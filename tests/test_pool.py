"""InferencePool tests (Task 6). CPU only, fast fake pipelines.

Fakes are top-level so the spawn-context worker processes can unpickle the factories.
Each fake stage encodes the frame's own marker (pixel value) into its detection's
class_name, so a test can verify that a record's detections belong to that frame.
"""

import asyncio
import functools
import os
import time

import numpy as np
import pytest

from app.contracts.log_schema import Detection
from app.pipeline.runner import Pipeline
from app.pipeline.stage import FrameRef, StageResult
from app.workers.pool import InferencePool


# ---------------------------------------------------------------- fakes (picklable)
class MarkerStage:
    """Emits one detection whose class_name is m<marker>, marker = frame pixel value."""

    name = "marker"
    version = "1"
    kind = "detector"

    def __init__(self, delay=0.0, slow_even=0.0, crash_on=None):
        self.delay = delay
        self.slow_even = slow_even
        self.crash_on = crash_on

    def process(self, frame, ref, ctx):
        marker = int(frame.flat[0])
        if self.crash_on is not None and marker == self.crash_on:
            os._exit(13)  # simulate a hard worker crash (CUDA abort, segfault, OOM kill)
        time.sleep(self.delay)
        if self.slow_even and marker % 2 == 0:
            time.sleep(self.slow_even)
        d = Detection(bbox=(0.1, 0.1, 0.2, 0.2), class_name=f"m{marker}", confidence=0.9)
        return StageResult(frame_id=ref.frame_id, stage=self.name, detections=[d])


class RaisingPipeline(Pipeline):
    """Pipeline whose run() itself raises on a given marker (not caught by the runner)."""

    def __init__(self, stages, raise_on):
        super().__init__(stages)
        self.raise_on = raise_on

    def run(self, frame, ref):
        if int(frame.flat[0]) == self.raise_on:
            raise RuntimeError("pipeline boom")
        return super().run(frame, ref)


def make_pipeline(delay=0.0, slow_even=0.0, crash_on=None, raise_on=None):
    stage = MarkerStage(delay=delay, slow_even=slow_even, crash_on=crash_on)
    if raise_on is not None:
        return RaisingPipeline([stage], raise_on)
    return Pipeline([stage])


def frame(marker):
    return np.full((4, 4), marker, dtype=np.int32)


def ref(fid, session="s"):
    return FrameRef(session_id=session, frame_id=fid, pts=fid / 30.0)


async def collect(pool, n, timeout=20.0):
    out = []

    async def _go():
        async for item in pool.results():
            out.append(item)
            if len(out) >= n:
                return

    await asyncio.wait_for(_go(), timeout)
    return out


def assert_own_detections(rec, marker):
    """A non-dropped record must carry exactly its own frame's detections."""
    assert not rec.dropped
    assert [d.class_name for d in rec.detections] == [f"m{marker}"]


# ---------------------------------------------------------------- tests
async def test_overload_drops_oldest_not_mixes():
    factory = functools.partial(make_pipeline, delay=0.2)
    async with InferencePool(factory, workers=1, queue_size=2) as pool:
        await pool.wait_ready()
        ids = list(range(20))
        for fid in ids:
            assert pool.submit(frame(fid), ref(fid)) is True
        got = await collect(pool, len(ids))

    records = [r for _, r in got]
    # every submitted frame yields exactly one record, and only submitted frames appear
    assert sorted(r.frame_id for r in records) == ids
    by_id = {r.frame_id: r for r in records}
    # frame 0 started immediately; drop-oldest keeps the newest queue_size frames
    survivors = {fid for fid, r in by_id.items() if not r.dropped}
    assert survivors == {0, 18, 19}
    for fid, r in by_id.items():
        assert r.pts == pytest.approx(fid / 30.0)
        if r.dropped:
            assert r.detections == [] and r.classification == {} and r.anatomy is None
        else:
            assert_own_detections(r, fid)


async def test_results_keyed_by_frame_id_out_of_order():
    factory = functools.partial(make_pipeline, slow_even=0.4)
    async with InferencePool(factory, workers=2, queue_size=10) as pool:
        await pool.wait_ready()
        ids = [0, 1, 2, 3]
        for fid in ids:
            assert pool.submit(frame(fid), ref(fid))
        got = await collect(pool, len(ids))

    arrival = [r.frame_id for _, r in got]
    assert sorted(arrival) == ids
    assert arrival != ids  # fast odd frames overtake slow even ones
    assert arrival.index(1) < arrival.index(0)
    for sid, r in got:
        assert sid == "s"
        assert_own_detections(r, r.frame_id)


async def test_worker_crash_does_not_stop_pool():
    factory = functools.partial(make_pipeline, crash_on=3, raise_on=6)
    async with InferencePool(factory, workers=1, queue_size=20) as pool:
        await pool.wait_ready()
        ids = list(range(9))
        for fid in ids:
            assert pool.submit(frame(fid), ref(fid))
        got = await collect(pool, len(ids))
        # the pool is still usable after the crash
        assert pool.submit(frame(42), ref(42))
        (after,) = await collect(pool, 1)

    by_id = {r.frame_id: r for _, r in got}
    assert sorted(by_id) == ids
    assert {fid for fid, r in by_id.items() if r.dropped} == {3, 6}
    for fid, r in by_id.items():
        if not r.dropped:
            assert_own_detections(r, fid)
    assert_own_detections(after[1], 42)


async def test_session_scoped_eviction():
    factory = functools.partial(make_pipeline, delay=0.3)
    async with InferencePool(factory, workers=1, queue_size=3) as pool:
        await pool.wait_ready()
        # markers are unique; frame ids deliberately collide across sessions
        subs = [("A", 0, 10), ("A", 1, 11), ("B", 1, 21), ("A", 2, 12),  # queue full: A1 B1 A2
                ("A", 3, 13),  # evicts A's oldest (A1)       -> B1 A2 A3
                ("B", 2, 22),  # evicts B's oldest (B1)       -> A2 A3 B2
                ("C", 1, 31)]  # C has none: global oldest A2 -> A3 B2 C1
        for sess, fid, marker in subs:
            assert pool.submit(frame(marker), ref(fid, sess))
        got = await collect(pool, len(subs))

    keyed = {(sid, r.frame_id): r for sid, r in got}
    assert len(keyed) == len(subs)
    assert {k for k, r in keyed.items() if r.dropped} == {("A", 1), ("B", 1), ("A", 2)}
    for sess, fid, marker in subs:
        r = keyed[(sess, fid)]
        if not r.dropped:
            assert_own_detections(r, marker)


async def test_submit_after_close_returns_false():
    pool = InferencePool(functools.partial(make_pipeline), workers=1, queue_size=2)
    await pool.wait_ready()
    assert pool.submit(frame(1), ref(1))
    (item,) = await collect(pool, 1)
    assert_own_detections(item[1], 1)
    await pool.close()
    assert pool.submit(frame(2), ref(2)) is False
    # results() terminates after close
    rest = [x async for x in pool.results()]
    assert rest == []


# ---------------------------------------------------------------- I5: restart backoff / budget
def failing_factory():
    raise RuntimeError("weights not found: /nope.pt")


def flaky_factory(counter_dir, fails):
    """Fails the first ``fails`` builds (counted with files, one worker), then works."""
    from pathlib import Path

    d = Path(counter_dir)
    n = len(list(d.iterdir()))
    (d / f"attempt{n}").touch()
    if n < fails:
        raise RuntimeError(f"flaky build {n}")
    return make_pipeline()


def test_restart_delay_schedule_is_deterministic_exponential_capped():
    from app.workers.pool import restart_delay

    assert [restart_delay(n, 0.5, 30.0) for n in range(0, 10)] == [
        0.0, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0, 30.0]


async def _until(cond, timeout=30.0):
    deadline = time.monotonic() + timeout
    while not cond():
        assert time.monotonic() < deadline, "condition not reached"
        await asyncio.sleep(0.02)


async def test_failing_factory_gives_up_after_budget_and_drops_frames_promptly(caplog):
    caplog.set_level("WARNING", logger="app.workers.pool")
    pool = InferencePool(failing_factory, workers=2, queue_size=4,
                         restart_backoff=0.01, restart_max_backoff=0.05, max_start_failures=3)
    try:
        # frames submitted while the workers are still (re)starting wait in the queue
        assert pool.submit(frame(1), ref(1))
        assert pool.submit(frame(2), ref(2))
        await _until(lambda: pool.failed_workers == [0, 1])
        assert not pool.healthy and not pool.ready
        assert "all 2 inference workers failed" in pool.status_reason
        with pytest.raises(RuntimeError):
            await pool.wait_ready(timeout=1)
        # no more spawns: exactly 3 attempts per worker
        spawns = [r for r in caplog.records if "failed to start" in r.getMessage()]
        assert sum("giving up" in r.getMessage() for r in spawns) == 2
        assert sum("restarting in" in r.getMessage() for r in spawns) == 2 * 2
        t0 = time.monotonic()
        for i in range(3, 6):
            assert pool.submit(frame(i), ref(i))
        recs = await collect(pool, 5, timeout=2.0)
        assert time.monotonic() - t0 < 1.0
        assert sorted(r.frame_id for _, r in recs) == [1, 2, 3, 4, 5]  # exactly one each
        assert all(r.dropped for _, r in recs)
    finally:
        await pool.close()


async def test_worker_that_fails_twice_then_starts_is_kept(tmp_path):
    pool = InferencePool(functools.partial(flaky_factory, str(tmp_path), 2), workers=1,
                         queue_size=4, restart_backoff=0.01, restart_max_backoff=0.05,
                         max_start_failures=3)
    await pool.__aenter__()
    try:
        await _until(lambda: pool.ready)
        assert pool.failed_workers == [] and pool.healthy and pool.status_reason is None
        assert len(list(tmp_path.iterdir())) == 3
        pool.submit(frame(7), ref(7))
        (item,) = await collect(pool, 1)
        assert_own_detections(item[1], 7)
    finally:
        await pool.close()
