# aiirisdx-client

Backend: FastAPI (`backend/`), frontend: React + Vite (`frontend/`).

```
python3 -m venv backend/.venv && backend/.venv/bin/pip install -e backend
backend/.venv/bin/pytest -q
cd frontend && npm install && npm test && npm run build
```

## Deployment

Everything is in `deploy/`: `docker-compose.yml`, `Dockerfile.backend`,
`Dockerfile.frontend`, `nginx/`, `coturn.conf`, `.env.example` (documents every variable).

```
cd deploy
cp .env.example .env            # edit: profile, ports, weights, TURN, token
cp /path/to/detector.pt weights/detect.pt   # and set AIIRIS_DETECT_WEIGHTS=/weights/detect.pt
docker compose up -d --build    # COMPOSE_PROFILES in .env selects gpu or cpu
curl http://localhost:8080/api/health        # {"status":"ok","ready":true,...}
```

Services:

| service | what | ports |
|---|---|---|
| `backend` (profile `gpu`) / `backend-cpu` (profile `cpu`) | FastAPI + inference pool; uvicorn `app.api.main:app_from_env` | 8000 inside; `127.0.0.1:${AIIRIS_BACKEND_PORT}` for diagnostics |
| `frontend` | nginx: the stand page (static Vite build) + reverse proxy `/api/*` -> backend (REST and the results WebSocket, upgrade headers) | `${AIIRIS_HTTP_PORT}` (8080), `${AIIRIS_HTTPS_PORT}` (8443, only with certs) |
| `coturn` | TURN/STUN for the WebRTC stream | `${TURN_PORT}` (3478) udp+tcp, relay `${TURN_MIN_PORT}-${TURN_MAX_PORT}` udp |

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
  (spec §3). The stand browser and the backend are on one LAN; TURN is usually not needed but
  harmless.
* *Cloud*: set `AIIRIS_REQUIRE_TOKEN=true` and `AIIRIS_STAND_TOKENS={"stand-1": "<random>"}`;
  enter the token at the stand page ("Токен стойки", stored in the stand's browser). Enable
  TLS. TURN is required: the backend container has only private addresses, and the stand is
  behind the hospital NAT.

**TURN / ICE.** coturn runs with `use-auth-secret`; set the same random value in
`TURN_SECRET` and `AIIRIS_TURN_SECRET`. The backend derives time-limited credentials
(`AIIRIS_TURN_TTL`, TURN REST API scheme) for its own aiortc peer and hands them to the stand
page via `GET /api/client-config`. `AIIRIS_TURN_URLS` must be reachable **from the backend
container and from the stands** -- the host's public IP / DNS name (cloud) or LAN IP
(on-prem), never `localhost` (inside the container that is the container itself; a wrong
TURN URL delays every connection by the TURN timeout, ~5 s, measured). Set
`TURN_EXTERNAL_IP` to the same address. Open `TURN_PORT` udp+tcp and the relay range in the
firewall. Static STUN/TURN entries can be added with `AIIRIS_ICE_SERVERS` (JSON).

**TLS.** Browsers allow camera / capture-card access (`getUserMedia`) only on HTTPS or
`localhost`, so a stand that is not the server itself needs HTTPS. Put `tls.crt` + `tls.key`
(full chain) into `./certs`; nginx then also serves 8443 (HSTS). A self-signed certificate for
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

**Workers.** `AIIRIS_WORKERS` (default 1) -- see `tests/load/README.md` for the measured
stream capacity per GPU. Each worker is a process with its own model copy; workers warm up
(`AIIRIS_WARMUP_FRAMES`) before `/health` reports `ready`.

**Acceptance.** With the stack up: `AIIRIS_E2E_BASE_URL=http://localhost:8080/api
AIIRIS_E2E_MEDIA_DIR=$PWD/deploy/media backend/.venv/bin/pytest -q tests/e2e`.
Station page in a real browser: `frontend/scripts/station-e2e.cjs --url http://localhost:8080/ --accounting`.
