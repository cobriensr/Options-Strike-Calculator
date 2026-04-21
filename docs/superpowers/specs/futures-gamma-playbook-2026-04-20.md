# Futures Gamma Playbook Component — Phase 1

**Date:** 2026-04-20
**Status:** Scoped, ready to build
**Scope:** Phase 1 only (SPX-derived; ES-native gamma deferred)

## Goal

Give the trader a futures-focused UI panel that translates existing SPX GEX
signals into a concrete "how to trade ES right now" playbook — regime
verdict, ES-equivalent key levels, time-of-day phase, trigger checklist, and
edge-triggered alerts — so GEX analysis extends beyond spread selection into
futures execution without new data pipelines. The component must also
support **backtest scrubbing** so the trader can replay prior sessions,
watch the playbook evolve minute-by-minute against the actual ES chart, and
evaluate whether the rules would have generated profitable setups.

## Why SPX-derived, not ES-native

ES moves because dealers hedge SPX options. SPX GEX is the same signal as
ES-native gamma, just observed from the option side — with cleaner data
(tighter SPX spreads vs. thinner ES option strikes). The NQ OFI study
already showed ES microstructure has no edge independent of index flow, so
paying for ES option intraday gamma is speculative. Phase 1 ships from
existing SPX GEX + basis translation; if a specific trade shows SPX-derived
is misleading us on ES, Phase 2 (ES-native gamma via Databento + Black-76)
gets justified by real evidence rather than pre-built.

## Phases

### Phase 1A — Logic modules and aggregator hook (~2 hrs, 4 files)

Pure-function layer, fully unit-testable before any UI lands.

**Create:**

- `src/components/FuturesGammaPlaybook/types.ts` — shared types
  (`RegimeVerdict`, `SessionPhase`, `PlaybookRule`, `EsLevel`,
  `PlaybookBias`).
- `src/components/FuturesGammaPlaybook/playbook.ts` — regime → rule
  translation. Pure functions: `classifyRegime(netGex, zeroGamma, spot)`,
  `rulesForRegime(verdict, phase)`, `sizingGuidance(spreadDelta)`.
- `src/components/FuturesGammaPlaybook/basis.ts` — SPX → ES level
  translation. Pure function: `translateSpxToEs(spxLevel, basis)`,
  `esTickRound(price)` (ES trades in 0.25 ticks).
- `src/hooks/useFuturesGammaPlaybook.ts` — aggregator hook. Composes
  `useGexPerStrike()` + `useFuturesData()` + derives regime/verdict/levels
  via the pure modules. Emits a `PlaybookBias` suitable for
  `onBiasChange` → analyze context.

**Verify:** `npm run test:run src/components/FuturesGammaPlaybook` —
regime classification, basis translation, session phase boundaries all
tested.

## Backtest requirements (cross-cutting across Phases 1B–1E)

The component is not "live only" — it is explicitly designed to be
scrubbed across historical sessions so the trader can rewind and watch
setups play out against the ES chart.

**Data plumbing (already in place from Phase 1A):**

- `useFuturesGammaPlaybook(marketOpen, futuresAt?)` accepts an optional
  ISO timestamp that time-aligns ES data to the scrubbed GEX snapshot.
- The inner `useGexPerStrike()` already exposes scrub state
  (`selectedDate`, `timestamps`, `scrubPrev/Next/To/Live`,
  `availableDates`) — mirrors how `GexLandscape` works today.

**Phase 1B must:** pass the full `ScrubControls` header through to
`SectionBox`, same wire-up as `GexLandscape` (date picker, prev/next,
LIVE, refresh).

**Phase 1C must:** the `RegimeTimeline` panel plots the scrubbed day
(not live), and the `EsLevelsPanel` reads `futuresAt`-aligned ES price
so level distances are historically accurate.

**Phase 1D must:** `TriggersPanel` reads the scrubbed state and lights
up triggers as they _would have_ fired at the scrubbed timestamp — not
only live triggers.

**Phase 1E must:** the alerts engine is **suppressed during
backtest** — `isLive === false` disables toast/Notification/audio
delivery but still records "would-have-fired" events into an
in-session `backtestAlerts[]` array that the UI can display as a
timeline/list so the trader can see when alerts would have gone off
without them actually interrupting their work.

**Open question (default pick):** overlay the raw 1m ES candles
(via `futures_bars`) onto `RegimeTimeline` so the correlation between
regime flips and price action is visible without switching tabs.
Default: yes, reuse the existing `useFuturesData` pattern for
historical bars. Decide during Phase 1C based on performance.

### Phase 1B — Regime Header + Playbook Panel (~2 hrs, 3 files)

Core decision panels — what regime and what to do.

**Create:**

- `src/components/FuturesGammaPlaybook/RegimeHeader.tsx` — big-verdict tile
  (MEAN-REVERT / TREND-FOLLOW / STAND ASIDE), current GEX regime badge,
  zero-gamma distance in ES points, current ES price plus basis, session
  phase badge.
- `src/components/FuturesGammaPlaybook/PlaybookPanel.tsx` — regime-reactive
  rules cheat sheet. Shows: entry condition, direction, ES target,
  ES stop, sizing note. Rules come from `playbook.ts::rulesForRegime`.
- `src/components/FuturesGammaPlaybook/index.tsx` — container shell
  (SectionBox + ScrubControls), composes all panels in a 5-panel grid
  matching `GexTarget/index.tsx` layout conventions.

**Verify:** Component renders against mocked hook data; regime badges
color-code correctly (sky for +GEX, amber for −GEX, red for transitioning).

### Phase 1C — ES Levels Panel + Regime Timeline (~2 hrs, 2 files)

Level mapping + intraday regime evolution.

**Create:**

- `src/components/FuturesGammaPlaybook/EsLevelsPanel.tsx` — call wall,
  put wall, zero-gamma, and max-pain from `gex_strike_0dte`, translated
  to ES prices via live basis. Shows distance-to-level in ES points and
  ticks, status badge (approaching / rejected / broken). Reuses
  `GexLandscape`'s left-border color pattern for direction weight.
- `src/components/FuturesGammaPlaybook/RegimeTimeline.tsx` — intraday GEX
  regime strip chart from `spot_exposures` series, zero-gamma crossings
  marked, ES price overlay. SVG polyline plus shaded regime bands.

**Verify:** Level translation uses live basis (not stale), timeline
correctly marks zero-gamma crossings, regime bands align with cron
refresh cadence.

### Phase 1D — Triggers Panel + App wire-up (~1.5 hrs, 2 files)

Actionable checklist + App integration.

**Create:**

- `src/components/FuturesGammaPlaybook/TriggersPanel.tsx` — checklist of
  named setups. Example triggers: "ES within 5pts of call wall with
  positive GEX — fade active"; "ES below zero-gamma with negative GEX —
  short trend active"; "After 1:30 CT with positive GEX — charm drift to
  pin active". Each trigger lights up when conditions fire.

**Modify:**

- `src/App.tsx` — lazy-import and mount `FuturesGammaPlaybook` below
  `GexLandscape` in the owner-gated section. Pass `onBiasChange` to the
  existing analyze context setter (`setGexBiasContext`) or a new
  `setPlaybookBiasContext`.

**Verify:** `npm run dev`, confirm panel renders, scrubber works, trigger
checklist reacts to scrub. Verify analyze endpoint picks up the new
bias block (or leaves it out cleanly).

### Phase 1E — Alerts system (~2 hrs, 3 files)

Edge-triggered browser alerts for fast-moving futures. In-component, no
new backend. Without this, the component is only useful when actively
watched — futures move too fast for passive display.

**Alert types (each individually toggleable):**

1. **Regime flip** — spot crosses zero-gamma (+GEX → −GEX or vice versa).
2. **Level approach** — ES within `LEVEL_PROXIMITY_ES_POINTS` of call
   wall, put wall, zero-gamma, or max-pain.
3. **Level breach** — ES price just broke through a key level (sustained
   ≥1 minute to avoid wick false positives).
4. **Trigger fire** — one of the named setups in `TriggersPanel` just
   activated (e.g. "fade the wall" condition became true).
5. **Session phase transition** — entering charm drift window (13:30 CT)
   or power hour (14:30 CT).

**Design:**

- **Edge-triggered**: fire on state _change_, not persistence. Store
  last-known state per alert type in a ref; compare on each data update.
- **Dedup cooldown**: 90-second minimum between same-type fires (tunable
  per alert).
- **Delivery channels** (all user-toggleable): in-app toast via existing
  `useToast`; browser `Notification` API (for when app is in another
  tab), requesting permission on first enable; optional audio cue
  (simple beep; hosted asset, no new dep).
- **Config persistence**: `localStorage` key
  `futures-playbook-alerts-v1` holds per-alert-type enable flags and
  cooldown overrides.

**Create:**

- `src/components/FuturesGammaPlaybook/alerts.ts` — pure alert engine:
  `detectAlertEdges(prev, next): Alert[]`, alert types, cooldown logic.
- `src/components/FuturesGammaPlaybook/AlertConfig.tsx` — small config
  drawer or popover with per-type toggles, cooldown sliders, and the
  Notification API permission prompt.
- `src/components/FuturesGammaPlaybook/useAlertDispatcher.ts` — hook
  that wires the engine to the three delivery channels (toast,
  Notification, audio) and manages cooldown state refs.

**Tests:**

- `src/components/FuturesGammaPlaybook/__tests__/alerts.test.ts` — edge
  detection, cooldown enforcement, each alert type firing under its
  correct condition.

**Verify:** Force a regime-flip scenario in dev (scrub to a known
crossing), confirm exactly one alert fires (not spam), confirm toast and
browser notification both appear when tab is hidden, confirm dedup
suppresses rapid-fire crossings.

### Phase 1F — Tests + Claude analyze context + final verification (~1.5 hrs)

**Create:**

- `src/components/FuturesGammaPlaybook/__tests__/playbook.test.ts` —
  regime classification edge cases, session phase boundaries.
- `src/components/FuturesGammaPlaybook/__tests__/basis.test.ts` — SPX→ES
  math, tick rounding.
- `src/components/FuturesGammaPlaybook/__tests__/FuturesGammaPlaybook.test.tsx`
  — RTL render + trigger firing.
- `src/hooks/__tests__/useFuturesGammaPlaybook.test.ts` — hook composition.

**Modify (optional):**

- `api/_lib/analyze-context.ts` — add `formatPlaybookBiasForClaude()` if
  the new `PlaybookBias` shape isn't trivially reusable from the existing
  `GexLandscape` bias formatter.

**Verify:** `npm run review` passes (tsc + eslint + prettier + vitest
--coverage). New tests exist and pass. No new TypeScript errors.

## Files to create/modify (all phases)

**Created:**

- `src/components/FuturesGammaPlaybook/types.ts`
- `src/components/FuturesGammaPlaybook/playbook.ts`
- `src/components/FuturesGammaPlaybook/basis.ts`
- `src/components/FuturesGammaPlaybook/alerts.ts`
- `src/components/FuturesGammaPlaybook/RegimeHeader.tsx`
- `src/components/FuturesGammaPlaybook/PlaybookPanel.tsx`
- `src/components/FuturesGammaPlaybook/EsLevelsPanel.tsx`
- `src/components/FuturesGammaPlaybook/RegimeTimeline.tsx`
- `src/components/FuturesGammaPlaybook/TriggersPanel.tsx`
- `src/components/FuturesGammaPlaybook/AlertConfig.tsx`
- `src/components/FuturesGammaPlaybook/index.tsx`
- `src/components/FuturesGammaPlaybook/useAlertDispatcher.ts`
- `src/components/FuturesGammaPlaybook/__tests__/playbook.test.ts`
- `src/components/FuturesGammaPlaybook/__tests__/basis.test.ts`
- `src/components/FuturesGammaPlaybook/__tests__/alerts.test.ts`
- `src/components/FuturesGammaPlaybook/__tests__/FuturesGammaPlaybook.test.tsx`
- `src/hooks/useFuturesGammaPlaybook.ts`
- `src/hooks/__tests__/useFuturesGammaPlaybook.test.ts`

**Modified:**

- `src/App.tsx` — mount new component, wire bias callback.
- `api/_lib/analyze-context.ts` — add playbook bias formatter (if needed).

**Total new files:** 18 · **Modified:** 1–2

## Data dependencies

**No new:** tables, migrations, crons, env vars, external APIs, or
sidecar changes.

**Consumed (all existing):**

- `spot_exposures` (via `useGexPerStrike` or successor hook) — intraday
  GEX timeseries.
- `gex_strike_0dte` — per-strike walls.
- `greek_exposure` — net GEX snapshot.
- `futures_snapshots` (via `useFuturesData`) — ES price plus live basis.
- `futures_bars` (transitively via `fetch-futures-snapshot` cron output).

## Open questions (with default picks)

1. **Session phase boundaries** — Default: `OPEN 8:30–9:00`, `MORNING
9:00–11:30`, `LUNCH 11:30–13:00`, `AFTERNOON 13:00–14:30`, `POWER
14:30–15:30`, `CLOSE 15:30–16:00` (all CT). User's memory says he
   flattens by close and switches to directional buys after 12–1 PM —
   these phases respect that structure.
2. **Regime transition band** — Default: when spot is within ±0.5% of
   zero-gamma level, classify as `TRANSITIONING` (→ "STAND ASIDE"
   verdict). Tunable constant in `playbook.ts`.
3. **Sizing formula for stacked trades** — Default: show advisory text
   (`1 ES ≈ X spread lots' delta`) rather than computing exact contracts
   (avoids being "click-to-trade"). User enters spread delta manually
   or we compute from open positions if available via `useChainData`.
4. **Owner-gated or public?** — Default: owner-gated (mirrors
   `GexLandscape`). No reason to expose decision tools to guests.
5. **`onBiasChange` → analyze context** — Default: emit a compact
   `PlaybookBias` ({regime, verdict, esZeroGamma, esCallWall, esPutWall,
   sessionPhase, firedTriggers[]}) that the analyze endpoint can include
   as a separate Claude context block. Alternative: piggyback on
   existing `setGexBiasContext` to avoid a second formatter. Decide
   during Phase 1D based on whether the shapes are compatible.
6. **Spot GEX timeseries source** — No dedicated `useSpotGex` hook
   exists. Either extend `useGexPerStrike` to expose the timeseries or
   add `useSpotGex` reading `spot_exposures` directly. Decide during
   Phase 1A — default is extend existing hook to avoid another fetch.
7. **Alert audio asset** — Default: a single short beep WAV hosted in
   `public/sounds/`. Alternative: Web Audio synth tone (no asset). Decide
   during Phase 1E — default is hosted WAV for clearer, consistent
   timbre.

## Thresholds / constants (in `playbook.ts`)

```ts
export const REGIME_TRANSITION_BAND_PCT = 0.005; // ±0.5% of zero-gamma
export const LEVEL_PROXIMITY_ES_POINTS = 5; // "approaching" threshold
export const CHARM_DRIFT_PHASE_START_CT = '13:30'; // when charm dominates
export const ALERT_COOLDOWN_SECONDS = 90; // dedup window
export const LEVEL_BREACH_CONFIRM_SECONDS = 60; // wick filter
export const SESSION_PHASES_CT = {
  open: ['08:30', '09:00'],
  morning: ['09:00', '11:30'],
  lunch: ['11:30', '13:00'],
  afternoon: ['13:00', '14:30'],
  power: ['14:30', '15:30'],
  close: ['15:30', '16:00'],
} as const;
export const ES_TICK_SIZE = 0.25;
```

## Out of scope (deferred to Phase 2 if justified)

- ES options intraday gamma computation (Databento mbp-1 + Black-76 in
  sidecar).
- Dedicated ES-native dealer positioning dashboard.
- Server-side alert delivery (push notifications / SMS / `regime_events`
  table). Phase 1 is client-side only.
- Overnight (post-3 PM CT) gamma visibility.
- Cross-asset GEX correlation (SPX GEX ↔ NQ gamma ↔ ES price).
- ML-driven regime classification (current approach is rule-based).

## Verification on completion

1. `npm run review` — zero tsc errors, zero eslint errors, all tests
   pass.
2. `npm run dev`, load app as owner, verify:
   - Panel renders below `GexLandscape`.
   - Regime header shows correct verdict given current GEX.
   - Playbook rules match regime.
   - ES levels have sensible basis translation (within 2–5 pts of SPX
     levels during RTH).
   - Scrubber rewinds intraday state.
   - At least one alert fires when scrubbing across a known zero-gamma
     crossing.
   - Alert config drawer persists toggles across reload.
   - Analyze endpoint includes playbook bias (if wired).
3. Manual sanity check on one historical session — pick a known +GEX
   range-bound day and a known −GEX trend day; verify the verdict
   matched what actually happened.

## Rough total scope

- **6 sub-phases**, each 1.5–2 hrs.
- **~11 hrs total engineering time** (Phase 1 only, including alerts).
- **No infrastructure changes** — pure frontend plus maybe one analyze
  context formatter.
- **Zero ongoing cost** (no new subscriptions, no new cron DB load).
