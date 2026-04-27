# Frontend Coherence Pass — 2026-04-27

## Goal

Eliminate the user-visible drift the frontend has accumulated across recent
component pushes: inconsistent time pickers, mixed default-collapse states,
a header that doesn't scale to the section count, and duplicated formatters.
Outcome: one canonical primitive per UX dimension, one shared formatter
layer, one navigation pattern.

## Background

Audit on 2026-04-27 found four independent dimensions of drift:

1. **Time pickers** — 8 instances, 4 paradigms, one real correctness bug
   (`FuturesPanel` treats `datetime-local` as browser-local rather than CT).
2. **Collapsible sections** — 13 instances, 3 implementation patterns,
   7 expanded vs 6 collapsed by default with no documented rule.
3. **Header / navigation** — header surfaces 0 of the 8–19 content sections;
   `SectionNav` `overflow-x-auto` hides ~80% of chips at mobile widths.
4. **Code-quality drift** — `formatTime()` and friends duplicated 2–3×,
   396 inline `.toFixed()` calls, AudioContext type-cast duplicated 3×,
   two polling hooks miss strict `marketOpen` early-returns.

Detailed audit findings are in the conversation transcript.

## Phases

Each phase is independently shippable, ≤5 files, with explicit verification.
Phases are ordered by **risk × user-impact / cost**: real bugs first,
high-leverage primitives next, layout last.

### Phase 1 — Fix FuturesPanel timezone bug (1 file + test)

Replace `localInputToIso()` so that the `datetime-local` value is interpreted
as **Central Time** (matching the rest of the app), not browser-local.
Same-direction fix for `isoToLocalInputValue()` so the `min`/`max`/round-trip
display also use CT.

- `src/components/FuturesCalculator/FuturesPanel.tsx` — replace local-tz
  parsing with explicit CT wall-clock conversion.
- `src/utils/timezone.ts` — add `ctWallClockToUtcIso(dateStr, ctMinutesPastMidnight)`
  helper (mirrors existing `etWallClockToUtcIso`).
- `src/__tests__/components/FuturesPanel.historical.test.tsx` — update the
  `expect(latestAt).toBe(new Date(...).toISOString())` assertion (which
  embodies the bug) to assert CT-anchored UTC ISO.
- `src/__tests__/utils/timezone.test.ts` — add tests for the new helper.

**Verify:** `npm run review` green; new test asserts that picker value
`2026-04-17T09:30` (CT) maps to `2026-04-17T14:30:00.000Z` (EDT) regardless
of host TZ.

### Phase 2 — Shared formatter utilities (≤5 files)

Create a single source of truth for the duplicated formatters.

- `src/utils/component-formatters.ts` — new file. Exports:
  - `formatTimeCT(iso, { showSeconds?, fallback? })` — replaces 3 copies
    in `AlertBanner.tsx:54`, `DarkPoolLevels.tsx:58`, `GexTarget/index.tsx:57`.
  - `formatPremium(n)` — K/M/B abbreviation; replaces copies in
    `DarkPoolLevels.tsx:50` and `OptionsFlow/FlowConfluencePanel.tsx:45`.
  - `formatDeltaPct(v, digits?)` — replaces 3 copies in
    `GexTarget/TargetTile.tsx:10`, `GexTarget/UrgencyPanel.tsx:10`,
    `GexTarget/StrikeBox/formatters.tsx:19`.
- `src/__tests__/utils/component-formatters.test.ts` — covers null/NaN,
  rounding boundaries, 0/negative inputs.
- Update 3 callers (`AlertBanner.tsx`, `DarkPoolLevels.tsx`,
  `GexTarget/index.tsx`) to import the new helpers and delete locals.

**Verify:** `npm run review` green; visual diff on the affected sections
unchanged (timestamps render identically).

### Phase 3 — getAudioContext utility (4 files)

Extract the unsafe `(globalThis as unknown as { AudioContext?: ... })` cast
duplicated in three places.

- `src/utils/audio-utils.ts` — new file. `getAudioContext(): AudioContext | undefined`.
- `src/__tests__/utils/audio-utils.test.ts` — covers fallback to
  `webkitAudioContext`, returns undefined when neither exists.
- `src/components/OtmFlowAlerts/OtmFlowAlerts.tsx` — replace inline cast.
- `src/components/TRACELive/hooks/chime-audio.ts` — replace inline cast.
- `src/components/FuturesGammaPlaybook/useAlertDispatcher.ts` — replace
  inline cast.

**Verify:** `npm run review` green; existing alert/chime tests still pass.

### Phase 4 — Polling-gate fixes (2 files + tests)

Tighten the `marketOpen` gate so the interval is never created when the
gate is closed.

- `src/hooks/useAnomalyCrossAsset.ts:158` — move `if (!marketOpen) return`
  to the top of the polling effect, before any `setInterval`/`fetch`.
- `src/hooks/useDarkPoolLevels.ts:199` — same pattern; gate on
  `(isOwner && marketOpen)` before any side effect.

**Verify:** `npm run review` green; add unit tests asserting that with
`marketOpen=false` no fetch is issued (use `vi.useFakeTimers` + advance).

### Phase 5 — TimeInputCT primitive + native-picker migration (4 files)

Build the canonical CT-anchored time picker. Migrate the simplest 2 callers;
leave `DateTimeSection` (which has 12h+AM/PM+TZ-toggle UX) and the already-
fixed `FuturesPanel` for a follow-up.

- `src/components/ui/TimeInputCT.tsx` — wraps native `<input type="time">`,
  documents "value is HH:MM in Central Time", 1-minute granularity, accepts
  optional `min`/`max` market-hours bounds.
- `src/__tests__/components/ui/TimeInputCT.test.tsx` — covers controlled
  state, min/max enforcement, keyboard support.
- `src/components/OtmFlowControls.tsx:158` — migrate.
- `src/components/InstitutionalProgramSection.tsx:86,95` — migrate both.

**Verify:** `npm run review` green; manual smoke that the affected pickers
keep behaving identically (24h CT-naive → 24h CT-explicit, no UX change).

### Phase 6 — Migrate manual collapsibles to SectionBox (≤5 files)

The codebase already has the right primitive (`SectionBox` in `ui.tsx`)
with `CollapseAllContext` integration and full a11y. Migrate the 5 manual
implementations that re-roll the pattern.

Document the rule explicitly in `SectionBox`'s TSDoc:
**"Core panels start expanded, drill-downs/optional inputs start collapsed."**

- `src/components/ResultsSection.tsx` — replace local toggle with `SectionBox`.
- `src/components/BacktestDiag.tsx` — same.
- `src/components/IronCondorSection/index.tsx` — same.
- `src/components/BWBSection/index.tsx` — same.
- `src/components/FuturesCalculator/index.tsx` — same.

(`PositionMonitor`, `MarketFlow.SubSection`, `IVAnomalies.AnomalyRow`,
`ChartAnalysis.Collapsible`, `TradeLog`, `PositionVisuals`, `PositionRow`
deferred — they have row-level multi-expand semantics that don't fit
`SectionBox` cleanly. Track in follow-up issue.)

**Verify:** `npm run review` green; "Collapse All" / "Expand All" buttons
in header now affect the migrated sections (they didn't before).

### Phase 7 — Sidebar navigation (3 files)

Convert the horizontal `SectionNav` chip bar into a sticky left sidebar
on `lg+` breakpoints; preserve horizontal-scroll behavior on mobile.

- `src/App.tsx` — change `#app-shell` from block flow to
  `lg:grid lg:grid-cols-[16rem_1fr]`; move `SectionNav` into the left
  column. Add `sec-futures-gamma-playbook` to the `navSections` array
  (currently orphaned).
- `src/components/SectionNav.tsx` — accept `orientation: 'horizontal' | 'vertical'`
  prop, render `flex-col` + sticky for vertical. Keep IntersectionObserver
  spy logic unchanged.
- `src/__tests__/components/SectionNav.test.tsx` — extend to cover both
  orientations.

**Verify:** `npm run review` green; manual smoke at 375px (mobile keeps
horizontal scroll), 1024px (sidebar appears), 1440px (sidebar fixed).
No section anchors broken.

### Phase 8 — Aria-label sweep for icon-only buttons (≤5 files)

Add missing labels on icon-only controls flagged in the audit.

- `src/components/ScrubControls.tsx` — prev/next chevron buttons.
- `src/components/BackToTop.tsx` — scroll-to-top button.
- `src/components/AdvancedSection.tsx` — collapse toggle (if migrated to
  SectionBox in Phase 6, this may be auto-fixed; verify).
- Spot-check any other icon-only buttons surfaced by `grep`.

**Verify:** `npm run review` green; `npx playwright test e2e/a11y.spec.ts`
green if axe rules cover button-name.

## Out of Scope (Track Separately)

- App.tsx state lift into focused hooks (7 useStates → 4 hooks). High
  effort, modest payoff. Track as a separate spec.
- React 19 `useTransition` adoption for GexTarget / FuturesGammaPlaybook
  heavy-calc panels. Performance optimization, not coherence.
- Replacing 396 inline `.toFixed()` with `roundN()` utilities. Large
  codemod, low per-call risk; defer to a dedicated kaizen pass.
- DarkPoolLevels prop-drilling refactor (13 scrubber props →
  `useTimeGridScrubber` hook). Deferred until Phase 5/6 land — the
  sidebar refactor may simplify the call site enough to make this
  smaller.

## Open Questions

- **Phase 5 scope of TimeInputCT** — should it support an optional
  12h-display mode for `DateTimeSection`'s UX, or do we standardize on
  24h everywhere? **Default:** 24h only; if `DateTimeSection` needs
  12h-display, that's a follow-up wrapping `TimeInputCT`.
- **Phase 7 sidebar width** — `16rem` (256px) is the proposal. **Default:**
  ship at 16rem; tune if it crowds the calc panels at 1024px.
- **Phase 6 `PositionMonitor` migration** — the parent panel could move
  to `SectionBox`, but its row-level multi-expand is custom. **Default:**
  skip in this pass; PositionMonitor's "starts collapsed" outlier remains.

## Thresholds / Constants

- Sidebar breakpoint: `lg:` (1024px) — matches existing `lg:max-w-6xl` in
  the content container.
- Sidebar width: `16rem` (256px).
- TimeInputCT minute granularity: 1 minute (no rounding).

## Verification Cadence

After each phase: run `npm run review` (tsc + eslint + prettier + vitest +
coverage), then dispatch the code-reviewer subagent per the project's Get
It Right loop, then commit on green review. Direct-to-main per project
convention.
