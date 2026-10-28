"""Frame-id marker: raw roundtrip, CRC, golden vectors and survival through H.264."""

import json
from fractions import Fraction
from pathlib import Path

import numpy as np
import pytest

from app.contracts.frame_id import (
    BLOCK,
    CODE_BITS,
    crc8,
    encode_frame_id,
    frame_id_bits,
    read_frame_id,
    strip_marker,
)

FIXTURES = Path(__file__).parent / "fixtures"
W, H = 1920, 1080


def _frame(seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.integers(0, 256, size=(H, W, 3), dtype=np.uint8)


@pytest.mark.parametrize("fid", [0, 1, 2**32 - 1, 123456789])
def test_roundtrip_raw(fid):
    frame = _frame(fid % 7)
    out = encode_frame_id(frame, fid)
    assert out.shape == frame.shape and out.dtype == np.uint8
    assert read_frame_id(out) == fid
    # input frame is not mutated
    assert not np.array_equal(out[:BLOCK], frame[:BLOCK]) or fid == 0


def test_roundtrip_other_widths():
    for w in (640, 1280, 1366):
        frame = np.full((480, w, 3), 90, dtype=np.uint8)
        assert read_frame_id(encode_frame_id(frame, 4242)) == 4242


def test_encode_rejects_bad_ids_and_small_frames():
    frame = _frame()
    with pytest.raises(ValueError):
        encode_frame_id(frame, -1)
    with pytest.raises(ValueError):
        encode_frame_id(frame, 2**32)
    with pytest.raises(ValueError):
        encode_frame_id(np.zeros((100, 320, 3), np.uint8), 1)


def test_unmarked_frame_reads_none():
    # endoscope frames often have solid black (or blown-out white) borders
    assert read_frame_id(np.zeros((H, W, 3), np.uint8)) is None
    assert read_frame_id(np.full((H, W, 3), 255, np.uint8)) is None
    noise_hits = sum(read_frame_id(_frame(s)) is not None for s in range(50))
    assert noise_hits <= 2


def test_crc_rejects_corruption():
    frame = encode_frame_id(_frame(3), 0xDEADBEEF)
    # flip one codeword bit in every copy -> CRC mismatch -> None
    bad = frame.copy()
    copies = W // (CODE_BITS * BLOCK)
    for c in range(copies):
        x0 = (c * CODE_BITS + 5) * BLOCK
        bad[:BLOCK, x0 : x0 + BLOCK] = 255 - bad[:BLOCK, x0 : x0 + BLOCK]
    assert read_frame_id(bad) is None
    # flipping a bit in only one of three copies is corrected by majority vote
    one = frame.copy()
    one[:BLOCK, 5 * BLOCK : 6 * BLOCK] = 255 - one[:BLOCK, 5 * BLOCK : 6 * BLOCK]
    assert read_frame_id(one) == 0xDEADBEEF


def test_crc8_standard_check_value():
    # CRC-8/I-432-1 (poly 0x07, init 0, xorout 0x55): catalogue check value for "123456789"
    assert crc8(b"123456789") == 0xA1


def test_strip_marker():
    frame = _frame(5)
    marked = encode_frame_id(frame, 77)
    stripped = strip_marker(marked)
    assert stripped.shape == frame.shape
    np.testing.assert_array_equal(stripped[BLOCK:], frame[BLOCK:])
    for y in range(BLOCK):
        np.testing.assert_array_equal(stripped[y], frame[BLOCK])
    assert read_frame_id(stripped) != 77


def test_golden_vectors():
    vectors = json.loads((FIXTURES / "frame_id_vectors.json").read_text())
    assert len(vectors) >= 5
    for v in vectors:
        bits = [int(b) for b in v["bits"]]
        assert len(bits) == CODE_BITS
        assert frame_id_bits(v["frame_id"]) == bits
        out = encode_frame_id(np.full((H, W, 3), 128, np.uint8), v["frame_id"])
        for c in range(W // (CODE_BITS * BLOCK)):
            for i, b in enumerate(bits):
                x0 = (c * CODE_BITS + i) * BLOCK
                blk = out[:BLOCK, x0 : x0 + BLOCK]
                assert np.all(blk == (255 if b else 0)), (v["frame_id"], c, i)


# ---------------------------------------------------------------- H.264 ----

N_FRAMES = 1000


def _content(t: int, base: np.ndarray, noise: np.ndarray) -> np.ndarray:
    """Synthetic moving scene: scrolling gradient + scrolling noise texture + moving disc."""
    f = np.roll(base, shift=7 * t, axis=1)
    f = f + np.roll(noise, shift=(3 * t, 5 * t), axis=(0, 1))
    cx = int(W / 2 + 600 * np.sin(t / 25))
    cy = int(H / 2 + 300 * np.cos(t / 31))
    f[max(cy - 120, 0) : cy + 120, max(cx - 120, 0) : cx + 120] ^= 0x80
    return f


def _run_h264(bitrate: int) -> tuple[int, int, int]:
    av = pytest.importorskip("av")
    yy, xx = np.mgrid[0:H, 0:W]
    base = np.stack(
        [(xx * 255 // W), (yy * 255 // H), ((xx + yy) * 255 // (W + H))], axis=-1
    ).astype(np.uint8)
    noise = np.random.default_rng(1).integers(0, 48, size=(H, W, 3), dtype=np.uint8)

    codec = av.CodecContext.create("libx264", "w")
    codec.width, codec.height = W, H
    codec.pix_fmt = "yuv420p"
    codec.time_base = Fraction(1, 30)
    codec.framerate = Fraction(30, 1)
    codec.bit_rate = bitrate
    codec.options = {
        "preset": "veryfast",
        "tune": "zerolatency",
        "maxrate": str(bitrate),
        "bufsize": str(bitrate // 2),
        "g": "300",
    }
    decoder = av.CodecContext.create("h264", "r")

    ids = [(i * 2654435761) & 0xFFFFFFFF for i in range(N_FRAMES)]
    got: list[int | None] = []

    def decode(packets):
        for p in packets:
            for df in decoder.decode(p):
                got.append(read_frame_id(df.to_ndarray(format="rgb24")))

    for t, fid in enumerate(ids):
        rgb = encode_frame_id(_content(t, base, noise), fid)
        vf = av.VideoFrame.from_ndarray(rgb, format="rgb24").reformat(format="yuv420p")
        vf.pts = t
        decode(codec.encode(vf))
    decode(codec.encode(None))
    for df in decoder.decode(None):
        got.append(read_frame_id(df.to_ndarray(format="rgb24")))

    assert len(got) == N_FRAMES
    correct = sum(g == e for g, e in zip(got, ids))
    wrong = sum(g is not None and g != e for g, e in zip(got, ids))
    missing = sum(g is None for g in got)
    return correct, wrong, missing


@pytest.mark.parametrize("bitrate", [500_000, 1_000_000, 2_000_000, 4_000_000])
def test_survives_h264(bitrate):
    correct, wrong, missing = _run_h264(bitrate)
    print(f"bitrate={bitrate} correct={correct} wrong={wrong} missing={missing}")
    assert wrong == 0
    assert correct / N_FRAMES == 1.0
