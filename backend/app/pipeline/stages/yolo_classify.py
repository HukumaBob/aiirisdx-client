"""YoloClassifyStage: three heads (zone/quality/mode), each its own Ultralytics classifier.

weights=None -> stub (all "unknown"). weights={"zone": Path, ...}: missing head -> "unknown".
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from app.pipeline.stage import FrameRef, StageResult
from app.pipeline.stages._weights import load_yolo, weights_version

HEADS = ("zone", "quality", "mode")


class YoloClassifyStage:
    name = "yolo_classify"
    kind = "classifier"

    def __init__(self, weights: dict | None = None, models: dict | None = None):
        """`models` injects predict()-compatible objects per head (tests)."""
        weights = {k: Path(v) for k, v in (weights or {}).items() if k in HEADS}
        self.models = dict(models or {})
        for head, p in weights.items():
            if head not in self.models:
                self.models[head] = load_yolo(p)
        if not weights:
            self.version = "stub" if not self.models else "fake"
        else:
            self.version = ",".join(f"{h}={weights_version(p)}" for h, p in sorted(weights.items())
                                    if p.exists())

    def process(self, frame: np.ndarray, ref: FrameRef, ctx: dict) -> StageResult:
        work = ctx.get("frame", frame)
        labels = {}
        for head in HEADS:
            m = self.models.get(head)
            if m is None:
                labels[head] = "unknown"
                continue
            r = m.predict(work, verbose=False)[0]
            labels[head] = str(r.names[int(r.probs.top1)])
        return StageResult(frame_id=ref.frame_id, stage=self.name, labels=labels)
