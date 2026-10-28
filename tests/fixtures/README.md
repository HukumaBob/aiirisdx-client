# Fixtures

## frame_id_vectors.json

Golden vectors for the frame-id marker (`backend/app/contracts/frame_id.py`), used to verify
the TypeScript (browser canvas) port byte-for-byte.

Each entry: `frame_id` (uint32), `crc8` (int), `bits` (40-char string, `bits[0]` is drawn leftmost).

- Codeword: 32-bit `frame_id` MSB first, then CRC8 MSB first (40 bits).
- CRC8: CRC-8/I-432-1 — poly 0x07, init 0x00, no reflection, xorout 0x55, computed over the id
  as 4 big-endian bytes. Check value: `crc8("123456789") == 0xA1`.
- Geometry: bit `i` of copy `c` is a solid 16x16 block at x = (c*40 + i)*16, y = 0..15.
  `1` = white (255,255,255), `0` = black (0,0,0). Copies = min(3, width // 640);
  at 1920 px the three copies fill the whole top 16 rows.
- Reading (server): per block, mean luma (0.299R+0.587G+0.114B) of the inner 8x8 (inset 4 px);
  per bit average (mean - 128) over copies; bit = avg > 0; any |avg| < 40 or CRC mismatch -> None.
