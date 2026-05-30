# Options Alerts View — Design Spec

**Date:** 2026-05-30
**Status:** Approved (design) — pending implementation plan
**Author:** Charles O'Brien (with Claude)

## Goal

Give the Lottery Finder and Silent Boom alert feeds their own dedicated full-screen
view — a vertical split-pane (Lottery on top, Silent Boom on bottom) where both
systems' newest fires stay visible at once — instead of being buried as two stacked
panels in the long calculator scroll.

## Motivation

The two feeds are visually similar but generate very different alerts, and tracking
both is currently impractical:

- Stacked vertically in the main scroll, one feed's long list pushes the other off-screen.
- Each feed is too data-dense to line up side-by-side comfortably.

A dedicated view with two independently-scrolling half-height panes lets the trader
watch both alert streams simultaneously during the session (ideal for a second monitor),
and declutters the main calculator scroll by removing the two heavy panels from it.

## Decisions (locked during brainstorming)

| Decision | Choice |
| --- | --- |
| View model | Full mode-switch — Alerts view shows ONLY the two feeds, full viewport. |
| Feed layout | Vertical split-pane: Lottery top half, Silent Boom bottom half, each with its own independent scroll. |
| Split control | Fixed 50/50 (no draggable divider; can add later if missed). |
| Feed home | Moved entirely into the Alerts view; removed from the main calculator scroll. |
| Pane chrome | Compact + sticky — filter toolbar collapses behind a `filters ⌄` disclosure, banners condense to a single status line, both pinned at the top of the pane. |
| Default view on load | Calculator, with an always-visible **Options Alerts** entry point in the header. |
| Height model | App-shell is a flex column; the alerts view takes `flex-1` remaining space (no `calc(100vh - Npx)` pixel math). |

## Architecture

### Navigation mechanism — hash-based view switch (no router)

The app currently has **no router** by design — it is one `App.tsx` orchestrating a
panel registry (`src/constants/panel-registry.ts`) + a panel-map renderer, with
`SectionNav` driving scroll-based navigation via `IntersectionObserver`. Introducing
`react-router` would require tearing apart that orchestration and the scroll-nav
system for zero functional gain.

Instead, a lightweight hash-based view switch:

- New hook `src/hooks/useViewMode.ts`:
  - Reads `window.location.hash` to derive the current view: `'alerts'` when hash is
    `#alerts`, otherwise `'calculator'` (the default).
  - Exposes `setView(view)` which updates `window.location.hash` (`#alerts` or clears it).
  - Subscribes to the `hashchange` event so browser back/forward and bookmarked
    `#alerts` deep-links work, and cleans up the listener on unmount.
- `App.tsx` reads the mode and renders **either** the existing calculator body
  (SectionNav + PanelRouter) **or** the new `OptionsAlertsView` — never both.

No new dependencies. The PWA/Vite SPA fallback already serves `index.html` for any
path, so hash routing needs no server or service-worker change.

### Entry point — toggle in `AppHeader`

A two-item segmented toggle in the sticky `AppHeader`: **Calculator | Options Alerts**.
Always visible, so the Alerts view is trivially discoverable from the default
calculator view.

- In **alerts** mode: `SectionNav` and the Collapse-All control are hidden (both are
  calculator concepts).
- The global `AlertBanner` / `IntervalBAAlertBanner` remain pinned in **both** modes —
  they are cross-cutting and relevant regardless of view.

### The view — `src/components/OptionsAlerts/index.tsx`

A flex column taking the remaining viewport height, split into two equal panes:

```
OptionsAlertsView            (flex-1 min-h-0, flex-col)
 ├─ Pane  (flex-1 min-h-0 overflow-y-auto) → <LotteryFinderSection compact marketOpen={…} />
 ├─ Divider                  (fixed, visual)
 └─ Pane  (flex-1 min-h-0 overflow-y-auto) → <SilentBoomSection compact marketOpen={…} />
```

**Key layout mechanics:**

- `min-h-0` on each flex child is essential. By default a flex item won't shrink below
  its content's intrinsic height, so without it the panes grow and the *page* scrolls
  instead of each pane scrolling internally. `min-h-0` caps each pane at its 50% share
  and gives it its own overflow context.
- Fixed 50/50 falls out of `flex-1` on both panes — no pixel math, reflows on any
  screen size.
- The app-shell becomes a flex column so `OptionsAlertsView` can claim `flex-1`
  remaining height beneath the sticky header/banners (height model decision).

### Feeds relocate out of the calculator

- Remove the `sec-lottery-finder` and `sec-silent-boom` entries from
  `src/constants/panel-registry.ts` and their renderer closures from the `App.tsx`
  panel-map `useMemo`.
- Relocate their lazy imports into `OptionsAlertsView`.
- Net effect: each feed has exactly one mounted instance, so there is no duplicated
  `usePersistedState` filter state to reconcile, and the calculator scroll shrinks.

### Gating & props

- Both feeds currently require `hasMarketContext` (via `GatedSection`) and take a
  `marketOpen` prop computed in `App.tsx` from `market.data.quotes?.marketOpen ?? false`.
- `OptionsAlertsView` receives `marketOpen` (and any market-context signal it needs)
  from `App.tsx` and passes it through.
- When there is no market context (after-hours / unauthenticated), the view shows a
  single friendly gated/empty state for the whole view rather than two separate gated
  boxes. Existing gating behavior is otherwise preserved.

### Compact + sticky chrome — `compact` prop on each feed

Add `compact?: boolean` to `LotteryFinderSection` and `SilentBoomSection`. When `true`:

- The filter toolbar collapses behind a `filters ⌄` disclosure.
- The day/tier/regime banners condense to a single status line.
- Both the disclosure trigger and the condensed status line are **sticky** at the top
  of the pane, so alert rows fill the half-screen and filters stay one click away while
  scrolling.

This is conditional wrapping of existing toolbar/banner JSX, not logic changes — but
it is the most careful change because each component is ~1,650 LOC.

## Components & Files

**Create:**

- `src/hooks/useViewMode.ts` — view-mode hook (hash read/write + `hashchange` subscription)
- `src/components/OptionsAlerts/index.tsx` — the split-pane alerts view

**Modify:**

- `src/App.tsx` — conditional render (calculator body vs `OptionsAlertsView`); remove
  the two panel-map renderers; app-shell becomes a flex column; pass `marketOpen` through.
- `src/constants/panel-registry.ts` — remove `sec-lottery-finder` and `sec-silent-boom`
  entries (and any group references).
- `src/components/AppHeader.tsx` — add the Calculator | Options Alerts toggle; hide
  SectionNav / Collapse-All in alerts mode.
- `src/components/LotteryFinder/index.tsx` — add `compact` prop (Phase 2).
- `src/components/SilentBoom/index.tsx` — add `compact` prop (Phase 2).

**Tests:**

- `src/__tests__/useViewMode.test.ts` — default mode, hash→mode mapping, `setView`
  updates hash, `hashchange` triggers re-render, listener cleanup.
- `OptionsAlertsView` smoke test — both panes render, `compact` prop forwarded.
- `App.tsx` view-switch test — alerts mode renders `OptionsAlertsView` and NOT the
  calculator panels; calculator is the default.
- Update any existing tests referencing the removed `sec-lottery-finder` /
  `sec-silent-boom` panel-registry entries.

## Data Dependencies

None new. No tables, migrations, env vars, or external APIs. Both feeds keep their
existing endpoints (`/api/lottery-finder`, `/api/lottery-finder-ticker-counts`,
`/api/silent-boom-feed`, `/api/silent-boom-ticker-counts`) and existing hooks.

## Phases (each independently shippable, ≤5 files)

### Phase 1 — Navigation skeleton + relocation

- `useViewMode` hook (+ test).
- `AppHeader` toggle; hide SectionNav / Collapse-All in alerts mode.
- `OptionsAlertsView` rendering the two **existing** feeds (non-compact) in the fixed
  50/50 split panes (+ smoke test).
- App-shell flex-column height model; conditional render in `App.tsx`.
- Remove the two feeds from the calculator panel registry + panel-map; update affected
  tests.

**Delivers the core value on its own:** both feeds visible at once, off the crowded
scroll, with a discoverable entry point.

### Phase 2 — Compact chrome

- Add the `compact` prop to `LotteryFinderSection` and `SilentBoomSection` (sticky
  filter disclosure + condensed banners) and enable it in `OptionsAlertsView` (+ tests).

### Phase 3 — Optional polish

- a11y pass on the toggle + panes (roles, focus, keyboard).
- Playwright e2e spec for the view switch and independent pane scroll.
- New-fire count badges on the inactive view's toggle item (so you notice activity in
  the view you're not currently on).

## Thresholds / Constants

- Split ratio: fixed **50/50** (`flex-1` on both panes).
- Hash sentinel: `#alerts` = alerts view; empty/other = calculator (default).

## Open Questions

All resolved during brainstorming:

- **Default view:** Calculator, with an always-visible header toggle. ✅
- **Height model:** flex `flex-1`, no pixel math. ✅
- **Draggable divider / maximize:** deferred (fixed 50/50); revisit only if missed in
  live use.
- **Tab fire-count badges:** deferred to Phase 3.

## Risks & Notes

- **Compact mode in 1,650-LOC components.** The Phase 2 change touches large files;
  keep it to conditional JSX wrapping, verify both compact and non-compact render paths,
  and follow Step 0 (remove any dead props/imports surfaced) before structural edits.
- **Removed panel IDs.** Grep for `sec-lottery-finder` / `sec-silent-boom` across the
  repo (registry, App, SectionNav grouping, tests, any e2e specs / anchor links) — the
  No-Semantic-Search rule applies; one grep won't catch string literals + test mocks.
- **Persisted filter state.** Both feeds use `usePersistedState`. With a single instance
  per feed there's no collision, but confirm the persistence keys are unchanged so a
  user's existing saved filters carry over.
