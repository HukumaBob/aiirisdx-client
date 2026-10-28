"""Stage registry and sequential pipeline runner."""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np

from app.contracts.log_schema import Detection, FrameRecord
from app.pipeline.stage import FrameRef, Stage

log = logging.getLogger(__name__)

_REGISTRY: dict[str, Callable[..., Stage]] = {}


def register_stage(name: str, factory: Callable[..., Stage]) -> None:
    _REGISTRY[name] = factory


@dataclass
class StageConfig:
    name: str
    params: dict = field(default_factory=dict)


class Pipeline:
    def __init__(self, stages: list[Stage]):
        self.stages = stages
        self.last_errors: list[tuple[str, Exception]] = []

    def model_versions(self) -> dict[str, str]:
        return {s.name: s.version for s in self.stages}

    def run(self, frame: np.ndarray, ref: FrameRef) -> FrameRecord:
        ctx: dict = {"labels": {}, "classification": {}}
        detections: list[Detection] = []
        self.last_errors = []
        for stage in self.stages:
            try:
                res = stage.process(frame, ref, ctx)
            except Exception as e:  # a failing stage must not crash the pipeline
                log.exception("stage %s failed on frame %s", stage.name, ref.frame_id)
                self.last_errors.append((stage.name, e))
                continue
            detections.extend(res.detections)
            ctx["labels"].update(res.labels)
            kind = getattr(stage, "kind", "detector")
            if kind == "classifier":
                ctx["classification"].update(res.labels)
            elif kind == "anatomy":
                ctx.setdefault("anatomy", {}).update(res.labels)
        anatomy = ctx.get("anatomy")
        if anatomy is not None and "anatomy_status" in anatomy:
            anatomy = {"status": anatomy["anatomy_status"]}
        return FrameRecord(
            frame_id=ref.frame_id,  # RF3: always the input ref's id
            pts=ref.pts,
            detections=detections,
            classification=dict(ctx["classification"]),
            anatomy=anatomy,
        )


def build_pipeline(config: list[StageConfig]) -> Pipeline:
    stages = []
    for c in config:
        if c.name not in _REGISTRY:
            raise KeyError(f"unknown stage: {c.name}")
        stages.append(_REGISTRY[c.name](**c.params))
    return Pipeline(stages)
