# Market Mechanics Research Topics
## Future additions to `api/_lib/market-mechanics.ts`

These are gaps in the current Claude analyze prompt's foundational market mechanics framework — areas where the theory is either missing, underexplained, or disconnected from the practical rules Claude applies. Ordered by estimated impact on daily analysis quality.

---

## High Priority

### 1. Charm Flows — The Pin Effect's Actual Mechanism

**What's missing:** Charm is ∂delta/∂time — how a position's delta changes purely from time passing, with price and IV constant. The current `<gex_at_expiry>` section describes the *outcome* of the pin (oscillation, hedging reversals at high-OI strikes) without naming or explaining the mechanism that drives it.

**Why it matters:** On positive-GEX days, charm causes dealers to systematically unwind hedges as 0DTE options decay toward expiry. This creates predictable intraday drift toward high-OI strikes — not random walk, but mechanically determined drift. Understanding charm would let Claude reason correctly about:
- Why price gravitates toward large OI strikes in the afternoon
- Why the pin holds more reliably on high-GEX days (charm reinforces GEX)
- Why the morning Periscope walls lose suppression power into the close (charm-driven delta unwind changes dealer exposure)

**Sources to find:** ORATS, VolResearch, or SqueezeMetrics have covered charm in the context of 0DTE. Any academic paper on the Greeks beyond delta/gamma (e.g., "higher-order Greeks in practice") would cover the mechanics.

---

### 2. The 0DTE Volume Regime Shift

**What's missing:** The GEX framework was developed when weekly and monthly expirations dominated SPX volume. By 2024, 0DTE represents ~40-50% of daily SPX options volume. This has changed the intraday GEX landscape in ways the current framework doesn't acknowledge.

**Why it matters:** Claude currently treats the 9:30 AM GEX snapshot as a reasonably durable guide to the day's structure. In the current market, it isn't. A large portion of outstanding OI expires same-day, so the gamma distribution reshapes continuously throughout the session. Specifically:
- AM GEX is heavily influenced by 0DTE OI that didn't exist at yesterday's close
- 0DTE gamma spikes rapidly (especially for near-ATM strikes) through the session
- The PM GEX picture can look radically different from the AM snapshot even without large price moves
- This makes the "afternoon wall failure" pattern in `<gex_at_expiry>` more frequent and more extreme than historical norms implied

**Sources to find:** SpotGamma research on 0DTE growth, CBOE data on daily options volume by expiration, Nomura/Barclays equity vol research from 2022-2024 on 0DTE structural impact. JPMorgan has published on this topic.

---

### 3. Post-Event IV Crush and VEX Flows

**What's missing:** The current VEX section (in `<implied_order_book>`) explains how IV changes create dealer hedging flows. What's not covered is the specific event-driven scenario: IV crush after FOMC, CPI, earnings.

**Why it matters:** IV crush is a VEX event. When IV collapses after a scheduled event:
- OTM puts lose delta (become less negative as the distribution tightens)
- Dealers holding short puts (the standard case) have their delta unwind
- They must sell futures to rebalance
- This creates selling pressure even when the underlying event outcome is bullish

This is the partial mechanical explanation for the "sell the news" pattern. Rule 17 documents the positive vanna / declining VIX structural drift, but it covers the gentle, continuous version. The event-specific IV crush version is sharper and happens on a specific timeline (immediately after the announcement, as vols reset). Claude should understand:
- Why post-event rallies often fail or retrace intraday
- Why the direction of VEX flow on crush days depends on where large-OI strikes sit relative to spot (OTM vs ITM puts)
- The asymmetry: IV expansion events (VIX spike) and IV crush events have opposite VEX direction

**Sources to find:** SqueezeMetrics has written about this. Any derivatives research on "vanna flows post-FOMC" should cover the mechanics. Piper Sandler, Morgan Stanley derivatives research.

---

## Medium Priority

### 4. VIX Term Structure Shape → GEX/VEX Implications

**What's missing:** The tool already passes VIX, VIX1D, and VIX9D to the analyze endpoint. There's no framework in the prompt explaining what the *shape* of the VIX term structure implies mechanically.

**Why it matters:**
- **Normal contango** (VIX1D < VIX9D < VIX): Near-term vol is cheap relative to 30-day expectations. MMs are not anticipating an imminent spike. GEX regime is more durable.
- **Inverted near-term** (VIX1D > VIX9D ≈ VIX): The 0DTE tail is priced as unusually fat relative to longer-dated vol. This typically means large 0DTE put buying is happening — which raises GEX support but also means more VEX crash risk if those puts go ITM.
- **Full backwardation** (VIX1D > VIX > longer): Stress regime. Near-term demand for protection is overwhelming the market. Dealer hedging flows are concentrated in short-dated puts, VEX risk is high.

Understanding the curve shape gives Claude better context for interpreting why VIX1D is elevated relative to VIX — sometimes it's a minor event premium (harmless), sometimes it's structural put demand (meaningful for GEX/VEX).

**Sources to find:** VIX methodology white paper (CBOE). Research on VIX term structure regimes (there's extensive academic literature). SqueezeMetrics blog posts on VIX1D launch.

---

### 5. Put Skew as a Leading Indicator of GEX/VEX Risk

**What's missing:** Put skew (the premium of OTM puts relative to ATM options) reflects investor demand for downside protection. This demand directly determines the GEX/VEX profile — but the relationship isn't documented anywhere in the prompt.

**Why it matters:**
- **Steep put skew** → Heavy customer buying of OTM puts → Dealers short those puts → More GEX buy-limits below. BUT: more latent VEX sell-stops if a large move pushes those OTM puts toward ITM. High skew = more structural support AND more crash risk potential. They are the same position.
- **Flat put skew** → Fewer protective puts outstanding → Less GEX support below, but also fewer latent sell-stops. Lower crash risk potential.
- **Put skew rising during a rally** → Investors are buying protection while price moves up. If this is significant, it's worth noting because it's building the conditions for a future VEX flip.

Note: Chain data (per-strike IV, skew) currently lives in frontend state only and isn't passed to Claude in the analyze context. The conceptual framework is still worth adding — Claude can reason from verbal skew descriptions in the user's context or from what it knows about the current regime.

**Sources to find:** CBOE SKEW Index methodology. Any options research on skew and its predictive relationship to realized volatility and drawdowns. SqueezeMetrics or SpotGamma have likely addressed this.

---

## Lower Priority

### 6. The Weekly GEX Reset Cycle

**What's missing:** GEX is not constant through the week — it resets as options expire. Monthlies dominate early in the cycle, weekies dominate near expiry, 0DTE is always present on SPX M/W/F.

**Why it matters for Claude:** The `dowLabel` context field already passes the day of week. But without understanding the GEX cycle, Claude treats Monday and Thursday identically structurally. In practice:
- Monday-Tuesday: GEX often highest (fresh weekly options, monthly structure intact), suppression more reliable
- Wednesday: SPX Wednesday expiry removes a chunk of GEX from the book
- Thursday: GEX typically lower than Monday, Periscope walls less sticky
- Friday: Monthly expiry (on opex Friday) causes large GEX rolloff; non-opex Friday has weekly rolloff. Both create structural loosening into close.

**Sources to find:** SpotGamma publishes weekly GEX analysis. CBOE expiration calendar data.

---

### 7. SPX vs SPY Dual-Market GEX Structure

**What's missing:** GEX calculations that include both SPX and SPY OI slightly misstate the true hedging pressure because the two products have different settlement mechanics (European/cash-settled SPX vs American/equity-settled SPY).

**Why it matters:** Mostly a precision issue rather than a directional one. The key practical point: SPY OI generates hedging in SPY shares, not SPX futures. Since SPY and SPX are highly correlated but not identical, large SPY GEX at a given dollar-equivalent level produces slightly different hedging behavior than the same SPX GEX. Claude doesn't currently distinguish between SPX-sourced and SPY-sourced walls.

**Sources to find:** This is relatively well-documented in any primer on European vs American options and settlement mechanics. Less critical than the others — probably a short footnote rather than a full section.

---

## Notes on Implementation

When adding sections, maintain the existing structure:
- Named XML-style sections within `<market_mechanics_framework>`
- Each section follows: concept → mechanism → practical implication
- "Connecting to Practice" section at the end should be updated to reference any new rules/heuristics the new sections explain

Charm should be inserted into or adjacent to `<gex_at_expiry>` since it directly explains the pin and afternoon wall dynamics already documented there.

The 0DTE regime shift could be a standalone section or an addendum to `<gex_at_expiry>`.

VIX term structure and put skew are better as additions to `<connecting_to_practice>` than as standalone sections, since they're more interpretive than mechanically foundational.
