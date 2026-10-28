import os
from pathlib import Path

import numpy as np
import pytest

from app.contracts.log_schema import CropRect
from app.pipeline.runner import StageConfig, build_pipeline
from app.pipeline.stage import FrameRef
from app.pipeline.stages.crop import CropStage
from app.pipeline.stages.yolo_classify import YoloClassifyStage
from app.pipeline.stages.yolo_detect import YoloDetectStage

DEFAULT_W = Path(
    "/mnt/work-disk/Documents/Dev/video_stream_client/video_stream_project/backend/checkpoints/test000.pt"
)
WEIGHTS = Path(os.environ.get("TEST_DETECTOR_WEIGHTS", DEFAULT_W))
needs_weights = pytest.mark.skipif(not WEIGHTS.exists(), reason="detector weights absent")


class _T(np.ndarray):
    pass


class FakeBoxes:
    def __init__(self, xyxy, conf, cls):
        self.xyxy = np.array(xyxy, dtype=float).reshape(-1, 4)
        self.conf = np.array(conf, dtype=float)
        self.cls = np.array(cls, dtype=float)


class FakeResult:
    def __init__(self, boxes, names):
        self.boxes = boxes
        self.names = names


class FakeModel:
    """Mimics ultralytics YOLO.predict; records the frame it was given."""

    names = {0: "test_cross", 1: "other"}

    def __init__(self, xyxy=(), conf=(), cls=()):
        self.args = (xyxy, conf, cls)
        self.seen_shape = None

    def predict(self, frame, imgsz=None, conf=None, verbose=False, **kw):
        self.seen_shape = frame.shape
        return [FakeResult(FakeBoxes(*self.args), self.names)]


def ref(crop=None):
    return FrameRef(session_id="s", frame_id=7, pts=0.1, crop=crop)


def test_crop_maps_bbox_back():
    frame = np.zeros((1000, 2000, 3), np.uint8)
    ctx: dict = {}
    CropStage(CropRect(x=500, y=200, w=1000, h=500)).process(frame, ref(), ctx)
    assert ctx["frame"].shape == (500, 1000, 3)
    assert ctx["crop_offset"] == (500, 200)
    assert ctx["orig_size"] == (2000, 1000)
    # box in crop pixels (100,50)-(300,150)
    det = YoloDetectStage(model=FakeModel([[100, 50, 300, 150]], [0.9], [0]))
    res = det.process(frame, ref(), ctx)
    d = res.detections[0]
    assert d.bbox == pytest.approx((600 / 2000, 250 / 1000, 200 / 2000, 100 / 1000))
    assert all(0 <= v <= 1 for v in d.bbox)
    assert d.class_name == "test_cross" and d.confidence == pytest.approx(0.9)


def test_crop_none_passthrough():
    frame = np.zeros((100, 200, 3), np.uint8)
    ctx: dict = {}
    CropStage(None).process(frame, ref(), ctx)
    assert ctx["frame"].shape == frame.shape and ctx["crop_offset"] == (0, 0)
    assert ctx["orig_size"] == (200, 100)


def test_downscale_4k_maps_back():
    frame = np.zeros((2160, 3840, 3), np.uint8)
    fake = FakeModel([[480, 270, 960, 540]], [0.5], [1])  # in 1920x1080 coords
    res = YoloDetectStage(model=fake, max_side=1920).process(frame, ref(), {})
    assert fake.seen_shape[:2] == (1080, 1920)
    x, y, w, h = res.detections[0].bbox
    assert (x * 3840, y * 2160, w * 3840, h * 2160) == pytest.approx(
        (960, 540, 960, 540), abs=1
    )
    assert res.detections[0].class_name == "other"


def test_downscale_with_crop_4k():
    frame = np.zeros((2160, 3840, 3), np.uint8)
    ctx: dict = {}
    CropStage(CropRect(x=1000, y=500, w=2400, h=1200)).process(frame, ref(), ctx)
    fake = FakeModel([[100, 100, 300, 200]], [0.5], [0])  # work 2400x1200 -> 1920x960 (s=0.8)
    res = YoloDetectStage(model=fake, max_side=1920).process(frame, ref(), ctx)
    assert fake.seen_shape[:2] == (960, 1920)
    x, y, w, h = res.detections[0].bbox
    assert (x * 3840, y * 2160, w * 3840, h * 2160) == pytest.approx(
        (1000 + 125, 500 + 125, 250, 125), abs=1
    )


def test_bbox_clamped_and_zero_detections():
    frame = np.zeros((100, 100, 3), np.uint8)
    res = YoloDetectStage(model=FakeModel([[-5, -5, 120, 50]], [1.0], [0])).process(frame, ref(), {})
    assert res.detections[0].bbox == pytest.approx((0, 0, 1, 0.5))
    res = YoloDetectStage(model=FakeModel()).process(frame, ref(), {})
    assert res.detections == [] and res.frame_id == 7 and res.stage == "yolo_detect"


def test_classifier_stub_without_weights():
    s = YoloClassifyStage(None)
    r = s.process(np.zeros((10, 10, 3), np.uint8), ref(), {})
    assert r.labels == {"zone": "unknown", "quality": "unknown", "mode": "unknown"}
    assert s.kind == "classifier" and s.version == "stub"


def test_classifier_fake_models_missing_head_unknown():
    class P:
        top1 = 1

    class R:
        probs = P()
        names = {0: "a", 1: "good"}

    class M:
        def predict(self, frame, verbose=False, **kw):
            return [R()]

    s = YoloClassifyStage({"quality": Path("x")}, models={"quality": M()})
    r = s.process(np.zeros((10, 10, 3), np.uint8), ref(), {})
    assert r.labels == {"zone": "unknown", "quality": "good", "mode": "unknown"}


def test_registry():
    p = build_pipeline([StageConfig("crop", {"rect": None}), StageConfig("yolo_classify", {})])
    assert [s.name for s in p.stages] == ["crop", "yolo_classify"]


@needs_weights
def test_detector_output_format():
    s = YoloDetectStage(WEIGHTS, imgsz=640, conf=0.01)
    assert s.version and s.version != "stub"
    rng = np.random.default_rng(0)
    frame = rng.integers(0, 255, (480, 640, 3), dtype=np.uint8)
    res = s.process(frame, ref(), {})
    for d in res.detections:
        assert isinstance(d.class_name, str) and d.class_name
        assert 0 <= d.confidence <= 1
        assert all(0 <= v <= 1 for v in d.bbox)
