import numpy as np
import pytest

from app.contracts.log_schema import Detection
from app.pipeline.runner import Pipeline, StageConfig, build_pipeline, register_stage
from app.pipeline.stage import FrameRef, StageResult

FRAME = np.zeros((32, 32, 3), np.uint8)


def ref(fid=7, pts=0.5):
    return FrameRef(session_id="s", frame_id=fid, pts=pts, crop=None)


class Fake:
    kind = "detector"
    version = "1"

    def __init__(self, name="fake", dets=(), labels=None, kind=None, seen=None, frame_id=None):
        self.name = name
        self._dets = list(dets)
        self._labels = labels or {}
        if kind:
            self.kind = kind
        self.seen = seen
        self._fid = frame_id

    def process(self, frame, ref, ctx):
        if self.seen is not None:
            self.seen.append(self.name)
        fid = ref.frame_id if self._fid is None else self._fid
        return StageResult(frame_id=fid, stage=self.name, detections=self._dets, labels=self._labels)


class Boom(Fake):
    def process(self, frame, ref, ctx):
        raise RuntimeError("boom")


def det(c):
    return Detection(bbox=(0.1, 0.1, 0.2, 0.2), class_name=c, confidence=0.9)


def test_order_follows_config():
    seen = []
    register_stage("t_a", lambda **p: Fake("a", [det("a")], seen=seen))
    register_stage("t_b", lambda **p: Fake("b", [det("b")], seen=seen))
    p = build_pipeline([StageConfig("t_b", {}), StageConfig("t_a", {})])
    rec = p.run(FRAME, ref())
    assert seen == ["b", "a"]
    assert [d.class_name for d in rec.detections] == ["b", "a"]


def test_result_frame_id_matches_ref():
    p = Pipeline([Fake("a", frame_id=999)])
    rec = p.run(FRAME, ref(fid=42, pts=1.25))
    assert rec.frame_id == 42 and rec.pts == 1.25


def test_stage_added_without_core_change():
    register_stage("t_new", lambda **p: Fake("new", [det(p["cls"])]))
    p = build_pipeline([StageConfig("t_new", {"cls": "polyp"})])
    assert p.run(FRAME, ref()).detections[0].class_name == "polyp"
    with pytest.raises(KeyError):
        build_pipeline([StageConfig("nope", {})])


def test_failing_stage_marks_record_not_crash():
    p = Pipeline([Boom("bad"), Fake("ok", [det("x")])])
    rec = p.run(FRAME, ref(fid=5))
    assert rec.frame_id == 5
    assert [d.class_name for d in rec.detections] == ["x"]
    assert len(p.last_errors) == 1 and p.last_errors[0][0] == "bad"
    assert isinstance(p.last_errors[0][1], RuntimeError)
    p.run(FRAME, ref())
    assert len(p.last_errors) == 1  # reset per run


def test_ctx_labels_classification_anatomy():
    seen_ctx = {}

    class Spy(Fake):
        def process(self, frame, ref, ctx):
            seen_ctx.update(ctx)
            return super().process(frame, ref, ctx)

    p = Pipeline([
        Fake("cls", labels={"zone": "gastric"}, kind="classifier"),
        Fake("anat", labels={"anatomy_status": "ok"}, kind="anatomy"),
        Spy("spy"),
    ])
    rec = p.run(FRAME, ref())
    assert rec.classification == {"zone": "gastric"}
    assert rec.anatomy == {"status": "ok"}
    assert seen_ctx["classification"] == {"zone": "gastric"}
    assert seen_ctx["labels"]["anatomy_status"] == "ok"
    assert Pipeline([Fake("d")]).run(FRAME, ref()).anatomy is None


def test_model_versions():
    f = Fake("m")
    f.version = "2.1"
    assert Pipeline([f]).model_versions() == {"m": "2.1"}


def test_ctx_exposes_detections_collected_so_far():
    seen = []

    class Spy(Fake):
        def process(self, frame, ref, ctx):
            seen.append([d.class_name for d in ctx["detections"]])
            return super().process(frame, ref, ctx)

    d = Detection(bbox=(0.1, 0.1, 0.2, 0.2), class_name="polyp", confidence=0.9)
    rec = Pipeline([Fake("det", dets=[d]), Spy("spy")]).run(FRAME, ref())
    assert seen == [["polyp"]]
    assert len(rec.detections) == 1
