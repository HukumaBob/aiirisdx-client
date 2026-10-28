"""Shared helpers for YOLO stages."""

from __future__ import annotations

import hashlib
from pathlib import Path


def weights_version(path: Path) -> str:
    """'<file stem>@<first 8 hex of sha1 of file content>' (content-based, mtime-independent)."""
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return f"{Path(path).stem}@{h.hexdigest()[:8]}"


def load_yolo(path: Path):
    from ultralytics import YOLO  # lazy: heavy import

    return YOLO(str(path))
