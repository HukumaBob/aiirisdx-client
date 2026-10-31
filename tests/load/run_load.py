#!/usr/bin/env python3
"""Load measurement (Task 13, spec §8а): N concurrent 1080p@30 streams on one GPU.

What runs (in-process, no browser): for each stream a ``FileIngest`` in realtime mode reads a
generated 1080p30 H.264 file (PyAV decode, pacing to the file's timestamps, downscale to
``max_side`` 960 off-loop -- the same ``FrameSink`` path as WebRTC) into the real
``Core.on_frame`` -> ``InferencePool`` (drop-oldest queue, worker processes) -> results router
-> session log writer (fsync per line). The pipeline is the production default
(crop, yolo_detect with real weights, yolo_classify stub, anatomy) -- or a stub if no weights.
Not covered: WebRTC receive/RTP depacketizing and the marker read (aiortc decode costs about
what PyAV decode costs here), the network, the browser.

Per N it reports: processed (non-dropped) fps per stream, dropped share, latency from
submit (frame handed to the pool) to result (record back on the event loop) p50/p95/max,
event-loop max stall (5 ms sleep probe), GPU utilisation (NVML, mean/max) and the GPU
utilisation baseline before the run.

Usage (from the repo root):
  backend/.venv/bin/python tests/load/run_load.py --streams 1 2 4 8 --seconds 60 \
      [--weights path.pt] [--workers 1] [--queue-size 8] [--json out.json]
Weights: --weights, else $TEST_DETECTOR_WEIGHTS, else none (stub detector, 5 ms).
CPU instead of GPU: CUDA_VISIBLE_DEVICES= backend/.venv/bin/python tests/load/run_load.py ...
"""

from __future__ import annotations

import argparse
import asyncio
import functools
import json
import os
import platform
import statistics
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import av  # noqa: E402
import numpy as np  # noqa: E402

from app.api.config import Settings, make_pipeline  # noqa: E402
from app.api.main import warmed_pipeline  # noqa: E402
from app.api.sessions import Core  # noqa: E402
from app.ingest.file_source import FileIngest  # noqa: E402
from app.workers.pool import InferencePool  # noqa: E402
from load_stub import stub_pipeline  # noqa: E402

FPS = 30
PROBE_S = 0.005


def make_video(path: Path, seconds: int, size=(1920, 1080)) -> Path:
    """1080p30 H.264 with moving shapes over a gradient (cached between runs)."""
    if path.exists() and path.stat().st_size > 0:
        return path
    w, h = size
    yy, xx = np.mgrid[0:h, 0:w]
    base = ((xx * 255 // w)[..., None] * np.array([1, 0.5, 0.2])).astype(np.uint8)
    tmp = path.with_suffix(".tmp.mp4")
    with av.open(str(tmp), "w") as out:
        st = out.add_stream("libx264", rate=FPS, options={"preset": "ultrafast", "crf": "28"})
        st.width, st.height, st.pix_fmt = w, h, "yuv420p"
        for i in range(seconds * FPS):
            img = base.copy()
            for k in range(3):
                cx = int((0.2 + 0.3 * k) * w + 200 * np.sin(i / 20 + k))
                cy = int(h / 2 + 150 * np.cos(i / 25 + k))
                img[max(0, cy - 60):cy + 60, max(0, cx - 80):cx + 80] = (40 + 60 * k, 200, 90)
            for pkt in st.encode(av.VideoFrame.from_ndarray(img, format="bgr24")):
                out.mux(pkt)
        for pkt in st.encode():
            out.mux(pkt)
    tmp.rename(path)
    return path


class GpuSampler:
    """NVML utilisation sampler (thread); no-op without NVIDIA/NVML."""

    def __init__(self, period: float = 0.2):
        self.period, self.samples, self.mem = period, [], []
        self._stop = threading.Event()
        self.name = None
        try:
            import pynvml

            pynvml.nvmlInit()
            self._nvml = pynvml
            self._h = pynvml.nvmlDeviceGetHandleByIndex(0)
            self.name = pynvml.nvmlDeviceGetName(self._h)
            self.name = self.name.decode() if isinstance(self.name, bytes) else self.name
        except Exception:
            self._nvml = None

    def baseline(self, seconds: float = 3.0) -> float | None:
        if not self._nvml:
            return None
        vals = []
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            vals.append(self._nvml.nvmlDeviceGetUtilizationRates(self._h).gpu)
            time.sleep(self.period)
        return statistics.mean(vals)

    def _run(self):
        while not self._stop.is_set():
            u = self._nvml.nvmlDeviceGetUtilizationRates(self._h)
            self.samples.append(u.gpu)
            self.mem.append(self._nvml.nvmlDeviceGetMemoryInfo(self._h).used / 2**20)
            time.sleep(self.period)

    def __enter__(self):
        if self._nvml:
            self._t = threading.Thread(target=self._run, daemon=True)
            self._t.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()


def pct(vals: list[float], q: float) -> float | None:
    if not vals:
        return None
    vals = sorted(vals)
    return vals[min(len(vals) - 1, int(round(q * (len(vals) - 1))))]


async def run_one(n: int, seconds: int, video: Path, factory, args, tmp: Path) -> dict:
    settings = Settings(sessions_dir=tmp / f"n{n}", workers=args.workers,
                        queue_size=args.queue_size, file_root=video.parent)
    (tmp / f"n{n}").mkdir(parents=True, exist_ok=True)
    worker_factory = functools.partial(warmed_pipeline, factory, 3, (540, 960))
    gpu = GpuSampler()
    base_util = gpu.baseline(2.0)
    async with InferencePool(worker_factory, args.workers, args.queue_size) as pool:
        await pool.wait_ready(timeout=300)
        core = Core(settings, pool, factory().model_versions() if args.versions else {})
        submitted: dict[tuple[str, int], float] = {}
        lat: list[float] = []
        per: dict[str, list[int]] = {}  # key -> [real, dropped]
        orig_on_frame, orig_deliver = core.on_frame, core._deliver

        def on_frame(frame, ref):
            submitted[(ref.session_id, ref.frame_id)] = time.perf_counter()
            orig_on_frame(frame, ref)

        def deliver(key, rec):
            t = submitted.pop((key, rec.frame_id), None)
            c = per.setdefault(key, [0, 0])
            if rec.dropped:
                c[1] += 1
            else:
                c[0] += 1
                if t is not None:
                    lat.append(time.perf_counter() - t)
            orig_deliver(key, rec)

        core.on_frame, core._deliver = on_frame, deliver
        core.start()
        sessions = [core.create(f"load-{k}", None, None) for k in range(n)]
        stalls: list[float] = []
        stop = asyncio.Event()

        async def probe():
            last = time.perf_counter()
            while not stop.is_set():
                await asyncio.sleep(PROBE_S)
                now = time.perf_counter()
                stalls.append(now - last - PROBE_S)
                last = now

        async def stream(s, k):
            await asyncio.sleep(k * 0.011)  # streams are not phase-locked in reality
            ing = FileIngest(video, True, on_frame, s.key, max_side=settings.max_side)
            task = asyncio.create_task(ing.run())
            await asyncio.sleep(seconds)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            return ing.delivered_frames

        p = asyncio.create_task(probe())
        t0 = time.perf_counter()
        with gpu:
            delivered = await asyncio.gather(*(stream(s, k) for k, s in enumerate(sessions)))
            elapsed = time.perf_counter() - t0
            frames = [await core.stop(s) for s in sessions]
        stop.set()
        await p
        await core.shutdown()
    real = sum(c[0] for c in per.values())
    dropped = sum(c[1] for c in per.values())
    total = real + dropped
    return {
        "streams": n, "workers": args.workers, "queue_size": args.queue_size,
        "seconds": round(elapsed, 1),
        "input_fps_per_stream": round(statistics.mean(delivered) / elapsed, 1),
        "processed_fps_per_stream": round(real / n / elapsed, 1),
        "dropped_share": round(dropped / total, 4) if total else None,
        "records": total, "submitted": sum(delivered), "logged": sum(frames),
        "lat_p50_ms": round(1000 * pct(lat, 0.5), 1) if lat else None,
        "lat_p95_ms": round(1000 * pct(lat, 0.95), 1) if lat else None,
        "lat_max_ms": round(1000 * max(lat), 1) if lat else None,
        "loop_max_stall_ms": round(1000 * max(stalls), 1) if stalls else None,
        "loop_p99_stall_ms": round(1000 * pct(stalls, 0.99), 1) if stalls else None,
        "gpu_util_baseline": None if base_util is None else round(base_util, 1),
        "gpu_util_mean": round(statistics.mean(gpu.samples), 1) if gpu.samples else None,
        "gpu_util_max": max(gpu.samples) if gpu.samples else None,
        "gpu_mem_used_max_mib": round(max(gpu.mem)) if gpu.mem else None,
    }


def machine() -> dict:
    cpu = platform.processor()
    try:
        for line in open("/proc/cpuinfo"):
            if line.startswith("model name"):
                cpu = line.split(":", 1)[1].strip()
                break
    except OSError:
        pass
    g = GpuSampler()
    import torch

    return {"cpu": cpu, "cpus": os.cpu_count(), "gpu": g.name,
            "torch": torch.__version__,
            "cuda": torch.cuda.is_available() and os.environ.get("CUDA_VISIBLE_DEVICES") != ""}


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--streams", type=int, nargs="+", default=[1, 2, 4, 8])
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--queue-size", type=int, default=8)
    ap.add_argument("--weights", default=os.environ.get("TEST_DETECTOR_WEIGHTS"))
    ap.add_argument("--video", default=None, help="1080p30 input (generated if omitted)")
    ap.add_argument("--json", default=None, help="append results (JSON lines)")
    ap.add_argument("--versions", action="store_true", help="probe model versions in parent")
    args = ap.parse_args()
    cache = ROOT / "tests" / "load" / ".cache"
    cache.mkdir(exist_ok=True)
    secs = max(args.seconds, 10) + 5
    video = Path(args.video) if args.video else make_video(
        cache / f"synthetic_1080p30_{secs}s.mp4", secs)
    if args.weights:
        cfg = Settings(detect_weights=Path(args.weights)).pipeline_config()
        factory = functools.partial(make_pipeline, cfg)
    else:
        factory = stub_pipeline
    info = {"machine": machine(), "weights": args.weights or "stub (5 ms)", "video": str(video)}
    print(json.dumps(info))
    with tempfile.TemporaryDirectory() as tmp:
        for n in args.streams:
            r = await run_one(n, args.seconds, video, factory, args, Path(tmp))
            r.update(weights=Path(args.weights).name if args.weights else "stub",
                     cuda=info["machine"]["cuda"])
            print(json.dumps(r), flush=True)
            if args.json:
                with open(args.json, "a") as f:
                    f.write(json.dumps({**r, "machine": info["machine"]}) + "\n")


if __name__ == "__main__":
    asyncio.run(main())
