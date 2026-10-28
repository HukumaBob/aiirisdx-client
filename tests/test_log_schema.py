"""Session log schema + JSONL writer/reader."""

import json
from datetime import datetime, timezone

import pytest
from pydantic import BaseModel, ValidationError

from app.contracts.log_schema import (
    CropRect, Detection, FrameRecord, LogHeader, SessionId,
)
from app.logwriter import LogWriter, read_log


def make_header(crop=None) -> LogHeader:
    return LogHeader(
        schema_version="1.0",
        session=SessionId(stand="stand-1", started_at=datetime(2026, 10, 28, tzinfo=timezone.utc), uuid="u-1"),
        doctor="Dr. X",
        crop=crop,
        models={"detector": "v1"},
        taxonomy_version="t1",
    )


def make_rec(i=0, bbox=(0.1, 0.2, 0.3, 0.4)) -> FrameRecord:
    return FrameRecord(
        frame_id=i, pts=i / 25, detections=[Detection(bbox=bbox, class_name="polyp", confidence=0.9)],
        classification={"zone": "antrum"}, anatomy=None, dropped=False,
    )


def test_header_first_line(tmp_path):
    p = tmp_path / "log.jsonl"
    w = LogWriter(p, make_header())
    w.close(complete=True)
    first = json.loads(p.read_text().splitlines()[0])
    assert first["type"] == "header"
    assert first["schema_version"] == "1.0"


def test_append_flushes(tmp_path):
    p = tmp_path / "log.jsonl"
    w = LogWriter(p, make_header())
    w.append(make_rec(0))
    w.append(make_rec(1))
    # no close: simulated crash
    header, recs, complete = read_log(p)
    assert [r.frame_id for r in recs] == [0, 1]
    assert complete is False
    w.close(complete=True)


def test_close_footer(tmp_path):
    p = tmp_path / "log.jsonl"
    w = LogWriter(p, make_header())
    w.append(make_rec(0))
    w.close(complete=True)
    lines = p.read_text().splitlines()
    assert json.loads(lines[-1]) == {"type": "footer", "complete": True, "frames": 1}
    assert json.loads(lines[1])["type"] == "frame"
    _, recs, complete = read_log(p)
    assert len(recs) == 1 and complete is True


def test_close_incomplete(tmp_path):
    p = tmp_path / "log.jsonl"
    w = LogWriter(p, make_header())
    w.close(complete=False)
    assert read_log(p)[2] is False


def test_truncated_last_line_tolerated(tmp_path):
    p = tmp_path / "log.jsonl"
    w = LogWriter(p, make_header())
    w.append(make_rec(0))
    w.append(make_rec(1))
    w.close(complete=False)
    text = p.read_text().splitlines()
    # drop footer, cut last frame line in half
    broken = "\n".join(text[:-2]) + "\n" + text[-2][: len(text[-2]) // 2]
    p.write_text(broken)
    header, recs, complete = read_log(p)
    assert header.schema_version == "1.0"
    assert [r.frame_id for r in recs] == [0]
    assert complete is False


def test_bbox_in_original_frame_with_crop():
    h = make_header(crop=CropRect(x=100, y=50, w=800, h=600))
    assert h.crop.w == 800
    Detection(bbox=(0.0, 0.0, 1.0, 1.0), class_name="a", confidence=1.0)
    for bad in [(0.5, 0.5, 0.6, 0.1), (0.5, 0.5, 0.1, 0.6), (-0.1, 0, 0.1, 0.1), (0, 0, 1.2, 0.1)]:
        with pytest.raises(ValidationError):
            Detection(bbox=bad, class_name="a", confidence=0.5)
    with pytest.raises(ValidationError):
        Detection(bbox=(0, 0, 0.1, 0.1), class_name="a", confidence=1.5)


def test_crop_validation():
    for kw in [dict(x=-1, y=0, w=1, h=1), dict(x=0, y=-1, w=1, h=1), dict(x=0, y=0, w=0, h=1), dict(x=0, y=0, w=1, h=0)]:
        with pytest.raises(ValidationError):
            CropRect(**kw)


def test_frame_validation():
    with pytest.raises(ValidationError):
        make_rec(-1)


def _all_field_names(model, seen=None):
    seen = seen if seen is not None else set()
    if model in seen:
        return []
    seen.add(model)
    names = []
    for name, f in model.model_fields.items():
        names.append(name)
        stack = [f.annotation]
        while stack:
            a = stack.pop()
            if isinstance(a, type) and issubclass(a, BaseModel):
                names += _all_field_names(a, seen)
            stack += list(getattr(a, "__args__", ()))
    return names


def test_no_personal_fields():
    names = _all_field_names(LogHeader) + _all_field_names(FrameRecord)
    assert {"session", "stand", "doctor", "class_name"} <= set(names)  # walk really recursed
    bad = ("patient", "birth", "mrn", "ssn", "surname", "dob", "fio", "address", "phone")
    for n in names:
        low = n.lower()
        assert not any(b in low for b in bad), n
        # bare "name" tokens (first_name, full_name...) are personal; class_name is the sole allowed one
        if "name" in low.split("_") or low.endswith("name"):
            assert low == "class_name", n
