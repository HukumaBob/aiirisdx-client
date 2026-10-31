"""Acceptance e2e (Task 13): video file -> session -> finished -> stop -> log.

Flow: POST /sessions -> POST /sessions/{id}/file (realtime=False) -> poll
GET /sessions/{id} until the file is fully ingested and every submitted frame has a log
record -> POST /stop -> GET /log. Checks the log against the frame table produced by
``FileSource`` for the same file (frame ids sequential from 0):

* one log frame line per file frame (every submitted frame yields exactly one record, real
  or ``dropped``), frame ids unique and exactly ``0..n-1``;
* every bbox value within 0..1;
* the header has ``schema_version`` "1.0" and the model versions (``models``);
* the footer says ``complete: true`` with the same frame count.

Two variants share the same checks:

* ``test_file_mode_e2e_in_process`` -- the real app (``build_app``) with a fast stub
  pipeline (spawned worker processes, real ingest/pool/log path), no Docker, no weights;
  always runs (CI).
* ``test_file_mode_e2e_against_stack`` -- against a running deployment (deploy/
  docker-compose). Skipped unless ``AIIRIS_E2E_BASE_URL`` (e.g. ``http://localhost:18080/api``)
  and ``AIIRIS_E2E_MEDIA_DIR`` (host directory mounted as the backend's ``AIIRIS_FILE_ROOT``)
  are set; ``AIIRIS_E2E_TOKEN``/``AIIRIS_E2E_STAND`` if the stack requires a stand token.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path

import av
import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api.config import Settings, build_app
from app.contracts.log_schema import Detection
from app.ingest.file_source import FileSource
from app.pipeline.runner import Pipeline
from app.pipeline.stage import StageResult

N_FRAMES = 90
POLL_TIMEOUT_S = 120.0


class BoxStage:
    """Stub detector: one box whose position depends on the frame id (stays in 0..1)."""

    name = "stub_detect"
    version = "stub-1"
    kind = "detector"

    def process(self, frame, ref, ctx):
        x = (ref.frame_id % 10) / 20
        d = Detection(bbox=(x, 0.25, 0.4, 0.5), class_name="polyp", confidence=0.8)
        return StageResult(frame_id=ref.frame_id, stage=self.name, detections=[d])


def stub_pipeline() -> Pipeline:
    return Pipeline([BoxStage()])


def make_video(path: Path, n: int = N_FRAMES, size=(1280, 720), fps: int = 30) -> Path:
    """Small H.264 test video with motion; 1280x720 so the ingest downscale path is used."""
    w, h = size
    with av.open(str(path), "w") as out:
        st = out.add_stream("libx264", rate=fps)
        st.width, st.height, st.pix_fmt = w, h, "yuv420p"
        for i in range(n):
            img = np.full((h, w, 3), (i * 3) % 256, np.uint8)
            img[:, (i * 8) % w] = 255
            for pkt in st.encode(av.VideoFrame.from_ndarray(img, format="bgr24")):
                out.mux(pkt)
        for pkt in st.encode():
            out.mux(pkt)
    return path


def file_frame_ids(path: Path) -> list[int]:
    return [fid for _, fid, _ in FileSource(path, realtime=False).frames()]


def run_flow(http, video_name: str, stand: str = "e2e-1") -> tuple[str, dict]:
    """Drive the API; returns (log text, last status). ``http`` is httpx-like."""
    r = http.post("/sessions", json={"stand": stand, "doctor": "e2e"})
    assert r.status_code == 200, r.text
    sid = r.json()["session_id"]
    r = http.post(f"/sessions/{sid}/file", json={"path": video_name, "realtime": False})
    assert r.status_code == 200, r.text
    deadline = time.monotonic() + POLL_TIMEOUT_S
    while True:
        st = http.get(f"/sessions/{sid}").json()
        assert st["file"] in ("running", "done"), st
        if st["file"] == "done" and st["logged"] == st["submitted"]:
            break
        assert time.monotonic() < deadline, f"session did not finish: {st}"
        time.sleep(0.1)
    r = http.post(f"/sessions/{sid}/stop")
    assert r.status_code == 200, r.text
    assert r.json()["frames"] == st["submitted"]
    r = http.get(f"/sessions/{sid}/log")
    assert r.status_code == 200, r.text
    return r.text, st


def check_log(text: str, expected_ids: list[int]) -> None:
    lines = [json.loads(x) for x in text.splitlines() if x.strip()]
    header, footer = lines[0], lines[-1]
    frames = [x for x in lines if x["type"] == "frame"]
    assert header["type"] == "header"
    assert header["schema_version"] == "1.0"
    assert header["models"], "header must carry model versions"
    assert all(isinstance(v, str) and v for v in header["models"].values())
    assert footer["type"] == "footer" and footer["complete"] is True
    assert footer["frames"] == len(frames)
    ids = [f["frame_id"] for f in frames]
    assert len(ids) == len(set(ids)), "frame_id must be unique"
    assert sorted(ids) == expected_ids, "log frame ids must equal the file's frame table"
    assert len(frames) == len(expected_ids)
    for f in frames:
        for d in f["detections"]:
            assert all(0.0 <= v <= 1.0 for v in d["bbox"]), d
            x, y, w, h = d["bbox"]
            assert x + w <= 1.0 + 1e-6 and y + h <= 1.0 + 1e-6, d


def test_file_mode_e2e_in_process(tmp_path):
    media = tmp_path / "media"
    media.mkdir()
    video = make_video(media / "e2e.mp4")
    expected = file_frame_ids(video)
    assert expected == list(range(N_FRAMES))
    settings = Settings(sessions_dir=tmp_path / "sessions", file_root=media, workers=1,
                        queue_size=256, drain_timeout=10.0)
    with TestClient(build_app(settings, pool_factory=stub_pipeline)) as c:
        assert c.get("/health").json()["status"] == "ok"
        text, st = run_flow(c, "e2e.mp4")
    assert st["file_frames"] == N_FRAMES and st["submitted"] == N_FRAMES
    check_log(text, expected)
    header = json.loads(text.splitlines()[0])
    assert header["models"] == {"stub_detect": "stub-1"}
    frames = [json.loads(x) for x in text.splitlines()[1:-1]]
    real = [f for f in frames if not f["dropped"]]
    assert real and all(len(f["detections"]) == 1 for f in real)


BASE_URL = os.environ.get("AIIRIS_E2E_BASE_URL")
MEDIA_DIR = os.environ.get("AIIRIS_E2E_MEDIA_DIR")


@pytest.mark.skipif(not (BASE_URL and MEDIA_DIR),
                    reason="set AIIRIS_E2E_BASE_URL and AIIRIS_E2E_MEDIA_DIR to run against a stack")
def test_file_mode_e2e_against_stack():
    media = Path(MEDIA_DIR)
    name = f"e2e-{uuid.uuid4().hex[:8]}.mp4"
    video = make_video(media / name)
    try:
        expected = file_frame_ids(video)
        headers = {}
        if os.environ.get("AIIRIS_E2E_TOKEN"):
            headers["X-Stand-Token"] = os.environ["AIIRIS_E2E_TOKEN"]
        stand = os.environ.get("AIIRIS_E2E_STAND", "e2e-1")
        with httpx.Client(base_url=BASE_URL.rstrip("/"), headers=headers, timeout=30.0) as http:
            h = http.get("/health")
            assert h.status_code == 200 and h.json()["status"] == "ok", h.text
            text, st = run_flow(http, name, stand)
        assert st["submitted"] == len(expected)
        check_log(text, expected)
    finally:
        video.unlink(missing_ok=True)
