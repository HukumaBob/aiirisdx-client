# Task 12 report: container + EMR delivery

## What
- frontend/src/container/zip.ts: own stored-ZIP writer (CRC32, local headers, central dir, EOCD, UTF-8 flag, Blob parts, CRC computed over 4 MiB slices; no ZIP64, throws >=4 GiB).
- logParse.ts (tolerant JSONL parser; complete = LAST non-empty line is footer complete=true), assemble.ts (assembleContainer, containerFilename, manifest), deliver.ts (deliver + downloadBlob), finish.ts (FinishedSession -> container -> deliver, outcome for the UI).
- profiles.ts: `emrUrl` in station data (+migrate, store getter/setter). StationPage: EMR URL input, `container-status` line (assembling / ready / delivered / saved locally - delivery failed: ... / log incomplete (server lost)), "Сохранить контейнер" button.
- scripts/station-e2e.cjs: `--save DIR`, `--emr URL`, prints containerStatus.

## ZIP library decision
Own ~100-line writer instead of fflate/client-zip: only stored entries needed, zero deps, Blob-part output means the video is not duplicated in memory (fflate would need a Uint8Array copy of the video; client-zip is small but still a dependency and we need nothing of its streaming). Correctness checked by an independent reader (Python zipfile incl. testzip CRC check + sha256 of video) in the test.

## Decisions
- Manifest as specified; `video.frames_without_pts` lists non-dropped log frame ids absent from the frame table, plus `errors` entry `frame_table_missing: [ids]`. Dropped frames exempt.
- Errors added: log missing, log incomplete, frame_table_missing, plus the flow's `error`/`recorderError`.
- Filename `<session_id>.zip`; if the server never gave an id a local `<stand>_<time>_<uuid>` is synthesized (stable per meta object).
- deliver: POST application/zip + X-Session-Id, retries default 3 (4 attempts), backoff 1s doubling, 30 s per-attempt timeout (AbortController); final failure -> onFallbackSave (default browser download), returns {delivered:false,error}; never throws (also if fallback throws). Empty URL -> {delivered:false} without fallback (page treats empty as download-only).
- No video (file mode / recorder failed) -> no container, status says why.

## Tests (frontend/tests/assemble.test.ts, 24 tests; full suite 97 pass, tsc -b clean)
test_zip_readable_by_independent_reader (Python zipfile), test_log_complete_detection_variants (true/false/no footer/truncated line/truncated footer/footer not last/null/empty), test_manifest_marks_incomplete_log, test_frame_table_covers_log_frame_ids, test_no_patient_fields, test_filename_has_no_doctor_name, test_deliver_retries_then_keeps_file, test_deliver_never_throws, backoff timing, timeout abort, buildAndDeliver (server lost / delivery failed).
Concern: tests need python3 on PATH (spawn `python3 -I`).

## TDD evidence
Tests written first; first run: "Test Files 1 failed, no tests" (imports of src/container/* missing). After implementation: 22 passed at first run, later 24.

## E2E (headless Chrome, fake camera, backend :8011, vite :5176, both stopped afterwards)
1. No EMR URL, 6 s: page "Контейнер: готов (URL EMR не задан)", download via button. Python zipfile: testzip OK; entries video.mp4 322096 B, frame_table.json, log.jsonl, manifest.json; manifest: doctor "Тест", crop null, mp4 avc1.640028, frame_count 149, frames_without_pts [], log.complete true frames 145, errors []; frame table 149 rows; log 147 lines ending with footer complete true; no log frame lacking a pts.
2. EMR = local python receiver: status "доставлен в EMR"; receiver got Content-Type application/zip and X-Session-Id = session id; received zip valid.
3. EMR URL dead: status "сохранён локально — доставка не удалась: Failed to fetch"; file downloadable via button (fallback auto-download also triggered, not captured by headless).
NOT verified e2e: server killed mid-session (log complete=false) - covered only by unit tests (null log / truncated log). Real EMR with CORS: a browser POST cross-origin needs the EMR to allow CORS (my test receiver answered OPTIONS with ACAO); worth noting for deployment (or proxy through reverse proxy).

## Concerns
- Cross-origin EMR POST requires CORS on the EMR side.
- Stored video >= 4 GiB unsupported (buildAndDeliver reports 'container: ...' failure, recording itself stays in FinishedSession.video; no raw-video fallback button in the UI yet).
- Whole container held in memory as a Blob (fine for session sizes seen: 0.3 MB / 6 s).

## Fix round 1 (review: >=4 GiB recording unrecoverable, false "saved locally")
Changed:
- zip.ts: real ZIP64. Per entry: sizes >= threshold get saturated 32-bit fields + ZIP64 extra (local: both sizes after the name; central: only saturated fields in order size, size, offset), version 45. ZIP64 EOCD record + locator when the central directory offset/size reaches the threshold or entries > 65534; otherwise plain ZIP. Blobs stay referenced as parts. `createZip(entries, {zip64Threshold, now, type})`: threshold injectable (default 0xFFFFFFFF). Misleading "raw-recording fallback" comment replaced.
- finish.ts: if assembleContainer throws, raw video, frame_table.json and log.jsonl (if any) are handed one by one to onFallbackSave (default download) -> outcome `raw-saved` with the reason; `savedLocally` is true only if a file was really handed over; if none could be saved -> `failed`, savedLocally=false. `buildAndDeliver` takes an injectable `assemble`. Outcome 'saved' renamed 'ready'.
- deliver.ts: result has `savedLocally` (false when the fallback save threw).
- StationPage: "сохранён локально" only when savedLocally; otherwise explicit "НЕ доставлен и НЕ сохранён автоматически — используйте кнопку «Сохранить контейнер»"; raw-saved message "Контейнер не собран — сырые файлы сохранены ..."; no-blob+failed -> "не собран и файлы не сохранены".
Tests (tests/assemble.test.ts, +6): test_zip64_forced_small_input (threshold 100, ZIP64 EOCD present, Python zipfile + testzip CRCs, extract_version 45, sha256 of video), offset-only/threshold-0 variants, small archive stays plain, raw fallback file names/order/outcome, nothing-saved not claimed as saved, delivery failure with failed local save. A fake >4 GiB Blob was NOT tested: CRC needs to read every byte, so it cannot be done without allocating it.
Command: `cd frontend && npx tsc -b && npx vitest run` -> tsc clean; Test Files 8 passed, Tests 103 passed.
Note: browsers may prompt before multiple automatic downloads (raw fallback saves 2-3 files).
