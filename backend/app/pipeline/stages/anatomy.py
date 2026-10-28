"""AnatomyStage: checks detected findings against the classifier's zone using declarative rules.

anatomy_status: "unknown" if the zone is unknown/missing, "warning" if a confident,
ruled finding is not allowed in the zone, otherwise "ok". Rules: see anatomy_rules.yaml.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import yaml

from app.pipeline.stage import FrameRef, StageResult

DEFAULT_RULES = Path(__file__).with_name("anatomy_rules.yaml")


class AnatomyStage:
    name = "anatomy"
    version = "1"
    kind = "anatomy"

    def __init__(self, rules_path: Path | str = DEFAULT_RULES):
        data = yaml.safe_load(Path(rules_path).read_text(encoding="utf-8")) or {}
        self.min_confidence = float(data.get("min_confidence", 50)) / 100.0
        self.findings = {k: set(v) for k, v in (data.get("findings") or {}).items()}

    def process(self, frame: np.ndarray, ref: FrameRef, ctx: dict) -> StageResult:
        zone = (ctx.get("classification") or {}).get("zone", "unknown")
        if zone in ("", "unknown"):
            status = "unknown"
        else:
            status = "ok"
            for d in ctx.get("detections") or []:
                allowed = self.findings.get(d.class_name)
                if allowed is not None and d.confidence >= self.min_confidence and zone not in allowed:
                    status = "warning"
                    break
        return StageResult(frame_id=ref.frame_id, stage=self.name, labels={"anatomy_status": status})
