# Daemon Refactor — TRACE Live Capture daemon — 2026-05-01

## Goal

Reduce **cross-codebase duplication risk** and decompose oversized files
in the `daemon/` Railway service. Pulled from a single-agent assessment of
all 10 source files (~2205 LOC). Mirrors the structure of the
[api-refactor-2026-05-02](api-refactor-2026-05-02.md) and
[src-refactor-2026-04-30](src-refactor-2026-04-30.md) plans:
highest-ROI cross-cutting fixes first, then file-by-file decomposition,
then process-lifecycle hardening.

The daemon is in healthy shape — works in production, scheduler skip-if-running
guard already protects against overlapping ticks, Sentry+pino observability
is already wired up. The biggest risks are **silent annual drift** in
duplicated calendar/classification data shared with `src/` and `scripts/`.

## Constraints

- **No production behavior change.** The daemon runs every 5 min in production;
  refactors must not change scheduler cadence, capture flow, POST contract, or
  graceful-shutdown ordering.
- **No tests exist today.** Add tests where they're cheap and meaningful (pure
  functions: calendar lookups, GEX classification, gex.ts helpers, backfill
  outcome routing). Skip tests for Playwright integration (capture-script.ts —
  validated end-to-end on Railway).
- **Cross-codebase imports require `.js` extensions** when daemon imports from
  `src/` (per CLAUDE.md). The daemon `tsconfig.json` and Vercel both run Node
  ESM strict resolver.
- **Logger / Sentry isolation is correct, not duplication** — these are
  separate Railway service instances; do NOT consolidate with `api/_lib/`.
- Each phase ≤5 files (CLAUDE.md `## Pre-Work`).
- Each phase ends with `npm run review` (root) AND `npm run --prefix daemon build`
  + a code-reviewer subagent verdict before commit.
- Commit directly to `main` (per memory `feedback_direct_to_main.md`).

## Files to create (new shared modules)

```
src/data/marketHours.ts                    # already exists — extend with daemon-friendly export
src/utils/gex-classification.ts            # new — shared classSignal / class labels
src/utils/trace-live-tz.ts                 # new — TZ probe shared by daemon + scripts
daemon/src/capture/auth.ts                 # extracted from capture-script.ts (~120 LOC)
daemon/src/capture/selectors.ts            # extracted SEL map + CHART_TYPES (~50 LOC)
daemon/src/capture/dom-helpers.ts          # extracted ensureChartType / ensureGexToggleOn / readSpotPrice / etc
daemon/src/capture/diagnostics.ts          # failWithDiagnostics helper (consolidates 3 sites)
daemon/src/utils/sleep.ts                  # tiny shared helper
```

## Files to modify (consumers)

```
daemon/src/scheduler.ts                    # adopt shared calendar
daemon/src/gex.ts                          # adopt shared classification + decompose fetchGexLandscape
daemon/src/backfill.ts                     # adopt shared TZ probe + processSlot extraction
daemon/src/capture-script.ts               # decompose into auth/selectors/dom-helpers/diagnostics
daemon/src/api-client.ts                   # adopt shared sleep
daemon/src/capture.ts                      # SIGTERM→SIGKILL timer cleanup
daemon/src/health-server.ts                # 503 on wedged-daemon detection
daemon/src/index.ts                        # fatalExit ordering fix
scripts/capture-trace-live.ts              # adopt shared TZ probe
src/components/GexLandscape/constants.ts   # collapse classSignal into shared module
```

## Phases

### Phase 1 — Cross-codebase consolidation (highest ROI, smallest risk)

These are the items most likely to silently drift over time. Greenfield
shared modules + adoption in BOTH callers per phase.

**1a. Holiday + early-close calendar consolidation** (≤4 files)

- Move/derive the 2025/2026 holiday and early-close lists from
  `daemon/src/scheduler.ts:26–56` into `src/data/marketHours.ts` (which
  is the existing source of truth for the frontend) using an exported
  CT-keyed shape the daemon can import.
- The daemon imports from `../../src/data/marketHours.js` (relative path
  with `.js` extension per CLAUDE.md). Verify the daemon's `tsconfig.json`
  allows the cross-package import; if not, extend its `include` or use
  a path alias.
- Delete the daemon-local arrays and the "keep in lock-step" comment.
- Add unit tests for the shared lookup (which already exist for
  `src/data/marketHours.ts`; just verify the daemon doesn't break them).

**Verify:** daemon `tsc --noEmit`; `npm run review` (root) green.

**1b. GEX classification consolidation** (≤3 files)

- Extract the `classSignal` mapping (and any class-label constants) to
  a new `src/utils/gex-classification.ts` (or extend
  `src/components/GexLandscape/constants.ts` with a daemon-importable
  pure-function export).
- Adopt in `daemon/src/gex.ts:30–65`.
- Adopt in `src/components/GexLandscape/constants.ts` (or remove the
  duplicate definition).
- Add tests if the function isn't already covered.

**1c. TRACE-Live TZ probe consolidation** (≤3 files)

- Move `computeCapturedAtIso` from `daemon/src/backfill.ts:99–117` AND
  `scripts/capture-trace-live.ts` to `src/utils/trace-live-tz.ts`.
- Adopt in both consumers.
- The "keep them in lock-step" comment that exists in both files goes
  away.

### Phase 2 — Internal daemon decomposition

**2a. `capture-script.ts` split into 4 modules** (≤5 files)

- Create `daemon/src/capture/auth.ts` from `loginIfNeeded` (~123 LOC) +
  the failure-screenshot+throw branches.
- Create `daemon/src/capture/selectors.ts` from the `SEL` map +
  `CHART_TYPES` constant (~50 LOC).
- Create `daemon/src/capture/dom-helpers.ts` from `ensureChartType`,
  `ensureGexToggleOn`, `ensureStrikeZoom`, `readSpotPrice`, `readStability`,
  `captureChartImage`.
- Create `daemon/src/capture/diagnostics.ts` exporting
  `failWithDiagnostics(page, label, originalErr)` — consolidates the 3
  duplicated screenshot-and-throw blocks.
- `capture-script.ts` shrinks to the orchestration shell (~150 LOC).
- No new tests — this is Playwright integration code; validated
  end-to-end on Railway.

**2b. `gex.ts` `fetchGexLandscape` decomposition** (≤2 files)

- Extract 4 named helpers: `findClosestSnapshotTs()`,
  `fetchPriorGammaMap()`, `enrichStrikes()`, `computeAggregates()`.
- Each is a pure-ish function over the existing data; testable in isolation
  with mocked `sql` client.
- Add unit tests for each helper (cheap — small inputs/outputs).
- `fetchGexLandscape` becomes a ~30-LOC orchestrator.

**2c. `backfill.ts` `processSlot` extraction** (1 file + tests)

- Extract `processSlot(slot, config, logger)` returning a discriminated
  result `{ outcome: 'succeeded' | 'skipped' | 'alreadyDone' | 'failed' }`.
- The wall of counters + early-continue branches in the loop body
  collapses to a switch on outcome.
- Add tests covering each outcome path.

**2d. `sleep` helper + `failWithDiagnostics` adoption** (≤3 files)

- Create `daemon/src/utils/sleep.ts` exporting `sleep(ms)`.
- Adopt in `api-client.ts` and `backfill.ts`.
- Adopt `failWithDiagnostics` from Phase 2a in the 3 sites in
  `capture-script.ts`.

### Phase 3 — Process lifecycle hardening (real correctness fixes)

**3a. `fatalExit` cleanup ordering** (1 file + test)

- Current: `fatalExit` (`index.ts:134`) calls `Sentry.close(2000)` then
  `process.exit(1)`. The scheduler timer + health server + spawned
  capture child are NOT cleaned up.
- Fix: in order — `scheduler.stop()` (clears interval, prevents new
  ticks) → `health.close()` (stops accepting requests) → `Sentry.close()`
  (drains events) → `process.exit(1)`.
- Add a unit test that mocks all three and asserts call ordering.
- For the spawned capture child: track the active child PID in
  `capture.ts` and add `killActiveChild()` exported helper called by
  `fatalExit` before scheduler.stop. Optional — not strictly needed
  on Linux/Railway since OS reaps orphans on parent exit.

**3b. Health endpoint 503 on wedged daemon** (≤2 files)

- Current: `/health` always returns 200.
- Fix: return 503 when EITHER:
  - `status !== 'running'` (scheduler stopped)
  - `lastFailAt > lastSuccessAt && uptime > 30 min` (wedged after recovery
    window)
- Add unit tests for both 503 conditions and the 200 happy path.
- Railway liveness probe will now correctly bounce wedged containers.

**3c. `capture.ts` SIGTERM→SIGKILL timer cleanup** (1 file)

- Current: the SIGTERM→SIGKILL backstop at line 130 leaks the inner
  timeout if the close fires first.
- Fix: `child.once('close', () => clearTimeout(killTimer))`.
- One-line change. No test (would require complex child-process timing
  mock; the leak is observably benign).

### Verification (always last)

- `npm run review` (root) — full pipeline (tsc + eslint + prettier +
  vitest --coverage).
- `npm run --prefix daemon build` — daemon's TypeScript compiles.
- Manual smoke (optional): `BYPASS_MARKET_HOURS_GATE=1 npm run --prefix daemon dev`
  and confirm a single capture cycle completes.
- Final code-reviewer subagent on the full diff.

## Open questions

- **Q1: Daemon ↔ src/ import path.** The daemon's `tsconfig.json` may
  not currently allow imports from `../../src/`. Default: extend its
  `include` or add a path alias. Alternative: physically symlink/copy
  the shared files into `daemon/src/shared/` at build time. **Going
  with**: extend `include` (simplest, no build-step gymnastics).
- **Q2: GEX classification — extract or extend `GexLandscape/constants.ts`?**
  Default: new `src/utils/gex-classification.ts` (mirrors how
  `src/utils/timezone.ts` exists alongside `src/data/marketHours.ts`).
  Avoids pulling component-specific imports into the daemon's bundle.
- **Q3: `processSlot` discriminated result — exhaustive `switch` or `if-else`?**
  Default: `switch` with a never-typed default branch so adding a new
  outcome forces compile-time review of every consumer.
- **Q4: Health endpoint wedged threshold.** Default 30 min. Configurable
  via env var? **Going with**: hard-code 30 min for now; promote to env
  var only if Railway tuning needs it.

## Thresholds / constants to name

- `WEDGED_DAEMON_THRESHOLD_MS = 30 * 60 * 1000` (health-server.ts)
- `KILL_GRACE_MS = 5_000` (capture.ts SIGTERM→SIGKILL grace window —
  may already be a const; verify and name if not)

## Skip / defer

- **Tests for `capture-script.ts`** — Playwright integration code,
  validated end-to-end on Railway. Mocking the browserless connection
  + DOM probes for unit tests would be more code than the implementation.
- **Logger / Sentry consolidation with `api/_lib/`** — daemon is a
  separate Railway service; sharing runtime instances with Vercel would
  be wrong.
- **`withRetry` consolidation between `daemon/api-client.ts` and
  `api/_lib/uw-fetch.ts`** — the signatures are similar but the daemon's
  retry is HTTP-specific; sharing would require a generic version that
  pulls daemon-only context. Skip unless a 3rd consumer emerges.
- **`api-client.ts` NDJSON parser** — necessary for handling the streaming
  Vercel response; well-commented and not a refactor candidate.

## Done when

- All Phase 1-3 sub-tasks committed to `main`.
- `npm run review` green.
- `npm run --prefix daemon build` clean.
- Final code-reviewer subagent verdict = `pass`.
- No production regressions observed in Sentry / Railway logs in the
  24h after the last commit lands.
