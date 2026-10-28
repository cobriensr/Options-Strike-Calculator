# Panel payload guards (2026-10-28)

## Goal

A malformed API response must degrade one panel, not blank the whole page. Today an unexpected payload shape from `/api/history`, `/api/opening-flow-signal` or `/api/pin-setup-status` throws during render, outside any error boundary, and the page falls back to the root error screen. The owner asked for this fix on 2026-10-28.

## Background

Found during the E2E repair (`e2e-ci-repair-2026-10-26.md`, phase 2). The fetch mock answered unmocked `/api/*` calls with `{}`, and three render paths crashed on it:

- `src/App.tsx:945`: `historyData.history?.spx.candles`. `useHistoryData` (`src/hooks/useHistoryData.ts:88-108`) returns `await res.json()` unchecked, so `{}` is stored as the history and `.spx.candles` throws. `useHistoryData.ts:295-297` reads `history.spx.candles` the same way.
- `src/components/OpeningFlowSignal/OpeningFlowSignal.tsx:122`: `displayData.tickers[ticker]` with `tickers` undefined. The data comes from `src/hooks/useOpeningFlowSignal.ts`.
- `src/components/PinSetupTile/index.tsx:97`: `data.state.replace('_', ' ')` with `state` undefined.

The E2E harness now fails unmocked calls like a dead backend (commit e5c3bd18), so the suite no longer hits this. Production still can: an API that returns 200 with an unexpected body (a deploy skew, an upstream change, a partial error body) takes the page down.

**Precedent:** `src/hooks/useGreekHeatmap.ts` already validates its response with Zod schemas at the fetch boundary, with types derived via `z.infer`. Match that pattern. `src/components/ErrorBoundary.tsx` exists, and `GatedSection` already wraps lazy panels in it.

## Phases

### Phase 1: the three known crash paths (TDD)

1. **Tests first.** For each hook (`useHistoryData`, `useOpeningFlowSignal`, and whatever fetches `/api/pin-setup-status`), add a test feeding a 200 response with `{}` and with a wrong-typed field. Expect an error or empty state, not a thrown render or a stored malformed object.
2. **Validate at the fetch boundary** with a Zod schema covering the fields the UI reads. On a mismatch:
   - treat it like a failed fetch: the existing error/empty state, with no partial data stored;
   - surface it by name, following whatever `useGreekHeatmap` does on a parse failure (a Sentry capture or log). Silent swallowing is not OK (R4).
3. **Per-panel boundaries.** Wrap OpeningFlowSignal, PinSetupTile and the history-fed panel at `App.tsx:945` in `<ErrorBoundary label="…">` (or confirm they already sit inside a `GatedSection`), so a future render bug degrades one panel.
4. **E2E regression.** Add a spec where `/api/history`, `/api/opening-flow-signal` and `/api/pin-setup-status` are fulfilled with `{}` (200), and assert the calculator still renders and computes. It must use the `e2e/helpers` conventions.

### Phase 2: audit the other fetch sites

About 31 `src/` files call `fetch('/api/…')`. List each one that reads nested fields of an unvalidated response and renders outside an error boundary. Fix the ones that can crash the page the same way (≤5 files per commit). Report the rest.

**Leads from Phase 1 (2026-10-28):**

- **Validation.** Phase 1's implementer counted 32 `src/` files calling `/api` directly. Only 4 hooks validate the response (`useGreekHeatmap`, `useHistoryData`, `useOpeningFlowSignal`, `usePinSetupStatus`), and there are 30 unchecked `res.json() as …` casts.
- **Highest-leverage fix:** `PanelRouter` runs each panel's render function outside every boundary. Wrapping each call in its own `ErrorBoundary` component would protect every panel at once.
- **No boundary at all:** `sec-datetime`, `sec-spot-price`, `sec-premarket-futures`, `sec-advanced`, `sec-iv`.
- **To verify against prod:** the history schema requires `previousClose` to be a number. If Schwab ever omits it, the history is rejected and Sentry reports it.

## Files

- **Phase 1:**
  - `src/hooks/useHistoryData.ts`, `src/hooks/useOpeningFlowSignal.ts`, the pin-setup fetch site;
  - `src/App.tsx` (boundaries);
  - their tests under `src/__tests__/`;
  - one new `e2e/*.spec.ts`.
- **Phase 2:** per the audit.

## Data dependencies

None.

## Open questions

- **A schema mismatch with otherwise-usable data** (e.g. one optional field wrong). **Default:** reject the whole payload (same as a failed fetch). Partial acceptance hides drift.
- **The `.js` extension rule** applies if any schema module is imported by `api/`. **Default:** keep the schemas in `src/` and don't share them with `api/`.
- **First-paint cost of zod. Decided: accepted (2026-10-28).** `useHistoryData` and the Pre-Market cards import zod eagerly, so it now ships in the entry chunk. Measured with `vite build`:

  | Entry chunk | Raw | Gzip |
  |---|---|---|
  | Full zod | 519.68 KB | 144.83 KB |
  | zod/mini | 484.42 KB | 134.72 KB |
  | No zod | 422.76 KB | 116.86 KB |

  `zod/mini` saved only about 10 KB gzipped, under the 25 KB bar, so the schemas stay on full zod (+28 KB gzip vs no zod).

## Phase 1 outcome (2026-10-28)

- **Commits** `5b0dd47c`..`abcf6426` (10).
- **Shared helpers** in `src/lib/response-guard.ts`:
  - issue formatting (`path: message` strings, since Sentry's depth-3 normalize turned issue objects into `"[Object]"`);
  - a per-request report latch (`claimReport`), so a persistently bad payload reports once, not every poll tick.
- **The history schema** keeps SPX `previousClose` strict and defaults it to 0 for the VIX family. Schwab may omit it on empty days, and 0 is what `api/history.ts` already sends for a failed symbol.
- **Fields the UI doesn't read** are optional. The enums stay strict.
- **Non-JSON 2xx bodies** are reported under their own name.
- **Pin setup** aborts superseded fetches, and shows an "update failed" badge next to its last good status.
- **`useGreekHeatmap`** got the same reporting fixes.
