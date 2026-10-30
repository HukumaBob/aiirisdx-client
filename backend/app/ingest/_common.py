"""Shared ingest path: downscale to the inference working size and deliver (frame, FrameRef).

Both WebRTC and video-file ingest go through ``FrameSink.push`` so a file is processed
exactly like a live stream (spec §4: same pipeline, same frame binding).

* Downscale (ruling R8): every frame whose longer side exceeds ``max_side`` (960) is
  resized with ``cv2.INTER_AREA`` in an executor thread (never on the event loop), and
  ``FrameRef.crop`` (pixels of the original frame) is scaled by the same factor so it
  addresses the same region of the delivered frame. The log's bbox convention is
  normalized 0..1 of the frame, which is scale-invariant, so nothing downstream changes;
  the original size is ``delivered size / scale``.
* A delivered frame is a fresh array that ingest never touches again (the pool stores
  it uncopied).
"""

from __future__ import annotations

import asyncio
import inspect
import math
from collections.abc import Awaitable, Callable

import cv2
import numpy as np

from app.contracts.log_schema import CropRect, SessionId
from app.pipeline.stage import FrameRef

MAX_SIDE = 960

OnFrame = Callable[[np.ndarray, FrameRef], Awaitable[None] | None]


class IngestError(Exception):
    """An input cannot be ingested (unopenable / not a video / no frames)."""


def session_key(session: SessionId | str) -> str:
    """String session id used in FrameRef / pool results: the session UUID."""
    return session if isinstance(session, str) else session.uuid


def scale_crop(crop: CropRect | None, s: float, size: tuple[int, int]) -> CropRect | None:
    """Scale a crop rect by ``s`` and clamp it to the scaled frame ``size`` = (w, h)."""
    if crop is None or s == 1.0:
        return crop
    w, h = size
    x = min(int(math.floor(crop.x * s)), w - 1)
    y = min(int(math.floor(crop.y * s)), h - 1)
    cw = max(1, min(int(round(crop.w * s)), w - x))
    ch = max(1, min(int(round(crop.h * s)), h - y))
    return CropRect(x=x, y=y, w=cw, h=ch)


def downscale(frame: np.ndarray, max_side: int = MAX_SIDE) -> tuple[np.ndarray, float]:
    """Return (frame resized so max(h, w) <= max_side, scale factor). Blocking (cv2)."""
    h, w = frame.shape[:2]
    m = max(h, w)
    if m <= max_side:
        return frame, 1.0
    s = max_side / m
    size = (max(1, round(w * s)), max(1, round(h * s)))
    return cv2.resize(frame, size, interpolation=cv2.INTER_AREA), s


async def call_on_frame(on_frame: OnFrame, frame: np.ndarray, ref: FrameRef) -> None:
    res = on_frame(frame, ref)
    if inspect.isawaitable(res):
        await res


class FrameSink:
    """Downscale off-loop, build the FrameRef, hand (frame, ref) to ``on_frame``."""

    def __init__(self, on_frame: OnFrame, max_side: int = MAX_SIDE):
        self.on_frame = on_frame
        self.max_side = max_side

    def prepare(self, frame: np.ndarray, crop: CropRect | None
                ) -> tuple[np.ndarray, CropRect | None]:
        """Blocking part (run in an executor)."""
        small, s = downscale(frame, self.max_side)
        h, w = small.shape[:2]
        return small, scale_crop(crop, s, (w, h))

    async def push(self, frame: np.ndarray, session_id: str, frame_id: int, pts: float,
                   crop: CropRect | None = None, prepared: bool = False) -> None:
        """Deliver one frame. ``prepared=True``: ``frame``/``crop`` already went through
        ``prepare`` (callers that batch work into one executor call)."""
        if not prepared:
            loop = asyncio.get_running_loop()
            frame, crop = await loop.run_in_executor(None, self.prepare, frame, crop)
        ref = FrameRef(session_id=session_id, frame_id=frame_id, pts=pts, crop=crop)
        await call_on_frame(self.on_frame, frame, ref)
