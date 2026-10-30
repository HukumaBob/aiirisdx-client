"""Event-loop lag under load (Task 7 R8 follow-up): 4 synthetic 1080p@30fps streams go
through the real ingest path (FrameSink.push -> on_frame -> InferencePool.submit) with a
trivial pipeline and the logging consumer; a periodic sleep probe measures loop stalls."""

from __future__ import annotations

import asyncio
import time

import numpy as np

from app.api.config import Settings
from app.api.sessions import Core
from app.ingest._common import FrameSink
from app.pipeline.runner import Pipeline
from app.workers.pool import InferencePool
from test_api import FastStage

STREAMS, FPS, SECONDS, PROBE_S = 4, 30, 6, 0.005
MAX_STALL_S = 0.100


def trivial() -> Pipeline:
    return Pipeline([FastStage()])


async def test_event_loop_lag_with_four_1080p_streams(tmp_path):
    frames = [np.full((1080, 1920, 3), 10 * i, np.uint8) for i in range(4)]
    settings = Settings(sessions_dir=tmp_path, workers=2, queue_size=8)
    async with InferencePool(trivial, workers=2, queue_size=8) as pool:
        await pool.wait_ready()
        core = Core(settings, pool, {"fast": "t1"})  # real router + log writing + fan-out
        core.start()
        sess = [core.create("lag", None, None) for _ in range(STREAMS)]
        sink = FrameSink(core.on_frame)  # same sink the ingests use
        stalls: list[float] = []
        stop = asyncio.Event()

        async def probe():
            last = time.perf_counter()
            while not stop.is_set():
                await asyncio.sleep(PROBE_S)
                now = time.perf_counter()
                stalls.append(now - last - PROBE_S)
                last = now

        async def stream(k: int):
            t0 = time.perf_counter()
            for i in range(FPS * SECONDS):
                await asyncio.sleep(max(0.0, t0 + i / FPS - time.perf_counter()))
                await sink.push(frames[(i + k) % 4].copy(), sess[k].key, i, i / FPS)

        p = asyncio.create_task(probe())
        await asyncio.gather(*(stream(k) for k in range(STREAMS)))
        stop.set()
        await p
        got = [await core.stop(s) for s in sess]
        await core.shutdown()
    stalls.sort()
    total = STREAMS * FPS * SECONDS
    print(f"\nloop lag: samples={len(stalls)} max={stalls[-1]*1000:.1f}ms "
          f"p99={stalls[int(len(stalls)*0.99)]*1000:.1f}ms p50={stalls[len(stalls)//2]*1000:.1f}ms "
          f"logged={sum(got)}/{total}")
    assert sum(got) == total
    assert stalls[-1] < MAX_STALL_S
