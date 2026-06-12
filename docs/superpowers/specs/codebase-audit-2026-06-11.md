# Full Codebase Audit — 2026-06-11

**Scope:** entire repository — `api/` (endpoints + `_lib`), `api/cron/` (78 handlers),
security (auth/validation/CSP/CI/deps), `src/` (components, hooks, utils),
`sidecar/`, `uw-stream/`, `ml/`, `scripts/`, and build/CI/config infrastructure.

**Method:** eight parallel read-only audit agents, each covering one slice, every
finding quote-verified against actual source (several verified at runtime, e.g. the
pandas `shift(1)` leak reproduced on the actual `ml/.venv`). High-precision policy:
speculative findings were rejected; six false claims from sub-auditors were
explicitly verified and discarded (listed at the bottom).

**Status legend:** unchecked = open. Check the box when fixed, add the commit SHA.

---

## Executive summary

The production TypeScript app (`api/` + `src/`) is in unusually good shape — the
historical bug classes (NUMERIC-as-string, DATE-as-Date, transient Neon, silent
cron failures, `.js`-extension ESM crashes) have been systematically engineered
around there. The serious problems cluster in three places the hardening sweeps
never reached:

1. **ML research code** — three genuine look-ahead/leakage bugs that invalidate
   specific results (Setup 6 backtest, VIX overlay features, takeit training set).
2. **Backfill scripts** — the local-vs-UTC trading-days bug survives in 18 copies
   despite being fixed three separate times; plus rate-limit/resume designs that
   convert transient failures into permanent data holes.
3. **Silent-death ops paths** — uw-stream can die with exit 0 (no Sentry, no
   restart); one cron is silently skipped all winter with a green monitor.

| Severity | Count |
| -------- | ----- |
| Critical | 4     |
| High     | 10    |
| Medium   | ~35   |
| Low      | ~30   |

---

## CRITICAL — data correctness / invalid results

### [x] AUD-C1 — Setup 6 CVD divergence reads full-day (future) order flow `34846197`

**File:** `ml/src/setups_backtest/evaluators/setup_6_cvd_divergence.py:106-127`

```python
cvd_series = features.cvd_series(es_tbbo, session_start)  # comment claims "up to now"
cvd_at_now = float(cvd_series.iloc[-1])
cvd_peak_ts = cvd_series.idxmax()
```

`features.cvd_series()` only applies a lower bound; `es_tbbo` is the full UTC day.
At decision minute `now`, `iloc[-1]` is **end-of-day** CVD and the peak is the
whole-day max — including hours after `now`. The divergence condition degenerates
to "final CVD < day max" (near-constant), consistent with the observed 856-signal
over-firing. The reported −$35K result is invalid in both directions.

**Fix:** slice `es_tbbo[es_tbbo["minute"] < now]` before computing CVD. Setup 6b
already does this correctly via `end_ts` — copy its pattern. Re-run the backtest.

### [x] AUD-C2 — VIX overlay assigns same-day close to intraday bars `34846197`

**File:** `ml/src/options_features/overlay.py:99-108`

Docstring promises "prior-day close carried forward", but there is no `shift(1)` —
a 09:31 ET bar on day D receives day D's 16:15 ET close. Every backtest consuming
`options_features_for_bars()` gets a feature unknowable until session end;
`vx_ratio` inherits the leak.

**Fix:** `shift(1)` after building the continuous calendar, then ffill. Pin with a
test. Re-run anything that consumed the overlay.

### [x] AUD-C3 — takeit training feature has cross-ticker + future leakage (runtime-verified) `34846197`

**File:** `ml/src/takeit/build_training_set.py:543-549`

```python
daily.groupby("underlying_symbol")["_daily_win_rate"].expanding().mean()
    .shift(1).reset_index(level=0, drop=True)
```

`.shift(1)` runs on the concatenated multi-group Series, not per group — verified
on the actual pandas 3.0.2 venv. Ticker B's first date inherits ticker A's full
history mean, including dates _later_ than B's row → future, wrong-ticker
information in `prior_session_win_rate_same_ticker` (~80 ticker-dates affected;
the parity fixture embeds the contaminated values).

**Fix:** shift per group (`.groupby(...)[col].shift(1)` on the expanded series),
regenerate parquets, update the parity fixture, **retrain takeit**.

### [x] AUD-C4 — local-vs-UTC `getTradingDays` bug copy-pasted into 18 backfill scripts `0b24f9b8`

**Files:** `scripts/backfill-{darkpool,etf-tide,flow-ratio,gex-0dte,greek-exposure,greek-exposure-strike,greek-flow,iv-monitor,local,netflow,nope,oi-change,oi-per-strike,spot-gex,strike-all,strike-exposure,vol-surface,zero-dte-flow}.mjs`

```js
const today = d.getDay(); // LOCAL weekday
dates.push(d.toISOString().slice(0, 10)); // UTC date string
```

The bug is documented as already-bitten-and-fixed in
`scripts/backfill-net-prem-ticks.mjs:163-168` ("pushed Saturday-labeled strings
for Friday data, silently missing Mondays"), yet the broken original survives in
18 scripts. Run from CT after ~6-7 PM → wrong dates fetched, Mondays silently
dropped. This has been independently fixed **three times** (net-prem-ticks,
strike-exposure-lottery, spx-candles-1m) while the copies stay broken.

**Fix:** extract the CT-anchored `Intl.DateTimeFormat('en-CA', {timeZone:
'America/Chicago'})` version into one shared `scripts/_lib/trading-days.mjs`
helper and import it from all 18 + the 3 already-correct scripts.

---

## HIGH

### [x] AUD-H1 — uw-stream: unexpected task death exits 0 — no Sentry, no restart `8d01b307`

**File:** `uw-stream/src/main.py:288-313, 397-400`

If the router task, a handler drain task, or the health server dies with an
unexpected exception, `asyncio.wait(FIRST_COMPLETED)` treats it exactly like a
SIGTERM: graceful shutdown → **exit 0**. The exception is never retrieved
(`_describe_done` logs only the task name; the later
`gather(..., return_exceptions=True)` swallows it). With
`restartPolicyType = "ON_FAILURE"`, exit 0 means Railway does NOT restart. Same
failure class as the 2026-06-09 lease incident, which was fixed _only_ for the
renewal task.

**Fix:** after the wait, for any completed task other than `done_task`, call
`t.exception()`; if non-None, `capture_exception(...)` and raise `SystemExit(1)`
after `_shutdown` (mirror the `lease_lost` flag). Land with a test that a
non-`done_task` exception → non-zero exit + Sentry capture. ~10 lines.

### [x] AUD-H2 — uw-stream: lease acquire-timeout crash loop is Sentry-silent `8d01b307`

**File:** `uw-stream/src/main.py:161-178` + `uw-stream/railway.toml:7-8`

The acquire-timeout path raises `SystemExit(1)`, which is a `BaseException` and
bypasses `main()`'s `except Exception → capture_exception`. With
`restartPolicyMaxRetries = 10`, a wedged prior generation holding the lease
produces 10 silent boot→timeout→exit cycles (~10 min), then a dead daemon —
Lottery + Silent Boom frozen — with **zero Sentry events on the path**.

**Fix:** `capture_message("uw-stream ws lease acquire timed out — exiting",
level="error")` immediately before the `raise SystemExit(1)`. Consider a Sentry
uptime monitor on `/healthz` for the exhausted-retries terminal state (no
in-process fix can cover it).

### [x] AUD-H3 — cron `fetch-greek-exposure-strike` silently skipped every trading day in EST `8d01b307 / a40e69c0`

**File:** `api/cron/fetch-greek-exposure-strike.ts:219` + `vercel.json` schedule `30 13 * * 1-5`

The wrapper call passes no options → default `isMarketHours()` gate (opens 9:25
ET). The only slot, 13:30 UTC, is 9:30 ET in EDT (runs) but **8:30 ET in EST →
gated, skipped** — and the skip sends an intentional-skip `ok` check-in to
Sentry, so the monitor stays green while `greek_exposure_strike` gets zero rows
all winter.

**Fix:** dual schedule `30 13,14 * * 1-5` + a once-per-day dedupe or custom
`timeCheck`, matching the established pattern (`compute-es-overnight`,
`fetch-economic-calendar`, `fetch-outcomes`).

### [x] AUD-H4 — `api/analyze.ts` refusal path crashes after NDJSON stream started `d2c72194`

**File:** `api/analyze.ts:272-277`

Headers flush with the first keepalive ping (lines 204-213) long before Opus
returns. The refusal branch then calls `res.status(422).json()` →
`ERR_HTTP_HEADERS_SENT` → outer catch: (1) client gets the raw headers-sent error
text instead of the refusal, (2) `done()` records twice (422 then 500 — no
once-latch in this file, unlike `withDbReader`), (3) spurious
`Sentry.captureException` for a handled model refusal.

**Fix:** mirror the empty/corruption path at lines 369-371:
`done({ status: 422 }); res.write(JSON.stringify({ error }) + '\n'); return res.end();`
and add a once-latch around `done`.

### [x] AUD-H5 — `npm run audit` gate is RED and CI doesn't run it `fe06cbf0`

**Files:** `audit-ci.jsonc`, `package.json`, `.github/workflows/ci.yml:86`

`npx audit-ci --config audit-ci.jsonc` fails today on two unallowlisted `thrift`
HIGH advisories (GHSA-526f-jxpj-jmg2, GHSA-r67j-r569-jrwp; transitive of
`@dsnp/parquetjs` used in `api/_lib/gexbot-parquet.ts`, no fix available). CI runs
the weaker `npm audit --audit-level=critical`, so CI stays green while the
project's own moderate-level gate has silently rotted.

**Fix:** (a) triage thrift — `gexbot-parquet.ts` parses owner-generated archive
files, so an allowlist entry with written justification is defensible, or swap to
a thrift-free parquet reader (e.g. `hyparquet`); (b) change the CI step to
`npm run audit` so the allowlisted gate is what CI enforces.

### [x] AUD-H6 — frontend: panelMap memo barrier structurally defeated — full panel re-render every 5s `986f2f61`

**Files:** `src/App.tsx:768-1435` (panelMap), `src/components/PanelRouter.tsx:46`, `src/hooks/useMarketData.ts:232,466`

`panelMap`'s ~77 deps include whole hook-return objects (`market`, `darkPool`,
`periscope`, `gexTarget`) that are fresh literals every render — `useMarketData`,
`useDarkPoolLevels`, `useGexTarget`, `usePeriscopeExposure` return plain object
literals with no `useMemo`. Any App re-render → new identities → panelMap
rebuilds → `PanelRouter`'s `memo()` fails → all ~30 mounted panels re-render
(GexTarget SVG PriceChart, GexLandscape, GreekHeatmap, charts…). And App
re-renders constantly: `STALENESS_TICK_MS = 5_000` ticks pre-market through
after-hours, plus a 15s session tick, polls, and every input keystroke. The
77-dep `useMemo` is pure overhead.

**Fix:** memoize the return objects of those four hooks (cheapest high-leverage
move — the existing barrier then actually holds). Note `AppHeader`,
`IVInputSection`, `MarketRegimeSection` also take the whole `market` object and
can't be memoized until this lands.

### [x] AUD-H7 — `backfill-darkpool.mjs` string-concatenation corruption of `total_shares` `a35aee75`

**File:** `scripts/backfill-darkpool.mjs:155`

`existing.totalShares += trade.size;` — UW returns `size` as a string (the
sibling script parses it). `0 + "100" + "200"` → `"0100200"`, which still parses
as numeric on INSERT → silent plausible-looking corruption.

**Fix:** `Number(trade.size)` at ingestion. Audit existing `total_shares` rows
written by this script for the concat signature (values with improbable leading
digit patterns / magnitudes).

### [x] AUD-H8 — `backfill-greek-flow-ticker.mjs`: rate-limit breach + resume design creates permanent holes `f8f4d503`

**File:** `scripts/backfill-greek-flow-ticker.mjs:41, 330, 335`

3 workers × ~125ms sleep ≈ 24 req/s vs UW's 120/min cap; the second 429 throws →
date skipped; MAX(ts)-based resume then **permanently skips the hole** on every
re-run. Transient 429s become unrecoverable data gaps.

**Fix:** honor the cap (global limiter across workers), retry 429s with backoff,
and make resume hole-aware (per-date completeness check, not MAX(ts)).

### [x] AUD-H9 — setups harness never checks stop/target on the entry bar `331c463a`

**File:** `ml/src/setups_backtest/harness.py:385-386` (related: `:207-210`)

Entry fills at T+1 open but `_simulate_exit` walks from T+2 — the entry bar's
high/low is never examined. For tight-stop setups (5, 6, 6b) entry-minute
stop-outs are common → losses understated. Related: empty `exit_bars` returns
`stop_price` as exit → fabricated ~−1R loss with `exit_ts` before `entry_ts`.

**Fix:** include the entry bar in the exit walk (entry price = open, check H/L of
that same bar); guard the empty-exit-bars case explicitly.

### [x] AUD-H10 — backtest baselines replay Claude's win/loss stream `3aad18ee`

**File:** `ml/src/backtest.py:125-139, 567-572`

`simulate_strategy` overrides the structure label for the "Majority Class (CCS)"
baseline but the win flag is still `row["structure_correct"]` — whether _Claude's_
structure was correct. The baseline P&L is exactly 2× EqualSize on the identical
win stream, so "structure selection not adding value" measures only sizing.

**Fix:** derive counterfactual wins from settlement vs strikes for the baseline
structure, or relabel the comparison as sizing-only.

---

## MEDIUM

### Backend — `api/` (non-cron)

- [x] **AUD-M1** `e4f9881a` `api/history.ts:147-171, 285-290` — partially-failed Schwab fetch
      cached in Redis for **90 days**. Cache-write gate only checks
      `spx.candles.length`; if `$VIX1D` fails transiently while `$SPX` succeeds, a
      past-date response with permanently empty VIX panels is cached and served
      forever. Log-only, no Sentry. _Fix:_ gate the long-TTL write on all five
      symbols ok; Sentry breadcrumb on per-symbol failure.
- [x] **AUD-M2** `e4f9881a` `api/events.ts:337-341, 527-531` — FRED HTTP errors degrade to
      `[]` and the degraded list is cached for the rest of the day (date-scoped key).
      A FRED blip at first fetch on CPI morning = Claude analyzes all day without the
      CPI flag. _Fix:_ don't cache (or short-TTL) when any source errored; Sentry
      warning on FRED non-OK.
- [x] **AUD-M3** `e4f9881a` `api/_lib/embeddings.ts:238-255, 300` — Neon DATE-as-Date: raw
      `a.date` interpolated into the Claude prompt → emits
      `[Wed Jun 11 2026 00:00:00 GMT+0000 (Coordinated Universal Time)]` per analog
      row. Same in `findSimilarLessons` (`source_date`, ~:104-109). _Fix:_
      `TO_CHAR(..., 'YYYY-MM-DD')` like the sibling queries already do.
- [x] **AUD-M4** `e4f9881a` `api/analyses.ts:32-36` — `spx`/`vix`/`vix1d` are DECIMAL → Neon
      returns strings; cast `as number` is a lie. Same bug class that corrupted
      `peak_ceiling_pct` for 5 weeks; currently latent. _Fix:_ `::float8` in SQL or
      `Number()` in `parseRow`.
- [x] **AUD-M5** `e4f9881a` `api/_lib/analyze-context.ts:192-229, 557-605` — sequential
      awaits over independent fetches in the hottest endpoint: `main` / `ivTerm` /
      `volRealized` / `preMarket` are independent (only `candles` needs `preMarket`),
      and the tail (`getActiveLessons` → `getHistoricalWinRate` → embedding +
      `findSimilarAnalyses`) is three sequential awaits with no interdependency
      (~500ms OpenAI call alone). Several seconds of avoidable pre-Opus latency.
      _Fix:_ two `Promise.all` groups; pay the test-mock reorder.
- [x] **AUD-M6** `e4f9881a` `api/positions.ts:133-141` — snapshot-id lookup outside the
      `try` defeats the documented "DB write is incidental" contract: a transient
      Neon failure on an optional FK lookup 500s the whole position read (CSV path
      surfaces it as a misleading `'Failed to parse CSV'`). _Fix:_ move inside the
      try / `safeDb(..., [])` so `snapshotId` degrades to null.

### Crons — `api/cron/`

- [ ] **AUD-M7** _(DEFERRED — bundle of many sub-items; schedule as its own focused session per 2026-06-11 decision)_ — Per-row awaited INSERT/UPDATE loops despite `bulk-upsert.ts`
      existing (staged as Phase 3b of `docs/superpowers/specs/api-refactor-2026-05-02.md`,
      never adopted). Offenders: `fetch-etf-tide:110-123`, `fetch-net-flow:140-160`,
      `fetch-greek-flow:91-122`, `fetch-greek-exposure:117-145`,
      `fetch-greek-exposure-strike:84-137`, `fetch-zero-dte-flow:110-143`,
      `fetch-flow-alerts:146-178` (**no per-row catch** — one bad row aborts the
      batch), `fetch-oi-change:79-116`, `fetch-oi-per-strike:54-79`,
      `fetch-vol-surface:79-101`, `fetch-economic-calendar:90-101`,
      `takeit-fill-shap:186-214`. N+1 enrichment loops:
      `enrich-lottery-outcomes:209-316`, `enrich-silent-boom-outcomes:113-199`,
      `enrich-periscope-lottery-outcomes:97-197` (`evaluate-round-trip.ts` is the
      batched UNNEST/LATERAL gold standard to copy).
      `detect-silent-boom:822-838` — per-fire COUNT(\*) trivially batchable with
      `= ANY(...) GROUP BY`.
- [x] **AUD-M8** `f2257fda` `api/cron/compute-zero-gamma.ts:326-341` — all-tickers-failed
      still returns `status: 'success'`. `deriveCronStatus(failed, total)` exists
      (`cron-instrumentation.ts:467`) and is unused here.
- [x] **AUD-M9** `f2257fda` `api/cron/backfill-futures-gaps.ts:320-339` — hardcoded
      `status: 'ok'` + HTTP 200 even if all 7 symbols fail; also its batch
      `sql.query()` inserts are the only cron DB writes not wrapped in `withDbRetry`.
- [x] **AUD-M10** `f2257fda` `api/cron/curate-lessons.ts:471-482` — per-review DB write
      failures: `logger.error` only, no Sentry; stream ends 200 so the monitor shows
      green even if every review fails. _Fix:_ `Sentry.captureException` in the catch.
- [x] **AUD-M11** `f2257fda` `api/cron/fetch-zero-dte-flow.ts:90-100` — degenerate-snapshot
      rejection (the 2026-06-03 incident fix) is warn-log only; a recurring UW
      degenerate feed = silent 0DTE flow gap. _Fix:_ one `Sentry.captureMessage`.
- [x] **AUD-M12** `f2257fda` `api/cron/fetch-es-options-eod.ts:77-116` — QC counters
      (`with_oi`, `with_iv`) computed but never checked; only `total_rows === 0`
      alerts. Sidecar drift writing NULL-OI stubs sails through. _Fix:_ gate on
      `with_oi === 0` too.
- [x] **AUD-M13** `f2257fda` DST-hardcoded overnight windows:
      `api/cron/auto-prefill-premarket.ts:40-44` + `api/cron/compute-es-overnight.ts:40-46`
      — window end pinned to the CDT offset (`T13:30:00Z`); in CST the last hour of
      Globex (7:30–8:30 CT) is excluded from H/L/C/VWAP, and auto-prefill also _runs_
      an hour before its data is complete (single `30 13` slot, `marketHours: false`).

### Frontend — `src/`

- [x] **AUD-M14** `e5d0e759` `src/hooks/useChainData.ts:64-67` — transient fetch failure
      wipes the live chain: `setChain(result.data)` runs unconditionally and
      `result.data === null` on networkError → pin-risk/skew blank for a full poll
      cycle (120s after backoff). _Fix:_ keep last-good data when
      `result.networkError` is set.
- [x] **AUD-M15** `e5d0e759` `src/hooks/useGexTarget.ts:295-357, 364-442` — stale-response
      race on date change: no abort-on-supersede, no sequence counter; a slow
      in-flight today-request (up to 30s on a Neon hang) can overwrite a freshly
      scrubbed past date's data. `useFetchedData.ts:136-151` has the correct pattern.
- [x] **AUD-M16** `e5d0e759` `src/hooks/useMarketData.ts:285-316` — side effects inside the
      `setData` updater (nested `setNeedsAuth`/`setFetchedAt`, ref mutations,
      `Date.now()`). StrictMode double-invokes → `consecutiveFailsRef` increments 2×
      per failure, halving the backoff threshold. _Fix:_ compute
      `processEndpointResults` outside the updater.
- [x] **AUD-M17** `e5d0e759` `src/hooks/useMarketData.ts:344, 386` — quotes-poll backoff can
      never engage: the poll tick never increments the fail counter, and ref reads at
      render don't re-render. The documented "interval doubling on 3+ failures" is
      dead code on the path it was built for. Same ref-at-render issue gates polling
      start for a visitor who authenticates in another tab. _Fix:_ adopt
      `useChainData`'s state+ref pattern.
- [x] **AUD-M18** `e5d0e759` `src/hooks/useMarketData.ts:376-383` — poll path bumps
      `fetchedAt` even when every fetch failed (contract says "last successful").
      No current UI consumer, but any future "last updated" display would lie.
- [x] **AUD-M19** `e5d0e759` `src/components/PreMarketInput.tsx:54-80` — scrubbing to a date
      with no saved data keeps the previous date's Globex H/L/C and `saved=true`; one
      Update click writes date A's overnight levels onto date B → wrong gap context
      to analyze. _Fix:_ reset all fields + flags at the top of the date-change
      effect.
- [x] **AUD-M20** `e5d0e759` `src/components/PanelPrefsModal/PanelPrefsModal.tsx:207-221,
313-320` — `aria-modal="true"` with no focus trap; Tab walks into the inert
      background AT was told doesn't exist. Escape + focus-restore are already
      correct. _Fix:_ focus-trap loop, native `<dialog>`, or `inert` on the shell.
      Spot-check `AccessKeyModal` and Tracker's `AddContractForm` dialog too.
- [x] **AUD-M21** `e5d0e759` `src/App.tsx:275-280, 667-672` + `src/utils/ui-utils.ts:34-50`
      — `chevronUrl` reads `getComputedStyle` during render and is permanently one
      theme-toggle behind (the `.dark` class flips in an effect after the memo
      recomputes). Render-purity violation + wrong chevron color per theme.
- [x] **AUD-M22** `e5d0e759` `src/hooks/useGexTarget.ts:224-238` — fresh
      `Intl.DateTimeFormat` per candle (~390/response, every 60s poll). Hoist one CT
      formatter to module scope (`src/utils/timezone.ts:9-41` is the template).
- [x] **AUD-M23** `e5d0e759` Dead components (grep-verified, referenced only by own tests /
      barrel): `src/components/DateLookupSection.tsx`,
      `src/components/VixUploadSection.tsx` (superseded by inline AppHeader upload),
      `src/components/ui/SortableHeader.tsx` + 3 orphan test files + barrel export.
- [ ] **AUD-M24** (DEFERRED — ~4k-line dedup refactor, quality not correctness) LotteryFinder/SilentBoom ~4,000-line near-twins:
      `LotteryFinder/index.tsx` (1,997) vs `SilentBoom/index.tsx` (1,941), row + group
      components likewise. Identical 30s tick + 60s midnight-roll effects copied
      verbatim; drift management is manual per the comments. Extract: now-tick +
      midnight-roll hook, date-scrub state machine, filter-chip toolbar shell.

### Python services — `sidecar/`, `uw-stream/`

- [x] **AUD-M25** `13e16a0c` `sidecar/src/health.py:972` + `sidecar/src/archive_query.py:62-139`
      — unauthenticated `/archive/*` on an **unbounded** `ThreadingHTTPServer`;
      DuckDB `memory_limit = '500MB'` is per-connection (thread-local), so N
      concurrent requests = N×500MB (+N×2GB temp) on a container with documented OOM
      history. _Fix:_ `threading.Semaphore(2)` around archive query execution
      (503/429 when saturated) or a small fixed pool.
- [x] **AUD-M26** `13e16a0c` `sidecar/src/options_router.py:358-369` — stat upsert failures
      are log-only, never Sentry; persistent failure (overflow, schema drift,
      SIDE-016 class) silently rots `futures_options_daily`. _Fix:_
      `capture_exception` with the file's existing throttled-summary pattern.
- [x] **AUD-M27** `13e16a0c` sidecar `db.py`/`databento_client.py` — per-record synchronous
      Neon writes on the single SDK callback thread (`upsert_futures_bar` at
      `databento_client.py:717`, `upsert_options_daily` in `handle_stat`): pool
      borrow up to 10s + retry head-of-line-blocks TBBO and options ingestion during
      a Neon stall. _Fix:_ route bars/stats through `BatchedWriter` (already exists,
      tables are upsert-idempotent).
- [x] **AUD-M28** `13e16a0c` `uw-stream/src/connector.py:99-106, 155-159` — repeated _clean_
      closes form a 1s tight reconnect loop that never trips the storm alert
      (`_maybe_alert_storm` only fires from exception branches) and resets backoff
      each cycle (`_established = True` after subscribe). This is exactly how a
      provider sheds over-cap connections. _Fix:_ alert from the clean-close branch;
      don't reset backoff on sub-threshold session duration (sidecar's
      `MIN_HEALTHY_SESSION_S` pattern).
- [x] **AUD-M29** `13e16a0c` `uw-stream/src/handlers/interval_ba.py:454-471` — alert rows
      unconditionally discarded when the raw-tick flush raises: `pending` is cleared
      before `super()._flush(rows)`; on Neon-outage retry exhaustion the alert rows +
      push notifications are gone and `_fired` blocks re-fire. _Fix:_ re-prepend
      `pending` (bounded) in an except before re-raising; ON CONFLICT key makes
      retry idempotent.

### CI / config / build

- [x] **AUD-M30** `18e93f2a` `vercel.json:2` — `ignoreCommand` diffs only `HEAD^ HEAD`: a
      two-commit push ending in a docs-only commit **skips deploying the src
      change**. _Fix:_ one-commit-at-a-time habit (current), or compare against
      `$VERCEL_GIT_PREVIOUS_SHA` / turbo-ignore-style logic. Also references
      nonexistent `daemon/`.
- [x] **AUD-M31** `18e93f2a` `.github/workflows/ci.yml` `changes` filter — misses
      `scripts/**` (includes `run-migrations.ts` → prod Neon), `index.html`,
      `public/**`, `vercel.json`, `audit-ci.jsonc`; lists nonexistent
      `vitest.config.ts` (vitest config lives in `vite.config.ts`). A PR touching
      only scripts/ runs zero checks.
- [x] **AUD-M32** `acd70d4f` `tsconfig.json:27` — `scripts/` (5.7MB of TS incl. prod-DB
      tooling) never type-checked; eslint.config.ts:121-127 acknowledges it.
      Combined with AUD-M31: zero static checks on prod-DB scripts. _Fix:_ minimal
      `tsconfig.scripts.json` (noEmit) for the non-throwaway scripts.
- [x] **AUD-M33** `18e93f2a` `vite.config.ts:142-181` — coverage configured, **no
      `thresholds`** — the "Tests Are Mandatory" policy has no mechanical backstop.
- [x] **AUD-M34** `acd70d4f` `tsconfig.json:5` — one tsconfig serves browser + server:
      `api/` compiles with DOM globals (`window`, `localStorage` available in Vercel
      Functions). _Fix:_ split app/api tsconfigs (standard Vite solution-style).
- [x] **AUD-M35** `18e93f2a` ci.yml has no `timeout-minutes` on any job (hung Playwright
      burns the 6h default); `ml-pipeline.yml:55,170` runs `npm install @vercel/blob`
      unpinned at runtime inside a job holding `contents: write` + prod
      `DATABASE_URL`. _Fix:_ timeouts (20 app / 30 e2e); pin or lockfile-install.

### ML — additional methodology issues

- [~] **AUD-M36** (DROPPED — ML, per user 2026-06-11) `ml/src/nq_flow_leadership/backtest.py` + `correlate.py` — QQQ
      sweep-imbalance backtest evaluates on its discovery sample (signal/bucket/exit
      geometry all selected from the same 15 days scored); headline 100%-WR/10-trade
      result is in-sample selection. Also: entry fills at the signal bar's own close;
      time stop counts join rows not minutes; overlapping forward windows inflate the
      correlation scan.
- [~] **AUD-M37** (DROPPED — ML, per user 2026-06-11) `ml/src/imbalance/eod_analysis.py:391-399` — NOII "predictive"
      test correlates `signed_imbalance_last` (~15:59) against the 15:50→15:59 return
      — concurrence, not prediction (Phase-5 `index_aggregator.py` gets it right).
      `ml/src/moc_features.py:63-69, 240-268` + `moc_eda.py` — same class: T55
      features vs a 15:50-anchored target.
- [~] **AUD-M38** (DROPPED — ML, per user 2026-06-11) `ml/src/cross_section_eda.py:282-308, 347-368` — H2/H3 mix
      SPX-scale levels with equity fires → `pd.cut` NaN → silently dropped; the
      documented 2026-05-16 rerun fixed it but the buggy script remains with no
      SUPERSEDED banner (and the rerun's tier gate `score >= 12` on bare `score`
      looks like a V1-cutoff-on-V2-field scale mismatch — verify).
- [~] **AUD-M39** (DROPPED — ML, per user 2026-06-11) `ml/src/enrich_lottery_outcomes.py:111-123` — per-fire
      full-archive `read_parquet('{archive}/*.parquet')` + fresh DuckDB connection
      inside the loop (the measured 40× per-row scan cliff). Tickless fires never get
      `enriched_at` → once ≥1000 accumulate, `LIMIT 1000` refetches the same dead
      batch forever. _Fix:_ derive `{date}-trades.parquet` from fire date; one
      connection; mark dead fires.
- [~] **AUD-M40** (DROPPED — ML, per user 2026-06-11) _(DEFERRED — bundle of many sub-items; schedule as its own focused session per 2026-06-11 decision)_ — Assorted (one line each — see agent report for detail):
      `clustering.py:228-236` preprocessing fit before split-half validation;
      `lottery_scoring.py:484-515` in-sample stats saved under `"validation"`;
      `takeit/train.py:264-276` calibration AUC on its own fit data;
      `calibration.py:161-166` NaN lands in "high" tertile;
      `takeit_drift_monitor.py:160-163` `fillna(-100)` turns NULL outcomes into
      definite losses; `eod_flow_forward_returns.py:349` / `singles_only.py:213`
      `ts > bucket_end` drops first post-burst minute (bars start-stamped) →
      deflated touch rates; `eod_flow_forward_returns.py:138-149` p90 floor from
      full-day distribution framed as live rule; `moc_moo_persistence.py:338-343`
      claims `|MOO|` but regresses signed; `payoff_eda_probe.py:308,394` imputation
      median computed pre-split, `:482-489` unbound `clip_peak` on empty cohort;
      `lottery_exit_policies.py:48-68` `realized_hard_stop_30m` never uses
      `minutes_since_entry` (label vs implementation mismatch — resolve before it
      feeds a model); `vega_spike_eda.py` + `pin_analysis.py` hardcoded EDT offsets
      (1h off in EST); `whale_plots.py:70-75` truncated DTE understates by ~1;
      `flow_outcomes.py:105-133` symbol-only join → ~10⁸-row intermediate;
      `visualize.py:1068-1077` ZeroDivisionError on never-recommended structure;
      `moc_eda.py:362` / `payoff_eda_probe.py:500` `boxplot(labels=)` removed in
      matplotlib 3.11; `imbalance/decoder.py:97-99` NaN-into-uint32 may raise under
      pandas 3.
- [ ] **AUD-M41** _(DEFERRED — bundle of many sub-items; schedule as its own focused session per 2026-06-11 decision)_ — scripts/ misc mediums: `backfill-vol-surface.mjs:110-114` +
      `backfill-greek-exposure.mjs:79` wrong-day `?? rows.at(-1)` fallback stores
      another day's row stamped as `${date}`; `backfill-flow-ratio.mjs:110-112` bare
      `catch {}` eats ALL insert errors; `backfill-strike-all.mjs:59-63` +
      `backfill-gex-strike-expiry.mjs:107` `limit=500` pagination caps with no
      overflow check (SPX chains can exceed); `backfill-netflow.mjs:100-113`
      running-sum assumes UW tick ordering, never sorts;
      `backfill-iv-monitor.mjs:91` hardcoded `-04:00` (winter dup rows — ts in
      conflict key); `backfill-takeit-scores.mjs:313-317,490-494` string
      interpolation into `sql.query()` text (validated upstream, injection-shaped);
      `backfill-darkpool.mjs:170-191` non-atomic DELETE-then-insert with swallowed
      errors; `backfill-lottery-fires.mjs:83-96,137-144` naive CSV split + float
      join key on `entry_price`; nearly every date-loop backfill exits 0 despite
      counted failures (only `backfill-periscope-playbook.mjs:640` sets exitCode);
      no 429 retry / no timeout / per-date rejection aborts run in ~8 scripts;
      `backfill-day-embeddings.mjs:95-105` no skip-existing (crash re-pays OpenAI
      for ~4,000 days); `backfill-ndx-candles-1m.mjs:61` hardcoded
      `QQQ_TO_NDX_RATIO = 41` (drifts 1-2%/quarter, no guard);
      `backfill-strike-exposure-lottery.mjs:226-233` multi-hour run, no try/catch,
      no resume.
- [x] **AUD-M42** `20421697` Security mediums: `api/alerts.ts:36` +
      `api/interval-ba-alerts.ts:212` — `?since=` reaches a TIMESTAMPTZ compare
      unvalidated (parameterized, NOT injection — but garbage input → repeatable
      500s on a 10s-polled endpoint; add an ISO-format guard → 400). `xlsx@0.18.5`
      unfixed prototype-pollution/ReDoS advisories (client-only, write-only usage,
      allowlisted with justification — track for replacement with `exceljs`).
      `@vercel/node` vendors `undici@5.28.4` with HIGH CVEs (trusted-upstream-only
      exposure; structural — track Vercel releases).

---

## LOW (selected — quick wins)

- [ ] **AUD-L1** `api/positions.ts` — `done` metrics callback never invoked on
      real outcomes (only 405/guard/rate-limit/400); `api/lottery-finder.ts:452` —
      no-op `done`, heaviest-polled endpoint invisible in `api.duration_ms`.
- [ ] **AUD-L2** `api/_lib/uw-fetch.ts:69` — unanchored `/50[234]/` retry
      classifier matches status codes appearing anywhere in the error body; anchor
      `^UW API (5\d\d):` like `sentry.ts:63`.
- [ ] **AUD-L3** `api/lottery-finder.ts:621-950` + `api/silent-boom-feed.ts:485+`
      — full ~100-line query duplicated per ORDER BY branch (~400 collapsible lines
      via the whitelist-splice pattern already used in the same file).
- [ ] **AUD-L4** `api/_lib/db-oi-change.ts:36-47` — dead `date` field with the
      DATE-as-Date type lie (never read; drop or TO_CHAR).
- [ ] **AUD-L5** `src/components/Toast.tsx:151-161` — `dismiss()` side effects
      inside a state updater (StrictMode double-fire; nested setState in updater).
- [ ] **AUD-L6** `src/App.tsx:811` — `derivedRatio` recomputes
      `useSpotInputs().effectiveRatio` inline; `src/main.tsx:30` — `console.log`
      build stamp (redundant with the corner badge).
- [ ] **AUD-L7** `src/utils/iron-condor.ts:41-68` —
      `adjustICPoPForKurtosis` returns NaN where `calcPoP` returns 0
      (`putSigma===0`/`beLow<=0` unguarded in the kurtosis branch).
- [ ] **AUD-L8** `src/hooks/useTimeInputs.ts:62-73` — three independent
      `getInitialCTTime()` clock reads can tear the seeded time across a minute/AM-PM
      boundary; window check ignores early-close days.
- [ ] **AUD-L9** `src/hooks/useOpeningFlowSignal.ts:2-4` — header says
      09:25–09:50 CT, code implements 08:25–08:50 CT (code is right, doc misleads).
- [ ] **AUD-L10** `src/utils/time.ts:31-54` — `validateMarketTime`
      production-dead, drifting from `computeMarketTime` (no early-close support);
      `parseDow` no-arg fallback uses host-local day not ET.
- [ ] **AUD-L11** `src/hooks/useVixData.ts:188-192` — localStorage write inside
      setState updater; `src/utils/black-scholes.ts:268-273` — IV-seed comment/code
      drift (0.5 vs 0.3); `src/hooks/useFuturesData.ts:125-132` — superseded request
      flips `loading` off early (cosmetic flicker).
- [ ] **AUD-L12** uw-stream: no jitter on reconnect backoff (8 shards in
      lockstep, `connector.py:26-29`); WS token in URL scrubbed for Sentry but not
      plain logs (`config.py:427-430`); floor-only pins in requirements.txt (both
      services — `databento>=` is the riskiest given SIDE-014 record-type churn).
- [ ] **AUD-L13** sidecar dead code: `_handle_ohlcv_from_client` (unreachable,
      missing SIDE-011 check — trap if wired in), `db.insert_options_trade` (zero
      callers, **no ON CONFLICT** — reintroduces SIDE-003 if revived),
      `takeit_server.start_in_thread` ("safe to delete after next deploy" — shipped),
      `symbol_manager.build_es_option_symbols` (placeholder).
- [ ] **AUD-L14** Repo hygiene: `sidecar/ThetaTerminalv3.jar` 11.8MB binary
      tracked in git (fetch at build time instead); `ml/experiments/` 21.2MB of
      parquet/CSV; `docs/tmp/` leaked an 8.4MB CSV past the `p1_*…p6c_*` ignore
      patterns (widen to `p*_*.csv`).
- [ ] **AUD-L15** Stale `daemon/` references: `vite.config.ts:140`,
      `eslint.config.ts:22`, `vercel.json:2`. Unused `ws` devDependency
      (grep-verified zero imports). `@sentry/vite-plugin` in dependencies but
      build-only (move to devDeps).
- [ ] **AUD-L16** 8 e2e specs use hardcoded `waitForTimeout` (≤400ms debounce
      waits — low flake risk; canonical fix is web-first assertions/`toPass()`).
      ~62 of 239 components never named in any test (many are leaves covered via
      parents — spot-check against coverage HTML, smoke-test the truly untouched).
      Hooks with zero direct tests, largest first: `useGreekHeatmap`,
      `useIntervalBAAlerts`, `useIntervalBAFeed`, `useGexStrikeExpiry`,
      `useGexbotData`, `useVegaSpikes`, `usePeriscopeExposure`, `useTermStructure`.
- [ ] **AUD-L17** `api/positions.ts:250-251,359-360` — `?spx=` parseFloat
      without `Number.isFinite` bounds (owner-gated; data-integrity only).
      `vercel.json:399` — deprecated `X-XSS-Protection: 1; mode=block` (OWASP now
      recommends `0`/omit). `ml-pipeline.yml:110-114` echoes full response body to
      Actions log (truncate on non-200 instead).
- [ ] **AUD-L18** ml/ lows: `backtest.py` profit_factor `Infinity` → invalid
      JSON; `pyproject.toml` has no dependency table (the pandas-3 breakages arrived
      exactly this way) + ruff targets py313 on py314 venv; `conftest.py` puts
      tests/ ahead of src/ on sys.path; hardcoded `~/Desktop/Bot-Eod-parquet` in
      `nq_flow_leadership/load_options_trades.py`; `periscope_eda/` relative output
      paths; `features/microstructure.py` + `tbbo_convert.py` not crash-resumable;
      `test_setups_backtest_setup_6b.py:144-146` silently returns when pivot
      detection finds nothing (can't fail — notable given AUD-C1 lives next door);
      `test_flow_ingest.py` tests `scripts/ingest-flow.py` NOT `eod_flow_ingest.py`
      (name collision masks the gap); no UW User-Agent set in 13 scripts (known WAF
      403 hazard).

---

## Cron-layer schedule/status lows (from the cron agent — for completeness)

- `fetch-spx-candles-1m.ts:560-575` — hardcoded `success: true` in response when
  failures occurred (Sentry does fire; monitor-cosmetics only).
- `fetch-futures-snapshot.ts:74-75` — fulfilled-but-null snapshot dropped with no
  log; partial failures report `'ok'` with errors only in metadata.
- `fetch-day-ohlc.ts:176-205` — `updated === 0` returns `'success'`, should be
  `'skipped'`.
- `auto-prefill-premarket.ts:68` vs `compute-es-overnight.ts:146` — two different
  VWAP formulas for the same concept (surfaces will disagree).
- `archive-gexbot.ts:125` — `Number()` on BIGINT keyset cursor (latent); no
  trading-day assert before archive→cleanup chain (holiday run green-lights
  deletion of an empty day).
- `cleanup-ws-*` — repeated `wall_budget` stop reason never alerts (retention
  falling behind ingestion would be silent).
- `fetch-gexbot-fast.ts:357-368` / `fetch-gexbot-strikes.ts:130-141` — >10
  failures collapse to one Sentry _warning_; confirm alert rules page on it.

---

## CLAUDE.md doc drift (update the doc, not the code)

- [ ] `.js`-extension list is stale: `src/utils/max-pain.ts` and
      `src/utils/futures-gamma/` no longer exist. Actual api-imported set:
      `src/utils/{timezone,zero-gamma,market-regime,extreme-detector,black-scholes}.ts`,
      `src/utils/gex-target/*`, `src/components/LotteryFinder/ct-window.ts`,
      `src/data/marketHours.ts` (+ type-only `src/types/{api,market-internals}.ts`).
- [ ] `useAppState` was split into `useSpotInputs` / `useTimeInputs` /
      `useIvInputs` / `useStrategyInputs` (Phase 2P); the 10:00 AM CT default lives
      in `useTimeInputs.ts`.
- [ ] "35 cron jobs" → 84 schedule entries / 78 unique handlers.
- [ ] "23 Playwright specs" → 38.
- [ ] "`api/analyze.ts` (800s)" → actual `maxDuration: 780`.
- [ ] "`cleanupOutdatedCaches: true` is set in vite.config.ts" → it moved to
      `src/sw.ts:44` after the injectManifest switch (requirement IS satisfied).

---

## Verified clean (explicitly checked — do not re-litigate)

- **SQL injection:** none. Every `db.unsafe`/`sql.unsafe` site is static or
  whitelisted; all user input flows through tagged-template params.
- **Auth:** OAuth state nonce (randomBytes(32), 10-min TTL, delete-on-use),
  correct cookie flags, constant-time guest-key + CRON_SECRET comparison
  (timingSafeEqual; guest-auth uses fixed-buffer walk-all-keys), botid `protect`
  array fully in sync with `checkBot` callers.
- **Anthropic:** analyze.ts cache boundary correct (static system under one
  `cache_control` block, dynamic lessons/similar blocks after it).
- **`.js`-extension rule:** zero violations across the full transitive closure.
- **Black-Scholes / day counts / timezone layer:** verified correct incl. DST
  edges; hedge's 365-day base is the documented FE-MATH-008 divergence.
- **Polling discipline:** all 30+ polling hooks gate on marketOpen or a CT
  window; PWA lazy imports all have `.catch(handleStaleChunk)`.
- **ml/ CV hygiene:** no shuffled/random CV anywhere (expanding walk-forward /
  TimeSeriesSplit); seeds set on every stochastic site; the known
  Categorical.astype(str) venv bug has zero live instances.
- **uw-stream 50-channel cap:** properly sharded (`PER_CONN_MAX=45`,
  family-contiguous shards, re-join reconcile loop, subscription watchdog) and
  well-tested. Lease death → exit 1 → restart is wired except the two paths in
  AUD-H1/H2.
- **Sidecar archive-seed endpoint:** genuinely solid (hmac.compare_digest,
  traversal-hardened dest path, SSRF-blocked host allowlist, atomic tmp→rename +
  SHA verify, single-flight).
- **GitHub Actions:** third-party actions SHA-pinned, scoped permissions,
  concurrency groups present, no untrusted-input injection.
- **api/ test coverage:** all 168 endpoint/cron handlers imported by ≥1 of 306
  test files.
- **Cron auth:** all 78 handlers guard CRON_SECRET (timing-safe) before any side
  effect.
- **Neon driver traps in crons/scripts (read side):** every NUMERIC/DATE read
  checked coerces correctly; the residual instances are AUD-M3/M4 (api) and the
  write-side `trade.size` concat (AUD-H7).

## Sub-auditor claims verified and REJECTED (do not act on)

- `audit-takeit-calibration` "missing `{ marketHours: false }`" — false (present).
- `fetch-economic-calendar` "14:25 UTC slot is dead" — false (standard DST dual-slot).
- `backfill-futures-gaps` "DB errors silently swallowed" — false (caught + Sentried; the real issue is status misreporting, AUD-M9).
- `curate-lessons` "partial-write corruption" — false (atomic per-review `sql.transaction`).
- `fetch-flow` "QC only runs when stored" — false (runs unconditionally; total failure throws).
- `takeit-fill-shap` "4xx/5xx Sentry severity reversed" — intentional and documented in the file header.

---

## Suggested remediation order

1. **Silent-death ops** (small diffs, big blast radius): AUD-H1, AUD-H2, AUD-H3
   — "production data silently stops" class.
2. **ML leakage criticals**: AUD-C1, AUD-C2, AUD-C3 (+ retrain) — corrupting
   research conclusions that drive trading decisions.
3. **Shared `getTradingDays` helper**: AUD-C4 — one helper, 18 call sites.
4. **Prod-visible bugs**: AUD-H4 (analyze refusal), AUD-H6 (panelMap memo),
   AUD-M14/M15 (chain wipe, gex race), AUD-M19 (PreMarket stale fields).
5. **Alerting gaps**: AUD-M1/M2 (cache poisoning), AUD-M8–M12 (cron status/Sentry).
6. **Infra/CI**: AUD-H5 (audit gate), AUD-M30–M35.
7. **Everything else** as touched — batch the per-row INSERT migration (AUD-M7)
   with the bulk-upsert Phase 3b spec it was already staged under.
