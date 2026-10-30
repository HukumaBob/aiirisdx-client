"""Sessions: creation, WebRTC offer, video-file mode, stop, log; plus the shared ``Core``.

Session id format (documented, tested): ``f"{stand}_{YYYYmmddTHHMMSS}_{uuid}"`` where the
time is the UTC start time and ``uuid`` is ``uuid4().hex`` (32 hex chars). ``stand`` is
restricted to ``[A-Za-z0-9-]{1,32}`` (no ``_``, no path characters), so the id parses back
unambiguously and is safe as a directory name. ``SessionId.uuid`` in the log header is that
same uuid; it is also the key used in ``FrameRef.session_id`` / pool results.

Results router (one task per app, ``Core._route``): consumes ``pool.results()`` and for each
``(uuid, record)`` (a) appends it to that session's LogWriter and (b) offers it to the
session's WebSocket subscribers. Records of unknown / already stopped sessions are discarded.
Records are never reordered or relabelled; log writing does not depend on subscribers.

Stop: ingest is stopped, then ``drain_timeout`` seconds are allowed for the results of all
frames submitted for the session (every submitted frame yields exactly one record), then the
LogWriter is closed with ``complete=True``.

Log writes (flush + fsync per line, ~120/s with four 30 fps streams) run on one dedicated
thread, in submission order, so the fsync latency never stalls the event loop (measured:
tests/test_loop_lag.py). ``Session.logged`` counts records that reached the file. Shutdown closes still-open logs with
``complete=False``. A log of a session that was never stopped (server crash) has no footer.
"""

from __future__ import annotations

import asyncio
import logging
import re
import uuid as uuidlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.api import access
from app.api.config import Settings
from app.contracts.log_schema import SCHEMA_VERSION, CropRect, FrameRecord, LogHeader, SessionId
from app.ingest._common import IngestError
from app.ingest.file_source import FileIngest, FileSource
from app.ingest.webrtc import WebRtcIngest
from app.logwriter import LogWriter
from app.pipeline.stage import FrameRef
from app.workers.pool import InferencePool

log = logging.getLogger(__name__)

router = APIRouter()

STAND_RE = r"^[A-Za-z0-9-]{1,32}$"
_ID_RE = re.compile(r"^([A-Za-z0-9-]{1,32})_(\d{8}T\d{6})_([0-9a-f]{32})$")


class Subscriber:
    """Bounded drop-oldest buffer for one WebSocket; dropped items are simply skipped,
    the remaining ones keep their own frame_id."""

    def __init__(self, size: int):
        self.items: list[dict | None] = []
        self.size = size
        self.event = asyncio.Event()
        self.dropped = 0

    def offer(self, item: dict | None) -> None:
        if len(self.items) >= self.size:
            self.items.pop(0)
            self.dropped += 1
        self.items.append(item)
        self.event.set()

    async def get(self) -> dict | None:
        while not self.items:
            self.event.clear()
            await self.event.wait()
        return self.items.pop(0)


@dataclass
class Session:
    session_id: str
    stand: str
    key: str  # uuid; FrameRef.session_id
    writer: LogWriter
    log_path: Path
    submitted: int = 0
    logged: int = 0
    closed: bool = False
    frames: int = 0
    crop: CropRect | None = None
    file_task: asyncio.Task | None = None
    subscribers: set[Subscriber] = field(default_factory=set)


class Core:
    def __init__(self, settings: Settings, pool: InferencePool, models: dict[str, str]):
        self.settings = settings
        self.pool = pool
        self.models = models
        self.sessions: dict[str, Session] = {}  # by session_id
        self.by_key: dict[str, Session] = {}  # by uuid
        self.ingest = WebRtcIngest(self.on_frame, ice_servers=settings.ice_servers,
                                   video_codecs=settings.video_codecs,
                                   max_side=settings.max_side, on_closed=self._on_ingest_closed)
        self._router: asyncio.Task | None = None
        self._log_exec = ThreadPoolExecutor(1, thread_name_prefix="log-writer")

    # ---------------------------------------------------------------- lifecycle
    def start(self) -> None:
        self._router = asyncio.create_task(self._route(), name="results-router")

    async def shutdown(self) -> None:
        for s in list(self.sessions.values()):
            await self._stop_ingest(s)
        await self.ingest.close()
        await self.pool.close()
        if self._router is not None:
            await self._router  # ends when the pool has delivered everything
        for s in list(self.sessions.values()):
            await self._finish(s, complete=False)
        self._log_exec.shutdown(wait=True)

    # ---------------------------------------------------------------- frames in / results out
    def on_frame(self, frame, ref: FrameRef) -> None:
        s = self.by_key.get(ref.session_id)
        if s is None or s.closed:
            return
        if self.pool.submit(frame, ref):
            s.submitted += 1

    def _on_ingest_closed(self, key: str) -> None:
        # The WebRTC connection ended by itself; ingest already released it. The log stays
        # open until /stop (or shutdown) so in-flight results are still recorded.
        log.info("session key %s: WebRTC connection closed", key)

    async def _route(self) -> None:
        async for key, rec in self.pool.results():
            try:
                self._deliver(key, rec)
            except Exception:
                log.exception("failed to deliver a result for %s", key)

    def _deliver(self, key: str, rec: FrameRecord) -> None:
        s = self.by_key.get(key)
        if s is None or s.closed:
            return
        fut = asyncio.get_running_loop().run_in_executor(self._log_exec, s.writer.append, rec)
        fut.add_done_callback(lambda f, s=s: self._logged(s, f))
        if s.subscribers:
            msg = rec.model_dump(mode="json")
            for sub in list(s.subscribers):
                sub.offer(msg)

    @staticmethod
    def _logged(s: Session, fut: asyncio.Future) -> None:
        if fut.exception() is not None:
            log.error("log write failed for %s: %r", s.session_id, fut.exception())
        s.logged += 1

    # ---------------------------------------------------------------- session ops
    def create(self, stand: str, doctor: str | None, crop: CropRect | None) -> Session:
        started = datetime.now(timezone.utc)
        key = uuidlib.uuid4().hex
        sid = f"{stand}_{started.strftime('%Y%m%dT%H%M%S')}_{key}"
        d = self.settings.sessions_dir / sid
        d.mkdir(parents=True, exist_ok=False)
        header = LogHeader(schema_version=SCHEMA_VERSION,
                           session=SessionId(stand=stand, started_at=started, uuid=key),
                           doctor=doctor, crop=crop, models=self.models,
                           taxonomy_version=self.settings.taxonomy_version)
        s = Session(sid, stand, key, LogWriter(d / "log.jsonl", header), d / "log.jsonl")
        s.crop = crop
        self.sessions[sid] = s
        self.by_key[key] = s
        return s

    async def _stop_ingest(self, s: Session) -> None:
        await self.ingest.close_session(s.key)
        t = s.file_task
        if t is not None and not t.done():
            t.cancel()
            await asyncio.gather(t, return_exceptions=True)

    async def stop(self, s: Session) -> int:
        if s.closed:
            return s.frames
        await self._stop_ingest(s)
        deadline = asyncio.get_running_loop().time() + self.settings.drain_timeout
        while s.logged < s.submitted and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.02)
        await self._finish(s, complete=True)
        return s.frames

    async def _finish(self, s: Session, complete: bool) -> None:
        if s.closed:
            return
        s.closed = True
        s.frames = s.logged
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(self._log_exec, s.writer.close, complete)  # after queued appends
        for sub in list(s.subscribers):
            sub.offer(None)  # end-of-stream for the websocket
        self.by_key.pop(s.key, None)


# ---------------------------------------------------------------- dependencies
def core_of(request: Request) -> Core:
    return request.app.state.core


def _token(request: Request) -> str | None:
    return request.headers.get(access.HEADER)


def live_session(session_id: str, request: Request) -> Session:
    """Session lookup + stand-token check (404 first for unknown ids, then 401)."""
    core = core_of(request)
    s = core.sessions.get(session_id)
    if s is None:
        raise HTTPException(404, "unknown session")
    access.check_http(core.settings, s.stand, _token(request))
    return s


class CreateBody(BaseModel):
    stand: str = Field(pattern=STAND_RE)
    doctor: str | None = None
    crop: CropRect | None = None


class OfferBody(BaseModel):
    sdp: str
    type: str = "offer"


class FileBody(BaseModel):
    path: str
    realtime: bool = True


@router.post("/sessions")
def create_session(body: CreateBody, request: Request):
    core = core_of(request)
    access.check_http(core.settings, body.stand, _token(request))
    s = core.create(body.stand, body.doctor, body.crop)
    return {"session_id": s.session_id}


@router.post("/sessions/{session_id}/offer")
async def offer(session_id: str, body: OfferBody, request: Request):
    core = core_of(request)
    s = live_session(session_id, request)
    if s.closed:
        raise HTTPException(409, "session is stopped")
    if body.type != "offer":
        raise HTTPException(400, "type must be 'offer'")
    try:
        sdp = await core.ingest.handle_offer(body.sdp, s.key, s.crop)
    except IngestError as e:
        raise HTTPException(400, str(e)) from e
    return {"sdp": sdp, "type": "answer"}


@router.post("/sessions/{session_id}/file")
async def start_file(session_id: str, body: FileBody, request: Request):
    core = core_of(request)
    s = live_session(session_id, request)
    if s.closed:
        raise HTTPException(409, "session is stopped")
    root = core.settings.file_root
    if root is None:
        raise HTTPException(403, "video file mode is disabled (no file_root configured)")
    root = root.resolve()
    path = (root / body.path).resolve()  # absolute body.path replaces root; symlinks resolved
    if not path.is_relative_to(root):
        raise HTTPException(403, "path outside the allowed directory")
    if s.file_task is not None and not s.file_task.done():
        raise HTTPException(409, "a file is already being processed")
    loop = asyncio.get_running_loop()
    try:  # validate now so a bad file is a 400, not a silent background failure
        await loop.run_in_executor(None, FileSource, path, body.realtime)
    except IngestError as e:
        raise HTTPException(400, str(e)) from e
    ing = FileIngest(path, body.realtime, core.on_frame, s.key,
                     crop=s.crop, max_side=core.settings.max_side)
    s.file_task = asyncio.create_task(_run_file(ing, s.session_id))
    return {"started": True}


async def _run_file(ing: FileIngest, session_id: str) -> None:
    try:
        await ing.run()
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("file ingest failed for %s", session_id)


@router.post("/sessions/{session_id}/stop")
async def stop_session(session_id: str, request: Request):
    core = core_of(request)
    s = live_session(session_id, request)
    return {"frames": await core.stop(s)}


@router.get("/sessions/{session_id}/log")
def get_log(session_id: str, request: Request):
    core = core_of(request)
    s = core.sessions.get(session_id)
    if s is not None:
        access.check_http(core.settings, s.stand, _token(request))
        path = s.log_path
    else:  # e.g. after a server restart: serve what is on disk for a well-formed id
        m = _ID_RE.match(session_id)
        path = core.settings.sessions_dir / session_id / "log.jsonl"
        if not m or not path.is_file():
            raise HTTPException(404, "unknown session")
        access.check_http(core.settings, m.group(1), _token(request))
    return Response(path.read_text(encoding="utf-8"), media_type="application/x-ndjson")
