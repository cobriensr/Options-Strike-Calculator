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

### What ships today

The server is a `ThreadingHTTPServer` (subclassed as
`_QuietThreadingHTTPServer` to swallow client-disconnect tracebacks
that would otherwise alert as log noise). Each request runs on its
own thread, but parallel matcher invocations are bounded by a
`threading.BoundedSemaphore(_CLASSIFY_CONCURRENCY)` in
`multileg_routes.py`. The cap was lowered 8→4→2→**1** to keep the
open-burst memory peak under the box ceiling (see "Memory limit"
below); excess requests queue up to a 30s wait, then return
`503` with `Retry-After` so the caller backs off. The batch caller
(`api/_lib/multileg-classify-batch.ts`) treats a 503/failure as
best-effort — the alert is still inserted, just without a multileg
structure label — so backpressure never wedges the cron.

Request-body size is capped at 50 MB; payloads above the cap
short-circuit to `413` before the body is read off the wire (DoS
floor, well clear of the ~3-4 MB a realistic 7500-trade payload
weighs in at). `Connection: close` is set on every 4xx/5xx so
Railway's edge proxy does not pool a broken upstream socket.

## Memory limit

The per-replica memory **ceiling** is NOT settable in `railway.toml`
(config-as-code only covers `build`/`deploy`). It lives on a separate
Railway surface. **Current recommendation: leave the 24 GB host ceiling
in place — do NOT set 8 GB.** The earlier 8 GB recommendation was
falsified on 2026-06-09 (live peak hit 28.88 GB on the old
concurrency-2 + 500K settings); an 8 GB ceiling would hard crash-loop
the box. The 2026-06-09 hotfix (concurrency 2→1, cross-join cap
500K→250K) should pull the peak well under 24 GB — re-measure
`MEMORY_USAGE_GB` on the new settings before setting any explicit
ceiling, and never set it below the observed open-window peak. Rationale
in `classifier/railway.toml`.

**Manual dashboard path** (only if a re-measured peak justifies an
explicit ceiling): Railway dashboard → project **Theta-Options** →
**Classifier** service → **Settings** tab → **Deploy** section →
**Replica Limits** → set **Memory** to a value safely above the observed
peak → the change applies on the next deploy. (Setting it too low
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
