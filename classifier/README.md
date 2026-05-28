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
python -m src.main
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

The server is `ThreadingHTTPServer` fronted by a
`threading.BoundedSemaphore(8)` cap on parallel matcher runs (sized
for a dedicated 24 GB box with no JVM competing). Requests above the
cap queue; if queue wait exceeds 30s, the server returns `503` with
`Retry-After: 5`.

## Deploy

Railway-only. Vercel does not host this service. The TypeScript caller
(`api/_lib/multileg-client.ts`) selects this service via the
`CLASSIFIER_URL` env var.

Full design rationale lives in
`docs/superpowers/specs/multileg-classifier-service-split-2026-05-28.md`.
