---
name: charm-pressure
description: "Use whenever the user mentions SpotGamma TRACE, Charm Pressure, charm pressure heatmaps, EoD pinning, pin targets, blue/red zone analysis, Stability %, or wants to study/screenshot/EDA/ML these charts — even if they don't say 'SpotGamma' or 'TRACE' explicitly. Encodes the proprietary semantics of the Charm Pressure visualization (red = passive value gain → dealer selling, blue = passive value loss → dealer buying, pin = white/black intersection at strong gamma), the Stability % reliability gate, the Time Cutoff handling for projected vs realized regions, and analytical conventions for image-based study. Invoke before writing code that ingests these screenshots, before discussing where SPX is likely to pin into the close, and before any modeling that uses charm pressure as a feature."
risk: unknown
source: owner
date_added: '2026-04-24'
version: 3
---

## Where this lives in TRACE

The chart is **SpotGamma TRACE** — the platform. **Charm Pressure** is one mode in the chart-type dropdown (alongside GEX and others). When the user references "the heatmap," "TRACE," or "Charm Pressure" they almost always mean this view in MM (Market Maker) mode. Three on-screen elements matter and they read differently:

1. **Center pane — the heatmap itself.** Blue and red here carry the charm semantics below. This is the surface to color-extract.
2. **Left pane — GEX by Strike bar chart.** Bars are colored **purple (positive GEX)** and **pink (negative GEX)**. These colors are _not_ the heatmap colors and must not be conflated with charm zones during image processing.
3. **Top-center — `Stability %` gauge.** Per SpotGamma's tooltip, a proprietary forward-looking metric measuring **the likelihood of low realized volatility over the next 10 minutes**. Higher = more stable (less likely to see significant price movement). Applicable only between **9:30 AM and 3:30 PM ET**; outside that window the value is stale or undefined. Treat as a first-class predicted feature — not a "trust the chart" gate.

A `Time Cutoff` toggle (top-right) controls whether pixels to the right of "now" are forward-projected or hidden — see the _Time Cutoff handling_ section.

## What Charm Pressure is

Charm Pressure is a SpotGamma heatmap that depicts **how options positioning changes with respect to time**. Charm is the rate of change of delta with respect to time (∂Δ/∂t), so the chart visualizes the _flow_ dealers must transact to stay delta-hedged as time decays — independent of price moves. In a heavy 0DTE tape this dominates intraday hedging because charm grows large near expiry.

The default Market Maker view shows where dealers are likely to **buy** or **sell** towards the end of the day. Charm Pressure is best understood as a key driver of the EoD pinning process around positive gamma nodes.

## Color semantics — read this carefully, the sign convention is unintuitive

The color refers to what the **option position** is doing passively (from time decay alone), which then determines the dealer's hedge direction. Do not invert it.

- **Red zones** — Options are **passively gaining value** as time passes → dealer is short these options (or otherwise needs to _reduce_ support) → dealer **sells more futures** → less price support.
- **Blue zones** — Options are **passively losing value** as time passes → dealer is long-ish or needs to _add_ support → dealer **buys more futures** → more price support.

Mnemonic: **blue = bid (support), red = release (selling)**. SpotGamma's empirical observation is that **spot price moves strongly through blue zones at EoD**.

### Dynamic interpretation — red zones as active rejection points

The static reading above ("red = no support, blue = support") is the floor. In practice, red zones are not just _passive absence of support_ — they act as **active rejection points** when price tests them:

- Each time price rallies into a red zone, dealers' selling flow fires and price is pushed back down. You see this as **rejection wicks** at the red boundary.
- Successive tests of the same red zone tend to weaken the rejection (dealer flow at that level depletes through the day).
- The pin on a red-dominant day often lands at the **bottom of the red interaction zone**, not at the red/blue junction. Price walks down through repeated rejections and lands where the red flow finally gives out.
- The mirror pattern applies in blue: price drifts _through_ blue zones with little resistance and tends to settle at the far edge.

A high-quality charm chart on a clean day shows this dynamic clearly: the candle wicks repeatedly testing into a colored zone is the chart's flow signature in action. If you see 3–4 rejection wicks at the same red boundary during the session, the red interaction is real and the pin will likely land below the deepest test, not at the static junction.

### Chart-stability check — when _not_ to trade the chart

Before reading direction or pin off the chart, evaluate **chart stability across captures**:

- **Stable**: prevailing color (red or blue) stays the same from open → mid → close. Junctions migrate slowly. This is a tradeable read.
- **Flip-flopping**: the chart changes prevailing color twice or more during the session (e.g., red at open → blue by 9am → red again by close). This is the chart telling you _it does not have a stable read_. Skip the day. Forcing a directional or pin call here will produce noise.
- **Mid-day flip with contour confirmation**: the chart pivots once, _and the contour lines re-orient to point at a new pin candidate_. This is different from flip-flopping — it's the chart saying "I'm now seeing a different setup, here's the new pin." Honor the flip and trade the new direction (this captured the 2026-01-29 setup correctly).

Two directional changes in a session = no-trade. One change with re-oriented contours = adapt and follow.

## The pinning mechanic

Pinning is **strong gamma interaction at EoD** — the visual signature is **white/black bands sitting between red and blue pockets**. Around a strong positive-gamma node, charm pressure dampens hedging flows (the buying and selling cancel), and price gets stuck.

SpotGamma's stated rule: **spot tends to drift toward zones where positive and negative MM charm meet at EoD**. The intersection — not the peak of either color — is the pin target.

So when the user asks "where will it pin," the answer to look for in the chart is **the white/black band between a red pocket and a blue pocket, near a strong positive gamma strike**. Not the deepest blue, not the deepest red.

## Trading rules (from SpotGamma docs + observed)

Apply these when the user is reasoning about the close, not earlier:

1. **Time gate** — Charm Pressure is an EoD signal. It dominates roughly the last 1–2 hours. Do not use it to call direction at 9:30 CT.
2. **Stability as a regime predictor** — Stability% is a _forward 10-min low-vol probability_, not chart confidence. Empirically it tends to be low at the open, rise into the close, and concentrate higher on calm/range-bound days. Treat Stability ≥ ~20% near the close as a _necessary_ (not sufficient) condition for pinning: low Stability predicts large near-term moves, which is exactly when pinning fails. Outside 9:30–3:30 ET the value isn't valid — don't read it.
3. **Monitor the gap between blue and red pockets** towards the close — that is the candidate pin zone.
4. **Confirm with gamma** — pinning requires _strong positive MM gamma_ nearby. A blue/red intersection in a negative-gamma regime is not a pin signal.
5. **Direction through blue zones** — if price is _moving_ into the close, it tends to travel through blue zones rather than red.
6. **0DTE volume amplifies the effect** — large 0DTE flow makes charm pressure deeper and the pin tighter.
7. **Pinning is conditional, not a default outcome.** It works best on calm, range-bound days with strong +gamma. On strong directional days, flow overwhelms the dampening effect and price punches _into_ the red pocket rather than pinning at the red/blue boundary. If the day is clearly trending, downgrade pin confidence even with high Stability.
8. **MOC / close-auction risk.** The 14:30 CT (= 15:30 ET) capture is 30 minutes before the official market close. Index rebalancing, MOC orders, and quad-witch settlement flows fire in the final auction and can move SPX 5–50+ points in the last 30 minutes — invisible to the chart at capture time. On EOQ (Mar 31, Jun 30, Sep 30, Dec 31), quad-witch (3rd Fri of Mar/Jun/Sep/Dec), and rebalance days (S&P quarterly, Russell), expect material chart-vs-actual drift and either size for $10+ of MOC slippage or exit at 14:30 CT before the auction. On normal days the gap is usually < $5 but can still bite (08/11 had a $10–15 MOC reversal even though it wasn't an event day).

## Analytical conventions for image-based study

When the user wants to do EDA or ML on Charm Pressure screenshots, use these conventions consistently. Inconsistency between screenshots is the first thing that destroys reproducibility.

### Capture protocol

- **Cadence** — one screenshot per trading day, taken at a fixed time (suggest **15:30 ET / 14:30 CT**, 30 min before close — late enough for charm to dominate, early enough that the pin hasn't fully resolved, and the _last valid moment_ for `Stability %` per its 9:30–3:30 ET window). For richer studies, capture a quartet at **08:30 / 12:00 / 14:30 / 15:00 CT** (= 09:30 / 13:00 / 15:30 / 16:00 ET) so you can also study how the heatmap _evolved_ AND see the actual settle. The first three are inside the Stability% valid window; the 15:00 CT capture is post-close — Stability% is invalid there but the visual confirms where SPX actually settled vs the predicted pin band.
- **Frame** — same chart settings each capture: same x-axis time window (intraday), same y-axis strike range (centered on spot ± a fixed dollar band, e.g. ±$50 SPX), same Market Maker view, same theme (light or dark — pick one and never change), **same `Time Cutoff` setting** (recommend ON — see below).
- **Metadata sidecar** — for every screenshot, record: date, capture time, SPX spot at capture, EoD close (collected later), nearest 25-pt strike, day-type (FOMC / CPI / OpEx / quiet), realized regime (trending / range-bound, classified post-hoc), and **`stability_pct`** read directly off the gauge.

### Stability % handling

The `Stability %` gauge in the top-center of TRACE is a numeric reliability score for the heatmap shape. Treat it as both a **feature** and a **gate**:

- **As a feature**: log it for every capture and stratify all analysis by stability tertile.
- **As a gate**: do not act on a pin call when `stability_pct < ~20`. Below that threshold the projected EoD pockets migrate substantially during the day. (Empirically observed: 11% at open → 18% midday → 23% close on a normal trending day.)
- **Read it via OCR** if scripting capture, or write it manually into the metadata sidecar. Do _not_ try to color-extract the gauge — it's small and the dial is rendered, not data-bearing.

### Time Cutoff handling

The `Time Cutoff` toggle determines what the heatmap shows to the right of "now":

- **ON (recommended)** — pixels right of the current time still appear (forward-projected) so you can see the EoD shape _as predicted_. This is the analytic mode; calibrate everything against it.
- **OFF** — only realized time is colored. Useful for ground-truth studies but not for forecasting.

**Always capture with the same setting**, and tag it in metadata. When extracting features for a forecasting model, **mask out everything to the right of capture-time** if you want to avoid lookahead — the projected pixels are the model's _input_, not its label.

### Color extraction (HSV not RGB, region-restricted)

**First, crop to the heatmap pane only.** The TRACE screen has three colored elements that share warm/cool palettes but mean different things — a naive whole-image color sweep will conflate them:

| Element         | Location    | Colors                              | Means                                 |
| --------------- | ----------- | ----------------------------------- | ------------------------------------- |
| Heatmap         | center pane | blue / red gradient                 | charm pressure (this skill's subject) |
| GEX by Strike   | left pane   | purple (positive) / pink (negative) | gamma exposure (different feature)    |
| Stability gauge | top center  | grey arc                            | reliability score (read via OCR)      |

Define a fixed bounding box for the heatmap pane based on the chart's pixel layout (the layout is stable across captures as long as the browser window size is stable). Restrict all color extraction to that box.

Convert to HSV before thresholding. Suggested ranges (calibrate on a few labeled frames first — SpotGamma's palette has gradients, so wide bands beat narrow ones):

- **Blue zone** — `H ∈ [200, 240]`, `S > 0.35`, `V > 0.30`
- **Red zone** — `H ∈ [0, 15] ∪ [345, 360]`, `S > 0.35`, `V > 0.30`
- **Neutral / pin band** — low `S` AND (very high `V` for white OR very low `V` for black)

The neutral band between red and blue is the **explicit pin zone** — extract it as a contour, not as a single pixel.

### GEX sidebar handling

The GEX-by-Strike bars on the left are useful for fusing chart-internal +gamma node detection with charm pressure features (avoids needing your separate GEX feed for this part):

- Crop to the sidebar pane.
- Purple bars = positive GEX, pink = negative GEX. Read magnitudes from the bar lengths and the on-bar labels (OCR).
- The `nearest_pos_gamma_strike` feature can come from the **largest purple bar within ±$30 of spot**, with the strike read from the y-axis at the bar's vertical center.
- Note the **scale changes** during the day (the example day went ±10M → ±50M → ±500M as positioning crystallized) — always normalize by total absolute GEX in-frame, not raw dollars, when comparing across captures.

### Pin definition (commit to one and document it in the spec)

Reasonable choices, ranked by how forgiving they are:

1. **Tight integer pin** — EoD SPX close within ±$2 of an integer strike (10-pt or 25-pt grid).
2. **Soft pin** — EoD close within ±$5 of an integer strike.
3. **Drift-to pin** — direction of close-vs-2pm matches the predicted pin band.

Pick (1) or (2) for binary classification. (3) is for evaluating directional usefulness when the chart is wrong about the exact strike.

### Useful features to engineer

Avoid pure pixel-input CNNs at small n. Hand-engineered features dominate at n=100:

- `pin_band_centroid_strike` — strike at the centroid of the white/black contour nearest spot.
- `pin_band_width_dollars` — how wide the neutral band is.
- `dist_spot_to_pin_band` — signed distance from current spot to the centroid.
- `blue_mass_above`, `blue_mass_below` — pixel-area of blue zones above and below spot (asymmetry → directional pull).
- `red_mass_above`, `red_mass_below` — same for red.
- `nearest_pos_gamma_strike` — read from the largest purple GEX bar within ±$30 of spot (chart-internal, no separate feed needed).
- `nearest_pos_gamma_magnitude_norm` — that bar's magnitude normalized by total absolute GEX in-frame.
- `stability_pct` — direct read off the gauge. Use as both a feature and a regime indicator.
- `time_to_close_minutes` — for cross-time studies.
- `realized_regime` — `trending` / `range_bound`, classified post-hoc from the day's price range vs realized vol. Use to stratify, not as input.

When training, **always include `stability_pct` as a feature _and_ stratify CV folds by stability tertile**. The signal-to-noise ratio is dramatically different across stability bands and a model trained on a mix will underfit the high-stability subset where the real edge lives.

### Leakage traps specific to this study

- **You are modeling SpotGamma's renderer, not the market.** Color choices are quantized; gradients are interpolated. If your model finds a clean signal, suspect the colormap before you suspect alpha. Validate that the same setup with a _different_ day's spot still shows the predicted pin.
- **Uniform lift across day-types is a leakage fingerprint.** Real charm-pin edge should concentrate on calm, range-bound, high-positive-gamma days and _fail_ on event days. If FOMC/CPI/jobs days show the same accuracy as quiet days, something has leaked. Same goes for stability bands — accuracy must drop in the low-stability tertile or the model is leaking.
- **Selection bias on capture days** — if you only screenshot days you remembered to look at, your sample is biased toward memorable (trending or eventful) days. Automate the capture or commit to capturing every session.
- **Lookahead via metadata** — never include EoD close, or anything derived from after the capture time, as a feature.
- **Conflating prediction with realization.** With `Time Cutoff` ON, the right side of the heatmap is _projected_ charm pressure, not yet observed. If you compute features on the whole image and use the right-side region as input to predict the close, you're using the model's own forward-projection — circular and not informative. Either mask the projected region, or compare projected-vs-realized as a secondary diagnostic.
- **Right pin / wrong reason.** Today's test (2026-04-24): the chart correctly identified a horizontal "action band" but price closed inside the red pocket above the predicted intersection. A naive accuracy metric would call this a miss; a regime-aware metric would correctly mark it as a _trending day_ failure. Always evaluate accuracy _conditional on realized regime_, not unconditionally — pinning is a conditional phenomenon and most of the apparent edge will live in the range-bound subset.

### Sample-size guidance

- n=100 is small. Do **EDA + logistic regression on hand-engineered features** before any tree ensemble or CNN. Interpretability is the goal here — you're learning the tool, not deploying a model.
- Reserve ≥20% as a held-out test set, and split by **time** not randomly (early days train, recent days test). Charm-pressure dynamics change with regime.

## How to apply this skill

When the user asks about Charm Pressure in any of these contexts, lean on this material:

- **"Where might it pin today?"** — Look for white/black band between red and blue pockets near a strong +gamma strike. Mention the time-gate (last 1-2 hours).
- **Discussing a screenshot** — Read colors with the correct sign (red = dealer selling, blue = dealer buying), and identify the pin band as the neutral zone _between_ colored pockets.
- **Designing the study** — Push for the capture protocol, the pin definition, and the engineered features above. Discourage pure CNN approaches at n=100.
- **Interpreting model results** — Apply the leakage checks before celebrating any lift.

If the user is reasoning about pre-noon direction, gently note that Charm Pressure is an EoD signal and other tools (gamma profile, dealer flow, dark pool) are the right surface earlier in the session.
