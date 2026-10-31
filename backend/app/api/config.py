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
from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.pipeline.runner import Pipeline, StageConfig


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AIIRIS_", extra="ignore")

    require_token: bool = False
    # TLS is terminated in front of the backend (nginx with certs mounted). Only informs the
    # startup check: require_token without TLS sends the stand tokens in clear text
    tls: bool = False
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
    # seconds a credential is valid; must exceed the longest session (coturn rejects the
    # allocation refresh after expiry), a reconnect fetches fresh credentials
    turn_ttl: int = Field(default=7200, ge=60)
    video_codecs: list[str] | None = None
    max_side: int = 960
    warmup_frames: int = Field(default=3, ge=0)  # dummy frames per worker before "ready"
    # a worker that dies before ready is restarted after 0.5, 1, 2 ... (cap 30) s and given up
    # after this many consecutive failed starts (pool.py, restart policy)
    worker_restart_backoff: float = Field(default=0.5, gt=0)
    worker_restart_max_backoff: float = Field(default=30.0, gt=0)
    worker_max_start_failures: int = Field(default=5, ge=1)

    ws_queue_size: int = Field(default=64, ge=1)  # per-subscriber results buffer
    drain_timeout: float = 3.0  # seconds /stop waits for in-flight results
    # a session with no frames received and no API call for this long (s) is abandoned: its
    # log is closed with complete=false, ingest released, and it is pruned from the registry
    # (its log stays readable via GET /sessions/{id}/log from disk). 0 disables
    session_idle_timeout: float = Field(default=1800.0, ge=0)

    @model_validator(mode="after")
    def _refuse_unsafe_secrets(self) -> "Settings":
        """Refuse to start with TURN but no real shared secret, or with stand tokens required
        but none (or placeholder ones) configured."""
        if self.turn_urls and _placeholder(self.turn_secret):
            raise ValueError("AIIRIS_TURN_URLS is set but AIIRIS_TURN_SECRET is empty or a "
                             "placeholder; generate one with `openssl rand -hex 32` (and use "
                             "the same value as coturn's TURN_SECRET)")
        if self.require_token:
            if not self.stand_tokens:
                raise ValueError("AIIRIS_REQUIRE_TOKEN is on but AIIRIS_STAND_TOKENS is empty")
            bad = sorted(k for k, v in self.stand_tokens.items() if _placeholder(v))
            if bad:
                raise ValueError(f"AIIRIS_STAND_TOKENS has empty/placeholder tokens for {bad}")
        return self

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


PLACEHOLDER_SECRETS = {"change-me", "changeme", "change_me"}


def _placeholder(value: str | None) -> bool:
    return value is None or not value.strip() or value.strip().lower() in PLACEHOLDER_SECRETS


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
