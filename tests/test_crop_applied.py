"""C2: the session crop (FrameRef.crop, delivered-frame pixels) is applied to inference.

Frames go through the real path: POST /sessions {crop} -> /file -> FileIngest -> FrameSink
(downscale to 960 + crop scaling) -> pool worker -> CropStage -> detector -> router -> log.
The fake detector reports the shape of the working frame it received (class_name "HxW") and
a known box in WORKING (cropped, downscaled) pixels, mapped back with to_original_norm.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api.config import build_app
from app.contracts.log_schema import CropRect, Detection
from app.logwriter import read_log
from app.pipeline.geometry import to_original_norm
from app.pipeline.runner import Pipeline
from app.pipeline.stage import FrameRef, StageResult
from app.pipeline.stages.crop import CropStage
from test_api import make_settings
from test_ingest import write_video

BOX = (54, 54, 108, 108)  # xywh in working-frame pixels


class ShapeDetector:
    name = "shape"
    version = "t1"
    kind = "detector"

    def process(self, frame, ref, ctx):
        work = ctx.get("frame", frame)
        h, w = work.shape[:2]
        d = Detection(bbox=to_original_norm(BOX, ctx), class_name=f"{h}x{w}", confidence=0.9)
        return StageResult(frame_id=ref.frame_id, stage=self.name, detections=[d])


def crop_pipeline() -> Pipeline:
    return Pipeline([CropStage(), ShapeDetector()])


def _run(tmp_path, crop):
    c = TestClient(build_app(make_settings(tmp_path), pool_factory=crop_pipeline))
    with c:
        write_video(tmp_path / "media" / "v.mp4", 6, size=(1280, 720))
        body = {"stand": "s1"} | ({"crop": crop} if crop else {})
        sid = c.post("/sessions", json=body).json()["session_id"]
        assert c.post(f"/sessions/{sid}/file", json={"path": "v.mp4", "realtime": False}).status_code == 200
        for _ in range(200):
            st = c.get(f"/sessions/{sid}").json()
            if st["file"] == "done" and st["logged"] == st["submitted"] == 6:
                break
            import time
            time.sleep(0.05)
        assert c.post(f"/sessions/{sid}/stop").json()["frames"] == 6
        header, recs, complete = read_log(Path(c.app.state.settings.sessions_dir) / sid / "log.jsonl")
    assert complete and len(recs) == 6
    return header, recs


def test_session_crop_reaches_the_detector_and_bbox_is_full_frame_normalized(tmp_path):
    crop = {"x": 320, "y": 0, "w": 720, "h": 720}  # original 1280x720 pixels
    header, recs = _run(tmp_path, crop)
    assert header.crop == CropRect(**crop)
    # delivered frame: 960x540 (s=0.75) -> crop (240, 0, 540, 540)
    for r in recs:
        assert not r.dropped
        d = r.detections[0]
        assert d.class_name == "540x540", "detector must see the CROPPED frame"
        # working box (54,54,108,108) -> delivered px (294,54,108,108) of 960x540
        assert d.bbox == pytest.approx((294 / 960, 54 / 540, 108 / 960, 108 / 540))
        # same thing in ORIGINAL pixels: x = 320 + 54/0.75
        x, y, w, h = d.bbox
        assert (x * 1280, y * 720, w * 1280, h * 720) == pytest.approx((392, 72, 144, 144), abs=0.5)


def test_no_crop_runs_on_the_full_frame(tmp_path):
    _, recs = _run(tmp_path, None)
    for r in recs:
        assert r.detections[0].class_name == "540x960"
        assert r.detections[0].bbox == pytest.approx((54 / 960, 54 / 540, 108 / 960, 108 / 540))


# ---------------------------------------------------------------- stage-level
def ref(crop=None):
    return FrameRef(session_id="s", frame_id=1, pts=0.0, crop=crop)


def test_ref_crop_wins_over_build_time_rect():
    frame = np.zeros((540, 960, 3), np.uint8)
    ctx: dict = {}
    CropStage(CropRect(x=0, y=0, w=10, h=10)).process(frame, ref(CropRect(x=240, y=0, w=540, h=540)), ctx)
    assert ctx["frame"].shape[:2] == (540, 540)
    assert ctx["crop_offset"] == (240, 0) and ctx["orig_size"] == (960, 540)
    assert "crop_note" not in ctx


def test_build_time_rect_used_without_ref_crop():
    frame = np.zeros((100, 200, 3), np.uint8)
    ctx: dict = {}
    CropStage({"x": 50, "y": 10, "w": 100, "h": 80}).process(frame, ref(), ctx)
    assert ctx["frame"].shape[:2] == (80, 100) and ctx["crop_offset"] == (50, 10)


@pytest.mark.parametrize("rect", [
    CropRect(x=960, y=0, w=10, h=10),     # starts right of the frame
    CropRect(x=0, y=540, w=10, h=10),     # starts below the frame
    CropRect(x=2000, y=2000, w=50, h=50),
])
def test_crop_outside_the_frame_falls_back_to_full_frame(rect):
    frame = np.zeros((540, 960, 3), np.uint8)
    ctx: dict = {}
    CropStage().process(frame, ref(rect), ctx)
    assert ctx["frame"].shape == frame.shape and ctx["crop_offset"] == (0, 0)
    assert "full frame" in ctx["crop_note"]


def test_crop_partly_outside_is_clipped():
    frame = np.zeros((540, 960, 3), np.uint8)
    ctx: dict = {}
    CropStage().process(frame, ref(CropRect(x=900, y=500, w=100, h=100)), ctx)
    assert ctx["frame"].shape[:2] == (40, 60) and ctx["crop_offset"] == (900, 500)
