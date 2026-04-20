# Market Internals Panel (TICK / ADD / VOLD)

**Date:** 2026-04-15
**Status:** Scoped — ready to build
**Branch target:** new feature branch off `main`

## Goal

Add a live market-internals panel that polls NYSE breadth/momentum indices ($TICK, $ADD, $VOLD) every 60s, classifies the current session as **range day** or **trend day**, and feeds that regime signal — plus today's extreme events — into both the UI (badge + event log) and the Claude analyze context.

The purpose is **not** to display raw numbers; it is to produce a regime classification that weights every other signal (GEX walls, whale flow, NOPE) differently based on whether the tape is mean-reverting or trending.

## Why a component + Claude feed, not just a Claude feed

- The regime shifts **intraday** (range morning → trend afternoon is common). A component shows it continuously; injecting into analyze-only surfaces it at button-press time.
- Claude should consume a **pre-digested classification** (`regime: range_day`, `confidence: 0.8`, `evidence: [...]`), not raw TICK/ADD/VOLD. Raw values force Claude to re-derive the regime every call, inconsistently.
- **Confluence is visual** — seeing a TICK extreme line up with a GEX wall is faster on-screen than in prose.

## Data source decision

**Primary:** Schwab `/marketdata/v1/pricehistory` polled every 60s for **1-min OHLC bars** of `$TICK`, `$ADD`, `$VOLD`.

**Rationale:** Polling `/quotes` gives only the value at poll-time — a +650 spike that reverses in 30s would be missed entirely. OHLC bars capture the minute's `high`/`low`/`close`, so extremes are preserved by construction.

**Unknown (step 1 of Phase 1):** Confirm Schwab pricehistory supports `$TICK`/`$ADD`/`$VOLD` symbols. These are indices, not equities.

**Fallbacks if pricehistory doesn't support them:**

1. **Databento** — confirmed to carry TICK as a continuous index, tick-level bars available. Would add to the sidecar ingestion pipeline. +1–2 days of work.
2. **Schwab streaming** — level-1 streamer definitely has them. Connect once at market open, aggregate to 1-min bars in a long-running function or sidecar. Authoritative but +infra lift.

## Thresholds (starting point — Phase 4 makes them adaptive)

| Band | $TICK (NYSE, ~3,000 stocks) | $TICKQ (Nasdaq, ~3,700 stocks) |
|---|---|---|
| Neutral | \|x\| < 400 | \|x\| < 500 |
| Elevated | 400–600 | 500–750 |
| Extreme | 600–1000 | 750–1200 |
| Blowoff | > 1000 | > 1200 |

**$ADD and $VOLD** use **slope-based classification, not fixed thresholds:**

- Flat / oscillating around zero → range day
- Monotonic drift one direction → trend day
- $VOLD outpacing $ADD in magnitude → heavy one-sided volume, trend-day confirmation

Thresholds live in `src/constants/market-internals.ts` for easy tuning.

## Regime classifier (pseudocode)

```
range_score  = tick_mean_reversion_rate × (1 - abs(add_directional_drift))
trend_score  = pct_time_tick_extreme × abs(vold_directional)
neutral_score = 1 - max(range_score, trend_score)

regime       = argmax(range_score, trend_score, neutral_score)
confidence   = normalized_top_score
evidence     = [ 'TICK oscillating ±400', 'ADD flat', ... ]
```

Pure function over today's bar series. Same implementation runs in the browser (for the badge) and in `analyze-context.ts` (for Claude).

---

## Phases

### Phase 1 — Live readout (~5 hrs)

Ships a component showing real-time TICK/ADD/VOLD with color-state badges. No regime call yet — just the numbers, on the screen, during market hours.

**Files to create:**

- `api/cron/fetch-market-internals.ts` — 1-min cron, pulls OHLC bars from Schwab, writes to `market_internals` table
- `api/__tests__/fetch-market-internals.test.ts` — cron test (mock `getDb`, mock Schwab fetch, verify SQL call sequence)
- `api/market-internals/history.ts` — GET endpoint returning today's bars
- `api/__tests__/market-internals-history.test.ts` — endpoint test
- `src/hooks/useMarketInternals.ts` — 60s polling hook, gated on `marketOpen`
- `src/components/MarketInternals/MarketInternalsBadge.tsx` — color-state badge
- `src/__tests__/components/MarketInternalsBadge.test.tsx`
- `src/constants/market-internals.ts` — threshold constants
- `src/types/market-internals.ts` — `InternalBar`, `InternalSymbol` types

**Files to modify:**

- `api/_lib/db-migrations.ts` — add migration N: `CREATE TABLE market_internals (ts timestamptz, symbol text, open real, high real, low real, close real, PRIMARY KEY (ts, symbol))`
- `api/__tests__/db.test.ts` — add `{ id: N }` to applied-migrations mock + expected output + SQL call count
- `vercel.json` — register the new cron job with `* 13-21 * * 1-5` schedule (1-min cadence during market hours), add path to `protect` array if needed
- `src/main.tsx` — add `/api/market-internals/history` to `initBotId()` `protect` array
- `src/App.tsx` — render `<MarketInternalsBadge />` somewhere visible (near Flow Confluence Panel feels natural)

**Verify:**

- Cron fires every minute 13:00–21:00 UTC Mon–Fri
- `market_internals` table fills with OHLC rows for all three symbols
- Badge shows current close value with correct color band
- `npm run review` passes

**Decision gate:** Confirm Schwab pricehistory supports `$TICK` BEFORE writing the cron. If it doesn't, stop and reroute to Databento or streaming.

---

### Phase 2 — Regime classification + event log (~3 hrs)

Turns the live readout into a classified regime signal with a scrollable session log.

**Files to create:**

- `src/utils/market-regime.ts` — pure classifier function `classifyRegime(bars: InternalBar[]): RegimeResult`
- `src/__tests__/utils/market-regime.test.ts` — fixture-based tests (range-day fixture, trend-day fixture, neutral fixture)
- `src/utils/extreme-detector.ts` — pure function `detectExtremes(bars: InternalBar[]): ExtremeEvent[]`
- `src/__tests__/utils/extreme-detector.test.ts`
- `src/components/MarketInternals/MarketInternalsPanel.tsx` — full panel with regime badge + event log (supersedes the simple badge)
- `src/__tests__/components/MarketInternalsPanel.test.tsx`

**Files to modify:**

- `src/App.tsx` — swap simple badge for full panel
- `src/components/MarketInternals/MarketInternalsBadge.tsx` — keep or inline into panel (decide during impl)

**Verify:**

- Given a mock range-day bar series, classifier returns `regime: 'range'` with reasonable confidence
- Given a mock trend-day bar series, classifier returns `regime: 'trend'`
- Event log shows all TICK > 600 events from today's bars with timestamps
- `npm run review` passes

---

### Phase 3 — Analyze context + confluence wiring (~1 hr)

Closes the loop: Claude sees the regime label and today's extremes; the Flow Confluence Panel re-weights based on regime.

**Files to modify:**

- `api/_lib/analyze-context.ts` — add `formatMarketInternalsForClaude()` that produces a pre-digested block (regime + confidence + evidence + today's extreme count)
- `api/_lib/db-flow.ts` — add `getMarketInternalsToday()` query helper
- `api/_lib/analyze-prompts.ts` — add rule text explaining how to weight signals based on regime (range vs trend)
- `src/components/OptionsFlow/FlowConfluencePanel.tsx` — consume regime from `useMarketInternals`, adjust confluence scoring (range-day confluence weights GEX walls higher; trend-day weights flow directional conviction higher)

**Verify:**

- Run analyze; confirm Claude's response references the regime label
- Range-day confluence score differs from trend-day score for the same underlying flow data
- `npm run review` passes

---

### Phase 4 — Adaptive thresholds (future)

Once `market_internals` has 20+ sessions of history, replace the fixed thresholds with a rolling percentile:

```ts
todayExtremeThreshold = p90(abs(tick_high)) over last 20 sessions
```

Self-calibrates to volatility regime — VIX-30 weeks auto-widen, VIX-12 weeks auto-tighten.

---

## Data dependencies

| Dependency | Location | Notes |
|---|---|---|
| Schwab OAuth session | Upstash Redis (existing) | Already authenticated; no new env vars |
| `DATABASE_URL` | Neon Postgres (existing) | New table `market_internals` |
| `CRON_SECRET` | Vercel env (existing) | Gates the new cron handler |
| Schwab pricehistory endpoint | External API | **Unverified for $TICK/$ADD/$VOLD symbols — Phase 1 step 1** |

No new env vars, no new third-party services (unless Databento fallback activates).

---

## Verification results (2026-04-15)

Ran a one-off debug endpoint (`api/debug/verify-market-internals.ts`) hitting Schwab `/pricehistory` for all five candidate symbols. Results:

| Symbol | Supported | Notes |
|---|---|---|
| `$TICK` | ✅ | 706 candles returned (extended-hours data included despite `needExtendedHoursData: false`) |
| `$ADD` | ✅ | 390 candles (regular hours only — respects the flag) |
| `$VOLD` | ✅ | 390 candles (regular hours only) |
| `$TRIN` | ✅ bonus | 706 candles — wasn't originally in scope; cheap to include |
| `$TICKQ` | ⚠️ empty | Schwab accepts the symbol but returns zero candles. Nasdaq internal not carried through Schwab's pricehistory, or symbol name is different |

**Adjusted Phase 1 scope:**

- **Include:** `$TICK`, `$ADD`, `$VOLD`, `$TRIN` (4 symbols)
- **Exclude:** `$TICKQ` — investigate separately later (could be `$COMPQ-TICK` or similar)
- **Cron must filter extended-hours bars for `$TICK` and `$TRIN`** using the same ET-time filter pattern as [api/intraday.ts:185-194](api/intraday.ts#L185-L194): keep only candles where ET minutes-of-day ≥ 570 (9:30 AM) and ≤ 960 (4:00 PM)

## Open questions (remaining)

1. **Where does the panel live in `App.tsx`?** → Default: near the Flow Confluence Panel, since regime feeds confluence scoring. Alternative: sticky top-bar summary. Decide during Phase 1 impl based on visual density.
2. **Toast/desktop notifications on new extremes?** → Default: skip for now. The badge + event log cover the use case without being intrusive.
3. **$TRIN thresholds?** → Not in original scope. Default: display only (no threshold coloring) in Phase 1; add thresholds in Phase 2 if useful for regime classifier.

---

## Thresholds / constants (agreed on during scoping)

```ts
// src/constants/market-internals.ts
export const MARKET_INTERNALS_THRESHOLDS = {
  tick: { elevated: 400, extreme: 600, blowoff: 1000 },
  tickq: { elevated: 500, extreme: 750, blowoff: 1200 },
  // $ADD, $VOLD use slope-based classification, no fixed thresholds
} as const;

export const POLL_INTERVAL_MS = 60_000;
export const PINNED_THRESHOLD_MINUTES = 3; // TICK > extreme for 3+ consecutive mins = trend signature
```

---

## Out of scope (explicitly)

- Backfilling historical TICK/ADD/VOLD data (Phase 1 starts writing from deploy; no retro-fill)
- Integration with Phase 1 ML clustering feature set (could be a future ML feature, not now)
- Alerts pushed to external destinations (Slack, email, SMS)
- Per-sector breadth (just the three headline indices)
- Mobile-specific layout (panel follows existing Tailwind responsive conventions, no special handling)
