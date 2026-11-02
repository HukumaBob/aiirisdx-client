"""YoloDetectStage: Ultralytics detector; boxes returned in original-frame normalized xywh."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from app.contracts.log_schema import Detection
from app.pipeline.geometry import to_original_norm
from app.pipeline.stage import FrameRef, StageResult
from app.pipeline.stages._weights import load_yolo, weights_version


def _np(t):
    return t.cpu().numpy() if hasattr(t, "cpu") else np.asarray(t)


class YoloDetectStage:
    name = "yolo_detect"
    kind = "detector"
    variant = "detect"

    def __init__(self, weights: Path | str | None = None, imgsz: int = 640,
                 conf: float = 0.25, max_side: int = 1920, model=None):
        """`model` injects a predict()-compatible object (tests); otherwise weights are loaded."""
        self.imgsz, self.conf, self.max_side = imgsz, conf, max_side
        if model is not None:
            self.model, self.version = model, "fake"
        else:
            weights = Path(weights)
            self.model, self.version = load_yolo(weights), weights_version(weights)

    def process(self, frame: np.ndarray, ref: FrameRef, ctx: dict) -> StageResult:
        work = ctx.get("frame", frame)
        h, w = work.shape[:2]
        scale = min(1.0, self.max_side / max(h, w))
        img = work
        if scale < 1.0:
            img = cv2.resize(work, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
        # actual per-axis scale (rounding) so mapping back is exact
        sx, sy = img.shape[1] / w, img.shape[0] / h
        res = self.model.predict(img, imgsz=self.imgsz, conf=self.conf, verbose=False)[0]
        names = res.names if getattr(res, "names", None) is not None else self.model.names
        mctx = {**ctx, "frame": work}
        dets: list[Detection] = []
        boxes = res.boxes
        for (x1, y1, x2, y2), c, k in zip(
            _np(boxes.xyxy), _np(boxes.conf), _np(boxes.cls), strict=True
        ):
            box = (x1 / sx, y1 / sy, (x2 - x1) / sx, (y2 - y1) / sy)
            bbox = to_original_norm(box, mctx)
            dets.append(Detection(bbox=bbox, class_name=str(names[int(k)]),
                                  confidence=min(1.0, max(0.0, float(c)))))
        return StageResult(frame_id=ref.frame_id, stage=self.name, detections=dets)
