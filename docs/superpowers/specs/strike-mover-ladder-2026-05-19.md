# StrikeMoverLadder — design spec

**Date:** 2026-05-19
**Author:** Charles + Claude (brainstorming session)
**Status:** Approved, ready for implementation plan
**Supersedes:** the StrikeMoverTicker portion of `gexbot-frontend-2026-05-16.md`

## Goal

Replace the existing `StrikeMoverTicker` (a flex-wrap chip wall of ~30–140
chips, unscannable during a trading session) with `StrikeMoverLadder`: a
spot-anchored, SPX-centered ladder of strike movers that surfaces the
most actionable signal for 0DTE SPX trading — *where the floors and
ceilings are, which are strengthening or breaking, and whether
cross-asset flow confirms.*

## Why the current ticker is unusable

1. **No spatial anchor.** Strikes are scattered by `|Δ|` desc, so a 7400
   SPX floor sits next to a 702 QQQ ceiling. The brain rebuilds the
   price line every glance.
2. **No cross-asset aggregation.** SPX 7400 appears 6+ times (SPX 0DTE,
   SPX 1DTE, SPX all, ES_SPX 0DTE, ES_SPX 1DTE, ES_SPX all). That is
   confirmation — but it renders as clutter.
3. **No Periscope semantics.** Sign of Δ is encoded by chip color, but
   the directional read (*floor strengthening* vs *floor breaking*)
   requires position relative to spot. The ticker lacks that axis.
4. **Symbols the user doesn't trade dominate.** QQQ, NDX, NQ_NDX, IWM
   contribute roughly half the chips and compete for attention with the
   SPX rows the user actually needs.

## What it should do

Answer three questions at a glance, for the SPX 0DTE trader:

- **Where are today's gamma walls relative to spot?** (key levels)
- **Which walls are strengthening vs failing right now?** (sign × position)
- **Is the move confirmed across ES_SPX and SPY?** (cross-asset)

## Phases

### Phase 1 — Ladder MVP

Ship the spot-anchored SPX ladder with category tabs, position-aware
coloring, and cross-asset confirmation badges. No sign-flip detection
yet. Replaces `StrikeMoverTicker` in `GexbotSection`.

Rough estimate: ~300 LOC across 3–5 files, one PR.

### Phase 2 — Sign-flip detection

Add a client-local 10-minute ring buffer keyed by
`(symbol, category, strike)`. Detect sign transitions over a 5-minute
lookback and render a `↻` flip badge on the relevant ladder row with a
"flipped Xm ago" tooltip.

Rough estimate: ~200 LOC, 1–2 files. Ships as a separate PR after
Phase 1 has soaked for 1+ session.

## Files (Phase 1)

### Create

- `src/components/Gexbot/StrikeMoverLadder.tsx` — top-level component.
- `src/components/Gexbot/strike-mover-ladder/aggregation.ts` —
  pure functions: filter winners, bin cross-asset strikes, build rows.
  Extracted so the binning math is unit-testable without React.
- `src/components/Gexbot/strike-mover-ladder/colors.ts` —
  4-quadrant tone classifier (position × sign).
- `src/components/Gexbot/strike-mover-ladder/types.ts` — local types.
- `src/__tests__/StrikeMoverLadder.test.tsx` — component-level tests.
- `src/__tests__/strike-mover-ladder.aggregation.test.ts` — pure-fn
  tests covering binning edge cases.

### Modify

- `src/components/Gexbot/GexbotSection.tsx` — swap
  `<StrikeMoverTicker />` for `<StrikeMoverLadder />`.

### Delete

- `src/components/Gexbot/StrikeMoverTicker.tsx`
- `src/__tests__/StrikeMoverTicker.test.tsx`

## Data dependencies

No new APIs, DB migrations, env vars, or cron changes.

Reuses two existing views from `useGexbotData`:

- `maxchange-winners` — one row per `(ticker, endpoint, category)` with
  windows including `five: [strike, change]`.
- `snapshots-latest` — provides per-ticker `spot` (used for SPX,
  ES_SPX, SPY anchors).

### What the data shape constrains

`maxchange-winners` returns the **winner strike per category**, not
all strikes. So at any moment we have at most:

- `1 × {SPX, ES_SPX, SPY} × {GEX, γ, Δ, V, CH} × {0DTE, 1DTE, all}` rows.

For `[GEX]+[0DTE]` (default), that is `3 tickers × 1 = 3` strikes
worth of data, collapsing typically to 1–2 unique SPX-equivalent rows
after cross-asset binning.

This is *intentional sparseness* — we are surfacing where the biggest
hedging pressure is, not painting every strike. A "show all SPX
strikes' GEX" view would require a new API on top of `gex_strike_expiry`
and is out of scope for this spec.

## Component structure (Phase 1)

```text
┌─ GEXBOT DEALER STATE ──────────────────────────────────────────────┐
│  STRIKE MOVERS — SPX  ·  0DTE  ·  spot 6750  ·  12:08 CT          │
│  [GEX ✓] [γ] [Δ] [V] [CH]    [0DTE ✓] [+1DTE] [all]               │
│                                                                    │
│  ▲ CEILINGS (dealer short γ — sells rips)                          │
│  ─────────────────────────────────────────────────                 │
│   7469  ▪ES ▪SPX             +164   ━━              (weakening)   │
│   7419  ▪ES ▪SPX             −3.0K  ━━━━━━          (forming)     │
│  ═════════════ SPX spot 6750 ═════════════════════                 │
│   7400  ▪ES ▪SPX ▪SPY  3✓    +3.7K  ━━━━━━━ ⚡     (strengthening)│
│   7385  ▪ES ▪SPX ▪SPY  3✓    +1.6K  ━━━━            (building)    │
│   7375  ▪ES ▪SPX             −199   ▽               (weakening)   │
│  ─────────────────────────────────────────────────                 │
│  ▼ FLOORS (dealer long γ — fades dips)                             │
│                                                                    │
│  empty-state: "No SPX winners in last 5 min for GEX-0DTE"          │
└────────────────────────────────────────────────────────────────────┘
```

### Subcomponents

1. **Header row** — title, current SPX spot (with ES_SPX and SPY
   secondary spots in a tooltip), and last-update timestamp.
2. **Category tabs** — `[GEX] [γ] [Δ] [V] [CH]`. Mutually exclusive.
   Default: `GEX`.
3. **DTE switch** — `[0DTE] [+1DTE] [all]`. Mutually exclusive.
   Default: `0DTE`.
4. **Ladder body** — list of rows in descending strike order. Spot
   line is rendered between the last ceiling and first floor row.
5. **Empty state** — when no SPX winner matches the current filter,
   show a short explainer (data writes every 1 min; 5-min freshness
   window).

### Per-row anatomy

```text
strike  symbol-dots  confirm-badge  Δ-value  magnitude-bar  status-icon
```

| Element | Meaning |
| --- | --- |
| Strike | SPX-equivalent strike, rounded to nearest 5. |
| Symbol dots | One filled dot per symbol that has a winner within tolerance: `▪ES` `▪SPX` `▪SPY`. |
| Confirm badge | `3✓` when all three symbols agree on direction; `2✓` when two; otherwise omitted. |
| Δ-value | Signed change for the SPX row (the spine), formatted via existing `formatChange()`. |
| Magnitude bar | Horizontal bar, width relative to the largest `\|Δ\|` in the visible ladder. Min 4% so non-zero is visible. |
| Status icon | `⚡` = largest mover in current view. `▽` = sign opposes expected direction for this side (e.g., floor with `−Δ`). |

## Trading-aware color logic

This is the central insight. *Position relative to spot × sign of Δ*
determines the read:

| Position | 5-min Δ sign | Reads as | Row tone |
| --- | --- | --- | --- |
| Below spot | + | Floor strengthening | `text-emerald-300` |
| Below spot | − | Floor weakening / failing | `text-amber-300` |
| Above spot | − | Ceiling strengthening | `text-rose-300` |
| Above spot | + | Ceiling weakening | `text-yellow-300` |
| Equal to spot (±0.25%) | ± | At-the-money | `text-secondary` |

Implemented in `strike-mover-ladder/colors.ts` as a single pure function:

```ts
type Side = 'above' | 'below' | 'atm';
type Tone = 'strengthening' | 'weakening' | 'neutral';
function classifyRow(strike: number, spot: number, deltaSign: 1 | -1 | 0): {
  side: Side;
  tone: Tone;
  toneClass: string;
};
```

## Cross-asset aggregation

Per fetch, we have at most one winner strike per `(ticker, category)`.
Build SPX-anchored rows by:

1. Take all SPX `maxchange-winners` rows in the active category.
2. For each SPX winner at strike `S`:
   - Check ES_SPX winners in same category: match if `|strike − S| ≤ 5`.
   - Check SPY winners: convert `strike × 10` (SPY-to-SPX), match if
     `|strike × 10 − S| ≤ 5`.
3. Collapse duplicates (same `S` ± tolerance) into one row.
4. Compute confirmation badge:
   - All three symbols present AND all changes same sign → `3✓`.
   - Two of three present, same sign → `2✓`.
   - Otherwise no badge.

Symbols outside the spine (QQQ, NQ_NDX, NDX, IWM) are hidden in
Phase 1. They may get their own future tile; not this one.

## Sort and cap

- Rows sorted by **strike descending** within the rendered ladder
  (highest strike at top, lowest at bottom). The spot divider is
  inserted between the lowest ceiling and the highest floor. This
  preserves the price-axis intuition — reading top-to-bottom = moving
  down through prices.
- Cap each side independently: at most **5 ceilings** above spot and
  **5 floors** below spot. Selection within each side is by
  proximity to spot ascending — closest-to-spot levels are most
  actionable in 0DTE. If a side has fewer than 5, render fewer; do not
  borrow rows from the other side.
- A "more" affordance is deferred unless the 5+5 budget proves too
  tight in live use.

## Constants (Phase 1)

```ts
const CROSS_ASSET_TOLERANCE_PTS = 5;   // SPX±5pt match window
const SPY_TO_SPX_RATIO = 10;           // SPY × 10 ≈ SPX
const ATM_BAND_BPS = 25;               // ±0.25% of spot = ATM tone
const MAX_LADDER_ROWS = 10;
const MIN_BAR_PCT = 4;                 // mirror CharmClock convention
```

## Sign-flip detection (Phase 2, design preview)

Local ring buffer in a `useRef`:

```ts
type FlipBufferKey = `${symbol}:${category}:${strike}`;
type FlipBuffer = Map<FlipBufferKey, Array<{ ts: number; change: number }>>;
```

- On every poll tick, append the current `(strike, change)` for every
  visible winner row.
- Drop entries older than `FLIP_HISTORY_WINDOW_MIN = 10` minutes.
- At render, for each row, look at the buffer entry `FLIP_LOOKBACK_MIN
  = 5` minutes ago: if `sign(then) !== sign(now)` and both non-zero,
  mark as flipped.
- Display: `↻` badge with `flipped 3m ago` tooltip.

Edge: the buffer is purely client-side and lost on reload. That is
acceptable; the trader sees a fresh state on session start, and flips
that matter will reappear within the next 5 minutes anyway.

## Empty states

- **No SPX winners in current filter** — friendly explainer card.
- **No data at all** (hook returns `[]`, no error) — "Awaiting first
  GEXBot tick" (matches existing `StrikeMoverTicker` convention).
- **Loading** — skeleton matching the ladder dimensions so layout
  doesn't shift.
- **Error** — amber error card with the hook error text (matches
  existing components).

## Acceptance criteria (Phase 1)

- [ ] SPX spot rendered in header from `snapshots-latest`.
- [ ] Ceilings (strikes > spot) listed above the spot divider in
      descending strike order; floors below in descending strike order.
- [ ] Spot divider visually distinct (double line, label).
- [ ] Position-aware color logic implemented exactly per the table
      above and unit-tested for all four quadrants plus ATM.
- [ ] Cross-asset binning produces `3✓` when SPX + ES_SPX + SPY winners
      agree, `2✓` when two of three agree, no badge otherwise.
- [ ] Magnitude bar present per row, min 4% width when value is
      non-zero, scaled to max `|Δ|` in the visible ladder.
- [ ] `[GEX] [γ] [Δ] [V] [CH]` tabs switch the active category.
- [ ] `[0DTE] [+1DTE] [all]` switches the DTE filter.
- [ ] Empty state when no SPX winners match the current filter.
- [ ] `npm run review` passes (tsc + eslint + prettier + vitest).
- [ ] `GexbotSection` no longer imports `StrikeMoverTicker`; the old
      component and its test file are deleted.

## Open questions

- **SPX/SPY ratio drift.** We assume `SPX ≈ SPY × 10`. The actual ratio
  drifts slowly. With a ±5pt tolerance, a ratio error of even 0.5 (i.e.
  SPY × 9.95) only matters at strike distances near 1000pt from spot,
  which is well outside any 0DTE winner range. Acceptable for v1; can
  switch to a dynamic ratio (computed from spot pairs) if needed.
- **0DTE-only on Fridays (weekly expirations).** GEXBot's `gex_zero`
  always means "minimum-DTE expiration," which on Fridays could mean
  weekly SPX (Mon/Wed/Fri) vs monthly. We trust GEXBot's definition;
  no special-case logic.
- **Strikes rounded to nearest 5.** SPX strikes are 5-pt. ES_SPX strikes
  are 5-pt. SPY strikes are 1-pt. We round SPY × 10 to nearest 5
  for binning. This loses fine-grained SPY confirmation but the
  resulting strike-rounding band (±2.5pt) is well within
  the 5-pt tolerance and keeps rows clean.

## Non-goals (explicit)

- Showing per-strike absolute GEX values. The data view doesn't have
  it; would require a new endpoint over `gex_strike_expiry`.
- Showing QQQ / NDX / NQ_NDX / IWM strike movers. Out of scope for
  the SPX-spine tile.
- Click-to-deep-dive on a strike row. Deferred until a deep-dive
  surface exists (originally deferred in `gexbot-frontend-2026-05-16.md`).
- Persistent (cross-reload) flip-detection history. Client-local ring
  buffer is fine; reloads are rare.
- Marquee / scrolling animation. Was deferred in the original spec for
  accessibility reasons; we stay deferred.

## References

- Original GEXBot frontend spec:
  `docs/superpowers/specs/gexbot-frontend-2026-05-16.md`
- Periscope skill (4-quadrant color logic origin):
  `.claude/skills/periscope/SKILL.md`
- Memory: `project_periscope_naive_vs_mm_gex.md` —
  `ws_gex_strike_expiry` is naive; GEXBot's MM-attributed view is
  what this ladder is actually rendering.
