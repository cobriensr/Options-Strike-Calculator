# ml-sweep — Railway-hosted PAC backtest runner

Sibling service to [`sidecar/`](../sidecar/). Runs the Python PAC
backtest suite (CPCV, Optuna, pine-match validation) on Railway's
compute so the developer laptop doesn't have to.

Full design: [pac-sweep-railway-service-2026-04-22.md](../docs/superpowers/specs/pac-sweep-railway-service-2026-04-22.md).

## Current phase: 1 — scaffold

Only `GET /health` works for real. `POST /run` and `GET /status/:id`
are echo stubs — they return the shape that Phase 3 will fill in.

## Endpoints

| Method | Path               | Auth   | Purpose                                              |
| ------ | ------------------ | ------ | ---------------------------------------------------- |
| `GET`  | `/health`          | none   | Railway health probe; returns `{ok: true}`           |
| `POST` | `/run`             | Bearer | Phase 3: queue a sweep job, return a `job_id`        |
| `GET`  | `/status/{job_id}` | Bearer | Phase 3: check job state; returns blob URL when done |

## Auth

All mutation/read endpoints require `Authorization: Bearer <token>`
where `<token>` matches the `AUTH_TOKEN` env var on the Railway
service. Generate a long random token locally and set it via
`railway variables set AUTH_TOKEN=...`.

## Local dev

```bash
cd ml-sweep
pip install -r requirements.txt
AUTH_TOKEN=dev uvicorn app:app --reload --port 8080
curl http://localhost:8080/health
curl -X POST http://localhost:8080/run \
  -H "Authorization: Bearer dev" \
  -H "Content-Type: application/json" \
  -d '{"script":"pine_match_2026_window","args":{}}'
```

## Deploying

First deploy:

```bash
cd ml-sweep
railway init   # pick existing Theta-Options project, new service "ml-sweep"
railway variables set AUTH_TOKEN=$(openssl rand -hex 32)
railway up
```

Subsequent deploys happen automatically when `ml-sweep/**` or `ml/**`
changes are pushed to `main` (configured via `railway.toml`
watchPatterns).

## Scaling to zero (save money)

This service is intended to be idle most of the time. After completing
a sweep, scale to zero replicas so Railway stops billing compute:

```bash
railway service scale --replicas 0 --service ml-sweep
```

Bring it back online just before the next sweep:

```bash
railway service scale --replicas 1 --service ml-sweep
```

Cold start is ~30-60 sec (container boot + archive hydration in
Phase 2+).

## Destroying (if abandoned)

```bash
railway service delete ml-sweep
```

Removes the service entirely. The parent `Theta-Options` project and
sidecar service stay untouched.
