# "No errors" sweep — 2026-08-19

**Date:** 2026-08-19 · **Status:** Phases A–F shipped + deployed (commits c7dc9b3a..d8d927d2); G shipped (selector drift), G2 (collapsed-section helper + /api/history mock + tab-order) in progress; H (DEP0169) RESOLVED: the stack traced to Vercel's runtime bridge (/opt/rust/nodejs.js IncomingMessage.get — the lazy req.query getter calls url.parse); platform code, not ours → NODE_OPTIONS=--no-deprecation in prod; live deployment shows 0 error-level lines and 0 5xx in its first 2h · **Owner:** soonerdude28 fork

## Goal

Close every known error, failing gate, and leftover note so the project runs
clean: production logs with no error clusters, all local/CI gates green,
no stale docs, and the reviewer nice-to-haves from the VIX fix applied.

## Inventory (evidence, 2026-08-19)

| # | Item | Evidence | Phase |
|---|------|----------|-------|
| 1 | Sidecar lint gate is not enforcing anything | `sidecar/pyproject.toml` does not exist (CLAUDE.md claims it does); `ruff check` unconfigured → 224 findings (109 RUF100 from noqa's that reference unselected rules, 24 I001, 23 BLE001, 21 SIM117, 7 DTZ011, …); `make lint` fails repo-wide | A |
| 2 | `capture-flow-regime-daily` 500 | 2026-08-18 21:55Z: TransientDbError 'db attempt timeout' 33s — one full-day GROUP BY over ~7.4M `ws_option_trades` rows | B |
| 3 | `detect-lottery-fires` 60s timeout | 2026-08-19 13:48Z at the open (1 occurrence, maxDuration 60): `Promise.all` tick batches across ~86 tickers | C |
| 4 | NDX 1m candles stop at the RTH open | `index_candles_1m` 2026-08-19: NDX 302 rows 08:00→13:29 UTC only; SPX 603 rows through 20:05 UTC | D |
| 5 | `/api/quotes` shed path can exceed the UI timeout | theta_busy retry = 5s + 1s + ≤5s = 11s vs `FETCH_TIMEOUT_MS = 10_000` | D |
| 6 | `mapWithConcurrency` has no fail-fast | abandoned runners keep loading the sidecar after a rejection | E |
| 7 | `/api/history` all-five-empty on a trading day → long CDN header; dead 120s redis write; early-open ok-but-empty alert noise; real 300ms timers in tests | VIX-fix reviewer nice-to-haves | E |
| 8 | Redis cost/resilience (paid per command since 2026-08-19) | rate limiter = 2 commands/request; Schwab token read per API call; `events`/`vix1d` raw redis calls 500 on quota; `/api/health` can't tell quota from outage | F |
| 9 | e2e selector drift | 40 uses of `getByRole('radio', {name:'AM'})` in 24 specs; UI renders AM/PM as `aria-pressed` buttons → a11y spec fails | G |
| 10 | DEP0169 `url.parse()` deprecation logged as **error** on every cold start | 738 events / 24h across ~95 routes; not in our code (grep clean) — runtime/transitive | H |
| 11 | Stale docs | theta spec cites `:25503` ×7; sidecar README says `/healthz` and "7 futures symbols" (6); CLAUDE.md claims `sidecar/pyproject.toml` | A |
| 12 | `takeit-score.parity.test.ts` fails locally | needs gitignored `ml/data/takeit/*_training.parquet` (Phase-1 ML export); `it.skip`s only in CI — **by upstream design; left as-is** | — |
| 13 | Schwab secret rotation + weekly re-login | secret passed through chat; refresh token 7d | user |

## Phases (disjoint files; A–G run in parallel)

- **A. Sidecar lint + docs** — `sidecar/pyproject.toml` (ruff select mirroring uw-stream/classifier PLUS the rule families the code's `noqa`s reference: `PL`, `ARG`, `S`, `BLE`, `D401`, `N`; ignore E501/B008), fix every remaining finding so `make lint` (ruff check --fix + format) is clean and `pytest` stays 819+ green; README `/health`, 6 symbols; theta spec port/monitor. Files: `sidecar/**`, `docs/superpowers/specs/theta-railway-sidecar-2026-04-18.md`.
- **B. flow-regime-daily chunking** — accumulate per slot-window chunks (the builder takes `[start,end)`; slot index must stay relative to 09:30 ET, verify) or per-ticker chunks; sequential; same output rows; per-attempt timeout respected. Report desired `maxDuration` (orchestrator edits vercel.json). Files: `api/cron/capture-flow-regime-daily.ts` + test (+ `api/_lib/flow-regime*.ts` builder only if it must learn a slot offset — keep the live `capture-flow-regime` cron byte-identical).
- **C. detect-lottery-fires budget** — cap tick-batch concurrency, wall-clock budget with graceful partial result (never a 504), report desired `maxDuration` (orchestrator edits vercel.json). Files: `api/cron/detect-lottery-fires.ts` + test.
- **D. NDX RTH candles + quotes shed path** — find why NDX stops at 13:29Z and fix; on the `/theta/index/price` path skip the theta_busy retry for roots with a UW fallback (or shorter wait) so quotes stay < 10s. Files: `api/cron/fetch-spx-candles-1m.ts` + test, `api/_lib/market-data-adapters.ts` + test.
- **E. history + uw-fetch polish** — `isTradingDay` gate for all-empty long-TTL, drop/comment dead write, early-open alert demotion, fake timers; `mapWithConcurrency` fail-fast. Files: `api/history.ts` + test, `api/_lib/uw-fetch.ts` + test, `src/data/marketHours.ts` read-only.
- **F. Redis Phase B** — rate limiter 1 command (EXPIRE only when count===1) + skip for `sc-owner` / `CRON_SECRET` callers; in-memory Schwab token cache; `safeRedis` on `events`/`vix1d-daily`/`refresh-vix1d`; `redis.ts` quota detection (`redis.quota_exceeded` metric, once-per-process warn); `/api/health` redis `degraded` on quota vs `error`. Files: `api/_lib/auth-helpers.ts`, `api/_lib/schwab.ts`, `api/_lib/redis.ts`, `api/health.ts`, `api/events.ts`, `api/vix1d-daily.ts`, `api/cron/refresh-vix1d.ts` + tests.
- **G. e2e AM/PM helper** — `e2e/helpers/…` `selectMeridiem(page, 'AM'|'PM')` using `getByRole('button', {name})`; replace all 40 call sites; run the a11y spec + 2 others locally. Files: `e2e/**`.
- **H. DEP0169** — set `NODE_OPTIONS=--trace-deprecation` for one deploy to capture the stack; then fix the source if ours/upgradable, else `NODE_OPTIONS=--no-deprecation`. Orchestrator (env + deploy), not an agent.

## Thresholds / constants
flow-regime chunk = per slot window; detect-lottery-fires budget ≈ 45s of its maxDuration; token cache = `expires_at − 60s`; quotes theta_busy retry skipped for `UW_INDEX_ROOTS`.

## Open questions (defaults picked)
- Fix the DEP0169 source vs suppress: trace first; suppress only if it is the Vercel runtime.
- `takeit` parity test: keep upstream semantics (fails loudly locally without the ML export); not a code defect.
