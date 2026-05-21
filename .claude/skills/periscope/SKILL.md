---
name: periscope
description: "Use whenever the user pastes or mentions an Unusual Whales Periscope chart, the per-strike Gamma / Charm / Positions / Vanna histograms, the Net GEX / Net Charm heat maps, the dots / orange / purple bar highlights, the 0DTE straddle breakeven cone or breakeven lines, the MM hedge reaction Excel decoder, or asks 'how does this chart affect my trading today / where do I put my stop / where should I exit my long or short' with a Periscope screenshot in view — even if they don't say 'Periscope' or 'Unusual Whales' explicitly. Encodes the official Periscope FAQ semantics: green bar = MM **net positive gamma** at that strike (long-options inventory, suppressive hedging), red bar = MM **net negative gamma** (short-options inventory, procyclical hedging), orange bar = gamma flipped sign since prior 10-min slice, purple bar = magnitude crossed user threshold, dots = prior-slice value. Encodes the 4-case hedge primitive (gamma sign × price direction → Buy or Sell /ES) which is the engine behind every read, plus the per-strike Excel decoder as a derived lookup, the straddle breakeven cone as a vol-shock context layer, and the actionable trading playbook: how +γ floors and ceilings define stop placement, how charm flow translates to EoD /ES drift direction, and how to translate dealer hedge direction into long/short exit targets. The skill operates in a 3-mode lifecycle (`pre_trade` / `intraday` / `debrief`) and produces a structured trading playbook (regime, bias, key levels, trade types to take vs. avoid) as a trailing JSON block. Per-strike MM-attributed GEX/charm values from the heat maps are injected by the backend as exact numbers — lean on those magnitudes, not visual estimation. Invoke before discussing exits, stops, directional bias, or pin targets whenever a Periscope chart is in view, and before any vol-shock reasoning that has Periscope as the primary surface."
risk: unknown
source: owner
date_added: '2026-04-30'
version: 3
---

## What Periscope is

The Unusual Whales **Periscope** chart is a per-strike view of dealer (Market Maker) option exposure for a single SPX expiry, typically 0DTE. Periscope renders **horizontal histograms across strikes** — each strike has one bar per panel, and the user can configure which panels are visible. Common configurations:

- **3-panel:** Gamma + Charm + Positions
- **4-panel:** adds Vanna

A small candle chart on the left shows SPX intraday price; horizontal dashed lines mark intraday levels. The top control bar shows date, expiry, intraday timeframe (the 10-min slice the bars summarize), DTE, and chart-type controls.

Periscope's huge per-strike $-labeled bars _are_ the levels that move price — a 10K-contract green Positions bar at 7240 isn't a region of "support," it's a single strike where dealer flow concentrates and price gets capped or attracted. Use the per-strike resolution; don't smooth it back into "zones."

## Numeric heat maps + injected per-strike values

The user typically provides **Net GEX Heat Map** and **Net Charm Heat Map** screenshots alongside the Periscope chart. The backend's Pass 1B vision OCR extracts per-strike values from these heat maps and injects them as a labeled text block at the top of the user message:

```
[Heat-map extracted strikes (MM-attributed Net GEX / Net Charm from UW)]
GEX:  7,275 +977.72  |  7,250 -1,560.05  |  7,260 +625.15  | ...
Charm: 7,275 +1.45M  |  7,295 -1.37M     |  7,210 +72.5K   | ...
```

**Lean on these injected numbers, not visual estimation.** They are UW's MM-attributed Net GEX / Net Charm — same values shown in the heat-map cells, transcribed exactly. Quote magnitudes directly in the read: _"7,275 = +977 γ ceiling, 7,250 = −1,560 γ acceleration trigger."_

**What injection does NOT cover (still read from the chart visually):**

- **Dots** (prior 10-min slice values) — the momentum read.
- **Orange / purple bar highlights** — regime-flip and threshold-breach signals.
- **Yellow dashed cone** overlay (read via OCR but exposed as `cone_lower` / `cone_upper` in structured input).
- **Price candles** for the back-read.
- **Wider strike range.** Heat maps typically show a central ~100-pt range; the Periscope visual extends further out for deep magnets / far-strike Position clusters.

**Back-read discipline:**

- The heat-map header `Underlying: ($XXXX)` shows the **live spot at capture** (usually EOD close). **Ignore for back-reads**, same rule as the Periscope's red dotted spot line. The authoritative spot for the read time comes from the backend's `index_candles_1m` lookup and is supplied in the user message.

**Workflow:**

1. Use the injected heat-map values as the structural map (exact $-magnitudes per strike).
2. Cross-reference with the Periscope visual for dots (momentum), cone bounds, orange/purple highlights, and far-strike structure outside the heat-map range.
3. Quote numeric magnitudes in the read (e.g. "7,250 = −1,560 γ"); never "huge red bar."
4. Use precise magnitudes for trigger placement and R:R sizing.

When heat-map injection is absent (e.g. pre-trade chart-only mode), fall back to visual estimation and flag the precision loss in the read.

## Bar semantics — straight from the official FAQ

This is the part to get exactly right. The color and shape of every bar carry distinct meanings.

### Color = sign of net MM gamma at that strike

- **Green bar (right of zero)** — MM is **net positive gamma** at that strike. MM is net **long** options inventory there (calls _or_ puts; put-vs-call is irrelevant for the sign). MM hedging at this strike is **suppressive** — buys dips, sells rips. Price tends to find resistance / support and stall.
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

Use the dots to detect intraday momentum in dealer positioning. A growing green Gamma bar near spot means +γ defense is _strengthening_ into the close; a shrinking one means it's bleeding.

### The straddle breakeven lines — identify these FIRST

At 9:31 AM ET, Periscope computes the theoretical 0DTE straddle (nearest ATM call + put) and exposes its breakevens via a dropdown:

- **None** — no lines.
- **Cone** — yellow **diagonal dashed lines** on the price pane. Start wide at the 9:31 ET calculation point, converge toward the breakeven prices at the close. Tightens through the day as theta decays.
- **Breakeven** — yellow horizontal dashed lines at the breakeven prices. Stays fixed all day.

**Visual identification matters.** The Cone diagonals look superficially like a TA triangle pattern — they aren't. They're the market's priced-in expected move bounds. Identify the cone before reading anything else, because the bounds frame every other interpretation on the chart. If you see two diagonal yellow dashed lines tapering toward the right, that's the Cone — not a triangle, not a wedge, not a TA pattern.

**Cone width = market's expected daily move.** Half-width (distance from cone midpoint to one bound) ≈ ATM straddle premium. A 71-pt-wide cone on SPX prices in a ±35 pt expected move; a 30-pt-wide cone prices in tight chop.

**Cone asymmetry reflects put/call skew.** When the cone is roughly symmetric around its calculation-time spot, vol is balanced. When the lower bound is farther from spot than the upper bound (more downside room), the market is paying more for puts than calls — already pricing in downside skew. Trade thesis should respect that: long-side reward is capped at the upper cone, downside risk extends to the lower cone.

**Why the cone matters for trading:** when SPX exceeds the breakeven cone intraday, short-straddle sellers must buy back their short options to limit convex losses, and that buying _reflexively extends the move_. UW's empirical observation — confirmed by their first-minute volume data — is that breakouts beyond the cone tend to expand, not mean-revert. Treat a cone breach as a vol-acceleration setup, not a fade.

**Trade-thesis framing with the cone:**

- **Inside-cone targets** (e.g. a +γ magnet at +$15 from spot when cone is ±$35) = high-probability but low-reward. The market already expects the move; the trade is paying you for vol you could have collected by selling the straddle.
- **Outside-cone targets** = low-probability but high-reward (vol extension). The trade pays when the market under-priced vol.
- **Asymmetric cone** (e.g. lower bound twice as far from spot as upper) = setup is structurally favoring the side with more room. Don't fight the skew — if puts are priced richer, the path of least resistance has a downside skew.

### Reading historical / replay charts — discipline

When the user pastes a chart from a past timeframe and asks you to read it as if at that moment (post-mortem analysis, "what did the open say"), apply these rules:

1. **Ignore the red dotted spot price line.** That marker is _always live_ — it shows the chart's current spot at the moment of capture, which is usually after the timeframe being analyzed. For a back-read, it's future data; pretend it's not there.
2. **Read candles only up to the timeframe slice being analyzed.** The price pane shows the entire trading day; mentally crop it at the right edge of the slice. Anything to the right is what you're trying to _predict_, not input.
3. **The dots on the bars represent the prior 10-min slice from the captured timeframe.** They're "historical" in the captured frame's reference, so they're valid input for the back-read.
4. **The yellow dashed cone is anchored at the 9:31 ET calculation point** (= 8:31 CT). For any timeframe at or after the calc point, the cone is valid input. For earlier timeframes (e.g. an 8:20–8:30 CT pre-calc slice), the cone shown was drawn 1 minute later — treat it as "imminent" input.

The discipline matters because it prevents lookahead bias. A back-read that quietly references where price ended up isn't analysis — it's hindsight rationalization.

## Mode-specific protocol — pre_trade / intraday / debrief

The skill operates in a 3-mode lifecycle. Each mode has different inputs, allowed reasoning, and forbidden moves. **The mode is supplied at the top of the user message as `Mode: pre_trade | intraday | debrief`. Read it before anything else.**

### `pre_trade` mode — one read per day, at/before market open

Inputs: chart screenshot (required) + heat-map screenshots (optional — pre-trade can run chart-only with `greek_exposure_strike` morning DB snapshot covering the per-strike numbers). Authoritative spot from DB. No prior-read context (no parent chain).

Output: **the day's playbook** — regime call, key levels, bilateral triggers, trade types that fit this regime vs. types that don't, expected dealer behavior, confidence with a stated basis.

Forbidden: any reference to outcomes from worked examples in the skill (the user already knows them). Treat every chart as a fresh real-time read even when the date or structure resembles an example.

### `intraday` mode — N reads per day, every ~10 min slice

Inputs: chart + both heat maps (required) + parent chain summary in user content (today's pre-trade plus prior intraday reads). Authoritative spot from DB at `read_time`.

Output: **thesis maintenance** — does the pre-trade thesis still hold? What changed in the slice (orange bars, charm sign flips, new dominant strikes)? Did a trigger fire? What's the next leg?

Forbidden: contradicting the chain without explicit reasoning. The chain encodes the user's earlier (no-cheat) read; if you reverse the bias, state WHY (a specific structural change in the new slice). Don't quietly invert.

Hindsight is forbidden in the same way as pre-trade: only price action visible in the candle pane up to `read_time` counts. Anything to the right of that on the price pane is future data — pretend it's not there.

### `debrief` mode — one read per day, after close

Inputs: end-of-day chart + parent chain (today's pre-trade + last intraday). Hindsight is allowed and is the entire point.

Output: **honest scoring** — which triggers from the chain fired, at what times, what was the R:R; what the chart got right; what it missed; what (if anything) to add to the user's mental model. Use ✓ check-marks freely; "the chart was right" framing is allowed because the goal is scoring, not predicting.

Forbidden: nothing. But don't conflate "lucky" with "right." If the regime tag was wrong but the bias was right by coincidence (e.g. predicted a pin, got a gap-and-rip that happened to run to the same level), call it out — the chart wasn't right, the trader was lucky.

### Common to all modes — the chart is a map, not a compass

The chart tells you LEVELS, not DIRECTION. Direction is confirmed only by price action AFTER the open. Even in `intraday` mode where some price action is visible, your bias call must be defensible from the structure (gamma topology + charm sign), not from the candle slope. A read that just describes recent candles is failing the protocol.

Required structural reads regardless of mode:

1. **Levels** — dominant +γ above and below spot, −γ acceleration zones, cone bounds, dominant Position cluster, magnets, soft floors.
2. **Long trigger** — a specific price level above spot whose break confirms upside conviction.
3. **Short trigger** — a specific price level below spot whose break confirms downside conviction.
4. **Stops + targets pre-defined for both triggers.**
5. **No-trade zone** — the range between triggers where the chart says "wait."
6. **Regime label** — pin / drift-and-cap / gap-and-rip / trap / cone-breach / chop / other.

## The hedge primitive — gamma sign × price direction

This is the engine behind every read. The FAQ's worked examples reduce to one 4-case table:

| MM gamma at strike | If price moves… | MM hedge in /ES | Effect on tape                                  |
| ------------------ | --------------- | --------------- | ----------------------------------------------- |
| **−γ** (red)       | **Down**        | **Sell**        | Fuels decline (procyclical, "fuel on the fire") |
| **−γ** (red)       | **Up**          | **Buy**         | Fuels rally (procyclical)                       |
| **+γ** (green)     | **Down**        | **Buy**         | "Buys the dip" (suppressive)                    |
| **+γ** (green)     | **Up**          | **Sell**        | "Sells the rip" (suppressive)                   |

That's it. Memorize this table; everything else in the skill derives from it.

The reason it works: under the FAQ's naive delta-hedging model, MMs hold an option inventory and offset its directional exposure with /ES futures. As price moves, gamma changes the option's delta, so the hedge has to be re-sized. The sign of gamma determines whether the rebalance is _with_ the move (negative gamma = procyclical) or _against_ the move (positive gamma = suppressive).

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

|                       | Short OTM Put | Long OTM Put  | Short ITM Put | Long ITM Put  |
| --------------------- | ------------- | ------------- | ------------- | ------------- |
| **MM original hedge** | Short /ES     | Long /ES      | Short /ES     | Long /ES      |
| **Δ change (charm)**  | −0.25 → −0.24 | −0.25 → −0.24 | −0.75 → −0.76 | −0.75 → −0.76 |
| **MM hedge action**   | **Buy** /ES   | **Sell** /ES  | **Sell** /ES  | **Buy** /ES   |

Mnemonic for the OTM half (the most common case in 0DTE): **Long-OTM-Call + big red-leftward Charm bar = mechanical /ES BUY into the close.**

ITM flips the sign because charm pushes ITM delta _toward_ ±1 (gets more extreme), opposite to OTM where Δ decays toward 0.

**Important framing:** the Periscope chart already shows you the gamma sign directly via the bar colors. You don't actually need the Excel decoder to walk strike-by-strike — Charm bar direction (green/red) at a strike combined with whether the strike is above or below spot tells you the same thing the Excel does. Use the decoder when you want to be explicit about the call/put + OTM/ITM derivation; use the colors when you want to read fast.

## How to read the panels together

Each panel answers a different question per strike:

- **Positions** — "How big is the MM's contract inventory at this strike?" Sign = net long (green) or net short (red); magnitude = contract count. Read this for _which strikes matter_.
- **Gamma** — "How will MM hedging respond to a price move at this strike?" Sign + magnitude per the 4-case primitive. Read this for **support / resistance / acceleration topology**.
- **Charm** — "How will MM hedging drift just from time passing at this strike?" Read this for **mechanical EoD /ES drift direction**.
- **Vanna** — "How will MM hedging shift if IV moves?" Read this for **vol-event sensitivity** (when present).

**With Pass 1B injection, lead with the structured numbers, not the visual.** The injected GEX and Charm rows already rank-order the dominant strikes near spot by exact magnitude; use them directly to identify the +γ floor, +γ ceiling, charm-zero crossover, and the dominant magnet. Use the visual panels for what injection doesn't capture: dots (prior-slice momentum), orange/purple highlights, and far-strike structure outside the heat-map's central band.

Stories to extract, in priority order:

1. **Largest +γ values (green) within ±$30 of spot** → strongest pin / support / resistance candidates. These are the levels you quote for stops and targets.
2. **Largest −γ values (red)** → acceleration zones; price travels through them fast with no defense.
3. **Largest Charm values** → biggest mechanical EoD /ES drift contributors. Sum the signed contributions across visible strikes to get the day's net drift direction (the **net charm tally**).
4. **Largest Vanna bars** (visual only — Vanna isn't injected) → strikes most exposed to a vol shock. On event days matter as much as charm; on quiet days background.

Always cross-check Positions vs. Gamma at the same strike — when sign agrees (green Positions + green Gamma), you have a clean read. Sign disagreement is rare and usually means a complex multi-leg structure at that strike — read both signs as data points.

**Magnet identification — regime-modified:** the dominant magnet isn't always the largest +γ cluster. In an **active trending regime** (vol expanding, fixed-strike IV climbing day-over-day), price is drawn to the **largest dealer-short cluster** (largest red Gamma magnitude near or above spot in a rally, below spot in a sell-off) — that's where MMs are forced /ES chasers and the trend extends into the position they have to keep hedging. In a **settling regime** (vol relaxing, IV bleeding), price gravitates to the **largest dealer-long cluster** (largest green Gamma magnitude near spot) — that's where MM hedging suppresses motion and the day pins. When the chart shows both a large red cluster overhead and a large green cluster nearby, the regime determines which one acts as the magnet for the rest of the session: trending rally → red overhead pulls; settling chop → green nearby pulls.

## Trading rules — what the chart tells you to actually do

This is the section to lean on when the user asks "where do I put my stop" or "where should I exit."

### Conceptual split: stops vs. exits

- **Stops come from gamma topology** — strikes where dealers structurally defend price (large +γ green clusters).
- **Exits come from charm + vanna flow** — where dealer hedging is _actively_ pushing the tape via time decay or IV moves.

Don't confuse them. A profit target is where the directional flow runs out, not where the topology will mean-revert against you.

### Stop placement

- **Long stops go a few points BELOW the nearest +γ floor (green Gamma bar below spot)**, not at it. Price often wicks _into_ the floor before bouncing — a stop at the level gets stopped on the wick; a stop ~5–10 SPX points below survives the wick and only triggers if the floor truly breaks.
- **Short stops go a few points ABOVE the nearest +γ ceiling (green Gamma bar above spot)**, by the same logic.
- **Acceleration zones (large red Gamma bars) are not stop levels.** Price moves swiftly through them; placing a stop _inside_ a −γ zone means the stop fills several points worse than the trigger. Either widen past the −γ zone or don't carry the trade through it.
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

### Mode-aware time weighting

Charm magnitude is highly time-of-day dependent for 0DTE; how you weight it depends on the mode:

- **`pre_trade` (≤09:30 CT)** — Charm is small relative to gamma flow. The morning flow tally gives a _future_ drift, not a current one. Lean on Gamma topology for the day's levels; treat the charm tally as a directional tilt that strengthens through the session.
- **`intraday` 09:30–11:00 CT** — Same: gamma topology dominates, charm is a tilt.
- **`intraday` 11:00–13:30 CT** — Charm builds; flow tally becomes tradeable as a tilt. Pin candidates from the Gamma panel start to matter.
- **`intraday` 13:30–14:30 CT** — Charm dominates. Net flow is the primary directional read; pin candidate becomes specific.
- **`intraday` 14:30–15:00 CT** — Final 30 min. Charm flow is mostly consumed; pin compresses to nearest dominant +γ. **Self-igniting unwind risk dominates** — large +γ Position clusters with a shrinking dot are actively unwinding their /ES hedge in this window; check the unwind direction against the charm tally and pin candidate (see "Self-igniting expiry unwind"). MOC orders can override the chart in last 5 min, especially on rebalance / quad-witch days.
- **`debrief` (post-close)** — Time weighting is no longer predictive; the question shifts to "did the right band of charm magnitude actually translate into the realized drift?" — use the framework to score, not predict.

### Vol shock awareness (vanna + cone)

When present, the Vanna panel matters most on event days (FOMC, CPI, jobs):

- **Large positive Vanna bars overhead** → if IV jumps, dealers must buy /ES (their put-side hedging unwinds). On a vol-pop the rally extends through these levels.
- **Large negative Vanna bars below spot** → if IV jumps on a sell-off, dealers must sell more /ES. Acceleration to the downside.
- **On vol-crush days** (post-event IV drop), the same bars work in reverse: vanna-positive overhead unwinds into selling, vanna-negative below covers into buying. Pin compresses faster than charm alone implies.

The straddle breakeven cone is the cleanest standalone vol-shock signal: when price exceeds the cone, short-vol sellers reflexively buy back hedges and extend the move. Pair with vanna for the strike where the extension will hit hardest.

### Self-igniting expiry unwind — non-conditional EoD flow

Most Periscope reasoning treats dealer hedging as **conditional**: a price move (gamma) or time passing (charm) triggers a rebalance. Late in 0DTE, a third mechanic kicks in that's neither — **the hedge against an expiring option must converge to zero by settlement**, regardless of price action.

When MM holds a large position with a substantial /ES hedge tied to it, the **mechanical unwind** is itself a directional flow. No external catalyst required — the hedge has to leave because the option is leaving.

What this changes about the read:

- **Large green Positions cluster surrounded by −γ in the last 60 min** = self-starting reversal risk. The /ES that MMs accumulated to hedge the cluster gets sold back through the −γ band below; the procyclical hedging in that band amplifies the unwind once it starts. The pin can break the wrong way with no external trigger.
- **Direction of the unwind is set by the hedge sign, not by where price is moving.** A large MM long-call cluster above spot (MM was originally short /ES against the calls) → unwind is /ES BUYING into the close. A large MM long-put cluster below spot (MM was originally long /ES against the puts) → unwind is /ES SELLING into the close.
- **Slice diagnostic:** when the dot on a large +γ Positions bar is meaningfully larger than the bar (position is shrinking) and you're inside the last 60 min, you're watching the unwind happen in real time. The /ES it generates is a tradeable directional flow distinct from the charm tally.

Distinguish from charm: charm flow is gradual delta drift over time. Unwind flow is the residual hedge being closed because the option ceases to exist. They usually point the same direction; flag the read explicitly when the unwind sign disagrees with the net charm tally — the unwind typically wins in the last 30 min.

### Long-skew regime watchout

The standard read above assumes the **normal regime** — customers long stock + long puts + short calls, dealers as the inverse counterparty (short puts + long calls), with suppressive +γ hedging above price. In a **long-skew regime** the dealer book inverts (customers chasing calls instead of selling them; 3M 25Δ skew at historical lows), and the same chart reads differently. **Vanna and charm sign-flip alongside gamma** at the dealer-short strike — every Greek that normally produces suppressive hedging above the dealer-long strike now produces procyclical hedging in this regime.

- **Red-bar clusters above price become fade fuel, not breakout fuel.** Rallies into them extend in the moment (forced MM chasing UP) but tend to fade as IV later decays and the same /ES purchases reverse into passive selling.
- **Vol-decay forced selling is a third drift mechanism** alongside delta (price moves) and charm (time decay). Price stalled below short-call strikes with rich IV produces passive MM /ES selling as IV bleeds — even with no directional move.
- **Live fingerprint, no infra required: spot/vol positive correlation.** If VIX is rising with SPX (not against it), treat ceiling reads with extra caution; the structural defense above may be inverted.
- **Exit timer is the vol flatline, not the price reversal.** Vol can't climb forever — once daily fixed-strike IV change rolls to zero with spot still elevated, the mechanical unwind is imminent (the /ES bought to hedge the short-call book gets sold back regardless of news). Switch long-side reads from "drift target" to "exit watch" at the flatline, not when candles turn.

This is an interpretive overlay, not a quantitative regime gate. The 25Δ-90D skew percentile is not yet ingested in this codebase, and the relationship has not been validated against SPX 0DTE outcomes here. See `references/vol-signals-mm-heuristics.md` Section 1 ("Long skew" regime: inverted dealer book makes tops unstable) for the full mechanic plus the live 2026-04-14 → 2026-05-13 example and the trade frame. When the spot/vol fingerprint is visible live, downgrade confidence on red-bar-cluster breakout reads above spot and flag the "chase-and-fade" pattern as a possibility.

### Futures execution — the permission/prohibition framing

The 4-case hedge primitive tells you which directions MM hedging will FUEL vs. FIGHT. For directional futures execution this maps to a permission/prohibition rule:

- **+γ above spot (green ceiling)** → MM SELLS the rip → fights longs into the level → **avoid naked longs that target the level** (use options structures instead, or wait for cone-breach behavior).
- **−γ above spot (red acceleration zone)** → MM BUYS the rip → fuels longs through the level → **safe direction; long is permitted**.
- **+γ below spot (green floor)** → MM BUYS the dip → fights shorts into the level → **avoid naked shorts that target the level** (the floor will catch you).
- **−γ below spot (red acceleration zone)** → MM SELLS the dip → fuels shorts through the level → **safe direction; short is permitted**.

The output `futures_plan` field carries this as three labeled sections (`LONG:`, `SHORT:`, `WAIT:`) tying each verdict to a specific +γ/−γ level. The user's directional bet is fundamentally a bet on which side of the next regime boundary the chart sits — fighting the dealer hedge direction is the trap to flag.

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

> **Counterpoint example available on demand:** A trap-day pattern (2026-04-29, asymmetric cone + missing +γ floor) lives in `references/worked-example-2026-04-29-trap-day.md`. Cite it when an analogous setup appears.

## Expiry check — the user trades 0DTE only

**Before any read, check the Expiry field in the top control bar against the chart's Date.** If the expiry is later than the chart's date, the chart is showing N-DTE positioning (1DTE, 2DTE, etc.), not 0DTE. The user only trades 0DTE — STOP and tell them to switch the expiry to today's date before continuing.

How to spot the mismatch:

- **0DTE:** Expiry date == chart date (e.g. Date: Fri Apr 24 / Expiry: 2026-04-24).
- **N-DTE:** Expiry date > chart date (e.g. Date: Fri Apr 24 / Expiry: 2026-04-30 = 6DTE).

Why it matters:

- **Charm bar magnitude scales radically with DTE.** 0DTE charm runs ±60K–120K (or larger). 6DTE charm runs ±30K-50K. A 6DTE chart's charm bars look small and miss the day's actual flow — you'd under-call mechanical /ES drift.
- **Cone width changes too.** 0DTE cones are tight (40–70 pts on calm days); multi-DTE cones widen with the longer-dated straddle premium.
- **Dominant strikes shift.** Different expiries have different MM positioning concentrations — the 0DTE magnet is often at a different strike than the 6DTE magnet. Reading the wrong expiry's structure leads to the wrong target.

A correct 0DTE chart for the user will have a same-day expiry; anything else is a misconfigured view and the read will be wrong even if mechanically applied.

**3rd Friday AM monthly expirations — overnight context flag:** SPX has both PM (daily 0DTE) and AM (3rd Friday monthly, settling at the morning open) expirations. The user trades only PM 0DTE, so the same-day expiry rule still holds. But on a Thursday before a 3rd Friday AM expiry, the AM expiration's dealer hedges unwind into Friday's open — a self-igniting unwind on the largest-positioning expiry of the month. That flow can produce overnight directional pressure and an unusually directional open print that frames the PM 0DTE chart you'll be reading. If a major AM expiration is in play tomorrow, factor the expected open-print direction (driven by which side the AM hedge unwind clears) into the morning context; don't read the PM chart in isolation.

## Structured trading playbook output

The output that makes this skill actually actionable is a **structured trading playbook** — not a free-form narrative. The prose section walks through the structural read (regime, levels, charm tally, vol-shock context, mode-specific framing), and the response ends with a fenced JSON code block carrying the typed fields the backend persists for retrieval / similarity / frontend rendering.

### Output structure (prose)

The prose section, in this order:

1. **Setup at slice end** — current spot (use the authoritative `spot` injected in the user message; ignore the chart's red dotted line for back-reads) + immediate context.
2. **Structural map** — gamma + charm + positions key strikes with exact magnitudes (quoted from the injected heat-map values).
3. **Charm flow tally** — net direction (Buy /ES vs. Sell /ES) summed across visible strikes.
4. **Trade thesis with bilateral triggers** — long trigger, short trigger, stops, targets, R:R per side, no-trade zone.
5. **Regime label** with one-sentence basis.
6. **(intraday/debrief only) Parent-chain reconciliation** — does this read agree with the prior reads in the chain? If reversing, state why.
7. The required JSON block at the very end.

### Required: structured fields JSON block at end of response

When this skill is invoked from the `/api/periscope-chat` endpoint (i.e. anywhere the response is being persisted), **always end your response with a fenced JSON code block** containing the schema below. The server strips this block from the prose before saving + displaying, then parses it into typed columns. **This is non-negotiable** — fields must match the exact shape, with `null` for anything not applicable.

Append exactly:

````
```json
{
  "spot": <number | null>,
  "cone_lower": <number | null>,
  "cone_upper": <number | null>,
  "long_trigger": <number | null>,
  "short_trigger": <number | null>,
  "regime_tag": <"pin" | "drift-and-cap" | "gap-and-rip" | "trap" | "cone-breach" | "chop" | "other" | null>,
  "bias": <"long-only" | "short-only" | "fade-only" | "two-sided" | "no-trade" | null>,
  "trade_types_recommended": [<trade-type enum string>, ...],
  "trade_types_avoided": [<trade-type enum string>, ...],
  "key_levels": {
    "gamma_floor": <number | null>,
    "gamma_ceiling": <number | null>,
    "magnet": <number | null>,
    "charm_zero": <number | null>
  },
  "expected_dealer_behavior": <string | null>,
  "confidence": <"low" | "medium" | "high" | null>,
  "confidence_basis": <string | null>,
  "futures_plan": <string | null>
}
```
````

### Field semantics

- **`spot`** — SPX spot at the read time. Use the authoritative value supplied in the user message (DB lookup against `index_candles_1m`); never the chart's red dotted line on a back-read.
- **`cone_lower` / `cone_upper`** — straddle breakeven cone bounds in price (yellow dashed). `null` if cone not visible.
- **`long_trigger` / `short_trigger`** — bilateral entry triggers per the protocol. `null` if your read concluded "no-trade" on that side.
- **`regime_tag`** — single-label classification: `pin` / `drift-and-cap` / `gap-and-rip` / `trap` / `cone-breach` / `chop` / `other`. Use `"chop"` for symmetric cone-bounded chop with no clean directional read; `"other"` only when no listed pattern fits.
- **`bias`** — overall directional posture for the day:
  - `long-only` — structure favors long entries; short trades fight the structure
  - `short-only` — opposite
  - `fade-only` — both directions valid but only off explicit triggers (most chop days)
  - `two-sided` — both directions tradeable with their own setups
  - `no-trade` — chart says wait
- **`trade_types_recommended`** / **`trade_types_avoided`** — arrays from the trade-type enum below. Type the structures the structure SUPPORTS in `recommended`; type the structures it FIGHTS in `avoided`.

Trade-type enum:

```
"debit_call_spread", "debit_put_spread",
"credit_call_spread", "credit_put_spread",
"iron_condor", "iron_butterfly", "broken_wing_butterfly",
"directional_long_call", "directional_long_put",
"naked_directional_call", "naked_directional_put",
"calendar_spread", "diagonal_spread",
"long_straddle", "long_strangle"
```

- **`key_levels`** — the concrete price anchors for the day:
  - `gamma_floor` — nearest dominant +γ strike below spot (long stops go just below this)
  - `gamma_ceiling` — nearest dominant +γ strike above spot (long targets go to this; short stops go just above)
  - `magnet` — strike with the largest Positions or Gamma magnitude near spot — the gravitational center of the day
  - `charm_zero` — strike where the net charm sign flips between supportive (+γ buying) and procyclical (−γ selling), if identifiable
- **`expected_dealer_behavior`** — one-sentence forecast: _"passive bid below 7,250, passive offer above 7,275 — range-bound until either side breaks."_ Concrete, mechanism-first; not opinion.
- **`confidence`** — `low` / `medium` / `high`. Calibrated against:
  - **High** — twin-strike +γ floor + matching charm sign + intraday parent chain agrees + clean cone
  - **Medium** — single dominant level + reasonable charm tally + no contradicting orange bars
  - **Low** — fragile structure (no nearby +γ floor, mixed charm), cone-breach setup, or major event window with vanna unknown
- **`confidence_basis`** — required when `confidence != null`. One sentence stating WHY: a specific structural fact, not "looks good" / "feels right."
- **`futures_plan`** — a generic directional-execution string for the user's directional futures trades (they trade NQ + ES interchangeably). Three sections, separated by blank lines:
  - **`LONG:`** — explicit go/no-go and reason tied to MM positioning above spot. State whether long is SAFE (MM hedging will fuel the move or stay out of the way), CONDITIONAL (allowed only on a specific level reclaim/break), or AVOID (MM hedging will fight you). Always tie the verdict to a specific +γ/−γ level. No R:R math; just where to enter, where to exit, and why the direction is safe or dangerous given dealer hedge sign.
  - **`SHORT:`** — symmetric, focused on MM positioning below spot. Same verdict + level tie + no math.
  - **`WAIT:`** — the no-trade zone (price band where dealer hedging is mixed and scalping fights both directions).
    Use generic "LONG" / "SHORT" — do NOT lock to a specific contract. Levels are SPX-priced (the contract the user picks just sizes against the same level structure). `null` only when the chart genuinely supports neither direction at any level (rare; debrief mode usually has at least one direction's verdict to record).

For ad-hoc conversational reads outside the persistence endpoint, this block is optional but doesn't hurt. When in doubt, include it.
