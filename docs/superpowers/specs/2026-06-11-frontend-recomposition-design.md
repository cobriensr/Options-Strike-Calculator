# Frontend Recomposition — Design Spec (2026-06-11)

## Goal

Restructure the calculator page's composition so visual hierarchy follows
glance frequency — market state first, results prominent, inputs compact —
while keeping the existing visual identity (Source Serif 4 / DM Mono /
Outfit, color tokens, table patterns) untouched.

This is a **recomposition**, not a reskin. No token values change except a
small light-mode ink audit in Phase 5. No data fetching, hook logic, or
calculation behavior changes anywhere in this spec.

## Background (from the 2026-06-11 design review)

The app's tokens, typography, and data tables are strong. The weaknesses
are compositional:

1. Every section renders as the same full-width card with the same accent
   top-border (`SectionBox` hardcodes `border-t-accent border-t-[3px]`),
   so nothing has hierarchy.
2. Input controls are scaled like consumer forms (56px-tall, full-width
   date field; 730px-wide hour select) and occupy the top of the page,
   while regime/results live thousands of pixels down.
3. Single-column layout at all widths wastes widescreen space.
4. Degraded states leak raw `HTTP 403` strings instead of speaking the
   app's status-pill language.
5. The 13-item sidebar nav is ungrouped; light-mode semantic inks are
   slightly harsh.

## Phases

Each phase is independently shippable and lands with tests in the same
commit. Order is by foundation-first; Phases 3–5 can reorder freely.

---

### Phase 1 — Card tiers (foundation, ~2 files + tests)

`SectionBox` gains a `tier` prop:

```ts
tier?: 'primary' | 'standard' | 'quiet'   // default 'standard'
```

- **primary** — current look: accent top-border 3px. Reserved for the
  panels the user trades off of.
- **standard** — same card, but the top border matches the other edges
  (1.5px `--color-edge`). The default.
- **quiet** — no card chrome: transparent background, no border/shadow;
  header row + hairline rule under it, content below. For low-stakes
  archival panels.

Initial assignment (via a `tier` field on the panel registry entry, so
the renderer closures in App.tsx pass it through):

| Tier     | Panels |
| -------- | ------ |
| primary  | Results, Market Regime, 0DTE Gamma Regime |
| standard | everything else |
| quiet    | Analysis History, Periscope Lesson Library |

Files: `src/components/ui/SectionBox.tsx`,
`src/constants/panel-registry.ts` (add `tier` field), App.tsx renderer
closures pass `tier`.

---

### Phase 2 — Compact setup strip (~5 files + tests)

Merge the three input sections **Date & Time**, **Spot Price**, and
**Implied Volatility** into a single standard-tier card: **Setup**
(`sec-setup`, group `Inputs`).

Layout: one responsive grid of compact fields (control height ~38px,
labels 10px caps above each field, field widths capped to content):

```
┌ SETUP ──────────────────────────────────────────────────────────┐
│ DATE        TIME            SPY    SPX     RATIO   VIX    0DTE  │
│ 06/11/2026  10:00 AM CT     572    5720    10.00   19     1.15  │
│ [date]      [hh][mm][AM|PM][ET|CT] [input][input] (ro)  [input][input] [VIX|Direct IV] │
└──────────────────────────────────────────────────────────────────┘
```

- Existing hooks (`useTimeInputs`, `useSpotInputs`, `useIvInputs`,
  `useAutoFill`) are consumed unchanged — this is presentational only.
- The VIX regime guidance block currently inside the IV section
  (CAUTION REGIME stats) is **not** part of the strip; it moves into the
  Market Regime panel where it belongs semantically.
- Derived-ratio explanation drops to a tooltip; the strip shows the
  resolved value inline.
- Pre-Market Signals, Pre-Market Futures Inputs, Advanced, and Risk
  Calculator remain separate panels (content-heavy), standard tier.

Registry migration: `sec-datetime`, `sec-spot-price`, `sec-iv` are
replaced by `sec-setup`. `resolvePanelOrder` already drops unknown stored
ids and appends new registry ids (verify in tests); stored panel-prefs
orders therefore degrade gracefully — no data migration needed.

Section-nav anchors update via the registry automatically. The e2e specs
that target the old section ids must be updated in the same commit.

---

### Phase 3 — Today command band (~3 files + tests)

A new `TodayBand` component rendered above the `PanelRouter` output on
the Calculator view (not a registry panel: always visible, not
reorderable or hideable — same class of chrome as `AlertBanner`).

One dense horizontal strip (wraps to 2 rows under `lg`), using the
existing big-number stat pattern and `StatusBadge` freshness vocabulary:

| Slot | Content | Source (existing state in App.tsx) |
| ---- | ------- | ----------------------------------- |
| Spot | SPX (large mono) + SPY, freshness pill | `useMarketData` / spot inputs |
| Vol  | VIX value + regime chip (e.g. `19.0 · CAUTION`) | `useVixData` / regime calc |
| Gamma | 0DTE gamma regime chip, or `PRE-OPEN` outside window | same data as the 0DTE Gamma Regime panel |
| Range | Expected median / 90th H-L for current VIX bucket | same data as Market Regime |
| Clock | Market phase + time (`OPEN · 10:00 CT`, `AFTER HOURS`) | `getCTTime` / market-hours utils |

- Read-only; no fetching of its own. Renders whatever subset of data is
  available (signed-out: spot from inputs, VIX regime from static stats,
  gamma slot shows its signed-out state).
- Not sticky in v1 (open question below).
- Each slot deep-links (scrolls) to its full panel.

---

### Phase 4 — Two-column panel grid at `xl` (~3 files + tests)

Registry gains a `width` field:

```ts
width?: 'full' | 'half'   // default 'full'
```

The panel container in App.tsx becomes
`grid grid-cols-1 xl:grid-cols-2 gap-6`; full-width panels get
`xl:col-span-2`. `SectionBox`'s `mt-6` page-flow margin is dropped in
favor of the grid gap (the existing `fill` behavior pattern).

Initial half-width set (conservative; tune later by editing the
registry):

- Risk Calculator + Advanced
- Zero Gamma + Dealer Regime

Half panels pair only when adjacent in the user's resolved order; a lone
half panel renders half-width with empty space beside it. Accepted
trade-off — panel cards are self-contained — and the user can reorder or
we can revert a panel to `full` with a one-line registry edit.

`SectionBox` already supports `h-full`, so paired cards equalize height.

---

### Phase 5 — Degraded states, nav grouping, light-ink audit (~6 files + tests)

**5a. `DataUnavailable` ui component.** Shared empty/error block with the
status-pill visual language instead of raw error text:

```ts
kind: 'auth' | 'error' | 'window' | 'empty'
```

- `auth` — lock glyph + "Sign in for live data". Muted, not red.
- `error` — amber "Data unavailable — retrying" (panels already poll).
  Optional `detail` line for the technical error, rendered 10px muted —
  never as the headline.
- `window` — "Auto-updates 08:25–08:50 CT" style copy (existing pattern,
  standardized).
- `empty` — "No fires yet today" style neutral copy.

Sweep all panels that currently render raw `HTTP <status>` or error
strings (Opening Flow Signal, 0DTE Pin Setup, and any others found by
grepping for direct error-message rendering) and route them through the
component. Mapping: 401/403 → `auth`, 5xx/network → `error`.

**5b. Sidebar nav grouping.** `SectionNav` renders group headers
(10px caps, muted) between panel groups using the registry's existing
`group` field. No behavior change to scroll-spy.

**5c. Light-mode ink audit.** Verify AA contrast for semantic colors on
the cream surfaces and tune only failures/harsh offenders (candidates:
pure-saturated mono figures in tables, chart colors on `#faf9f6`).
Output: a small table of before/after hex values in the PR description.
No dark-mode changes.

---

## Out of scope

- The frontend-only `npm run dev` blank-page bug (a `src/` module imports
  `/api/_lib/flow-regime-baseline.json` through the proxy) and the
  `vercel dev` >128-functions boot failure — real bugs, tracked
  separately from this design work.
- Options Alerts view recomposition (it's a separate surface; the Today
  band ships there in v1 only if it falls out for free — see open
  questions).
- Mobile-specific layout work beyond the band's `lg` wrap.
- Any change to calculations, hooks' data flow, polling, or endpoints.

## Data dependencies

None. All Today-band data already lives in App.tsx hook state. No new
tables, env vars, or endpoints.

## Open questions (defaults chosen, flag to change)

1. **Sticky Today band on scroll?** Default **no** for v1; revisit after
   living with it.
2. **Today band on the Options Alerts view too?** Default **yes** —
   market state is view-independent — unless it complicates the alerts
   view's gated empty state, in which case calculator-only.
3. **Setup strip collapse-to-summary-chip once configured?** Default
   **no** — the compact strip is small enough; collapse logic adds state
   for little gain.
4. **Primary-tier set** — default Results, Market Regime, 0DTE Gamma
   Regime. One-line registry edits to tune.

## Testing

- Unit (vitest, same commit as each phase): SectionBox tier classes;
  registry tier/width fields; `resolvePanelOrder` graceful handling of
  removed ids (Phase 2); TodayBand renders each slot from props and
  omits unavailable slots; DataUnavailable variants.
- E2E (Playwright): section-nav anchors and scroll-spy still work after
  Phase 2's id merge; axe a11y pass on the recomposed page (existing
  a11y spec).
- Visual sanity: screenshot pass in both themes after each phase.

## Risks

- **Panel-prefs stored orders** reference the three merged input ids —
  covered by `resolvePanelOrder` drop-unknown behavior; test it.
- **Memo identity**: AUD-H6 (commit 986f2f61) stabilized hook-return
  identities to hold the `panelMap` memo. New props through the renderer
  closures must not reintroduce unstable identities.
- **Scroll-spy / e2e selectors** keyed to section ids change in Phase 2.
