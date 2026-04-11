/**
 * Foundational market mechanics framework for the analyze endpoint.
 *
 * Distilled from SqueezeMetrics research:
 *   - "Gamma Exposure (GEX)" white paper (March 2016, rev. December 2017)
 *   - "Short Is Long" paper (March 2018)
 *   - sqzme.co indicator documentation (G, D, P, V)
 *   - "The Implied Order Book" (GEX Ed., SqueezeMetrics, 6 July 2020)
 *
 * Injected as part of the stable cached system prompt so Claude internalizes
 * these mechanics as background context for every analysis — not reference
 * material to look up on demand, but a lens through which all signals are read.
 */

export const MARKET_MECHANICS_CONTEXT = `<market_mechanics_framework>
This section documents the foundational market structure mechanics that underlie every rule, signal, and heuristic in this system. Understanding WHY the rules exist — not just WHAT they say — allows you to reason correctly in novel situations not explicitly covered by the rules.

<dealer_gamma_hedging>
## The Dealer Gamma Hedging Framework

Every option contract traded in SPX has a market maker (MM) on the other side. MMs do not take directional bets — they profit from the bid/ask spread and must remain delta-neutral at all times. This delta-neutrality requirement is the engine that drives GEX mechanics.

**How dynamic hedging works:**

When an MM sells a put to an investor (the standard case — investors buy protective puts, MMs sell them), the MM is SHORT the put. A short put has POSITIVE delta (MM profits as price rises) and NEGATIVE gamma. To neutralize the positive delta, the MM sells the underlying (futures). So far, so good — they're delta-neutral.

Now price falls 10 points. The put's delta becomes more negative. The MM's short put position now has MORE positive delta than before (short × more negative = more positive). To stay neutral, the MM must sell more futures. The MM is selling as price falls. This AMPLIFIES the move — classic negative gamma behavior.

When price rises 10 points, the reverse occurs: the put's delta becomes less negative, the MM's net delta is now negative, so the MM must buy back futures. The MM is buying as price rises. Again, amplifying.

**The call side works in the opposite direction:**

Investors sell covered calls; MMs buy them. MM is LONG the call. A long call has positive gamma. As price rises, call delta increases, making the MM's position too long delta — so the MM sells futures. As price falls, call delta decreases, MM's position is now short delta — so the MM buys futures. The MM is selling into rallies and buying dips. This SUPPRESSES volatility.

**The net result — GEX regime:**

The balance between the call-side (long gamma, suppressing) and put-side (short gamma, amplifying) creates the Gamma Exposure (GEX) regime:

- POSITIVE net GEX: Call gamma dominates. MMs collectively are net long gamma. They sell into rallies and buy dips. Every price move generates counter-directional hedging flow. The market is in SUPPRESSION mode — bounded, mean-reverting, favorable for iron condors and premium selling. Gamma walls are sticky. Periscope green bars are reliable anchors.

- NEGATIVE net GEX: Put gamma dominates. MMs collectively are net short gamma. They sell into selloffs and buy into rallies. Every price move generates same-directional hedging flow. The market is in AMPLIFICATION mode — trending, volatile, directional. Walls may fail under sustained pressure. Risk management timing must compress.

- GEX NEAR ZERO: Hedging flows are balanced and largely cancel out. Price moves freely based on supply/demand without structural dampening or amplification. This is often a regime transition point. When the zero-gamma level is near spot, a small catalyst can tip the market into either regime.

**GEX formula (for reference):**
- Calls: GEX = Γ × OI × 100
- Puts: GEX = Γ × OI × (-100)
- Total GEX = sum across all strikes and all expirations (denominated in dollars for SPX)

The magnitude matters as much as the sign. Deeply negative GEX means MMs must buy/sell proportionally more shares per point of SPX movement — the hedging flows are larger and the amplification is stronger.
</dealer_gamma_hedging>

<gex_vs_vix>
## Why GEX Predicts Volatility Better Than VIX

VIX is derived from quoted option prices — it measures what option market participants are PRICING as future volatility. Because MMs are sophisticated, their quotes incorporate their own hedging costs, bid/ask spreads, and demand for protection. VIX reflects price, not mechanics.

The empirical problem: VIX cannot distinguish between its lowest readings. The 1-day standard deviation of SPX returns at VIX below 12 (lowest quartile) is 0.51%. At VIX 12-15 (second-lowest quartile) it is 0.66%. A VIX of 12 and a VIX of 15 predict nearly the same realized variance — the model is nearly useless in benign regimes.

GEX predicts actual mechanical flows. When GEX is in its highest quartile, the 1-day SPX standard deviation is 0.55%. In the second-highest quartile, it is 0.85% — a 4-point difference on an index at 5,500. These distributions are empirically distinguishable in a way VIX's lowest readings are not.

Additionally, VIX's correlation to 30-day FUTURE realized volatility is 0.75, but its correlation to the PRIOR month's realized volatility is 0.85. VIX is systematically lagging — it is more a reflection of recent volatility than a forecast of future volatility. GEX is derived from the actual open interest structure that governs today's hedging flows, making it structurally forward-looking by design.

**Practical implication:** On days where VIX reads low (12-16) but GEX is negative or near zero, the mechanical hedging dynamics can produce much larger intraday moves than VIX implies. Do not use VIX alone to gauge intraday range risk. GEX regime (via Aggregate GEX and the zero-gamma level) is the more reliable indicator of whether today's price action will be suppressed or amplified.
</gex_vs_vix>

<gex_at_expiry>
## GEX Behavior at 0DTE Expiration

Gamma is highest for at-the-money options and increases rapidly as expiration approaches — especially in the final hours of a 0DTE session. This creates intensifying hedging flows near large OI strikes as the day progresses.

At 9:30 AM ET, a 10-delta 0DTE option has modest gamma. By 1:30 PM ET, the same option has nearly double the gamma if it has migrated toward ATM. By 3:00 PM ET, gamma for near-ATM options is extreme — small moves create large delta changes, requiring proportionally larger hedging trades.

This is why positive gamma walls that held reliably all morning can fail in the final 2 hours: as 0DTE gamma concentrates near ATM, strikes far from the current price lose their gamma (and thus their ability to suppress moves), while the strikes near the money gain enormous gamma. The suppression effect of morning Periscope walls does not extrapolate to the afternoon — the gamma distribution has shifted.

The same mechanism creates the pin effect at high-OI strikes. With extreme gamma and large OI, MMs are forced into large hedging trades at those specific levels. This creates oscillation — as price crosses the strike, gamma flips sign and the hedging direction reverses, pulling price back. The oscillation is mechanical and predictable, not directional.
</gex_at_expiry>

<short_is_long>
## The Short Is Long Framework (Dark Pool Short Volume as Buying Proxy)

The word "short" in market data is deeply misleading. According to SEC reporting, approximately 49% of all equity share volume is classified as "short." The intuitive interpretation — half the market is making bearish bets — is wrong.

**The actual mechanism:**

Market makers are exempt from short-selling restrictions under Regulation SHO. The reason: when a customer submits a buy order, the MM filling that order must sell shares to the customer. If the MM does not already own those shares, this sale is classified as a SHORT sale — not because the MM is bearish, but because they are acting as liquidity provider.

The relationship is:
- Investor BUYS → MM sells short to fill the order → reported as "SHORT"
- Investor SELLS → MM buys to absorb the sell order → reported as "long" (not short)

Since the modern maker-taker model (introduced via Island ECN in 1997 and universally adopted by ~2005) pays MMs rebates for providing liquidity, nearly every retail and institutional buy order in today's market is filled by an MM via a short sale. The liquidity rebate competition ensures MMs intercept the vast majority of all order flow.

**The empirical result:**

Across 11,254 securities and 12.74 million discrete days of return data (2010-present):
- Days with dark pool short volume below 35%: intraday returns steadily and increasingly NEGATIVE
- Days with dark pool short volume above 35%: intraday returns uniformly POSITIVE
- Upper quantile (50-100% dark pool short): +0.1184% mean intraday return
- Lower quantile (0-49% dark pool short): -0.0593% mean intraday return

The relationship is nearly linear between 20-60% short volume — the range where most of the data sits. High short volume means high buying activity being facilitated by MMs. Low short volume means high selling activity.

**DIX (Dark Index):**

DIX tracks dollar-weighted dark pool short volume across all S&P 500 components. It aggregates the individual stock signals into an index-level read on institutional buying activity.

Key DIX thresholds:
- DIX ≥ 45%: associated with mean 60-market-day forward returns of 5.3%, vs a 2.8% baseline across all observations. This is nearly double the baseline return.
- DIX rises during corrections because institutional investors accumulate index stocks at discounted prices. An elevated DIX during a selloff signals that smart money is buying the weakness — which limits downside depth and sets up future recovery, but does NOT stop the immediate move.

**What DIX is NOT:**

DIX is a MEDIUM-TO-LONG TERM bullish signal, not an intraday reversal indicator. High DIX on a selloff day means institutions are accumulating, but the selling pressure is still real and the session may close lower. The signal's predictive power emerges over 30-90 calendar days, not hours.

DIX divergence (price falling while DIX is rising or elevated) is the most interesting configuration: institutional players are buying despite the surface bearishness. This can foreshadow a rally but the timing is loose.

**The modern D (Dark-Ratio) indicator:**

The current sqzme product tracks D as a 5-day moving average of OTC short-selling proportion, ranging from 0 to 1. Higher D = more dark pool short volume = more facilitated buying = bullish tailwind. It is the same conceptual signal as DIX, smoothed to reduce daily noise.
</short_is_long>


<implied_order_book>
## The Implied Order Book: Options as Committed Liquidity

Every option contract creates a *committed* future liquidity obligation on the part of the dealer who sold it. Unlike a market order (executed once and done) or a limit order (cancellable at will), a dealer's hedging obligation attached to an open option position cannot be withdrawn — it persists until the option expires or is closed. This is the core insight of the implied order book framework: options are not bets, they are pre-committed orders with specific price and volatility triggers.

**DDOI (Dealer Directional Open Interest):**

Public open interest data tells you how many contracts exist but not whose side is whose. DDOI solves this by tracking the transaction-level direction of every SPX options trade — whether the customer bought or sold — to infer the dealer's actual inventory. This distinction matters: a dealer who SOLD a put has different hedging commitments than a dealer who BOUGHT a put, even though both show up identically in public OI data.

The key categories:

- **Customer short OTM put (dealer long put):** Dealer is long the put. As price falls toward the strike, the put goes from OTM toward ATM — dealer gains long delta exposure. To stay neutral, dealer SELLS futures as price falls. This is DESTABILIZING. The customer sold a put to collect premium; the dealer must sell into the selloff.

- **Customer long OTM put (dealer short put):** Dealer is short the put. As price falls, dealer gains short delta exposure. To stay neutral, dealer BUYS futures as price falls. This is STABILIZING — the familiar GEX buy-the-dip mechanic. This is the standard hedging regime for most market conditions.

**The put-as-order-type framework:**

Depending on dealer inventory, a put creates one of two very different implied orders:

- **Short put (dealer):** Creates a *buy limit order* at and below the strike. Dealer buys when price falls. Equivalent to a protective limit order in the book.
- **Long put (dealer):** Creates a *sell stop order* at the strike. Dealer sells when price falls. Equivalent to a stop-loss in the book.

The aggregate of all dealer put positions is therefore an implied limit order book — some levels have committed buying (where customers own puts, dealer is short), other levels have committed selling (where customers sold puts, dealer is long).

**GEX as a measure of this book:**

GEX quantifies the dollar value of delta hedging per point of SPX movement from all outstanding options positions. Example from the paper: at SPX 3000, a 2900-strike put with 100 SPX points of notional at a given gamma produces approximately $393/point of hedging obligation. Aggregate across all strikes and expirations, and the typical GEX range is $0 to $1bn+ per point, historically very rarely negative.

When GEX is large and positive, the implied order book is thick with committed buying below — the market has structural support not from sentiment but from hedging mechanics.

**The GEX zero problem — two causes, one dangerous:**

GEX approaches zero in two scenarios that look identical in the data but have opposite implications:

1. **Balanced inventory:** Roughly equal short-put and long-put inventory at the dealer level. The buy limits and sell stops cancel out. The book is thin but not tilted in either direction. Historically benign.

2. **High implied volatility:** At high IV, every put has a wider distribution and its gamma is spread across a larger price range. The per-strike gamma contribution shrinks. GEX approaches zero simply because the gamma has spread out, NOT because inventory has balanced. This is dangerous — and it is the scenario that precedes crashes.

The distinction: zero GEX from balanced inventory is structural equilibrium. Zero GEX from high IV is a regime where GEX has become an unreliable guide and VEX (see below) has taken over as the dominant hedging flow driver.

**VEX (Vanna Exposure) — the implied order book in volatility space:**

While GEX measures dealer delta sensitivity to *price changes*, VEX measures dealer delta sensitivity to *IV changes*. Vanna is the cross-partial derivative (∂²V/∂S∂σ) — how much delta changes per unit of IV change. Because dealers hedge continuously, any IV change that moves their delta requires them to trade the underlying.

The direction of the VEX effect depends critically on moneyness:

- **OTM put, dealer short (customer long):** As IV rises, the OTM put's delta becomes more negative. Dealer's short put position becomes more negative delta — so dealer must BUY futures to stay neutral. **IV rise → dealer buys.** Stabilizing.

- **ITM put, dealer short (customer long):** As IV rises, the deep ITM put's delta moves back toward -0.5 (toward neutral). Dealer's position becomes less short delta — so dealer must SELL futures to stay neutral. **IV rise → dealer sells.** Destabilizing.

- **OTM put, dealer long (customer short):** As IV rises, dealer's long put gains more negative delta — dealer must SELL futures. **IV rise → dealer sells.** Destabilizing.

- **ITM put, dealer long (customer short):** As IV rises, delta moves toward -0.5 from deeper ITM — dealer must BUY futures. **IV rise → dealer buys.** Stabilizing.

The call side mirrors the put side symmetrically.

**The vanna cheat sheet — identifying crash configurations:**

Two option positions create inherently unstable configurations because *both* cause dealers to sell when IV rises:

1. **Customer short OTM calls (dealer long calls):** Common in covered call writing. As IV rises, OTM call delta increases. Dealer's long call position gains positive delta — dealer must SELL futures to stay neutral. Rising IV = dealer selling.

2. **Customer long OTM puts (dealer short puts):** Standard protective put buying. As price falls, puts go from OTM toward ITM. The OTM-to-ITM transition is the dangerous moment: while OTM, IV rise → dealer buys (stabilizing); once ITM, IV rise → dealer sells (destabilizing). The flip happens right around ATM.

When the market is loaded with customer-sold covered calls AND customer-bought OTM puts simultaneously, a volatility spike will cause dealers to sell from BOTH directions. This is the crash configuration. The put positions that stabilized the market when OTM become destabilizers the moment they go ITM.

**Crash risk mechanics:**

Crash risk is proportional to the volume of customer-SOLD puts outstanding. Sold puts create:
- Buy limits WHILE OTM (GEX stabilizing): the market has structural support
- Stop-losses WHEN ITM (VEX destabilizing): the GEX support evaporates and becomes selling pressure

The mechanism: a large price drop pushes OTM sold puts toward ATM. GEX drops (gamma spreads out, IVs rise). VEX simultaneously flips sign as puts cross ATM. Dealers who were buying are now selling. The feedback loop: price falls → IV rises → newly-ITM puts generate dealer selling → price falls further → more puts go ITM → more dealer selling.

Long puts do NOT cause crashes by this mechanism. When a customer is LONG puts and price falls, the puts go ITM, vanna flips, and dealers are FORCED to BUY (not sell). Long puts cause short, sharp corrections that self-limit — the hedging mechanic generates buying pressure as the decline deepens.

Crash risk, in the paper's direct formulation: *a function of how many investors have sold puts, plain and simple.*

**GEX+ = GEX + VEX: The complete implied order book:**

Neither GEX nor VEX alone captures the full hedging commitment. GEX+ combines both:

- GEX answers: what do dealers do when PRICE moves?
- VEX answers: what do dealers do when IV moves?
- GEX+ answers: what is the net dealer liquidity provision across both dimensions?

Historical GEX+ range: approximately -$500mm to +$2bn per point. When GEX+ is deeply negative, the market is in a structural environment where both price moves AND volatility spikes generate same-directional dealer selling — the amplification regime at its most extreme.

The paper's headline finding: GEX tightens daily SPX ranges to approximately 0.20% in high-GEX+ regimes. VEX at its worst (deeply negative) can widen daily ranges to 6.00%. The difference between a 0.20% day and a 6.00% day is structural, not sentiment-driven.

**The conditional liquidity map:**

GEX+ is not a single number — it is a function of BOTH current SPX price AND current VIX level. As VIX moves, the vanna contributions shift in sign and magnitude. The full implied order book is therefore a two-dimensional surface. Reading GEX+ at a single price level while ignoring the IV dimension misses the conditional nature of dealer hedging commitments.

Practical implication: when VIX is rising, look not just at GEX (price sensitivity) but at the direction VEX pushes — specifically, whether the current distribution of put OI is in OTM territory (VEX stabilizing) or has moved ITM (VEX destabilizing). The transition from OTM to ITM for the large OI strikes is the key inflection point where structural support inverts.
</implied_order_book>

<sqzme_indicators>
## The sqzme Indicator Framework

The current sqzme product translates these mechanics into four normalized indicators that track market structure in real time:

**G (Gamma-Ratio):** The proportion of call gamma to total gamma in the SPX options market, calculated using Black-Scholes at constant volatility (no skew adjustment). Range 0 to 1.
- G approaching 1: Call gamma dominates → MMs skewed toward net long gamma → suppression regime. Favorable for premium selling.
- G approaching 0: Put gamma dominates → MMs skewed toward net short gamma → amplification risk. Options buyer's environment.
- G = 0.5: Balanced gamma → no particular structural regime from dealer hedging alone.

This is the directional equivalent of GEX — it captures the call/put gamma balance without the absolute magnitude. A low G in a high-OI market has more structural impact than a low G in a thin market.

**D (Dark-Ratio):** 5-day moving average of OTC dark pool short-selling proportion. Range 0 to 1.
- Higher D: More dark pool short volume → more institutional buying facilitated → bullish medium-term tailwind.
- Lower D: Less dark pool short volume → more institutional selling or distribution → bearish medium-term pressure.
- Smoothed to 5-day MA to reduce day-to-day noise from single large block trades.

**P (Price-Trend):** Volatility-adjusted momentum = (21-day moving average of daily % changes) / (21-day moving average of absolute daily % changes). Range -1 to +1.
- High P (near +1): The market is making consistent directional progress in one direction relative to its own volatility. Clean uptrend.
- Low P (near -1): Consistent downtrend.
- P near zero: Chopping — lots of volatility but no net direction. This is actually the most dangerous environment for premium selling: high realized vol with no clear directional offset.

**V (Volatility-Trend):** Whether realized volatility is expanding or contracting relative to its own moving average.
- Rising V: Vol regime is expanding — each day is more volatile than recent history. Widen strikes, reduce size.
- Falling V: Vol regime is contracting — the market is calming. Favorable for premium collection as the straddle cone will tend to overstate risk.
</sqzme_indicators>

<connecting_to_practice>
## Connecting Theory to Practice

These mechanics explain WHY the rules in this system exist — not as arbitrary guidelines but as consequences of quantifiable dealer behavior:

- **Rule 16 (GEX regime)** is directly derived from the positive/negative GEX suppression/amplification framework. The management timing tiers (when to close, what profit targets to use) are calibrated to how quickly amplification forces grow when dealers are net short gamma.

- **Rule 1 (Gamma Asymmetry)** exists because a lopsided GEX profile means the amplification force dominates on one side and the suppression force dominates on the other. Price moves toward the negative gamma side with no counter-directional hedging flow to slow it down.

- **Rule 6 (Dominant Positive Gamma for IC)** reflects that a 10x positive gamma wall means a large volume of MM hedging will repeatedly buy the dip and sell the rally at that level — the hedging commitments are large enough to absorb selling pressure and return price toward the wall.

- **Rule 7 (Stops Must Avoid Negative Gamma Zones)** follows directly from amplification mechanics: placing a stop at a negative GEX strike guarantees that the hedging flows themselves will trigger and then blow through the stop.

- **Rule 18 (Wall Placement Discipline — Shelf Not Spike)** follows from the same amplification mechanics: a narrow GEX spike creates stabilization only exactly at that level, while the surrounding negative GEX accelerates any departure. A shelf of contiguous positive GEX creates suppression across multiple adjacent strikes that doesn't have an amplification corridor immediately bordering it.

- **Pin risk and settlement mechanics** are the 0DTE gamma spike in concentrated form: MMs are forced into enormous, rapidly-changing hedges as near-ATM options oscillate between in-the-money and out-of-the-money in the final hours. The mechanical committed hedging flows at high-OI strikes create the oscillation pattern, not directional sentiment.

- **DIX and the D (Dark-Ratio)** context: when D is elevated during a session where SPX is selling off, the dark pool short volume tells you that institutional buyers are actively accumulating below — the selling may be shallow or may set up a stronger base for recovery. When D is falling during a rally, the dark pool signal suggests distribution — institutions are selling into strength, which raises the probability the rally is mechanical rather than structurally supported.

- **VEX and the GEX zero problem:** When GEX reads near zero and VIX is elevated, do not interpret this as a benign balanced regime. The dangerous GEX zero is caused by high IV spreading gamma thin across strikes — in this environment VEX dominates, and the direction of VEX flows depends on whether large-OI put strikes are OTM (stabilizing) or ITM (destabilizing). High VIX + GEX near zero is the regime most likely to produce crash dynamics, not orderly ranging.

- **Rule 17 (Vanna context):** The positive-vanna / declining-VIX structural upward drift documented in the rules is the constructive side of VEX — when put OI is OTM and IV is falling, dealers are buying as their delta unwinds. This is automatic, mechanical, not sentiment-driven. When VIX is RISING instead, and those same puts are near or in the money, the vanna flow reverses and becomes a selling headwind.

- **The crash configuration check:** Before initiating any short-premium structure when the market has sold off significantly, assess whether large OI put strikes have moved from OTM to ATM or ITM. If they have, the structural support that existed when those puts were OTM has inverted — GEX has weakened, VEX has flipped sign, and the implied order book is no longer buying dips.

In every analysis, the question is: what are the dealers committed to doing, and at what price levels AND at what IV level? GEX answers where and how much (price dimension). VEX answers the conditional overlay — what happens to those same commitments if volatility moves. GEX+ is the full picture. The direction of those combined commitments (suppression vs amplification, structural vs conditional) determines which structure is appropriate, how large it can be, and how long it can safely be held.
</connecting_to_practice>
</market_mechanics_framework>`;
