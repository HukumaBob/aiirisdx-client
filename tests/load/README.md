# Load measurement: streams per GPU (spec §8а)

`run_load.py` feeds N concurrent synthetic **1080p @ 30 fps** H.264 streams through the real
server path, in-process (no browser): `FileIngest` in realtime mode (PyAV decode paced to the
file's timestamps, downscale to `max_side` 960 off-loop: the same `FrameSink` path the
WebRTC ingest uses), then `Core.on_frame`, the `InferencePool` (drop-oldest queue of 8,
worker processes, warm-up), the results router and the session log writer (fsync per line).
The pipeline is the production default: `crop`, `yolo_detect` (real weights), `yolo_classify`
(stub, no classifier weights exist yet) and `anatomy`.

```
backend/.venv/bin/python tests/load/run_load.py --streams 1 2 4 8 --seconds 60 \
    --workers 2 --weights /path/to/detector.pt [--json results.jsonl]
CUDA_VISIBLE_DEVICES= backend/.venv/bin/python tests/load/run_load.py ...   # CPU
```

What it reports per N:

* **in / processed fps per stream**: frames submitted per stream per second / frames with a
  real (not dropped) result per stream per second;
* **dropped**: share of records with `dropped: true` (evicted from the full queue);
* **latency**: from submit (frame handed to the pool) to the result back on the event loop,
  p50 / p95 / max, over non-dropped frames;
* **loop stall**: largest overshoot of a 5 ms `asyncio.sleep` probe;
* **GPU util**: NVML, baseline before the run / mean / max during it;
* **logged / records**: records written to the log by the end of `/stop`.

Not covered: WebRTC receive (RTP, aiortc decode, roughly the cost of the PyAV decode here),
reading the frame-id marker, the network and the browser. The secondary-screen delay of ~1 s
(§8а) is set by the stand's buffer; the server-side share measured here is the latency column.

## Machine and conditions (2026-10-31)

* CPU AMD Ryzen 5 3500 (6 cores, no SMT), 16 GB RAM; GPU NVIDIA GeForce RTX 2070 8 GB,
  driver 580.173.02; torch 2.15.0+cu132, ultralytics 8.4.191.
* One detector, `test000.pt` (prototype YOLO, 19 MB) at imgsz 640. No classifier weights
  (stub); with real classifier heads the per-frame cost goes up and N goes down.
* The GPU is shared with another project's container (`endoscopy-platform-ml-worker`), idle
  during the runs (see the baseline column).
* Every run is 60 s. Synthetic content (moving rectangles on a gradient); YOLO cost hardly
  depends on the content.

## Results

| workers | N | in fps/stream | processed fps/stream | total processed fps | dropped | p50 ms | p95 ms | max ms | loop max stall ms | GPU util % base / mean / max | logged / records |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 30.0 | 30.0 | 30 | 0.0% | 9.8 | 10.7 | 13.7 | 4.3 | 0 / 15.1 / 17 | 1800/1800 |
| 1 | 2 | 30.0 | 30.0 | 60 | 0.0% | 9.9 | 10.7 | 20.4 | 4.2 | 2.5 / 30.5 / 31 | 3600/3600 |
| 1 | 4 | 30.0 | 24.2 | 97 | 19.4% | 72.2 | 77.8 | 91.1 | 9.5 | 4 / 38.3 / 40 | 7198/7198 |
| 1 | 8 | 29.9 | 10.4 | 83 | 65.2% | 43.9 | 48.6 | 80.3 | 16.5 | 7.7 / 37.6 / 40 | 14387/14387 |
| 1 | 12 | 29.9 | 5.1 | 61 | 82.8% | 41.9 | 50.4 | 123.2 | 71.8 | 7.7 / 29.9 / 33 | 21551/21568 |
| 1 | 16 | 29.9 | 2.5 | 40 | 91.7% | 45.0 | 64.2 | 220.4 | 177.2 | 0.5 / 13.1 / 24 | 27950/28742 |
| 2 | 3 | 30.0 | 30.0 | 90 | 0.0% | 10.4 | 14.8 | 25.9 | 6.2 | 0.5 / 38.7 / 40 | 5397/5397 |
| **2** | **4** | 30.0 | **30.0** | **120** | **0.0%** | 15.3 | **18.8** | 34.9 | 10.8 | 3.7 / 51.0 / 55 | 7197/7197 |
| 2 | 6 | 29.9 | 23.0 | 138 | 23.3% | 54.6 | 65.7 | 85.7 | 18.2 | 7.3 / 64.0 / 68 | 10793/10793 |
| 2 | 8 | 29.9 | 17.1 | 137 | 43.0% | 46.2 | 52.5 | 79.3 | 18.7 | 0 / 61.7 / 65 | 14380/14380 |
| 2 | 12 | 29.9 | 8.9 | 107 | 70.1% | 40.9 | 51.3 | 128.8 | 81.5 | 2.5 / 42.7 / 55 | 21458/21560 |
| 2 | 16 | 28.1 | 3.7 | 59 | 86.7% | 59.4 | 83.0 | 243.2 | 206.5 | 1 / 23.0 / 39 | 26137/27025 |
| 3 | 4 | 29.9 | 29.9 | 120 | 0.0% | 17.2 | 23.1 | 63.4 | 33.0 | 10.2 / 56.3 / 61 | 7191/7191 |
| 3 | 6 | 29.9 | 27.2 | 163 | 9.2% | 57.0 | 70.3 | 132.2 | 79.9 | 10 / 75.0 / 79 | 10791/10791 |

## Conclusion

Acceptance criterion: latency p95 < 1 s **and** dropped share < **5 %** (a 30 fps stream must
keep at least ~28.5 fps of real results; drops show as frames without boxes on the
secondary screen).

* **Maximum N = 4 streams of 1080p30 per RTX 2070 with 2 workers** (0 % dropped, p95 19 ms).
  N = 6 fails with 2 workers (23 %) and with 3 workers (9 %).
* With 1 worker the maximum is N = 2 (one worker serves ~97 fps at most; N = 4 drops 19 %).
* Default number of workers for this class of machine: **`AIIRIS_WORKERS=2`**
  (`deploy/.env.example`). The code default stays 1 (dev / CPU). A third worker adds nothing
  at N = 4 and is not enough for N = 6.
* Latency is never the limit (p95 < 100 ms in every run; queueing behind a full queue of 8
  adds ~8 frame-times); the limit is throughput, and the shed load shows up as drops.
* The bottleneck is the **CPU**, not the GPU: GPU utilisation stays at 40-79 % while total
  throughput *falls* beyond 6-8 streams (decode + downscale of N 1080p streams + per-frame
  worker pre/post-processing and pickling on 6 cores). Past capacity the event loop starts
  to stall (72-206 ms at N >= 12). A bigger CPU, hardware decode, or shared-memory frame
  transport (Task 6 note) would raise N before a bigger GPU would.
* Above capacity (N >= 12) the log writer falls behind and `/stop`'s 3 s drain ends before
  every record is written (`logged < records`: 17 to 888 records missing from the log). This
  never happens at or below the measured capacity; raise `AIIRIS_DRAIN_TIMEOUT` if a server
  is run overloaded on purpose.

Limits of this measurement: one machine, one detector, no classifier weights (stub), the GPU
shared with an idle container, synthetic video, no WebRTC/RTP or marker-read cost. Repeat on
the target server with the real model set before fixing per-site stream counts.
