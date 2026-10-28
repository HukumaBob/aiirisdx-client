"""JSONL log writer/reader: header line, one frame per line, footer on close."""

import json
import os
from pathlib import Path

from pydantic import ValidationError

from app.contracts.log_schema import FrameRecord, LogFooter, LogHeader


class LogWriter:
    def __init__(self, path: Path, header: LogHeader):
        self._f = open(path, "w", encoding="utf-8")
        self._frames = 0
        self._write(header.model_dump_json())

    def _write(self, line: str) -> None:
        self._f.write(line + "\n")
        self._f.flush()
        try:
            os.fsync(self._f.fileno())
        except OSError:
            pass

    def append(self, rec: FrameRecord) -> None:
        self._write(rec.model_dump_json())
        self._frames += 1

    def close(self, complete: bool) -> None:
        if self._f.closed:
            return
        self._write(LogFooter(complete=complete, frames=self._frames).model_dump_json())
        self._f.close()


def read_log(path: Path) -> tuple[LogHeader, list[FrameRecord], bool]:
    """Read a log. Missing footer => complete=False; an unparsable last line is ignored."""
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    header = LogHeader.model_validate_json(lines[0])
    records: list[FrameRecord] = []
    complete = False
    for i, line in enumerate(lines[1:], start=1):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
            if obj.get("type") == "footer":
                complete = LogFooter.model_validate(obj).complete
                continue
            records.append(FrameRecord.model_validate(obj))
        except (json.JSONDecodeError, ValidationError):
            if i == len(lines) - 1:
                break  # truncated last line from a crash
            raise
    return header, records, complete
