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
import dataclasses
import logging
import re
import time
import uuid as uuidlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

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
_ID_RE = re.compile(r"([A-Za-z0-9-]{1,32})_(\d{8}T\d{6})_([0-9a-f]{32})")  # use fullmatch


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
    variant: str | None = None  # chosen detector ("detect" | "segment"), see FrameRef.variant
    # one ingest kind per session (frame ids restart at 0 in file mode): None until the first
    # accepted /offer ("webrtc"; re-offers allowed) or /file ("file"; only one file)
    ingest_kind: str | None = None
    file_task: asyncio.Task | None = None
    file_ingest: FileIngest | None = None
    file_error: str | None = None
    subscribers: set[Subscriber] = field(default_factory=set)
    last_activity: float = 0.0  # Core.clock() of the last frame / API call (idle reaping)


class Core:
    def __init__(self, settings: Settings, pool: InferencePool, models: dict[str, str]):
        self.settings = settings
        self.pool = pool
        self.models = models
        self.sessions: dict[str, Session] = {}  # by session_id
        self.by_key: dict[str, Session] = {}  # by uuid
        self.ingest = WebRtcIngest(self.on_frame, ice_servers=lambda: settings.ice_servers_now("server"),
                                   video_codecs=settings.video_codecs,
                                   max_side=settings.max_side, on_closed=self._on_ingest_closed)
        self._router: asyncio.Task | None = None
        self._reaper: asyncio.Task | None = None
        self.clock = time.monotonic  # injectable (tests)
        self._log_exec = ThreadPoolExecutor(1, thread_name_prefix="log-writer")

    # ---------------------------------------------------------------- lifecycle
    def start(self) -> None:
        self._router = asyncio.create_task(self._route(), name="results-router")
        if self.settings.session_idle_timeout > 0:
            self._reaper = asyncio.create_task(self._reap_loop(), name="idle-session-reaper")

    async def _reap_loop(self) -> None:
        interval = min(60.0, max(1.0, self.settings.session_idle_timeout / 4))
        while True:
            await asyncio.sleep(interval)
            try:
                await self.reap_idle()
            except Exception:
                log.exception("idle session reaping failed")

    def touch(self, s: Session) -> None:
        s.last_activity = self.clock()

    async def reap_idle(self) -> list[str]:
        """Close and prune sessions idle for ``session_idle_timeout`` (no frames, no API
        call): log closed with complete=False, ingest (WebRTC peer / file task) released,
        removed from the registry. Returns the pruned session ids."""
        timeout = self.settings.session_idle_timeout
        if timeout <= 0:
            return []
        now = self.clock()
        pruned = []
        for s in list(self.sessions.values()):
            if now - s.last_activity < timeout:
                continue
            if not s.closed:
                log.warning("session %s: no frames and no API call for %.0f s -- abandoned; "
                            "closing its log (complete=false)", s.session_id, now - s.last_activity)
                await self._stop_ingest(s)
                await self._finish(s, complete=False)
            self.sessions.pop(s.session_id, None)
            self.by_key.pop(s.key, None)
            pruned.append(s.session_id)
        return pruned

    async def shutdown(self) -> None:
        if self._reaper is not None:
            self._reaper.cancel()
            await asyncio.gather(self._reaper, return_exceptions=True)
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
        s.last_activity = self.clock()
        if s.variant is not None:
            ref = dataclasses.replace(ref, variant=s.variant)
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
    def create(self, stand: str, doctor: str | None, crop: CropRect | None,
               variant: str | None = None) -> Session:
        started = datetime.now(timezone.utc)
        key = uuidlib.uuid4().hex
        sid = f"{stand}_{started.strftime('%Y%m%dT%H%M%S')}_{key}"
        d = self.settings.sessions_dir / sid
        d.mkdir(parents=True, exist_ok=False)
        header = LogHeader(schema_version=SCHEMA_VERSION,
                           session=SessionId(stand=stand, started_at=started, uuid=key),
                           doctor=doctor, crop=crop, models=self.models, model_variant=variant,
                           taxonomy_version=self.settings.taxonomy_version)
        s = Session(sid, stand, key, LogWriter(d / "log.jsonl", header), d / "log.jsonl")
        s.crop = crop
        s.variant = variant
        s.last_activity = self.clock()
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
    core.touch(s)
    return s


class CreateBody(BaseModel):
    stand: str = Field(pattern=STAND_RE)
    doctor: str | None = None
    crop: CropRect | None = None
    model: Literal["detect", "segment"] | None = None  # None: the first available


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
    available = core.settings.available_variants()
    if body.model is not None and available and body.model not in available:
        raise HTTPException(422, f"model {body.model!r} is not available (have: {available})")
    variant = body.model or (available[0] if available else None)
    s = core.create(body.stand, body.doctor, body.crop, variant)
    return {"session_id": s.session_id, "model": variant}


@router.post("/sessions/{session_id}/offer")
async def offer(session_id: str, body: OfferBody, request: Request):
    core = core_of(request)
    s = live_session(session_id, request)
    if s.closed:
        raise HTTPException(409, "session is stopped")
    if body.type != "offer":
        raise HTTPException(400, "type must be 'offer'")
    if s.ingest_kind == "file":
        raise HTTPException(409, "this session processes a video file; a WebRTC offer needs a "
                                 "new session")
    prev, s.ingest_kind = s.ingest_kind, "webrtc"  # claim before awaiting (no /file race)
    try:
        sdp = await core.ingest.handle_offer(body.sdp, s.key, s.crop)
    except IngestError as e:
        s.ingest_kind = prev
        raise HTTPException(400, str(e)) from e
    except BaseException:
        s.ingest_kind = prev
        raise
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
    if s.ingest_kind == "webrtc":
        raise HTTPException(409, "this session is a live WebRTC session; a video file needs a "
                                 "new session")
    if s.ingest_kind == "file":
        # frame ids restart at 0 per file: a second file would duplicate ids in the log
        raise HTTPException(409, "a video file was already started in this session; create a "
                                 "new session for another file")
    s.ingest_kind = "file"  # claim before awaiting (no concurrent /file or /offer)
    loop = asyncio.get_running_loop()
    try:  # validate now so a bad file is a 400, not a silent background failure
        await loop.run_in_executor(None, FileSource, path, body.realtime)
    except IngestError as e:
        s.ingest_kind = None
        raise HTTPException(400, str(e)) from e
    except BaseException:
        s.ingest_kind = None
        raise
    if s.closed:
        raise HTTPException(409, "session is stopped")
    ing = FileIngest(path, body.realtime, core.on_frame, s.key,
                     crop=s.crop, max_side=core.settings.max_side)
    s.file_ingest = ing
    s.file_error = None
    s.file_task = asyncio.create_task(_run_file(ing, s))
    return {"started": True}


async def _run_file(ing: FileIngest, s: Session) -> None:
    try:
        await ing.run()
    except asyncio.CancelledError:
        raise
    except Exception as e:
        s.file_error = str(e) or type(e).__name__
        log.exception("file ingest failed for %s", s.session_id)


def _file_state(s: Session) -> str:
    t = s.file_task
    if t is None:
        return "none"
    if not t.done():
        return "running"
    if t.cancelled():
        return "cancelled"
    return "failed" if s.file_error else "done"


@router.get("/health")
def health(request: Request):
    """Liveness/readiness: ``status`` "ok" = the app is up; ``ready`` = every inference worker
    has built and warmed its pipeline (frames sent before that may be dropped); ``healthy`` = at
    least one worker serves; ``failed_workers`` = slots that exhausted their restart budget;
    ``reason`` = why not ready (null when ready). No auth (it reveals only model versions and counters, no session data)."""
    core = core_of(request)
    pool = core.pool
    return {"status": "ok", "ready": pool.ready, "healthy": pool.healthy,
            "failed_workers": pool.failed_workers, "reason": pool.status_reason,
            "workers": core.settings.workers, "models": core.models,
            "sessions_open": sum(1 for s in core.sessions.values() if not s.closed)}


@router.get("/client-config")
def client_config(request: Request, stand: str | None = None):
    """What the stand page needs before connecting: ICE servers (STUN/TURN with fresh
    time-limited TURN credentials) and whether a stand token is required.

    Auth: the same per-stand check as every other endpoint. With ``require_token`` on, the
    caller must name its ``?stand=`` and send that stand's ``X-Stand-Token``, otherwise 401
    -- TURN credentials are never handed to anonymous clients. With it off nothing is checked
    (``stand`` is optional and only labels the TURN username)."""
    settings = core_of(request).settings
    if stand is not None and not re.fullmatch(STAND_RE, stand):
        raise HTTPException(422, "invalid stand")
    if settings.require_token:
        if stand is None:
            raise HTTPException(401, "missing stand (?stand=) and stand token")
        access.check_http(settings, stand, _token(request))
    return {"ice_servers": settings.ice_servers_now(stand or "stand"),
            "require_token": settings.require_token,
            "models": settings.available_variants()}


@router.get("/sessions/{session_id}")
def session_status(session_id: str, request: Request):
    """Progress counters of a live session (used by e2e/acceptance tests and diagnostics).

    ``submitted``: frames handed to the pool; ``logged``: records written to the log (real or
    dropped). ``file``: video-file mode state (none|running|done|failed|cancelled);
    ``file_frames``: frames the file ingest delivered. ``webrtc``: ingest counters of the live
    stream (``received == delivered + skipped_unreadable + skipped_stale``), null if none.
    A file session is finished when ``file`` is ``done`` and ``logged == submitted``.
    """
    core = core_of(request)
    s = live_session(session_id, request)
    st = core.ingest.last_stats(s.key)
    ing = s.file_ingest
    return {
        "session_id": s.session_id, "closed": s.closed,
        "submitted": s.submitted, "logged": s.logged,
        "file": _file_state(s), "file_error": s.file_error,
        "file_frames": ing.delivered_frames if ing is not None else 0,
        "webrtc": None if st is None else {
            "received": st.received, "delivered": st.delivered,
            "skipped_unreadable": st.skipped_unreadable, "skipped_stale": st.skipped_stale,
            "last_id": st.last_id},
    }


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
        core.touch(s)
        path = s.log_path
    else:  # e.g. after a server restart: serve what is on disk for a well-formed id
        m = _ID_RE.fullmatch(session_id)
        path = core.settings.sessions_dir / session_id / "log.jsonl"
        if not m or not path.is_file():
            raise HTTPException(404, "unknown session")
        access.check_http(core.settings, m.group(1), _token(request))
    return Response(path.read_text(encoding="utf-8"), media_type="application/x-ndjson")
