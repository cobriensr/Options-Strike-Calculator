# classifier

Standalone Railway service that runs the polars-based multileg classifier
behind a small HTTP server. Carved out of `sidecar/` so the JVM-heavy
Databento + Theta Data Terminal box no longer competes with polars for
memory. Source of truth for the matcher itself lives in
`ml/src/multileg_assembler.py` and `ml/src/multileg_patterns.py`;
byte-identical vendored copies live in `classifier/_vendored_ml/` and
are kept in sync by a test.

## Environment variables

| Variable     | Required | Default | Notes                                          |
| ------------ | -------- | ------- | ---------------------------------------------- |
| `SENTRY_DSN` | optional | empty   | Empty disables Sentry. Tagged `server_name=classifier`. |
| `PORT`       | optional | `8080`  | Railway sets this; bind `0.0.0.0:$PORT`.       |

## Local development

```bash
pip install -r requirements.txt
PYTHONPATH=src:_vendored_ml python -m main
```

## Running tests

```bash
pytest
```

Coverage gate (`--cov-fail-under=95`, branch coverage) is enforced by
`pyproject.toml` `addopts`, so a plain `pytest` invocation fails CI if
coverage drops below the spec floor.

## Architecture

Co-resident on port 8080 with two routes:

- `POST /multileg-classify` — runs the polars matcher on the posted
  trade window and returns per-trade classifications.
- `GET /health` — liveness probe (used by the Docker `HEALTHCHECK`).

### What ships today (Phase 1)

The server is a `ThreadingHTTPServer` (subclassed as
`_QuietThreadingHTTPServer` to swallow client-disconnect tracebacks
that would otherwise alert as log noise). Each request runs on its
own thread — there is **no concurrency cap** in Phase 1, so parallel
matcher invocations are bounded only by the underlying box's memory
and CPU.

Request-body size is capped at 50 MB; payloads above the cap
short-circuit to `413` before the body is read off the wire (DoS
floor, well clear of the ~3-4 MB a realistic 7500-trade payload
weighs in at). `Connection: close` is set on every 4xx/5xx so
Railway's edge proxy does not pool a broken upstream socket.

### Phase 2 — not yet deployed

The full spec at
`docs/superpowers/specs/multileg-classifier-service-split-2026-05-28.md`
calls for bounded concurrency in front of the matcher:
`threading.BoundedSemaphore(8)` cap on parallel runs, with a 30s queue
wait timeout returning `503 Retry-After: 5`. The TS client will also
drop `MAX_WINDOW_TRADES` from 10000 to 7500 to match the new cap.
**None of that has shipped yet** — Phase 1 is fault isolation only;
back-pressure lands in Phase 2.

## Memory limit

The per-replica memory **ceiling** is NOT settable in `railway.toml`
(config-as-code only covers `build`/`deploy`). It lives on a separate
Railway surface. Recommended ceiling: **8 GB** (rationale in
`classifier/railway.toml`).

**Manual dashboard path** (one-off click): Railway dashboard → project
**Theta-Options** → **Classifier** service → **Settings** tab → **Deploy**
section → **Replica Limits** → set **Memory** (slider/field) to **8 GB** →
the change saves and applies on the next deploy. (Setting it too low
crashes the service, so do not go below the observed open-burst peak.)

**Reproducible alternative** (idempotent, preferred for re-runs):

```bash
RAILWAY_API_TOKEN=... \
RAILWAY_CLASSIFIER_SERVICE_ID=... \
RAILWAY_CLASSIFIER_ENVIRONMENT_ID=... \
node scripts/set-classifier-memory-limit.mjs
```

It reads the current limit first and only mutates if different (exit 0 on
no-op). The token comes from `RAILWAY_API_TOKEN` (or `RAILWAY_TOKEN`) —
create one at <https://railway.com/account/tokens>; it is never printed.
Service/environment IDs come from the dashboard URL
(`project/<projectId>/service/<serviceId>?environmentId=<envId>`).
Under the hood it calls the `serviceInstanceLimitsUpdate` GraphQL
mutation with `{ serviceId, environmentId, memoryGB }` (Railway expresses
the limit in **GB**, not bytes).

## Deploy

Railway-only. Vercel does not host this service. The TypeScript caller
(`api/_lib/multileg-client.ts`) selects this service via the
`CLASSIFIER_URL` env var.

Full design rationale lives in
`docs/superpowers/specs/multileg-classifier-service-split-2026-05-28.md`.
