"""``WS /sessions/{id}/results``: one JSON message per frame record.

Message = ``FrameRecord.model_dump(mode="json")``: ``{type, frame_id, pts, detections,
classification, anatomy, dropped}``. Messages arrive in completion order and each keeps its own
frame_id (never relabelled). A slow client loses its oldest unsent messages (bounded buffer,
``Settings.ws_queue_size``); other clients and the log are unaffected. The socket is closed
with code 1000 when the session is stopped. Auth: ``X-Stand-Token`` header or ``?token=``.
Rejections: the socket is ACCEPTED and then closed with 4404 (unknown/stopped session) or 4401
(bad token). Closing before accept would reach the browser as an HTTP 403 handshake failure
(close code 1006), so the stand page could not tell it from a network error and would keep
reconnecting forever.
"""

from __future__ import annotations

import asyncio
import contextlib

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.api import access
from app.api.sessions import Subscriber

router = APIRouter()


@router.websocket("/sessions/{session_id}/results")
async def results(ws: WebSocket, session_id: str):
    core = ws.app.state.core
    s = core.sessions.get(session_id)
    if s is None or s.closed:
        await ws.accept()
        await ws.close(code=4404, reason="unknown or stopped session")
        return
    token = ws.headers.get(access.HEADER) or ws.query_params.get("token")
    if not access.token_ok(core.settings, s.stand, token):
        await ws.accept()
        await ws.close(code=4401, reason="bad stand token")
        return
    await ws.accept()
    sub = Subscriber(core.settings.ws_queue_size)
    s.subscribers.add(sub)

    async def watch_disconnect() -> None:
        try:
            while True:
                await ws.receive_text()
        except (WebSocketDisconnect, RuntimeError):
            sub.offer(None)

    watcher = asyncio.create_task(watch_disconnect())
    try:
        while (msg := await sub.get()) is not None:
            await ws.send_json(msg)
        with contextlib.suppress(RuntimeError):
            await ws.close(code=1000)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        s.subscribers.discard(sub)
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)
