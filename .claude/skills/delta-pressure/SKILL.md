---
name: delta-pressure
description: "Use whenever the user mentions SpotGamma TRACE Delta Pressure, the delta-hedging heatmap, dealer delta-hedging support/resistance, where dealers will buy/sell SPX as price moves, or wants to study/screenshot/EDA/ML Delta Pressure charts — even if they don't say 'SpotGamma' or 'TRACE' explicitly. Encodes the proprietary semantics of the Delta Pressure visualization (blue = dealer buying support / pressure, red = dealer selling resistance / pressure), the CRITICAL gamma-environment conditioning that flips the effect from mean-reverting to trend-amplifying, the Stability % reliability gate, the Time Cutoff handling, and analytical conventions for image-based study. Invoke before writing code that ingests these screenshots, before discussing where SPX is likely to find support or resistance, and before any modeling that uses Delta Pressure as a feature."
risk: unknown
source: owner
date_added: '2026-04-25'
version: 1
---

## Where this lives in TRACE

The chart is **SpotGamma TRACE** — the platform. **Delta Pressure** is one mode in the chart-type dropdown (alongside Charm Pressure and Gamma). When the user references "the delta heatmap" or "Delta Pressure" they almost always mean this view in MM (Market Maker) mode. Three on-screen elements matter and they read differently:

1. **Center pane — the heatmap itself.** Blue and red here carry the delta-hedging semantics below. This is the surface to color-extract.
2. **Left pane — GEX by Strike bar chart.** Bars are colored **purple (positive GEX)** and **pink (negative GEX)**. These colors are *not* the heatmap colors and must not be conflated with delta zones during image processing. **For Delta Pressure, the GEX sidebar is also load-bearing for interpretation** — the sign of net dealer gamma at spot determines whether the delta zones are mean-reverting or trend-amplifying.
3. **Top-center — `Stability %` gauge.** Per SpotGamma's tooltip, a proprietary forward-looking metric measuring **the likelihood of low realized volatility over the next 10 minutes**. Higher = more stable (less likely to see significant price movement). Applicable only between **9:30 AM and 3:30 PM ET**; outside that window the value is stale or undefined. Treat as a first-class predicted feature — not a "trust the chart" gate.

A `Time Cutoff` toggle (top-right) controls whether pixels to the right of "now" are forward-projected or hidden — see the *Time Cutoff handling* section.

## What Delta Pressure is

The Delta Pressure lens displays the **net change in market-maker delta positioning across all prices and time frames**. Where Charm Pressure visualizes the *time-decay* component of dealer hedging, Delta Pressure visualizes the *price-move* component: as SPX moves up or down, dealers must trade futures or stock to stay delta-neutral on their existing book. The heatmap shows where that hedging is concentrated.

The default Market Maker view shows where dealer buying and selling will *kick in* as SPX traverses different price levels. Delta Pressure is best understood as a **support / resistance topology** for the current session.

## Color semantics — gamma-environment conditional

The colors are **the same** in both gamma environments, but their *behavioral implication* flips. This is the most important thing to get right about Delta Pressure and the easiest thing to get wrong.

- **Blue zones** — Dealers must **buy** futures/stock to hedge (passive value loss to their position requires upward hedging).
- **Red zones** — Dealers must **sell** futures/stock to hedge (passive value gain requires downward hedging).
- **Contours** — Lines mark zone borders; price often pivots / closes near these borders.

But what those flows *do* to spot depends on the sign of net dealer gamma:

### Positive gamma environment — zones are SUPPORT / RESISTANCE (mean-reverting)

Dealers are net long gamma; their hedging is *contrarian*. Zones cap movement.

- **Overhead red zone** = dealers selling as SPX rises → resistance, breakout requires absorbing dealer flow.
- **Underhead blue zone** = dealers buying as SPX falls → support, breakdown requires absorbing dealer flow.
- **Contour at zone border** = where price tends to pause or reject.
- **Implication**: in a clean positive-gamma day, zone borders act as a corridor. Breaks need volume; the default outcome is range-bound drift.

### Negative gamma environment — zones are ACCELERATION (trend-amplifying)

Dealers are net short gamma; their hedging is *procyclical*. Zones amplify moves through them.

- **Overhead blue zone** = dealers buying as SPX rises → fuel for the up-move (NOT support), can extend rallies.
- **Underhead red zone** = dealers selling as SPX falls → fuel for the down-move (NOT resistance), can extend declines.
- **Contour at zone border** = where the regime shifts in or out of an acceleration corridor.
- **Implication**: in a clean negative-gamma day, the same blue/red zones become engines of momentum. A blue zone above spot is bullish (not support).

### One-line summary

> **+gamma**: blue below = support, red above = resistance.
> **−gamma**: blue above = bull fuel, red below = bear fuel.
>
> **Strength** is more likely in a blue zone, **weakness** in a red zone — gamma sign tells you what "more likely" means (mean-revert vs accelerate).

## Trading rules (from SpotGamma docs + observed)

1. **Gamma sign first, color second.** Read the GEX-by-Strike sidebar (or your separate GEX feed) before interpreting any zone. The same picture is two opposite trade theses depending on sign. If you don't know the gamma sign, you can't use the chart.
2. **Zone borders are the actionable feature, not zone centers.** Contour lines are where price pivots. Center-of-zone is irrelevant; nearest-border-distance from spot is the load-bearing measurement.
3. **Strength / weakness sign**: in any gamma environment, blue tends to coincide with strength and red with weakness — but the *path* to that strength/weakness differs by gamma sign (mean-reverting vs trend-amplifying).
4. **Time-of-day** — Delta Pressure is read-anytime, unlike Charm Pressure which is EoD-dominant. It's most useful in the 9:30–3:30 ET window where Stability% is also valid.
5. **Stability% as a regime co-signal** — high Stability + positive gamma + clean blue-below/red-above topology is the textbook range-bound day. Low Stability + negative gamma + acceleration zones overhead is the textbook trend day.
6. **Volume confirms breaks** — a Delta Pressure zone-border break "needs volume" because breaking it requires absorbing the dealer hedging flow concentrated at that level. Price-action without volume through a +gamma red overhead zone usually fails.
7. **Negative-gamma trades are leveraged in both directions.** Acceleration cuts both ways; structures (long calls during bull acceleration, long puts during bear) capture the gamma; spreads do not.

## Analytical conventions for image-based study

Use these conventions consistently. Inconsistency between screenshots is the first thing that destroys reproducibility.

### Capture protocol

- **Cadence** — same protocol as Charm Pressure: a quartet at **08:30 / 12:00 / 14:30 / 15:00 CT** (= 09:30 / 13:00 / 15:30 / 16:00 ET). The first three are inside the Stability% valid window; the 15:00 CT capture is post-close — Stability% is invalid there but the visual confirms where SPX actually settled vs the predicted zone topology.
- **Frame** — same chart settings each capture: same x-axis time window (intraday), same y-axis strike range (centered on spot ± a fixed dollar band, e.g. ±$50 SPX), same Market Maker view, same theme, **same `Time Cutoff` setting** (recommend ON).
- **Metadata sidecar** — for every screenshot, record: date, capture time, SPX spot at capture, EoD close (later), nearest 25-pt strike, day-type (FOMC / CPI / OpEx / quiet), realized regime (trending / range-bound, post-hoc), `stability_pct`, **and `gamma_sign_at_spot` (positive / negative / mixed) — load-bearing for Delta Pressure interpretation in a way it isn't for Charm Pressure**.

### Stability % handling

Same as Charm Pressure: read it as both a **feature** and a **gate**. Below ~20% near the close, predictive value is poor. Outside 9:30–3:30 ET the value isn't valid — don't read it.

### Time Cutoff handling

Same as Charm Pressure: capture with `Time Cutoff` ON for forecasting, mask the projected (right-of-now) region if you need to avoid lookahead.

### Color extraction (HSV, region-restricted)

Crop to the heatmap pane only. The Delta Pressure heatmap uses the same blue/red palette as Charm Pressure but the *meaning* differs — the HSV thresholds are unchanged but the downstream features are different. Suggested HSV ranges:

- **Blue zone** — `H ∈ [200, 240]`, `S > 0.35`, `V > 0.30`
- **Red zone** — `H ∈ [0, 15] ∪ [345, 360]`, `S > 0.35`, `V > 0.30`
- **Contour line** — typically darker / saturated edges between blue and red regions; use Canny edge detection on the L-channel after HSV masking of the colored regions.

### GEX sidebar handling (especially important for Delta Pressure)

The GEX-by-Strike bars on the left determine the entire interpretation of the Delta Pressure heatmap. Always extract:

- **Sign of net GEX in the spot ± $30 band.** This is your `gamma_sign_at_spot` feature.
- **`nearest_pos_gamma_strike` and `nearest_pos_gamma_magnitude`** — same as charm: largest purple bar within ±$30 of spot.
- **`nearest_neg_gamma_strike` and `nearest_neg_gamma_magnitude`** — largest pink bar; in a negative-gamma environment this is where acceleration is concentrated.
- **Net GEX magnitude** — sum of purple minus sum of pink in-frame.
- The scale changes during the day — normalize by total absolute GEX in-frame, not raw dollars, when comparing across captures.

### Outcome definitions (commit to one and document it in the spec)

Delta Pressure doesn't have a "pin" outcome the way Charm Pressure does. Reasonable choices:

1. **Zone-border respect** (positive gamma) — did spot pivot at the predicted +gamma blue/red border within ±$3 of the contour during the session? Binary.
2. **Zone-break magnitude** (negative gamma) — given that spot entered an acceleration zone, how many points of follow-through vs the entry price? Continuous.
3. **Overhead resistance test** — at any point did spot rally to within ±$3 of the predicted overhead red contour and reject by ≥$3 in the next 30 min? Binary.
4. **Underneath support test** — symmetric.
5. **Direction-on-day** — did SPX close on the same side of the dominant zone topology as predicted? (Coarse but interpretable.)

Pick (1) for clean +gamma days, (2) for clean −gamma days. (3)/(4) are intra-day reaction events. (5) is for day-level direction-of-day analysis.

### Useful features to engineer

Hand-engineered features dominate at small n. For Delta Pressure:

- `nearest_blue_below_dollars` — signed distance from spot to the centroid of the nearest blue zone below.
- `nearest_red_above_dollars` — same for red overhead.
- `nearest_blue_above_dollars` — for negative-gamma scenarios.
- `nearest_red_below_dollars` — for negative-gamma scenarios.
- `blue_mass_above`, `blue_mass_below`, `red_mass_above`, `red_mass_below` — pixel-area asymmetry around spot.
- `corridor_width` — distance from nearest blue contour below to nearest red contour above (for +gamma corridor measurement).
- `gamma_sign_at_spot` — categorical (+/−/mixed) from GEX sidebar. **Always include as an interaction term, not just a main effect.**
- `net_gex_normalized` — net GEX in spot ±$30, normalized by total |GEX|.
- `stability_pct` — direct read off the gauge.
- `time_to_close_minutes` — for cross-time studies.
- `realized_regime` — classified post-hoc; use to stratify, not as input.

When training, **interact every Delta Pressure feature with `gamma_sign_at_spot`**. The same feature has opposite predictive sign in +γ vs −γ days; without the interaction, a model averages the two to noise.

### Leakage traps specific to this study

- **You are modeling SpotGamma's renderer, not the market.** Same as Charm Pressure — if a clean signal emerges, suspect the colormap before alpha. Validate that the same setup with a different day's spot still shows the predicted zone topology.
- **Gamma-sign confound.** Most apparent edge from "blue below = support" tests will turn out to be the +γ regime label doing the work, not the chart. Always evaluate features *conditional on `gamma_sign_at_spot`*.
- **Right outcome / wrong reason.** A spot that closes near a predicted zone border on a trending day is not a "respect" — it's the trend reaching that level by external force. Pair zone-respect outcomes with realized regime labels and only count respects on days where the realized vol path is consistent with the predicted regime.
- **Selection bias on capture days** — same as charm: automate or commit to capturing every session.
- **Lookahead via metadata** — never include EoD close, or anything derived from after capture time, as a feature.
- **Conflating prediction with realization** — with `Time Cutoff` ON, the right side of the heatmap is *projected*. Mask the projected region for forecasting; compare projected-vs-realized as a secondary diagnostic.

### Sample-size guidance

- n=100 is small. Do **EDA + logistic regression with gamma-sign interaction** before any tree ensemble or CNN.
- Reserve ≥20% as held-out test, split by **time** not randomly. Delta-pressure dynamics change with regime.

## How to apply this skill

When the user asks about Delta Pressure in any of these contexts, lean on this material:

- **"Where will SPX find support / resistance?"** — Read the gamma sign first, then identify the nearest blue-below contour (support in +γ) or red-above contour (resistance in +γ). In −γ, the same colors mean acceleration, not levels — flag that immediately.
- **Discussing a screenshot** — Read colors with the correct sign (blue = dealer buying, red = dealer selling) and the gamma-sign-conditional behavioral meaning. Point out the contour borders, not the zone centers.
- **Designing the study** — Push for the capture protocol, the gamma-sign feature, the conditional outcome definitions, and the interaction-term modeling. Discourage pure CNN approaches at n=100.
- **Interpreting model results** — Apply the leakage checks; stratify accuracy by `gamma_sign_at_spot` always.

If the user is reasoning about EoD pinning specifically, gently redirect to Charm Pressure — that's the EoD-pinning lens. Delta Pressure is the support/resistance lens, valid throughout the session.
