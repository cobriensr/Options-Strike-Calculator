# Full Frontend Design Review (2026-06-11)

Companion to `2026-06-11-frontend-recomposition-design.md`. That spec was
written from a live review of the signed-out surface; this document covers
the **entire** `src/` component tree — 312 files, ~60,600 LOC, reviewed by
five parallel reviewers against a shared rubric (token discipline,
typography, density, hierarchy, states, consistency, a11y, structure).

## Verdict

The token system and the newest panels are in good shape — but the design
system landed **mid-project and roughly half the app was never migrated
onto it**. The newest components (GammaNodeDetector, PinRiskAnalysis,
PeriscopeLottery, FlowRegimeBadge, Tracker, ChartAnalysis results subtree,
DarkPoolLevels) are token-disciplined exemplars. The older/bigger surfaces
(the GEX family, the LotteryFinder/SilentBoom feeds, PeriscopeChat,
GreekHeatmap, Regime0dte, both canvas charts) are dark-only raw-Tailwind
islands that bypass the tokens entirely and **break in light mode**.

The recomposition spec's five phases all survive, but this review adds a
required foundation layer beneath them (see "Impact on the spec" at the
end).

## Systemic findings (ranked by leverage)

### S1. The pixel type scale is not wired into Tailwind [high]

`--text-2xs…--text-xl` live in `:root` (src/index.css:86-91), not in
`@theme`, so Tailwind never generates utilities from them and zero code
references `var(--text-*)`. Two competing type systems resulted:

- 1,226 arbitrary `text-[Npx]` literals — including off-scale strays:
  `text-[12px]` ×78, `text-[9px]` ×56, `text-[8px]` ×14, `text-[7px]` ×2
- 477 Tailwind-default named sizes (`text-xs`=12px ×292, `text-sm`=14px
  ×114, `text-base`=16px ×42) — none of which exist on the 8/10/11/13/15/16
  scale. `mkTd()` (ui-utils.ts:67) emits 14px cells inside tables declared
  13px. Tracker uses `text-[12px]` while PositionMonitor uses `text-xs`
  for the same row roles.

**Fix:** move the scale into `@theme` so `text-xs` *means* 10px, add a
display-size token for hero numerals (current ad-hoc range: 18–28px),
then sweep mechanically. Off-scale sizes become lint-able.

### S2. Dark-only raw-palette islands break light mode [high]

Whole folders style with raw `neutral-*`/`slate-*`/`zinc-*`/
`emerald-/rose-/sky-/amber-*` classes that don't respond to the `.dark`
toggle. In light mode these render dark-on-dark or near-invisible text.

Islands: **Gexbot** (all 8 panels, `border-white/5 bg-white/[0.02]`),
**GreekHeatmap** (its own parallel neutral-800/900 theme),
**GexLandscape** (constants.ts palette maps), **PeriscopeChat** (all 8
files), **Regime0dte**, **OpeningFlowSignal/SignalCard** (slate — a third
family), **LotteryFinder / SilentBoom / IntervalBAFeed** feeds, both
canvas/SVG charts (`ContractTapeChart`, `TickerNetFlowChart` hardcode
every color despite `--color-chart-*` tokens and the in-repo
`getComputedStyle` precedent in GexTarget/PriceChart.tsx:160). The shared
primitive `ui/filter-toolbar-tokens.ts` itself is 100% raw palette, which
seeded the feed divergence.

**Fix:** extend the token family (`--color-bull/bear/warn/info` + tint
steps via `color-mix`, `--color-chart-*` series colors), re-express
`filter-toolbar-tokens.ts` on tokens, sweep the islands, and add a lint
gate banning raw palette color classes in `src/components/`.

### S3. Raw transport errors reach the user at 33+ sites [high]

`DataUnavailable` does not exist yet; hooks throw `` `HTTP ${res.status}` ``
and panels render it verbatim (`Error: HTTP 403` for guests). Confirmed
sites span every slice: LotteryFinder/index.tsx:1789, SilentBoom:1722,
IntervalBAFeed:292, VegaSpikeFeed:323, OpeningFlowSignal:99, GexLandscape
:426, GexTarget:329, Gexbot ×7, ZeroGammaPanel:130, GreekFlowPanel:182,
GreekHeatmap:293, StrikeBattleMap:249, DealerRegimeTile:185,
GammaNodeDetector:45, DarkPoolLevels:326, Regime0dte:66, PinSetupTile:114,
PeriscopeChat ×4, PeriscopeLottery:95, ChartAnalysis ×3, MLInsights:179,
Tracker:167, ErrorBoundary.tsx:46 (raw `error.message` in a `<pre>`).

The recomposition spec assumed ~2 panels; the real scope is **the whole
app**. FuturesPanel.tsx:191-228 and DarkPoolLevels (skeleton :303,
designed empty state :339) are the in-repo templates to standardize on.

### S4. Primitive gaps drive mass duplication [high]

What exists is underused; what's missing is hand-rolled everywhere:

- **Chip vs FilterChip** overlap: two toggle-chip primitives, two visual
  languages (token pill vs raw-palette rounded-md). ≥9 more local
  chip/toggle/segmented-control implementations in the calculator slice
  alone. Merge into one tokenized Chip with variants + a segmented
  control.
- **Dead/broken primitives:** `SortableHeader` exported, zero call sites
  (4 competing th-style sources exist instead); `text-text` class in
  DateInput.tsx:41, TimeInputCT.tsx:41, OpeningFlowSignal.tsx:77 —
  **no `--color-text` token exists, the class silently no-ops** (should
  be `text-primary`); Tooltip.tsx:209 uses `animate-in fade-in` classes
  from a plugin that isn't installed (no entry animation).
- **Missing primitives by clone count:** `Stat` block (9+ hand-rolled
  label-over-mono-value clones), `Modal` (3 divergent hand-rolls — none
  traps focus), `TintedBanner` (~10 clones), `Badge/Pill` (5+ recipes:
  `tint()`, inline color-mix, raw palette), `Stepper` (4 at four
  heights), shared `chartPalette()` reader, `Annotation` (serif italic
  footnote — the serif voice is almost never used despite being the
  system's editorial font).
- **Four scrubber implementations** of the same concept
  (`ScrubControls`, `ui/ScrubControlsCompact` ← canonical,
  `GreekHeatmap/MinuteScrubber`, `StrikeBattleMap/MinuteScrubber` — two
  distinct components share the latter name; DealerRegimeTile imports one
  cross-folder).
- **Tooltip vs title:** 329 `title=` attributes vs 8 `<Tooltip>` usages.

### S5. Hierarchy and badge overload — measured [high]

- A maxed **LotteryRow renders 20+ chips** before the ticker (which gets
  pushed to line 2 as a layout workaround — LotteryRow.tsx:819). Per the
  tag-value study, only tier/score, SPX gamma-sign (GEX/HIGH-Γ), and
  fire-count/burst separate outcomes; tide, flow-match, RELOAD,
  cheap-call-PM, TOD, TakeItScore tile, quintile, MEGA-CLUSTER, DUAL FLAG
  are decorative → demote to the expanded panel/tooltips. Same on
  SilentBoomRow and both TickerGroup headers (~13 elements).
- **Nested SectionBoxes:** GexTarget wraps five child SectionBoxes inside
  its own (index.tsx:384 + TargetTile/UrgencyPanel/SparklinePanel/
  PriceChart/StrikeBox), patched with `[&>section]:mt-0`.
  FuturesCalculator hand-copies the SectionBox card classes inside
  FuturesPanel's SectionBox. ResultsSection, IronCondorSection,
  BWBSection, CalcHeader each re-implement the collapse header.
- **Inconsistent shared vocabulary across the GEX family:** three
  different color codings for dealer-gamma sign (sky/amber vs
  emerald/rose vs calm-emerald); three "top-5 GEX strikes" presentations;
  three ATM-highlight treatments; legends present on StrikeBattleMap but
  absent on the visually similar histograms.
- **Status-pill fragmentation:** LIVE/SCRUBBED/STALE (StatusBadge,
  correct) vs local Live/Scrubbed pills, bare-text LIVE buttons,
  FRESH/MISSED/STALE, LIVE/DELAYED, `'● live'` lowercase — six
  vocabularies for one concept. Banner-severity ladders spelled six ways
  (CALM/NORMAL/ELEVATED/EVENT RISK, GREEN LIGHT/PROCEED/CAUTION/HIGH
  ALERT, …).

### S6. Layout/chrome debt [med]

- **Oversized inputs trace to one constant:** `inputCls`
  (ui-utils.ts:78) ≈ 50px tall + full width; consumed by every input
  section. One compact variant (~38px, capped widths) flips the entire
  setup surface — exactly the spec's Phase 2 lever.
- **Fixed-overlay anarchy:** five independent bottom-right fixed elements
  (Toast z-70, BackToTop z-65, IntervalBA banner z-80, UpdateAvailable
  z-300 with a `pushedUp` collision hack, BacktestDiag inline z-9999);
  z-index inventory: 5, 40, 50, 60, 65, 70, 80, 200, 201, 300, 9999.
  Needs one corner-anchored overlay layer + a z-scale.
- **Magic numbers duplicated:** `max-w-[660px]` ×3 (App, AppHeader,
  SectionNav), header height `top-[57px]` ×2 + `scroll-mt-28` ×3 →
  `--header-h`, `--content-max` vars.
- **AppHeader:** up to ~10 equal-weight buttons for the owner; admin
  plumbing (Migrate DB, Backfill, VIX CSV) has the same visual rank as
  the theme toggle. Needs an overflow/admin menu in the recomposition.
- **App.tsx panelMap:** the 77-entry dependency array (lines 768-1435)
  must be split (per-group renderer modules) **before** Phase 4 adds
  registry-driven widths, or the memo work from AUD-H6 unravels.

### S7. Honest-data and a11y spot items [med]

- VIXTermStructure renders **fabricated default values** (`'18.50'`/
  `'20.10'`) and a computed signal before live data arrives (index.tsx:43);
  same for OpeningRangeCheck (`'5735'`/`'5705'`). Show empty + placeholder.
- Gexbot/CharmClock.tsx:86 freezes "hours to close" at mount.
- SilentBoomRow.tsx:746 calls `Date.now()` in render (LotteryRow uses the
  `useNowMinute` value correctly).
- A11y: no modal traps focus; BackToTop stays keyboard-focusable while
  invisible; TrackerTabs `aria-controls` points at nonexistent ids;
  dismiss buttons missing `type="button"` (AlertBanner, IntervalBA
  banner, NotificationPermission); BWBInputs `bg-accent text-white`
  ≈ 2.2:1 contrast in dark mode (needs an on-accent token);
  `border-opacity-*` (dead in Tailwind 4) silently no-ops in
  PreMarketInput.tsx:166.

## Quick-fix list (clearly broken, independent of the redesign)

1. `text-text` → `text-primary` (DateInput.tsx:41, TimeInputCT.tsx:41,
   OpeningFlowSignal.tsx:77).
2. Tooltip.tsx:209 dead `animate-in fade-in` classes → use
   `animate-fade-in-up`.
3. PreMarketInput.tsx:166 dead `border-opacity-40`.
4. App.tsx:279 PWA `theme-color #121212` vs dark `--color-page #1a1a22`.
5. VIXTermStructure/OpeningRangeCheck fabricated defaults.
6. CharmClock frozen clock; SilentBoomRow render-time `Date.now()`.
7. Dismiss buttons missing `type="button"` (3 banners).
8. UrgencyPanel.tsx:65 class-string concat bug (`-mx-1bg-sky-500/10`).

## Impact on the recomposition spec

The five spec phases stand, but two get re-scoped and a foundation phase
precedes them:

- **New Phase 0 — Design-system foundation:** wire the type scale into
  `@theme` (S1); extend tokens (semantic tints + chart series + on-accent
  + display size + `--header-h`/`--content-max`/z-scale); tokenize
  `filter-toolbar-tokens.ts`; fix the quick-fix list; add the raw-palette
  lint gate. Everything later builds on this.
- **Phase 1 (tiers)** also absorbs: un-nesting GexTarget's five child
  SectionBoxes via a `SubPanel`/sub-header primitive, folding
  ResultsSection/IronCondor/BWB/CalcHeader collapse-header clones into
  the tier system, and making SkeletonSection share the SectionBox shell.
- **Phase 2 (setup strip)** is confirmed cheap: the `inputCls` compact
  variant is the lever; keep the uncontrolled DateInput wrapper (mobile
  picker quirk) and the `timeEdited` ↻ live-sync affordance; move the
  derived-ratio sub-panel behind a disclosure and the VIX term-structure
  block out of the IV input section (it's analysis, not input).
- **Phase 4 (two-column grid)** gains a prerequisite: split App.tsx's
  panelMap into per-group renderer modules first.
- **Phase 5 (DataUnavailable)** scope grows from ~10 to **33+ call
  sites**; standardize on the FuturesPanel/DarkPoolLevels state patterns;
  ErrorBoundary fallback becomes SectionBox-shaped.
- **New Phase 6 — Feed recomposition (Lottery/SB/IntervalBA):** badge
  cull per the tag-value study (keep tier, Γ-sign, burst, live EXIT/
  countdown; demote the rest), extract shared `FeedScrubBar` /
  `TickerGroupHeader` / `RegimeBanner` / `ContractDetailPanels` to stop
  LF↔SB drift (the three banners stacked above the feed get absorbed by
  the Today band), tokenize the feeds, collapse the 7-row filter
  toolbars.
- **New Phase 7 — Primitive consolidation (rolling):** Stat, Modal
  (with focus trap), TintedBanner, Badge/Pill, Stepper, segmented
  control, `chartPalette()`, scrubber unification, Chip+FilterChip
  merge, SortableHeader adopt-or-delete, GEX-family shared vocabulary
  (one dealer-gamma color coding, one ATM treatment, one top-5
  presentation, legends everywhere).

Suggested execution order: 0 → 1 → 2 → 5 (DataUnavailable early — it's
user-facing pain) → 3 → 4 → 6 → 7 rolling alongside.

## Slice inventory

| Slice | Files | LOC | Largest files |
| ----- | ----- | --- | ------------- |
| Alerts feeds (LF/SB/IntervalBA/Vega/OpeningFlow/banners) | 28 | 11,383 | LotteryFinder/index 1,997; SilentBoom/index 1,941; LotteryRow 1,380 |
| GEX/dealer family | 82 | 12,790 | GexLandscape/index 581; GexTarget/PriceChart 522 |
| Periscope/ChartAnalysis/MLInsights/charts | 41 | 8,644 | TickerNetFlowChart 992; ContractTapeChart 770 |
| Calculator & inputs | 76 | 12,483 | AdvancedSection 462; RiskInputs 461 |
| Chrome & shared (App, ui/, Tracker, PositionMonitor…) | 85 | 15,320 | App.tsx 1,634; AddContractForm 586 |
| **Total** | **312** | **~60,620** | |

Exemplars to pattern-match when migrating: GammaNodeDetector,
PinRiskAnalysis, DarkPoolLevels (states), FuturesPanel (states),
Tracker (token discipline), ChartAnalysis results subtree,
ui/ScrubControlsCompact's LIVE pill (the tinted-pill recipe done right).
