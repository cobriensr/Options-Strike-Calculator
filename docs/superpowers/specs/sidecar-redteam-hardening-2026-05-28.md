# Sidecar Red-Team Hardening — 2026-05-28

## Goal

Fix 21 source-verified findings from a 4-pass red-team review of the Railway
Python sidecar (Databento ingest, Theta Data, archive seed/query, multileg
classify HTTP server). Findings span silent data-loss, an unauthenticated
remote DoS, timezone/session-date errors, and reliability gaps. Every finding
below was independently re-verified against actual source (and the installed
Databento SDK) before this spec was written — verdicts are ACCURATE unless noted.

Verification was performed by 7 parallel read-only agents on 2026-05-28; their
line references and current-code snippets are the basis for each fix.

## Cross-cutting theme: CME session date

Three findings (#5 options stat `trade_date`, trade `trade_date`, front-month
grouping) are one conceptual gap: the code keys exchange data by **UTC or
local-clock calendar day** instead of the **CME session date**.

**Decision (user, 2026-05-28): CME 17:00 CT roll, DST-aware.**
ES/SPX Globex equity-index futures session runs ~17:00 CT (T-1) → 16:00 CT (T),
with the 16:00–17:00 CT maintenance halt. CME dates a session by its *close*:
the session opening Sunday 17:00 CT is **Monday's** trade date.

New module `sidecar/src/session_calendar.py`:

```python
def cme_session_date(ts_ns: int) -> date:
    """Map an exchange nanosecond timestamp to its CME trade date.

    Converts to America/Chicago (DST-aware); a timestamp at/after 17:00 CT
    belongs to the NEXT calendar day's session.
    """
```

SQL equivalent for DuckDB (`front_month.py`, where the bucket is SQL not Python):
`CAST((bars.<ts_col> AT TIME ZONE 'America/Chicago') + INTERVAL 7 HOUR AS DATE)`
(17:00 CT + 7h = next midnight ⇒ next day; DST handled by `AT TIME ZONE`).

**tzdata dependency:** `tzdata` is NOT in `sidecar/requirements.txt`. zoneinfo
works on macOS via system tz files, but Railway's slim image likely lacks them
→ `ZoneInfoNotFoundError` in prod. (`health.py:773` already uses
`ZoneInfo("America/Chicago")` — latent prod risk.) **Add `tzdata>=2024.1` to
requirements.txt** as part of Phase 1.

## Phases (each independently shippable; commit+push after each)

### Phase 1 — Foundation + CRITICAL server hardening
Files: `session_calendar.py` (new) + test, `requirements.txt`, `health.py`, `multileg_routes.py`, test_health/test_multileg_routes.
- **session_calendar.py** — `cme_session_date(ts_ns)` + tests (boundary cases: 16:59 CT, 17:00 CT, 09:00 CT, DST spring/fall, Sun-night→Mon). Add `tzdata>=2024.1`.
- **Finding 3 (CRITICAL):** `/takeit/multileg-classify` POST has NO auth and NO body-size cap; server binds `0.0.0.0` → unauthenticated remote OOM.
  - Add bearer auth mirroring `/takeit/explain` (env `TAKEIT_SIDECAR_SHARED_SECRET`), using `hmac.compare_digest` (the explain path uses raw `!=` — also upgrade explain to constant-time while here).
  - Add a Content-Length cap (default **1 MiB** = 1_048_576) on BOTH POST body reads (`health.py:372-380`, `397-405`) → 413 over cap, 400 on missing/≤0. Cap constant configurable via env `TAKEIT_MAX_BODY_BYTES`.
- **Finding (MEDIUM) archive 500s never reach Sentry** (`health.py:432` + all sibling archive 500 branches): add `capture_exception(...)` alongside the existing `log.error`, matching the `/health` DB-probe pattern.

### Phase 2 — Databento client CRITICALs
Files: `databento_client.py`, test_databento_client.
- **Finding 1 (CRITICAL):** `_on_reconnect(last_ts: int, new_start_ts: int)` is wrong — SDK passes two `pd.Timestamp` (verified: `ReconnectCallback = Callable[[pd.Timestamp, pd.Timestamp], None]`, `session.py:740-747`). `last_ts / 1e9` raises `TypeError`, swallowed by bare `except: gap_s = 0.0` → SIDE-011 gap alarm never fires.
  - Fix signature to `(gap_start: pd.Timestamp, gap_end: pd.Timestamp)`; compute `gap_s = max(0.0, (gap_end - gap_start).total_seconds())`. REMOVE the bare-except mask (or narrow it and `capture_exception` so a future signature drift is loud, not silent). Add a test asserting the SIDE-011 warning fires for a >threshold gap using real `pd.Timestamp`s.
- **Finding 2 (CRITICAL):** definitions subscribed `start=0` (snapshot) on initial connect; SDK resubscribes on reconnect with `start=None` and no snapshot → `_option_definitions` never re-seeded → every ES option trade post-reconnect hits the silent definition-lag drop path.
  - Re-seed definitions on reconnect: in `_on_reconnect`, re-issue the definition subscribe with the snapshot (or pass `snapshot=True` on the initial subscribe so the SDK replays it on reconnect — verify against SDK that stored `snapshot` is honored on resubscribe: `session.py:714-722` preserves `snapshot=bool(sub.snapshot)`). Prefer `snapshot=True` if the SDK replays it; otherwise explicit resubscribe in `_on_reconnect`. Add a test.

### Phase 3 — Timezone consumers + strike filter
Files: `options_router.py`, `trade_processor.py`, `front_month.py`, their tests.
- **Finding 5:** `options_router.py:253` `trade_date = date.today()` → use `cme_session_date(record.ts_event)` (Statistics records carry `ts_event`; mirror the `expiry` UTC-from-ns pattern at line 149).
- **trade `trade_date`:** `trade_processor.py:98-99` `ts_dt.date()` (UTC day) → `cme_session_date(ts_ns)`.
- **Finding A (front-month):** `front_month.py:157,162` UTC `date_trunc('day', ...)` → CME-session-date SQL expression above. Verify DuckDB ICU/`AT TIME ZONE` is available (archive_query already relies on it).
- **Finding 4:** `options_router.py:209` `if strike not in self.options_strikes.strikes:` — float (`float(strike_raw)/1e9`) vs int set, exact-equality; float-noise / non-5pt strikes silently dropped, NO counter.
  - Match with a tolerance (round to nearest `ES_STRIKE_SPACING` or compare with `abs(diff) < 0.5`), and add a `window_filter_drops` counter + throttled summary log mirroring `definition_lag_drops`.

### Phase 4 — Reliability: writer / processor / main
Files: `batched_writer.py`, `trade_processor.py`, `main.py`, their tests.
- **Finding A (batched_writer:85):** buffer swapped to `[]` before `_write`; on write failure the in-flight batch (100 rows) is lost, never re-queued.
  - Add a bounded retry/re-queue: on `_write` failure, re-prepend rows to the buffer (bounded by a max-buffer cap to avoid unbounded growth on persistent failure) OR pass failure back so the subclass decides. Keep the lock-then-write-outside-lock invariant. Make behavior explicit + tested.
- **Finding B (trade_processor:146):** `_write` catches `Exception` → `log.error` only, no Sentry. Add `capture_exception` (import sentry_setup, lazy/guarded like db.py) so trade-tick loss is visible. Same for quote_processor if it shares the gap (check).
- **Finding C (main:178):** backoff resets to `1.0` after ANY clean `block_for_close()` return → ~1s reconnect storm on a flapping session. Only reset backoff if the session lasted a meaningful duration (e.g. ≥60s uptime); otherwise keep escalating. Add a test.
- **Finding D (main:47):** shutdown never flushes/joins the writer — `trade_processor`/`quote_processor` aren't module globals, so SIGTERM kills the daemon flush thread with rows buffered. Expose the processors (module-level refs or a registry) and `flush()`+stop them in `shutdown()` BEFORE `drain_pool()`. Add a test.

### Phase 5 — Theta
Files: `theta_launcher.py`, `theta_client.py`, their tests.
- **Finding A (theta_launcher:211):** NOTE refinement — `poll()` DOES reap the child (not a true OS zombie). Real leak = drain-thread + FD churn: each `_spawn_subprocess()` spawns two fresh daemon drain threads and never closes the old proc's pipes/joins old threads. Fix: on respawn, close old `proc.stdout/stderr`, signal/join old drain threads (track them in `_LauncherState`), then spawn new.
- **Finding B (theta_launcher:337):** restart-not-ready only `log.warning`s; `is_running()` still True → "running but not ingesting" zombie. Fix: on not-ready, kill the proc and `capture_exception`/`capture_message` to Sentry so `is_running()` reflects reality.
- **Finding C (theta_client:289):** `zip(fmt, row, strict=False)` silently truncates on column add/remove. Change to `strict=True` and raise a clear `ThetaClientError` on mismatch (catch the `ValueError`).
- **Finding D (theta_client:180):** only 472 + 5xx retry. Add **429** and **476** (MDDS transient) to the retry set (with backoff), keeping 472 as the immediate subscription error. Add tests.

### Phase 6 — Archive
Files: `archive_seeder.py`, `archive_query.py`, their tests.
- **Finding A (archive_seeder:213, SSRF):** `blob_url` from manifest → `urlopen` with bearer token, no allowlist. Add a scheme+host allowlist: require `https://`, reject `file://`/`http://`, reject link-local/metadata hosts (169.254.0.0/16, etc.). Derive allowed host(s) from `ARCHIVE_MANIFEST_URL`'s host (or a configured allowlist) so the token is only ever sent to the blob host. Add tests (file://, metadata IP, wrong host → rejected).
- **Finding B (archive_seeder:137):** not byte-resumable; large parts can never finish under 60s `REQUEST_TIMEOUT_S`. Two parts: (1) fix the misleading docstring (resume is whole-file SHA-skip only); (2) raise/parameterize the timeout for large parts OR implement HTTP Range resume. Minimum: docstring honesty + a larger/size-scaled timeout so big Parquet parts can complete. (Range resume preferred if Blob supports it — verify.)
- **Finding C (archive_query:114):** DuckDB `/tmp/duckdb` spill unbounded. Add `SET max_temp_directory_size = '<cap>'` (e.g. '2GB') alongside the existing `memory_limit`/`temp_directory`. Add a test asserting the PRAGMA/SET is issued.

### Phase 7 — Multileg (VENDORED) + remaining MEDIUMs
Files: `ml/src/multileg_assembler.py`, `ml/src/multileg_patterns.py` (+ re-vendor to `sidecar/_vendored_ml/` via `make sync-ml`), `sidecar/src/multileg_routes.py`, `symbol_manager.py`, `db.py`, tests in BOTH ml/ and sidecar/.
- **Decision (user, 2026-05-28): FULL multileg fix.**
- **Finding B (assembler:367):** NBBO-absent → all sides `"mid"` → `_dir_opposite_expr` (risk_reversal) and `_dir_same_expr` (strangle) BOTH short-circuit True via the `(side=="mid")` term → a call+put pair matches both; butterfly direction guards also collapse → phantom butterflies.
  - Stop the double-match: when sides are `"mid"` (direction unknown), a pair must NOT satisfy both same- and opposite-direction patterns. Use the now-computed net debit/credit sign to disambiguate where possible; when still ambiguous, pick the canonical pattern and lower its confidence (do not emit both). Tighten butterfly direction guards so `"mid"` doesn't auto-pass.
- **Finding C (routes:96 + assembler):** `premium` is a required input but entirely unused; `price` only feeds side classification — no net debit/credit sign anywhere.
  - Compute `net_debit_credit = Σ leg_premium * sign(buy=+1, sell=-1)` per assembled multileg; expose it as an output field; incorporate into confidence/scoring and into the Finding-B disambiguation. Update `multileg_routes.py` response shape + its test.
  - **Sync constraint:** edit `ml/src/` first, run `cd sidecar && make sync-ml`, ensure `test_vendored_ml_sync.py` (sha256 byte-equality) passes, run ml/ tests too. Commit ml/ and sidecar/ together.
- **Finding D (symbol_manager:90):** recenter threshold 50 == window half-width (±10 strikes × 5) → no hysteresis, thrash at the 50-pt boundary. Fix so the subscribed window always contains current price with ≥10-pt margin (e.g. widen window beyond the trigger, or two-band hysteresis). Success criterion (test): price chopping ±2 pts across the exact trigger boundary causes ≤1 recenter; current price always inside subscribed strikes.
- **Finding E (db.py:189):** `/health` probe shares the 5-conn pool → spurious 503s under ingest burst → Railway restarts a healthy container. Fix: `is_db_healthy()` borrows with a short timeout (e.g. 2.0s) and treats `PoolTimeoutError` (saturation) as **alive-but-busy → return True** (log/Sentry-warn), reserving `False` for real connection/query errors. Add a test.

## Verification per phase
`cd sidecar && .venv/bin/python -m ruff check src/ tests/` + `.venv/bin/python -m pytest` (or `make review`).
For Phase 7 also run ml/ tests and `make sync-ml` byte-equality check. Then code-reviewer subagent → fix → commit+push.

## Open questions / defaults taken
- Body-size cap default 1 MiB (env-overridable). 
- batched_writer re-queue is bounded (cap) to avoid OOM on persistent DB failure.
- Archive Range-resume only if Blob supports it; else timeout bump + docstring fix.
- symbol_manager: prefer widen-window (keeps recenter frequency constant) over lowering trigger.
