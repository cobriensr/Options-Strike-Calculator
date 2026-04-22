# Futures Playbook — Trade Bias verdict strip

**Date:** 2026-04-22
**Status:** Scoped, ready to build
**Parent:** futures-playbook-bias-metrics-2026-04-21.md

## Goal

Collapse all the playbook's signals (regime, rule status, conviction,
drift-override, wall-flow) into a single **LONG / SHORT / NEUTRAL**
directional bias shown as a prominent banner at the top of the
FuturesGammaPlaybook widget — so the trader sees a decisive direction
in one glance instead of synthesizing six panels.

## Why

Current panels give the trader _all_ the signals but make them do the
synthesis. In conflicting-signal scenarios (e.g. POSITIVE regime with a
drift-down and a low-conviction fade rule) the correct read requires
scanning conviction badges, drift banner, wall-flow strip, and level
status simultaneously. At 2:50 PM live, that's cognitive load at
exactly the wrong moment. The user's own words: _"I just need a go
long or go short — it's a lot of information that doesn't give a
decisive direction."_

## Behavior spec

A single `TradeBiasStrip` component renders one of:

- 🟢 **LONG @ <esPrice>** — with short reason (≤ 50 chars)
- 🔴 **SHORT @ <esPrice>** — with short reason
- ⚪ **NEUTRAL** — with reason why no directional call

Plus an optional conviction label: `STRONG` (green/red badge), `MILD`
(subdued), or no label when NEUTRAL.

### Derivation rules

**TRANSITIONING regime** → `NEUTRAL · regime ambiguous`.

**POSITIVE regime (mean-revert template):**

- Enumerate ACTIVE fade/lift rules (post drift-override).
- If exactly one ACTIVE: direction is that rule's direction. Conviction
  defaults to MILD; upgrade to STRONG if rule conviction is `high` AND
  wall-flow aligns (ceiling strengthening for SHORT fade / floor
  strengthening for LONG lift). Downgrade to NEUTRAL if rule
  conviction is `low`.
- If both ACTIVE: pick the one with higher conviction. Tie → NEUTRAL.
- If none ACTIVE but ARMED exists: direction from nearest ARMED rule,
  MILD conviction, entry labeled `wait pullback`.
- If all DISTANT: NEUTRAL.

**NEGATIVE regime (trend-follow template):**

- If ACTIVE break-call-wall AND CALL_WALL status ≠ BROKEN → LONG
  (strong if wall-flow aligned: ceiling eroding + floor strengthening).
- If ACTIVE break-put-wall AND PUT_WALL status ≠ BROKEN → SHORT (strong
  if aligned: floor eroding + ceiling strengthening).
- If either wall is already BROKEN with an associated ACTIVE rule → the
  direction of that broken wall's trend with MILD conviction and entry
  labeled `wait pullback to <level>` (the user missed the clean break;
  continuation still valid on retrace).
- If both walls BROKEN simultaneously → NEUTRAL · whipsaw risk.
- If all DISTANT → NEUTRAL.

**Modifier: drift-override already fired**
If `rulesForRegime` suppressed one side under drift, the remaining
rule's direction is inherited with one conviction step up when the
drift direction aligns (e.g. drift-up + POSITIVE suppresses fade →
remaining lift-put-wall benefits from the trend).

### Reason strings (≤ 50 chars)

Examples (kept short enough to fit on a narrow screen):

- `fade-call @ sticky-pin · wall strengthening`
- `break-call continuation · trend intact`
- `break fired early · wait pullback`
- `low conviction · weakening pin`
- `regime ambiguous · spot inside ZG band`
- `wall flow contradicts rule`
- `all setups distant`

## Files to create / modify

**Create:**

- `src/components/FuturesGammaPlaybook/tradeBias.ts` — pure derivation
  function `deriveTradeBias(playbookState): TradeBias`.
- `src/components/FuturesGammaPlaybook/TradeBiasStrip.tsx` — display
  component.
- `src/__tests__/components/FuturesGammaPlaybook/tradeBias.test.ts` —
  cover every decision branch (POSITIVE × drift, NEGATIVE × broken
  wall, TRANSITIONING, all-distant, tie cases).

**Modify:**

- `src/components/FuturesGammaPlaybook/types.ts` — add `TradeBias`
  type.
- `src/components/FuturesGammaPlaybook/index.tsx` — mount `TradeBiasStrip`
  immediately below `RegimeHeader` (above the BACKTEST action
  directive). Pass `isLive` so backtest context stays honest.
- `src/hooks/useFuturesGammaPlaybook.ts` — compute `tradeBias` via
  `useMemo` and expose on the return type.

**Do not modify:**

- Existing rule logic (`playbook.ts`, `triggers.ts`) — the bias strip
  is a pure consumer of rules/levels/flowSignals, not a rewrite of
  them.
- `ActionDirective` — keeps its current "WAIT/ACTIVE/ARMED" copy below
  the bias strip. Two complementary views: bias = direction, directive
  = mechanics.

## Open questions (decided)

- **Replace ActionDirective or add above it?** Add above. Keeps the
  mechanics line for people who want it; the trader's first glance
  goes to the direction badge.
- **Size of the direction badge?** Big — same vertical footprint as
  the regime verdict tile so it's immediately scannable.
- **Colors?** LONG = emerald-500, SHORT = red-500, NEUTRAL = muted
  grey. Matches existing `DIRECTION_META` in PlaybookPanel.
- **What about charm-drift rule (EITHER direction)?** When it's the
  only ACTIVE rule, the bias is NEUTRAL with reason `charm drift —
direction-agnostic`. The trader manually picks side based on price
  context. Don't force a direction that the rule itself doesn't pick.

## Non-goals

- Not an auto-trader. No order routing, no position sizing math
  beyond what the rule row already carries.
- Not persisted to analyze context (yet). If the bias proves useful
  live for a session or two, future spec threads it through
  `PlaybookBias` and into the analyze prompt.
- Not configurable thresholds. If the derivation rules need tuning
  after real use, that's a follow-up spec with data.

## Done when

- [ ] `TradeBiasStrip` renders at the top of the playbook widget.
- [ ] Shows LONG/SHORT/NEUTRAL + reason + entry.
- [ ] All decision branches have unit test coverage in
      `tradeBias.test.ts`.
- [ ] On yesterday's 10:24 AM scrub: bias reads `NEUTRAL · weakening
pin, drift down`.
- [ ] On yesterday's 2:50 PM scrub: bias reads `LONG · break fired
early, wait pullback to 7077.75` (since call wall is BROKEN).
- [ ] `npm run review` green.
