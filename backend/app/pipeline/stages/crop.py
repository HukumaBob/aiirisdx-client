"""CropStage: publishes the cropped working frame to later stages via ctx."""

from __future__ import annotations

import numpy as np

from app.contracts.log_schema import CropRect
from app.pipeline.stage import FrameRef, StageResult


class CropStage:
    name = "crop"
    version = "1"
    kind = "detector"

    def __init__(self, rect: CropRect | dict | None = None):
        self.rect = CropRect(**rect) if isinstance(rect, dict) else rect

    def process(self, frame: np.ndarray, ref: FrameRef, ctx: dict) -> StageResult:
        h, w = frame.shape[:2]
        ctx["orig_size"] = (w, h)
        if self.rect is None:
            ctx["frame"], ctx["crop_offset"] = frame, (0, 0)
        else:
            r = self.rect
            x, y = min(r.x, w - 1), min(r.y, h - 1)
            ctx["frame"] = frame[y : y + r.h, x : x + r.w]
            ctx["crop_offset"] = (x, y)
        return StageResult(frame_id=ref.frame_id, stage=self.name)
