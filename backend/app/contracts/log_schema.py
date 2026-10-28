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
    taxonomy_version: str


class Detection(BaseModel):
    """bbox is xywh, normalized 0..1 relative to the original (uncropped) frame."""

    bbox: tuple[float, float, float, float]
    class_name: str
    confidence: float = Field(ge=0.0, le=1.0)

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
