"""Segmentation model next to detection: the stage, the polygon contract, the per-session
choice of detector ("detect" | "segment") through the pipeline and the API."""

from __future__ import annotations

import time
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.config import Settings, build_app
from app.contracts.log_schema import CropRect, Detection
from app.logwriter import read_log
from app.pipeline.runner import Pipeline
from app.pipeline.stage import FrameRef, StageResult
from app.pipeline.stages.crop import CropStage
from app.pipeline.stages.yolo_segment import YoloSegmentStage, simplify_outline
from test_ingest import write_video
from test_stages import FakeBoxes


def circle(cx, cy, r, n=400):
    a = np.linspace(0, 2 * np.pi, n, endpoint=False)
    return np.stack([cx + r * np.cos(a), cy + r * np.sin(a)], axis=1)


def area(p):
    x, y = np.asarray(p, dtype=float).T
    return 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


class FakeMasks:
    def __init__(self, xy):
        self.xy = xy


class FakeSegResult:
    def __init__(self, boxes, names, masks):
        self.boxes, self.names, self.masks = boxes, names, masks


class FakeSegModel:
    names = {0: "polyp"}

    def __init__(self, xyxy, conf, cls, outlines):
        self.args, self.outlines, self.seen_shape = (xyxy, conf, cls), outlines, None

    def predict(self, frame, imgsz=None, conf=None, verbose=False, **kw):
        self.seen_shape = frame.shape
        return [FakeSegResult(FakeBoxes(*self.args), self.names, FakeMasks(self.outlines))]


def ref(crop=None, variant=None):
    return FrameRef(session_id="s", frame_id=3, pts=0.1, crop=crop, variant=variant)


def test_simplify_outline_is_compact_and_keeps_the_shape():
    raw = circle(500, 400, 120, n=800)
    out = simplify_outline(raw, max_points=96)
    assert 3 <= len(out) <= 96
    assert area(out) == pytest.approx(area(raw), rel=0.03)
    assert len(simplify_outline(raw, max_points=12)) <= 12
    tri = np.array([[0, 0], [10, 0], [5, 8]], np.float32)
    assert len(simplify_outline(tri)) == 3


def test_segment_stage_maps_polygon_and_bbox_to_the_original_frame_with_crop():
    frame = np.zeros((1000, 2000, 3), np.uint8)
    ctx: dict = {}
    CropStage(CropRect(x=500, y=200, w=1000, h=500)).process(frame, ref(), ctx)
    # circle in CROP pixels, centre (400, 250) r 100  -> original (900, 450)
    model = FakeSegModel([[300, 150, 500, 350]], [0.8], [0], [circle(400, 250, 100)])
    res = YoloSegmentStage(model=model).process(frame, ref(), ctx)
    d = res.detections[0]
    assert d.class_name == "polyp" and d.confidence == pytest.approx(0.8)
    assert d.bbox == pytest.approx((800 / 2000, 350 / 1000, 200 / 2000, 200 / 1000))
    assert 3 <= len(d.polygon) <= 96
    xs, ys = np.array(d.polygon).T
    assert xs.min() == pytest.approx(800 / 2000, abs=0.01) and xs.max() == pytest.approx(1000 / 2000, abs=0.01)
    assert ys.min() == pytest.approx(350 / 1000, abs=0.01) and ys.max() == pytest.approx(550 / 1000, abs=0.01)
    assert all(0 <= v <= 1 for v in np.array(d.polygon).ravel())


def test_segment_stage_downscaled_input_maps_back():
    frame = np.zeros((1000, 2000, 3), np.uint8)
    ctx: dict = {}
    CropStage(None).process(frame, ref(), ctx)
    # max_side=1000 halves the frame: the model sees 500x1000 -> shape (500, 1000)
    model = FakeSegModel([[100, 100, 300, 300]], [0.9], [0], [circle(200, 200, 100)])
    d = YoloSegmentStage(model=model, max_side=1000).process(frame, ref(), ctx).detections[0]
    assert model.seen_shape[:2] == (500, 1000)
    assert d.bbox == pytest.approx((200 / 2000, 200 / 1000, 400 / 2000, 400 / 1000))
    xs, _ = np.array(d.polygon).T
    assert xs.min() == pytest.approx(200 / 2000, abs=0.01) and xs.max() == pytest.approx(600 / 2000, abs=0.01)


def test_segment_stage_without_masks_gives_boxes_only():
    class NoMasks(FakeSegModel):
        def predict(self, frame, **kw):
            r = super().predict(frame, **kw)[0]
            r.masks = None
            return [r]

    d = YoloSegmentStage(model=NoMasks([[10, 10, 50, 50]], [0.5], [0], [])).process(
        np.zeros((100, 100, 3), np.uint8), ref(), {}).detections[0]
    assert d.polygon is None


def test_detection_polygon_contract():
    ok = Detection(bbox=(0.1, 0.1, 0.2, 0.2), class_name="p", confidence=0.5,
                   polygon=[(0.1, 0.1), (0.3, 0.1), (0.2, 0.3)])
    assert Detection.model_validate_json(ok.model_dump_json()).polygon == ok.polygon
    assert Detection(bbox=(0, 0, 0.1, 0.1), class_name="p", confidence=0.5).polygon is None
    for bad in ([(0.1, 0.1), (0.2, 0.2)], [(0.1, 0.1), (0.2, 0.2), (1.5, 0.3)],
                [(0.1, 0.1)] * 300):
        with pytest.raises(ValidationError):
            Detection(bbox=(0, 0, 0.1, 0.1), class_name="p", confidence=0.5, polygon=bad)


class _Named:
    version = "t"
    kind = "detector"

    def process(self, frame, ref, ctx):
        d = Detection(bbox=(0.1, 0.1, 0.2, 0.2), class_name=self.name, confidence=0.9)
        return StageResult(frame_id=ref.frame_id, stage=self.name, detections=[d])


class DetStage(_Named):
    name, variant = "det", "detect"


class SegStage(_Named):
    name, variant = "seg", "segment"


class AlwaysStage(_Named):  # e.g. a future classifier: no variant, always runs
    name = "always"


def two_model_pipeline() -> Pipeline:
    return Pipeline([DetStage(), SegStage(), AlwaysStage()])


@pytest.mark.parametrize("variant,want", [("detect", ["det", "always"]), ("segment", ["seg", "always"]),
                                          (None, ["det", "seg", "always"])])
def test_pipeline_runs_only_the_chosen_variant(variant, want):
    rec = two_model_pipeline().run(np.zeros((10, 10, 3), np.uint8), ref(variant=variant))
    assert [d.class_name for d in rec.detections] == want


def settings(tmp_path: Path, **kw) -> Settings:
    root = tmp_path / "media"
    root.mkdir(exist_ok=True)
    base = dict(sessions_dir=tmp_path / "sessions", file_root=root, workers=1, queue_size=8,
                drain_timeout=5.0, detect_weights=tmp_path / "d.pt", segment_weights=tmp_path / "s.pt")
    base.update(kw)
    return Settings(**base)


def test_settings_available_variants(tmp_path):
    assert settings(tmp_path).available_variants() == ["detect", "segment"]
    assert settings(tmp_path, segment_weights=None).available_variants() == ["detect"]
    assert settings(tmp_path, detect_weights=None, segment_weights=None).available_variants() == []
    names = [c["name"] for c in settings(tmp_path).pipeline_config()]
    assert names.index("yolo_detect") < names.index("yolo_segment")


@pytest.fixture
def client(tmp_path):
    with TestClient(build_app(settings(tmp_path), pool_factory=two_model_pipeline)) as c:
        yield c


def test_client_config_lists_models_and_session_records_the_choice(client, tmp_path):
    assert client.get("/client-config").json()["models"] == ["detect", "segment"]
    r = client.post("/sessions", json={"stand": "s1", "model": "segment"}).json()
    assert r["model"] == "segment"
    header, _, _ = read_log(tmp_path / "sessions" / r["session_id"] / "log.jsonl")
    assert header.model_variant == "segment"
    assert client.post("/sessions", json={"stand": "s1"}).json()["model"] == "detect"  # default
    assert client.post("/sessions", json={"stand": "s1", "model": "nope"}).status_code == 422


def test_unavailable_model_is_refused(tmp_path):
    with TestClient(build_app(settings(tmp_path, segment_weights=None), pool_factory=two_model_pipeline)) as c:
        assert c.post("/sessions", json={"stand": "s1", "model": "segment"}).status_code == 422
        assert c.post("/sessions", json={"stand": "s1", "model": "detect"}).status_code == 200


@pytest.mark.parametrize("model,want", [("detect", {"det", "always"}), ("segment", {"seg", "always"})])
def test_chosen_model_is_what_reaches_the_log(client, tmp_path, model, want):
    write_video(tmp_path / "media" / "v.mp4", 6)
    sid = client.post("/sessions", json={"stand": "s1", "model": model}).json()["session_id"]
    assert client.post(f"/sessions/{sid}/file", json={"path": "v.mp4", "realtime": False}).status_code == 200
    deadline = time.monotonic() + 30
    while True:
        st = client.get(f"/sessions/{sid}").json()
        if st["file"] == "done" and st["logged"] == st["submitted"] and st["submitted"] > 0:
            break
        assert time.monotonic() < deadline, st
        time.sleep(0.05)
    client.post(f"/sessions/{sid}/stop")
    _, recs, _ = read_log(tmp_path / "sessions" / sid / "log.jsonl")
    seen = {d.class_name for r in recs if not r.dropped for d in r.detections}
    assert seen == want
