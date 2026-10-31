"""FastAPI app assembly: lifespan owns the pool, the ingest and the results router task."""

from __future__ import annotations

import asyncio
import functools
import logging
from collections.abc import Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api import results_ws, sessions
from app.api.config import Settings
from app.pipeline.runner import Pipeline
from app.workers.pool import InferencePool

log = logging.getLogger(__name__)


def warmed_pipeline(factory: Callable[[], Pipeline], frames: int, size: tuple[int, int]
                    ) -> Pipeline:
    """Build the pipeline and run ``frames`` dummy frames through it (inside the worker,
    before it reports ready): CUDA context, cuDNN autotuning and lazy model setup happen here
    instead of on the first real frames (measured: without it the first ~35 frames of the
    first session after start were dropped on an RTX 2070). Failures are logged, not raised."""
    import numpy as np

    from app.pipeline.stage import FrameRef

    pipeline = factory()
    h, w = size
    for i in range(frames):
        try:
            pipeline.run(np.zeros((h, w, 3), np.uint8), FrameRef("warmup", i, 0.0))
        except Exception:
            log.exception("pipeline warm-up frame failed")
            break
    return pipeline


def create_app(settings: Settings, pipeline_factory: Callable[[], Pipeline]) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        models = pipeline_factory().model_versions()  # parent-side probe for log headers
        side = settings.max_side
        worker_factory = functools.partial(warmed_pipeline, pipeline_factory,
                                           settings.warmup_frames, (side * 9 // 16, side))
        pool = InferencePool(worker_factory, settings.workers, settings.queue_size)
        core = sessions.Core(settings, pool, models)
        app.state.core = core
        await pool.__aenter__()
        core.start()
        try:
            yield
        finally:
            await core.shutdown()

    app = FastAPI(title="aiirisdx-client", lifespan=lifespan)
    app.state.settings = settings
    app.include_router(sessions.router)
    app.include_router(results_ws.router)
    return app


def app_from_env() -> FastAPI:
    """uvicorn entry: ``uvicorn app.api.main:app_from_env --factory``."""
    from pydantic import ValidationError

    from app.api.config import build_app

    try:
        settings = Settings()
    except ValidationError as e:
        # only the messages: the default text echoes every input value (secrets, tokens)
        msgs = "; ".join(f"{'.'.join(map(str, x['loc'])) or 'settings'}: {x['msg']}"
                         for x in e.errors())
        raise SystemExit(f"invalid AIIRIS_* configuration: {msgs}") from None
    return build_app(settings)
