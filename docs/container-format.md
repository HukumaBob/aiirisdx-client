# Result container format (v1)

The stand page assembles one ZIP per session after **Stop** (spec §6). It is self-contained:
a clean recording, the server's result log and enough metadata to overlay the results on the
video without the server. Writer: `frontend/src/container/assemble.ts`; types:
`Manifest` / `ContainerMeta` there; log schema: `backend/app/contracts/log_schema.py`.

## Files

| File | Written by | Content |
|---|---|---|
| `video.mp4` or `video.webm` | stand browser (MediaRecorder) | recording of the capture card signal, **cropped** to `manifest.crop` when a crop was set, no burned-in boxes, no frame-id marker |
| `frame_table.json` | stand browser | `[{"frameId": int, "pts": float}]`: capture frame id -> time (s) in the **recording** timeline |
| `log.jsonl` | server | JSON lines: header, one record per frame the server received, footer (see below). Missing when the log could not be fetched |
| `manifest.json` | stand browser | description of the container (below) |

Stored entries (no compression). ZIP64 records are written only when a size/offset needs them
(recordings >= 4 GiB, roughly 1-2 h at 5-8 Mbit/s); any current unzip / Python `zipfile`
reads them. File name: `<session_id>.zip` (`<stand>_<YYYYmmddTHHMMSS>_<uuid>`), never the
doctor's name.

## manifest.json

```json
{
  "schema_version": "1.0",
  "container_version": "1",
  "session": {"stand": "stand-1", "started_at": "<ISO time>", "uuid": "<32 hex>", "session_id": "stand-1_20261030T100000_<uuid>"},
  "doctor": "free-form label or null",
  "crop": {"x": 420, "y": 0, "w": 1080, "h": 1080},
  "source": {"width": 1920, "height": 1080},
  "video": {"file": "video.mp4", "mimeType": "video/mp4;codecs=avc1", "recording_start_offset": 0.033,
            "frame_count": 5400, "frames_without_pts": []},
  "log": {"file": "log.jsonl", "complete": true, "frames": 5310},
  "errors": [],
  "created_at": "<ISO time>"
}
```

- `crop`: rectangle in pixels of the **original** capture frame; `null` = no crop (the video
  is the whole frame). The video's pixel size is `crop.w x crop.h`.
- `source`: size (pixels) of the **original** capture frame as negotiated with the card
  (`track.getSettings()`). The log's normalized bboxes refer to this frame. `null` if unknown.
- `video.recording_start_offset`: capture-timeline time (s) of recording time 0.
- `video.frames_without_pts`: frame ids that have a (non-dropped) log record but no row in
  the frame table; also reported in `errors` as `frame_table_missing: [...]`.
- `log.complete`: `true` only when `log.jsonl` ends with a footer `{"complete": true}`.
  `false` means the server was lost or shut down mid-session, or the log was truncated: the
  records present are valid, the session may have more frames than were logged.
  `log.frames`: footer frame count (or the number of records when there is no footer).
- `errors`: every problem met while stopping/assembling (server down, recorder error, ...).
- No patient data: only stand, times, uuid and the doctor label.

## log.jsonl

Line 1, header: `{"type":"header","schema_version":"1.0","session":{...},"doctor":...,
"crop":{...}|null,"models":{"stage":"version"},"model_variant":"detect"|"segment"|null,
"taxonomy_version":"..."}`.
`crop` in the header is the same rectangle as in the manifest (original pixels).
`model_variant` is the detector the doctor chose for the session: `detect` (boxes) or
`segment` (boxes + outlines); `null` when the pipeline offered no such choice. `models` lists
the versions of every loaded stage, including the one that was not chosen.

Frame records: `{"type":"frame","frame_id":int,"pts":float,"detections":[{"bbox":[x,y,w,h],
"class_name":str,"confidence":0..1,"polygon":[[x,y],...]|null}],"classification":{"zone":..,"quality":..,"mode":..},
"anatomy":{"status":..}|null,"dropped":bool}`.

- `bbox`: xywh, normalized 0..1 of the **original, uncropped** frame (`manifest.source`),
  even though inference ran on the cropped region.
- `polygon` (segmentation sessions only, otherwise absent / `null`): the outline of the finding,
  3..256 points `[x, y]` normalized 0..1 of the same original frame, in drawing order, implicitly
  closed. It is a simplified contour (Douglas-Peucker, at most ~96 points) of the model's mask;
  readers should smooth it when drawing (the reference client does). Additive field of schema
  1.0: a reader that ignores it still sees the same `bbox`.
- `dropped: true`: the server received the frame but skipped inference under overload
  (no detections; it is not "nothing found").
- A frame id that is absent from the log never reached the server (the browser encoder did
  not send it, or its marker was unreadable): there is no result for it.

Last line, footer: `{"type":"footer","complete":true|false,"frames":int}`; absent after a
server crash.

## Joining the log to the video

**Join ONLY by `frame_id`**, through the frame table:

```
log record (frame_id) -> frame_table.json row with the same frameId -> pts (s) in the video
```

- `frame_table.pts` is on the **recording** timeline. Seek to the video frame nearest to it;
  tolerance is **±1 frame** (the recorder's own timestamps differ from the capture callback
  by up to about one frame interval).
- The log's own `pts` is the server's **receive-side RTP media time** of that frame (in the
  server video-file mode: the file's PTS). It is a different clock with a different origin. **Never compare log `pts` with
  `frame_table.pts`** and never join by time.
- Frames in the frame table without a log record: no result (show without boxes). Log
  records whose id is not in the frame table: listed in `video.frames_without_pts`; they
  cannot be placed in the video.

## Overlaying boxes on the cropped video

With `W, H = manifest.source.width, manifest.source.height` and `crop = manifest.crop`
(or `{x:0, y:0, w:W, h:H}` when null), a box `[x, y, w, h]` from the log maps to pixels of
the video frame as:

```
x_px = x * W - crop.x
y_px = y * H - crop.y
w_px = w * W
h_px = h * H
```

Clip the result to `0..crop.w` / `0..crop.h`: a box may extend outside the cropped region.
If `source` is `null` (older container / unknown), `W, H` cannot be recovered exactly from
a cropped video; without a crop, use the video's own size.
