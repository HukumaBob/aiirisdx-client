"""Settings (env prefix ``AIIRIS_``) and the application factory ``build_app``.

Complex values are JSON in the environment, e.g.
``AIIRIS_STAND_TOKENS='{"stand-1": "s3cret"}'``, ``AIIRIS_ICE_SERVERS='[{"urls": "stun:..."}]'``,
``AIIRIS_PIPELINE='[{"name": "crop"}, {"name": "yolo_detect", "params": {"weights": "w.pt"}}]'``,
``AIIRIS_TURN_URLS='["turn:turn.example:3478?transport=udp"]'`` + ``AIIRIS_TURN_SECRET``.

Default pipeline (``AIIRIS_PIPELINE`` unset): ``crop``, ``yolo_detect`` (only if
``AIIRIS_DETECT_WEIGHTS`` is set; otherwise skipped, no model is loaded), ``yolo_classify``
(heads from ``AIIRIS_CLASSIFY_WEIGHTS`` JSON ``{"zone": "path.pt"}``; none => no-op stub),
``anatomy``.

``build_app(settings, pool_factory=None)``: ``pool_factory`` is the *pipeline* factory
(``() -> Pipeline``, picklable: a top-level function or ``functools.partial``). The pool
workers call it in their own processes; the parent calls it once at startup only to read
``model_versions()`` for the log header. Tests inject a fast fake pipeline here. The default
builds the pipeline from ``settings.pipeline_config()`` via ``make_pipeline``.
"""

from __future__ import annotations

import functools
from collections.abc import Callable
from pathlib import Path

from fastapi import FastAPI
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.pipeline.runner import Pipeline, StageConfig


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AIIRIS_", extra="ignore")

    require_token: bool = False
    stand_tokens: dict[str, str] = Field(default_factory=dict)  # stand -> token
    sessions_dir: Path = Path("./sessions")
    file_root: Path | None = None  # allowed base dir for video-file mode; None = disabled
    taxonomy_version: str = "unversioned"

    pipeline: list[dict] | None = None  # [{"name":..., "params": {...}}]
    detect_weights: Path | None = None
    classify_weights: dict[str, str] | None = None
    workers: int = Field(default=1, ge=1)
    queue_size: int = Field(default=8, ge=1)

    ice_servers: list[dict] = Field(default_factory=list)  # static, used by server and clients
    # TURN (coturn ``use-auth-secret``): time-limited credentials are derived per request from
    # the shared secret (TURN REST API scheme) for both the server's peer and the browsers.
    turn_urls: list[str] = Field(default_factory=list)  # e.g. ["turn:turn.example:3478"]
    turn_secret: str | None = None
    turn_ttl: int = Field(default=86400, ge=60)  # seconds a credential is valid
    video_codecs: list[str] | None = None
    max_side: int = 960

    ws_queue_size: int = Field(default=64, ge=1)  # per-subscriber results buffer
    drain_timeout: float = 3.0  # seconds /stop waits for in-flight results

    def ice_servers_now(self, user: str = "aiiris") -> list[dict]:
        """Static ``ice_servers`` plus TURN with fresh credentials (if configured)."""
        out = [dict(x) for x in self.ice_servers]
        if self.turn_urls and self.turn_secret:
            username, credential = turn_credentials(self.turn_secret, self.turn_ttl, user)
            out.append({"urls": list(self.turn_urls), "username": username,
                        "credential": credential})
        return out

    def pipeline_config(self) -> list[dict]:
        if self.pipeline is not None:
            return self.pipeline
        cfg: list[dict] = [{"name": "crop"}]
        if self.detect_weights is not None:
            cfg.append({"name": "yolo_detect", "params": {"weights": str(self.detect_weights)}})
        cfg.append({"name": "yolo_classify", "params": {"weights": self.classify_weights}})
        cfg.append({"name": "anatomy"})
        return cfg


def turn_credentials(secret: str, ttl: int, user: str, now: float | None = None
                     ) -> tuple[str, str]:
    """TURN REST API credentials (coturn ``use-auth-secret``/``static-auth-secret``):
    username ``"<expiry unix time>:<user>"``, password ``base64(HMAC-SHA1(secret, username))``."""
    import base64
    import hashlib
    import hmac
    import time

    username = f"{int((time.time() if now is None else now) + ttl)}:{user}"
    digest = hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()
    return username, base64.b64encode(digest).decode()


def make_pipeline(config: list[dict]) -> Pipeline:
    """Pipeline from stage config dicts. Top-level so ``partial(make_pipeline, cfg)`` pickles."""
    import app.pipeline.stages  # noqa: F401  (registers the built-in stages)
    from app.pipeline.runner import build_pipeline

    return build_pipeline([StageConfig(c["name"], c.get("params") or {}) for c in config])


def build_app(settings: Settings, pool_factory: Callable[[], Pipeline] | None = None) -> FastAPI:
    from app.api.main import create_app

    factory = pool_factory or functools.partial(make_pipeline, settings.pipeline_config())
    return create_app(settings, factory)
