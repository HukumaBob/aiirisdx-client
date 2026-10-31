"""Inference worker pool with a bounded, drop-oldest queue (spec §4, §8а).

Design
------
* Ingest (WebRTC / video file, connection handlers) is separate from inference: callers
  only ``submit(frame, ref)`` and consume ``results()``. No session state lives in the pool
  beyond the frames currently queued / in flight.
* Each worker is a separate **process** (``multiprocessing`` *spawn* context, CUDA safe).
  The pipeline is built *inside* the worker by calling ``pipeline_factory()`` there, so the
  factory must be picklable (a top-level function or a ``functools.partial`` of one).
  Celery is deliberately not used for streams.
* The bounded queue lives in the parent. A frame is handed to a worker only when that
  worker is idle, so every queued frame is still evictable. When the queue is full the
  oldest queued frame **of the same session** is evicted (the globally oldest if that
  session has nothing queued) — DROP-OLDEST: ``submit`` always accepts the new frame and
  returns ``True`` unless the pool is closed (then ``False``).
* Every submitted frame yields exactly one ``(session_id, FrameRecord)`` from
  ``results()``: either the real result or ``FrameRecord(dropped=True)`` with no boxes
  (evicted, pipeline exception, worker crash, shutdown). A result is never attributed to
  another frame: records are matched to submissions by an internal sequence number and the
  record's ``frame_id`` is checked against the submitted ``ref`` (RF1).
* Ordering: results arrive in completion order, possibly out of order across workers. The
  pool does not reorder; consumers key by ``(session_id, frame_id)`` (RF3).
* A pipeline exception or a worker crash never stops the pool: the frame is emitted as
  dropped and a dead worker process is restarted.

Threading model: all pool state is owned by the asyncio event loop thread (``submit`` must
be called from it). One background reader thread waits on the worker pipes / process
sentinels and forwards messages to the loop with ``call_soon_threadsafe``.

Frames travel to workers through ``multiprocessing`` pipes (pickled numpy arrays); a
shared-memory transport is a later optimization.

Horizontal scaling across machines is done later by running several backend instances,
each with its own pool, behind session-sticky routing. Not built here (no Redis needed).
"""

from __future__ import annotations

import asyncio
import logging
import multiprocessing as mp
import threading
import time
from collections import deque
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from multiprocessing.connection import Connection, wait

import numpy as np

from app.contracts.log_schema import FrameRecord
from app.pipeline.runner import Pipeline
from app.pipeline.stage import FrameRef

log = logging.getLogger(__name__)

_READY = "ready"
_POLL_S = 0.1


def _worker_main(factory: Callable[[], Pipeline], task_r: Connection, res_w: Connection) -> None:
    """Worker process entry point: build the pipeline here, then serve tasks until None/EOF."""
    pipeline = factory()
    res_w.send(_READY)
    while True:
        try:
            msg = task_r.recv()
        except EOFError:
            return
        if msg is None:
            return
        seq, frame, ref = msg
        try:
            rec = pipeline.run(frame, ref)
            res_w.send((seq, rec, None))
        except Exception as e:  # report and keep serving
            log.exception("pipeline failed on frame %s", getattr(ref, "frame_id", "?"))
            res_w.send((seq, None, repr(e)))


def dropped_record(ref: FrameRef) -> FrameRecord:
    return FrameRecord(frame_id=ref.frame_id, pts=ref.pts, detections=[], classification={},
                       anatomy=None, dropped=True)


@dataclass
class _Item:
    seq: int
    frame: np.ndarray
    ref: FrameRef


class _Worker:
    def __init__(self, ctx, factory, idx: int, gen: int):
        self.idx = idx
        self.gen = gen
        task_r, self.task_w = ctx.Pipe(duplex=False)
        self.res_r, res_w = ctx.Pipe(duplex=False)
        self.proc = ctx.Process(target=_worker_main, args=(factory, task_r, res_w),
                                name=f"inference-worker-{idx}", daemon=True)
        self.proc.start()
        task_r.close()  # child owns these ends; closing ours makes EOF detection work
        res_w.close()
        self.ready = False
        self.busy: _Item | None = None
        self.dead = False

    def close_handles(self) -> None:
        for c in (self.task_w, self.res_r):
            try:
                c.close()
            except OSError:
                pass


class InferencePool:
    def __init__(self, pipeline_factory: Callable[[], Pipeline], workers: int, queue_size: int):
        if workers < 1 or queue_size < 1:
            raise ValueError("workers and queue_size must be >= 1")
        self._factory = pipeline_factory
        self._queue_size = queue_size
        self._ctx = mp.get_context("spawn")
        self._workers = [_Worker(self._ctx, pipeline_factory, i, 0) for i in range(workers)]
        self._pending: deque[_Item] = deque()
        self._in_flight: dict[int, _Item] = {}
        self._seq = 0
        self._out: deque[tuple[str, FrameRecord]] = deque()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._wake: asyncio.Event | None = None
        self._ready_ev: asyncio.Event | None = None
        self._reader: threading.Thread | None = None
        self._stop_reader = threading.Event()
        self._closed = False
        self._finished = False

    # ------------------------------------------------------------------ public API
    async def __aenter__(self) -> InferencePool:
        self._ensure_started()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.close()

    @property
    def ready(self) -> bool:
        """True when every worker has built its pipeline and is serving."""
        return bool(self._workers) and all(w.ready for w in self._workers)

    async def wait_ready(self, timeout: float = 60.0) -> None:
        """Wait until every worker has built its pipeline (e.g. loaded model weights)."""
        self._ensure_started()
        deadline = time.monotonic() + timeout
        while not all(w.ready for w in self._workers):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("inference workers not ready")
            self._ready_ev.clear()
            try:
                await asyncio.wait_for(self._ready_ev.wait(), remaining)
            except TimeoutError:
                pass

    def submit(self, frame: np.ndarray, ref: FrameRef) -> bool:
        """Queue a frame (drop-oldest). Returns False only if the pool is closed."""
        if self._closed:
            return False
        self._ensure_started()
        self._seq += 1
        item = _Item(self._seq, frame, ref)
        if len(self._pending) >= self._queue_size:
            self._evict_for(ref.session_id)
        self._pending.append(item)
        self._dispatch()
        return True

    async def results(self) -> AsyncIterator[tuple[str, FrameRecord]]:
        """Yield ``(session_id, record)`` in completion order. Single consumer.

        Ends after ``close()`` once everything has been delivered.
        """
        self._ensure_started()
        while True:
            while self._out:
                yield self._out.popleft()
            if self._finished:
                return
            self._wake.clear()
            await self._wake.wait()

    async def close(self, timeout: float = 10.0) -> None:
        """Stop accepting frames, drop queued ones, let in-flight finish, stop workers."""
        if self._closed:
            while not self._finished:
                await asyncio.sleep(_POLL_S)
            return
        self._ensure_started()
        self._closed = True
        while self._pending:
            self._emit_dropped(self._pending.popleft())
        for w in self._workers:
            self._send(w, None)
        deadline = time.monotonic() + timeout
        while self._in_flight and time.monotonic() < deadline:
            await asyncio.sleep(0.02)
        procs = [w.proc for w in self._workers]
        await asyncio.to_thread(_join_all, procs, max(0.0, deadline - time.monotonic()) + 1.0)
        self._stop_reader.set()
        await asyncio.to_thread(self._reader.join)
        for w in self._workers:
            if w.busy is not None:
                self._in_flight.pop(w.busy.seq, None)
                self._emit_dropped(w.busy)
                w.busy = None
            w.close_handles()
        for item in list(self._in_flight.values()):
            self._emit_dropped(item)
        self._in_flight.clear()
        self._finished = True
        self._wake.set()

    # ------------------------------------------------------------------ internals (loop thread)
    def _ensure_started(self) -> None:
        if self._loop is not None:
            return
        self._loop = asyncio.get_running_loop()
        self._wake = asyncio.Event()
        self._ready_ev = asyncio.Event()
        self._reader = threading.Thread(target=self._reader_main, name="inference-pool-reader",
                                        daemon=True)
        self._reader.start()

    def _emit(self, session_id: str, rec: FrameRecord) -> None:
        self._out.append((session_id, rec))
        self._wake.set()

    def _emit_dropped(self, item: _Item) -> None:
        self._emit(item.ref.session_id, dropped_record(item.ref))

    def _evict_for(self, session_id: str) -> None:
        victim = next((it for it in self._pending if it.ref.session_id == session_id), None)
        if victim is None:
            victim = self._pending[0]
        self._pending.remove(victim)
        self._emit_dropped(victim)

    def _dispatch(self) -> None:
        for w in self._workers:
            if not self._pending:
                return
            if w.ready and w.busy is None and not w.dead:
                item = self._pending.popleft()
                w.busy = item
                self._in_flight[item.seq] = item
                if not self._send(w, (item.seq, item.frame, item.ref)):
                    self._on_worker_dead(w.idx, w.gen)

    def _send(self, w: _Worker, msg) -> bool:
        if w.dead:
            return False
        try:
            w.task_w.send(msg)
            return True
        except (BrokenPipeError, OSError, EOFError):
            return False

    def _on_message(self, idx: int, gen: int, msg) -> None:
        w = self._workers[idx]
        if w.gen != gen:
            return  # late message from a replaced worker
        if msg == _READY:
            w.ready = True
            self._ready_ev.set()
            self._dispatch()
            return
        seq, rec, err = msg
        item = self._in_flight.pop(seq, None)
        if w.busy is not None and w.busy.seq == seq:
            w.busy = None
        if item is None:
            return  # already emitted (e.g. as dropped)
        if rec is None or rec.frame_id != item.ref.frame_id:
            if err:
                log.warning("frame %s dropped: %s", item.ref.frame_id, err)
            rec = dropped_record(item.ref)
        self._emit(item.ref.session_id, rec)
        self._dispatch()

    def _on_worker_dead(self, idx: int, gen: int) -> None:
        w = self._workers[idx]
        if w.gen != gen or w.dead:
            return
        w.dead = True
        if w.busy is not None:
            log.warning("worker %d died on frame %s", idx, w.busy.ref.frame_id)
            if self._in_flight.pop(w.busy.seq, None) is not None:
                self._emit_dropped(w.busy)
            w.busy = None
        if self._closed:
            return
        log.warning("restarting inference worker %d (exitcode %s)", idx, w.proc.exitcode)
        w.proc.join(timeout=1.0)
        w.close_handles()
        self._workers[idx] = _Worker(self._ctx, self._factory, idx, gen + 1)

    # ------------------------------------------------------------------ reader thread
    def _reader_main(self) -> None:
        reported: set[tuple[int, int]] = set()
        while not self._stop_reader.is_set():
            workers = [w for w in list(self._workers) if (w.idx, w.gen) not in reported]
            objs: dict = {}
            for w in workers:
                objs[w.res_r] = w
                objs[w.proc.sentinel] = w
            if not objs:
                time.sleep(_POLL_S)
                continue
            try:
                ready = wait(list(objs), timeout=_POLL_S)
            except OSError:
                continue  # a handle was closed concurrently; rebuild the list
            # results first, so data written just before exit is not lost
            for obj in sorted(ready, key=lambda o: not isinstance(o, Connection)):
                w = objs[obj]
                if (w.idx, w.gen) in reported:
                    continue
                try:
                    while w.res_r.poll():
                        msg = w.res_r.recv()
                        self._post(self._on_message, w.idx, w.gen, msg)
                except (EOFError, OSError):
                    dead = True
                else:
                    dead = not w.proc.is_alive()
                if not dead:
                    continue
                reported.add((w.idx, w.gen))
                self._post(self._on_worker_dead, w.idx, w.gen)

    def _post(self, fn, *args) -> None:
        try:
            self._loop.call_soon_threadsafe(fn, *args)
        except RuntimeError:
            pass  # loop closed


def _join_all(procs, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    for p in procs:
        p.join(max(0.0, deadline - time.monotonic()))
    for p in procs:
        if p.is_alive():
            p.terminate()
            p.join(1.0)
        if p.is_alive():
            p.kill()
            p.join(1.0)
