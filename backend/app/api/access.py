"""Stand-token access control (spec §3): the only auth is an optional per-stand token.

With ``require_token`` false nothing is checked. With it true, the ``X-Stand-Token`` header
(for WebSocket also the ``token`` query parameter, because browsers cannot set headers on a
WebSocket) must equal the token configured for the stand the session belongs to; a missing,
wrong, or unconfigured token yields 401. Comparison is constant-time.
"""

from __future__ import annotations

import hmac

from fastapi import HTTPException

from app.api.config import Settings

HEADER = "X-Stand-Token"


def token_ok(settings: Settings, stand: str, provided: str | None) -> bool:
    if not settings.require_token:
        return True
    expected = settings.stand_tokens.get(stand)
    if not expected or not provided:
        # still burn a comparison so timing does not reveal whether the stand exists
        hmac.compare_digest(b"x", b"y")
        return False
    return hmac.compare_digest(provided.encode(), expected.encode())


def check_http(settings: Settings, stand: str, provided: str | None) -> None:
    if not token_ok(settings, stand, provided):
        raise HTTPException(status_code=401, detail="missing or invalid stand token")
