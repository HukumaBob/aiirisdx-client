# aiirisdx-client

Backend: FastAPI (`backend/`), frontend: React + Vite (`frontend/`).

```
python3 -m venv backend/.venv && backend/.venv/bin/pip install -e backend
backend/.venv/bin/pytest -q
cd frontend && npm install && npm test && npm run build
```

Result container (video + frame table + log + manifest), the overlay math and the rule for
joining the log to the video (by `frame_id` only): [docs/container-format.md](docs/container-format.md).

## Tests

```
backend/.venv/bin/pytest -q                 # from the repo root (pytest.ini: pythonpath=backend)
cd frontend && npx vitest run && npx tsc -b # unit tests + type check (npm run build also builds)
```

Prerequisites and what needs external assets:

* Backend: the venv from above (`pip install -e backend` brings FastAPI, aiortc, PyAV,
  OpenCV, numpy, ultralytics (+ torch), pytest, pytest-asyncio). Tests spawn worker processes (multiprocessing *spawn*);
  no GPU needed -- all pool/API tests use fast fake pipelines.
* `tests/test_frame_id.py`: the H.264 bitrate gate tests use PyAV via `pytest.importorskip("av")`
  (skipped without it; PyAV is a regular dependency, so normally it runs).
* `tests/test_stages.py`: tests marked `needs_weights` run real YOLO detection and are
  **skipped** unless detector weights exist at `TEST_DETECTOR_WEIGHTS` (default: the
  prototype's `test000.pt` path). The format/geometry logic is also covered with fake models.
* `tests/e2e/test_file_mode_e2e.py`: the in-process variant always runs; the variant against
  a running deployment is skipped unless `AIIRIS_E2E_BASE_URL` (e.g.
  `http://localhost:18080/api`) and `AIIRIS_E2E_MEDIA_DIR` (host directory mounted as the
  backend's `AIIRIS_FILE_ROOT`) are set; add `AIIRIS_E2E_TOKEN` / `AIIRIS_E2E_STAND` when the
  stack requires a stand token.
* Frontend: Node 20 + `npm install`. `frontend/tests/assemble.test.ts` verifies the ZIP with an
  independent reader and needs **`python3` on PATH** (standard library only).
* Not part of the suites (manual / browser): `frontend/scripts/chrome-e2e.cjs` and
  `frontend/scripts/station-e2e.cjs` drive headless Chrome with a fake camera against a
  running backend (playwright on `NODE_PATH`, see the script headers); `tests/load/`
  (streams-per-GPU measurement, `tests/load/README.md`).

## Deployment

Everything is in `deploy/`: `docker-compose.yml`, `Dockerfile.backend`,
`Dockerfile.frontend`, `nginx/`, `coturn.conf`, `.env.example` (documents every variable).

```
cd deploy
cp .env.example .env            # minimal: works as is (gpu profile, no TURN, no token)
cp /path/to/detector.pt weights/detect.pt   # and set AIIRIS_DETECT_WEIGHTS=/weights/detect.pt
docker compose up -d --build    # COMPOSE_PROFILES in .env selects gpu or cpu (+ turn)
curl http://localhost:8080/api/health        # {"status":"ok","ready":true,...}
```

Services:

| service | what | ports |
|---|---|---|
| `backend` (profile `gpu`) / `backend-cpu` (profile `cpu`) | FastAPI + inference pool; uvicorn `app.api.main:app_from_env` | 8000 inside; `127.0.0.1:${AIIRIS_BACKEND_PORT}` for diagnostics |
| `frontend` | nginx: the stand page (static Vite build) + reverse proxy `/api/*` -> backend (REST and the results WebSocket, upgrade headers) | `${AIIRIS_HTTP_PORT}` (8080), `${AIIRIS_HTTPS_PORT}` (8443, only with certs) |
| `coturn` (profile `turn`, opt-in) | TURN/STUN for the WebRTC stream | `${TURN_PORT}` (3478) udp+tcp, relay `${TURN_MIN_PORT}-${TURN_MAX_PORT}` udp |

There is no Redis/Celery service: the backend keeps its state in-process and on the
sessions volume (the `redis`/`celery` packages in `pyproject.toml` are unused and are not in
the image).

**GPU prerequisites.** NVIDIA driver >= 560 (the image uses the PyTorch cu126 wheels, which
carry their own CUDA runtime; no CUDA toolkit on the host or in the image) and the NVIDIA
Container Toolkit (`docker info | grep -i nvidia` must list the runtime). The backend
reserves `AIIRIS_GPU_COUNT` GPUs through `deploy.resources.reservations.devices`. Without a
GPU use `COMPOSE_PROFILES=cpu` (CPU-only torch image, ~1.7 GB instead of ~7.5 GB; detection
then runs at a few fps -- for tests and file mode, not for live use).

**Volumes.** `./weights:/weights:ro` (model weights, never baked into the image),
`./media:/media:ro` (video-file mode root, `AIIRIS_FILE_ROOT=/media`), named volume
`sessions` -> `/data/sessions` (session logs; back it up / keep it). `./certs` -> nginx certs.

**Cloud vs on-prem.**

* *Inside the hospital network* (default): `AIIRIS_REQUIRE_TOKEN=false`, no authorization
  (spec §3). The stand browser and the backend are on one LAN; TURN is usually not needed
  (the `.env.example` default: `AIIRIS_TURN_URLS=[]`, no `turn` profile). If it is needed
  (stands in another subnet behind NAT), enable it as below with `TURN_EXTERNAL_IP` = the
  server's LAN IP and `TURN_ALLOWED_PEER_IP` = that same IP (or the stands' LAN range): the
  shipped `coturn.conf` denies relaying to every private range, and this is the one carve-out.
* *Cloud*: set `AIIRIS_REQUIRE_TOKEN=true` and `AIIRIS_STAND_TOKENS={"stand-1": "<random>"}`;
  enter the token at the stand page ("Токен стойки", stored in the stand's browser). Enable
  TLS (below) and set `AIIRIS_TLS=true`. TURN is required: the backend container has only private addresses, and the stand is
  behind the hospital NAT. Leave `TURN_ALLOWED_PEER_IP` empty: coturn then relays only to
  public addresses (the backend allocates on the same TURN server, so the session runs
  relay-to-relay on the public `TURN_EXTERNAL_IP`), never into the VPC or the docker networks.

**TURN / ICE.** Enable with `COMPOSE_PROFILES=gpu,turn` (or `cpu,turn`). coturn runs with
`use-auth-secret`; set the same random value (`openssl rand -hex 32`) in `TURN_SECRET` and
`AIIRIS_TURN_SECRET` -- both are empty in `.env.example`: coturn exits and the backend refuses
to start when TURN URLs are set with an empty or `change-me` secret (likewise the backend
refuses `AIIRIS_REQUIRE_TOKEN=true` with no tokens or placeholder tokens). The backend derives
time-limited credentials (`AIIRIS_TURN_TTL`, default 2 h; must exceed the longest session, a
reconnect fetches fresh ones; TURN REST API scheme) for its own aiortc peer and hands them to
the stand page via `GET /api/client-config?stand=<stand>`; with `AIIRIS_REQUIRE_TOKEN=true`
that call needs the stand's `X-Stand-Token` (401 otherwise), so anonymous clients get no TURN
credentials. `AIIRIS_TURN_URLS` must be reachable **from the backend
container and from the stands** -- the host's public IP / DNS name (cloud) or LAN IP
(on-prem), never `localhost` (inside the container that is the container itself; a wrong
TURN URL delays every connection by the TURN timeout, ~5 s, measured). Set
`TURN_EXTERNAL_IP` to the same address. Open `TURN_PORT` udp+tcp and the relay range in the
firewall. Static STUN/TURN entries can be added with `AIIRIS_ICE_SERVERS` (JSON).

> **WARNING: stand tokens without TLS travel in clear text.** With
> `AIIRIS_REQUIRE_TOKEN=true` the stand token is sent on every request (`X-Stand-Token`) and
> in the results WebSocket URL (`?token=`). Without certificates in `./certs` nginx serves
> plain HTTP only and anyone on the path can read the token. Never run the cloud mode without
> TLS. The backend logs a startup WARNING when `AIIRIS_REQUIRE_TOKEN=true` and
> `AIIRIS_TLS` is not `true`, and once more if a token arrives over plain HTTP.

**TLS.** Browsers allow camera / capture-card access (`getUserMedia`) only on HTTPS or
`localhost`, so a stand that is not the server itself needs HTTPS. Put `tls.crt` + `tls.key`
(full chain) into `./certs`; nginx then also serves 8443 (HSTS) and plain HTTP (8080) answers
every request except the container health check `/nginx-health` with a `308` redirect to
`https://<host>:${AIIRIS_HTTPS_PORT}` (`AIIRIS_HTTP_REDIRECT=0` keeps plain HTTP serving the
site too; not recommended with tokens). Without certificates (on-prem, minimal `.env`) 8080
serves the site as before. A self-signed certificate for
a closed network: `openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout certs/tls.key
-out certs/tls.crt -subj /CN=aiiris.local -addext subjectAltName=DNS:aiiris.local,IP:<server ip>`
(install it as trusted on the stands). The nginx access log omits query strings, so the
`?token=` of the results WebSocket is not logged.

**Offline use.** At runtime nothing is downloaded: weights come from the volume, and the
image sets `YOLO_OFFLINE=1`, `YOLO_AUTOINSTALL=false` (Ultralytics neither checks online nor
pip-installs) and a writable `YOLO_CONFIG_DIR`. Verified: real YOLO inference in the GPU
image with `docker run --network none` (8 ms/frame, no network access attempted / needed).
Building offline:

* simplest: build on a connected machine, then
  `docker save aiirisdx-backend:gpu aiirisdx-frontend:latest coturn/coturn:4.6 | gzip > aiiris-images.tgz`
  and `docker load < aiiris-images.tgz` on site; `docker compose up -d` (without `--build`);
* or rebuild on site from caches: base images loaded with `docker load`, Python wheels in
  `deploy/wheels/` (`pip download -d deploy/wheels --python-version 3.12 --only-binary=:all:
  torch==2.14.1 torchvision==0.29.1 --index-url https://download.pytorch.org/whl/cu126` plus
  `pip download -d deploy/wheels --no-deps --python-version 3.12 --only-binary=:all: -r
  deploy/requirements.txt`; when the directory contains wheels the build uses `--no-index`),
  and the BuildKit npm/pip cache mounts for warm rebuilds.

**Workers / capacity.** `AIIRIS_WORKERS=2` in `.env.example` (code default 1): measured
on an RTX 2070 + Ryzen 5 3500, 2 workers carry **4 streams of 1080p30** with 0 % drops and
p95 latency 19 ms; the CPU is the bottleneck (`tests/load/README.md`; re-measure on the target
server). Each worker is a process with its own model copy; workers warm up
(`AIIRIS_WARMUP_FRAMES`) before `/health` reports `ready`.

**Acceptance.** With the stack up: `AIIRIS_E2E_BASE_URL=http://localhost:8080/api
AIIRIS_E2E_MEDIA_DIR=$PWD/deploy/media backend/.venv/bin/pytest -q tests/e2e`.
Station page in a real browser: `frontend/scripts/station-e2e.cjs --url http://localhost:8080/ --accounting`.
