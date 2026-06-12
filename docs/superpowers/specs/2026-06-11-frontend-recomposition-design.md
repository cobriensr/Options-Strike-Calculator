# Frontend Recomposition — Design Spec (2026-06-11, rev 2)

## Goal

Restructure the calculator page's composition so visual hierarchy follows
glance frequency — market state first, results prominent, inputs compact —
and finish migrating the app onto its own design system, while keeping the
existing visual identity (Source Serif 4 / DM Mono / Outfit, color tokens,
table patterns).

This is a **recomposition**, not a reskin. No calculation behavior, hook
data flow, polling, or endpoint changes anywhere in this spec.

**Rev 2 (same day):** folded in the findings of the full 312-file design
review (`2026-06-11-frontend-design-review-full.md`). Adds Phase 0
(design-system foundation), re-scopes Phases 1/2/4/5, adds Phases 6–7.
That review document is the detailed evidence base for everything here;
this spec stays the buildable summary.

## Background

From the live review (signed-out surface) and the full static review:

1. Every section renders as the same full-width card with the same accent
   top-border (`SectionBox` hardcodes `border-t-accent border-t-[3px]`),
   so nothing has hierarchy.
2. Input controls are scaled like consumer forms — all traceable to one
   constant, `inputCls` (ui-utils.ts:78, ≈50px tall, full width) — and
   occupy the top of the page while regime/results live thousands of
   pixels down.
3. The pixel type scale is not wired into Tailwind's `@theme`; 1,226
   arbitrary `text-[Npx]` literals and 477 off-scale Tailwind-default
   sizes coexist.
4. Roughly half the app (Gexbot, GreekHeatmap, GexLandscape,
   PeriscopeChat, Regime0dte, the LF/SB/IntervalBA feeds, both canvas
   charts, `ui/filter-toolbar-tokens.ts` itself) styles with dark-only
   raw Tailwind palette classes that break in light mode.
5. Raw `HTTP <status>` strings reach the user at 33+ sites; no shared
   degraded-state component exists.
6. Primitive gaps drive mass duplication: 9+ Stat clones, 3 divergent
   modals (none traps focus), ~10 tinted banners, 5+ pill recipes, 4
   steppers, 4 scrubbers, Chip vs FilterChip overlap, 329 `title=` vs 8
   `<Tooltip>`.
7. Badge overload on feed rows (LotteryRow: 20+ chips; the tag-value
   study says only tier, Γ-sign, and burst separate outcomes); the GEX
   family uses three different color codings for dealer-gamma sign.
8. Single-column layout at all widths; ungrouped 13-item sidebar;
   bottom-right fixed-overlay anarchy (z 5…9999).

## Phases

Each phase is independently shippable and lands with tests in the same
commit. Execution order: **0 → 1 → 2 → 5 → 3 → 4 → 6 → 7** (5 moves up
because raw-error leaks are user-facing pain; 7 rolls alongside 4–6).

---

### Phase 0 — Design-system foundation (+ quick fixes)

Everything later builds on this. No visual redesign yet — wiring and
mechanical correctness.

**0a. Wire the type scale into `@theme`.** Move `--text-2xs…--text-xl`
from `:root` into the `@theme` block so Tailwind generates utilities from
them (`text-xs` = 10px, `text-sm` = 11px, `text-md` = 13px, `text-lg` =
15px, `text-xl` = 16px). Add a display-size token for hero numerals
(`--text-display`, 22px) to replace the ad-hoc 18–28px range. Sweep
mechanically: arbitrary `text-[Npx]` values on-scale → named utilities;
off-scale strays (7/9/12/14px) snap to the nearest step. The sweep may
split across commits by folder; the `@theme` wiring ships first.

**0b. Extend the token family.**
- Semantic intents usable from raw-palette islands: `--color-bull`,
  `--color-bear`, `--color-warn`, `--color-info` (+ light/dark values),
  with tinting via the existing `tint()`/`color-mix` convention.
- Chart series tokens: extend `--color-chart-*` (bull/bear candles, vwap,
  overlay series) for canvas/SVG charts to read via `getComputedStyle`
  (precedent: GexTarget/PriceChart.tsx:160).
- `--color-on-accent` (fixes white-on-`#7ba4ff` 2.2:1 fails).
- Layout vars: `--header-h`, `--content-max`; a z-index scale
  (`--z-nav/banner/overlay/toast/modal`).
- Re-express `ui/filter-toolbar-tokens.ts` on tokens (it currently seeds
  the raw-palette divergence in every feed).

**0c. Quick-fix list (clearly broken, mechanical):**
1. `text-text` → `text-primary` (DateInput.tsx:41, TimeInputCT.tsx:41,
   OpeningFlowSignal.tsx:77 — the class silently no-ops today).
2. Tooltip.tsx:209 dead `animate-in fade-in` classes → `animate-fade-in-up`.
3. PreMarketInput.tsx:166 dead `border-opacity-40` (no-op in Tailwind 4).
4. App.tsx:279 PWA theme-color `#121212` → dark `--color-page` `#1a1a22`.
5. VIXTermStructure (`'18.50'`/`'20.10'`) and OpeningRangeCheck
   (`'5735'`/`'5705'`) fabricated defaults → empty + placeholder.
6. Gexbot/CharmClock.tsx:86 frozen clock; SilentBoomRow.tsx:746
   render-time `Date.now()` → `useNowMinute`.
7. Missing `type="button"` on dismiss buttons (AlertBanner,
   IntervalBAAlertBanner, NotificationPermission).
8. GexTarget/UrgencyPanel.tsx:65 class-concat bug (`-mx-1bg-sky-500/10`).

**0d. Lint gate.** ESLint rule (or grep-based check in CI) banning raw
palette color classes (`neutral-`, `slate-`, `zinc-`, bare hue families)
in `src/components/` — grandfathering existing files via an allowlist
that shrinks as Phases 6–7 migrate them.

---

### Phase 1 — Card tiers + section-shell consolidation

`SectionBox` gains a `tier` prop:

```ts
tier?: 'primary' | 'standard' | 'quiet'   // default 'standard'
```

- **primary** — current look: accent top-border 3px. Reserved for the
  panels the user trades off of.
- **standard** — top border matches the other edges (1.5px
  `--color-edge`). The default.
- **quiet** — no card chrome: header row + hairline rule, content below.

Initial assignment via a `tier` field on the panel registry:

| Tier     | Panels |
| -------- | ------ |
| primary  | Results, Market Regime, 0DTE Gamma Regime |
| standard | everything else |
| quiet    | Analysis History, Periscope Lesson Library |

Absorbed from the full review:

- **`SubPanel` primitive** (titled tile, no card chrome) and un-nesting of
  GexTarget's five child SectionBoxes (TargetTile, UrgencyPanel,
  SparklinePanel, PriceChart, StrikeBox; drop the `[&>section]:mt-0`
  patch). FuturesCalculator's hand-copied card-inside-card gets the same
  treatment.
- **Collapse-header consolidation**: ResultsSection, IronCondorSection,
  BWBSection, and FuturesCalculator/CalcHeader re-implement SectionBox's
  collapse header; fold them into the tier system / `SubPanel`.
- **SkeletonSection shares the shell**: it currently copies SectionBox's
  card classes by string; extract the shell so tiers don't fork the
  loading vs loaded look.
- SectionBox shadow literal → `var(--shadow-subtle)`.

---

### Phase 2 — Compact setup strip

Merge **Date & Time**, **Spot Price**, and **Implied Volatility** into a
single standard-tier card: **Setup** (`sec-setup`, group `Inputs`).

One responsive grid of compact fields (control height ~38px via a new
`inputClsCompact` in ui-utils — the single-constant lever; labels 10px
caps; widths capped to content):

```
┌ SETUP ──────────────────────────────────────────────────────────┐
│ DATE        TIME                  SPY    SPX    RATIO  VIX  0DTE│
│ [date]  [hh][mm][AM|PM][ET|CT]  [input][input] (ro) [input][input] [VIX|Direct IV] │
└──────────────────────────────────────────────────────────────────┘
```

Constraints confirmed by the full review:

- Existing hooks (`useTimeInputs`, `useSpotInputs`, `useIvInputs`,
  `useAutoFill`) consumed unchanged — presentational only.
- **Keep the uncontrolled `DateInput` wrapper verbatim** (iOS
  Safari/Android Firefox dismiss the native picker if React touches the
  node).
- **Keep the `timeEdited` → "↻ Now / live sync paused" affordance** (it
  later migrates into the Today band).
- Derived-ratio sub-panel (slider + explanation) folds behind a
  disclosure; the resolved SPX number stays inline.
- The VIX regime guidance block and the Term Structure block (with its
  own VIX1D/9D inputs) move **out** of the IV section into Market Regime —
  they are analysis, not input.
- The 0DTE Adj `?`-tooltip migrates from the hand-rolled IVTooltip to
  `ui/Tooltip`.

Registry migration: `sec-datetime`, `sec-spot-price`, `sec-iv` →
`sec-setup`. `resolvePanelOrder` drops unknown stored ids and appends new
ones (cover with a test); stored panel-prefs orders degrade gracefully.
E2e specs targeting the old ids update in the same commit.

---

### Phase 3 — Today command band

A new `TodayBand` component rendered above the `PanelRouter` output (not
a registry panel: always visible, not reorderable or hideable).

One dense strip (wraps to 2 rows under `lg`), using the big-number stat
pattern and `StatusBadge` freshness vocabulary:

| Slot | Content | Source (existing App.tsx state) |
| ---- | ------- | ------------------------------- |
| Spot | SPX (large mono) + SPY, freshness pill | `useMarketData` / spot inputs |
| Vol  | VIX value + regime chip (`19.0 · CAUTION`) | `useVixData` / regime calc |
| Gamma | 0DTE gamma regime chip, or `PRE-OPEN` | same data as the 0DTE Gamma Regime panel |
| Range | Expected median / 90th H-L for current VIX bucket | same data as Market Regime |
| Clock | Market phase + time (`OPEN · 10:00 CT`) | `getCTTime` / market-hours utils |

- Read-only; renders whatever subset is available (signed-out shows spot
  from inputs + static VIX regime).
- Not sticky in v1. Each slot scroll-links to its full panel.
- The three feed banners (SessionQuality / Day / Tier on LF and the SB
  equivalents) are *not* duplicated here, but Phase 6 demotes them on the
  assumption the band carries the day-level context.

---

### Phase 4 — Two-column panel grid at `xl`

**Prerequisite (same phase, first commit): split App.tsx's `panelMap`**
(77-entry dependency array, lines ~768–1435) into per-group renderer
modules so the AUD-H6 memo work holds when registry props are added.

Then registry gains:

```ts
width?: 'full' | 'half'   // default 'full'
```

Panel container becomes `grid grid-cols-1 xl:grid-cols-2 gap-6`; full
panels get `xl:col-span-2`; SectionBox's `mt-6` page-flow margin yields
to the grid gap. Initial half-width set (one-line registry edits to
tune): Risk Calculator + Advanced; Zero Gamma + Dealer Regime.

Half panels pair only when adjacent in the user's resolved order; a lone
half renders half-width. Accepted trade-off.

---

### Phase 5 — DataUnavailable + degraded states (moved up)

**Scope from the full review: 33+ call sites**, not the ~10 originally
assumed. Shared component:

```ts
kind: 'auth' | 'error' | 'window' | 'empty'
```

- `auth` — lock glyph + "Sign in for live data". Muted, not red.
- `error` — amber "Data unavailable — retrying"; optional `detail` line
  (10px muted) for the technical message — never the headline.
- `window` — "Auto-updates 08:25–08:50 CT" standardized copy.
- `empty` — neutral domain copy ("No fires yet today").

Standardize on the in-repo templates: FuturesPanel.tsx:191-228 (state
trio) and DarkPoolLevels (shimmer skeleton :303, designed empty :339 —
promote the skeleton to a shared `SkeletonRows` primitive).

Sweep all sites rendering hook `error` strings or `HTTP <code>` (the full
review lists them: feeds ×5, GEX family ×12, Periscope/Chat ×6,
ChartAnalysis ×3, MLInsights, Tracker, Regime0dte, PinSetupTile,
OpeningFlowSignal, per-chart error strings in the three feed row
expansions). Mapping: 401/403 → `auth`, 5xx/network → `error`.
ErrorBoundary fallbacks become SectionBox-shaped and stop printing raw
`error.message`.

Also in this phase: **sidebar nav grouping** (group headers from the
registry's `group` field — flatten no longer; App.tsx:726-737 currently
discards it) and the **light-mode ink audit** (AA contrast pass on
semantic colors over the cream surfaces; before/after hex table in the
PR).

---

### Phase 6 — Feed recomposition (LotteryFinder / SilentBoom / IntervalBA)

The highest-glance-frequency surfaces, currently the furthest off-system.

**6a. Badge cull** per the tag-value study. Keepers on collapsed rows:
tier/score badge, SPX gamma-sign (GEX/HIGH-Γ), fire-count/×N burst, plus
live actionable state (EXIT, hot, CohortCountdown). Demoted to the
expanded panel or tooltips: tide, flow/Flow Match/Flow Inverted, RELOAD,
cheap-call-PM, TOD, TakeItScore tile, quintile, MEGA-CLUSTER, DUAL FLAG,
OTM-SWEEP and the TickerGroup header equivalents. Ticker/strike return to
line 1 (drop the `basis-full` workaround).

**6b. Shared feed components** to stop LF↔SB copy-paste drift:
`FeedScrubBar`, `TickerGroupHeader`, `RegimeBanner`, and
`ContractDetailPanels` (the expanded twin-chart block currently pasted
three times). The three stacked banners above each feed collapse into one
`RegimeBanner` row (day-level context now lives in the Today band).

**6c. Tokenize the feeds + both canvas charts** (`ContractTapeChart`,
`TickerNetFlowChart` read the Phase 0 chart tokens via a shared
`chartPalette()` helper); off-scale type snaps to the wired scale; filter
toolbars adopt the tokenized FilterChip and `CompactDisclosure` in full
view (not just compact mode).

---

### Phase 7 — Primitive consolidation (rolling, alongside 4–6)

In descending clone-count order:

1. `Stat` (label-over-mono-value; 9+ clones).
2. `Modal` with focus trap + restore (PanelPrefsModal, AccessKeyModal,
   AddContractForm — none traps today).
3. `TintedBanner` (~10 clones) + adopt `StatusBadge` for pills; one
   canonical severity→label/color map (six vocabularies today).
4. `Badge`/pill recipe (the ScrubControlsCompact LIVE pill is the
   reference implementation).
5. Chip + FilterChip merge (one tokenized Chip with variants) + a
   segmented-control primitive (9+ local toggles).
6. Scrubber unification on `ScrubControlsCompact` (retire
   `ScrubControls`, both `MinuteScrubber`s).
7. `Stepper` (4 clones at four heights).
8. SortableHeader: adopt (4 competing th-style sources) or delete.
9. GEX-family shared vocabulary: one dealer-gamma color coding, one ATM
   treatment, one top-5-strikes presentation, legends on all histograms.
10. Overlay layer: one corner-anchored stacking container for
    Toast/BackToTop/IntervalBA/UpdateAvailable/BacktestDiag + the Phase 0
    z-scale (kills the `pushedUp` hack and inline z-9999).
11. `Annotation` (serif italic footnote) — gives the serif voice its
    intended editorial role (~15 hand-rolled italic notes today).
12. AppHeader: admin actions (Migrate DB, Backfill, VIX CSV) move behind
    an overflow menu; freshness pills get visual priority over buttons.

## Out of scope

- The frontend-only `npm run dev` blank-page bug (a `src/` module imports
  `/api/_lib/flow-regime-baseline.json` through the proxy) and the
  `vercel dev` >128-functions boot failure — real bugs, tracked
  separately.
- Options Alerts view recomposition beyond what Phase 6 delivers
  (LF/SB/IntervalBA are its content).
- Mobile-specific layout work beyond the band's `lg` wrap.
- Any change to calculations, hook data flow, polling, or endpoints.

## Data dependencies

None. All Today-band data already lives in App.tsx hook state. No new
tables, env vars, or endpoints.

## Open questions (defaults chosen, flag to change)

1. **Sticky Today band on scroll?** Default **no** for v1.
2. **Today band on the Options Alerts view too?** Default **yes** unless
   it complicates the gated empty state.
3. **Setup strip collapse-to-summary-chip once configured?** Default
   **no**.
4. **Primary-tier set** — default Results, Market Regime, 0DTE Gamma
   Regime.
5. **Phase 0a sweep granularity** — default: `@theme` wiring + ui/ +
   calculator slice in the first commit; remaining folders sweep as
   Phases 6–7 touch them (avoids one 300-file diff).

## Testing

- Unit (vitest, same commit as each phase): SectionBox tier classes;
  registry tier/width fields; `resolvePanelOrder` graceful handling of
  removed ids; TodayBand renders each slot from props and omits
  unavailable slots; DataUnavailable variants; new primitives
  (Stat/Modal/Badge) with a11y assertions (focus trap, aria-pressed).
- E2E (Playwright): section-nav anchors + scroll-spy after the Phase 2 id
  merge; axe a11y pass on the recomposed page; feed rows still expand.
- Visual sanity: screenshot pass in both themes after each phase —
  **light mode is the regression hotspot** (the palette islands are
  invisible there today; Phases 0/6 fix, the screenshots prove it).

## Risks

- **Panel-prefs stored orders** reference merged input ids — covered by
  `resolvePanelOrder` drop-unknown behavior; test it.
- **Memo identity**: AUD-H6 (986f2f61) stabilized hook-return identities
  to hold the `panelMap` memo. Phase 4's split is the structural fix; in
  the interim no new unstable identities through renderer closures.
- **Scroll-spy / e2e selectors** keyed to section ids change in Phase 2.
- **Type-scale sweep** (0a) touches many files mechanically — keep those
  commits pure (no logic changes) so review is diff-shape-only.
- **Feed badge cull** changes information display on live trading
  surfaces — Phase 6 ships behind the existing panel-prefs mechanism
  where feasible, and the demoted badges remain in the expanded panel
  (information is relocated, never deleted).
