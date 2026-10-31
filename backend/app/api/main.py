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


INSECURE_TOKEN_WARNING = (
    "AIIRIS_REQUIRE_TOKEN is on but TLS is not configured (AIIRIS_TLS=false): stand tokens "
    "(X-Stand-Token, ?token= of the results WebSocket) travel in CLEAR TEXT. Mount tls.crt/"
    "tls.key for nginx (deploy/certs; plain HTTP then redirects to HTTPS) and set AIIRIS_TLS=true")


def create_app(settings: Settings, pipeline_factory: Callable[[], Pipeline]) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if settings.require_token and not settings.tls:
            log.warning(INSECURE_TOKEN_WARNING)
        models = pipeline_factory().model_versions()  # parent-side probe for log headers
        side = settings.max_side
        worker_factory = functools.partial(warmed_pipeline, pipeline_factory,
                                           settings.warmup_frames, (side * 9 // 16, side))
        pool = InferencePool(worker_factory, settings.workers, settings.queue_size,
                             restart_backoff=settings.worker_restart_backoff,
                             restart_max_backoff=settings.worker_restart_max_backoff,
                             max_start_failures=settings.worker_max_start_failures)
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

    if settings.require_token:
        warned = False

        @app.middleware("http")
        async def _plain_http_token_check(request, call_next):
            # a token-carrying request that reached nginx over plain HTTP: misconfiguration
            nonlocal warned
            if (not warned and request.headers.get("x-forwarded-proto") == "http"
                    and request.headers.get("x-stand-token")):
                warned = True
                log.warning("a stand token arrived over plain HTTP (X-Forwarded-Proto: http); "
                            "%s", INSECURE_TOKEN_WARNING)
            return await call_next(request)

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
