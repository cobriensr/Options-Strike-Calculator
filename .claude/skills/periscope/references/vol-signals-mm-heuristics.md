# VolSignals MM Heuristics — Companion Reference

**Status:** Populated (~42 distilled heuristics across 7 sections, sourced from 21 transcripts).
**Source:** YouTube channel [@VolSignals](https://www.youtube.com/@VolSignals) (Imran Lakha + prior-MM contributors, ex-Goldman SPX desk perspective).
**Purpose:** Encode former-MM heuristics about how dealer desks _actually_ hedge SPX/SPY/QQQ flows, so Periscope reads can move from "what the bars show" → "what the desk on the other side is forced to do next."

This file is **read on demand** by the `periscope` skill — it is NOT auto-loaded with the skill body. Cite this file from `SKILL.md` only when a heuristic here is load-bearing for a specific read.

---

## Verification convention

Each heuristic is tagged with a confidence flag. The user is the source of truth — VolSignals framing is informative but not gospel.

- **`[verified]`** — Confirmed via contract specs / first-principles math, not just Imran's word.
- **`[plausible]`** — Imran's framing is internally consistent and aligns with public dealer-flow research, but not yet validated on this trader's setup.
- **`[era-specific]`** — May reflect pre-2022 or 2024-low-VIX desk practice. Flag whenever cited.
- **`[contested]`** — Conflicts with another trusted source or with Periscope mechanics as written in `SKILL.md`. Surface explicitly before applying.

When citing a heuristic in a Periscope read, include the tag in parentheses, e.g. _"Imran's anti-pin rule at customer-long puts [contested]."_

---

## Section 1 — Dealer hedging mechanics

### SPX→ES hedge ratio is 2× (per delta) [verified]

**Source:** 9.md (Dealer Hedging Basics) | 19.md, 20.md (collar applications) | quote-keyword: "2x ratio" / "100 puts → 200 futures"
**Mechanic:** SPX option multiplier is 100, ES future multiplier is 50. To hedge an SPX option delta with E-minis you double the SPX delta. A 100-lot risk reversal at 34Δ = 3,400 SPX delta = 68 ES futures. A 100-lot 100Δ short put = 200 short ES futures.
**Implication:** Every SPX delta exposure dealers carry translates 1:2 into ES order flow. Sizable SPX prints at the open should produce 2× notional ES hedging within seconds. Big single-strike OI clusters (JPM collar at 35K contracts → ~70K futures hedge) signal large mechanical flow at expiration.
**Periscope mapping:** n/a directly, but sets the magnitude of futures hedge bursts after big risk-reversal prints.

### Dynamic hedge — not the initial print — moves the tape [plausible]

**Source:** 9.md (initial trade absorbed) | 7.md (sell options → sell futures, then dynamic) | quote-keyword: "tells you about the future instead of the past"
**Mechanic:** The futures sale tied to the option print is absorbed at execution. The market-relevant flow is the subsequent dynamic re-hedging driven by gamma and charm on the residual book.
**Implication:** Tape-reading the initial print is past-looking. Positioning maps (Periscope) are forward-looking because they predict the re-hedge schedule.
**Periscope mapping:** Periscope's per-strike gamma/charm bars are the dynamic-hedge predictor. Use a single huge UW flow alert at strike X less than the resulting bar at strike X on Periscope after the position settles into the next 10-min slice.

### Long-call / short-put risk-reversal is the structural dealer book [plausible]

**Source:** 9.md, 11.md (long calls + short puts hedged with short ES) | 19.md (vol-drop math)
**Mechanic:** Real-money is structurally long equity and buys puts / sells calls (~20–25Δ each side) to hedge. Dealers are the natural counterparty: short puts, long calls, short ES against it. 100 of a 20Δ-call/20Δ-put risk reversal = ~80 short futures.
**Implication:** Persistent dealer book bias is short-downside-put / long-upside-call. Downside is an "accelerant" zone (short gamma builds fast on selloff); upside has more passive supply. Anything that REDUCES this short-futures hedge (charm decay, vol drop, expiry) is mechanically bullish for ES.
**Periscope mapping:** Expect the standing positions panel to show net long calls clustered above spot and net short puts clustered below — the asymmetric "fence" around price.

### Long-gamma absorbs; short-gamma chases [plausible]

**Source:** 3.md, 7.md, 8.md, 13.md (multi-source consensus) | quote-keyword: "racing you to the book" / "shadow order book"
**Mechanic:** In positive-gamma zones MMs sell rallies / buy dips to stay neutral, supplying liquidity (deep "ghost" book absorbing flow). In negative-gamma zones MMs buy rallies / sell dips, removing liquidity and amplifying moves. Same headline produces a shallow dip in green zone, cascading sell in red zone.
**Implication:** Stop placement and option pricing should both reset at the gamma sign-flip line. Long-gamma walls compress range; they don't reverse price — expect deceleration into a wall, not rejection. Wait for a probe through the wall before trading reversal.
**Periscope mapping:** Tall positive (long-gamma) bars = compression zone; price decelerates as it approaches. Negative net-gamma strikes near spot = expect through-prints and trend continuation.

### Net-MM positions are the only ones that matter [plausible]

**Source:** 10.md (The Landscape) | quote-keyword: "tip of the iceberg because this is the net hedgeable position"
**Mechanic:** When MM-vs-MM trades happen, both sides hedge dynamically and the position cancels for hedging-flow purposes. Only the net imbalance held by entities running a hedge book ("market maker" tag, sometimes "firm") drives predictive flow.
**Implication:** A massive OI cluster can be hedging-irrelevant if it's MM-vs-MM. Conversely, a smaller customer-vs-MM cluster can dominate intraday.
**Periscope mapping:** Periscope shows MM net by default. When a strike is conspicuously absent from the histogram despite huge OI elsewhere, that's the netting at work, not a data gap.

### Naive GEX is structurally wrong because it can't tell spreads from outright [plausible]

**Source:** 8.md | quote-keyword: "if I sell a put spread … you doubled the actual exposure"
**Mechanic:** Open-interest-based GEX assumes MM is short puts / long calls and double-counts both legs of any customer spread. A sold put spread shows up in naive models as "two puts sold" when its real Greek footprint is near-zero in time-far tenors.
**Implication:** Any chart sourcing GEX from raw OI overstates dealer gamma at strike clusters where customer spreads dominate. Trust UW's MM-attributed Net GEX (heat maps) over naive OI-derived overlays.
**Periscope mapping:** This justifies the project's choice to OCR the heat maps for MM-attributed values rather than computing locally from `ws_gex_strike_expiry` (naive).

### Long-dated regime sets the floor; 0DTE overlays it [plausible]

**Source:** 2.md | quote-keyword: "transient effect that overlays"
**Mechanic:** The visible gamma profile is an additive sum of (a) a stable "regime" gamma from options >1d–3m and (b) a transient "local" gamma from 0DTE. Once 0DTE expires, the 0DTE contribution disappears and price reverts to regime behavior.
**Implication:** A green 0DTE pocket inside a red regime gives temporary stability; expect MM passive support to vanish at/after PM settle, with reversion toward regime tendency.
**Periscope mapping:** Treat single-day Periscope dot/charm clusters as transient; cross-check against multi-expiry positioning for the underlying regime before sizing trend bets.

### Above-spot green calls + below-spot red puts = bullish drift cluster [plausible]

**Source:** 6.md | quote-keyword: "long calls, short futures and also importantly short puts"
**Mechanic:** Dealer long calls above (sold short futures against opening) + dealer short puts below (sold short futures against opening). Both legs require dealers to BUY futures back as charm decays the deltas through the day.
**Implication:** Buyable dips with mechanical tailwind; "exhaustion" target = center of the long-call cluster. Cut if price closes below the largest red put strike (downside threshold).
**Periscope mapping:** Green call cluster above + red put cluster below = "green flag." Largest red put = stop-out level; center of green call cluster = drift target.

### Short-gamma at a strike = liquidity withdrawal, not provision [plausible]

**Source:** 11.md, 20.md | quote-keyword: "racing you and I" / "8 minis deep"
**Mechanic:** When spot is near a dealer short option, dealers go from passive liquidity providers to liquidity TAKERS — they race retail/algos to hedge first. Book depth collapses (~"8 minis deep" first 4 levels per Aug 2024).
**Implication:** Erratic 200-pt 30-min moves; stop-loss orders hit air. Position sizing must shrink near these strikes.
**Periscope mapping:** Tall red gamma bar at the strike; thin order-book in DOM; expect overshoots in either direction.

### Falling IV pumps gamma in a long-options regime [plausible]

**Source:** 3.md | quote-keyword: "as implied vol came down… gamma of the options increased"
**Mechanic:** Lower IV concentrates each option's gamma at-the-money. When dealers are net long options, vol-down compounds the long-gamma stabilization in a reflexive feedback loop (vol drop → bigger dealer gamma → tighter ranges → more vol-selling → more vol drop).
**Implication:** Expect summer-lull regime persistence once it starts. Range compression deepens day-over-day during low-VIX stretches.
**Periscope mapping:** Watch for green Gamma bars to deepen day-over-day during low-VIX stretches even without new positioning.

---

## Section 2 — Charm / vanna behavior

### Charm only matters near expiration [plausible]

**Source:** 9.md | quote-keyword: "you almost never hear me talk about charm with longer dated"
**Mechanic:** A 1-day time spread on a 30+ DTE OTM call shows tiny delta differential. 0DTE charm has to decay the entire 34-delta inception hedge across a single session.
**Implication:** Charm-driven flows are a 0DTE-specific phenomenon. Charm panels should be read as today's-expiry-only.
**Periscope mapping:** Always confirm Periscope chart Date == 0DTE expiry; charm bars from later expiries are noise relative to the intraday hedge.

### Charm becomes meaningful after ~1:30 PM ET (12:30 CT) [plausible]

**Source:** 8.md | quote-keyword: "1:30 to three is probably a good time to start looking at charm"
**Mechanic:** Charm exposure scales with t-decay rate; in the morning the per-5-minute charm number is small. It accelerates into the back half of the session.
**Implication:** Pre-12:30 CT, charm panel is informational only; intraday-tradable signal kicks in after 12:30 CT (1:30 ET) and dominates 1:00–3:00 CT close window.
**Periscope mapping:** Time-gate any charm-driven thesis to >12:30 CT; before that, gamma walls dominate.

### Charm sign = passive bid vs. passive offer [plausible]

**Source:** 14.md, 8.md | quote-keyword: "passive bid or a passive offer"
**Mechanic:** Orange charm zone = MM position drifting more negative-delta with time → passive futures buying. Blue charm zone = MM drifting longer-delta with time → passive futures selling. The sign is unintuitive: positive charm bar is bearish pressure.
**Implication:** Direction prediction independent of news: orange under spot supports drifts higher; blue above spot caps rallies. Effect compounds in low-volume tape where mechanical flow dominates.
**Periscope mapping:** Read Periscope charm bars as time-decay flow: orange below spot = passive bid into close; blue above spot = passive offer.

### Charm into dealer-LONG strikes = pin glide; into dealer-SHORT strikes = anti-pin (repulsion) [plausible]

**Source:** 5.md, 12.md, 20.md (multi-source) | quote-keyword: "marionette" / "two magnets in the same pole"
**Mechanic:** At a dealer LONG option, time decay drops |Δ| → dealer must rebalance toward the strike (BUY back hedge below, SELL more above) → price ATTRACTED. At a dealer SHORT option, time decay shrinks |Δ| → dealer must hedge AWAY from the strike → price REPELLED.
**Implication:** Trade structure should match polarity. Long-gamma strikes = symmetric fly with body at the magnet. Short-strike anti-pins = directional bet through them.
**Periscope mapping:** Largest green Gamma/Positions bar near spot in the final 1–2 hours = pin candidate. Charm sign tells you which direction the residual flow tilts. Tall red position bar = anti-pin (repulsion).

### Vanna concentrated at 15–25Δ wings; vanishes ATM [plausible]

**Source:** 11.md | quote-keyword: "20 delta points on the curve" / "you're back on the straddle"
**Mechanic:** Vanna (dδ/dσ) is maximal at ~20Δ wings. Inside 35–65Δ ("straddle"), Δ ≈ 50 regardless of σ → no vanna hedging needed. Beyond ~10Δ, vega is too small to matter unless the V move is huge.
**Implication:** Vanna-driven mechanical rallies/sells run hardest while spot sits BETWEEN the dealer's 20Δ short put and 20Δ long call. They decelerate as spot enters the at-the-money zone — a vol crush near the call no longer produces buy-to-cover flow. Take vanna-rally profits as spot enters the ATM zone.
**Periscope mapping:** Charm/vanna histograms peak in the 1–1.5σ wing strikes; flat through ATM.

### Vol DROP with risk-reversal book = forced ES BUYING [plausible]

**Source:** 19.md, 9.md, 21.md | quote-keyword: "20 million Vegas supplied" / "delivers more of a hedge"
**Mechanic:** Dealer long-call/short-put book; vol drop shrinks the distribution → both wing options' |Δ| fall. Long call goes 20Δ → 15Δ (need to cover short futures); short put goes -20Δ → -15Δ (also need to cover short futures). Both legs say BUY ES.
**Implication:** Big quarterly vol crushes (e.g. JPM collar re-strike days) supply 10s of millions of vegas to dealers and trigger 1–3% mechanical rallies.
**Periscope mapping:** Bright blue vanna bars across both wings; charm panel reinforcing same direction. IV term-structure flattening intraday is the trigger.

### Vol SPIKE inverts vanna — supportive flows become offer [plausible]

**Source:** 11.md, 9.md | quote-keyword: "exactly the opposite"
**Mechanic:** When V rips (e.g. Aug 5 2024 VIX 66), the same dealer book that buys ES on a vol drop must SELL ES on a vol rip — the wings' |Δ| expand toward 50, deltas migrate toward straddle, dealers are now short too FEW futures, sell more. Compounded by collapsed liquidity.
**Implication:** "Supportive vanna" disappears in vol shocks; sell-flow can require 10,000s of futures. **A vol spike alone (no spot move) forces dealer ES selling — a self-reinforcing feedback into a selloff.**
**Periscope mapping:** When VIX is in fast mode, do NOT treat blue (charm-buy) bars as bullish — vanna can dominate and flip sign on an IV move alone. Cross-check VIX positioning regime before sizing SPX 0DTE.

### Skew = vanna proxy; falling skew before vol normalizes = vanna rip gone [plausible]

**Source:** 16.md | quote-keyword: "skew equals Vanna"
**Mechanic:** Customer risk-reversal leaves MMs short put/long call at the highest-vanna strikes. As spot sells off, those strikes drift to higher delta and lose vanna; MM repositions, lowering skew.
**Implication:** A skew drop coinciding with a still-elevated VIX signals the normal vol-crush vanna rip is unavailable — bounces will be shallower than the 2018/2020 playbook implies.
**Periscope mapping:** If macro skew is fading while spot still drips, deprioritize "vol-crush bounce" setups; treat upside as muted even on green-VIX prints.

### High-VIX (>16) regime kills strict pin behavior [era-specific]

**Source:** 8.md | quote-keyword: "over a VIX of like 16 shouldn't be expecting" [strict pins]
**Mechanic:** In 2024 sub-VIX-16 regime, MM pin-hedging compressed price into 5-pt fly targets near close. Post-Aug-2024 regime shift to higher vol disrupts that — straddle is too wide to allow tight pinning.
**Implication:** Don't treat high-charm strikes as pin targets when VIX > 16. The hedging force is there but the realized vol overwhelms it on the day.
**Periscope mapping:** Cross-check VIX before sizing a charm-pin trade; high-VIX day → use peak-charm strike as a magnet, not a target.

### Theta time is event-compressed, not linear [plausible]

**Source:** 1.md | quote-keyword: "vault time" / "compressed amount of time"
**Mechanic:** MM models freeze (or slow) decay until an event releases, then discretely subtract the event's variance bucket. The 0DTE straddle can climb into 8:25 ET, then collapse 8:35 ET on NFP/CPI/FOMC.
**Implication:** Pre-event "vol pop" is not mispricing — it's the model holding event variance. Post-release the discrete decay forces a one-shot vanna/charm hedge unwind.
**Periscope mapping:** Expect a step-function in charm/vanna bars around scheduled releases; a pre-release bar is not a tradeable signal.

---

## Section 3 — 0DTE flow attribution

### 0DTE is ~60% of SPX option volume [plausible]

**Source:** 1.md | quote-keyword: "60% literally 60%"
**Mechanic:** Imran's last-checked figure for 0DTE share of SPX volume.
**Implication:** Same-day gamma/charm dominates the dealer book; longer-dated dealer positioning is a smaller force in intraday tape.
**Periscope mapping:** 0DTE expiry views are the right default; multi-expiry composites dilute the actionable signal.

### Variable theta clock — fast at open/close, slow at lunch [plausible]

**Source:** 1.md | quote-keyword: "variance weighted time" / "everybody's literally at lunch"
**Mechanic:** MM models decay the straddle on a volume/variance-weighted clock — fast in the first/last 30 minutes, slow midday. Last 10 minutes can squeeze $3–5 of straddle premium out.
**Implication:** Charm flow accelerates into the close; midday drift is structurally weaker. Last-30-minute price action is amplified by the discrete tail of the decay.
**Periscope mapping:** Charm panel intensity should be read time-of-day weighted — magnitude near 14:30 CT is meaningfully larger than the same nominal value at 11:30 CT.

### 0DTE has a shot clock — flows are required, not discretionary [plausible]

**Source:** 5.md, 14.md | quote-keyword: "These positions have a shot clock" / "shot clock at 4 p.m."
**Mechanic:** Settlement risk forces dealers to hedge to flat by 4pm ET regardless of view. Every 0DTE option resolves to a binary delta state. Unlike longer-dated, there's no "wait it out" option.
**Implication:** Late-day 0DTE flows are the highest-confidence prediction surface available — they MUST happen.
**Periscope mapping:** 0DTE chart in final 90 minutes carries far more signal than the same chart at 10 AM.

### 0DTE position grows nonlinearly into close (gamma scales as √(1/t)) [plausible]

**Source:** 10.md | quote-keyword: "the same two contracts… will have so much more gamma… and therefore hedgeible influence"
**Mechanic:** Per-contract gamma of an ATM option grows as √(1/t) into expiry. The same 0DTE OI footprint that was inert at 10:00 CT becomes the dominant hedging force by 2:30 CT.
**Implication:** Re-read the Periscope chart in the afternoon — the morning's "background" levels become the afternoon's "hard" levels.
**Periscope mapping:** Don't trade off a 9:30 CT snapshot in the afternoon. Refresh.

### Same-day SPXW = "shifting sand above foundation underneath" [plausible]

**Source:** 10.md | quote-keyword: "shifting sand above… foundation underneath"
**Mechanic:** Imran splits 0DTE inventory into (a) carry-from-prior-days "stable" foundation expected to remain into close, and (b) intraday-opened customer flow expected to be closed if price runs through it.
**Implication:** A bar visible at 9:30 CT carries different meaning than a bar that materialized at 12:00 CT — the former is durable, the latter is fragile.
**Periscope mapping:** When comparing morning vs. midday Periscope snapshots, treat newly-appeared bars as conditional (will roll/close on touch); persistent bars as load-bearing levels.

### Customer-side ≈ inverse of MM panel [plausible]

**Source:** 10.md | quote-keyword: "very much just the opposite of market maker position"
**Mechanic:** Across the 5 entity tags (MM, broker-dealer, firm, customer, pro-customer), MM net is approximately the negative of customer + pro-customer net.
**Implication:** You can read Periscope's MM bars as a direct proxy for "what customers want to happen."
**Periscope mapping:** Tall short-MM-call bar above spot = customer long calls there → customer wants the rally. Use sign-flipping as a sanity check.

### JPM hedged-equity collar trades under "customer" tag, not "firm" [plausible]

**Source:** 10.md | quote-keyword: "JP Morgan hedge equity fund… not even a professional customer"
**Mechanic:** The largest known structural collar in SPX prints under the plain customer tag. Quarterly resets (end of March/June/Sept/Dec) trade through this account.
**Implication:** Quarter-end expiration profiles will show outsized customer-tag concentration at the JPM collar strikes (~10% OTM put long, ~5% OTM call short). These are not customer "speculation" — they are a hedge book and behave as durable.
**Periscope mapping:** Recognize quarter-end customer concentrations as institutional hedge, not retail flow. Don't expect them to roll on touch.

---

## Section 4 — EoD dynamics & MOC mechanics

### Long-gamma + charm above call cluster = supportive grind [plausible]

**Source:** 9.md | quote-keyword: "marionette market"
**Mechanic:** Above the OTM-call cluster (dealers long calls), gamma hedge sells futures on rallies, but charm decays the same call deltas back, forcing buy-back of those futures. Net effect: temporal redistribution of buy flow without permanent absorption.
**Implication:** A range above the call cluster grinds higher as charm slowly returns the gamma-sold futures. Selloffs in this zone tend to fizzle.
**Periscope mapping:** Long-call dot cluster overhead + positive gamma bars + charm panel pointing up = expect supportive grind, not a fade.

### Below the put cluster: short-gamma drift produces zigzag, then accelerated selling [plausible]

**Source:** 9.md | quote-keyword: "buying was producing buying and selling was producing selling"
**Mechanic:** Below the dealer short-put strike, dealers are short gamma — must hit bids on the way down, lift offers on the way up. Produces erratic zigzag; passes through neutral; then upside hits long-gamma absorption.
**Implication:** Three regimes on Periscope: erratic zigzag (short-gamma below), inflection (zero-gamma), supportive grind (long-gamma above). Trading style must change at each boundary.
**Periscope mapping:** Sign-flip in the gamma bars marks the regime boundary; it should coincide with a visible character change in price action.

### Drift magnitude scales with futures-per-point exposure [plausible]

**Source:** 9.md | quote-keyword: "200 futures to sell" / "200 futures to buy"
**Mechanic:** In the long-gamma zone, +$1 SPX = ~200 ES futures to sell from MMs; in short-gamma below, +$1 = 200 to buy. Same nominal $1 move, opposite hedge sign.
**Implication:** The futures-per-point number on the exposure chart is a quantitative drift forecast, not just a sign.
**Periscope mapping:** Bar height in the gamma panel is the magnitude — taller = stronger expected drift/repulsion at that strike.

### All four post-strike scenarios re-center on a dominant LONG strike [plausible]

**Source:** 5.md | quote-keyword: "all roads lead to the same thing"
**Mechanic:** Spot above strike + gamma → sell futures down. Spot above + charm (ITM call → 100Δ) → sell down. Spot below + gamma → buy up. Spot below + charm (OTM call → 0Δ) → buy up. All four point at the strike.
**Implication:** When a single strike dominates the 0DTE positions chart, EoD bias is overwhelmingly toward that level regardless of which side spot is on entering the last hour.
**Periscope mapping:** Identify dominant green Positions strike on 0DTE chart; treat as terminal magnet for last 30–60 min.

### FOMC/event-day vol crush amplifies charm at max-gamma cluster [plausible]

**Source:** 12.md | quote-keyword: "all the charm associated with the immense amount of premium"
**Mechanic:** Post-announcement vol collapse releases trapped charm; spot is pulled toward the largest MM-long-gamma cluster (where MM eventually stabilizes the book).
**Implication:** Symmetric fly with body at the max-gamma strike is the convex expression — sells the fast-decaying magnet, buys cheap wings inside the repulsion zone.
**Periscope mapping:** On vol-event days, identify the strike with the largest MM-long bar inside the Periscope window — that's the fly body candidate.

### Charm-driven EoD pinning requires low-vol environment [era-specific]

**Source:** 8.md | quote-keyword: "we used to be able to like buy flies… and hit them routinely in 2024"
**Mechanic:** Charm flow tightens delta-neutral hedging into close, producing pin behavior at peak-charm strikes — but only when realized vol stays inside the straddle. 2024-era setup worked; 2025+ higher-vol setup breaks it more often.
**Implication:** EoD pin trades had ~positive expectancy in 2024 single-digit VIX; same trade is breakeven-or-worse at VIX > 16.
**Periscope mapping:** Use peak-charm strike as the EoD attractor only when VIX is sub-16; otherwise demote it to "directional bias" not "target."

### Last hour of VIX expiration (3–4 PM ET) shows position-closing flow [plausible]

**Source:** 11.md | quote-keyword: "3 to four"
**Mechanic:** On VIX expiry afternoons, desks unwinding VIX positions hedge into the close, generating SPX impact via vol-gamma-to-vanna transmission.
**Implication:** Treat 3–4 PM CT on VIX-expiry afternoons as elevated-move regime; expect erratic IV jumps that translate to SPX vanna flow.
**Periscope mapping:** Cross-check VIX-expiry calendar before sizing 0DTE in that window.

---

## Section 5 — Vol-shock & event-day behavior

### Vol-shock vanna sign-flip is the highest-stakes rule [plausible]

**Source:** 11.md, 9.md (cross-listed from §2 because it's also event-day-critical)
**Mechanic:** A vol expansion does NOT produce the same flow as a vol compression. The dealer risk-reversal book flips sign on which way it has to hedge once the wings' |Δ| starts migrating toward 50 (in a vol spike) vs. shrinking (in a vol drop).
**Implication:** August 5 2024 broke "supportive vanna flow" expectations — the same chart with the same bars produced opposite hedge demand because vol regime changed.
**Periscope mapping:** Always cross-check VIX gamma sign + cash VIX behavior before reading the vanna panel; the same vanna histogram can mean opposite things in fast-VIX vs contained-VIX.

### Risk-reversal book becomes more negative-delta as IV rises [plausible]

**Source:** 9.md | quote-keyword: "delivers more of a hedge when volatility goes up"
**Mechanic:** Customer risk-reversal has max vanna at the wing strikes. Vol spike → put delta grows in absolute terms, call delta shrinks → customer gets more downside hedge automatically; dealers get more positive delta and must sell more futures.
**Implication:** Self-reinforcing feedback into a selloff.
**Periscope mapping:** Vanna panel sign on vol expansion days predicts cascading futures sales; track it alongside VIX move, not just SPX move.

### Liquidity collapse during V spikes amplifies hedge impact [plausible]

**Source:** 11.md | quote-keyword: "8 minis deep"
**Mechanic:** When V spikes, ES book depth thins to single-digit minis at the top 4 levels. Same hedge requirement now has 5–10× the price impact.
**Implication:** Stop discipline is critical; expect slippage to balloon. Hedge "size" required is invariant but realized price move is non-linear.
**Periscope mapping:** Use external book-depth or VIX as gating signal; reduce trade size in fast-VIX regimes.

### Stable-regime fingerprint = lower VIX + lower VVIX + "sea of green" [plausible]

**Source:** 2.md | quote-keyword: "sea of green"
**Mechanic:** A wide span of green across the gamma gradient (multiple straddles wide) co-occurs with depressed VIX/VVIX — this is the regime fingerprint, not a coincidence.
**Implication:** Don't bet on vol expansion or trend extension while gradient is uniformly green; trend-following loses edge against MM long-gamma absorption.
**Periscope mapping:** Sanity-check Periscope setups against gradient breadth — if the broader regime is uniform green, suppress fade trades from "wide range" expectations.

### Big-position roll-off + Vega flip drives mechanical rebounds [plausible]

**Source:** 18.md, 19.md | quote-keyword: "JP Morgan rolled their collar… sold back a tremendous amount of Vega"
**Mechanic:** Major systematic positions (e.g. JPM collar at quarterly expiry) roll/expire = dealer Vega/gamma profile flips overnight. If the resulting position is long-Vega and vol drops, dealers must mechanically buy futures to hedge.
**Implication:** Mechanical rallies post-major-expiry can overwhelm bearish headlines for weeks. Don't fade purely on news; check whether the dealer profile actually supports the move.
**Periscope mapping:** n/a directly (longer-dated structure shift); flag quarterly-expiry calendar when interpreting the post-expiry tape.

### Quarter-end pension rebalance amplifies post-expiry mechanical rally [plausible]

**Source:** 19.md | quote-keyword: "price insensitive entities like pensions"
**Mechanic:** End-of-quarter rebalancing flow from pensions stacks on top of dealer hedge unwind after big quarterly collar resets. Both flows buy equities, mechanical and price-insensitive.
**Implication:** Post-quarterly-OPEX upside has TWO independent mechanical bids; structurally bullish bias for the few days after re-strike unless news intervenes.
**Periscope mapping:** Calendar-based confirmation; treat end-of-quarter weeks as bias-up.

### IV-below-RV regime inverts the sell-vol default [plausible]

**Source:** 4.md | quote-keyword: "blue line is actually underneath the orange line"
**Mechanic:** Implied 30d vol < realized 30d vol means options have negative risk premium. Normally options trade rich; when they don't, owning them is positive-EV.
**Implication:** When IV<RV regime, switch from premium-sell mode (credit spreads, condors) to premium-buy mode (long calls/puts, debit flies, equity replacement). Existing premium-sellers are getting underpriced.
**Periscope mapping:** Regime indicator, not chart-level. Cross-reference with the credit-spread vs debit-spread choice in `trade_types_recommended`.

### True negative-gamma regimes are rare; "feels short-gamma" usually isn't [plausible]

**Source:** 7.md, 10.md | quote-keyword: "the percentage of time that we're actually entrenched in a negative gamma range is very very small"
**Mechanic:** Most "negative gamma" days are actually long-gamma-but-less-than-yesterday. Real net-short MM gamma is the exception.
**Implication:** Do not default to the "negative gamma → momentum-extends" trade hypothesis. Verify on Periscope before sizing.
**Periscope mapping:** Check the aggregate gamma sign on the chart's gamma panel before assuming the regime is negative-gamma; differential matters more than absolute label.

### Crash days can be long-gamma-down with customer-driven flush [era-specific]

**Source:** 10.md (2018 example) | quote-keyword: "we were flush with gamma… long downside gamma especially"
**Mechanic:** UBS/Harvest's iron condor + short-put-write programs meant MMs were long puts as the index sold off — long downside gamma. The waterfall came from customers panic-managing their own positions, not from MM hedging.
**Implication:** A "waterfall" tape can coexist with long dealer gamma when concentrated customer positions force-unwind. Read the underlying MM position before assuming negative gamma is in play.
**Periscope mapping:** If Periscope shows MM long-gamma below spot during a flush, the flush is customer-driven, not dealer-driven — expect snap-back when customer unwind exhausts.

---

## Section 6 — Cross-asset / SPY-QQQ-ES interactions

### ES futures are the universal SPX-options hedge instrument [verified]

**Source:** 7.md, 8.md, 19.md, 20.md (cross-batch consensus)
**Mechanic:** Every SPX option Greek translates to ES contracts. Dealer hedges of SPX options are executed in ES futures (50× multiplier, 2× ratio per delta), not SPY.
**Implication:** ES futures order flow is the cleanest tape to watch for SPX dealer hedge demand. SPY tape is incidental cross-asset noise relative to the SPX→ES hedge channel.
**Periscope mapping:** When validating a Periscope-implied dealer flow event, watch ES tape (volume, delta) — that's where the hedge prints.

### SPX dominates dealer hedging; SPY is a sliver [plausible]

**Source:** 9.md | quote-keyword: "80, it's just tremendously tilted towards SPX and SPXW"
**Mechanic:** Notional expiring is ~80%+ SPX/SPXW. SPY positioning is informational but not the driver.
**Implication:** Dealer-positioning analytics built off SPY mislabel the dominant flow source.
**Periscope mapping:** Periscope's SPX-only modeling is consistent with where the actionable hedge demand lives.

---

## Section 7 — Anti-patterns / things Imran says NOT to do

### Don't infer customer-vs-MM from bid/ask-side aggressor tagging [plausible]

**Source:** 9.md, 8.md, 11.md (multi-source) | quote-keyword: "inference model… completely backwards" / "edge cases and how things get swept"
**Mechanic:** Bid/ask-side inference (Cheddar-Flow style) breaks down on big SPX names because of how the market actually prices fills, multi-leg complex orders, ISO sweeps, and dealer-to-dealer trades hitting unexpected sides of the NBBO.
**Implication:** Treat any "buy/sell at ask/bid" classification on SPX with deep skepticism; prefer source-of-truth account-type labels (CBOE OCC clearing tags).
**Periscope mapping:** Trust Periscope's color-by-side (clearing tags) over UW flow tape buy/sell coloring on the same strikes.

### Don't trade off a single time-and-sales clickbait flow alert [plausible]

**Source:** 7.md | quote-keyword: "Cheddar Flow or Unusual Wales… clickbait"
**Mechanic:** By the time a flow alert fires, the MM hedge is done. The trade's market impact is in the past.
**Implication:** Reject "follow the whale" trades anchored on a single time-and-sales print. Trade the residual position, not the headline.
**Periscope mapping:** A single huge UW flow alert at strike X tells you less than the resulting bar at strike X on Periscope after the position settles.

### Don't call a "pin" at a customer-LONG / dealer-SHORT strike [contested]

**Source:** 20.md | quote-keyword: "this is the opposite of pinning literally"
**Mechanic:** Many commentators label any high-OI strike a "pin." For a customer-long put (= dealer-short put), the gamma/charm flows REPEL price, not attract it. Calling it a pin is mechanically wrong.
**Implication:** Trade plans built on "pin to JPM put strike" are upside-down — expect overshoot and acceleration, not compression.
**Periscope mapping:** Confirm dealer LONG vs SHORT at the level on Positions panel before assuming pin behavior. (Conflicts with naive "high-OI = pin" framing common in retail commentary.)

### Don't treat the call wall as "defended" by JPM/dealers [plausible]

**Source:** 20.md, 21.md | quote-keyword: "not defending a level"
**Mechanic:** Above the call wall, dealers must sell ES because they're long calls. It's mechanical Δ-neutrality, not intent. No conspiracy; it just looks like resistance.
**Implication:** Don't treat call walls as soft levels that "could break" on news flow. They are quantitative ceilings until OI clears.
**Periscope mapping:** Concentration of green call positions = pure mechanical ceiling; size short above it accordingly.

### Don't ignore that vanna effect dies on the straddle [plausible]

**Source:** 11.md | quote-keyword: "you're back on the straddle"
**Mechanic:** Once spot moves into the 35–65Δ zone of the dominant position, vanna stops working. Continuing to hold a vanna-thesis trade past that line is fighting decayed mechanics.
**Implication:** Take vanna-rally profits as spot enters the ATM zone; don't ride past the structural fade.
**Periscope mapping:** Watch the charm/vanna bars shrink as spot approaches the call wall — that's the exit signal.

### Don't naked-buy the strike you expect price to move toward [plausible]

**Source:** 12.md | quote-keyword: "would be too much money"
**Mechanic:** Buying the magnet strike pays full premium for an outcome charm/gamma already telegraphs — fights theta through a noisy intraday path.
**Implication:** Sell the magnet strike (2×), buy the strike you expect price to depart from, cap to a fly. Cuts cost ~3× and converts theta from foe to ally.
**Periscope mapping:** Structure choice, not a level read.

### Don't sell options when IV<RV [plausible]

**Source:** 4.md | quote-keyword: "if you're selling options now, be careful"
**Mechanic:** Premium sellers depend on IV>RV risk premium. When inverted, daily theta collected < daily realized hedging cost.
**Implication:** Avoid iron condors, credit spreads, naked premium sales during IV<RV regimes — switch to debit structures or equity replacement.

### Don't size puts expecting a flush through long-gamma support [plausible]

**Source:** 7.md | quote-keyword: "you would not be buying puts that are high vol expecting… another $150 [break]"
**Mechanic:** Buying premium-rich puts expecting the index to slice through a long-gamma support zone underwrites both the IV crush and the dealer-cushion compression.
**Implication:** Long-gamma support → sell puts (or skip), don't buy them.
**Periscope mapping:** When Periscope shows long-gamma bars stacking below spot, downside premium is overpriced — flip to put-side credit, or stand aside.

### Don't trade ghost-gamma morning levels [plausible]

**Source:** 10.md | quote-keyword: "no real gamma at these levels right now… more a consequence of people believing"
**Mechanic:** Morning bounces around 0DTE strike clusters are mostly self-fulfilling; the actual Greek is small pre-noon (Imran's example: 4-delta put spread).
**Implication:** Pre-12:30 CT, treat 0DTE strikes as soft levels driven by positioning belief, not by hedge mechanics.
**Periscope mapping:** Down-weight thin morning bars until afternoon; the same bar is genuinely tradable at 1:30 CT and noise at 9:45 CT.

### Don't use 10-min Periscope refresh if you're not high-frequency [plausible]

**Source:** 10.md | quote-keyword: "if you're not looking every 10 minutes,… don't get 10-minute updates"
**Mechanic:** The 10-minute CBOE cadence is rate-limited by exchange data, not trader need. Imran says swing/macro traders should anchor to opening positions, not chase intraday refreshes.
**Implication:** For 0DTE setup at the open, the 9:30 CT snapshot is the one that matters; mid-session refreshes mostly add fragile customer-flow bars.
**Periscope mapping:** Lock in levels from the open read; refresh once around 12:30 CT for the charm regime change; resist re-anchoring on every 10-min tick.

### Don't predict the path — bound the range and let charm work [plausible]

**Source:** 17.md | quote-keyword: "you don't need to predict the exact outcome"
**Mechanic:** Path-prediction is low-edge; range-bounding via gamma/charm is high-edge. Flies and bounded structures stay viable as long as price stays inside the modeled range.
**Implication:** Anti-pattern = treating dealer-flow signals as direction-of-next-tick predictions. Correct use = "where will price NOT punch through" + structure that pays for staying inside.

### Don't take "investors monetized hedges" as the explanation for skew drops [contested]

**Source:** 16.md | quote-keyword: "copout"
**Mechanic:** Goldman/CBOE narrative attributes skew fades to discretionary hedge unwinds. Imran's mechanical explanation: skew tracks MM short-skew exposure, which decays as spot moves the peak-vanna strikes off the 20Δ ring.
**Implication:** Treat sell-side skew commentary as ambiguous; default to the positional explanation when skew fades during continuing weakness.

### Don't telegraph a large futures hedge over time [plausible]

**Source:** 9.md | quote-keyword: "punish me for that"
**Mechanic:** 4,000 futures hit at once → ~$5 absorption then snap back; 1,000 broken into 20-lots overnight → worse cumulative fill.
**Implication:** Large blocks are absorbed and forgotten; sliced flow leaks intent and gets faded by other MMs.
**Periscope mapping:** Microstructure note; useful when reading ES tape alongside Periscope.

### Don't use VIX-on-Monday-open as a signal [plausible]

**Source:** 1.md | quote-keyword: "VIX effect on the weekends"
**Mechanic:** VIX uses calendar days; MM models use trading days. Friday close → Sunday open = ~2 calendar days vs ~1 minute of MM model time. Same option, same price, but VIX backs out a higher IV.
**Implication:** Monday-morning VIX pop with no spot move is a calculation artifact, not a regime change. Don't trade it.

---

## Source-video index

| Source | Title (from line 1 of file) |
| --- | --- |
| 1.md | Intro The Greeks - Delta, Gamma and Theta \| VolSignals Webinar |
| 2.md | The Stock Market Doesn't Care About The War (Here's Why) |
| 3.md | This Is A Critical Moment For The Stock Market |
| 4.md | Something Strange is Happening Here... |
| 5.md | Introduction To Pinning at Expiration (Charm + Gamma) |
| 6.md | This is JUST Mechanics... (Here's Why) |
| 7.md | Introduction To Dealer Hedging Dynamics (TGIF) |
| 8.md | Introduction to Dealer Hedging Flows |
| 9.md | Dealer Hedging Basics \| VolSignals Webinar |
| 10.md | The Landscape — Who are the key market participants \| VolSignals Webinar |
| 11.md | The Other Greeks \| VolSignals Webinar |
| 12.md | What Market Makers Hope You NEVER Figure Out |
| 13.md | Here's What Market Makers Don't Want You To Learn |
| 14.md | This Is What Actually Predicts Market Direction |
| 15.md | If You See This, It's a RED FLAG |
| 16.md | This Signal Just Triggered (Why it Matters) |
| 17.md | If You're Anxious About The Stock Market, Watch This. |
| 18.md | The Iran Narrative Is Misleading (Here's Why & How To Protect Yourself) |
| 19.md | The Next 24 Hours Could Change Everything |
| 20.md | This Expiration Event Could Change Everything Next Week |
| 21.md | This is a Problem... |

---

## Notes

- **`[contested]` items requiring main-session attention:** (a) Anti-pin at customer-long strikes (§7) — directly conflicts with naive retail "high-OI = pin" framing common in commentary feeds. (b) Skew-fade attribution (§7) — Imran's positional explanation vs. Goldman/CBOE's "monetized hedges" narrative.
- **`[era-specific]` cluster:** High-VIX kills strict pin (§2), 2024 charm-pin economics (§4), 2018 long-gamma-down crash (§5). Treat as historical color, not active rules.
- **`[verified]` items:** Only 2× SPX→ES hedge ratio (§1) and ES-as-universal-hedge (§6). Both are first-principles math from contract specs.
- **Coverage emphasis:** Sections 1, 2, and 7 are densest (mechanics + anti-patterns are where the corpus concentrates). Section 6 is light — these transcripts treat ES as the only relevant cross-asset hedge channel; SPY/QQQ analytics get little airtime.
- **Audit:** After 7 days of use, audit which heuristics actually appeared in Periscope reads. Drop dead weight at first audit.
