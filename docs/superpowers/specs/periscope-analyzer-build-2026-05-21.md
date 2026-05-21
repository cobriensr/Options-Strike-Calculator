# Periscope Analyzer — Deterministic Replacement for Intraday Auto-Playbook

**Date:** 2026-05-21
**Status:** Spec (build not yet started)
**Output target:** `api/_lib/periscope-analyzer.ts` + `/api/periscope-map` endpoint + simplified Market Maker Exposure panel
**Depends on:**
- [`docs/superpowers/specs/periscope-rules-study-2026-05-21.md`](periscope-rules-study-2026-05-21.md) — study spec
- `docs/tmp/periscope-rules-study-findings-2026-05-21.md` — findings (gitignored, local-only)
- `api/_lib/periscope-analyzer-rules.ts` — validated rule constants

---

## Goal

Replace the per-slice Periscope-scraper + Claude pipeline with a deterministic analyzer fed by **GEXBot's 1-min state endpoints**. Output: a structured "trader's map" — entry triggers, stops, targets, trade structures — updated every minute. Zero Claude calls during the trading day's intraday slices.

`pre_trade` (one call/day before open) and `debrief` (one call/day after close) keep Claude — those modes have no latency pressure and benefit from cross-context synthesis.

## Why

**This is a latency-reduction project, full stop.** The current pipeline is:

```
Periscope scrape (10-min slot cadence)    = up to 10 min
  → scraper lag (2-3 min)                 = +2-3 min
  → Claude auto-playbook call (2-3 min)   = +2-3 min
  → panel displays                        = 13-15 min stale
```

GEXBot replacement:

```
GEXBot poll (1-min cadence, already running) = up to 1 min
  → analyzer compute (<1 sec)                = ~negligible
  → panel polls map endpoint (10 sec)        = ~10 sec
  → panel displays                           = ~1 min stale
```

**13-15 min → ~1 min.** The Claude call latency goes to zero because the analyzer is deterministic. The 10-min cadence goes to 1-min because GEXBot polls every minute.

User direction from 2026-05-21:
- *"The whole point of this is to replace Periscope with Gexbot so I go from 13-15 minutes of latency to 1 minute response"*
- *"I just need a map to know where to go during the day based on gamma, delta, charm, vanna, etc."*
- *"This be based on dealer mechanics and price action not just an arbitrary number"*
- *"Whatever the data says"* (the rules study's job; already done)

## Output schema — the map

```ts
// api/_lib/periscope-analyzer-types.ts
export type RegimeTag =
  | 'pin' | 'drift-and-cap' | 'gap-and-rip' | 'trap'
  | 'cone-breach' | 'chop' | 'other';

export type TradeStructure =
  | 'debit_call_spread' | 'debit_put_spread'
  | 'iron_condor' | 'broken_wing_butterfly'
  | 'directional_long_call' | 'directional_long_put'
  | 'long_strangle' | 'credit_call_spread' | 'credit_put_spread';

export interface DirectionalSetup {
  /** Price level that arms the trigger when held past per TRIGGER_ARM rule. */
  triggerLevel: number;
  /** Whether the trigger is currently armed (3-min hold past trigger). */
  armed: boolean;
  /** Stop level. Fires when STOP_FIRE rule (S5) satisfied. */
  stopLevel: number;
  /** First target — gamma_wall per TARGET_ORDER rule. Always. */
  target1: number;
  /** Second target — magnet (or charm_zero in pin regime). */
  target2: number;
  /** Recommended structure for this side. */
  structure: TradeStructure;
  /** Strike legs for the structure, ordered short-strike-first. */
  structureLegs: { strike: number; type: 'C' | 'P'; side: 'long' | 'short' }[];
}

export interface PeriscopeMap {
  spot: number;
  capturedAt: string; // ISO

  // Levels (from per-strike Greek topology)
  gammaFloor: { strike: number; magnitude: number } | null;
  gammaCeiling: { strike: number; magnitude: number } | null;
  magnet: { strike: number; magnitude: number };
  charmZero: number | null;

  // Cone (when available)
  coneLower: number | null;
  coneUpper: number | null;

  // Setups
  long: DirectionalSetup | null;   // null when no +γ ceiling above spot
  short: DirectionalSetup | null;  // null when no +γ floor below spot
  waitZone: { lower: number; upper: number } | null;

  // Regime (rule-based, no Claude)
  regime: RegimeTag;

  // Freshness
  ageSec: number;
  source: 'gexbot_state' | 'periscope_snapshots'; // gexbot primary; snapshots fallback
}
```

## Algorithm

Order of operations (single pass per analyzer invocation):

```
1. Load latest slice from data source (periscope_snapshots OR gexbot_api_capture)
2. Load index_candles_1m for the last 30 min (for arm/stop checks)
3. Compute structural features:
     - gamma_floor: argmax(+γ, strike < spot, magnitude > threshold)
     - gamma_ceiling: argmax(+γ, strike > spot)
     - magnet: argmax(|γ|, |strike − spot| < $30)
     - charm_zero: linear-interp where signed charm crosses zero
4. Compute trigger + stop levels:
     - long.triggerLevel = nearest strike past gamma_ceiling (round to 5)
     - long.stopLevel = gamma_floor.strike
     - short.triggerLevel = nearest strike past gamma_floor
     - short.stopLevel = gamma_ceiling.strike
5. Check trigger arming (TRIGGER_ARM_RULE = T2):
     - long.armed = (3-min hold of 1-min closes > triggerLevel) AND
                    (continuationPct since trigger satisfied)
     - short.armed = symmetric
6. Compute targets (TARGET_ORDER_RULE):
     - target1 = gamma_wall (ceiling for long; floor for short)
     - target2 = magnet  OR  charm_zero (in pin regime)
7. Compute regime tag (deterministic classifier):
     - pin: dominant +γ near spot + no recent sign flips + symmetric cone
     - drift-and-cap: +γ wall above + same-side charm + spot 5+ pts below
     - cone-breach: spot outside [coneLower, coneUpper]
     - trap: cone present but asymmetric AND missing nearby +γ floor
     - chop: symmetric charm + dominant +γ near spot + low magnitudes
     - other: anything not above
8. Map regime → trade structure (see "Structure mapping" below)
9. Compute structure legs (strike selection from gamma topology)
10. Return PeriscopeMap
```

All rule thresholds and parameters come from `api/_lib/periscope-analyzer-rules.ts` — no magic numbers in the analyzer module.

## Structure mapping (regime → trade structure)

Phase-2 mapping from `periscope-rules-study-2026-05-21.md` Section "Trade-structure mapping," lifted into the analyzer:

| Setup state | Structure | Strike selection |
|---|---|---|
| `long.armed = true`, regime != cone-breach | `debit_call_spread` | long = `triggerLevel`, short = `gammaCeiling.strike` |
| `long.armed = true`, regime = cone-breach | `directional_long_call` | strike = `triggerLevel` |
| `short.armed = true`, regime != cone-breach | `debit_put_spread` | long = `triggerLevel`, short = `gammaFloor.strike` |
| `short.armed = true`, regime = cone-breach | `directional_long_put` | strike = `triggerLevel` |
| Both unarmed, regime = pin | `broken_wing_butterfly` | body = `magnet`, wings asymmetric per `coneLower/coneUpper` skew |
| Both unarmed, regime = chop | `iron_condor` | short legs = wait-zone boundaries, long legs = `gammaFloor`/`gammaCeiling` |
| Both unarmed, regime = trap | `null` (no structure) | wait — chart is ambiguous |
| Both unarmed, regime = drift-and-cap | side-dependent (long side: credit_call_spread above ceiling; short side: credit_put_spread below floor) | — |

Reference: existing `api/_lib/analyze-prompts.ts` for current Claude logic.

## Architecture

```
api/
  _lib/
    periscope-analyzer.ts         — pure analyzer (this build)
    periscope-analyzer-types.ts   — output shape
    periscope-analyzer-rules.ts   — already exists, validated constants
    periscope-data-source.ts      — adapter for periscope_snapshots vs gexbot_state
  periscope-map.ts                — GET /api/periscope-map endpoint
  cron/
    compute-periscope-map.ts      — every 1 min during RTH, persist latest map
```

### `periscope-data-source.ts` — input abstraction

GEXBot is the primary source from day 1. `periscope_snapshots` becomes a fallback when GEXBot is delayed or unavailable, plus the source for the historical replay sanity test.

```ts
export interface PerStrikeSnapshot {
  capturedAt: Date;
  spot: number;
  expiry: string;
  strikes: { strike: number; gamma: number; charm: number; vanna: number; positions?: number }[];
  source: 'gexbot_state' | 'periscope_snapshots';
}

// PRIMARY — used by /api/periscope-map and the cron.
export function loadLatestFromGexbot(ticker: GexbotTicker): Promise<PerStrikeSnapshot>;

// FALLBACK — used when the latest gexbot_api_capture row is > 3 min old.
// Also used by the replay test for historical days where GEXBot wasn't
// being captured yet (pre-2026-05-16).
export function loadLatestFromPeriscope(): Promise<PerStrikeSnapshot>;
```

#### GEXBot payload decoding

GEXBot's `state/{gamma,charm,vanna,delta}_{zero,one}` endpoints return responses with a `mini_contracts` array. Each row is:

```text
[strike, call_value, put_value, total_dealer_value, [t-1m, t-5m, t-10m], reserved, null]
```

Position-3 (`total_dealer_value`) is the signed MM-attributed value at that strike — gamma when reading `state/gamma_zero`, charm when reading `state/charm_zero`, etc. Position-4 is the time-series for slice-over-slice deltas (used by the inventory-drop rules even though they didn't make it into the validated rule set).

Data source reader joins three `gexbot_api_capture` rows per snapshot (gamma_zero + charm_zero + vanna_zero, or `_one` for 1DTE), unifies on (capturedAt, strike), and returns a single `PerStrikeSnapshot`.

### `periscope-analyzer.ts` — pure function

```ts
export async function computePeriscopeMap(opts: {
  source: 'periscope_snapshots' | 'gexbot_state';
  ticker?: GexbotTicker; // required if source = gexbot_state
  asOf?: Date;          // for historical replay
}): Promise<PeriscopeMap>;
```

No side effects, no DB writes inside the function. Just read → compute → return.

### `/api/periscope-map` endpoint

GET, returns latest `PeriscopeMap` for SPX. Cached in Upstash Redis with 60s TTL keyed by `(ticker, captured_at_minute)`. Falls back to direct compute if cache miss.

Owner-gated (the analyze prompt also gated): the map is a derivative of paid Periscope/GEXBot data.

### `compute-periscope-map.ts` cron

Every minute 13:30-21:00 UTC Mon-Fri:

```
1. Load latest snapshot
2. Compute map
3. Persist to Upstash Redis (key: periscope-map:SPX, TTL 60s)
4. Optionally persist to a new periscope_maps table for replay/backtest
```

CRON_SECRET guard, isMarketHours gate, withDbRetry on the DB calls.

## Integration points (what changes in the existing system)

| Current path | After change |
|---|---|
| `api/_lib/periscope-chat-runner.ts:runPeriscopeAutoPlaybook` called on scraper webhook → Claude | `runPeriscopeAutoPlaybook` keeps Claude for `pre_trade` + `debrief`; for `intraday` mode, calls `computePeriscopeMap()` instead, persists to `periscope_maps` |
| `src/hooks/usePeriscopeExposure.ts` reads `/api/periscope-analysis` | reads `/api/periscope-map` instead |
| `MarketMakerExposure` panel renders prose + structured fields | renders the map layout (see Frontend section) |
| `periscope_analyses` table | keeps growing (pre_trade + debrief). Intraday rows stop flowing in once cut over. |
| `periscope_maps` (new table) | one row per minute per ticker, the analyzer's persisted output |

## Frontend — the panel

Strip `MarketMakerExposure` down to the layout the user sketched:

```
┌─ SPX 7392 ─────────────────────────┐
│                                    │
│ ↑ CEILING   7405  (+γ 1,250)       │
│ ↑ T1        7400  (magnet)         │
│ ─ SPOT      7392                   │
│ ↓ T1        7380  (charm zero)     │
│ ↓ FLOOR     7355  (+γ 980)         │
│                                    │
│ LONG  arms > 7395  | stop 7388     │
│       T1 7400      T2 7405         │
│       debit_call_spread 7395/7405  │
│                                    │
│ SHORT arms < 7388  | stop 7395     │
│       T1 7380      T2 7355         │
│       debit_put_spread 7388/7378   │
│                                    │
│ WAIT  7388-7395                    │
│       iron_condor 7378p/7388p/7395c/7405c │
│                                    │
│ regime: trap  |  age 42s           │
└────────────────────────────────────┘
```

Visual rules:
- Spot color tracks zone: green tint when in wait, blue tint when armed long, red tint when armed short
- Armed trigger pulses (subtle CSS animation) until trade taken
- Stale data (age > 90 s) renders with a low-opacity overlay + "stale" badge
- No prose, no narrative — just the map

### New hook: `usePeriscopeMap()`

```ts
export function usePeriscopeMap(): {
  data: PeriscopeMap | null;
  loading: boolean;
  refresh: () => void;
};
```

Polls `/api/periscope-map` every 10 s during market hours.

### Components to retire
- The current "auto-playbook prose" section of `MarketMakerExposure`
- The "Claude analysis" badge / link
- Anything tied to `periscope_analyses.prose_text`

## Migration plan

The original draft included a 5-day A/B soak validating analyzer-vs-Claude agreement. That's the wrong objective — the user's goal is **latency reduction**, not signal parity. Removed. Replaced with a direct cut-over behind a feature flag.

| Phase | Action | User-visible? |
|---|---|---|
| 1 | Build analyzer + GEXBot data source + endpoint + cron + cache. Map persists every minute. Panel still shows Claude output. | No |
| 2 | Frontend: ship the new map panel behind a feature flag, default OFF. Owner toggles it on for their own session. | Owner only |
| 3 | Owner uses map for a few live sessions, eyeball-validates against current Periscope reads. If happy, flip flag default to ON. | Yes |
| 4 | Retire intraday `runPeriscopeAutoPlaybook` Claude calls. Keep `pre_trade` + `debrief`. | No |

If the map looks wrong in live use, fall back to flag OFF and fix. The cost of being wrong is one wrong-map-driven trade decision; the cost of dragging out the migration is real latency the user is paying every day.

## Testing

### Unit tests (`api/__tests__/periscope-analyzer.test.ts`)
- Per-rule TDD: feed a synthetic snapshot + expected trigger level / stop / target
- Regime classifier: 7 test cases, one per regime tag, asserting the right tag fires
- Structure mapping: assert each `(regime, armed_state) → structure` row from the mapping table
- No-data conditions: assert the analyzer returns null fields rather than throwing when no nearby +γ exists

### Integration test (`api/__tests__/periscope-map-endpoint.test.ts`)
- Mock the data source, hit the endpoint, assert the response shape matches `PeriscopeMap`
- Cache hit/miss path

### Replay sanity test (`scripts/replay-periscope-analyzer-2026-05-21.ts`)

NOT an agreement test against Claude — the spec deliberately drops that. Replaced with a sanity check:

- For every `periscope_snapshots` slice between 2026-05-01 and 2026-05-19 (full coverage window):
  - Run the analyzer with `source: 'periscope_snapshots'` (fallback path)
  - Record `PeriscopeMap` output

- Output: a single-page summary of "did the analyzer produce a usable map?" — frequency of `null` fields, regime distribution, trigger-level distance from spot distribution. Owner spot-checks 10 random sampled slices manually.

If the analyzer is producing null gamma_floor on 80% of slices, the magnitude threshold is wrong. If regime tag is "other" on 50% of slices, the classifier needs work. Eyeball, not agreement-rate.

## Open questions

1. **Cache vs. recompute on demand.** Polling every 10 s × multiple clients × multiple days adds DB load. Decision: Upstash cache with 60 s TTL, fall back to live compute. Cache key = `(ticker, captured_at_minute)`.

2. **Where to persist `periscope_maps`.** New table, or extend `periscope_analyses` with new columns? Decision: new table. The two are semantically different — one is mechanical, one is reasoning. Keeping them separate makes the cut-over reversible.

3. **Pre_trade / debrief integration.** Should the Claude prompt also receive the analyzer's map as input? Decision: yes. Claude's job becomes "narrate / cross-reference / catch edge cases" instead of "compute from scratch." This is the prompt's existing pattern with structured input.

4. **Stale data policy.** If neither data source has updated in > 5 min, the panel should fall back to "no data" rather than show a stale map. Decision: analyzer returns the last map with `ageSec` populated; the panel renders a "stale" overlay and grays out the trigger states when `ageSec > 90`.

5. **Multi-ticker support.** SPX is the trading focus, but NDX would benefit from the same map. Decision: API accepts `?ticker=SPX|NDX`. Default to SPX. NDX uses GEXBot state endpoints once Phase 6 lands; until then, NDX returns null (no Periscope scraper for NDX).

6. **Backtest / paper-trading hook.** Should the analyzer output feed a paper-trading log (taking each armed trigger as a trade)? Decision: out of scope for this spec. Build a separate paper-trade harness once the analyzer is in production for 2+ weeks.

## Deliverables

| Artifact | Location | LOC est. |
|---|---|---|
| Types | `api/_lib/periscope-analyzer-types.ts` | 80 |
| Data source adapter | `api/_lib/periscope-data-source.ts` | 150 |
| Analyzer (pure) | `api/_lib/periscope-analyzer.ts` | 500 |
| Endpoint | `api/periscope-map.ts` | 120 |
| Cron | `api/cron/compute-periscope-map.ts` | 80 |
| Migration | `api/_lib/db-migrations.ts` (new table `periscope_maps`) | 40 |
| Frontend hook | `src/hooks/usePeriscopeMap.ts` | 80 |
| Frontend panel | `src/components/MarketMakerExposure/index.tsx` (refactor) | -200 (net deletion) |
| Unit tests | `api/__tests__/periscope-analyzer.test.ts` | 400 |
| Endpoint test | `api/__tests__/periscope-map-endpoint.test.ts` | 120 |
| Replay test | `scripts/replay-periscope-analyzer-2026-05-21.ts` | 250 |
| vercel.json cron entry | — | 5 |

Total ~1,625 LOC net add (after the frontend deletion).

## Phasing

| Phase | Scope | Time |
|---|---|---|
| 1 | Types + GEXBot data source (decoder for `mini_contracts` array) + analyzer + unit tests | 1.5 days |
| 2 | Endpoint + cron + Upstash cache + migration #N for `periscope_maps` + replay sanity test | 1 day |
| 3 | Frontend hook + panel refactor + feature-flag toggle | 1 day |
| 4 | Owner enables flag, validates in 1-2 live sessions, flips default on | 1-2 trading days passive |
| 5 | Retire intraday `runPeriscopeAutoPlaybook` Claude calls | 0.5 day |

Calendar total: **~3.5 build days + 1-2 owner-validation sessions.** No multi-week soak.

## Non-goals

- Replacing `pre_trade` and `debrief` Claude calls. These have no latency pressure and benefit from cross-context synthesis.
- New signals beyond the validated rules. This is re-platforming, not research.
- Multi-ticker analyzer beyond SPX (NDX is a later add — GEXBot covers it, but frontend integration is its own scope).
- Paper-trading harness.
- Real-time WebSocket updates to the panel (10-sec polling is fine; sub-1-min latency target is already met).
- Frontend redesign beyond the MM Exposure panel.
- Multi-week A/B soak against Claude's prior output. The agreement-rate framing was solving for the wrong objective.

## Risk to flag

The study's honest finding (F1 < 0.6 on all rule families, base rate 0.1%) means the analyzer's signal quality matches Claude's already-mechanical output — no edge over current state. **The build is justified by latency reduction (13-15 min → 1 min) and cost (Claude calls → 0), not by signal lift.**

The user is the validator. Phase 4 owner-validation in 1-2 live sessions catches anything Phase 3 sanity-check missed. If the map looks wrong in live use, the feature flag flips off and the spec needs revision before retrying. The cost of "wrong map for one session" is small; the cost of dragging out validation while paying 13-15 min latency every day is large.
