"""Ingest tests (Task 7): video-file source/ingest and WebRTC ingest through aiortc loopback.

Test videos are generated with PyAV into tmp_path. The WebRTC test runs a real
client RTCPeerConnection -> server WebRtcIngest connection on localhost, so frames go
through real encoding (VP8 or H.264) and RTP packetization.
"""

from __future__ import annotations

import asyncio
import fractions
import time
from pathlib import Path

import av
import numpy as np
import pytest
from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from aiortc.mediastreams import MediaStreamError

from app.contracts.frame_id import BLOCK, encode_frame_id
from app.contracts.log_schema import CropRect, LogHeader, SessionId
from app.ingest.file_source import FileIngest, FileSource
from app.ingest.webrtc import IngestError, WebRtcIngest
from app.logwriter import LogWriter, read_log
from app.pipeline.stage import FrameRef

FPS = 30


# ---------------------------------------------------------------- helpers
def body_value(i: int) -> int:
    return 40 + (i % 8) * 20  # 40..180, distinct per frame class, survives the codec


def write_video(path: Path, n: int, size=(320, 240), fps=FPS, codec="libx264",
                fmt: str | None = None, options: dict | None = None) -> Path:
    w, h = size
    with av.open(str(path), "w", format=fmt, options=options or {}) as out:
        st = out.add_stream(codec, rate=fps)
        st.width, st.height, st.pix_fmt = w, h, "yuv420p"
        out.start_encoding()  # write the header even when no frame follows (n == 0)
        for i in range(n):
            img = np.full((h, w, 3), body_value(i), np.uint8)
            img[:, (i * 4) % w] = 255  # a little motion
            for pkt in st.encode(av.VideoFrame.from_ndarray(img, format="bgr24")):
                out.mux(pkt)
        for pkt in st.encode():
            out.mux(pkt)
    return path


def session_id() -> SessionId:
    from datetime import datetime, timezone
    return SessionId(stand="stand-1", started_at=datetime(2026, 10, 28, tzinfo=timezone.utc),
                     uuid="0f3c-test")


# ---------------------------------------------------------------- file source
def test_file_realtime_paces_to_fps(tmp_path):
    path = write_video(tmp_path / "rt.mp4", 72)
    stamps, ids, pts = [], [], []
    for frame, fid, p in FileSource(path, realtime=True).frames():
        stamps.append(time.monotonic())
        ids.append(fid)
        pts.append(p)
        assert frame.ndim == 3 and frame.shape[2] == 3 and frame.dtype == np.uint8
    assert ids == list(range(72))
    assert pts[0] == 0.0 and pts[-1] == pytest.approx(71 / FPS, abs=1e-3)
    measured = (len(stamps) - 1) / (stamps[-1] - stamps[0])
    assert abs(measured - FPS) / FPS < 0.05, measured


def test_file_batch_is_faster_than_realtime(tmp_path):
    path = write_video(tmp_path / "batch.mp4", 72)
    t0 = time.monotonic()
    out = list(FileSource(path, realtime=False).frames())
    elapsed = time.monotonic() - t0
    assert [fid for _, fid, _ in out] == list(range(72))
    assert elapsed < 0.5 * (72 / FPS), elapsed  # nominal duration 2.4 s


def test_empty_and_corrupt_file(tmp_path):
    """RF5: unopenable inputs raise IngestError; truncated tails stop cleanly."""
    empty = tmp_path / "empty.mp4"
    empty.write_bytes(b"")
    garbage = tmp_path / "garbage.mp4"
    garbage.write_bytes(np.random.default_rng(1).integers(0, 256, 50_000, np.uint8).tobytes())
    text = tmp_path / "notes.txt"
    text.write_text("this is not a video\n" * 100)
    missing = tmp_path / "missing.mp4"
    zero = tmp_path / "zero.mkv"
    write_video(zero, 0, fmt="matroska")
    full_mp4 = write_video(tmp_path / "full.mp4", 60)
    no_moov = tmp_path / "no_moov.mp4"  # mp4 cut before its index (moov at the end)
    no_moov.write_bytes(full_mp4.read_bytes()[: full_mp4.stat().st_size // 2])

    for bad in (empty, garbage, text, missing, zero, no_moov):
        with pytest.raises(IngestError) as ei:
            list(FileSource(bad, realtime=False).frames())
        assert str(bad.name) in str(ei.value), str(ei.value)

    # truncated mid-frame in a streamable container: decodable frames, then a clean stop
    full_mkv = write_video(tmp_path / "full.mkv", 60, fmt="matroska")
    cut = tmp_path / "cut.mkv"
    data = full_mkv.read_bytes()
    cut.write_bytes(data[: int(len(data) * 0.6)])
    t0 = time.monotonic()
    got = list(FileSource(cut, realtime=False).frames())
    assert time.monotonic() - t0 < 10
    assert 0 < len(got) < 60
    assert [fid for _, fid, _ in got] == list(range(len(got)))

    # the async ingest surfaces the same error; the session closes its log complete=False
    async def run_bad():
        log_path = tmp_path / "s.jsonl"
        log = LogWriter(log_path, LogHeader(session=session_id(), taxonomy_version="t"))
        delivered = []
        ingest = FileIngest(garbage, realtime=False, on_frame=lambda f, r: delivered.append(r),
                            session=session_id())
        try:
            await ingest.run()
        except IngestError:
            log.close(complete=False)
        else:
            pytest.fail("IngestError expected")
        _, records, complete = read_log(log_path)
        assert complete is False and records == [] and delivered == []

    asyncio.run(run_bad())


async def test_file_ingest_downscales_and_scales_crop(tmp_path):
    path = write_video(tmp_path / "hd.mp4", 5, size=(1920, 1080))
    got: list[tuple[np.ndarray, FrameRef]] = []

    async def on_frame(frame, ref):
        got.append((frame, ref))

    crop = CropRect(x=480, y=0, w=1080, h=1080)
    n = await FileIngest(path, realtime=False, on_frame=on_frame, session=session_id(),
                         crop=crop).run()
    assert n == 5 and len(got) == 5
    for i, (frame, ref) in enumerate(got):
        assert frame.shape == (540, 960, 3)
        assert ref.frame_id == i and ref.session_id == session_id().uuid
        assert ref.pts == pytest.approx(i / FPS, abs=1e-3)
        assert ref.crop == CropRect(x=240, y=0, w=540, h=540)


# ---------------------------------------------------------------- WebRTC (RF3)
class ScriptedTrack(VideoStreamTrack):
    """Sends a scripted sequence: each entry is a marker id or None (no marker)."""

    def __init__(self, script: list[int | None], size=(640, 360)):
        super().__init__()
        self.script = script
        self.w, self.h = size
        self.i = 0

    async def recv(self):
        if self.i >= len(self.script):
            self.stop()
            raise MediaStreamError
        pts, time_base = await self.next_timestamp()
        fid = self.script[self.i]
        self.i += 1
        if fid is None:
            img = np.full((self.h, self.w, 3), 230, np.uint8)  # no marker, distinct body
            img[:BLOCK] = 128  # flat mid-gray top band: no readable marker
        else:
            img = encode_frame_id(np.full((self.h, self.w, 3), body_value(fid), np.uint8), fid)
        frame = av.VideoFrame.from_ndarray(img, format="bgr24")
        frame.pts, frame.time_base = pts, time_base
        return frame


def make_script(n: int) -> list[int | None]:
    """ids 0..n-1 interleaved with frames without a marker and stale (repeated) ids."""
    script: list[int | None] = []
    for i in range(n):
        script.append(i)
        if i % 10 == 4:
            script.append(None)
        if i % 10 == 7 and i >= 3:
            script.append(i - 3)  # stale id: must never be accepted
    return script


# 1920x1080 over H.264 is not included: aiortc's own H.264 sender hardcodes level 3.1
# (a 720p level) and its 1080p stream breaks down in loopback (see task-7 report).
@pytest.mark.parametrize("codec,size", [(None, (640, 360)), ("video/H264", (640, 360)),
                                        (None, (1920, 1080))])
async def test_webrtc_frame_without_marker_is_skipped_not_misattributed(codec, size):
    script = make_script(60)
    got: list[tuple[np.ndarray, FrameRef]] = []
    ingest = WebRtcIngest(on_frame=lambda f, r: got.append((f, r)), ice_servers=[],
                          video_codecs=[codec] if codec else None)
    client = RTCPeerConnection()
    client.addTrack(ScriptedTrack(script, size))
    try:
        await client.setLocalDescription(await client.createOffer())
        answer = await ingest.handle_offer(client.localDescription.sdp, session_id())
        negotiated = next(ln for ln in answer.splitlines() if ln.startswith("a=rtpmap:"))
        assert (codec or "video/VP8").split("/")[1] in negotiated, negotiated
        await client.setRemoteDescription(RTCSessionDescription(sdp=answer, type="answer"))
        # wait for the stream to finish (~2.4 s) and the tail to arrive
        deadline, last_n, still = time.monotonic() + 20, -1, 0
        while time.monotonic() < deadline:
            await asyncio.sleep(0.25)
            n = ingest.received_frames
            still = still + 1 if n == last_n and n > 0 else 0
            last_n = n
            if still >= 6:
                break
    finally:
        await client.close()
        await ingest.close_session(session_id().uuid)

    ids = [r.frame_id for _, r in got]
    valid = set(range(60))
    read_rate = len(ids) / 60
    print(f"\ncodec={codec or 'default'} size={size} received={ingest.received_frames} "
          f"delivered={len(ids)} skipped={ingest.skipped_frames} read_rate={read_rate:.3f}")
    assert ids == sorted(set(ids)), "ids must be strictly increasing"
    assert set(ids) <= valid
    assert ingest.received_frames == len(ids) + ingest.skipped_frames
    stale_or_none = len(script) - 60
    assert ingest.skipped_frames >= stale_or_none - (len(script) - ingest.received_frames)
    assert read_rate >= 0.9, read_rate
    for frame, ref in got:
        assert ref.session_id == session_id().uuid
        # body brightness tells which frame this really is: never a no-marker / other frame
        body = float(frame[40:, :].mean())
        assert abs(body - body_value(ref.frame_id)) < 8, (ref.frame_id, body)
        # downscaled to the working size (R8); the marker band (rows 0..15 of the original,
        # replaced by row 16) is uniform along y in the delivered frame
        s = min(1.0, 960 / max(size))
        assert frame.shape[:2] == (round(size[1] * s), round(size[0] * s))
        band = int(BLOCK * s)
        assert np.array_equal(frame[:band], np.broadcast_to(frame[0], frame[:band].shape))
    pts = [r.pts for _, r in got]
    assert pts == sorted(pts) and pts[0] >= 0.0
