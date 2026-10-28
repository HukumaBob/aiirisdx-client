"""Frame-id marker stamped into the top pixel rows; survives H.264 (WebRTC) re-encoding.

Layout (see docs/superpowers/specs/frame-id-experiment.md and tests/fixtures/README.md):

* codeword = 32-bit frame_id (MSB first) followed by CRC8 (MSB first) = 40 bits;
  CRC8: poly 0x07, init 0x00, xorout 0x55 (CRC-8/I-432-1), over the id as 4 big-endian bytes.
* each bit is a solid 16x16 block in rows 0..15: bit 1 = white (255,255,255), bit 0 = black.
  Block i of copy c starts at x = (c * 40 + i) * 16, y = 0. Blocks are aligned to the
  16x16 H.264 macroblock grid and to the 8x8 chroma grid of 4:2:0.
* the codeword is repeated COPIES = min(3, width // 640) times left to right
  (1920 px wide -> 3 copies = exactly the full row).
* reading: luma of the inner 8x8 of each block (inset 4 px) is averaged; per bit the
  deviations (mean - 128) of all copies are summed (soft majority vote); bit = sum > 0.
  If any bit's average |deviation| < MIN_MARGIN or the CRC mismatches -> None.
"""

from __future__ import annotations

import numpy as np

BLOCK = 16
ID_BITS = 32
CRC_BITS = 8
CODE_BITS = ID_BITS + CRC_BITS
MAX_COPIES = 3
INSET = 4
THRESHOLD = 128.0
MIN_MARGIN = 40.0

_CRC_POLY = 0x07
_CRC_XOROUT = 0x55


def crc8(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ _CRC_POLY) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc ^ _CRC_XOROUT


def frame_id_bits(frame_id: int) -> list[int]:
    """40-bit codeword: id MSB-first, then CRC8 MSB-first."""
    if not 0 <= frame_id < 2**ID_BITS:
        raise ValueError(f"frame_id out of range: {frame_id}")
    word = (frame_id << CRC_BITS) | crc8(frame_id.to_bytes(4, "big"))
    return [(word >> (CODE_BITS - 1 - i)) & 1 for i in range(CODE_BITS)]


def _copies(frame: np.ndarray) -> int:
    if frame.ndim not in (2, 3) or frame.shape[0] <= BLOCK:
        raise ValueError(f"unsupported frame shape {frame.shape}")
    n = min(MAX_COPIES, frame.shape[1] // (CODE_BITS * BLOCK))
    if n < 1:
        raise ValueError(f"frame too narrow for marker: width {frame.shape[1]}")
    return n


def encode_frame_id(frame: np.ndarray, frame_id: int) -> np.ndarray:
    """Return a copy of `frame` (HxWx3 or HxW uint8) with the marker in rows 0..15."""
    bits = frame_id_bits(frame_id)
    copies = _copies(frame)
    out = frame.copy()
    for c in range(copies):
        for i, b in enumerate(bits):
            x0 = (c * CODE_BITS + i) * BLOCK
            out[:BLOCK, x0 : x0 + BLOCK] = 255 if b else 0
    return out


def _luma(region: np.ndarray) -> np.ndarray:
    r = region.astype(np.float32)
    if r.ndim == 2:
        return r
    return 0.299 * r[..., 0] + 0.587 * r[..., 1] + 0.114 * r[..., 2]


def marker_deviations(frame: np.ndarray) -> np.ndarray | None:
    """Per-bit average (luma - 128) over all copies, shape (40,); None if frame unsupported."""
    try:
        copies = _copies(frame)
    except ValueError:
        return None
    y = _luma(frame[INSET : BLOCK - INSET, : copies * CODE_BITS * BLOCK])
    inner = y.reshape(y.shape[0], copies * CODE_BITS, BLOCK)[:, :, INSET : BLOCK - INSET]
    means = inner.mean(axis=(0, 2)).reshape(copies, CODE_BITS)
    return (means - THRESHOLD).mean(axis=0)


def read_frame_id(frame: np.ndarray) -> int | None:
    dev = marker_deviations(frame)
    if dev is None or np.abs(dev).min() < MIN_MARGIN:
        return None
    word = 0
    for d in dev:
        word = (word << 1) | int(d > 0)
    fid, crc = word >> CRC_BITS, word & 0xFF
    return fid if crc8(fid.to_bytes(4, "big")) == crc else None


def strip_marker(frame: np.ndarray) -> np.ndarray:
    """Copy of `frame` with rows 0..15 replaced by row 16 (edge replication)."""
    out = frame.copy()
    out[:BLOCK] = frame[BLOCK]
    return out
