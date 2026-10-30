"""Video-file ingest (spec §4, §8а): same pipeline and frame binding as the live stream.

* ``FileSource(path, realtime)`` decodes a file with PyAV and yields
  ``(BGR frame, frame_id, pts)``: ``frame_id`` is the sequential decoded-frame number from
  0, ``pts`` is seconds from the first frame (stream pts * time_base; index / fps if the
  file has no timestamps).
* ``realtime=True`` paces output to the file's timestamps with absolute deadlines on a
  monotonic clock (no cumulative drift); if decoding falls more than ``_REANCHOR_S``
  behind, the schedule is re-anchored instead of bursting to catch up.
  ``realtime=False`` (batch) yields as fast as decoding allows.
* Errors (RF5): a missing / empty / non-video / corrupt file, a file without a video
  stream, or a video with no decodable frame raises ``IngestError`` (checked in the
  constructor). A file that ends mid-frame yields the frames that decode and then stops
  cleanly; undecodable packets are skipped and counted in ``decode_errors``.
* ``FileIngest`` runs a ``FileSource`` through the shared ``FrameSink`` (downscale to
  960, crop scaling, ``FrameRef``) and an ``on_frame(frame, ref)`` callback, exactly like
  ``WebRtcIngest``; decoding and pacing run in an executor thread, never on the loop.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import av
import numpy as np

from app.contracts.log_schema import CropRect, SessionId
from app.ingest._common import MAX_SIDE, FrameSink, IngestError, OnFrame, session_key

log = logging.getLogger(__name__)

_DEFAULT_FPS = 30.0
_REANCHOR_S = 0.5
# ffmpeg renders arbitrary text as an "ansi" video through the tty demuxer; not a video.
_TEXT_DEMUXERS = {"tty"}

__all__ = ["FileSource", "FileIngest", "IngestError"]


class FileSource:
    def __init__(self, path: Path, realtime: bool):
        self.path = Path(path)
        self.realtime = realtime
        self.decode_errors = 0
        self._stop = threading.Event()
        self.fps = self._probe()

    def stop(self) -> None:
        """Ask a running ``frames()`` to finish early (thread-safe; ends a pacing wait)."""
        self._stop.set()

    # ------------------------------------------------------------------ opening
    def _open(self):
        p = self.path
        if not p.is_file():
            raise IngestError(f"video file not found: {p.name}")
        if p.stat().st_size == 0:
            raise IngestError(f"video file is empty (0 bytes): {p.name}")
        try:
            container = av.open(str(p), "r")
        except (av.error.FFmpegError, OSError, ValueError) as e:
            raise IngestError(f"cannot open {p.name} as a video: {e}") from e
        if container.format.name in _TEXT_DEMUXERS:
            container.close()
            raise IngestError(f"{p.name} is a text file, not a video")
        if not container.streams.video:
            container.close()
            raise IngestError(f"no video stream in {p.name}")
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        return container, stream

    def _probe(self) -> float:
        container, stream = self._open()
        try:
            rate = stream.average_rate or stream.guessed_rate
            fps = float(rate) if rate else _DEFAULT_FPS
            if next(self._decode(container, stream), None) is None:
                raise IngestError(f"no decodable video frames in {self.path.name}")
        finally:
            container.close()
        self.decode_errors = 0
        return fps if fps > 0 else _DEFAULT_FPS

    def _decode(self, container, stream) -> Iterator[av.VideoFrame]:
        """Decoded frames; skips undecodable packets, stops on a demux error / EOF."""
        packets = container.demux(stream)
        while True:
            try:
                packet = next(packets)
            except StopIteration:
                return
            except (av.error.FFmpegError, OSError) as e:  # truncated / broken container
                log.warning("%s: demux stopped: %s", self.path.name, e)
                return
            try:
                frames = packet.decode()
            except av.error.FFmpegError as e:
                self.decode_errors += 1
                log.warning("%s: undecodable packet skipped: %s", self.path.name, e)
                continue
            yield from frames

    # ------------------------------------------------------------------ iteration
    def frames(self) -> Iterator[tuple[np.ndarray, int, float]]:
        container, stream = self._open()
        try:
            t0: float | None = None
            first_time: float | None = None
            for idx, vf in enumerate(self._decode(container, stream)):
                if self._stop.is_set():
                    return
                if vf.time is None:
                    pts = idx / self.fps
                else:
                    if first_time is None:
                        first_time = vf.time
                    pts = max(0.0, vf.time - first_time)
                img = vf.to_ndarray(format="bgr24")
                if self.realtime:
                    now = time.monotonic()
                    if t0 is None:
                        t0 = now - pts
                    delay = t0 + pts - now
                    if delay > 0 and self._stop.wait(delay):
                        return
                    elif delay < -_REANCHOR_S:
                        t0 = now - pts  # fell far behind: re-anchor, do not burst
                yield img, idx, pts
        finally:
            container.close()


class FileIngest:
    """Async adapter: a video file through the same on_frame path as WebRTC."""

    def __init__(self, path: Path, realtime: bool, on_frame: OnFrame, session: SessionId | str,
                 crop: CropRect | None = None, max_side: int = MAX_SIDE):
        self.path = Path(path)
        self.realtime = realtime
        self.session_id = session_key(session)
        self.crop = crop
        self.sink = FrameSink(on_frame, max_side)
        self.delivered_frames = 0

    async def run(self) -> int:
        """Deliver every frame; returns the count. Raises IngestError if unopenable."""
        loop = asyncio.get_running_loop()
        source = await loop.run_in_executor(None, FileSource, self.path, self.realtime)
        it = source.frames()
        done = object()
        # step() and close() run in executor threads; the lock makes close() wait for an
        # in-flight step, so a cancelled run() never closes a generator that is executing
        # ("ValueError: generator already executing" would mask CancelledError and leave
        # the container open until GC).
        lock = threading.Lock()

        def step():
            with lock:
                return _step()

        def _step():
            item = next(it, done)
            if item is done:
                return done
            img, fid, pts = item
            small, crop = self.sink.prepare(img, self.crop)
            return small, crop, fid, pts

        try:
            while True:
                item = await loop.run_in_executor(None, step)
                if item is done:
                    break
                small, crop, fid, pts = item
                await self.sink.push(small, self.session_id, fid, pts, crop, prepared=True)
                self.delivered_frames += 1
        finally:
            source.stop()  # ends a realtime pacing wait promptly

            def close() -> None:
                with lock:
                    it.close()

            # the close runs to completion in its thread even if this await is cancelled again
            await loop.run_in_executor(None, close)
        return self.delivered_frames
