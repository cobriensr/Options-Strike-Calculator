# Phase F — Cross-Asset Confluence UI for IV-Anomalies

## Goal

Surface the Phase D + Phase E findings as **per-filter visual pills**
on each active anomaly row. Strictly visual — does NOT filter, sort,
or gate any other behavior. The user reads the pills at a glance,
sees how many cross-asset signals confluence on the alert, and
makes their own call.

Five new pills per row, each independently colored:

1. **Regime** — chop / mild_trend / strong_trend / extreme × up/down
2. **Tape align** — aligned / contradicted / neutral (NQ/ES/RTY/SPX vs alert direction over last 15min)
3. **DP cluster** — none / small / medium / large dark-pool premium at strike (SPXW only; null for other tickers)
4. **GEX zone** — above_spot / below_spot / at_spot for nearest top-3 abs_gex (SPX-family only)
5. **VIX dir** — rising / flat / falling over last 30min

Each pill is a compact 10px font pill matching the existing
phase/flow_phase pill style.

## Why pure visual

Per Phase D/E findings, several signals invert by regime (E1 tape
alignment), are sample-thin (E2 dark prints n=36), or are
counterintuitive (E4 GEX below_spot beats above_spot). Filtering or
gating on these too early would risk anchoring decisions on
directional findings that may not survive more data.

The pills give the trader visibility without committing the system
to act on them. If after a month of live data the patterns hold, a
later Phase G can wire them into automatic prominence/sorting.

## Architecture

```
┌─────────────────┐         ┌─────────────────────────────────┐
│ useIVAnomalies  │  poll   │ /api/iv-anomalies               │
│ (existing)      │ ──────> │   list of ActiveAnomaly         │
└─────────────────┘         └─────────────────────────────────┘
        │
        │  parallel fetch every poll cycle
        ▼
┌─────────────────────┐    ┌─────────────────────────────────────┐
│ useAnomalyCrossAsset│ ── │ /api/iv-anomalies-cross-asset       │
│ (NEW)               │    │   POST { keys: [{ticker,strike,...}]│
└─────────────────────┘    │   returns { [key]: CrossAssetCtx }  │
        │                  └─────────────────────────────────────┘
        ▼ join by compoundKey
┌─────────────────────────────────────────┐
│ AnomalyRow renders 5 new pills          │
│   <RegimePill /> <TapeAlignPill />      │
│   <DPClusterPill /> <GEXZonePill />     │
│   <VIXDirPill />                        │
└─────────────────────────────────────────┘
```

## Sub-phases

### F1 — Backend endpoint (~3h)

**File:** `api/iv-anomalies-cross-asset.ts` (new endpoint)
**Route:** `POST /api/iv-anomalies-cross-asset`

Input (Zod-validated):

```ts
{
  keys: Array<{
    ticker: string;
    strike: number;
    side: 'call' | 'put';
    expiry: string;
    alertTs: string; // ISO
  }>;
}
```

Output:

```ts
{
  contexts: Record<
    string,
    {
      regime:
        | 'chop'
        | 'mild_trend_up'
        | 'mild_trend_down'
        | 'strong_trend_up'
        | 'strong_trend_down'
        | 'extreme_up'
        | 'extreme_down'
        | 'unknown';
      tapeAlignment: 'aligned' | 'contradicted' | 'neutral' | 'missing';
      dpCluster: 'none' | 'small' | 'medium' | 'large' | 'na';
      gexZone: 'above_spot' | 'below_spot' | 'at_spot' | 'na';
      vixDirection: 'rising' | 'flat' | 'falling' | 'unknown';
    }
  >;
}
```

Implementation notes:

- Bulk endpoint — single request returns context for all keys in a poll cycle. Avoids N+1 fan-out
- Compute regime per (ticker, date) using same logic as ML scripts (open ≈ first observed spot, close ≈ last observed spot for that day's snapshot data)
- Tape alignment computed from `futures_bars` (NQ/ES/RTY) + `spx_candles_1m`, 15-min window
- DP cluster computed from `dark_pool_levels` joined on (date, spx_approx near alertStrike). Buckets: none=$0, small=<$50M, medium=$50-200M, large=$200M+. Returns `'na'` for non-SPXW tickers
- GEX zone computed from `greek_exposure_strike` top-3 abs_gex per (date, expiry). Returns `'na'` for tickers we don't have GEX data for
- VIX direction from `market_snapshots` 30-min change. Returns `'unknown'` when sparse

**Caching:** HTTP `setCacheHeaders(res, 30)` on the response. With 30s client polling this gives effective dedup without an in-process LRU. Earlier draft of this spec called for a server-side LRU; dropped because the response cache covers the same use case at lower complexity.

**Auth:** owner-gated (same pattern as `api/strike-trade-volume.ts`). botid checked.

**Tests:** `api/__tests__/iv-anomalies-cross-asset.test.ts`

- Mock `getDb` returns futures + GEX + dark pool rows
- Verify regime classification (chop / mild / strong / extreme)
- Verify tape alignment labeling
- Verify DP cluster bucketing on SPXW; `'na'` on others
- Verify response shape matches Zod output schema

### F2 — Frontend hook + types (~2h)

**File:** `src/hooks/useAnomalyCrossAsset.ts` (new)

```ts
export function useAnomalyCrossAsset(
  anomalies: ActiveAnomaly[],
  marketOpen: boolean,
): Record<string, AnomalyCrossAssetContext>;
```

- Polls `/api/iv-anomalies-cross-asset` every 30s when `marketOpen`
- POST body = current `compoundKey` list
- Returns map keyed by compoundKey
- Reuses fetch retry pattern from existing hooks (`fetchWithRetry`)

**File:** `src/components/IVAnomalies/types.ts` (modify)

```ts
export interface AnomalyCrossAssetContext {
  regime: string;
  tapeAlignment: 'aligned' | 'contradicted' | 'neutral' | 'missing';
  dpCluster: 'none' | 'small' | 'medium' | 'large' | 'na';
  gexZone: 'above_spot' | 'below_spot' | 'at_spot' | 'na';
  vixDirection: 'rising' | 'flat' | 'falling' | 'unknown';
}
```

Add optional `crossAsset?: AnomalyCrossAssetContext` to `ActiveAnomaly` type, OR pass via separate prop (decision: separate prop keeps `ActiveAnomaly` server-shape clean).

### F3 — Pill components (~2h)

**File:** `src/components/IVAnomalies/AnomalyRow.tsx` (modify)

Add 5 new pill components and place them in the row header after the existing `PatternPill`. Order chosen so the most globally-applicable pills come first (regime, tape) and ticker-specific ones (DP, GEX) come last.

```tsx
<RegimePill regime={crossAsset?.regime} />
<TapeAlignPill alignment={crossAsset?.tapeAlignment} />
<DPClusterPill cluster={crossAsset?.dpCluster} />
<GEXZonePill zone={crossAsset?.gexZone} />
<VIXDirPill direction={crossAsset?.vixDirection} />
```

Each pill follows existing pattern:

- 10px font, rounded-full, px-2 py-0.5
- color encodes outcome strength (green = bullish-confluent, red = contradicted, neutral = gray)
- `data-testid` for E2E reliability
- Tooltip referencing Phase D/E finding (e.g., "Falling VIX + put = 18.5% historical win rate, n=324")

**Color map per pill type:**

| Pill          | Bullish-confluent                                     | Bearish-confluent     | Neutral / NA              |
| ------------- | ----------------------------------------------------- | --------------------- | ------------------------- |
| Regime        | green for `*_up`                                      | red for `*_down`      | gray for chop             |
| Tape align    | green when aligned                                    | red when contradicted | gray when missing/neutral |
| DP cluster    | sky-blue for `large`                                  | (no bearish)          | gray for none/na          |
| GEX zone      | green when below_spot for calls / above_spot for puts | red on opposite       | gray for at_spot/na       |
| VIX direction | green for falling                                     | red for rising        | gray for flat/unknown     |

Color depends on the alert's `side` for GEX zone (since the same position is bullish-confluent for one side and bearish for the other).

### F4 — Tests (~2h)

**File:** `src/components/IVAnomalies/__tests__/AnomalyRow.test.tsx` (modify)

Add cases:

- Renders all 5 pills when `crossAsset` is provided
- Renders gray/missing variants when `crossAsset` is undefined
- DP cluster pill renders `'na'` for non-SPXW tickers
- GEX zone pill swaps color based on side (call vs put)
- Tooltip text references the relevant Phase D/E finding

**File:** `src/hooks/__tests__/useAnomalyCrossAsset.test.ts` (new)

- Mock fetch returns context map
- Hook polls every 30s when marketOpen
- Hook does NOT poll when market closed
- Hook handles non-200 responses gracefully (returns empty map; no throw)
- Hook deduplicates concurrent fetches

## Constraints

- **Strictly visual.** Phase F does not change sorting, alert
  prominence, banner behavior, or audio cues. The pattern pill from
  D4 already follows this rule — F adopts the same.
- **No automatic filtering.** Even when all 5 pills are red
  (maximum contradiction), the alert still renders normally. The
  trader can choose to ignore it or not.
- **Sample-size labeling.** The DP cluster `large` bucket is the
  91.7%-win finding from E2 with n=36. Tooltip explicitly says
  "tentative — n=36" so the user doesn't anchor on it.
- **Graceful degradation.** When the cross-asset endpoint fails or
  is slow, the pills render as gray "loading" / "unknown" rather
  than blocking the row.
- **No mutation of `ActiveAnomaly`.** Cross-asset context is a
  parallel data source; passing it as a separate prop keeps the
  server contract shape stable.

## Out of scope (deferred to Phase G)

- **Analyze-prompt enrichment** — wiring cross-asset context into
  `analyze-context.ts` so Claude reasons with the same signals.
  Separate spec.
- **Sort-by-confluence** — ordering active alerts by how many
  filters confluence. Risks anchoring decisions; defer until
  patterns survive more data.
- **Alert sound differentiation** — different chime for high-
  confluence alerts. Audio is more intrusive than visual; needs a
  separate UX decision.
- **Per-(ticker, regime) BEST_STRATEGY display** — useful for
  exit-timing reasoning, but a separate UI surface (suggested in
  the expanded view, not the row header).

## Time estimate

**~8-10h total** — F1 (~3h) + F2 (~2h) + F3 (~2h) + F4 (~2h)

## Dependencies

- Existing tables: `futures_bars`, `spx_candles_1m`,
  `dark_pool_levels`, `greek_exposure_strike`, `market_snapshots`
- Existing crons keep these populated; no new ingestion required
- Frontend bot-id `protect` array gets new path:
  `/api/iv-anomalies-cross-asset`
- No DB migration

## Deliverables

- `api/iv-anomalies-cross-asset.ts` (new endpoint)
- `api/__tests__/iv-anomalies-cross-asset.test.ts` (new)
- `src/hooks/useAnomalyCrossAsset.ts` (new)
- `src/hooks/__tests__/useAnomalyCrossAsset.test.ts` (new)
- `src/components/IVAnomalies/types.ts` (extend with
  `AnomalyCrossAssetContext` type)
- `src/components/IVAnomalies/AnomalyRow.tsx` (add 5 pill
  components)
- `src/components/IVAnomalies/__tests__/AnomalyRow.test.tsx`
  (extend with pill render cases)
- `src/main.tsx` (add new endpoint to `protect` array)

## Open questions to confirm before starting

1. **Pill placement** — after `PatternPill` (last in the existing
   pill cluster) seems right. Confirm before implementation.
2. **Regime label format** — full string `mild_trend_up` is verbose;
   abbreviation `mild↑` is denser but less explicit. I'll default to
   the abbreviation if not told otherwise.
3. **DP cluster `na` label** — for non-SPXW tickers, render the pill
   as `na` (visible but gray) or hide it entirely? My default:
   render as `na` so visual layout stays consistent across rows.
4. **VIX direction `unknown` rate** — Phase E3 found 6,576 alerts
   had unknown VIX. The live data should be denser, but we should
   surface "unknown" honestly rather than guess. Confirmed default.

## Subagent handoff

This phase has 4 substantially-independent sub-phases that can
parallelize:

- F1 (backend) — touches only `api/`
- F2 (hook) — touches only `src/hooks/` + types
- F3 (UI) — touches only `src/components/IVAnomalies/`
- F4 (tests) — touches `__tests__/` in both halves

Recommended dispatch via `subagent-driven-development`:
F1 + F2 in parallel first, F3 + F4 in parallel second (F3 needs F2's
hook signature, F4 covers both sides).
