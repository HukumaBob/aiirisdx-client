"""Session log data contract (schema_version 1.0). No personal data fields by design."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

SCHEMA_VERSION = "1.0"
_EPS = 1e-6


class CropRect(BaseModel):
    """Crop rectangle in pixels of the ORIGINAL frame."""

    x: int = Field(ge=0)
    y: int = Field(ge=0)
    w: int = Field(gt=0)
    h: int = Field(gt=0)


class SessionId(BaseModel):
    stand: str
    started_at: datetime
    uuid: str


class LogHeader(BaseModel):
    type: Literal["header"] = "header"
    schema_version: str = SCHEMA_VERSION
    session: SessionId
    doctor: str | None = None  # free-form label, not a patient identifier
    crop: CropRect | None = None
    models: dict[str, str] = Field(default_factory=dict)
    # which detector the doctor chose for the session: "detect" (boxes) | "segment" (boxes +
    # contours); None when the pipeline has no such choice
    model_variant: str | None = None
    taxonomy_version: str


MAX_POLYGON_POINTS = 256


class Detection(BaseModel):
    """bbox is xywh, normalized 0..1 relative to the original (uncropped) frame.

    ``polygon`` (segmentation only): the outline of the finding as (x, y) points, normalized
    0..1 relative to the same original frame, in drawing order, implicitly closed. Absent for
    boxes-only detectors. Additive field: readers of schema 1.0 that ignore it still work."""

    bbox: tuple[float, float, float, float]
    class_name: str
    confidence: float = Field(ge=0.0, le=1.0)
    polygon: list[tuple[float, float]] | None = None

    @field_validator("polygon")
    @classmethod
    def _polygon_range(cls, v):
        if v is None:
            return v
        if not 3 <= len(v) <= MAX_POLYGON_POINTS:
            raise ValueError(f"polygon needs 3..{MAX_POLYGON_POINTS} points, got {len(v)}")
        if any(not (-_EPS <= x <= 1 + _EPS and -_EPS <= y <= 1 + _EPS) for x, y in v):
            raise ValueError("polygon points must be within 0..1")
        return v

    @field_validator("bbox")
    @classmethod
    def _bbox_range(cls, v):
        x, y, w, h = v
        if min(x, y, w, h) < 0 or max(x, y, w, h) > 1 + _EPS:
            raise ValueError("bbox values must be within 0..1")
        if x + w > 1 + _EPS or y + h > 1 + _EPS:
            raise ValueError("bbox exceeds the frame (x+w>1 or y+h>1)")
        return v


class FrameRecord(BaseModel):
    type: Literal["frame"] = "frame"
    frame_id: int = Field(ge=0)
    pts: float  # seconds
    detections: list[Detection] = Field(default_factory=list)
    classification: dict[str, str] = Field(default_factory=dict)
    anatomy: dict | None = None
    dropped: bool = False


class LogFooter(BaseModel):
    type: Literal["footer"] = "footer"
    complete: bool
    frames: int
