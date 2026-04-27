---
name: gamma
description: "Use whenever the user mentions SpotGamma TRACE Gamma, the Gamma heatmap, dealer gamma topology, areas of high vs low expected volatility for SPX, the +γ/−γ regime structure across strikes, multi-day forward gamma projections, or wants to study/screenshot/EDA/ML Gamma charts — even if they don't say 'SpotGamma' or 'TRACE' explicitly. Encodes the proprietary semantics of the Gamma visualization (blue = positive market-maker gamma → lower expected volatility, red = negative market-maker gamma → higher expected volatility, white/black = neutral transition zones), color-depth-as-magnitude, the Stability % reliability gate, the Time Cutoff handling for projected vs realized regions, and analytical conventions for image-based study. Invoke before writing code that ingests these screenshots, before discussing whether SPX is in a stable or volatile regime, and before any modeling that uses Gamma topology as a feature. The Gamma chart is the foundational regime view — it conditions the interpretation of both Charm Pressure and Delta Pressure."
risk: unknown
source: owner
date_added: '2026-04-25'
version: 1
---

## Where this lives in TRACE

The chart is **SpotGamma TRACE** — the platform. **Gamma** is one mode in the chart-type dropdown (alongside Charm Pressure and Delta Pressure). When the user references "the gamma heatmap" or "where is SPX stable today" they almost always mean this view in MM (Market Maker) mode. Three on-screen elements matter and they read differently:

1. **Center pane — the heatmap itself.** Blue / red / white / black here carry the gamma-topology semantics below. This is the surface to color-extract.
2. **Left pane — GEX by Strike bar chart.** Bars are colored **purple (positive GEX)** and **pink (negative GEX)**. Note: the GEX sidebar shows gamma magnitudes per strike at a single y-slice (cross-section), while the heatmap shows the same information across the full price × time grid. They're consistent views of the same underlying gamma surface — useful for cross-checking.
3. **Top-center — `Stability %` gauge.** Per SpotGamma's tooltip, a proprietary forward-looking metric measuring **the likelihood of low realized volatility over the next 10 minutes**. Higher = more stable. Applicable only between **9:30 AM and 3:30 PM ET**; outside that window the value is stale or undefined. **Stability% and the Gamma chart are the two most-correlated TRACE features** — Stability% essentially derives from the gamma topology around spot.

A `Time Cutoff` toggle (top-right) controls whether pixels to the right of "now" are forward-projected or hidden. The Gamma chart also exposes a **multi-day forward projection** via the calendar dropdown (typically 5 days ahead) — see _Multi-day projection_ below.

## What the Gamma chart is

The Gamma lens shows **the sign and magnitude of net market-maker gamma exposure across price and time**. It is the foundational regime indicator: where dealers are net long gamma the market is mean-reverting and stable; where they are net short the market is acceleration-prone and volatile.

This chart is the **underlying state** that the other two TRACE views describe in motion:

- **Charm Pressure** shows how dealer hedging will _flow_ through that gamma topology as time decays.
- **Delta Pressure** shows how dealer hedging will _flow_ through that gamma topology as price moves.
- **Gamma** shows the topology itself.

Read Gamma first. The other two charts mean different things in different gamma regions; you cannot interpret them without knowing the gamma sign at spot.

## Color semantics — direct, not conditional

Unlike Delta Pressure (where the same color flips meaning across +γ/−γ environments), the Gamma chart's colors _are_ the gamma sign. There's no conditional re-interpretation.

- **Blue zones** — Net positive market-maker gamma → **lower expected volatility**. Dealers are long gamma here; their hedging is mean-reverting; price tends to find support / resistance in these regions.
- **Red zones** — Net negative market-maker gamma → **higher expected volatility**. Dealers are short gamma here; their hedging is procyclical; price tends to _travel swiftly_ through these regions.
- **White zones (light theme)** — Transition / neutral zones. Little dealer hedging activity; no strong directional bias.
- **Black zones (dark theme)** — Same as white in light mode: transition / neutral. Pick a theme and stick to it across captures.

**Color depth encodes magnitude.** Dark blue = strongest +γ (most stable, deepest support/resistance); dark red = strongest −γ (most volatile, fastest moves). Pale blue / pale red are weaker. Use color depth as a continuous strength feature, not a binary in/out flag.

## Trading rules (from SpotGamma docs + observed)

1. **Read Gamma before Charm or Delta Pressure.** The other two charts are conditional on the gamma sign at spot; Gamma is the unconditional read. If you're going to look at one TRACE chart per session, this is it.
2. **Pinning is more likely in a deep blue zone** (highest impact at the EoD). The deeper the blue, the tighter the expected stability around that strike. Cross-reference with Charm Pressure for the EoD pin direction.
3. **Volatility is more likely in a deep red zone** (highest impact at the EoD). When SPX is sitting in or moving toward a red zone late in the session, expect range expansion, not pinning.
4. **Price moves swiftly through neutral / negative gamma**, and **finds support or resistance at strong positive gamma**. Use this as a directional path expectation: a blue island above spot acts as a magnet (support drawing price up); a red ravine adjacent to spot acts as a corridor of acceleration.
5. **Color depth matters more than color sign at the boundary.** A faint blue band gives no real stability; only deep-blue zones impose meaningful pinning behavior. Likewise, faint red gives little vol bump.
6. **Multi-day forward projection** (5-day calendar dropdown) is for swing traders only — gamma topology far out is highly speculative because it depends on dealer positioning that hasn't been put on yet. Do not use 3+ days forward as a precise feature; treat it as a coarse regime indicator.
7. **Time gate is loose** — Gamma topology is informative throughout the session, not just at the EoD like Charm Pressure. Stability%'s 9:30–3:30 ET window still bounds the _intraday metric_, but the underlying gamma chart is interpretable any time the market is open.

## Override rules — when gamma beats charm for level prediction

Gamma is the **senior signal for level prediction**. Charm gives direction; gamma gives the level when there's a strong +γ feature. Across a calibration sample (2026-04-25 walkthrough), in 6/6 days gamma and charm agreed on direction, in 4/6 they agreed on level, and in **2/2 disagreement cases gamma won**. The rule:

### 1. Dominant-node override

When **a single +γ node within ±$30 of spot is ≥10× the magnitude of the next-nearest +γ node**, that strike is the pin level — regardless of where charm's red/blue junction sits.

- The 10× ratio is read off the **GEX-by-Strike sidebar's labeled magnitudes** (e.g. 3.4B vs 324M = 10.5× ratio).
- A clear visual proxy: the dominant node will have the deepest blue color in the heatmap _and_ a visibly outsized purple bar in the sidebar.
- Calibration example: 2025-04-24 had +3.4B at 5475 with 324M next nearest (10.5× ratio). Charm said pin at 5475–5480 upper junction; gamma said 5475 specifically. Actual close 5,484.77 — landed at the gamma node, not the charm junction.

### 2. +γ floor/ceiling override

Even without a single dominant node, **a deep-blue +γ band acts as a hard support (below spot) or resistance (above spot) for that day's price action**. When charm predicts price will travel _past_ a deep-blue band, gamma usually wins — price stops at the band edge.

- Visually: a contiguous deep-blue zone of any width near spot is a level boundary, not a bar in the GEX sidebar.
- The pin lands at the **edge of the +γ band closest to spot**, not at the band center or at the charm-predicted level past the band.
- Calibration example: 2025-10-09 had a +γ floor at ~6735 with red zone above. Charm correctly said "lots of red, no support, go short" and predicted 6720–6725. Gamma said "+γ floor at 6735 will stop the move." Actual close 6,735.11 — exact floor location.

### 3. Dueling-nodes pattern — read both signs

When the chart shows a large −γ node _and_ a large +γ node near spot:

- **Price travels swiftly through the −γ zone** (acceleration) — don't expect resistance there.
- **Price pins at the +γ node** even if charm says the pin is elsewhere.
- Calibration example: 2025-12-03 had −10B at 6855 + +6B near 6850. Price flew through the −10B zone and locked at the +6B. Charm said pin at 6870 upper junction; gamma override said 6850. Actual close 6,849.72 — at the +γ node.

### Reading-time canon: use the EOD capture, not the close capture

Positioning crystallizes substantially in the last 30 minutes of the session. A +γ node that reads as 1.7B at the **close capture (14:30 CT / 15:30 ET)** can grow to 3.4B by the **eod capture (15:00 CT / 16:00 ET)** as MOC orders and settlement flows are absorbed into dealer books.

- For magnitude reads relevant to the override rule, **always use the eod capture**, not the close capture.
- The close capture is still useful for direction and topology — but the magnitude scale read there will _under-state_ the dominance ratio.
- Calibration: 2025-04-24 read as ~1.7B-largest at 14:30 CT, then 3.4B-largest by 14:40 CT. The 10× ratio was only visible after the magnitude grew.

### Combined trading rule (charm + gamma)

1. **Charm is stable** → take the direction call.
2. **Gamma shows a dominant +γ node OR a clear +γ floor/ceiling at a different level than charm's junction** → use the gamma level, not the charm junction.
3. **Charm + gamma agree on level** → high conviction, tight position size.
4. **Charm direction call is unstable (flip-flop)** → no-trade regardless of gamma.

## Analytical conventions for image-based study

Use these conventions consistently. Inconsistency between screenshots is the first thing that destroys reproducibility.

### Capture protocol

- **Cadence** — same protocol as Charm Pressure and Delta Pressure: a quartet at **08:30 / 12:00 / 14:30 / 15:00 CT** (= 09:30 / 13:00 / 15:30 / 16:00 ET). The first three are inside the Stability% valid window; the 15:00 CT capture is post-close — Stability% is invalid there but the visual confirms where SPX actually settled vs the predicted gamma topology.
- **Frame** — same chart settings each capture: same x-axis time window (intraday), same y-axis strike range (centered on spot ± a fixed dollar band, e.g. ±$50 SPX), same Market Maker view, same theme, **same `Time Cutoff` setting** (recommend ON).
- **Multi-day projection** — if you want to study swing-scale features, capture a _separate_ daily screenshot at the open with the calendar dropdown set to "+5 days." Tag those captures with `is_multiday_projection=true` so they don't pollute intraday analyses.
- **Metadata sidecar** — for every screenshot, record: date, capture time, SPX spot at capture, EoD close (later), nearest 25-pt strike, day-type (FOMC / CPI / OpEx / quiet), realized regime (trending / range-bound, post-hoc), `stability_pct`, **`gamma_sign_at_spot`** (read from the heatmap pixel at the spot strike, not the GEX sidebar), and **`gamma_strength_at_spot`** (color depth, 0–1).

### Stability % handling

Same as the other TRACE skills: read it as both a **feature** and a **gate**. Below ~20% near the close, predictive value is poor. Outside 9:30–3:30 ET the value isn't valid — don't read it.

For the Gamma chart specifically: Stability% is essentially the gauge-form summary of the gamma topology immediately around spot. Both should be highly correlated. When they diverge (Stability% high but spot is in a red zone, or vice versa) the divergence itself is informative — it usually means the topology is shifting and one of the two readings is lagging.

### Time Cutoff handling

Same as Charm Pressure: capture with `Time Cutoff` ON for forecasting, mask the projected (right-of-now) region if you need to avoid lookahead.

For the multi-day forward projection mode, the entire chart is forward-projected — there is no "realized" left side. Treat all 5-day captures as input only, with no concurrent realized comparison.

### Color extraction (HSV, region-restricted)

Crop to the heatmap pane only. Suggested HSV thresholds:

- **Deep blue (strong +γ)** — `H ∈ [200, 240]`, `S > 0.55`, `V > 0.40`
- **Pale blue (weak +γ)** — `H ∈ [200, 240]`, `0.20 < S < 0.55`, `V > 0.40`
- **Deep red (strong −γ)** — `H ∈ [0, 15] ∪ [345, 360]`, `S > 0.55`, `V > 0.40`
- **Pale red (weak −γ)** — `H ∈ [0, 15] ∪ [345, 360]`, `0.20 < S < 0.55`, `V > 0.40`
- **Neutral (transition zone)** — low `S` AND (very high `V` for white in light theme OR very low `V` for black in dark theme)

The pale/deep split is the load-bearing distinction for Gamma — strength matters more than just sign.

### GEX sidebar handling

The GEX-by-Strike bars on the left provide a cross-section of the same gamma surface. They're useful for:

- **Validation**: deep blue in the heatmap at strike K should correspond to a tall purple bar at strike K. If they disagree, color extraction is buggy.
- **Numeric labels**: the GEX bars often have on-bar labels (OCR-readable) that give exact gamma magnitude in dollars. The heatmap's color depth is normalized — for raw magnitudes, prefer the sidebar.

When training, derive `gamma_sign_at_spot` and `gamma_strength_at_spot` from the **heatmap pixel at the spot row**, not from the GEX sidebar. The heatmap encodes the projected surface; the sidebar is a single time-slice. Both are useful but they aren't the same feature.

### Outcome definitions (commit to one and document it in the spec)

1. **Realized vol regime match** — for each capture, did realized vol over the next 30/60 min agree with the predicted gamma sign at spot? (Deep blue → low realized vol; deep red → high realized vol.) Continuous (correlation) or binary (sign match).
2. **Pin in deep blue** — restricted version of the Charm-Pressure pin: did SPX close within ±$5 of the deepest-blue strike within ±$30 of spot? Binary.
3. **Acceleration through deep red** — given a deep-red zone overhead/underneath at capture, did spot traverse it with realized vol ≥ X std dev above its earlier session pace? Binary.
4. **Cross-chart consistency** — does the gamma topology at capture predict the same EoD outcome as Charm Pressure and Delta Pressure read at the same capture? Use this as a model-of-models validity check.

(1) is the cleanest unconditional outcome. (4) is for the cross-chart EDA you actually want — Gamma + Charm + Delta agreement should be strongly predictive; disagreement should add noise.

### Useful features to engineer

Hand-engineered features dominate at small n. For the Gamma chart:

- `gamma_sign_at_spot` — categorical (+/−/neutral) from the spot-row pixel.
- `gamma_strength_at_spot` — continuous, 0–1 from color depth at the spot-row pixel.
- `nearest_deep_blue_strike` and `nearest_deep_blue_distance` — strike of the closest deep-blue zone above/below spot.
- `nearest_deep_red_strike` and `nearest_deep_red_distance` — same for red.
- `blue_mass_above`, `blue_mass_below` — pixel-area of blue zones above/below spot.
- `red_mass_above`, `red_mass_below` — same for red.
- `gamma_corridor_width` — distance from nearest deep-blue _below_ to nearest deep-blue _above_ (the +γ stability band around spot).
- `red_zone_traversal_distance` — how far into a red zone you have to move to escape into the next blue zone (proxy for "how much vol once we enter this zone").
- `pale_to_deep_ratio` — within ±$30 of spot, ratio of pale (weak) to deep (strong) gamma pixels. High pale ratio = soft regime; high deep ratio = crystallized regime.
- `stability_pct` — direct read off the gauge.
- `time_to_close_minutes` — for cross-time studies.
- `realized_regime` — classified post-hoc; use to stratify, not as input.

When training, **always include both `gamma_sign_at_spot` and `gamma_strength_at_spot`** — sign without strength loses the deep-vs-pale information that drives most of the predictive power.

### Leakage traps specific to this study

- **You are modeling SpotGamma's renderer, not the market.** Same as the other TRACE charts — if a clean signal emerges, suspect the colormap before alpha. Validate that the same setup with a different day's spot still shows the predicted regime.
- **GEX leak** — `gamma_sign_at_spot` derived from the GEX sidebar's labels is functionally a leaked numeric feature; the heatmap-pixel version is the correct image-derived feature. Don't accidentally regress on the labels.
- **Stability%/Gamma circular use** — Stability% derives from the gamma topology, so using both as independent features triple-counts the same signal. Pick one as the primary regime feature; use the other as a divergence diagnostic.
- **Multi-day forward projections are speculative** — including 5-day-out gamma features as predictors of intraday outcomes is a leakage pattern in disguise (the 5-day projection moves substantially day-to-day because positioning hasn't been fully put on yet). Either keep multi-day captures in a strictly separated study, or include a `projection_days_out` feature so the model can downweight far-out projections.
- **Selection bias on capture days** — same as the other TRACE skills: automate or commit to capturing every session.
- **Lookahead via metadata** — never include EoD close, or anything derived from after capture time, as a feature.
- **Conflating prediction with realization** — with `Time Cutoff` ON, the right side of the heatmap is _projected_. Mask the projected region for forecasting; compare projected-vs-realized as a secondary diagnostic.

### Sample-size guidance

- n=100 is small. Do **EDA + logistic regression on `gamma_sign_at_spot × gamma_strength_at_spot`** before any tree ensemble or CNN.
- Reserve ≥20% as held-out test, split by **time** not randomly. Gamma topology evolves slowly with positioning cycles; recent days are not exchangeable with older ones.

## How to apply this skill

When the user asks about Gamma in any of these contexts, lean on this material:

- **"Is SPX in a stable or volatile regime today?"** — Read the gamma sign and depth at spot. Deep blue → stable / pin-prone. Deep red → volatile / acceleration-prone. Pale or neutral → soft regime, low conviction either way.
- **"Where will SPX find support or resistance?"** — The deepest-blue strikes within ±$30 of spot are the strongest candidates. Confirm with Delta Pressure for the directional flow, with Charm Pressure for the EoD pin specifically.
- **Discussing a screenshot** — Read colors with the correct sign (blue = +γ = stable, red = −γ = volatile), and weight by depth. Point out whether spot is in a deep zone (high regime conviction) or a pale / transition zone (soft regime).
- **Designing the study** — Push for the capture protocol, the heatmap-pixel-based gamma features, the cross-chart consistency outcome, and the deep/pale distinction in HSV thresholds. Discourage pure CNN approaches at n=100.
- **Cross-chart EDA** — Use Gamma as the _conditioning_ variable for both Charm Pressure (pin signals concentrate in deep-blue regimes) and Delta Pressure (zone-respect happens in +γ, acceleration in −γ). Always stratify the other two charts' analyses by gamma regime read from this chart.

If the user is reasoning about a specific intraday move, the Gamma chart tells you _whether_ a move is likely to be smooth or accelerated, but not _which direction_ — pair it with Delta Pressure for direction-of-move and Charm Pressure for the EoD destination.
