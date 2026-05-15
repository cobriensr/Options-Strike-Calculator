# Pin-Setup Widget (2026-05-14)

## Goal

Surface a live "pin-setup" tile in the PreTradeSignals section that classifies the current 0DTE SPX session as `ARMED` / `WATCH` / `NOT_TRIGGERED` based on dealer +γ concentration. The classification predicts whether short-premium structures (iron condors, BWBs) are the +EV trade for the day vs. directional plays.

## Conditions (the rule)

Three independent conditions evaluated against the latest 0DTE per-strike snapshot in `gex_strike_0dte` plus the latest SPX spot from `index_candles_1m`:

| #   | Condition               | Met when                                                                                                                                  |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Magnet weight**       | `max(call_gamma_oi + put_gamma_oi) ≥ 20_000_000_000` (20K M, where M = millions, matching the existing tile semantics) at a single strike |
| 2   | **Round-number strike** | The magnet strike is a multiple of 50                                                                                                     |
| 3   | **Spot proximity**      | `abs(spot − magnet) ≤ 15` SPX points                                                                                                      |

States (priority order):

- `ARMED` — all 3 conditions met
- `WATCH` — exactly 2 of 3 met
- `NOT_TRIGGERED` — ≤ 1 met (or no 0DTE data yet)

The widget operates in **two modes**, selected by an optional `date` query param:

- **Live mode** (no `date`): evaluates the latest available snapshot. State can transition through the day as positions grow. Used by the default tile rendering.
- **Historical mode** (`date=YYYY-MM-DD`): evaluates the snapshot at the **first 0DTE timestamp ≥ 09:30 CT** for that date — i.e. "would the alert have fired at the canonical 9:30 check on that day?". Adds an `outcome` field with the day's settle and signed delta to the magnet, so users can score past days' calls without leaving the widget.

The 9:30 CT timepoint from the original framing is the canonical "first informative read"; the live widget can transition states later in the session as positions grow.

Backed by 8-day validation: 4 of 4 `ARMED` days settled within 2 pts; 3 of 3 `WATCH` (high-weight off-round) days settled within 5 pts; the one `NOT_TRIGGERED`-equivalent day (05-07) broke 26 pts past its weak magnet.

## Bias call (derived from state + spot-vs-magnet)

When `ARMED` or `WATCH`:

- `spot > magnet + 3` → `fade-rips` (sell call credit spreads, short straddles biased high)
- `spot < magnet − 3` → `fade-dips` (sell put credit spreads, short straddles biased low)
- `|spot − magnet| ≤ 3` → `full-pin` (iron condor, BWB centered on magnet)

When `NOT_TRIGGERED` → `no-signal` (directional plays have room; widget shows informational state only).

## Trade type recommendations

| State + bias      | Recommended                                              | Avoided                                                                                  |
| ----------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| ARMED / full-pin  | `iron_condor`, `iron_butterfly`, `broken_wing_butterfly` | `directional_long_call`, `directional_long_put`, `debit_call_spread`, `debit_put_spread` |
| ARMED / fade-rips | `credit_call_spread`, `iron_condor`                      | `directional_long_call`, `debit_call_spread`                                             |
| ARMED / fade-dips | `credit_put_spread`, `iron_condor`                       | `directional_long_put`, `debit_put_spread`                                               |
| WATCH (any bias)  | Same as ARMED but smaller size                           | Same as ARMED                                                                            |
| NOT_TRIGGERED     | `directional_long_call`, `directional_long_put`          | None enforced                                                                            |

Enum values match `trade-type enum` in the periscope skill.

## Phases

### Phase 1 — Backend (this PR)

Files:

- `api/_lib/validation/market-data.ts` — add `pinSetupQuerySchema` (empty `.strict()` object; no params)
- `api/_lib/db-pin-setup.ts` — new helper:
  - `getLatestPinSetup()` returns `{ snapshotTs, spot, strikes: Array<{strike, netGammaM, netCharmM}>, trajectory: Array<{tsCt, gammaDirM, spot}> }`
  - Two queries: latest 0DTE snapshot (`gex_strike_0dte` ≥ 7000 strike band, today's date by ET) + intraday trajectory from `spot_exposures` (one row per minute, gated to 08:30–15:00 CT today, ticker = SPX)
- `api/pin-setup-status.ts` — endpoint:
  - GET only, `guardOwnerOrGuestEndpoint`, `setCacheHeaders` (30s during market, 300s off-hours)
  - Computes state from helper output using the 3 conditions
  - Derives bias from spot-vs-magnet
  - Maps to recommended/avoided trade type arrays
  - Returns response shape below
- `api/__tests__/endpoint-pin-setup-status.test.ts` — covers: method guard, auth guard, ARMED happy path, WATCH (one condition fails), NOT_TRIGGERED, empty-data path, error path
- `src/main.tsx` — add `{ path: '/api/pin-setup-status', method: 'GET' }` to the botid `protect` array

ET calendar date: use `getMarketDateET()` from existing helpers (same convention as other endpoints).

### Phase 2 — Frontend

Files:

- `src/hooks/usePinSetupStatus.ts` — polls `/api/pin-setup-status` every 60s during market hours, every 5 min otherwise. Uses existing fetch + react state pattern from `useDarkPoolLevels` / similar hooks.
- `src/components/PreTradeSignals/PinSetupTile.tsx` — full-card component:
  - Status badge (ARMED green / WATCH amber / NOT_TRIGGERED gray)
  - Magnet strike + net γ (M) + spot + signed distance
  - Bias label with one-sentence explanation
  - Recommended trade-type chips (max 3 visible)
  - Inline SVG sparkline of gamma_dir trajectory (no new dep — single `<path>` element)
  - "Last evaluated HH:MM CT" footer
- `src/components/PreTradeSignals/index.tsx` — wire the tile into the grid (compose alongside RvIv / Gap / Breadth cards)
- `src/__tests__/PinSetupTile.test.tsx` — render with each state, assert badge color + content

## Response shape

```ts
interface PinSetupStatusResponse {
  evaluatedAt: string; // ISO timestamp of response
  state: 'ARMED' | 'WATCH' | 'NOT_TRIGGERED';
  conditions: {
    netGammaAtMagnetM: number; // in millions
    netGammaThresholdM: number; // 20000
    netGammaMet: boolean;
    magnetStrike: number | null;
    isRound50: boolean;
    distanceToMagnet: number | null; // signed: spot - magnet
    distanceThreshold: number; // 15
    distanceMet: boolean;
  };
  spot: number | null;
  bias: 'fade-rips' | 'fade-dips' | 'full-pin' | 'no-signal';
  recommendedTradeTypes: string[];
  avoidedTradeTypes: string[];
  trajectory: Array<{
    t: string; // HH:MM CT
    gammaDirM: number; // in millions
    spot: number;
  }>;
  asOf: string; // ISO timestamp (same as evaluatedAt; kept for consistency with sibling endpoints)
}
```

## Data dependencies

- `gex_strike_0dte` (existing) — read latest snapshot for today's ET date, strike band 7000–8000.
- `spot_exposures` (existing) — read SPX rows for today, 08:30–15:00 CT for the trajectory sparkline.
- `index_candles_1m` (existing) — fallback for spot if `spot_exposures` is empty.
- No new tables. No new cron. No new env vars.

## Open questions

None blocking. Decisions made silently:

- **On-demand vs. stored cron**: on-demand (simpler, always live, no new infra).
- **Magnitude unit**: store and surface as millions (M). The DB column is in raw units; divide by 1e6 in the helper.
- **Trajectory granularity**: 1-minute resolution capped at 200 points (covers full 6.5h session at 1-min cadence with headroom). Sparkline downsamples in CSS via SVG path simplification, not in the API.
- **Off-hours behavior**: if no rows exist for today's ET date, return `NOT_TRIGGERED` with `conditions.*` set to `null` / `false`. Widget renders as gray informational tile.

## Thresholds / constants

| Name                    | Value      | Rationale                                                             |
| ----------------------- | ---------- | --------------------------------------------------------------------- |
| `NET_GAMMA_THRESHOLD_M` | 20,000     | Validated against 8-day window                                        |
| `DISTANCE_THRESHOLD`    | 15 SPX pts | Validated against 8-day window                                        |
| `ROUND_NUMBER_STEP`     | 50         | SPX 0DTE strike spacing's strongest psychological anchors             |
| `BIAS_NEUTRAL_BAND`     | 3 SPX pts  | Threshold for "full-pin" (centered) vs. "fade-rips/dips" (off-center) |
| `TRAJECTORY_LIMIT`      | 200 points | ~3.3h at 1-min cadence; covers worst-case session length              |

## Non-goals

- No alert delivery (push, email). Widget displays current state; users observe it.
- No historical lookback UI. Endpoint serves "now" only.
- No backtesting integration. The 8-day validation is in the spec; no automated check in CI.
- No event-day gating (FOMC/CPI). Future enhancement; out of scope.
