"""CropStage: publishes the cropped working frame to later stages via ctx.

Which rectangle: the SESSION crop ``ref.crop`` when present -- ingest already scaled it to
the pixels of the DELIVERED frame (the frame is downscaled to ``max_side`` before the
pipeline, see app/ingest/_common.py) -- else the build-time ``rect`` (pipeline config, same
pixel convention), else none.

ctx out: ``frame`` (working frame, a view), ``crop_offset`` (x, y of the working frame in the
delivered frame), ``orig_size`` (W, H of the delivered frame). Detectors map their boxes with
``geometry.to_original_norm`` => normalized 0..1 of the FULL frame, which is scale-invariant,
so it is also normalized to the original (pre-downscale) capture frame.

A rectangle that lies outside the frame (empty slice after clipping) is not applied: the
full frame is used and ``ctx["crop_note"]`` says so (logged once per stage instance).
"""

from __future__ import annotations

import logging

import numpy as np

from app.contracts.log_schema import CropRect
from app.pipeline.stage import FrameRef, StageResult

log = logging.getLogger(__name__)


class CropStage:
    name = "crop"
    version = "2"
    kind = "preprocess"

    def __init__(self, rect: CropRect | dict | None = None):
        self.rect = CropRect(**rect) if isinstance(rect, dict) else rect
        self._warned = False

    def process(self, frame: np.ndarray, ref: FrameRef, ctx: dict) -> StageResult:
        h, w = frame.shape[:2]
        ctx["orig_size"] = (w, h)
        r = ref.crop if ref.crop is not None else self.rect
        ctx["frame"], ctx["crop_offset"] = frame, (0, 0)
        if r is not None:
            x0, y0 = max(0, r.x), max(0, r.y)
            x1, y1 = min(w, r.x + r.w), min(h, r.y + r.h)
            if x1 - x0 < 1 or y1 - y0 < 1:
                note = (f"crop {r.x},{r.y} {r.w}x{r.h} is outside the {w}x{h} frame: "
                        "full frame used")
                ctx["crop_note"] = note
                if not self._warned:
                    self._warned = True
                    log.warning("frame %s of %s: %s", ref.frame_id, ref.session_id, note)
            else:
                ctx["frame"] = frame[y0:y1, x0:x1]
                ctx["crop_offset"] = (x0, y0)
        return StageResult(frame_id=ref.frame_id, stage=self.name)
