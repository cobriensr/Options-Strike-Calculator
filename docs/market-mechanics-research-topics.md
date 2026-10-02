# Market Mechanics Research Topics

## Future additions to `api/_lib/market-mechanics.ts`

These are gaps in the current Claude analyze prompt's foundational market mechanics framework — areas where the theory is either missing, underexplained, or disconnected from the practical rules Claude applies. Ordered by estimated impact on daily analysis quality.

---

## High Priority

### 1. Charm Flows — The Pin Effect's Actual Mechanism

**What's missing:** Charm is ∂delta/∂time — how a position's delta changes purely from time passing, with price and IV constant. The current `<gex_at_expiry>` section describes the _outcome_ of the pin (oscillation, hedging reversals at high-OI strikes) without naming or explaining the mechanism that drives it.

**Why it matters:** On positive-GEX days, charm causes dealers to systematically unwind hedges as 0DTE options decay toward expiry. This creates predictable intraday drift toward high-OI strikes — not random walk, but mechanically determined drift. Understanding charm would let Claude reason correctly about:

- Why price gravitates toward large OI strikes in the afternoon
- Why the pin holds more reliably on high-GEX days (charm reinforces GEX)
- Why the morning Periscope walls lose suppression power into the close (charm-driven delta unwind changes dealer exposure)

**Sources to find:** ORATS, VolResearch, or SqueezeMetrics have covered charm in the context of 0DTE. Any academic paper on the Greeks beyond delta/gamma (e.g., "higher-order Greeks in practice") would cover the mechanics.

**Reviewed:** Amaya et al. (2025) — see [Sources Reviewed](#sources-reviewed) below. Informs charm sizing (charm vs. the gamma hedge per minute, by distance from strike and time left), but does not test pinning or drift directly — it measures variance only.

---

### 2. The 0DTE Volume Regime Shift

**What's missing:** The GEX framework was developed when weekly and monthly expirations dominated SPX volume. By 2024, 0DTE represents ~40-50% of daily SPX options volume. This has changed the intraday GEX landscape in ways the current framework doesn't acknowledge.

**Why it matters:** Claude currently treats the 9:30 AM GEX snapshot as a reasonably durable guide to the day's structure. In the current market, it isn't. A large portion of outstanding OI expires same-day, so the gamma distribution reshapes continuously throughout the session. Specifically:

- AM GEX is heavily influenced by 0DTE OI that didn't exist at yesterday's close
- 0DTE gamma spikes rapidly (especially for near-ATM strikes) through the session
- The PM GEX picture can look radically different from the AM snapshot even without large price moves
- This makes the "afternoon wall failure" pattern in `<gex_at_expiry>` more frequent and more extreme than historical norms implied

**Sources to find:** SpotGamma research on 0DTE growth, CBOE data on daily options volume by expiration, Nomura/Barclays equity vol research from 2022-2024 on 0DTE structural impact. JPMorgan has published on this topic.

**Reviewed:** Amaya et al. (2025) — see [Sources Reviewed](#sources-reviewed) below. Supplies 2020–23 volume shares (0DTE ≈ 34.8% of SPX/SPXW volume) and how often MM gamma is negative (intraday on at least half of days after Tue/Thu expiries launched in May 2022).

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

**What's missing:** The tool already passes VIX, VIX1D, and VIX9D to the analyze endpoint. There's no framework in the prompt explaining what the _shape_ of the VIX term structure implies mechanically.

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

## Sources Reviewed

### Amaya, Garcia-Ares, Pearson & Vasquez (2025) — "0DTE Index Options and Market Volatility: How Large is Their Impact?"

Working paper dated 2025-01-25 (academic, not a Cboe publication; Cboe supplied the trade data). Not stored in the repo.

**Data:** Every SPX/SPXW trade from Jan 2020 to Jun 2023 from Cboe (442.6M trade records), each tagged with trader capacity (customer / market maker / firm / professional customer / broker-dealer). SPX trades only on Cboe, so this covers the whole market. Algoseek minute-bar BBO quotes for IV.

**Method:**

- MM net position per series per minute = cumulative MM buys minus sells since the series' inception. No sign convention is guessed — this is the "actual MM inventory" approach, vs. naive OI-based GEX.
- BSM gamma from minute-mid IV × position × 100, summed over all series. Analysis starts July 2020 to limit error from inventory that predates the Jan 2020 data.
- Two variance models, fit monthly on one-minute ES returns: an intraday GARCH (Engle–Sokalska daily and diurnal components plus a MIDAS lagged-gamma term) and a linear squared-return model with date and hour fixed effects.
- Counterfactual: re-simulate with the gamma coefficients set to zero and compare realized vol.

**Findings:**

- 0DTE ≈ 34.8% of SPX/SPXW volume on the average day (2020–23). Customer↔MM trades ≈ 68.7% of all volume.
- In 0DTE, customers bought 17.15% and sold 15.99% of total SPX/SPXW volume — slight net buyers by contract count (not gamma-weighted).
- MM aggregate gamma (all expiries) is usually positive, but negative at some point on ≥25% of days in the full sample. After the Tue/Thu expiries launched (May 2022) the median daily minimum is negative (−45.0), so gamma goes negative intraday on at least half of days. Mean daily-mean gamma fell from 408.8 to 234.2 (paper's scaled units).
- The gamma coefficient is negative in both models (more MM gamma → lower next-minute variance). Average LR stats 8.94 / 9.09 vs. the χ²(2) 5% critical value of 5.99 — moderate evidence. The effect is concentrated in the first one-minute lag.
- Impact (GARCH): mean −0.19 pp on annualized daily vol, −0.17 pp on 30-min vol. Max **+3.32 pp daily, +6.42 pp 30-min** (the 30-min 99th percentile is only +2.01). Linear-model maxima +3.18 / +7.00. The text says the impact is positive on 10% of days and windows; Table 5's 75th percentiles (+0.20 / +0.22 pp) are also positive, so it is positive more often than that, but small.
- Benchmarks: SD of daily changes in annualized realized vol = 4.5 pp; changes > 3 pp happen on ~20% of days. 30-min changes range from −52.2 to +63.4 pp (1st/99th percentiles −11.6 / +14.2). The authors conclude the max gamma effect is "not large."

**Erratum — appendix Fig. A1 units:** The paper sets the one-minute move to dS = σ√dt instead of σ·S·√dt, which understates Γ·dS by a factor of S (= 100). Its claim that the charm and speed terms are each larger than the Γ·dS term is an artifact of that slip. Corrected, at the paper's own parameters (K = 100, σ = 40%, r = 4%, 6.75h left, strike 1% OTM), charm per minute ≈ 2.3% of a 1-sd gamma hedge. The identity charm + ½σ²S²·speed = −(σ² + r)·S·Γ holds (checked numerically), so the time-drift terms nearly cancel in expectation **only when realized vol ≈ implied**. When price sits still, charm is uncancelled.

**Charm-to-gamma ratio at realistic vol:** Per minute, |charm·dt| / (Γ·σ·S·√dt) ≈ |ln(S/K)|·√dt / (2·σ·τ). It scales with distance from the strike and inversely with IV × time left, so for a fixed strike it doubles each time the remaining time halves. Fixed-strike view at σ = 15% (r = 4%, calendar-time annualization as in the paper; superseded by the per-sd table below):

| Strike OTM | 6.5h | 3h   | 1h  | 30m | 15m  |
| ---------- | ---- | ---- | --- | --- | ---- |
| 0.25%      | 1.6% | 3.4% | 10% | 20% | 40%  |
| 0.5%       | 3.1% | 6.8% | 20% | 40% | 81%  |
| 1%         | 6.3% | 14%  | 41% | 81% | 162% |

Correction: that table holds the strike fixed, which misleads. Read by distance in standard deviations of the remaining move, k = |ln(S/K)| / (σ√τ), the ratio ≈ k/2 · √(1 min ÷ time left), independent of IV and of the time convention. Exact Black-Scholes values (same r and convention, at σ = 15%; σ = 30% matches to within 0.1 point):

| Distance | Open (6.5h) | 1h    | 30m   | 15m   |
| -------- | ----------- | ----- | ----- | ----- |
| k = 1 sd | 2.6%        | 6.5%  | 9.2%  | 12.9% |
| k = 2 sd | 5.1%        | 12.9% | 18.3% | 25.8% |

A fixed strike's ratio climbs faster only because it drifts further out in sd terms as time runs down. The 0.5%-OTM strike at 15% IV, for example, is about 6 sd out with 15 minutes left (calendar-time convention) and carries essentially no hedge — so the fixed-strike table overstates charm's late-day share at the strikes that matter. Charm's late-session importance comes from its absolute size growing ~1/τ while the gamma hedge grows ~1/√τ, and from being one-directional.

Convention: the paper and both tables use calendar time (525,600 min/yr). VIX1D uses business time (102,060 min/yr), so the same quoted IV means a wider sd-distance in calendar terms (the 0.5%-OTM strike above is about 2.8 sd out with 15 minutes left in business time, vs. about 6.3 sd in calendar time).

<details>
<summary>Reproduction (Python)</summary>

```python
import math

n = lambda x: math.exp(-x * x / 2) / math.sqrt(2 * math.pi)
r, dt = 0.04, 1 / (60 * 24 * 365)  # calendar-year units, as in the paper

def greeks(S, K, sig, hrs):  # returns gamma, speed, charm
    tau = hrs / (24 * 365); s = sig * math.sqrt(tau)
    d1 = (math.log(S / K) + (r + sig**2 / 2) * tau) / s; d2 = d1 - s
    g = n(d1) / (S * s)
    return g, -g / S * (d1 / s + 1), -n(d1) * (2 * r * tau - d2 * s) / (2 * tau * s)

# Fig. A1 point: K=100, sigma=40%, 6.75h left, strike 1% OTM (S=99)
S, sig = 99.0, 0.40
g, sp, ch = greeks(S, 100.0, sig, 6.75)
print(abs(ch * dt) / (g * sig * S * math.sqrt(dt)))         # ~0.023; paper's dS=sig*sqrt(dt) drops the S
print(ch + 0.5 * sig**2 * S**2 * sp + (sig**2 + r) * S * g)  # identity residual ~0

# Charm/gamma ratio at sigma=15%: exact vs |ln(S/K)|*sqrt(dt)/(2*sig*tau)
for otm in (0.0025, 0.005, 0.01):
    S = 100 * (1 - otm)
    for h in (6.5, 3, 1, 0.5, 0.25):
        g, _, ch = greeks(S, 100.0, 0.15, h)
        approx = abs(math.log(S / 100)) * math.sqrt(dt) / (2 * 0.15 * h / (24 * 365))
        print(f"{otm:.2%} {h:>4}h  {abs(ch * dt) / (g * 0.15 * S * math.sqrt(dt)):6.1%}  {approx:6.1%}")

# Per-sd view: strike k sd of the remaining move above spot, k = |ln(S/K)| / (sig*sqrt(tau))
# (call OTM; with no dividends a put has the same gamma and charm). Exact vs k/2*sqrt(1 min / time left)
for k in (1, 2):
    for h in (6.5, 1, 0.5, 0.25):
        tau = h / (24 * 365); sig = 0.15
        S = 100 * math.exp(-k * sig * math.sqrt(tau))
        g, _, ch = greeks(S, 100.0, sig, h)
        exact = abs(ch * dt) / (g * sig * S * math.sqrt(dt))
        print(k, h, round(exact, 4), round(k / 2 * math.sqrt(1 / (h * 60)), 4))

# 0.5% OTM at 15% IV with 15 min left: sd-distance in calendar vs business time (min/yr)
for mins_per_year in (525_600, 102_060):
    print(mins_per_year, round(math.log(1 / 0.995) / (0.15 * math.sqrt(15 / mins_per_year)), 2))
```

</details>

**Takeaways for this repo:**

1. Dealer hedging as a _cause_ of volatility is small; much of GEX's predictive value is as a regime label. Consistent with our range-model Phase 1 v2 result that VIX1D already captures expected range and gamma adds ~nothing out of sample (`docs/tmp/expected-range-phase1v2-2026-05-29.md`, local and gitignored).
2. Charm is a one-directional drift that grows into the close and matters most on quiet tapes. Minute to minute, the gamma hedge stays larger at every strike that still carries hedge (about 13% at 1 sd with 15 minutes left); charm's weight comes from accumulating in one direction.
3. Negative MM gamma intraday is the common case post-2022, not a rare one.
4. Capacity-tagged inventory reconstruction is the gold standard for MM gamma — supports preferring MM-attributed (Periscope) over naive OI-based GEX.

**Caveats:**

- Working draft with internal inconsistencies: Table 1 caption numbers don't match the table body; the linear-model mean of −2.1 pp is described as "similar" to the GARCH −0.19 pp; two sections are numbered 6.
- Gamma enters as one aggregate number, so strike-local effects (amplifier pockets, pinning) can't show up.
- Sample ends June 2023.
- Assumes full, prompt delta-hedging in ES.

---

## Notes on Implementation

When adding sections, maintain the existing structure:

- Named XML-style sections within `<market_mechanics_framework>`
- Each section follows: concept → mechanism → practical implication
- "Connecting to Practice" section at the end should be updated to reference any new rules/heuristics the new sections explain

Charm should be inserted into or adjacent to `<gex_at_expiry>` since it directly explains the pin and afternoon wall dynamics already documented there.

The 0DTE regime shift could be a standalone section or an addendum to `<gex_at_expiry>`.

VIX term structure and put skew are better as additions to `<connecting_to_practice>` than as standalone sections, since they're more interpretive than mechanically foundational.
