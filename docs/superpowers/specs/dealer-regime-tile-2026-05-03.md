---
status: Shipped
date: 2026-05-03
---

# Dealer Regime Tile — Phase 2 of Strike Battle Map

**Status:** Spec — ready to build
**Author / owner:** Charles
**Date:** 2026-05-03
**Parent spec:** `docs/superpowers/specs/strike-battle-map-2026-05-03.md` (Phase 2 section)
**Audit prerequisite:** `docs/tmp/zero-gamma-audit/AUDIT_FINDINGS.md` — UNBLOCKED, Concern #1 closed via TRACE spot-check on 2026-05-01

## Goal

Surface the dealer-gamma regime at spot for **SPX, SPY, QQQ, NDX** as a compact 4-cell tile sitting above the Strike Battle Map. The tile classifies each ticker into one of four states — `long-γ`, `short-γ`, `transition`, or `uncertain` — derived from `zero_gamma_levels` so traders can read the "is this market dampening or amplifying right now" question in one glance without having to interpret the underlying number.

This is the second consumer of `zero_gamma_levels` (after the Anthropic analyze context). The audit verified the data is sane enough to drive a regime classifier; this spec defines the classifier and the UI.

## Non-goals

- No predictive modeling. The tile reflects _current_ dealer regime, not _projected_ regime.
- No trade signals or entries derived from the tile — that's Phase 3 territory.
- No new data sources. Reads only `zero_gamma_levels` (already populated by the `compute-zero-gamma` cron).
- No cross-ticker regime aggregation. Each cell is independent.

## Locked decisions (from scoping conversation 2026-05-03)

| Setting                   | Value                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| Tickers                   | SPX, SPY, QQQ, NDX (all four — already in `zero_gamma_tickers.ts`)                                   |
| States                    | `long-γ` / `short-γ` / `transition` / `uncertain`                                                    |
| Sign convention           | Direct: `net_gamma_at_spot > 0` ⇒ dealers long γ (interpretation #1, confirmed via TRACE spot-check) |
| Confidence gate           | `confidence < 0.10` ⇒ `uncertain` (Concern #3 from audit)                                            |
| Boundary buffer           | `\|spot − zero_gamma\| / spot < 0.3%` ⇒ `transition` (covers the EOD ambiguity case)                 |
| Mount                     | Own section above Strike Battle Map                                                                  |
| Cadence                   | Polls every 30s during market hours (matches Strike Battle Map / SectionBox sibling pattern)         |
| Live mode only on Mondays | Daemon writes forward; backfilled days exist via `compute-zero-gamma` cron, so historical reads work |

## Classifier rules

Inputs per ticker (from the latest `zero_gamma_levels` row):

- `spot: number`
- `zero_gamma: number | null`
- `confidence: number` (0–1)
- `net_gamma_at_spot: number` (signed, dealer-side)

Output: one of `long-γ` | `short-γ` | `transition` | `uncertain`.

Decision tree (apply in order, first match wins):

1. **`uncertain`** if any input is null OR `confidence < 0.10` OR the row is older than 15 minutes (stale data guard).
2. **`transition`** if `zero_gamma != null` AND `|spot − zero_gamma| / spot < 0.003` (within 0.3% of the crossing — too close to call).
3. **`long-γ`** if `net_gamma_at_spot > 0`.
4. **`short-γ`** if `net_gamma_at_spot < 0`.
5. **`uncertain`** fallthrough (defensive — should never hit given step 4).

Confidence gate, boundary buffer, and stale-data guard are independent — any one of them overriding to `uncertain` or `transition` short-circuits the sign read.

## Data dependencies

- **Read source:** `zero_gamma_levels` table (already populated by `api/cron/compute-zero-gamma.ts`). No new tables.
- **Per-ticker policy:** `api/_lib/zero-gamma-tickers.ts` (already covers SPX/SPY/QQQ/NDX with appropriate per-ticker expiry rules).
- **Auth tier:** Owner-or-guest, matching sibling `/api/zero-gamma`, `/api/spot-gex-history`, `/api/gex-strike-expiry`.
- **Env vars:** None new. `DATABASE_URL` already in place.
- **No new migrations.**

## Files to create / modify

### Phase 1 — Backend read helper + endpoint (new)

- `api/_lib/db-dealer-regime.ts` (new) — `getLatestDealerRegime(tickers): Promise<DealerRegimeRow[]>` returns the latest row per ticker via `DISTINCT ON (ticker) ORDER BY ticker, ts DESC`.
- `api/dealer-regime.ts` (new) — `GET /api/dealer-regime` Vercel Function. No query params (always returns all four tickers). Owner-or-guest guard. 30-second cache with `Vary: Cookie`. Returns `{ rows: DealerRegimeApiRow[], asOf: string }`.
- `api/_lib/validation.ts` (modify) — add `dealerRegimeQuerySchema = z.object({}).strict()` for completeness (no params expected; reject any).
- `src/main.tsx` (modify) — add `/api/dealer-regime` to the BotID `protect` array.

### Phase 2 — Hook + classifier logic (new)

- `src/hooks/useDealerRegime.ts` (new) — fetches `/api/dealer-regime`, polls every 30s during market hours, owner-or-guest tier (returns nulls + idle for anon visitors).
- `src/components/DealerRegimeTile/classify.ts` (new) — pure `classify(input): DealerRegimeState` function implementing the decision tree above. Exported separately so it's unit-testable without React.

### Phase 3 — UI + mount (new + modify)

- `src/components/DealerRegimeTile/index.tsx` (new) — `<DealerRegimeTile marketOpen />` renders 4 cells in a single row: ticker label, state badge (color-coded), spot vs zero-gamma deltas, confidence indicator. Inherits the SectionBox + collapsible pattern.
- `src/components/DealerRegimeTile/Cell.tsx` (new) — single-cell render with hover tooltip showing the underlying numbers.
- `src/App.tsx` (modify) — mount `<DealerRegimeTile />` immediately above `<StrikeBattleMap />`.

### Phase 4 — Tests

- `api/__tests__/dealer-regime.test.ts` (new) — endpoint tests: 401 for anon, 200 for owner with mocked DB, schema reject of unknown query params.
- `src/__tests__/components/DealerRegimeTile.test.tsx` (new) — render tests: 4 cells, state-badge color mapping, low-confidence ⇒ uncertain, stale data ⇒ uncertain, transition near zero-gamma.
- `src/__tests__/lib/dealer-regime-classify.test.ts` (new) — pure-logic table tests covering each branch of the decision tree.

### Phase 5 — Post-launch verification (one-shot, no new code)

- One-time TRACE cross-check during a Monday session with spot clearly inside deep blue OR deep red. Confirms classifier matches visual read on a non-borderline day. Document in `docs/tmp/zero-gamma-audit/AUDIT_FINDINGS.md` as a closing note.

Total: 9 new files + 3 modifications across 5 phases. Each phase fits under the 5-files-per-phase ceiling per CLAUDE.md.

## Visual design — sketch

```text
┌─ Dealer Regime ─────────────────────────────────────────────┐
│  SPX        SPY        QQQ        NDX                       │
│  long-γ     long-γ     transition uncertain                 │
│  ───────    ───────    ─ ─ ─ ─    ░░░░░░░                   │
│  +3.6B      +1.2B      −0.2B      —                         │
│  zg 7187    zg 619.4   zg 521.1   zg —                      │
│  conf 0.39  conf 0.18  conf 0.42  conf 0.04                 │
└─────────────────────────────────────────────────────────────┘
```

Color tokens (Tailwind):

- `long-γ` → `bg-sky-400/15 text-sky-300 border-sky-400/40` (matches StrikeRow.tsx GAMMA_POS hue)
- `short-γ` → `bg-amber-400/15 text-amber-300 border-amber-400/40` (matches GAMMA_NEG)
- `transition` → `bg-zinc-400/10 text-zinc-300 border-zinc-400/30 border-dashed`
- `uncertain` → `bg-zinc-700/30 text-zinc-500 border-zinc-700/40`

Hover tooltip per cell shows: `spot`, `zero_gamma`, `net_gamma_at_spot`, `confidence`, `ts` formatted as CT time.

## Thresholds / constants — locked

```ts
export const REGIME_CONFIDENCE_GATE = 0.1; // below ⇒ uncertain
export const REGIME_BOUNDARY_PCT = 0.003; // 0.3% of spot ⇒ transition
export const REGIME_STALE_AGE_MS = 15 * 60 * 1000; // 15 min ⇒ uncertain
```

These ride alongside the existing zero-gamma constants — likely co-located in a new `api/_lib/dealer-regime-constants.ts` so the frontend hook and the classifier both consume the same values.

## Open questions — none

All four scoping questions resolved. Sign convention confirmed via TRACE spot-check. Ship sequence is unblocked.

## Build sequence (suggested)

1. **Phase 1 commit**: backend (db helper + endpoint + validation + BotID register). Deploy. Smoke-test the JSON response against a known timestamp.
2. **Phase 2 commit**: hook + pure classifier with classify.ts unit tests. Verify the classifier's output against a hand-computed table of cases.
3. **Phase 3 commit**: UI components + mount. Visual smoke-test in `npm run dev:full`.
4. **Phase 4 commit**: integration / endpoint / render tests. `npm run review` clean.
5. **Phase 5 (post-launch, no commit)**: TRACE cross-check during a Monday session.

Each phase is independently shippable and reviewable.

## Risks

| Risk                                                                                               | Mitigation                                                                                                             |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Most rows have `confidence < 0.10` ⇒ tile says `uncertain` 80% of the time                         | The 0.10 gate is conservative. Track the state distribution post-launch; relax to 0.05 if `uncertain` dominates        |
| Boundary buffer of 0.3% misses transition cases on volatile days                                   | The buffer is intentionally tight. Re-tune after first volatile session if classifier flickers between states          |
| `compute-zero-gamma` cron silently fails ⇒ stale rows ⇒ tile says `uncertain` for hours undetected | Stale-data guard (15-minute age) enforces the failure mode is visible (`uncertain` cells) rather than a stale `long-γ` |
| Sign convention drifts if UW changes their per-leg sign tagging                                    | Phase 5 TRACE spot-check is one-time; add a daily cron-driven sanity probe in a follow-up if drift is suspected        |

## Decision log

- **2026-05-03 — locked four states (long-γ / short-γ / transition / uncertain)**: three-state was considered but the EOD boundary case in the audit motivated the `transition` state explicitly, rather than collapsing it into either side and producing flickering reads.
- **2026-05-03 — locked all four tickers, not SPX-only**: user trades 0DTE SPX but the tile is regime context, not a trade signal; SPY/QQQ/NDX read alongside SPX makes intermarket divergences obvious in one glance.
- **2026-05-03 — locked own-section mount above Strike Battle Map**: header-strip variant was considered but the tile carries enough information per cell (state + spot + zero-γ + conf) that it'd compress poorly into a header. Owning a row keeps the tile readable.
- **2026-05-03 — interpretation #1 (dealer-signed) confirmed via TRACE spot-check**: closes audit Concern #1; no label-flip in the classifier.
