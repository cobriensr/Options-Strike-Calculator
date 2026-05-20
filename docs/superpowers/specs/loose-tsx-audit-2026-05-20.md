# Loose Top-Level `src/components/*.tsx` Audit — 2026-05-20

**Context:** Phase 3D of the frontend cleanup spec
(`frontend-cleanup-tiers-1-2-3-2026-05-18.md`) listed "fold any >250 LOC
into folders" as an optional follow-up after the 5 entry-point renames
(LotteryFinder, SilentBoom, Tracker, Gexbot, GreekHeatmap). This audit
inventories the candidates and recommends which ones are worth doing.

## Inventory (sorted by LOC, descending)

| LOC | File | Internal `function` decls | Recommendation |
|-----|------|---------------------------|----------------|
| 484 | DarkPoolLevels.tsx | 3 | **Fold** — has local `formatPremium`, `formatDist`, `SORT_LABELS` const + a memo'd default export with internal sub-tables (sorted/filtered/scrubbed views). Natural split: `index.tsx` (memo + props) + `DarkPoolRow.tsx` (per-level row markup) + `SortControls.tsx` (sort cycle UI) + `formatters.ts` (the 3 pure helpers). |
| 462 | AdvancedSection.tsx | 1 | **Fold** — only 1 internal function but a single ~450-line component is a maintenance smell. Likely splits into the discrete advanced-input subsections (multiplier, theme picker, etc.). Inspect first to confirm cohesive subsections exist. |
| 384 | AppHeader.tsx | 1 | **Defer** — header bars naturally accumulate; sub-pieces (auth menu, panel-prefs button, theme toggle) are already in their own files. The 384 LOC is mostly layout + conditional rendering, not extractable logic. Worth a content-density audit instead. |
| 378 | PinSetupTile.tsx | 4 | **Fold** — 4 internal functions = 4 candidate sub-components. Likely splits into `PinPrompt`, `PinStatus`, `PinDismissed`, and the orchestrator. |
| 310 | PreMarketInput.tsx | 0 | **Defer** — 0 internal functions means one cohesive component. LOC is likely conditional UI/branching, not nested sub-components. Refactor opportunity is small. |
| 308 | ThetaDecayChart.tsx | 6 | **Fold** — 6 internal helpers strongly suggest extractable pieces (chart axes, tooltips, scale helpers). Natural split: `index.tsx` + `chart-math.ts` (pure) + `Tooltip.tsx`. |
| 303 | BacktestDiag.tsx | 2 | **Defer** — diagnostic widget, 2 internal helpers. Tightly coupled to App.tsx state. Low ROI unless touched in feature work. |
| 266 | DeltaStrikesTable.tsx | 0 | **Defer** — table renderer at the LOC threshold, 0 internal functions. Likely a single cohesive component. Skip. |

## Recommended action

**Fold these 4 in a follow-up Tier 3 cleanup:**
1. DarkPoolLevels — 484 LOC, has 3 internal helpers (highest ROI)
2. AdvancedSection — 462 LOC, second largest
3. PinSetupTile — 378 LOC, 4 internal functions
4. ThetaDecayChart — 308 LOC, 6 internal helpers (chart math)

**Skip these 4 (low ROI):**
5. AppHeader, PreMarketInput, BacktestDiag, DeltaStrikesTable — either single-cohesive-component or tightly coupled to App.tsx state.

## Notes

- The spec listed `MarketRegimeSection` as an "obvious candidate" but it's only 213 LOC today, already under the 250 threshold. The 3D-era audit was based on an older snapshot.
- This is purely a maintenance/readability pass; no behavior changes. Each fold can ship independently. Estimate ~30 min per fold = ~2 hours total for the 4 recommended.
- Defer until after a feature pause; don't interleave with active product work in those files.

## Status

Audit complete. Folds NOT executed in this session — explicitly marked
optional in the spec, and the user can prioritize against incoming
feature work.
