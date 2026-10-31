"""WebRTC ingest (aiortc): receive the stand's video, read the frame-id marker, deliver frames.

Flow per session: ``handle_offer(sdp, session)`` creates an ``RTCPeerConnection``, returns
the SDP answer, and consumes the incoming video track. For every received frame (in an
executor thread, never on the event loop): ``to_ndarray("bgr24")`` -> ``read_frame_id`` ->
``strip_marker`` -> downscale to ``max_side`` (960, ``cv2.INTER_AREA``, crop scaled by the
same factor; see ``app.ingest._common``). The result is passed to the caller-provided
``on_frame(frame, ref)`` (sync or async) -- the ingest does not know about the pool; Task 8
connects ``on_frame`` to ``InferencePool.submit``.

Frame-id rules (docs/superpowers/specs/frame-id-experiment.md):

* A frame id is accepted only if it is **strictly greater** than the last accepted id of
  that session. Below ~500 kbit/s the encoder skips the top macroblocks and the decoder
  shows the *previous* frame's marker (a stale but CRC-valid id); monotonic acceptance
  removes that whole failure class.
* A frame whose marker is unreadable (``None``) or not increasing is **skipped** -- never
  given a guessed or made-up id -- and counted in ``skipped_frames`` (total) and
  ``session_stats(session_id)``. ``received_frames == delivered_frames + skipped_frames``.
* The marker rows (0..15) are removed with ``strip_marker`` before delivery.

``FrameRef.pts``: seconds = ``frame.pts * frame.time_base`` of the received frame minus
that of the first frame received in the session (RTP timestamp clock, 90 kHz for video).
It is a receive-side media time, not the sender's capture time; the frame id is the
authoritative key (RF3), pts is informational.

``FrameRef.session_id`` is ``session_key(session)`` = the session UUID.

Sender requirement (for Task 9, browser side -- the server cannot set it): the video
sender must use ``RTCRtpSender.setParameters({..., degradationPreference:
"maintain-resolution"})``. Otherwise WebRTC lowers the resolution when bandwidth drops,
the 16x16 block grid of the marker no longer lines up and every frame reads as ``None``
(skipped, not misattributed -- but the stream would lose all ids).

Codec: ``video_codecs`` (e.g. ``["video/H264"]``) restricts the answer to those codecs if
the offer contains them (the marker experiment modelled H.264); ``None`` keeps aiortc's
default negotiation. ICE servers (STUN/TURN) come from settings via ``ice_servers``; the
default is none (host candidates only, e.g. inside the hospital LAN). ``ice_servers`` may be
a callable, evaluated for every offer (fresh time-limited TURN credentials).

Lifecycle: if the peer connection ends on its own (``failed`` / ``closed``, e.g. the
browser tab was closed or the network dropped), the session is cleaned up and the optional
``on_closed(session_id)`` callback is called once. It is not called for a deliberate
``close_session`` / ``close``.

Backpressure: frames are processed sequentially per session; aiortc's receive queue is
unbounded, so processing must keep up with the frame rate (to_ndarray + resize of 1080p
is a few ms). Overload is shed by the pool (drop-oldest), not here.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field

from aiortc import (RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCRtpSender,
                    RTCSessionDescription)
from aiortc.mediastreams import MediaStreamError, MediaStreamTrack

from app.contracts.frame_id import read_frame_id, strip_marker
from app.contracts.log_schema import CropRect, SessionId
from app.ingest._common import MAX_SIDE, FrameSink, IngestError, OnFrame, session_key

log = logging.getLogger(__name__)

__all__ = ["WebRtcIngest", "IngestError", "SessionStats"]

IceServerSpec = RTCIceServer | dict | str
_ENDED_STATS_MAX = 256


@dataclass
class SessionStats:
    received: int = 0
    delivered: int = 0
    skipped_unreadable: int = 0
    skipped_stale: int = 0
    last_id: int | None = None

    @property
    def skipped(self) -> int:
        return self.skipped_unreadable + self.skipped_stale


@dataclass
class _Session:
    session_id: str
    pc: RTCPeerConnection
    crop: CropRect | None
    stats: SessionStats = field(default_factory=SessionStats)
    tasks: list[asyncio.Task] = field(default_factory=list)
    first_time: float | None = None


def _ice_server(spec: IceServerSpec) -> RTCIceServer:
    if isinstance(spec, RTCIceServer):
        return spec
    if isinstance(spec, str):
        return RTCIceServer(urls=spec)
    return RTCIceServer(**spec)


class WebRtcIngest:
    def __init__(self, on_frame: OnFrame,
                 ice_servers: Iterable[IceServerSpec] | Callable[[], Iterable[IceServerSpec]] = (),
                 video_codecs: Iterable[str] | None = None, max_side: int = MAX_SIDE,
                 on_closed: Callable[[str], None] | None = None):
        self.on_closed = on_closed
        self.sink = FrameSink(on_frame, max_side)
        # a callable is evaluated per offer (e.g. fresh time-limited TURN credentials)
        self._ice_fn = ice_servers if callable(ice_servers) else None
        self.ice_servers = [] if self._ice_fn else [_ice_server(s) for s in ice_servers]
        self.video_codecs = [c.lower() for c in video_codecs] if video_codecs else None
        self._sessions: dict[str, _Session] = {}
        # stats of ended connections stay readable (bounded) for diagnostics after /stop
        self._ended_stats: dict[str, SessionStats] = {}
        self.received_frames = 0
        self.delivered_frames = 0
        self.skipped_frames = 0

    # ------------------------------------------------------------------ public API
    async def handle_offer(self, sdp: str, session: SessionId | str,
                           crop: CropRect | None = None) -> str:
        """Accept a browser offer; return the SDP answer. One connection per session."""
        sid = session_key(session)
        if sid in self._sessions:
            await self.close_session(sid)
        ice = [_ice_server(x) for x in self._ice_fn()] if self._ice_fn else self.ice_servers
        pc = RTCPeerConnection(RTCConfiguration(iceServers=ice))
        sess = _Session(sid, pc, crop)
        self._sessions[sid] = sess

        @pc.on("track")
        def on_track(track: MediaStreamTrack) -> None:
            if track.kind != "video":
                return
            sess.tasks.append(asyncio.ensure_future(self._consume(sess, track)))

        @pc.on("connectionstatechange")
        async def on_state() -> None:
            if pc.connectionState in ("failed", "closed"):
                log.info("session %s: connection %s", sid, pc.connectionState)
                if self._sessions.get(sid) is sess:  # not a deliberate close_session()
                    await self.close_session(sid)
                    if self.on_closed is not None:
                        try:
                            self.on_closed(sid)
                        except Exception:
                            log.exception("session %s: on_closed failed", sid)

        try:
            self._apply_codec_preferences(pc, sdp)
            await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="offer"))
            await pc.setLocalDescription(await pc.createAnswer())
        except Exception as e:
            await self.close_session(sid)
            raise IngestError(f"cannot accept WebRTC offer for session {sid}: {e}") from e
        return pc.localDescription.sdp

    async def close_session(self, session_id: str) -> None:
        sess = self._sessions.pop(session_id, None)
        if sess is None:
            return
        self._ended_stats[session_id] = sess.stats
        while len(self._ended_stats) > _ENDED_STATS_MAX:
            self._ended_stats.pop(next(iter(self._ended_stats)))
        await sess.pc.close()
        for t in sess.tasks:
            t.cancel()
        await asyncio.gather(*sess.tasks, return_exceptions=True)

    async def close(self) -> None:
        for sid in list(self._sessions):
            await self.close_session(sid)

    def session_stats(self, session_id: str) -> SessionStats | None:
        """Counters of the session's live connection; None if it has none."""
        sess = self._sessions.get(session_id)
        return sess.stats if sess else None

    def last_stats(self, session_id: str) -> SessionStats | None:
        """Counters of the live connection, else of the last ended one (diagnostics after
        /stop; the most recent ``_ENDED_STATS_MAX`` ended connections are kept)."""
        return self.session_stats(session_id) or self._ended_stats.get(session_id)

    # ------------------------------------------------------------------ internals
    def _apply_codec_preferences(self, pc: RTCPeerConnection, offer_sdp: str) -> None:
        """Restrict the answer to ``video_codecs`` if the offer has any of them.

        aiortc filters codecs inside ``setRemoteDescription``, so the preference must sit on
        a (recvonly) video transceiver created *before* it; that transceiver is then matched
        to the offer's video m-line.
        """
        if not self.video_codecs:
            return
        offered = {line.split()[1].split("/")[0].lower()
                   for line in offer_sdp.splitlines() if line.startswith("a=rtpmap:")}
        caps = RTCRtpSender.getCapabilities("video").codecs
        prefs = [c for c in caps if c.mimeType.lower() in self.video_codecs
                 and c.mimeType.split("/")[1].lower() in offered]
        if not prefs:
            log.warning("offer has none of %s; using default codec negotiation",
                        self.video_codecs)
            return
        prefs += [c for c in caps if c.mimeType.lower() == "video/rtx"]
        pc.addTransceiver("video", direction="recvonly").setCodecPreferences(prefs)

    def _decode(self, vf, crop: CropRect | None):
        """Blocking per-frame work (executor): ndarray, marker, strip, downscale."""
        img = vf.to_ndarray(format="bgr24")
        fid = read_frame_id(img)
        if fid is None:
            return None, None, None
        small, scaled = self.sink.prepare(strip_marker(img), crop)
        return fid, small, scaled

    async def _consume(self, sess: _Session, track: MediaStreamTrack) -> None:
        loop = asyncio.get_running_loop()
        st = sess.stats
        while True:
            try:
                vf = await track.recv()
            except MediaStreamError:
                log.info("session %s: video track ended", sess.session_id)
                return
            st.received += 1
            self.received_frames += 1
            t = float(vf.pts * vf.time_base) if vf.pts is not None and vf.time_base else None
            if t is not None and sess.first_time is None:
                sess.first_time = t
            fid, frame, crop = await loop.run_in_executor(None, self._decode, vf, sess.crop)
            if fid is None:
                st.skipped_unreadable += 1
                self.skipped_frames += 1
                continue
            if st.last_id is not None and fid <= st.last_id:
                st.skipped_stale += 1
                self.skipped_frames += 1
                continue
            st.last_id = fid
            pts = max(0.0, t - sess.first_time) if t is not None else 0.0
            try:
                await self.sink.push(frame, sess.session_id, fid, pts, crop, prepared=True)
            except Exception:  # a consumer bug must not stop the stream
                log.exception("session %s: on_frame failed for frame %d", sess.session_id, fid)
            st.delivered += 1
            self.delivered_frames += 1
