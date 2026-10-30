"""FastAPI app assembly: lifespan owns the pool, the ingest and the results router task."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api import results_ws, sessions
from app.api.config import Settings
from app.pipeline.runner import Pipeline
from app.workers.pool import InferencePool

log = logging.getLogger(__name__)


def create_app(settings: Settings, pipeline_factory: Callable[[], Pipeline]) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        models = pipeline_factory().model_versions()  # parent-side probe for log headers
        pool = InferencePool(pipeline_factory, settings.workers, settings.queue_size)
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
    from app.api.config import build_app

    return build_app(Settings())
