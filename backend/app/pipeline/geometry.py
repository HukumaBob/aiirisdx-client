"""Coordinate mapping between the working (possibly cropped) frame and the original frame."""

from __future__ import annotations


def _clamp(v: float) -> float:
    return min(1.0, max(0.0, v))


def to_original_norm(box_px_xywh, ctx: dict) -> tuple[float, float, float, float]:
    """Map an xywh box in WORKING-frame pixels to xywh normalized 0..1 of the ORIGINAL frame.

    ctx: "frame" (working frame), "crop_offset" (x, y; default (0, 0)),
    "orig_size" (W, H; default = working frame size). The box is clipped to the
    original frame, so x+w and y+h never exceed 1.
    """
    wh, ww = ctx["frame"].shape[:2]
    ox, oy = ctx.get("crop_offset", (0, 0))
    W, H = ctx.get("orig_size", (ww, wh))
    x, y, w, h = box_px_xywh
    x0, y0 = _clamp((x + ox) / W), _clamp((y + oy) / H)
    x1, y1 = _clamp((x + w + ox) / W), _clamp((y + h + oy) / H)
    return (x0, y0, x1 - x0, y1 - y0)


def points_to_original_norm(points_px, ctx: dict) -> list[tuple[float, float]]:
    """Map (x, y) points in WORKING-frame pixels to points normalized 0..1 of the ORIGINAL
    frame (same convention as ``to_original_norm``; points are clamped into the frame)."""
    wh, ww = ctx["frame"].shape[:2]
    ox, oy = ctx.get("crop_offset", (0, 0))
    W, H = ctx.get("orig_size", (ww, wh))
    return [(_clamp((float(x) + ox) / W), _clamp((float(y) + oy) / H)) for x, y in points_px]
