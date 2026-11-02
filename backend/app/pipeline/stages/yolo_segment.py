"""YoloSegmentStage: Ultralytics segmentation model; boxes AND smooth outlines.

Output per finding: ``bbox`` (xywh) and ``polygon`` (outline points), both normalized 0..1 of
the ORIGINAL frame (crop and downscale are undone like in YoloDetectStage). The contour comes
from the model's mask (a low-resolution mask upsampled to the image, so its raw edge is
stair-stepped); it is simplified here to a compact polygon and smoothed again when drawn.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from app.contracts.log_schema import MAX_POLYGON_POINTS, Detection
from app.pipeline.geometry import points_to_original_norm, to_original_norm
from app.pipeline.stage import FrameRef, StageResult
from app.pipeline.stages._weights import load_yolo, weights_version


def _np(t):
    return t.cpu().numpy() if hasattr(t, "cpu") else np.asarray(t)


def simplify_outline(points: np.ndarray, max_points: int = 96, rel_eps: float = 0.004) -> np.ndarray:
    """Compact an outline (N, 2) to <= max_points vertices, keeping its shape.

    Douglas-Peucker with an epsilon relative to the outline's size (so small and large
    findings are treated alike), then even resampling if it is still too long."""
    pts = np.asarray(points, dtype=np.float32).reshape(-1, 2)
    if len(pts) <= 3:
        return pts
    size = float(max(np.ptp(pts[:, 0]), np.ptp(pts[:, 1]), 1.0))
    eps = rel_eps * size
    out = cv2.approxPolyDP(pts.reshape(-1, 1, 2), eps, True).reshape(-1, 2)
    while len(out) > max_points:
        eps *= 1.5
        out = cv2.approxPolyDP(pts.reshape(-1, 1, 2), eps, True).reshape(-1, 2)
    return out


class YoloSegmentStage:
    name = "yolo_segment"
    kind = "detector"
    variant = "segment"

    def __init__(self, weights: Path | str | None = None, imgsz: int = 640,
                 conf: float = 0.25, max_side: int = 1920, max_points: int = 96, model=None):
        """`model` injects a predict()-compatible object (tests); otherwise weights are loaded."""
        self.imgsz, self.conf, self.max_side = imgsz, conf, max_side
        self.max_points = min(max_points, MAX_POLYGON_POINTS)
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
        sx, sy = img.shape[1] / w, img.shape[0] / h
        res = self.model.predict(img, imgsz=self.imgsz, conf=self.conf, verbose=False)[0]
        names = res.names if getattr(res, "names", None) is not None else self.model.names
        mctx = {**ctx, "frame": work}
        dets: list[Detection] = []
        boxes, masks = res.boxes, getattr(res, "masks", None)
        outlines = list(masks.xy) if masks is not None else []
        for i, ((x1, y1, x2, y2), c, k) in enumerate(
            zip(_np(boxes.xyxy), _np(boxes.conf), _np(boxes.cls), strict=True)
        ):
            bbox = to_original_norm((x1 / sx, y1 / sy, (x2 - x1) / sx, (y2 - y1) / sy), mctx)
            polygon = None
            if i < len(outlines) and len(outlines[i]) >= 3:
                pts = simplify_outline(np.asarray(outlines[i]), self.max_points)
                if len(pts) >= 3:
                    work_px = [(x / sx, y / sy) for x, y in pts]
                    polygon = points_to_original_norm(work_px, mctx)
            dets.append(Detection(bbox=bbox, class_name=str(names[int(k)]),
                                  confidence=min(1.0, max(0.0, float(c))), polygon=polygon))
        return StageResult(frame_id=ref.frame_id, stage=self.name, detections=dets)
