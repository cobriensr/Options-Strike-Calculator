# classifier

> **Scheduled for retirement (approved 2026-10-28), still running.** The
> exchange's own multi-leg flag (`trade_code` on `ws_option_trades`) will
> replace this service. See
> [the replacement design](../docs/superpowers/specs/2026-10-28-classifier-replacement-design.md).
> Until that ships, the detect crons still call it.

Standalone Railway service that runs the polars-based multileg classifier
behind a small HTTP server. Carved out of `sidecar/` in 2026-05, when the
sidecar also ran the Java Theta Data Terminal and Databento ingestion, so
polars no longer competed with them for memory. Both have since been
removed from the sidecar.

The matcher's source of truth is `ml/src/multileg_assembler.py` and
`ml/src/multileg_patterns.py`. Edit them there, then copy them into
`classifier/_vendored_ml/` by hand and commit both.
`tests/test_vendored_ml_sync.py` fails CI on any byte difference. Both
CI's path filter and Railway's `watchPatterns` include
`ml/src/multileg_*.py`, so a matcher edit re-runs the classifier gate and
redeploys the service.

## Environment variables

| Variable                      | Required       | Default              | Notes                                                                                      |
| ----------------------------- | -------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `CLASSIFIER_SHARED_SECRET`    | yes            | none                 | Bearer token for `/multileg-classify` and `/version`. Same value as Vercel's.              |
| `SENTRY_DSN`                  | optional       | empty                | Empty disables Sentry. Events carry `server_name=classifier` and tag `service=classifier`. |
| `PORT`                        | optional       | `8080`               | Railway sets this; bind `0.0.0.0:$PORT`.                                                   |
| `POLARS_MAX_THREADS`          | optional       | `2` (Dockerfile)     | Caps polars threads, and so the peak-memory multiplier. Read once, at import.              |
| `POLARS_STREAMING_CHUNK_SIZE` | optional       | `50000` (Dockerfile) | Streaming-engine morsel size.                                                              |
| `RAILWAY_DEPLOYMENT_ID`       | set by Railway | `local`              | Reported as `release` by `/version` and Sentry.                                            |
| `RAILWAY_ENVIRONMENT`         | set by Railway | `production`         | Sentry environment.                                                                        |

Generate `CLASSIFIER_SHARED_SECRET` from at least 32 random bytes (e.g. `openssl rand -hex 32`): the repo is public and the endpoint is reachable from the internet.

## Local development

```bash
cd classifier
python -m venv .venv
source .venv/bin/activate                         # Windows (Git Bash): source .venv/Scripts/activate
pip install -r requirements-dev.txt               # runtime deps + pytest/ruff; the image installs requirements.txt only
export CLASSIFIER_SHARED_SECRET=dev-only-secret   # without it the auth routes return 503
PYTHONPATH=src:_vendored_ml python -m main        # Windows: PYTHONPATH='src;_vendored_ml' python -m main
```

Python splits `PYTHONPATH` on `;` on Windows, so the colon form there
puts one bogus entry on `sys.path`.

## Running tests

```bash
cd classifier
# What CI's Classifier Quality Gate runs on Python 3.12 (check-only: format drift fails it)
pytest tests/test_vendored_ml_sync.py --no-cov
ruff check src/ tests/ conftest.py
ruff format --check src/ tests/ conftest.py
pytest
```

Coverage gate (`--cov-fail-under=95`, branch coverage) is enforced by
`pyproject.toml` `addopts`, so a plain `pytest` invocation fails CI if
coverage drops below the spec floor.

## Architecture

Listens on `0.0.0.0:$PORT` (default 8080) with three routes:

- `POST /multileg-classify` — runs the polars matcher on the posted
  trade window and returns per-trade classifications.
- `GET /version` — matcher sha, release and pattern list; the TS client
  probes it once per process to detect cross-deploy drift.
- `GET /health` — liveness probe (used by the Docker `HEALTHCHECK` and
  the Railway healthcheck). No auth.

### Auth

`/multileg-classify` and `/version` require
`Authorization: Bearer <CLASSIFIER_SHARED_SECRET>`. The secret is read
from the environment on each request and compared as bytes with
`hmac.compare_digest`. The check runs before the framing checks, body
buffering and the matcher.

On a rejected `POST`, a single valid `Content-Length` of at most 8 MiB
(`_AUTH_FAIL_DRAIN_MAX`, about 2x a 10,000-trade window) is read and
discarded in 64 KiB chunks before the response goes out. Closing with
the body unread resets the connection, and a client still uploading
would see a network error instead of the 401. Chunked, missing,
invalid, duplicate or larger lengths are answered without reading.

- Header missing or wrong → `401 {"error": "unauthorized"}`.
- Secret unset or blank → `503` with
  `{"error": "CLASSIFIER_SHARED_SECRET not configured"}`, plus one
  `classifier.auth.secret_missing` Sentry event per process. `/health`
  stays `200`, so the deploy still boots.

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
floor, well clear of a 10,000-trade window, the client's cap, which
the server sizes at about 3-4 MB). `Connection: close` is set on every
4xx/5xx so Railway's edge proxy does not pool a broken upstream socket.

## Memory limit

Root cause identified 2026-09-08: the uncapped butterfly enumeration
stage, now gated by `_BUTTERFLY_PAIR_CAP` (400,000 body×wing pairs,
`ml/src/multileg_assembler.py`).

The per-replica memory **ceiling** is NOT settable in `railway.toml`
(config-as-code only covers `build`/`deploy`). It lives on a separate
Railway surface. **Current recommendation: leave the 24 GB host ceiling
in place — do NOT set 8 GB.** The earlier 8 GB recommendation was
falsified on 2026-06-09 (live peak hit 28.88 GB on the old
concurrency-2 + 500K settings); an 8 GB ceiling would hard crash-loop
the box.

In-process bounds now: classify concurrency 1, cross-join cap 250K
pairs, butterfly cap 400K pairs, a 500K-row per-ticker overload skip,
and `POLARS_MAX_THREADS=2`. Even so, the service still OOM-restarts: the
replacement spec records 2 replicas × 24 GB and 55 OOM restarts in the
30 days to 2026-10-28. Re-measure `MEMORY_USAGE_GB` before setting any
explicit ceiling, and never set it below the observed open-window peak.
Rationale in `classifier/railway.toml`.

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
`CLASSIFIER_URL` env var and sends `CLASSIFIER_SHARED_SECRET` as the
bearer. Set the secret on both Vercel and this Railway service. If
`CLASSIFIER_URL` or `CLASSIFIER_SHARED_SECRET` is unset on Vercel, the
client skips the call: it raises `config_missing` and emits a throttled
`multileg.classify.config_missing` Sentry event, and the alert is
inserted with NULL multileg columns.

Full design rationale lives in
`docs/superpowers/specs/multileg-classifier-service-split-2026-05-28.md`.
