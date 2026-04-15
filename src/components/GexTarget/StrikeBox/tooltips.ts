/**
 * Tooltip text for StrikeBox greek bars (Appendix H — exact wording).
 *
 * Each greek has three states (positive / negative / zero) with hand-tuned
 * trader-facing copy explaining what the dealer-flow story is at the strike.
 * Kept as plain string constants (not React nodes) so callers can pass them
 * to the native `title` attribute.
 */

export const CHEX_TOOLTIPS = {
  positive:
    'Positive Charm \u00B7 selling pressure into expiration\nDealers at this strike need to sell the underlying as time passes to stay hedged. This creates passive downward pressure as 0DTE approaches expiry, even without a change in the underlying price.',
  negative:
    'Negative Charm \u00B7 buying pressure into expiration\nDealers at this strike need to buy the underlying as time passes to stay hedged. This creates passive upward pressure as 0DTE approaches expiry \u2014 often the biggest tailwind for pins in the 2pm\u2013close window.',
  zero: 'Charm near zero\nNo meaningful time-decay pressure from dealer hedging at this strike. The magnet isn\u2019t being reinforced or dismantled by the passage of time alone.',
};

export const DEX_TOOLTIPS = {
  positive:
    'Positive DEX \u00B7 resistance / supply overhead\nDealers are net long delta at this strike \u2014 typically from customers buying puts. They\u2019ve already shorted the underlying as a hedge. As price approaches this strike, those short hedges lean on supply and create resistance.\nUnlike charm and vanna, DEX doesn\u2019t generate new flow \u2014 it tells you where the hedges already live. The flow shows up when spot, vol, or time moves those hedges around.',
  negative:
    'Negative DEX \u00B7 support / demand underneath\nDealers are net short delta at this strike \u2014 often from customers selling calls or from calls dealers are short. They\u2019re already long the underlying as a hedge. As price drops toward this level, those long hedges anchor the tape and create support.\nDEX doesn\u2019t generate new flow \u2014 it tells you where the hedges already live.',
  zero: 'DEX near zero\nNo concentrated dealer directional exposure at this strike. It\u2019s unlikely to behave as support or resistance based on hedge positioning alone.',
};

export const VEX_TOOLTIPS = {
  positive:
    'Positive VEX \u00B7 selling pressure on vol expansion\nA rise in implied volatility forces dealers at this strike to sell the underlying to stay hedged. When VIX expands \u2014 headlines, support cracks, fear bids \u2014 dealers mechanically hit bids, amplifying selloffs. Part of why vol spikes and price drops reinforce each other on the way down.',
  negative:
    'Negative VEX \u00B7 buying pressure on vol crush\nA drop in implied volatility forces dealers at this strike to buy the underlying to stay hedged. This is the classic \u2018vol crush rally\u2019 \u2014 VIX falls, dealers lift offers mechanically, price drifts higher with no catalyst. Strongest after fear spikes unwind (post-FOMC, post-CPI, Monday-morning weekend-premium decay).',
  zero: 'VEX near zero\nThis strike won\u2019t generate meaningful dealer flow from vol changes. Less interesting around VIX moves, OPEX, or vol-crush events.',
};

export const CP_TOOLTIPS = {
  positive:
    'Net long gamma \u00B7 dealer long delta (support zone)\nNet GEX is positive here \u2014 dealers are net long gamma, meaning they buy dips and sell rips to stay delta-neutral. That mechanical two-way flow acts as a gravitational anchor. Expect price to be drawn toward this strike and find support on a test from above.\nFormula: net GEX$ \u00F7 (spot \u00D7 100) \u2248 dealer delta in contracts.',
  negative:
    'Net short gamma \u00B7 dealer short delta (resistance zone)\nNet GEX is negative here \u2014 dealers are net short gamma, meaning they sell into strength and buy into weakness in the same direction as price. This amplifies moves rather than dampening them. Price through this level tends to accelerate; it\u2019s a zone of fuel not a floor.\nFormula: net GEX$ \u00F7 (spot \u00D7 100) \u2248 dealer delta in contracts.',
  zero: 'Net GEX near zero\nDealer gamma exposure is roughly balanced at this strike. No strong mechanical hedging pull in either direction \u2014 less likely to act as a magnet or accelerant.',
};
