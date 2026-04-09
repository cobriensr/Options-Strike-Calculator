# GexTarget Rebuild Plan

**Status:** Draft — awaiting owner approval before Phase 0
**Owner:** @cobriensr
**Replaces:** `src/components/GexMigration/`
**Created:** 2026-04-08

---

## Why this rebuild exists

The current `GexMigration` component was built to answer one question ("where is gamma growing fastest?") using one ranking heuristic (sparkline urgency with proximity weighting). After using it for a few sessions and reverse-engineering Wonce's sofbot tool, two problems surfaced:

1. **The model is prescriptive, not descriptive.** `GexMigration` picks a single "target strike" using opaque confidence tiers and hides the leaderboard of candidates. In a live session, the trader wants to see the full board and understand *why* a strike is being picked — not trust a black box.
2. **The scoring math ignores load-bearing features.** The current code weights only Δ% urgency and proximity. It doesn't consider size dominance relative to the board, flow directionality (calls vs puts), charm (time-weighted decay alignment), price cooperation, or multi-horizon confluence. Those are exactly the features that distinguish a real magnet from a noisy one.

`GexTarget` is a fundamentally different component. It's a **5-panel single-component** that shows the leaderboard, the target pick, the per-strike history at three time horizons, and a gex-annotated price chart — all driven by one mode toggle (OI/VOL/DIR) that cascades through every panel. Behind it is a richer scoring model and a persisted features table that makes backtest and ML work possible.

This plan is also a **methodology document for the ML pipeline and futures validation experiments** that will follow. Those are not built in this phase, but the data architecture is designed so they drop in cleanly later.

---

## Success criteria

This rebuild is done when:

1. The old `GexMigration` component and all its files are deleted. Lint passes.
2. `GexTarget` renders five panels with live data and a working backtest scrubber that can replay any of the last 30 days.
3. The mode toggle (OI/VOL/DIR) cascades through all 5 panels and updates the price chart overlay lines when the relevant GEX strikes change.
4. The `gex_target_features` table has been backfilled from the last 30 days of `gex_strike_0dte` data and is being written to live by the existing `fetch-gex-0dte` cron.
5. The `spx_candles_1m` table has been backfilled from the last 30 days of UW SPY 1-minute data and is being written to live by a new `fetch-spx-candles-1m` cron.
6. The analyze endpoint reads 1-minute candles from `spx_candles_1m` instead of fetching 5-minute candles on demand. Full-session 1-minute candles land in the Claude prompt.
7. `npm run review` passes with zero failures.
8. Full backtest of a random day from the last week produces sensible target picks that can be eyeballed against the price action.

---

## Architectural commitments

These are the load-bearing decisions made in discussion. They should not be relitigated mid-phase without owner approval.

### Scoring model: weighted composite with multiplicative gates

The scoring function is a weighted combination of directional factors, gated multiplicatively by presence factors:

```typescript
score = 
    w1 * flowConfluence * dominance * proximity   // direction × strength × presence
  + w2 * priceConfirm   * dominance * proximity   // price agreeing × presence
  + w3 * charmScore     * proximity               // charm story × reach
  + w4 * (clarity - 0.5)                          // clean-wall bonus / mixed-strike penalty
```

**Why multiplicative gates matter:** a strike 45pts away from spot with mid-pack GEX $ can't win on flow alone. `dominance ≈ 0.1` and `proximity ≈ 0.05` kill the contribution. This is the "not much more GEX $ than the other bars" failure mode we explicitly want to avoid.

**Why it's sign-aware:** every term carries direction. A put wall being actively built while price falls scores negative and is rendered the same way as a positive-magnet call wall. The UI translates the sign into a `CALL WALL` or `PUT WALL` label based on signed net gamma at the strike, not a predetermined bias.

The full mathematical specification is in **Appendix C**.

### Three parallel scoring modes

The three modes (`oi`, `vol`, `dir`) are not a display toggle — they are three independent score pipelines computed on every snapshot, all persisted to `gex_target_features`. The mode toggle at the top of the component selects which one drives the UI; the other two are always computed and stored so (a) switching modes is instant with no refetch, and (b) the ML pipeline has three labels per snapshot to train against.

| Mode | Reads | Tells you |
|---|---|---|
| **OI** | `call_gamma_oi + put_gamma_oi` | Standing dealer inventory — slow, structural, "the book" |
| **VOL** | `call_gamma_vol + put_gamma_vol` | Today's fresh flow — fast, reactive, new positions |
| **DIR** | `(call_gamma_ask - call_gamma_bid) + (put_gamma_ask - put_gamma_bid)` | Directionalized — which side is actively pushing |

### Multi-horizon ratio weighting

Horizon deltas are combined with weights derived from `1/n`, not hand-tuned constants. For horizons `[1, 5, 20, 60]`:

```typescript
raw_weights = [1/1, 1/5, 1/20, 1/60] = [1.00, 0.20, 0.05, 0.017]
sum         = 1.267
norm_weights = [0.789, 0.158, 0.039, 0.014]
```

Adding or dropping a horizon in the future (e.g., adding 10m) re-derives the weights automatically. No re-tuning. The 1-minute horizon dominates heavily, which is the intended shape: recency is the primary signal, longer horizons are confirmation gates.

### Persisted features table

Every snapshot writes 30 feature rows (10 strikes × 3 modes) to `gex_target_features`. The table carries both the raw scoring inputs (so re-scoring with a new math version is deterministic) and the derived component scores (so queries don't have to reconstruct what the UI was showing). A `math_version` column lets multiple math versions coexist in the table for head-to-head comparison.

### Backfill from Day 1

Backtest must work on the day the component ships. The plan includes:

- A `spx_candles_1m` backfill script that pulls the last 30 days from UW
- A `gex_target_features` backfill script that runs the scoring math over every existing `gex_strike_0dte` snapshot in the last 30 days

Both run once during the Phase 2/3/4 rollout.

### Full-session 1-minute candles in Claude analyze prompt

The analyze endpoint's candle formatter will be rewritten to consume 1-minute candles directly. **No truncation.** The trader explicitly wants Claude to have a granular view of the entire session, and the token cost increase is accepted. This is a deliberate trade-off documented here so future edits don't silently truncate it back.

### Chart library: `lightweight-charts`

The price chart panel (Panel 4) uses TradingView's `lightweight-charts`. Reasons:

- Purpose-built for financial time-series (candles, horizontal price lines, crosshair, zoom/pan)
- ~45kb gzipped, zero peer dependencies
- First-class React wrapper
- Visual match for Wonce's sofbot chart

Hand-rolled SVG was considered and rejected: the chart panel is the visual centerpiece, and hand-rolled OHLC + crosshair + horizontal labels would be 300-500 lines of ongoing maintenance for no benefit.

---

## Component layout (5 panels)

```text
┌─────────────────────────────┬──────────────────────────────────────────┐
│ HEADER: mode toggle OI/VOL/DIR  |  scrubber  |  date picker  |  LIVE   │
├─────────────────────────────┼──────────────────────────────────────────┤
│ PANEL 1: TARGET STRIKE      │ PANEL 4: PRICE CHART                     │
│ - Big headline + WALL label │ - Candles + VWAP                         │
│ - Confidence chip           │ - #1/#2/#3 GEX horizontal lines          │
│ - Component score bars      │ - M+ / M- lines                          │
│ - Key stats                 │ - ZF (gamma flip) line                   │
├─────────────────────────────┤ - Current price marker                   │
│ PANEL 2: 5-MIN URGENCY      │                                          │
│ - Top 5 bars                │                                          │
│ - Δ% over 5-tick window     │                                          │
├─────────────────────────────┤                                          │
│ PANEL 3: 20-MIN SPARKLINES  │                                          │
│ - Top 5 per-strike shape    │                                          │
│ - 20-tick history           │                                          │
│                             │                                          │
├─────────────────────────────┴──────────────────────────────────────────┤
│ PANEL 5: GEX STRIKE BOX (sofbot-style leaderboard)                     │
│ RK | Rank change | Strike | Dist | Δ% | CHEX/DEX/VEX bars | GEX$ | ... │
│ Top 10 strikes ranked by score, with per-row greek bars                │
└────────────────────────────────────────────────────────────────────────┘
```

### Panel responsibilities

| Panel | Answers | Time horizon | Source |
|---|---|---|---|
| 1. Target Strike Tile | "Where is dealer flow pointing?" | Composite | `gex-target.ts` |
| 2. 5-min Urgency | "Which strikes gained attention over 5 ticks?" | 5-tick Δ | `gex-target.ts` |
| 3. 20-min Sparklines | "Which strikes are structurally building?" | 20-tick shape | `gex-target.ts` |
| 4. Price Chart | "Where is price relative to the walls?" | Live tick | `spx_candles_1m` + level math |
| 5. GEX Strike Box | "What's the top-10 board right now?" | 1-tick Δ | `gex-target.ts` |

### Panel 5 vs Panel 2 — why both

Panel 5 is "tick-over-tick (1m) Δ with rank change arrows" — the *now* view, dense with columns (strike, dist, Δ%, greek bars, GEX $, flow C/P, HOT %). Panel 2 is "average Δ over a 5-tick rolling window" — the *recent momentum* view, thin and visual. They're not the same chart at different zooms; they answer different questions. Subagents implementing these panels must preserve that distinction.

### Three greek bars on each row of Panel 5

Each row in Panel 5 shows three thin horizontal bars inline: CHEX (charm), DEX (delta), VEX (vanna). Each bar is green when positive, red when negative, with width proportional to the magnitude. This replaces the "relic" gradient bar from sofbot with three distinct signals the trader can actually read.

---

## Phase sequencing

**Execution model:** phases run sequentially. Within a phase, subagents are dispatched in parallel for independent work items. Between phases, the owner reviews and approves before the next phase begins.

### Phase 0 — Delete old GexMigration

**Owner:** main session (no subagents)
**Blocks:** Phase 1

**Work items:**

1. Delete `src/components/GexMigration/index.tsx`
2. Delete `src/__tests__/components/GexMigration.test.tsx`
3. Delete `src/utils/gex-migration.ts`
4. Delete `src/hooks/useGexMigration.ts` (if it exists — grep to confirm)
5. Remove the `GexMigration` import and usage from `src/App.tsx`
6. Remove any `/api/gex-migration` endpoint if one exists (grep to confirm)
7. Run `npm run lint` to surface any orphaned references
8. Commit as `chore(gex): remove old GexMigration component ahead of GexTarget rebuild`

**Checkpoint:** owner reviews `git diff`, approves, then approves Phase 1.

---

### Phase 1 — Math module + exhaustive tests

**Owner:** 3 subagents in parallel
**Blocks:** Phase 2, 4
**Gated by:** Appendix C (math spec) + Appendix D (test matrix)

The scoring math is the product. This is the highest-leverage, highest-risk piece of the rebuild. Three subagents split the work:

**Subagent 1A — Pure component scorers**

- File: `src/utils/gex-target.ts` (types + component scorers)
- Scope: types (`MagnetFeatures`, `ComponentScores`, `StrikeScore`, `TargetScore`, `Mode`, etc.), the six component scoring functions (`flowConfluence`, `priceConfirm`, `charmScore`, `dominance`, `clarity`, `proximity`), and their unit tests in `src/__tests__/utils/gex-target.components.test.ts`
- Each scorer is a pure function with a clear input/output contract from Appendix C
- Must achieve 100% branch coverage

**Subagent 1B — Feature extraction pipeline**

- File: `src/utils/gex-target.ts` (feature extractor + top-level entry)
- Scope: `extractFeatures(snapshots, mode, strike)`, `pickUniverse(snapshots) → top 10 by |GEX $|`, `scoreStrike(features, weights) → StrikeScore`, `scoreBoard(snapshots, mode) → TargetScore[]`, and the top-level `computeGexTarget(snapshots) → { oi, vol, dir }`
- Tests in `src/__tests__/utils/gex-target.pipeline.test.ts`
- Must achieve 100% branch coverage
- **Must wait for 1A to publish its type signatures** — 1A and 1B overlap in the same file but in different sections. Coordinated via Appendix C being prescriptive about type names.

**Subagent 1C — Integration tests**

- File: `src/__tests__/utils/gex-target.integration.test.ts`
- Scope: end-to-end tests covering every scenario in Appendix D — symmetric call-wall / put-wall cases, churning board with no target, 3-mode divergence, missing horizons (early-morning partial windows), all-negative-charm afternoon, proximity vetoes, NONE tier, etc.
- Uses fixture builders that construct realistic `GexSnapshot` arrays

**Merge step:** main session runs `npm run review` after all three subagents return. Reviewer subagent verdicts must all be `pass` before Phase 2 begins.

**Checkpoint:** owner reviews the test output (especially the component scorer output ranges), approves, moves to Phase 2.

---

### Phase 2 — DB migration

**Owner:** 1 subagent (no parallelization — single migration block)
**Blocks:** Phase 3, 4

**Work items:**

1. Add migration `{ id: 50, description: 'gex_target_features', statements: (sql) => [...] }` to `api/_lib/db-migrations.ts`
2. Add migration `{ id: 51, description: 'spx_candles_1m', statements: (sql) => [...] }` to `api/_lib/db-migrations.ts`
3. Update `api/__tests__/db.test.ts` per the CLAUDE.md migration protocol:
   - Add `{ id: 50 }` and `{ id: 51 }` to the applied-migrations mock
   - Add the migrations to the expected-output list
   - Update the SQL call count (each migration = 1 CREATE + indexes + 1 INSERT)
4. Run `npm run lint` and `npx vitest run api/__tests__/db.test.ts` to verify both files agree

**Schema for `gex_target_features`:**

```sql
CREATE TABLE IF NOT EXISTS gex_target_features (
  id                  SERIAL PRIMARY KEY,
  date                DATE NOT NULL,
  timestamp           TIMESTAMPTZ NOT NULL,
  mode                TEXT NOT NULL CHECK (mode IN ('oi','vol','dir')),
  math_version        TEXT NOT NULL,
  strike              NUMERIC NOT NULL,
  rank_in_mode        SMALLINT NOT NULL,   -- 1..10, ranked by score within this mode
  rank_by_size        SMALLINT NOT NULL,   -- 1..10, ranked by |GEX $|
  is_target           BOOLEAN NOT NULL,    -- true for the top-scoring strike in this mode

  -- raw scoring inputs (enough to re-score deterministically)
  gex_dollars         NUMERIC NOT NULL,
  delta_gex_1m        NUMERIC,             -- null if no prior snapshot
  delta_gex_5m        NUMERIC,
  delta_gex_20m       NUMERIC,
  delta_gex_60m       NUMERIC,
  call_ratio          NUMERIC,             -- flow clarity input, -1..1
  charm_net           NUMERIC,             -- scored in v1 (charmScore)
  delta_net           NUMERIC,             -- stored in v1, NOT scored — reserved for v2 (see Appendix I)
  vanna_net           NUMERIC,             -- stored in v1, NOT scored — reserved for v2 (see Appendix I)
  dist_from_spot      NUMERIC NOT NULL,
  spot_price          NUMERIC NOT NULL,
  minutes_after_noon_ct NUMERIC NOT NULL,  -- for charm time weight

  -- nearest-wall metadata (for futures validation experiments — Appendix B)
  nearest_pos_wall_dist NUMERIC,
  nearest_pos_wall_gex  NUMERIC,
  nearest_neg_wall_dist NUMERIC,
  nearest_neg_wall_gex  NUMERIC,

  -- derived component scores
  flow_confluence     NUMERIC NOT NULL,    -- -1..1
  price_confirm       NUMERIC NOT NULL,    -- -1..1
  charm_score         NUMERIC NOT NULL,    -- -1..1
  dominance           NUMERIC NOT NULL,    -- 0..1
  clarity             NUMERIC NOT NULL,    -- 0..1
  proximity           NUMERIC NOT NULL,    -- 0..1

  -- composite + tier
  final_score         NUMERIC NOT NULL,    -- signed, unbounded in theory
  tier                TEXT NOT NULL CHECK (tier IN ('HIGH','MEDIUM','LOW','NONE')),
  wall_side           TEXT NOT NULL CHECK (wall_side IN ('CALL','PUT','NEUTRAL')),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (date, timestamp, mode, strike, math_version)
);

CREATE INDEX IF NOT EXISTS idx_gex_target_features_date_time
  ON gex_target_features (date, timestamp);
CREATE INDEX IF NOT EXISTS idx_gex_target_features_mode_target
  ON gex_target_features (mode, is_target) WHERE is_target = TRUE;
CREATE INDEX IF NOT EXISTS idx_gex_target_features_math_version
  ON gex_target_features (math_version);
```

**Schema for `spx_candles_1m`:**

```sql
CREATE TABLE IF NOT EXISTS spx_candles_1m (
  id          SERIAL PRIMARY KEY,
  date        DATE NOT NULL,
  timestamp   TIMESTAMPTZ NOT NULL,   -- start_time of the candle
  open        NUMERIC NOT NULL,
  high        NUMERIC NOT NULL,
  low         NUMERIC NOT NULL,
  close       NUMERIC NOT NULL,
  volume      BIGINT NOT NULL,
  market_time TEXT NOT NULL CHECK (market_time IN ('pr','r','po')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (date, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_spx_candles_1m_date_time
  ON spx_candles_1m (date, timestamp);
```

**Checkpoint:** owner reviews the migration SQL, approves, moves to Phase 3.

---

### Phase 3 — SPX candles pipeline

**Owner:** 3 subagents in parallel
**Blocks:** Phase 4 (indirectly, via shared data); analyze endpoint refactor

**Subagent 3A — New `fetch-spx-candles-1m` cron**

- File: `api/cron/fetch-spx-candles-1m.ts`
- Mirrors `fetch-gex-0dte.ts` structure: `cronGuard`, `withRetry`, `checkDataQuality`, Sentry tagging
- Hits `/stock/SPY/ohlc/1m?date=<today>`, translates SPY→SPX via 10x ratio, writes rows to `spx_candles_1m` with `ON CONFLICT (date, timestamp) DO NOTHING`
- Runs every minute during market hours via a new `vercel.json` cron entry
- Tests in `api/__tests__/fetch-spx-candles-1m.test.ts` following the existing cron test pattern (mock `getDb`, `CRON_SECRET` in env, error-path coverage)

**Subagent 3B — Refactor `api/_lib/spx-candles.ts`**

- File: `api/_lib/spx-candles.ts` + `api/_lib/analyze-context.ts` (the consumer)
- Rewrite `fetchSPXCandles()` to read 1-minute rows from `spx_candles_1m` for the requested date, returning the existing `SPXCandle[]` shape
- Fallback to the old live-fetch path only if the table is empty for the requested date (transition safety — this branch should be dead after backfill completes)
- Rewrite `formatSPXCandlesForClaude()` to consume 1-minute candles directly. Update the docstring to note the full-session no-truncation commitment.
- Update the "Recent N candles" table (currently last 12) to show the last 30 candles (= last 30 minutes) instead of last 12 — token budget is not a concern per owner direction
- Existing tests in `api/__tests__/spx-candles.test.ts` get updated for the new data source (mock `getDb`, not `fetch`)

**Subagent 3C — Backfill script**

- File: `scripts/backfill-spx-candles-1m.mjs`
- Iterates the last 30 trading days (skipping weekends; market holidays can be handled by just letting UW return empty and continuing)
- For each date, calls `/stock/SPY/ohlc/1m?date=<day>&limit=500`, translates SPY→SPX, upserts all rows (including `pr`/`po` candles — we filter in the reader, not the writer, so future premarket/postmarket use cases aren't blocked)
- Idempotent via the `(date, timestamp)` unique constraint
- Logs per-date row counts to stdout for progress visibility
- Documented in a `scripts/README.md` entry explaining when to run it and why

**Merge step:** main session runs `npm run review` after all three subagents return. Runs the backfill script once to populate the table, verifies row counts match expectation (~22 trading days × ~780 regular+pre+post candles ≈ 17k rows, of which ~390/day are regular session).

**Checkpoint:** owner verifies backfill row count is sensible and the analyze endpoint still works (spot-check one analyze call against a recent session). Approves, moves to Phase 4.

---

### Phase 4 — Extend cron + features backfill

**Owner:** 2 subagents in parallel
**Blocks:** Phase 5

**Subagent 4A — Extend `fetch-gex-0dte` cron**

- File: `api/cron/fetch-gex-0dte.ts`
- After the existing `storeStrikes` call succeeds, load the snapshot history needed for multi-horizon scoring (last 60 minutes from `gex_strike_0dte` for the same date), run `computeGexTarget(snapshots)` from Phase 1, and upsert the resulting feature rows into `gex_target_features` within the same transaction as the raw snapshot write
- Use a shared transaction so a partial write (raw snapshot committed but features missing) is impossible
- Tag every row with `math_version = 'v1'` from a constant in `gex-target.ts`
- Existing tests in `api/__tests__/fetch-gex-0dte.test.ts` extended to cover the new feature-writing path (mock the scoring function, assert the DB writes with the right shape)

**Subagent 4B — Features backfill script**

- File: `scripts/backfill-gex-target-features.mjs`
- For each trading day in the last 30 days, loads all `gex_strike_0dte` snapshots for that day in chronological order, and for each snapshot runs the *same* feature-computation logic the cron uses (imported from `api/_lib/gex-target.ts` or similar shared location)
- Writes feature rows to `gex_target_features` with the same `math_version` tag the cron uses
- Idempotent via the `UNIQUE (date, timestamp, mode, strike, math_version)` constraint
- Logs per-date snapshot and row counts
- Documented in `scripts/README.md`

**Architectural note:** Subagents 4A and 4B share a helper function for "given a history of snapshots, compute feature rows for the latest one and return DB-ready records." This helper should live in `api/_lib/gex-target-features.ts` (new file) so both the cron and the backfill script import the identical code path. Subagent 4A owns creating this helper; Subagent 4B imports it.

**Merge step:** main session runs `npm run review`. Runs the backfill script once to populate `gex_target_features` (~30 days × ~480 snapshots/day × 30 rows/snapshot ≈ 432k rows). Verifies row count, spot-checks a few target picks against the raw data.

**Checkpoint:** owner verifies backfill worked and spot-checks one or two target picks look sensible. Approves, moves to Phase 5.

---

### Phase 5 — Backend history endpoint

**Owner:** 1 subagent (no parallelization — single endpoint file)
**Blocks:** Phase 6

**Work items:**

1. Create `api/gex-target-history.ts` with `export default async function handler(req, res)`
2. Query params: `date=YYYY-MM-DD` (required), `ts=ISO8601` (optional — if omitted, returns the latest snapshot for the date)
3. Response shape:

   ```ts
   {
     timestamp: string | null,
     timestamps: string[],     // all timestamps for the date, ascending
     spot: number,
     oi:  { target: StrikeScore | null, leaderboard: StrikeScore[] },
     vol: { target: StrikeScore | null, leaderboard: StrikeScore[] },
     dir: { target: StrikeScore | null, leaderboard: StrikeScore[] },
     candles: SPXCandle[],     // 1-minute candles for the session up to `ts` (or full day if ts omitted)
   }
   ```

4. Reads `gex_target_features` for the scored data (pre-baked, fast)
5. Reads `spx_candles_1m` for the candle data (pre-baked, fast)
6. Bot-protected via `checkBot(req)`; add the path to `protect` array in `src/main.tsx`'s `initBotId()` call per CLAUDE.md
7. Owner-gated (guest visitors get empty response or 401 — match the `gex-per-strike` endpoint's policy exactly)
8. Tests in `api/__tests__/gex-target-history.test.ts` covering: live (no `ts`), scrubbed (with `ts`), unknown date, missing auth, empty response

**Checkpoint:** owner tests the endpoint with `curl` against a known date, verifies response shape. Approves, moves to Phase 6.

---

### Phase 6 — `useGexTarget` hook

**Owner:** 1 subagent (no parallelization — single hook file)
**Blocks:** Phase 7

**Work items:**

1. Create `src/hooks/useGexTarget.ts`, structurally identical to `useGexPerStrike.ts`
2. Return shape:

   ```ts
   interface UseGexTargetReturn {
     // all three modes always present — never null, always computed
     oi:  { target: StrikeScore | null, leaderboard: StrikeScore[] },
     vol: { target: StrikeScore | null, leaderboard: StrikeScore[] },
     dir: { target: StrikeScore | null, leaderboard: StrikeScore[] },
     spot: number,
     candles: SPXCandle[],
     timestamp: string | null,
     timestamps: string[],
     selectedDate: string,
     setSelectedDate: (date: string) => void,
     isLive: boolean,
     isScrubbed: boolean,
     canScrubPrev: boolean,
     canScrubNext: boolean,
     scrubPrev: () => void,
     scrubNext: () => void,
     scrubLive: () => void,
     loading: boolean,
     error: string | null,
     refresh: () => void,
   }
   ```

3. Dispatch ladder mirrors `useGexPerStrike` exactly — not-owner → scrubbed → past-date → today-closed → today-open-polling
4. `STALE_THRESHOLD_MS` and `WALL_CLOCK_TICK_MS` constants match `useGexPerStrike` for consistency
5. The mode toggle is **not owned by this hook** — the hook always returns all three modes. The component decides which one to display. This matters for test reuse (switching modes doesn't trigger a refetch) and for ML fidelity (we always have all three).
6. Tests in `src/__tests__/hooks/useGexTarget.test.ts` mirror the `useGexPerStrike.test.ts` structure: mock fetch, verify dispatch ladder, verify scrub behavior, verify freshness check, verify `scrubLive` resets both scrub and date

**Checkpoint:** owner reviews the hook shape and test output. Approves, moves to Phase 7.

---

### Phase 7 — Component shell + 4 non-chart panels

**Owner:** 3 subagents in parallel
**Blocks:** Phase 8

Panels 1, 2, 3, 5 all built in parallel. Panel 4 (price chart) is Phase 8 because `lightweight-charts` integration is self-contained and has its own risk profile.

**Subagent 7A — Panels 1 + 2 (target tile + 5-min urgency)**

- File: `src/components/GexTarget/TargetTile.tsx` (Panel 1) + `src/components/GexTarget/UrgencyPanel.tsx` (Panel 2)
- Target tile shows headline strike, wall label, confidence chip, component score bars (6 thin bars — one per component, green-positive, red-negative, neutral for gates), key stats (5m Δ, 20m Δ, dist, signal conf)
- Urgency panel is a 5-row horizontal bar chart, similar to the old `UrgencyLeaderboard` but reading from the new `StrikeScore` shape and ranked by the new score, not raw Δ%

**Subagent 7B — Panels 3 + 5 (sparklines + GEX strike box)**

- File: `src/components/GexTarget/SparklinePanel.tsx` (Panel 3) + `src/components/GexTarget/StrikeBox.tsx` (Panel 5)
- Sparkline panel shows top 5 strikes with their 20-tick history sparkline, similar to the old `MigrationSparklines`
- Strike box is the dense sofbot-style leaderboard: rank, rank-change arrow, strike, dist, Δ%, three thin greek bars (CHEX/DEX/VEX), GEX $, flow C/P, HOT % OI
- **Each greek bar has an on-hover tooltip explaining what its sign means in trading terms.** Tooltip text is prescribed in Appendix H — subagent renders the exact prose, does not invent wording. The tooltip variant is chosen by sign (positive / negative / near-zero), with the near-zero threshold computed per-greek as the 5th percentile of `|value|` across the universe's 10 strikes.
- This is where most of the information density lives — tight row heights, mono font, small caps

**Subagent 7C — Index composition + header + chart placeholder**

- File: `src/components/GexTarget/index.tsx`
- Composes the 5 panels in the layout from "Component layout" section above
- Header: mode toggle (OI/VOL/DIR, aria-pressed semantics matching the old `ModeToggle`), scrubber buttons (prev/next/live), date picker, LIVE badge
- Panel 4 placeholder: a `<div className="h-full border border-dashed">Price chart — Phase 8</div>` so the layout renders end-to-end without waiting for chart integration
- Consumes `useGexTarget`, picks `oi`/`vol`/`dir` based on the selected mode, passes to the 4 panel sub-components
- Tests in `src/__tests__/components/GexTarget.test.tsx`: render states (live, scrubbed, loading, error, empty), mode toggle switching, scrubber interactions

**Merge step:** main session runs `npm run review`, launches reviewer subagent. Verdict must be `pass` before Phase 8.

**Checkpoint:** owner pulls the branch, looks at the component in dev (with the placeholder chart), gives UX feedback before Phase 8 locks in the chart integration. This is deliberately the last checkpoint before a hard-to-revert decision.

---

### Phase 8 — `lightweight-charts` price chart panel

**Owner:** 1 subagent (no parallelization — single integrated sub-component)
**Blocks:** Phase 9

**Work items:**

1. Add `lightweight-charts` to `package.json` dependencies (check latest stable version at implementation time — context7 lookup)
2. Create `src/components/GexTarget/PriceChart.tsx` replacing the Phase 7 placeholder
3. Render a candlestick chart from `useGexTarget.candles`
4. Compute and render horizontal overlay lines for the currently-selected mode:
   - **#1 / #2 / #3 GEX** — top 3 strikes by `gex_dollars` from the mode's leaderboard (different line styles per rank)
   - **M+** — strike with max call volume across all top-10 strikes
   - **M-** — strike with max put volume across all top-10 strikes
   - **ZF** — zero flip, computed as the strike where cumulative signed gamma crosses zero (pure function added to `gex-target.ts` in a minor amendment)
5. Render a VWAP line from candle data (formula: `sum((h+l+c)/3 * vol) / sum(vol)` over the session)
6. Crosshair + tooltip showing OHLC + time
7. Switching modes updates the overlay lines without re-rendering the chart (library supports `updatePriceLine()` style mutations)
8. Tests in `src/__tests__/components/PriceChart.test.tsx` — render test, overlay line computation test, mode switching test
9. Visual sub-spec in **Appendix A** (line colors, styles, label positions)

**Known risk:** `lightweight-charts` may have React ergonomic issues under Vite + React 19. If the library can't be integrated cleanly, fallback is a hand-rolled SVG chart (rejected in architectural commitments but available as escape hatch). This should be raised as a blocker to the owner before consuming more than a day of implementation time.

**Checkpoint:** owner reviews the chart visually against Wonce's sofbot screenshot. Approves, moves to Phase 9.

---

### Phase 9 — Integration + full review

**Owner:** main session (no subagents)
**Blocks:** Phase 10

**Work items:**

1. Wire `GexTarget` into `src/App.tsx` in the same slot the old `GexMigration` occupied
2. Run `npm run review` (full: tsc + eslint + prettier + vitest --coverage)
3. Fix any failures, re-run
4. Launch a reviewer subagent per CLAUDE.md Get-It-Right workflow with `git diff` scope
5. Address any `continue` feedback; on `refactor` verdict, escalate to owner
6. Commit the full feature branch

**Checkpoint:** owner merges or requests changes.

---

### Phase 10 — Backtest session + weight tuning

**Owner:** main session + owner
**Blocks:** nothing (end of this plan)

**Work items:**

1. Pick a trading day from last week with known price action (ideally one where the owner remembers what happened)
2. Load the component in backtest mode, scrub through the session tick-by-tick
3. Owner notes which target picks felt right, which felt wrong, and why
4. Identify any weight adjustments needed (starting weights: `[0.40, 0.25, 0.20, 0.15]` for flow/price/charm/clarity)
5. If adjustments are needed, commit a tuning pass: update `MIGRATION_CONFIG` constants in `gex-target.ts`, bump `math_version` to `v2`, re-run the backfill script to produce v2 rows alongside v1, re-test
6. Document the tuning rationale in a comment at the top of `gex-target.ts` so future-you knows why the weights are what they are

**Checkpoint:** owner declares the rebuild complete.

---

## Appendices

### Appendix A — Visual language for the chart overlay

Colors and styles for the Panel 4 overlay lines, to be implemented in Phase 8.

| Element | Color | Style | Label |
|---|---|---|---|
| Candles | default green/red | solid | none |
| VWAP | amber (`theme.chartAmber`) | dashed (2px) | "VWAP" right-anchored |
| #1 GEX | bright green | solid 2px | "#1 GEX <strike>" left-anchored |
| #2 GEX | medium green | solid 1.5px | "#2 GEX <strike>" left-anchored |
| #3 GEX | dim green | solid 1px | "#3 GEX <strike>" left-anchored |
| M+ (max call vol) | bright cyan | dashed 2px | "M+ <strike>" right-anchored |
| M- (max put vol) | bright magenta | dashed 2px | "M- <strike>" right-anchored |
| ZF (gamma flip) | amber | dotted 1.5px | "ZF <strike>" left-anchored |
| Current price | white | horizontal scale marker | auto |

If the user selects a non-default mode (VOL or DIR), the #1/#2/#3 GEX lines recompute from that mode's top-3 strikes and the lines animate to their new positions. M+/M-/ZF do not change with mode — they're cross-mode structural levels.

### Appendix B — Futures validation experiments (deferred)

These experiments are **not built in this plan**. They're documented here as a methodology so when the owner comes back to them in 4-6 weeks with 30+ days of `gex_target_features` accumulated, the hypotheses, queries, and success criteria are already written down.

**Prerequisites:**

- `gex_target_features` table populated with ≥30 days of trading sessions
- Databento sidecar streaming 1-minute ES tick data for the same window
- A `futures_ticks_1m` table (or equivalent) on the app side with aggregated tick data joinable by timestamp

**Experiment 1 — Does realized vol drop near big positive-gamma strikes?**

*Hypothesis:* When price is within 5 pts of a >$1M positive-gamma wall, 1-minute realized volatility is materially lower than when price is far from any wall or near a negative-gamma wall.

*Query sketch:*

```sql
WITH labeled_minutes AS (
  SELECT
    f.timestamp,
    f.nearest_pos_wall_dist,
    f.nearest_pos_wall_gex,
    f.nearest_neg_wall_dist,
    f.nearest_neg_wall_gex,
    -- compute realized vol from futures ticks in that minute
    stddev_samp(ticks.log_return) * sqrt(60) AS realized_vol_1m
  FROM gex_target_features f
  JOIN futures_ticks_1m ticks
    ON ticks.timestamp = f.timestamp
  WHERE f.mode = 'oi' AND f.rank_in_mode = 1
  GROUP BY 1,2,3,4,5
)
SELECT
  CASE
    WHEN abs(nearest_pos_wall_dist) < 5 AND nearest_pos_wall_gex > 1e6 THEN 'near_pos_wall'
    WHEN abs(nearest_neg_wall_dist) < 5 AND abs(nearest_neg_wall_gex) > 1e6 THEN 'near_neg_wall'
    ELSE 'free_air'
  END AS bucket,
  median(realized_vol_1m),
  percentile_cont(0.25) WITHIN GROUP (ORDER BY realized_vol_1m),
  percentile_cont(0.75) WITHIN GROUP (ORDER BY realized_vol_1m),
  count(*)
FROM labeled_minutes
GROUP BY 1;
```

*Success criterion:* median realized vol in the `near_pos_wall` bucket is at least 30% lower than the `free_air` bucket, with a Mann-Whitney U test `p < 0.05`.

*What to do if it fails:* The scoring math still has value for picking growing flow, but the "dealer hedging suppresses vol" premise is weaker in your data than expected. Deprioritize the futures-confirmation layer; keep the scoring.

**Experiment 2 — Does taker/maker imbalance flip near gamma strikes?**

*Hypothesis:* Near positive-gamma walls, taker-buy ratio drifts toward 0.5 (neutral, dealers passive). Near negative-gamma walls, taker-buy ratio becomes more extreme (one-sided, dealers aggressive).

*Requires:* taker-side inference on every futures tick (`trade price closer to bid = taker sell, closer to ask = taker buy`). Databento L1 data is sufficient.

*Success criterion:* distribution of `taker_buy_ratio` in the `near_pos_wall` bucket is visibly more concentrated around 0.5 than in the `near_neg_wall` bucket.

**Experiment 3 — Can we predict reversal at a positive-gamma wall from tape alone?**

*Hypothesis:* In the 1-minute window before price reverses at a >$1M positive-gamma wall, there's a detectable signature in L1 data (depth stack thickening on the far side, taker ratio flipping, print sizes trending down).

*Method:*

1. Label every "price touched within 3pts of a >$1M pos-gamma wall and then reversed" event in the last 30 days as positive examples.
2. Label "price touched a wall and broke through" as negative examples.
3. For the minute before each touch, extract L1 features: bid/ask depth at top 5 levels, taker-buy ratio, print size p95, spread width.
4. Train a logistic regression predicting `will_reverse`.

*Success criterion:* model ROC-AUC > 0.65 on a holdout set. Anything above that is a tradable edge.

*This is the highest-value experiment.* Success means the owner can use the ES tape to confirm or reject a target pick from the component *before* entering a trade.

### Appendix C — Scoring math formal specification

**This is the canonical source for the Phase 1 implementation.** Subagents 1A and 1B read from this spec directly.

#### C.1 — Types

```ts
export type Mode = 'oi' | 'vol' | 'dir';

export type WallSide = 'CALL' | 'PUT' | 'NEUTRAL';

export type Tier = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

/** Raw per-strike features extracted from a snapshot sequence for one mode. */
export interface MagnetFeatures {
  strike: number;
  spot: number;
  distFromSpot: number;
  gexDollars: number;              // signed; positive = net long, negative = net short
  deltaGex_1m: number | null;      // signed Δ vs 1-minute-prior snapshot
  deltaGex_5m: number | null;
  deltaGex_20m: number | null;
  deltaGex_60m: number | null;
  callRatio: number;               // (callVol - putVol) / (callVol + putVol), in [-1, 1]
  charmNet: number;                // net charm at strike, signed — scored in v1
  deltaNet: number;                // net DEX at strike, signed — stored in v1, NOT scored (see Appendix I)
  vannaNet: number;                // net VEX at strike, signed — stored in v1, NOT scored (see Appendix I)
  minutesAfterNoonCT: number;      // 0 at noon, 180 at 3pm CT, clamped [0, 180]
  prevGexDollars: number | null;   // for growth_pct computation
}

export interface ComponentScores {
  flowConfluence: number;   // -1..1
  priceConfirm: number;     // -1..1
  charmScore: number;       // -1..1
  dominance: number;        // 0..1
  clarity: number;          // 0..1
  proximity: number;        // 0..1
}

export interface StrikeScore {
  strike: number;
  features: MagnetFeatures;
  components: ComponentScores;
  finalScore: number;       // signed
  tier: Tier;
  wallSide: WallSide;
  rankByScore: number;      // 1..10 within the mode
  rankBySize: number;       // 1..10 by |gexDollars|
  isTarget: boolean;        // true for the #1 by score, if tier !== 'NONE'
}

export interface TargetScore {
  target: StrikeScore | null;
  leaderboard: StrikeScore[];  // always length ≤ 10, sorted by finalScore desc
}
```

#### C.2 — Universe selection

Given a current snapshot, select the top 10 strikes by `|gex_dollars|` (in the selected mode's column set). This is the universe. All scoring is done within this universe; strikes outside it are ignored.

Rationale: a strike that doesn't have meaningful standing gamma isn't worth analyzing regardless of how its flow looks. This is the "admission ticket" principle from the design discussion.

#### C.3 — Component scorers

**C.3.1 — `flowConfluence(features) → [-1, 1]`**

```typescript
weights = normalize([1, 1/5, 1/20, 1/60])  // precomputed constant
         = [0.789, 0.158, 0.039, 0.014]

deltas = [deltaGex_1m, deltaGex_5m, deltaGex_20m, deltaGex_60m]

// Missing horizons (null) contribute 0 and their weight is redistributed
// proportionally over the remaining horizons.
available = deltas.map((d, i) => d == null ? null : { delta: d, weight: weights[i] })
            .filter(x => x != null)
if (available.length === 0) return 0

total_weight = sum(available.map(a => a.weight))
renorm = available.map(a => ({ delta: a.delta, weight: a.weight / total_weight }))

// Signed weighted sum of Δ% values — requires prevGexDollars to convert $ to %.
if (prevGexDollars == null || prevGexDollars === 0) return 0

pct_deltas = renorm.map(r => ({
  pct: r.delta / abs(prevGexDollars),  // Δ% of prior size
  weight: r.weight
}))

weighted_pct = sum(pct_deltas.map(p => p.pct * p.weight))

// Squash to [-1, 1] via tanh with a scale constant.
// SCALE_FLOW_PCT = 0.30 → ±30% weighted Δ maps to ~tanh(1) ≈ 0.76
return tanh(weighted_pct / 0.30)
```

**C.3.2 — `priceConfirm(features) → [-1, 1]`**

Requires access to `deltaSpot_1m`, `deltaSpot_3m`, `deltaSpot_5m` — spot price changes over the same horizons. These are computed once per snapshot at the board level and passed into the per-strike scorer (not per-strike inputs, since spot is the same for all strikes).

```typescript
// Spot moves are passed as arguments, not from MagnetFeatures
priceMove = 0.5 * deltaSpot_1m + 0.3 * deltaSpot_3m + 0.2 * deltaSpot_5m

if (priceMove === 0) return 0

toward = sign(strike - spot)  // +1 if strike above spot, -1 if below

// Magnitude scaled: SCALE_PRICE = 3.0 → a 3-pt recent move is "significant"
magnitude = tanh(abs(priceMove) / 3.0)

return magnitude * sign(priceMove) * toward
```

**C.3.3 — `charmScore(features) → [-1, 1]`**

```typescript
// Time weight: floor of 0.3, rises linearly to 1.0 at 3pm CT
todWeight = max(0.3, min(1.0, minutesAfterNoonCT / 180))

// Charm sign must match gamma sign for positive contribution
// (positive gamma + positive charm = decay supporting the magnet)
charmSign = sign(gexDollars) * sign(charmNet)

// Magnitude scaled
charmMag = tanh(abs(charmNet) / SCALE_CHARM)  // SCALE_CHARM TBD at implementation time

return charmSign * charmMag * todWeight
```

`SCALE_CHARM` is the 90th percentile of `abs(charmNet)` across a sample of snapshots from the existing data. Subagent 1A computes this empirically during implementation and hard-codes the constant with a code comment explaining the methodology.

**C.3.4 — `dominance(features, peerGexDollars) → [0, 1]`**

`peerGexDollars` is the array of `|gex_dollars|` for all 10 strikes in the universe.

```typescript
peerMedian = median(peerGexDollars)
peerMax = max(peerGexDollars)
peerRange = peerMax - peerMedian

if (peerRange === 0) return 0.5  // degenerate case: all strikes equal

raw = (abs(gexDollars) - peerMedian) / peerRange
return clamp(raw, 0, 1)
```

**C.3.5 — `clarity(features) → [0, 1]`**

```typescript
return abs(callRatio)  // already in [-1, 1], we want magnitude
```

A strike with 95% call volume has `callRatio ≈ 0.9`, `clarity = 0.9`. A 50/50 strike has `clarity = 0`.

**C.3.6 — `proximity(features) → [0, 1]`**

```typescript
SIGMA = 15  // points
return exp(-(distFromSpot ** 2) / (2 * SIGMA ** 2))
```

At 0 pts: 1.0. At 15 pts: 0.61. At 30 pts: 0.14. At 45 pts: 0.01.

#### C.4 — Composite score

```typescript
// Weights
W1 = 0.40  // flow confluence term
W2 = 0.25  // price confirmation term
W3 = 0.20  // charm term
W4 = 0.15  // clarity bonus/penalty

finalScore =
    W1 * flowConfluence * dominance * proximity
  + W2 * priceConfirm   * dominance * proximity
  + W3 * charmScore     * proximity
  + W4 * (clarity - 0.5)
```

Range in practice: roughly `[-0.85, +0.85]` given component bounds.

#### C.5 — Tier assignment

```typescript
abs_score = abs(finalScore)

if      (abs_score > 0.50) tier = 'HIGH'
else if (abs_score > 0.30) tier = 'MEDIUM'
else if (abs_score > 0.15) tier = 'LOW'
else                       tier = 'NONE'
```

#### C.6 — Wall side assignment

```typescript
if (tier === 'NONE')        wallSide = 'NEUTRAL'
else if (gexDollars > 0)    wallSide = 'CALL'
else if (gexDollars < 0)    wallSide = 'PUT'
else                        wallSide = 'NEUTRAL'
```

Wall side is derived from the sign of `gex_dollars` at the strike, not from the sign of `finalScore`. A growing call wall and a dying call wall both have `wallSide = 'CALL'`; the difference is in `finalScore` (positive for growing, negative for dying).

#### C.7 — Target selection

```typescript
// After all 10 strikes in the universe are scored:
leaderboard = allScores.sort((a, b) => abs(b.finalScore) - abs(a.finalScore))
leaderboard = leaderboard.map((s, i) => ({ ...s, rankByScore: i + 1 }))

topStrike = leaderboard[0]
target = topStrike.tier === 'NONE' ? null : topStrike
```

If the top strike has tier `NONE`, the target is `null` — the component renders "board churning, no target." This is the first-class "no confluence" case.

#### C.8 — Three-mode pipeline

```ts
function computeGexTarget(snapshots: GexSnapshot[]): {
  oi: TargetScore;
  vol: TargetScore;
  dir: TargetScore;
} {
  return {
    oi:  scoreMode(snapshots, 'oi'),
    vol: scoreMode(snapshots, 'vol'),
    dir: scoreMode(snapshots, 'dir'),
  };
}
```

Each mode reads its own column set (see the "Three parallel scoring modes" architectural commitment) and produces an independent `TargetScore`. The three are not combined — the component decides which one to display, and the ML pipeline trains on all three in parallel.

### Appendix D — Test matrix for Phase 1

Exhaustive case list for the Phase 1 subagents. Every case listed here must have at least one test.

**C.3.1 — flowConfluence**

- All four horizons agree positive, moderate magnitudes → score between 0.6 and 0.9
- All four horizons agree negative, moderate magnitudes → score between -0.9 and -0.6
- All positive but tiny (Δ% < 1%) → score near 0
- Mixed signs (1m+, 5m-, 20m+, 60m-) → score near 0
- Missing 20m and 60m (early session) → score computed on 1m+5m with reweighted weights, total_weight preserved
- prevGexDollars null → score 0
- prevGexDollars 0 → score 0
- All horizons null → score 0

**C.3.2 — priceConfirm**

- Strike above spot, price rallying → positive score
- Strike below spot, price rallying → negative score
- Strike above spot, price falling → negative score
- Strike below spot, price falling → positive score
- Price flat (all deltaSpot = 0) → score 0
- Strike exactly at spot (dist = 0, sign = 0) → score 0

**C.3.3 — charmScore**

- Positive gamma, positive charm, 3pm CT → score near +1 (aligned and fully weighted)
- Positive gamma, negative charm, 3pm CT → score near -1 (fighting and fully weighted)
- Positive gamma, negative charm, noon CT → score ≈ -0.3 (fighting but time-weighted down)
- Positive gamma, positive charm, 10am CT → score ≈ +0.3 (aligned but time-weighted down)
- charmNet = 0 → score 0
- gexDollars = 0 → score 0 (sign(0) = 0)

**C.3.4 — dominance**

- This strike is the biggest by |GEX $| → score = 1.0
- This strike is the median → score = 0.0
- This strike is smaller than the median → score = 0 (clamped, not negative)
- Degenerate: all 10 strikes equal → score = 0.5

**C.3.5 — clarity**

- 100% call volume → score ≈ 1.0
- 100% put volume → score ≈ 1.0
- 50/50 split → score = 0.0
- callRatio undefined (zero total volume) → score 0 (handled in feature extractor, not scorer)

**C.3.6 — proximity**

- dist = 0 → score = 1.0
- dist = 15 → score ≈ 0.61
- dist = 30 → score ≈ 0.14
- dist = 100 → score ≈ 0

**C.4 — composite**

- All factors aligned positive → finalScore roughly 0.6-0.8
- flowConfluence positive but dominance = 0 → flow term contribution = 0 (multiplicative gate test)
- flowConfluence positive but proximity = 0 → flow term contribution = 0 (multiplicative gate test)
- priceConfirm positive, everything else 0 → finalScore = W2 × priceConfirm × dom × prox

**C.5 — tier assignment**

- finalScore = 0.51 → HIGH
- finalScore = -0.51 → HIGH (abs value)
- finalScore = 0.31 → MEDIUM
- finalScore = 0.16 → LOW
- finalScore = 0.14 → NONE
- finalScore = 0 → NONE

**C.6 — wall side**

- tier NONE → wallSide NEUTRAL regardless of gamma sign
- tier HIGH, gexDollars > 0 → wallSide CALL
- tier HIGH, gexDollars < 0 → wallSide PUT
- tier HIGH, gexDollars = 0 → wallSide NEUTRAL

**C.7 — target selection**

- Top strike has tier HIGH → target = top strike
- Top strike has tier NONE → target = null
- Empty universe (no snapshots) → target = null, leaderboard = []

**C.8 — three-mode integration**

- Snapshots where OI, VOL, DIR all pick the same target → all three TargetScores agree
- Snapshots where OI picks strike A, VOL picks strike B, DIR picks nothing → three independent results, no cross-contamination
- Snapshots with only OI data populated (e.g., VOL columns all zero because no volume traded yet) → VOL returns empty leaderboard, OI and DIR unaffected

**Integration scenarios (Appendix D end-to-end, Subagent 1C)**

- Symmetric case: call wall forming above spot, growing across all horizons → HIGH CALL target
- Symmetric case: put wall forming below spot, growing across all horizons (negative direction) → HIGH PUT target
- Churning board: random deltas, no dominant trend → no target, all tiers NONE or LOW
- Morning partial window: only 1m and 5m data present (session started 5 min ago) → scoring works with reduced horizons
- Afternoon charm kill: positive gamma growing but charm is deeply negative at 2:30 CT → flow term positive, charm term large negative, net finalScore much lower than pure-flow case
- Proximity veto: perfect scores on every other factor, strike 40pts from spot → finalScore near 0 because proximity ≈ 0.03

### Appendix E — Known limitations and future work

Documented for transparency. None block this rebuild; all are candidates for follow-up plans.

1. **Chart library bundle size.** `lightweight-charts` adds ~45kb gzipped. Accepted because the component is the visual centerpiece. Could be lazy-loaded via dynamic import if bundle size becomes a concern.

2. **`dist` mode completeness.** The directionalized mode (`call_gamma_ask + call_gamma_bid + put_gamma_ask + put_gamma_bid`) uses bid/ask-split data that's thinner than OI-based data in low-volume periods. DIR scoring may produce NONE tiers more often than OI/VOL, especially in the first hour. This is expected behavior; the owner will learn to interpret NONE tiers in DIR as "not enough directional info yet."

3. **No cross-day history.** The hook loads only the current date's snapshots. Multi-day patterns (e.g., "this strike has been building for three sessions") are not computed. If this becomes important, the feature extractor can be extended to load priors without schema changes.

4. **Backfill granularity.** The `gex_target_features` backfill uses the same math the live cron uses, tagged with the same `math_version`. If the owner changes the math later, the old rows are orphaned at `v1` and the new rows start at `v2`. The ML pipeline can query `WHERE math_version = 'v2'` to get consistent training data. A "retire v1" backfill is a one-script operation.

5. **Panel 4 mode-switching animation.** `lightweight-charts` supports updating price lines imperatively, but the animation may not be perfectly smooth when three modes are cycled rapidly. Acceptable for the MVP; revisit if visual jank bothers the owner.

6. **Single-owner assumption.** The entire component is owner-gated; guests see empty data. Matches the existing `GexPerStrike` policy. No multi-user concerns.

### Appendix F — ML pipeline (deferred)

Documented for implementation later. Not built in this plan.

**Prerequisites:**

- `gex_target_features` table populated with ≥30 days of sessions
- A labeling job that joins features against price data to produce outcome labels
- A target variable definition agreed between the owner and the ML implementer

**Suggested target variables (pick one to start):**

- `did_pin_within_5pts_by_close` — binary, did spot close within 5 pts of the target strike
- `max_favorable_excursion_bps` — continuous, max % move toward the target in the 30 min after the pick
- `direction_correct_at_close` — binary, did price move in the predicted direction by close

**Labeling job structure (nightly cron):**

```sql
UPDATE gex_target_features
SET did_pin_within_5pts_by_close = (
  abs(close_price_at_4pm_et - strike) < 5
)
WHERE date = yesterday() AND did_pin_within_5pts_by_close IS NULL;
```

(`close_price_at_4pm_et` comes from joining against `spx_candles_1m` for the 15:59 timestamp.)

**Classifier approach — phased:**

1. **Baseline (week 1):** logistic regression on the 6 component scores + `rank_by_size` + `dist_from_spot` + `minutes_after_noon_ct`. Interpretable, fast, sets the bar.
2. **Intermediate (week 2):** gradient-boosted trees (XGBoost) on the same features. Expect 5-10% AUC improvement.
3. **Advanced (month 2):** add the nearest-wall features from Appendix B experiment design, add ES tape features if Experiment 3 shows signal, try per-mode models with ensemble voting.

**Three models, one per mode, ensemble voting:** the right approach given the "three modes as labels" architectural choice. Train `oi_model`, `vol_model`, `dir_model` independently on their mode's rows. At inference time, compute all three predictions and output:

- `consensus_yes` (all three agree on target) → highest confidence
- `majority_yes` (2 of 3) → medium
- `split` (1 of 3 or less) → low / no-trade

Consensus disagreement itself becomes a useful signal: "when OI and VOL agree but DIR disagrees, what's the base rate?" is an honest question the data can answer.

**Integration with the component:** once a classifier is trained, add a small `ML` chip next to the confidence tier in Panel 1 showing the model's prediction. This is purely informational — the heuristic score remains primary. If the ML consistently outperforms the heuristic across ≥60 days of out-of-sample data, *then* consider making ML the primary scorer with the heuristic as fallback.

**Do not:**

- Train on less than 30 days of data (overfit risk is enormous)
- Change the scoring math frequently without bumping `math_version` (breaks retrospective analysis)
- Mix modes in a single model without the `mode` categorical feature
- Remove the heuristic scorer once ML is live — the interpretable baseline is the safety net

---

### Appendix G — Rollback plan

If the rebuild goes sideways at any point, the rollback is straightforward because the old component was deleted in Phase 0 before anything new was built, but the git history retains it.

**Full rollback (nuclear):**

```bash
git revert <phase-9-integration-commit>
# Old GexMigration was deleted in Phase 0, so the revert brings it back.
# The new `gex_target_features` and `spx_candles_1m` tables stay populated
# (no harm), and the crons keep writing to them (also no harm).
# The new component is uninstalled from App.tsx.
```

**Partial rollback (keep backend, remove frontend):**

```bash
git revert <phase-9-commit>  # drops the App.tsx wire-up
# Keep the hook, component, and endpoint untouched — they just aren't rendered
# anywhere. Useful if the UI is broken but the data layer is fine.
```

**Data rollback:**
The `gex_target_features` and `spx_candles_1m` tables can be dropped and re-backfilled from raw data at any time. The raw `gex_strike_0dte` table is the source of truth and is never modified by this plan.

### Appendix H — Greek bar tooltip prose (Panel 5)

**Prescriptive for Subagent 7B.** Render the exact prose below, do not invent wording. Tooltip variant is chosen per-bar by the sign of that greek at that strike, with a near-zero threshold computed as the 5th percentile of `|value|` across the current universe's 10 strikes. If the greek's magnitude falls below that per-greek threshold, render the near-zero variant.

#### H.1 — CHEX (charm) tooltips

**Positive charm (`charm_net > +threshold`):**

> **Positive Charm · selling pressure into expiration**
> Dealers at this strike need to sell the underlying as time passes to stay hedged. This creates passive downward pressure as 0DTE approaches expiry, even without a change in the underlying price.

**Negative charm (`charm_net < -threshold`):**

> **Negative Charm · buying pressure into expiration**
> Dealers at this strike need to buy the underlying as time passes to stay hedged. This creates passive upward pressure as 0DTE approaches expiry — often the biggest tailwind for pins in the 2pm–close window.

**Near-zero charm (`|charm_net| ≤ threshold`):**

> **Charm near zero**
> No meaningful time-decay pressure from dealer hedging at this strike. The magnet isn't being reinforced or dismantled by the passage of time alone.

#### H.2 — DEX (delta) tooltips

**Positive DEX (`delta_net > +threshold`):**

> **Positive DEX · resistance / supply overhead**
> Dealers are net long delta at this strike — typically from customers buying puts. They've already shorted the underlying as a hedge. As price approaches this strike, those short hedges lean on supply and create resistance.
> Unlike charm and vanna, DEX doesn't generate new flow — it tells you where the hedges already live. The flow shows up when spot, vol, or time moves those hedges around.

**Negative DEX (`delta_net < -threshold`):**

> **Negative DEX · support / demand underneath**
> Dealers are net short delta at this strike — often from customers selling calls or from calls dealers are short. They're already long the underlying as a hedge. As price drops toward this level, those long hedges anchor the tape and create support.
> DEX doesn't generate new flow — it tells you where the hedges already live.

**Near-zero DEX (`|delta_net| ≤ threshold`):**

> **DEX near zero**
> No concentrated dealer directional exposure at this strike. It's unlikely to behave as support or resistance based on hedge positioning alone.

#### H.3 — VEX (vanna) tooltips

**Positive VEX (`vanna_net > +threshold`):**

> **Positive VEX · selling pressure on vol expansion**
> A rise in implied volatility forces dealers at this strike to sell the underlying to stay hedged. When VIX expands — headlines, support cracks, fear bids — dealers mechanically hit bids, amplifying selloffs. Part of why vol spikes and price drops reinforce each other on the way down.

**Negative VEX (`vanna_net < -threshold`):**

> **Negative VEX · buying pressure on vol crush**
> A drop in implied volatility forces dealers at this strike to buy the underlying to stay hedged. This is the classic "vol crush rally" — VIX falls, dealers lift offers mechanically, price drifts higher with no catalyst. Strongest after fear spikes unwind (post-FOMC, post-CPI, Monday-morning weekend-premium decay).

**Near-zero VEX (`|vanna_net| ≤ threshold`):**

> **VEX near zero**
> This strike won't generate meaningful dealer flow from vol changes. Less interesting around VIX moves, OPEX, or vol-crush events.

#### H.4 — Implementation notes for Subagent 7B

1. **Threshold computation:** each greek has an independent near-zero threshold computed once per render from the universe (10 strikes). Use `quantile(abs_values, 0.05)` — the 5th percentile of absolute values. Fall back to a hard floor of `1e-6` if the computed threshold is zero (degenerate case when most strikes have exactly-zero greeks).
2. **Tooltip library:** reuse whatever tooltip primitive already exists in the codebase (check `src/components/ui/` first). If no primitive exists, use a plain `title` attribute for v1 — good-enough accessibility, zero dependencies, ugly but functional. A proper hover tooltip with styled body can be a v2 polish.
3. **Cross-cousin context (do not put in the tooltip):** vanna and charm are close cousins — charm is delta decay driven by time, vanna is delta decay driven by vol. On a 0DTE morning with elevated VIX, both are firing at once, which is why the pre-10:30 CT tape so often drifts in the direction of the biggest negative-VEX / negative-CHEX strikes. This context is for the subagent's understanding — it's too dense for a hover tooltip.
4. **Accessibility:** every tooltip must be reachable via keyboard (focusable bar element) and announced to screen readers. A `title` attribute gets this for free; a custom tooltip component must wire `aria-describedby`.

### Appendix I — Scoring math v2: DEX and VEX integration (deferred)

**Status:** Non-blocking for Phase 0/1. Revisit in Phase 10 with a decision.

**Context.** Scoring math v1 (Appendix C) uses gamma centrally (as `gex_dollars`, which drives flowConfluence, dominance, proximity, and wallSide) and charm explicitly (`charmScore`, time-weighted and sign-aware). It does **not** use delta exposure (DEX / `delta_net`) or vanna (VEX / `vanna_net`) in the composite score — those two greeks are stored in `gex_target_features` and rendered in Panel 5 as display bars with tooltips (Appendix H), but they have zero weight in `finalScore`.

This is a deliberate v1 scoping decision, not an oversight. The owner's greek primer articulates clearly why both DEX and VEX matter for dealer-behavior prediction:

- **DEX** tells you where hedges *already live*. Large positive DEX creates resistance from dealer shorts; large negative DEX creates support from dealer longs. It's positional, not momentum-based — different flavor of signal from the flow-confluence math.
- **VEX** tells you how dealer positioning shifts under IV changes. Strongest around VIX moves, OPEX, vol-crush events. Background noise in flat-VIX regimes; dominant signal in vol-spike minutes.

The question is not *whether* to incorporate them — we will — but *how and when*.

#### I.1 — Three open design questions

**Q1. Should DEX and VEX be their own composite terms, or should they modulate existing terms?**

Option A (dedicated terms):

```text
score =
    W1 * flowConfluence * dominance * proximity
  + W2 * priceConfirm   * dominance * proximity
  + W3 * charmScore     * proximity
  + W4 * (clarity - 0.5)
  + W5 * dexPressure    * proximity           // NEW
  + W6 * vexPressure    * proximity           // NEW
```

- **Pro:** clean, additive, each term independently testable, weights fully explicit
- **Pro:** the ML pipeline can later learn the optimal weights per-term
- **Con:** six weights add up — every new term dilutes the flow-confluence backbone unless W1 is re-scaled

Option B (modulation):

DEX and VEX adjust the *weights* of other terms rather than contributing their own. Example: "if DEX is strongly negative at this strike, amplify the proximity term because the strike behaves more like a standing support level that price approaches." Implementation would look like `W_prox_eff = W_prox * (1 + k * abs(dexNormalized))`.

- **Pro:** fewer terms in the composite, more intuitive ("DEX makes this strike matter more")
- **Con:** harder to test, harder to explain, harder for ML to decompose into feature importance
- **Con:** sneaky — a single column's value secretly moves multiple weights

**Recommendation for v2:** Option A. Every modulation can be re-expressed as an additive term with a small penalty, and the architectural clarity of additive terms is worth a few extra lines of weight-tuning. Modulation is a premature abstraction.

---

**Q2. Should VEX be regime-gated by IV movement?**

VEX-driven dealer flow only happens when IV is actually moving. In a flat-VIX afternoon, VEX is background; in a VIX-spike minute, VEX is dominant. This is structurally analogous to charm's time-of-day weighting: charm matters more at 2pm than 10am, VEX matters more when `|ΔVIX / Δt|` is large.

Proposed weighting (sketch):

```text
vixVelocity = abs(VIX_now - VIX_5m_ago)   // points per 5 min
volRegimeWeight = clamp01(vixVelocity / 1.0)   // 1 VIX point / 5 min = fully weighted
vexSign = sign(vannaNet)
vexMag = tanh(abs(vannaNet) / SCALE_VANNA)
vexPressure = vexSign * vexMag * volRegimeWeight   // in [-1, 1]
```

- **Pro:** matches trading reality — VEX doesn't do anything when vol is flat
- **Pro:** frees w6 in Q1 from dominating the score during calm sessions
- **Con:** requires VIX data inside the scoring function. We have VIX data (there's a VIX strip in the app header already) but it's not currently passed into the gex-target math module. Plumbing lift: one extra arg through the snapshot chain.

**Recommendation for v2:** yes, regime-gate VEX. The volRegimeWeight term makes VEX self-silencing during chop sessions, which is exactly right.

---

**Q3. Should DEX be unsigned in the composite but signed for display?**

This is the subtlest question of the three. DEX tells you *where hedges already live*, not *which direction flow is pushing*. A strike with `dexNet < 0` is support regardless of whether the flow is currently adding or draining its gamma exposure. That's different from every other term in the v1 spec:

- `flowConfluence` is signed — direction matters (growing vs dying)
- `priceConfirm` is signed — direction matters (moving toward vs away)
- `charmScore` is signed — direction matters (time decay helping vs fighting)
- `clarity` is unsigned — magnitude matters, direction derives from callRatio sign elsewhere
- `dominance` and `proximity` are unsigned — they're gates

DEX is a **presence term**. It says "this strike is structurally important because of where the hedges are." Whether a strike is support or resistance is derived from the sign of `dexNet`, but that's a display concern (which side of spot is support, which is resistance), not a composite-score concern.

Proposed treatment:

```text
// Unsigned presence contribution to the composite
dexPressure = tanh(abs(dexNet) / SCALE_DEX)   // in [0, 1]

// Sign carried separately for display/wallSide refinement
dexSide = dexNet > 0 ? 'RESISTANCE' : dexNet < 0 ? 'SUPPORT' : 'NEUTRAL'
```

This is asymmetric with the rest of the terms and deserves a careful walk-through in Phase 10 before locking it in.

- **Pro:** models DEX's actual semantics (positional, not momentum)
- **Pro:** avoids double-counting direction (direction is already in flowConfluence, priceConfirm, charmScore)
- **Con:** breaks the "every term is signed" pattern — adds a cognitive exception to the composite
- **Con:** the unsigned presence term can't distinguish a growing support level from a shrinking one (which might actually matter — a support level that's losing DEX is a failing support)

**Recommendation for v2:** start with unsigned presence, revisit if the ML pipeline shows unsigned DEX has poor predictive power. Having `delta_net` persisted in the features table from v1 means we can run both formulations head-to-head on the same data when we get there.

#### I.2 — What gets shipped in v1 regardless of the Q1/Q2/Q3 debate

These are table-stakes and do not depend on the v2 design questions:

1. **`delta_net` and `vanna_net` are stored in `gex_target_features` from Day 1.** Cheap columns, needed for Panel 5 rendering anyway, future-proof for v2 and for ML training.
2. **Panel 5 renders DEX and VEX bars with tooltips (Appendix H).** Users see the values immediately; they just don't affect the composite score.
3. **`math_version = 'v1'`** tags every row so that when v2 ships, both versions can coexist in the table and be compared.

#### I.3 — Phase 10 revisit agenda

When Phase 10 (backtest a session + weight tuning) runs, the owner and main session will:

1. Re-read Appendix I with 30+ days of live data in the features table
2. Look at the top-scored strikes from v1 and ask "would incorporating DEX and VEX have changed the pick?" for a sample of sessions
3. Decide: build v2 now (bump `math_version = 'v2'`, amend Appendix C.3 with DEX/VEX scorers, re-backfill), or defer until labeled outcome data is available to tell us whether v1 has a real accuracy gap
4. If deferring, add a follow-up plan doc for v2 with answers to Q1/Q2/Q3 and an estimated weight vector

#### I.4 — What not to do

- **Do not** incorporate DEX or VEX into v1's scoring math mid-build without updating Appendix C, the test matrix (Appendix D), and the `math_version` tag. v1 is a frozen scope.
- **Do not** remove `delta_net` / `vanna_net` from the features table even though they're unused in v1 scoring. They're needed for Panel 5 display and for ML training.
- **Do not** treat this appendix as a TODO to ignore — Phase 10 explicitly opens it. The debate happens.

---

## Owner-confirmed decisions

These were confirmed by the owner on 2026-04-08 before Phase 0 began. They are not open for relitigation during the build.

1. **Panel 5 greek bars — three thin CHEX/DEX/VEX bars inline on each leaderboard row.** Replace the legacy gradient bar. Each bar is green when the greek is positive, red when negative, width proportional to magnitude. This is the design spec Phase 7 subagents implement from.

2. **Backfill window — last 30 days.** Both `spx_candles_1m` and `gex_target_features` backfill scripts iterate the last 30 trading days. Extending the window later is a one-line change to the backfill scripts; no schema or code impact.

3. **Analyze endpoint token cost — accepted, no truncation.** Full-session 1-minute candles land in the Claude prompt on every analyze call. The owner has explicitly accepted the roughly 5x increase in candle-table tokens in exchange for Claude seeing granular intraday price action. **Do not truncate** the candle table in `formatSPXCandlesForClaude()` without re-confirming with the owner.

4. **Chart library — latest stable `lightweight-charts` that does not cause dependency conflicts.** The Phase 8 subagent should use a context7 lookup to find the latest stable version at implementation time, install it, and verify no peer-dependency conflicts against React 19 and Vite 5+. If conflicts surface, fall back to the most recent compatible version and document the pin in the plan's "Known limitations" section.

5. **`math_version = 'v1'`** is the starting tag for the first shipped version. All backfilled rows and live-cron rows from Phase 4 onward carry `math_version = 'v1'`. Bumping to `v2` requires an owner-approved rationale and a new backfill run.

Phase 0 is cleared to begin.
