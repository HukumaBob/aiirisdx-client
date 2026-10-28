import numpy as np
import pytest

from app.contracts.log_schema import Detection
from app.pipeline.runner import Pipeline, StageConfig, build_pipeline
from app.pipeline.stage import FrameRef
from app.pipeline.stages.anatomy import AnatomyStage

FRAME = np.zeros((8, 8, 3), np.uint8)
REF = FrameRef(session_id="s", frame_id=1, pts=0.0)


def det(name, conf=0.9):
    return Detection(bbox=(0.1, 0.1, 0.2, 0.2), class_name=name, confidence=conf)


@pytest.fixture
def stage(tmp_path):
    p = tmp_path / "rules.yaml"
    p.write_text(
        "min_confidence: 50\n"
        "findings:\n"
        "  columnar_metaplasia: [z_line, distal_oesophagus]\n"
        "  sessile_polyp_0_Is: [rectum, caecum]\n"
    )
    return AnatomyStage(p)


def run(stage, zone, dets):
    ctx = {"classification": {"zone": zone}, "detections": dets}
    return stage.process(FRAME, REF, ctx).labels["anatomy_status"]


def test_finding_inconsistent_with_zone_gives_warning(stage):
    assert run(stage, "rectum", [det("columnar_metaplasia")]) == "warning"


def test_finding_consistent_with_zone_gives_ok(stage):
    assert run(stage, "z_line", [det("columnar_metaplasia")]) == "ok"


def test_unknown_zone_gives_unknown(stage):
    assert run(stage, "unknown", [det("columnar_metaplasia")]) == "unknown"
    assert run(stage, "unknown", []) == "unknown"


def test_missing_zone_gives_unknown(stage):
    assert stage.process(FRAME, REF, {}).labels["anatomy_status"] == "unknown"


def test_no_detections_known_zone_ok(stage):
    assert run(stage, "rectum", []) == "ok"


def test_low_confidence_and_unruled_findings_ignored(stage):
    assert run(stage, "rectum", [det("columnar_metaplasia", 0.3)]) == "ok"
    assert run(stage, "rectum", [det("something_else")]) == "ok"


def test_default_rules_load_and_stub_pipeline_does_not_break():
    import app.pipeline.stages  # noqa: F401  registers stages

    pipe = build_pipeline([StageConfig("yolo_classify"), StageConfig("anatomy")])
    rec = pipe.run(FRAME, REF)
    assert pipe.last_errors == []
    assert rec.anatomy == {"status": "unknown"}
