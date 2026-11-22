# Screen-reader names on the other panels: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give screen readers the text that 30 role-less elements in 20 panel files currently try to give through a name ARIA prohibits (`aria-label` or `aria-labelledby` on a bare `span`/`div`), and stop the pattern from coming back.

**Why:** ARIA 1.2 prohibits naming a generic element. Screen readers mostly ignore the name, so the text never reaches the user. The Lottery Finder and Silent Boom rows were fixed on 2026-11-20 (6e2fcef2d, 5e60717ce). The owner approved the same fix for every other panel the same day ("yes please").

**Architecture:** Each site gets one of five fixes, chosen in the site table below. The fixes reuse `<SrHint>` (`src/components/ui/SrHint.tsx`) and the test helpers in `src/__tests__/helpers/aria.ts`. A last task adds a source-level guard test that parses every `src/**/*.tsx` file and fails on any new site.

**Tech stack:** React 19, Tailwind 4, Vitest with Testing Library and jest-dom, the `typescript` compiler API (already a dev dependency) for the guard.

**Spec:** This document. The scope was set in conversation: the 2026-11-20 outcome message listed "about 25 other panels have the same screen-reader label problem … Want me to fix those the same way?" and the owner answered "yes please". The full scan found 30 sites.

## Global Constraints

- **No visible change.** Visible text, classes, colors and layout stay as they are. Wrapping a glyph in `<span aria-hidden="true">` is allowed; it changes nothing on screen.
- **Hint text goes through `<SrHint>` only,** as the element's last child. No ad-hoc `sr-only` spans. `SrHint.tsx` itself does not change.
- **Keep every existing `title`.** Add no new `title`.
- **A hint never repeats what the element already shows.** If the old label only repeated the visible text, drop it (fix D).
- **`role="img"` only on glyph-only elements** (arrows, check marks, dashes, an empty placeholder), never on an element whose visible words a screen reader would then lose, except where the site table puts those words into the label.
- **Tests:** every changed site gets an assertion (see "Test pattern"). Tests that queried an old name are updated to the new query in the same commit; never delete an assertion without a replacement. Grep `e2e/` too.
- **Vercel-only.** Everything is under `src/` and `docs/`. No `api/`, Railway or nightly paths.

## The five fixes

| Code | When | Change |
|---|---|---|
| **H** (hint) | The element shows words or numbers, and the label adds meaning | Remove the name attribute. Add `<SrHint>` as the last child with only the part the visible text does not already say. Keep `title`. |
| **I** (img) | The element shows only a glyph or a placeholder | Add `role="img"`. Keep or set `aria-label` as the table says. Keep `title`. |
| **G** (group) | A container of form controls | Add `role="group"`. Keep `aria-labelledby`, remove the redundant `aria-label`. |
| **D** (drop) | The label repeats the visible text, or an enclosing region already carries the name | Remove the attribute. |
| **S** (section) | A panel or block wrapper that needs a region name | Change the `div` to `<section>`, keeping the name attribute. |

## Site table

Line numbers are at c5672aec9.

| # | Site | Now | Fix |
|---|---|---|---|
| 1 | `GexTarget/PriceChart.tsx:459` momentum chip | `aria-label={\`Momentum: ${signalLabel(...)}\`}`, shows the signal label plus `⚡` when the range is expanding | **H**: hint `momentum`, plus `, range expanding` when `momentum.rangeExpanding`. Wrap the `⚡` in `<span aria-hidden="true">`. |
| 2 | `GexTarget/SparklinePanel.tsx:237` row `div` | `aria-label={\`Strike ${s.strike}\`}`, shows the strike number | **D** |
| 3–6 | `GexTarget/StrikeBox/RankArrow.tsx:26,35,44,52` | NEW / ↑n / ↓n / — with labels "New entry", "Rank improved by n", "Rank worsened by n", "Rank unchanged" | **I**, keep each label. All four stay consistent. |
| 7–8 | `GexTarget/StrikeBox/Row.tsx:229,238` ✓ / ✗ | label = title | **I**, keep label and title. |
| 9 | `OpeningFlowSignal/OpeningFlowSignal.tsx:52` wrapper `div` | `aria-labelledby="opening-flow-heading"` | **S**, unless the component renders inside a `SectionBox` (already a named region): then **D**. |
| 10 | `GreekHeatmap/GreekHeatmapTable.tsx:147` ATM badge | `aria-label="At-the-money"`, shows `ATM` | **H**: hint `at the money`. |
| 11 | `GreekHeatmap/MinuteScrubber.tsx:122` Live/Scrubbed chip | label = visible text | **D** |
| 12 | `GreekHeatmap/PriceChip.tsx:17` | `aria-label={\`${ticker} current price ${display}\`}`, shows ticker and price | **H**: hint `current price`. |
| 13 | `GreekHeatmap/RegimeChip.tsx:20` "—" | `aria-label="Regime unavailable"` | **I**, keep label. |
| 14 | `GreekHeatmap/RegimeChip.tsx:34` | `aria-label={\`Dealer regime ${regime}, net GEX ${magnitude}\`}`, shows regime and magnitude | **H**: hint `dealer regime and net GEX`. |
| 15 | `Regime0dte/index.tsx:127` gate chip | `aria-label={meta.ariaLabel}`, shows `meta.label` | **H**: hint = what `meta.ariaLabel` says beyond `meta.label`. If `ariaLabel` then feeds only the hint, rename the field `srText` (the `gexbotBadge` rename precedent), with every reference and test. |
| 16 | `Regime0dte/index.tsx:56` inner `div` | `aria-labelledby={REGIME_0DTE_HEADING_ID}` inside `SectionBox label="0DTE Gamma Regime"` | **D**. Keep the `h3`. |
| 17–18 | `GexLandscape/StrikeTable.tsx:216,225` New / Anchor badges | short label plus a longer `title` | **H**: hint = the `title` text. |
| 19–21 | `GexLandscape/StrikeTable.tsx:328,337,346` ↑↑ / ↓↓ / — | label "Vol reinforcing / opposing / neutral" plus a `title` that starts with the meaning word | **I**: `aria-label` = the `title` text. |
| 22 | `Gexbot/ConvexityMatrix.tsx:220` cell `div` | label = `title` = `cellTitle(cell)` | **H**: hint = the convexity name and reading (`cellHint(cell)`). The ticker, the DTE and the value stay out, because the cell shows all three. `title` stays the whole `cellTitle(cell)`. |
| 23 | `Gexbot/DexoflowVelocityTape.tsx:167` | `aria-label={\`${verdict} ${value}\`}`, shows an `aria-hidden` glyph and the value | **H**: hint = `verdict`. |
| 24 | `GreekFlowPanel/FlowChart.tsx:116` "waiting for ≥2 points" placeholder | `aria-label={ariaLabel}` (the chart's name) | **I**: `aria-label={\`${ariaLabel}, waiting for at least 2 points\`}`. |
| 25 | `VIXTermStructure/RatioCard.tsx:78` | `aria-label={\`15-minute change ${...}\`}`, shows the delta and `/ {spanMin}m` | **H**: hint `` `${trajectory.spanMin}-minute change` ``. The old label said "15-minute" whatever the span. |
| 26 | `DarkPoolLevels/LevelRow.tsx:51` empty bar `div` | `aria-label={\`${premium} premium\`}` | If the row shows the premium as text: **D** plus `aria-hidden="true"` on the bar. Otherwise **I**, keep label. |
| 27 | `DeltaStrikesTable.tsx:40` mobile card wrapper | `aria-label="Delta strikes"`, `md:hidden` | **S**, matching the desktop `<section aria-label="Delta strikes">` at :101. Confirm the two are never both displayed. |
| 28 | `FuturesCalculator/FuturesGrid.tsx:100` | `aria-label={\`${label} ${name}\`}`, shows `label` | **D** (was H: hint = `name`). The card already shows `name` as visible subtext (`<div>{name}</div>` below the changes row), so a hint would be read twice. |
| 29 | `FuturesCalculator/ScenarioInputs.tsx:185` contracts stepper | both `aria-labelledby` and `aria-label="Contracts"` | **G** |
| 30 | `IntervalBAFeed/IntervalBARow.tsx:300` moneyness badge | label = `title` = `moneyness.tooltip` | **H**: hint = the part of `moneyness.tooltip` the pill does not already say (`srText`: the spot / strike relation, and for OTM the distance to ITM). Every tooltip begins by restating the pill's label (and, for ITM and OTM, its percentage), so the verbatim tooltip would be read twice. `title` unchanged, built from `srText`. |

## Test pattern

Use the helpers in `src/__tests__/helpers/aria.ts`.

- **H:** `expect(srHintText(badge)).toBe('<exact hint>')`, and the badge has no `aria-label`.
- **I:** `screen.getByRole('img', { name: '<exact label>' })`.
- **G:** `screen.getByRole('group', { name: '<labelledby text>' })`.
- **S:** `screen.getByRole('region', { name: '<name>' })`.
- **D:** covered by the per-component guard below.
- **Every touched component's test file** adds `expect(genericElementsWithAriaLabel(container)).toEqual([])` for a render that reaches each fixed site. A component with no test file gets one.

## Review Focus

1. **Double reading.** A hint that repeats the visible text makes a screen reader say it twice (sites 11, 12, 14, 22).
2. **Lost text under `role="img"`.** Children of an `img` are hidden from screen readers; the label must carry everything (site 24).
3. **Names inside controls.** If any site renders inside a `<button>` or `<a>`, its hint becomes part of that control's name. Keep such hints short and say so in the report.
4. **Old-name queries.** `getByLabelText('New entry')`, `getByRole(..., { name: 'Momentum: …' })` and the like in `src/__tests__/` and `e2e/` break silently into "not found" or pass on the wrong element.
5. **Conditional branches.** RankArrow and RegimeChip render different spans per state; each state needs its own assertion.

---

### Task 1: GexTarget and OpeningFlowSignal (sites 1–9)

**Files:**
- Modify: `src/components/GexTarget/PriceChart.tsx`, `src/components/GexTarget/SparklinePanel.tsx`, `src/components/GexTarget/StrikeBox/RankArrow.tsx`, `src/components/GexTarget/StrikeBox/Row.tsx`, `src/components/OpeningFlowSignal/OpeningFlowSignal.tsx`
- Test: their existing test files (find them by component name under `src/__tests__/`)

- [ ] Write the failing assertions from "Test pattern" for sites 1–9.
- [ ] Run the touched test files; they fail on the new assertions.
- [ ] Apply the fixes from the site table.
- [ ] Run the touched test files; they pass. Grep `src/__tests__` and `e2e/` for the old names and update any query.
- [ ] `npm run review` green, then commit: `fix(a11y): Name the GexTarget badges and opening-flow panel in ways screen readers read`.

### Task 2: GreekHeatmap and Regime0dte (sites 10–16)

**Files:**
- Modify: `src/components/GreekHeatmap/GreekHeatmapTable.tsx`, `src/components/GreekHeatmap/MinuteScrubber.tsx`, `src/components/GreekHeatmap/PriceChip.tsx`, `src/components/GreekHeatmap/RegimeChip.tsx`, `src/components/Regime0dte/index.tsx` (plus the `meta` source if site 15 renames `ariaLabel`)
- Test: their existing test files, `e2e/regime-0dte.spec.ts` if it queries the chip's name

Same five steps. Commit: `fix(a11y): Name the Greek heatmap and 0DTE regime chips in ways screen readers read`.

### Task 3: GexLandscape, Gexbot, GreekFlow and VIX term structure (sites 17–25)

**Files:**
- Modify: `src/components/GexLandscape/StrikeTable.tsx`, `src/components/Gexbot/ConvexityMatrix.tsx`, `src/components/Gexbot/DexoflowVelocityTape.tsx`, `src/components/GreekFlowPanel/FlowChart.tsx`, `src/components/VIXTermStructure/RatioCard.tsx`
- Test: their existing test files

Same five steps. Commit: `fix(a11y): Name the strike-table, Gexbot, flow-chart and VIX ratio badges in ways screen readers read`.

### Task 4: Dark pool, delta strikes, futures and Interval B/A (sites 26–30)

**Files:**
- Modify: `src/components/DarkPoolLevels/LevelRow.tsx`, `src/components/DeltaStrikesTable.tsx`, `src/components/FuturesCalculator/FuturesGrid.tsx`, `src/components/FuturesCalculator/ScenarioInputs.tsx`, `src/components/IntervalBAFeed/IntervalBARow.tsx`
- Test: their existing test files, plus `e2e/` specs that find the contracts stepper or the delta strikes block

Same five steps. Commit: `fix(a11y): Name the dark-pool, delta-strike, futures and Interval B/A elements in ways screen readers read`.

### Task 5: Source guard

**Files:**
- Create: `src/__tests__/helpers/generic-aria-scan.ts`, `src/__tests__/no-generic-aria-name.test.ts`
- Modify: `src/__tests__/helpers/aria.ts` (export `GENERIC_TAGS`)

**Interfaces:**
- Produces: `findGenericAriaNames(fileName: string, source: string): string[]` in the helper. It returns one `"<line>: <tag> <attr>"` entry per naming attribute, at the attribute's line, so an element with both `aria-label` and `aria-labelledby` yields two.

- [ ] Write the detector's fixture tests first, on inline source strings:
  - flagged: `<span aria-label="x">a</span>`, `<div aria-labelledby="h" />`, `<p aria-label="x">a</p>`
  - not flagged: `<span role="img" aria-label="x">↑</span>`, `<button aria-label="x" />`, `<section aria-label="x" />`, `<fieldset aria-label="x" />`, `<span {...props} aria-label="x" />` (a spread may carry a role), `<Badge aria-label="x" />` (components are out of scope)
- [ ] Implement `findGenericAriaNames` with `ts.createSourceFile(..., ScriptKind.TSX)`. An element is flagged when its tag is intrinsic and in `GENERIC_TAGS`, it has `aria-label` or `aria-labelledby`, and it has no role and no spread attribute. `GENERIC_TAGS` is one list of 17 tags, exported from `src/__tests__/helpers/aria.ts` and shared with the runtime helper `genericElementsWithAriaLabel` (which also checks `aria-labelledby`): `span`, `div`, `p`, `i`, `b`, `em`, `strong`, `small`, `code`, `sub`, `sup`, `del`, `ins`, `s`, `u`, `caption`, `figcaption` (ARIA 1.2's naming-prohibited roles: generic, paragraph, emphasis, strong, code, subscript, superscript, deletion, insertion, caption). The test writes the 17 tags out, so a change to the list is a deliberate test edit.
  - An empty or presentational role counts as no role. An empty or whitespace-only `role` is ignored by browsers, and so are `none` and `presentation` (a string literal, first token, any case) when `aria-label` is present, so the element is still a named generic. One rule, `countsAsNoRole` in `aria.ts`, serves the scan and the runtime helper. Any other role exempts, and so does a non-literal expression (`role={r}`): a documented blind spot.
- [ ] Add the repo scan: every `src/**/*.tsx` outside `__tests__/` folders, skipping colocated `*.test.tsx` and `*.spec.tsx` files, read with `node:fs`, expecting `[]`, with a failure message naming `file:line tag attr` and the fix ("use `<SrHint>` or a role; see `src/components/ui/SrHint.tsx`").
- [ ] Run it; it passes on the branch after Tasks 1–4.
- [ ] `npm run review` green, then commit: `test(a11y): Fail when a bare span or div is given a screen-reader name`.

## Open questions

None. Default calls made while scoping:

- **SVG charts stay as they are.** Four role-less `<svg aria-label>` (CreditTimeChart, RiskWaterfall, StrikeMap, ThetaDecayChart) are not generic elements, so ARIA allows their name. Out of scope.
- **`<td aria-label>` in GreekHeatmapTable stays.** A table cell may be named.
- **Title-only elements in these panels stay out of scope.** The owner approved fixing the `aria-label` sites; elements with only a mouse-hover `title` are a separate, larger question.
