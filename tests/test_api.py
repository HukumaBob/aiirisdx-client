"""API tests (Task 8): sessions, results channel, stand token, log endpoint.

A fast fake pipeline is used (top-level classes/factories so spawned workers can import
them); the real YOLO stages are never loaded. Frames enter through the video-file mode,
i.e. the same ingest -> on_frame -> pool path as a live stream.
"""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api.config import Settings, build_app
from app.contracts.log_schema import Detection
from app.logwriter import read_log
from app.pipeline.runner import Pipeline
from app.pipeline.stage import StageResult
from test_ingest import write_video


class FastStage:
    name = "fast"
    version = "t1"
    kind = "detector"

    def process(self, frame, ref, ctx):
        d = Detection(bbox=(0.1, 0.1, 0.2, 0.2), class_name="x", confidence=0.9)
        return StageResult(frame_id=ref.frame_id, stage=self.name, detections=[d])


def fast_pipeline() -> Pipeline:
    return Pipeline([FastStage()])


def make_settings(tmp_path: Path, **kw) -> Settings:
    root = tmp_path / "media"
    root.mkdir(exist_ok=True)
    base = dict(sessions_dir=tmp_path / "sessions", file_root=root, workers=1, queue_size=8,
                drain_timeout=5.0)
    base.update(kw)
    return Settings(**base)


@pytest.fixture
def client_factory(tmp_path):
    clients = []

    def make(**kw):
        c = TestClient(build_app(make_settings(tmp_path, **kw), pool_factory=fast_pipeline))
        c.__enter__()
        clients.append(c)
        return c

    yield make
    for c in clients:
        c.__exit__(None, None, None)


def test_create_session_id_format(client_factory):
    c = client_factory()
    r = c.post("/sessions", json={"stand": "stand-1", "doctor": "dr-a"})
    assert r.status_code == 200
    sid = r.json()["session_id"]
    m = re.fullmatch(r"stand-1_(\d{8}T\d{6})_([0-9a-f]{32})", sid)
    assert m, sid
    header, recs, complete = read_log(Path(c.app.state.settings.sessions_dir) / sid / "log.jsonl")
    assert header.session.stand == "stand-1"
    assert header.session.uuid == m.group(2)
    assert header.doctor == "dr-a" and header.schema_version == "1.0"
    assert header.models == {"fast": "t1"} and header.taxonomy_version == "unversioned"
    assert recs == [] and complete is False
    assert c.post("/sessions", json={"stand": "../evil"}).status_code == 422


def test_token_required_when_enabled(client_factory):
    c = client_factory(require_token=True, stand_tokens={"s1": "secret", "s2": "other"})
    assert c.post("/sessions", json={"stand": "s1"}).status_code == 401
    assert c.post("/sessions", json={"stand": "s1"}, headers={"X-Stand-Token": "bad"}).status_code == 401
    # a token of another stand must not work
    assert c.post("/sessions", json={"stand": "s1"}, headers={"X-Stand-Token": "other"}).status_code == 401
    assert c.post("/sessions", json={"stand": "unknown"}, headers={"X-Stand-Token": "secret"}).status_code == 401
    ok = c.post("/sessions", json={"stand": "s1"}, headers={"X-Stand-Token": "secret"})
    assert ok.status_code == 200
    sid = ok.json()["session_id"]
    assert c.get(f"/sessions/{sid}/log").status_code == 401
    assert c.post(f"/sessions/{sid}/stop").status_code == 401
    assert c.get(f"/sessions/{sid}/log", headers={"X-Stand-Token": "secret"}).status_code == 200
    with pytest.raises(Exception):
        with c.websocket_connect(f"/sessions/{sid}/results"):
            pass
    h = {"X-Stand-Token": "secret"}
    with c.websocket_connect(f"/sessions/{sid}/results", headers=h):
        pass
    assert c.post(f"/sessions/{sid}/stop", headers=h).status_code == 200


def test_no_token_when_disabled(client_factory):
    c = client_factory(require_token=False, stand_tokens={"s1": "secret"})
    sid = c.post("/sessions", json={"stand": "s1"}).json()["session_id"]
    assert c.get(f"/sessions/{sid}/log").status_code == 200


def _run_file(c, tmp_path, n=40):
    write_video(tmp_path / "media" / "v.mp4", n)
    sid = c.post("/sessions", json={"stand": "s1"}).json()["session_id"]
    return sid


def test_results_ws_frame_ids_monotonic_or_marked(client_factory, tmp_path):
    c = client_factory(queue_size=2)  # tiny queue: some frames may be dropped=True
    n = 40
    sid = _run_file(c, tmp_path, n)
    msgs = []
    with c.websocket_connect(f"/sessions/{sid}/results") as ws:
        r = c.post(f"/sessions/{sid}/file", json={"path": "v.mp4", "realtime": False})
        assert r.status_code == 200, r.text
        while len(msgs) < n:
            msgs.append(ws.receive_json())
    ids = [m["frame_id"] for m in msgs]
    assert len(set(ids)) == len(ids), "duplicate frame ids"
    assert set(ids) <= set(range(n)), "frame id that was never submitted"
    assert ids == sorted(ids) or all(isinstance(m["dropped"], bool) for m in msgs)
    for m in msgs:
        assert set(m) >= {"frame_id", "pts", "dropped", "detections", "classification", "anatomy"}
        if not m["dropped"]:
            assert m["detections"][0]["class_name"] == "x"
        else:
            assert m["detections"] == []
    stop = c.post(f"/sessions/{sid}/stop").json()
    assert stop["frames"] == n


def test_stop_closes_log_complete(client_factory, tmp_path):
    c = client_factory()
    sid = _run_file(c, tmp_path, 20)
    assert c.post(f"/sessions/{sid}/file", json={"path": "v.mp4", "realtime": False}).status_code == 200
    r = c.post(f"/sessions/{sid}/stop")
    assert r.status_code == 200
    frames = r.json()["frames"]
    header, recs, complete = read_log(Path(c.app.state.settings.sessions_dir) / sid / "log.jsonl")
    assert complete is True and len(recs) == frames
    ids = [x.frame_id for x in recs]
    assert len(set(ids)) == len(ids)
    # stop is idempotent
    assert c.post(f"/sessions/{sid}/stop").json()["frames"] == frames


def test_log_endpoint_returns_partial_after_crash(client_factory, tmp_path):
    c = client_factory()
    sid = _run_file(c, tmp_path, 10)
    c.post(f"/sessions/{sid}/file", json={"path": "v.mp4", "realtime": False})
    import time
    path = Path(c.app.state.settings.sessions_dir) / sid / "log.jsonl"
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and len(path.read_text().splitlines()) < 11:
        time.sleep(0.05)
    r = c.get(f"/sessions/{sid}/log")  # session never stopped: "crashed"
    assert r.status_code == 200
    lines = r.text.splitlines()
    assert '"type":"header"' in lines[0] and len(lines) >= 2
    assert '"footer"' not in r.text
    _, recs, complete = read_log(path)
    assert complete is False and len(recs) >= 1


def test_log_available_after_restart(client_factory, tmp_path):
    c = client_factory()
    sid = c.post("/sessions", json={"stand": "s1"}).json()["session_id"]
    c.app.state.core.sessions.clear()  # as after a server restart
    assert c.get(f"/sessions/{sid}/log").status_code == 200
    assert c.get("/sessions/s1_20260101T000000_" + "0" * 32 + "/log").status_code == 404
    assert c.get("/sessions/..%2F..%2Fetc/log").status_code == 404


def test_file_path_outside_root_rejected(client_factory, tmp_path):
    c = client_factory()
    outside = write_video(tmp_path / "outside.mp4", 3)
    sid = c.post("/sessions", json={"stand": "s1"}).json()["session_id"]
    for p in (str(outside), "../outside.mp4", "/etc/passwd"):
        assert c.post(f"/sessions/{sid}/file", json={"path": p, "realtime": False}).status_code in (400, 403)
    (tmp_path / "media" / "link.mp4").symlink_to(outside)
    assert c.post(f"/sessions/{sid}/file", json={"path": "link.mp4", "realtime": False}).status_code == 403
    assert c.post(f"/sessions/{sid}/file", json={"path": "missing.mp4", "realtime": False}).status_code == 400


def test_unknown_session_404(client_factory):
    c = client_factory()
    bad = "nope"
    assert c.post(f"/sessions/{bad}/stop").status_code == 404
    assert c.get(f"/sessions/{bad}/log").status_code == 404
    assert c.post(f"/sessions/{bad}/offer", json={"sdp": "x", "type": "offer"}).status_code == 404
    assert c.post(f"/sessions/{bad}/file", json={"path": "a", "realtime": False}).status_code == 404
    with pytest.raises(Exception):
        with c.websocket_connect(f"/sessions/{bad}/results"):
            pass


def test_ws_disconnect_does_not_kill_router(client_factory, tmp_path):
    c = client_factory()
    sid = _run_file(c, tmp_path, 10)
    with c.websocket_connect(f"/sessions/{sid}/results") as ws:
        c.post(f"/sessions/{sid}/file", json={"path": "v.mp4", "realtime": False})
        ws.receive_json()
    # subscriber gone; logging must continue and stop must still complete the log
    r = c.post(f"/sessions/{sid}/stop")
    assert r.json()["frames"] == 10


def test_shutdown_closes_open_logs_incomplete(tmp_path):
    s = make_settings(tmp_path)
    with TestClient(build_app(s, pool_factory=fast_pipeline)) as c:
        sid = c.post("/sessions", json={"stand": "s1"}).json()["session_id"]
    _, _, complete = read_log(Path(s.sessions_dir) / sid / "log.jsonl")
    assert complete is False
    assert '"footer"' in (Path(s.sessions_dir) / sid / "log.jsonl").read_text()


def test_health_endpoint(client_factory):
    c = client_factory()
    r = c.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "workers": 1, "models": {"fast": "t1"}, "sessions_open": 0}


def test_session_status_tracks_file_progress(client_factory, tmp_path):
    c = client_factory(require_token=True, stand_tokens={"s1": "k"})
    write_video(tmp_path / "media" / "v.mp4", 15)
    h = {"X-Stand-Token": "k"}
    sid = c.post("/sessions", json={"stand": "s1"}, headers=h).json()["session_id"]
    assert c.get(f"/sessions/{sid}").status_code == 401
    st = c.get(f"/sessions/{sid}", headers=h).json()
    assert st["file"] == "none" and st["submitted"] == 0 and st["webrtc"] is None
    assert c.post(f"/sessions/{sid}/file", json={"path": "v.mp4", "realtime": False},
                  headers=h).status_code == 200
    import time
    deadline = time.monotonic() + 30
    while True:
        st = c.get(f"/sessions/{sid}", headers=h).json()
        if st["file"] == "done" and st["logged"] == st["submitted"]:
            break
        assert time.monotonic() < deadline, st
        time.sleep(0.05)
    assert st["file_frames"] == 15 and st["submitted"] == 15 and st["file_error"] is None
    assert c.post(f"/sessions/{sid}/stop", headers=h).json()["frames"] == 15
    assert c.get(f"/sessions/{sid}", headers=h).json()["closed"] is True
    assert c.get("/sessions/nope_20260101T000000_" + "0" * 32).status_code == 404
