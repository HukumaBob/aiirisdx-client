"""Stub detector for run_load.py when no weights are available (importable by spawned workers)."""

import time

from app.pipeline.runner import Pipeline
from app.pipeline.stage import StageResult


class SleepStage:
    name, version, kind = "stub_detect", "sleep-5ms", "detector"

    def process(self, frame, ref, ctx):
        time.sleep(0.005)
        return StageResult(frame_id=ref.frame_id, stage=self.name)


def stub_pipeline() -> Pipeline:
    return Pipeline([SleepStage()])
