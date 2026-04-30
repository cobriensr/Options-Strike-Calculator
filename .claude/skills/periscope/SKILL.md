---
name: periscope
description: "Use whenever the user pastes or mentions an Unusual Whales Periscope chart, the per-strike Gamma / Charm / Positions / Vanna histograms, the dots / orange / purple bar highlights, the 0DTE straddle breakeven cone or breakeven lines, the MM hedge reaction Excel decoder, or asks 'how does this chart affect my trading today / where do I put my stop / where should I exit my long or short' with a Periscope screenshot in view — even if they don't say 'Periscope' or 'Unusual Whales' explicitly. Encodes the official Periscope FAQ semantics: green bar = MM **net positive gamma** at that strike (long-options inventory, suppressive hedging), red bar = MM **net negative gamma** (short-options inventory, procyclical hedging), orange bar = gamma flipped sign since prior 10-min slice, purple bar = magnitude crossed user threshold, dots = prior-slice value. Encodes the 4-case hedge primitive (gamma sign × price direction → Buy or Sell /ES) which is the engine behind every read, plus the per-strike Excel decoder as a derived lookup, the straddle breakeven cone as a vol-shock context layer, and the actionable trading playbook: how +γ floors and ceilings define stop placement, how charm flow translates to EoD /ES drift direction, and how to translate dealer hedge direction into long/short exit targets. This is the actionable counterpart to the gamma / charm-pressure / delta-pressure SpotGamma TRACE skills — Periscope is per-strike with dollar magnitudes labeled, so reads can be much more specific than a heatmap. Invoke before discussing exits, stops, directional bias, or pin targets whenever a Periscope chart is in view, and before any vol-shock reasoning that has Periscope as the primary surface."
risk: unknown
source: owner
date_added: '2026-04-30'
version: 2
---

## What Periscope is

The Unusual Whales **Periscope** chart is a per-strike view of dealer (Market Maker) option exposure for a single SPX expiry, typically 0DTE. Unlike SpotGamma TRACE which renders a price × time heatmap, Periscope renders **horizontal histograms across strikes**. Each strike has one bar per panel, and the user can configure which panels are visible. Common configurations:

- **3-panel:** Gamma + Charm + Positions
- **4-panel:** adds Vanna

A small candle chart on the left shows SPX intraday price; horizontal dashed lines mark intraday levels. The top control bar shows date, expiry, intraday timeframe (the 10-min slice the bars summarize), DTE, and chart-type controls.

**Periscope is the actionable trading chart; SpotGamma TRACE is informational context.** Periscope's huge per-strike $-labeled bars *are* the levels that move price — a 10K-contract green Positions bar at 7240 isn't a region of "support," it's a single strike where dealer flow concentrates and price gets capped or attracted. TRACE smooths that into colormap intensity and you lose the strike specificity required to set stops and targets.

## Bar semantics — straight from the official FAQ

This is the part to get exactly right. The color and shape of every bar carry distinct meanings.

### Color = sign of net MM gamma at that strike

- **Green bar (right of zero)** — MM is **net positive gamma** at that strike. MM is net **long** options inventory there (calls *or* puts; put-vs-call is irrelevant for the sign). MM hedging at this strike is **suppressive** — buys dips, sells rips. Price tends to find resistance / support and stall.
- **Red bar (left of zero)** — MM is **net negative gamma** at that strike. MM is net **short** options inventory there. MM hedging is **procyclical** — sells into weakness, buys into strength. Price tends to accelerate through these strikes.
- **Orange bar** — Gamma **flipped sign** since the prior 10-min slice (positive→negative or negative→positive). Real-time regime change at this strike — flag it.
- **Purple bar** — Gamma magnitude crossed the user's configured **Highlight threshold** since the prior slice. Big positioning building.

The same color convention applies to the Charm and Positions panels — green = MM net long position / positive flow, red = MM net short position / negative flow.

### The dots

Each bar has a dot showing **the panel's value 10 minutes ago**. This is the second-most useful feature on the chart and easy to miss:

- **Bar bigger than the dot (same side)** → position is growing this slice.
- **Bar smaller than the dot (same side)** → position is shrinking / unwinding.
- **Bar on opposite side of zero from the dot** → sign flipped (the bar would also be orange).
- **Dot at zero with a meaningful bar** → fresh positioning that just appeared.

Use the dots to detect intraday momentum in dealer positioning. A growing green Gamma bar near spot means +γ defense is *strengthening* into the close; a shrinking one means it's bleeding.

### The straddle breakeven lines

At 9:31 AM ET, Periscope computes the theoretical 0DTE straddle (nearest ATM call + put) and exposes its breakevens via a dropdown:

- **None** — no lines.
- **Cone** — diagonal lines from open price to close-time breakeven. Tightens through the day as theta decays. Price exceeding the cone is a strong vol-extension signal.
- **Breakeven** — horizontal lines at the breakeven prices. Stays fixed all day.

Why care: when SPX exceeds the breakeven cone intraday, short-straddle sellers must buy back their short options to limit convex losses, and that buying *reflexively extends the move*. UW's empirical observation — confirmed by their first-minute volume data — is that breakouts beyond the cone tend to expand, not mean-revert. Treat a cone breach as a vol-acceleration setup, not a fade.

## The hedge primitive — gamma sign × price direction

This is the engine behind every read. The FAQ's worked examples reduce to one 4-case table:

| MM gamma at strike | If price moves… | MM hedge in /ES | Effect on tape |
| ------------------ | --------------- | --------------- | -------------- |
| **−γ** (red)       | **Down**        | **Sell**        | Fuels decline (procyclical, "fuel on the fire") |
| **−γ** (red)       | **Up**          | **Buy**         | Fuels rally (procyclical) |
| **+γ** (green)     | **Down**        | **Buy**         | "Buys the dip" (suppressive) |
| **+γ** (green)     | **Up**          | **Sell**        | "Sells the rip" (suppressive) |

That's it. Memorize this table; everything else in the skill derives from it.

The reason it works: under the FAQ's naive delta-hedging model, MMs hold an option inventory and offset its directional exposure with /ES futures. As price moves, gamma changes the option's delta, so the hedge has to be re-sized. The sign of gamma determines whether the rebalance is *with* the move (negative gamma = procyclical) or *against* the move (positive gamma = suppressive).

### What this means for the chart

- A cluster of **green bars above spot** = mechanical resistance. Rallies into the cluster face suppressive hedging that caps the move.
- A cluster of **green bars below spot** = mechanical support. Dips into it face counter-cyclical buying.
- A cluster of **red bars near spot** = acceleration zone. Whichever direction price moves, dealer hedging extends the move.
- An **orange bar** at spot = the regime at this strike just flipped. Position size accordingly — what was a defense level may have just become an acceleration zone, or vice versa.

## The per-strike Excel decoder (charm-driven flow)

The 4-case primitive above answers "what happens if price moves." A per-strike Excel decoder (often shared as a reference image) answers a related but distinct question: **what happens if no price move at all, just time decay (charm)?**

For a Long OTM Call held by MM: MM was originally hedged short /ES against the call's positive delta. As charm decays the call's delta toward 0, the MM's short /ES becomes too large — they BUY /ES to rebalance.

|                       | Short OTM Call | **Long OTM Call** | Short ITM Call | Long ITM Call |
| --------------------- | -------------- | ----------------- | -------------- | ------------- |
| **MM original hedge** | Long /ES       | Short /ES         | Long /ES       | Short /ES     |
| **Δ change (charm)**  | 0.25 → 0.24    | 0.25 → 0.24       | 0.75 → 0.76    | 0.75 → 0.76   |
| **MM hedge action**   | **Sell** /ES   | **Buy** /ES       | **Buy** /ES    | **Sell** /ES  |

|                       | Short OTM Put | Long OTM Put | Short ITM Put | Long ITM Put |
| --------------------- | ------------- | ------------ | ------------- | ------------ |
| **MM original hedge** | Short /ES     | Long /ES     | Short /ES     | Long /ES     |
| **Δ change (charm)**  | −0.25 → −0.24 | −0.25 → −0.24 | −0.75 → −0.76 | −0.75 → −0.76 |
| **MM hedge action**   | **Buy** /ES   | **Sell** /ES | **Sell** /ES  | **Buy** /ES  |

Mnemonic for the OTM half (the most common case in 0DTE): **Long-OTM-Call + big red-leftward Charm bar = mechanical /ES BUY into the close.**

ITM flips the sign because charm pushes ITM delta *toward* ±1 (gets more extreme), opposite to OTM where Δ decays toward 0.

**Important framing:** the Periscope chart already shows you the gamma sign directly via the bar colors. You don't actually need the Excel decoder to walk strike-by-strike — Charm bar direction (green/red) at a strike combined with whether the strike is above or below spot tells you the same thing the Excel does. Use the decoder when you want to be explicit about the call/put + OTM/ITM derivation; use the colors when you want to read fast.

## How to read the panels together

Each panel answers a different question per strike:

- **Positions** — "How big is the MM's contract inventory at this strike?" Sign = net long (green) or net short (red); magnitude = contract count. Read this for *which strikes matter*.
- **Gamma** — "How will MM hedging respond to a price move at this strike?" Sign + magnitude per the 4-case primitive. Read this for **support / resistance / acceleration topology**.
- **Charm** — "How will MM hedging drift just from time passing at this strike?" Read this for **mechanical EoD /ES drift direction**.
- **Vanna** — "How will MM hedging shift if IV moves?" Read this for **vol-event sensitivity** (when present).

The three stories you care about, in priority order:

1. **Largest +Gamma bars (green) within ±$30 of spot** → strongest pin / support / resistance candidates. These are the levels you quote for stops and targets.
2. **Largest −Gamma bars (red)** → acceleration zones; price travels through them fast with no defense.
3. **Largest Charm bars** → biggest mechanical EoD /ES drift contributors. Sum the signed contributions to get the day's net drift direction.
4. **Largest Vanna bars** → strikes most exposed to a vol shock. On event days these matter as much as charm; on quiet days they're background.

Always cross-check Positions vs. Gamma at the same strike — when sign agrees (green Positions + green Gamma), you have a clean read. Sign disagreement is rare and usually means a complex multi-leg structure at that strike — read both signs as data points.

## Trading rules — what the chart tells you to actually do

This is the section to lean on when the user asks "where do I put my stop" or "where should I exit."

### Conceptual split: stops vs. exits

- **Stops come from gamma topology** — strikes where dealers structurally defend price (large +γ green clusters).
- **Exits come from charm + vanna flow** — where dealer hedging is *actively* pushing the tape via time decay or IV moves.

Don't confuse them. A profit target is where the directional flow runs out, not where the topology will mean-revert against you.

### Stop placement

- **Long stops go a few points BELOW the nearest +γ floor (green Gamma bar below spot)**, not at it. Price often wicks *into* the floor before bouncing — a stop at the level gets stopped on the wick; a stop ~5–10 SPX points below survives the wick and only triggers if the floor truly breaks.
- **Short stops go a few points ABOVE the nearest +γ ceiling (green Gamma bar above spot)**, by the same logic.
- **Acceleration zones (large red Gamma bars) are not stop levels.** Price moves swiftly through them; placing a stop *inside* a −γ zone means the stop fills several points worse than the trigger. Either widen past the −γ zone or don't carry the trade through it.
- **No nearby +γ within ±$30 of spot** = no mechanical defense = use a fixed dollar stop, not a level-based one.
- **Orange bar at the floor / ceiling** = the structural defense at that strike just flipped. Don't trust the level until it confirms with the next slice.

### Exit targets — longs

- **Primary target: nearest large +Gamma strike above spot.** This is where suppressive MM hedging caps the move ("sell the rip"). Take partials there.
- **Secondary signal: charm flow turns net-sell.** If you re-tally the charm contributions across visible strikes and the net flips from buy to sell, the EoD drift just turned against you — exit even if you haven't hit the +γ ceiling.
- **Cone breach signal:** if SPX has already exceeded the 0DTE straddle breakeven cone, expect the move to extend, not fade. Trail stops looser, take partials further out.
- **Same-strike confluence** (large +γ AND positive charm bar both near the target) is the highest-confidence partial; dealers will both defend the level and see flows decay there.

### Exit targets — shorts

Symmetric:

- **Primary target: nearest large +Gamma strike below spot.** Cover partials there.
- **Secondary signal: charm flow turns net-buy.** Decoder sum flips → cover.
- **Cone breach below the lower breakeven** = bearish vol-extension setup; trail looser.
- **Vanna warning: rising IV on a down-move with a large negative-Vanna strike below spot** means dealers are buying into the puts mechanically; that flow becomes a floor.

### Direction call for the rest of the day

The chart's directional bias for the rest of the session = **net charm-driven /ES flow** across visible strikes:

1. For each strike with a meaningful Charm bar, read the sign + magnitude.
2. Tally: how many strike-magnitude-weighted "Buy /ES" vs "Sell /ES" entries are there?
3. The side with the bigger weighted flow is the EoD drift direction. Mechanical, not opinion.

When charm flow is roughly **symmetric**, the chart has no directional read — focus on pinning at the dominant +γ node and treat the day as range-bound.

### Time-of-day weighting

For 0DTE specifically:

- **Before 11:00 CT** — Charm is small relative to gamma flow; the flow tally gives a *future* drift, not a current one. Use Gamma topology for levels; treat charm as a tilt.
- **11:00–13:30 CT** — Charm builds; flow tally becomes tradeable as a tilt. Pin candidates from the Gamma panel start to matter.
- **13:30–14:30 CT** — Charm dominates. Net flow is the primary directional read; pin candidate becomes specific.
- **14:30–15:00 CT** — Final 30 min. Charm flow is mostly consumed; pin compresses to nearest dominant +γ. MOC orders can override the chart in last 5 min, especially on rebalance / quad-witch days.

### Vol shock awareness (vanna + cone)

When present, the Vanna panel matters most on event days (FOMC, CPI, jobs):

- **Large positive Vanna bars overhead** → if IV jumps, dealers must buy /ES (their put-side hedging unwinds). On a vol-pop the rally extends through these levels.
- **Large negative Vanna bars below spot** → if IV jumps on a sell-off, dealers must sell more /ES. Acceleration to the downside.
- **On vol-crush days** (post-event IV drop), the same bars work in reverse: vanna-positive overhead unwinds into selling, vanna-negative below covers into buying. Pin compresses faster than charm alone implies.

The straddle breakeven cone is the cleanest standalone vol-shock signal: when price exceeds the cone, short-vol sellers reflexively buy back hedges and extend the move. Pair with vanna for the strike where the extension will hit hardest.

## Periscope vs. SpotGamma TRACE — the hierarchy

**Periscope is the actionable surface; TRACE charts (Gamma / Charm Pressure / Delta Pressure) are informational context.** That hierarchy should drive every read.

The reason is data shape: Periscope's per-strike $-labeled bars *are* the levels that move price. TRACE renders the same underlying positioning data through a colormap that smooths magnitude across price × time — great for regime, useless for quoting a specific stop.

| Decision                  | Lead surface              | TRACE's role                                              |
| ------------------------- | ------------------------- | --------------------------------------------------------- |
| Stop strike               | **Periscope Gamma panel** | TRACE confirms the regime context (deep blue zone valid). |
| Long / short target       | **Periscope Gamma panel** | TRACE confirms whether the level is in a +γ band overall. |
| Direction-of-day bias     | **Periscope charm tally** | TRACE Charm Pressure is a sanity check on the EoD junction. |
| Vol-shock exposure        | **Periscope Vanna + cone** | TRACE doesn't expose vanna or breakeven cone directly.    |
| Regime (stable / vol)     | Periscope Gamma sign at spot | TRACE Gamma heatmap is the prettier overview.          |
| EoD pin level (specific)  | **Periscope dominant +γ + charm tally** | TRACE Charm Pressure can corroborate via the white/black junction. |

When the two disagree, **trust Periscope's specific strike** — TRACE's level reads have known calibration drift across captures and the heatmap loses precision near zone boundaries. Use TRACE only for "is the regime broadly +γ or −γ?" and as a regime-context check on Periscope's specific call.

## Worked example — 2026-04-30 morning open (08:20–08:30 CT)

This is the canonical "drift up, get capped at +γ cluster" day.

**Setup at the open:**
- SPX spot ~7,140 at 9:20–9:30 ET.
- Levels marked: 7,124.49 (lower yellow dashed), 7,198.69 (upper yellow dashed).
- 3-panel Periscope: Gamma + Charm + Positions.

**What the chart showed:**

- **~7240** — massive green Positions bar (~10K contracts, the biggest on the chart) + huge green Charm bar (~+7.2M) + mixed Gamma in the immediate cluster (red and green bars near each other 7240–7250).
  - Reading: MM has a major net-long inventory at 7240. The +charm = mechanical /ES buying drift toward 7240 as time decays. The +γ in the surrounding strikes 7220–7250 = once price arrives, suppressive hedging caps it.
- **~7220** — green Gamma cluster with smaller magnitudes than 7240 but still meaningful.
  - Reading: first soft suppression layer below 7240.
- **~7160** — small red Gamma.
  - Reading: minor acceleration zone in the path between spot (7140) and the cluster overhead.
- **~7125–7130** — green Gamma matching the lower yellow line at 7124.49.
  - Reading: the structural floor for the day. Long stops go just below 7124.
- **Below 7100** — small red bars on Positions and Gamma.
  - Reading: no defense on a break of 7124; price would accelerate down.

**Directional thesis from the open chart:**

- **Drift target:** 7240 (charm-driven mechanical buy + biggest position cluster).
- **Cap:** the +γ cluster at 7220–7250 should suppress price. Full break of 7240 unlikely without absorbing the entire long-position cluster.
- **Long entry context:** anything trading inside 7140–7160 has a ~15-pt cushion to the 7124 floor.
- **Stop level for a long:** below 7124.
- **No-trade zone:** stop placement at 7160 (acceleration); skip or widen past it.

**What actually happened:**

Day rallied 7,140 → high ~7,220–7,225 → settled **7,209.01** (+1.01%). The +γ cluster at 7220–7250 capped the move; price didn't break 7240. The 7124 floor was never tested. Settled inside the +γ cluster, just below the strongest node — textbook "drift up, get capped, pin into the cluster."

**The chart called the day cleanly:**
- Direction: up ✓
- Drift target: 7240 (price approached but didn't break — exactly what +γ suppression does) ✓
- Floor never tested ✓
- Settled inside the +γ cluster ✓

This is the kind of read the skill should produce on a clean +γ-overhead day from the morning chart alone.

## Capture conventions (if user is studying / building features)

Same protocol as the TRACE skills:

- **Cadence** — quartet at 08:30 / 12:00 / 14:30 / 15:00 CT. The 15:00 capture is for post-hoc verification of where SPX actually settled vs. the predicted cap and drift.
- **Frame** — same expiry (0DTE), same strike range (centered on spot ± a fixed dollar band, e.g. ±$100), same timeframe granularity, same theme, same panel configuration.
- **Metadata sidecar** — date, capture time, SPX spot at capture, EoD close (later), nearest 25-pt strike, day-type (FOMC / CPI / OpEx / quiet), realized regime (post-hoc), `net_charm_flow` (signed sum of charm bars across visible strikes), nearest dominant +γ strikes above and below spot, **and the straddle breakeven prices** (read from the cone or breakeven lines if shown).

### Useful features to engineer

- `net_charm_flow` — signed sum of charm bars across visible strikes; charm-magnitude-weighted "Buy − Sell" tally.
- `nearest_pos_gamma_above`, `nearest_pos_gamma_below` — strike + magnitude of the closest green Gamma bar above / below spot. Stop and target candidates.
- `nearest_neg_gamma_strike` — closest red Gamma bar; acceleration-zone awareness.
- `dominant_position_strike` — strike of the largest Positions bar; usually the day's gravitational center.
- `gamma_sign_at_spot` — sign of the Gamma bar at the strike nearest spot. Defines regime.
- `orange_bar_count` — number of orange bars in the capture; high = positioning is in flux, low conviction in structural levels.
- `cone_breach_flag` — whether SPX has exceeded the upper or lower straddle breakeven at capture time.
- `vanna_exposure_above`, `vanna_exposure_below` — sum of |Vanna| above/below spot (when 4-panel view is in use).
- `dot_to_bar_delta` — change between current bar and prior-slice dot, per panel; momentum in dealer positioning.

## How to apply this skill

When the user pastes a Periscope chart or asks about exits / stops / direction with one in view:

1. **Identify spot** from the SPX price label and dashed level lines.
2. **Identify the dominant +γ strikes** (largest green Gamma bars) within ±$30 of spot — those are stop and target candidates.
3. **Tally charm flow** across visible strikes — sum the signed magnitudes to get the day's net mechanical drift direction.
4. **Check Positions for the day's gravitational center** — usually the largest Positions bar marks the strike price wants to drift into.
5. **Check for orange bars** at any structural level — flag flipped regimes, downgrade conviction at those strikes.
6. **Check for cone breach** if straddle lines are shown — signals vol extension, not mean reversion.
7. **State the direction call** based on the charm tally; flag if symmetric / no-trade.
8. **Quote specific stop and target strikes**, not "support area." The chart gives per-strike resolution; use it.
9. **Apply time-of-day weighting** to the conviction (small before 11 CT, dominant after 13:30).
10. **Cross-check with TRACE** if the user has both. Note disagreements rather than averaging them.

The output the user wants is *actionable*: a stop strike, a target strike, a directional bias, and a confidence note from time-of-day. If you can't quote a specific strike, say so explicitly rather than gesturing at a region.
