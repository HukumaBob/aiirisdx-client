"""Stage protocol: pluggable synchronous processing steps (run in worker processes)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import numpy as np

from app.contracts.log_schema import CropRect, Detection


@dataclass(frozen=True)
class FrameRef:
    session_id: str
    frame_id: int
    pts: float
    crop: CropRect | None = None
    # detector the session chose ("detect" | "segment"); stages that declare a `variant`
    # run only when it matches (None: no gating)
    variant: str | None = None


@dataclass
class StageResult:
    frame_id: int
    stage: str
    detections: list[Detection] = field(default_factory=list)
    labels: dict[str, str] = field(default_factory=dict)


class Stage(Protocol):
    name: str
    version: str
    kind: str  # "detector" (default) | "classifier" | "anatomy"

    def process(self, frame: np.ndarray, ref: FrameRef, ctx: dict) -> StageResult: ...
