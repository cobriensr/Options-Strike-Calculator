# Nightly Pipeline Resilience Hardening — 2026-05-29

## Goal

Make `make nightly update` survive transient external failures (UW REST
403/429/5xx, Neon Postgres blips, Vercel Blob / Cloudflare R2 hiccups, curl
network errors) by adding bounded exponential-backoff retries on every external
call and isolating per-date failures so one transient blip can't poison the
whole batch or skip the closing pass.

Trigger: 2026-05-29 nightly run aborted at STEP 4/5 when `backfill_net_flow_history.py`
got a uniform `403 Forbidden` burst from UW across all 73 tickers (1.3s). A live
re-probe returned `200` — the key/endpoint were fine; it was a momentary UW edge
rejection. The script only retried `429`/`URLError`, so a 403 wiped the whole step
and `make` aborted the night.

## Scope decisions (confirmed with user 2026-05-29)

- **Transient-resilience core**: retry on ALL external calls + fix Makefile
  per-date loop isolation. NO changes to success/exit semantics (a fully-failed
  step still exits non-zero; we only add retries before that point and isolate
  the multi-date loop).
- **Failure policy = isolate + continue, report at end**: a date that fully
  fails after retries is logged and skipped; remaining dates AND the closing
  pass (rollup + plots) still run. End-of-run summary lists failed dates; the
  loop exits non-zero so the failure is visible, but only AFTER the closing pass.
- **Out of scope** (explicitly deferred — not "core"): Sentry hooks on scripts,
  atomic JSON writes for `lottery_score_weights.json`, changing stdout-only
  regression checks to exit non-zero. Noted here so the next session sees they
  were considered and parked.

## Retry policy (shared constants)

- HTTP: retry on status ∈ {403, 429, 500, 502, 503, 504} and on transport
  exceptions (connection reset, timeout, DNS). 403 is included because the
  observed failure was a transient UW edge 403, not an auth problem — a real
  auth failure will simply exhaust retries and still fail loud.
- DB: retry on `psycopg2.OperationalError` and `psycopg2.InterfaceError`
  ("server closed the connection unexpectedly") — the Neon-blip signatures.
- Backoff: 6 attempts, delays 1, 2, 4, 8, 16, 32s (cap 60s). Matches the
  existing `fetch_ticker` cadence so behavior is familiar.

## Phases

### Phase 1 — Shared retry helper + UW REST fix (the reported bug)

Files:

- CREATE `scripts/_pipeline_retry.py` — transport-agnostic helpers:
  - `RETRYABLE_HTTP_STATUS` frozenset
  - `retry_call(fn, *, attempts, base_delay, max_delay, retryable, label, sleep)`
    generic backoff loop (sleep injectable for tests)
  - `is_retryable_http_status(code)`, `is_retryable_db_error(exc)`
  - `connect_with_retry(dsn, **connect_kwargs)` for psycopg2
- CREATE `scripts/__tests__/test_pipeline_retry.py` (or `ml/tests/`) — pure
  unit tests for backoff sequence, predicate sets, exhaustion behavior.
- MODIFY `scripts/backfill_net_flow_history.py` — `fetch_ticker` retries
  403/5xx (currently only 429/URLError). Use the shared predicate.

### Phase 2 — Blob / R2 / curl (the other network calls)

Files:

- MODIFY `scripts/ingest-flow.py` — wrap the single-shot PUT + all 3 multipart
  POSTs in `retry_call`, catching `requests` 5xx/429 + `ConnectionError`/`Timeout`/
  `ChunkedEncodingError`. Preserve the CSV-deletion-only-after-clean-upload guard.
- MODIFY `scripts/upload-fulltape-to-r2.py` — add botocore
  `Config(retries={"max_attempts": 5, "mode": "adaptive"})`; broaden the upload
  except from `ClientError` to `(ClientError, BotoCoreError)`; wrap
  `list_objects_v2` in retry.
- MODIFY `scripts/download-fulltape.sh` — add
  `curl --retry 5 --retry-delay 5 --retry-max-time 120 --retry-connrefused`
  (native curl retry covers 429 + 5xx + transport). Keep the distinct exit codes.

### Phase 3 — Neon DB connect retry + Makefile loop isolation

Files:

- MODIFY `ml/src/utils/__init__.py` — `get_connection` retries transient
  connect errors before its existing `sys.exit(1)` (covers `takeit_drift_monitor.py`,
  `lottery_scoring.py`). No semantic change on permanent failure.
- MODIFY the four hand-rolled connectors to use `connect_with_retry`:
  `enrich_lottery_outcomes.py`, `enrich_silent_boom_outcomes.py`,
  `online_ticker_update.py`, `backfill_lottery_scores.py`. (Also fixes the
  `os.environ['DATABASE_URL']` KeyError in enrich_silent_boom — clean exit.)
- MODIFY `Makefile` — per-date loop in `nightly` collects failures instead of
  aborting: a failed `nightly-one DATE=$$d` is recorded, the loop continues, the
  closing pass (rollup + plots) runs unconditionally, then a summary prints and
  the target exits non-zero iff any date failed. Mirror the existing Full-Tape
  `|| echo` soft-fail idiom but with end-of-run aggregation.

## Data dependencies

None new. No tables, migrations, or env vars. Pure resilience wrapping.

## Open questions

- Mid-run DB read retry (vs. connect-only): wrapping every internal `cur.execute`
  is invasive and risks behavior change. Core scope = connect retry + the few
  top-level single-shot SELECT reads. Per-statement read retry deferred.

## Thresholds / constants

- HTTP retryable: {403, 429, 500, 502, 503, 504}
- DB retryable: OperationalError, InterfaceError
- Backoff: attempts=6, delays 1/2/4/8/16/32s, cap=60s
- curl: --retry 5 --retry-delay 5 --retry-max-time 120
- boto: max_attempts=5, mode=adaptive
