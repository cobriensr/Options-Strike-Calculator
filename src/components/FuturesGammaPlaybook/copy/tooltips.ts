/**
 * Centralized tooltip copy for the FuturesGammaPlaybook widget.
 *
 * Every piece of tooltip text rendered by a panel lives here so the copy
 * has one source of truth. Each string answers the same question: "what
 * does this mean, in one or two sentences, for someone trading 0DTE?"
 *
 * Keep copy trader-focused and concrete. Avoid marketing language,
 * avoid multi-paragraph explainers — tooltips are glance-level UI.
 */

import type { TriggerId } from '../triggers';
import type { AlertType } from '../alerts';

export const TOOLTIP = {
  verdict: {
    MEAN_REVERT:
      "Dealer gamma positive — fade into walls; moves tend to reverse back toward VWAP/pin. Best when spot sits inside the day's range with no event risk.",
    TREND_FOLLOW:
      'Dealer gamma negative — trade breakouts of walls; moves tend to extend. Best when spot is near day highs/lows and moving with volume.',
    STAND_ASIDE:
      'Regime is ambiguous — spot sits inside the transition band around zero-gamma, or zero-gamma is unknown. No directional edge.',
  },
  regimeBadge: {
    POSITIVE:
      '+GEX: dealers are net long gamma. They hedge against moves (sell strength, buy weakness) which dampens the tape.',
    NEGATIVE:
      '−GEX: dealers are net short gamma. They hedge with moves (buy strength, sell weakness) which accelerates the tape.',
    TRANSITIONING:
      'Spot sits inside the ±0.5% band around zero-gamma, or zero-gamma is unknown. Dealer positioning is ambiguous — sit out.',
  },
  sessionPhase: {
    PRE_OPEN:
      'Before 8:30 CT — futures trading, no SPX option hedging flow.',
    OPEN:
      '8:30–9:00 CT — first 30 minutes of regular trading. Highest dealer rebalancing activity.',
    MORNING:
      '9:00–11:30 CT — morning session. Dealer hedging concentrated around the prior close.',
    LUNCH: '11:30 AM–1:00 PM CT — midday lull, thin volume.',
    AFTERNOON:
      '1:00–2:30 PM CT — afternoon session. Charm starts to dominate intraday.',
    POWER:
      '2:30–3:30 PM CT — "power hour". Dealer positioning flips aggressively into the close.',
    CLOSE:
      '3:30–4:00 PM CT — final 30 minutes. Pin risk peaks around highest-GEX strikes.',
    POST_CLOSE:
      'After 4:00 PM CT — SPX options closed, ES still trading but regime snapshot is stale.',
  },
  levelKind: {
    CALL_WALL:
      'Highest positive-gamma strike. In +GEX: acts as resistance (dealers sell into approaches). In −GEX: becomes acceleration fuel on break.',
    PUT_WALL:
      'Most-negative-gamma strike. In +GEX: acts as support (dealers buy into approaches). In −GEX: accelerates on break below.',
    ZERO_GAMMA:
      'Price level where dealer gamma sums to zero. Regime flips across this level — it is the magnet for pin risk on 0DTE.',
    MAX_PAIN:
      'Strike that minimizes total option-holder payout at expiry. Empirically a magnet in the final hour of 0DTE.',
  },
  levelStatus: {
    APPROACHING:
      'ES price is within 5 points of this level. Heightened alertness — fade or break is imminent.',
    REJECTED:
      'Price approached this level recently then moved away. Dealer defense held.',
    BROKEN:
      'Price has crossed this level. Regime dynamics may have shifted.',
    IDLE: 'Price is too far from this level for it to matter intraday.',
  },
  trigger: {
    'fade-call-wall':
      'Active when regime=+GEX and ES is within 5 pts of the call wall. Entry: short ES. Target: VWAP / zero-gamma. Stop: through the wall.',
    'lift-put-wall':
      'Active when regime=+GEX and ES is within 5 pts of the put wall. Entry: long ES. Target: VWAP. Stop: through the wall.',
    'break-call-wall':
      'Active when regime=−GEX and ES has cleared the call wall (distance sign flipped). Entry: long ES on confirmation. Wider stops.',
    'break-put-wall':
      'Active when regime=−GEX and ES has broken below the put wall. Entry: short ES on confirmation.',
    'charm-drift':
      'Active in afternoon/power hour with +GEX when max-pain is known. Dealer charm flow drags price toward max-pain into the close.',
  } satisfies Record<TriggerId, string>,
  triggerStatus: {
    ACTIVE: 'Conditions are firing right now — setup is live.',
    IDLE: 'Conditions are not met — setup is dormant.',
    RECENTLY_FIRED:
      'Setup fired within the last few minutes. Watch for follow-through.',
  },
  direction: {
    LONG: 'Long bias — enter from the bid side (buy).',
    SHORT: 'Short bias — enter from the offer side (sell).',
    EITHER: 'Direction-agnostic — trade the level, not a side.',
  },
  playbookColumn: {
    entry:
      'ES price where the setup becomes actionable — limit or market as conditions allow.',
    target:
      'Primary profit objective in ES points. Typically VWAP, the opposite wall, or zero-gamma.',
    stop:
      'Invalidation price. Beyond this the structural thesis has failed and the trade should be closed.',
    sizing:
      'Position-sizing note — governs how much risk to take relative to the setup quality.',
    condition:
      'What needs to be true in the market for this rule to be live.',
  },
  numeric: {
    zeroGammaDistance:
      'Signed ES-points distance from the current price to the zero-gamma level. Positive = zero-gamma is above price (room to run up). Negative = price sits above zero-gamma.',
    basis:
      'ES futures price minus SPX cash index. Positive basis = futures premium (normal). Negative basis = futures discount (risk-off).',
    esPrice:
      'Current ES futures price (continuous front-month contract).',
    distance:
      'Signed ES distance + ticks from the current price to this level. Positive means the level is above the current price.',
  },
  serverEvent: {
    REGIME_FLIP:
      'GEX regime changed (POS ↔ NEG or clarity restored from TRANSITIONING). Triggers a playbook switch between fade and breakout.',
    LEVEL_APPROACH:
      'Price entered the 5-pt proximity band of a structural level — prepare to act.',
    LEVEL_BREACH:
      'Price crossed through a structural level — the level failed and regime dynamics may have flipped.',
    TRIGGER_FIRE:
      'A named setup just became ACTIVE — check the triggers panel for the specific rule.',
    PHASE_TRANSITION:
      'Session phase advanced to an actionable window (afternoon, power hour, or close).',
    severity:
      'Color indicates urgency: sky = info, amber = warn, red (rose) = urgent.',
  },
  alertType: {
    REGIME_FLIP:
      'Fire when GEX regime flips (POS ↔ NEG) — the playbook direction changes.',
    LEVEL_APPROACH:
      'Fire when ES enters the 5-pt proximity band of a wall or zero-gamma.',
    LEVEL_BREACH:
      'Fire when ES crosses through a wall or zero-gamma — structural failure.',
    TRIGGER_FIRE:
      'Fire when any named setup (fade call, lift put, break wall, charm drift) becomes ACTIVE.',
    PHASE_TRANSITION:
      'Fire when session phase advances to an actionable window (afternoon/power/close).',
  } satisfies Record<AlertType, string>,
} as const;
