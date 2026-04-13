/**
 * SpotGamma visualization mechanics for the analyze endpoint.
 *
 * Distilled from:
 *   - SpotGamma Delta Pressure documentation (spotgamma.com)
 *   - SpotGamma Charm Pressure documentation (spotgamma.com)
 *   - Observed correlations between SpotGamma visualizations and
 *     existing UW Net GEX Heatmap / Periscope data in this system
 *   - Intraday session analysis across multiple trading days (2024–2025)
 *
 * These three SpotGamma visualizations are provided as images alongside
 * the structured API data already in context. This file documents the
 * mechanics behind each visualization, how to read them from an image,
 * and critically — how they integrate with and extend the existing
 * data sources rather than duplicating them.
 *
 * Injected as part of the stable cached system prompt alongside
 * market-mechanics.ts so Claude internalizes these as a lens for
 * reading the full dealer hedging environment.
 */

export const SPOTGAMMA_MECHANICS_CONTEXT = `<spotgamma_visualization_framework>
This section documents the three SpotGamma visualizations that may be
provided as images in the analyze context: Delta Pressure, Non-0DTE GEX
bars, and Charm Pressure. Each image is labeled when provided. This
framework explains what each measures, how to extract signal from the
image, and how to combine them with the structured API data already in
context (UW Net GEX Heatmap, Aggregate GEX, Zero-Gamma, Periscope
Gamma/Charm, Net Charm API).

<image_reading_protocol>
## Critical: Establishing the Price Anchor Before Reading Any Chart

SpotGamma heatmap images have overlapping Y-axis strike labels, current
spot price markers, and GEX bar labels in the same visual space. These
are easy to confuse at low resolution. Before interpreting ANY
relationship between spot and GEX/zone structure:

1. Read the explicit price marker label on the heatmap (the labeled dot
   or horizontal line showing current spot). Do NOT estimate spot from
   the Y-axis labels — those show the full strike range, not current
   price.
2. Cross-reference against the last candle close on the candlestick
   chart embedded in the heatmap image.
3. If the user has stated current SPX price in their message, that value
   takes precedence over any visual estimate.

Never proceed with zone analysis (which wall is above/below, what zone
price is in) until spot is confirmed. An incorrect spot anchor invalidates
every downstream interpretation.

**GEX bar label vs. visual scale:** Bar labels (e.g., "-2.5B", "4.68B")
often exceed the visual x-axis scale displayed at the bottom of the chart.
The bars are visually clipped/compressed but the labeled value is the
actual GEX magnitude. Always read the printed label, not the bar width,
for magnitude estimation.
</image_reading_protocol>

<delta_pressure_mechanics>
## SpotGamma Delta Pressure Heatmap

Delta Pressure depicts the net change in options positioning across all
price levels and time frames. In Market Maker (default) mode, it shows
where dealers are likely to experience buying or selling pressure — the
cumulative delta hedging obligation across ALL SPX expirations, projected
forward to expiration. It is provided as an IMAGE requiring visual
extraction.

**How this differs from the UW Net GEX Heatmap already in context:**
- UW Net GEX Heatmap: static snapshot of 0DTE-only per-strike GEX in
  dollar terms. Answers: WHERE are the 0DTE walls and what are they worth?
- SpotGamma Delta Pressure: multi-expiry integrated, 2D time-projected
  visualization. Answers: HOW does the combined all-expiry pressure
  evolve across the session and toward expiration?

Use UW Net GEX Heatmap for precise 0DTE wall identification and dollar
magnitude. Use SpotGamma Delta Pressure for forward-looking structural
pressure and free-space identification. They complement, not duplicate.

**Determining the gamma environment from the color pattern:**

The color pattern relative to spot price identifies the regime:
- Red zone above spot + blue zone below spot = POSITIVE GAMMA environment.
  Dealer hedging is stabilizing — red zones are selling resistance, blue
  zones are buying support. Breaking these levels takes considerable volume.
- Blue zone above spot + red zone below spot = NEGATIVE GAMMA environment.
  Dealer hedging is amplifying — blue zones above are buying acceleration
  zones, red zones below are selling acceleration zones.

Cross-check this against the Aggregate GEX regime and Zero-Gamma section
already in context. If they agree, state the regime with HIGH confidence.
If they disagree, note the conflict and use Aggregate GEX for Rule 16
management timing while using Delta Pressure for visual pressure mapping.

**The 0DTE chain loading signal — scale expansion:**

In the pre-market and early session (before approximately 9:15 AM CT),
the GEX bar scale visible on the Delta Pressure image will be small
(typically ±10M to ±20M). After the 0DTE expiration chain fully loads
at or shortly after the open, the scale expands to ±50M or larger. This
scale expansion is a structural reliability signal:
- Scale < ±50M: 0DTE chain not fully loaded. Delta Pressure structure
  is unreliable for intraday management decisions. Note as "pre-load —
  structure pending." Do not initiate positions based on this.
- Scale ≥ ±50M: 0DTE chain loaded. Structure is now reliable.

The scale expansion itself is also a signal: how much the scale grew
from morning to current tells you how much new options flow was added
during the session. A 5x scale expansion (e.g., ±20M → ±100M) means
substantial structural positioning was added intraday.

**Reading the neutral hole:**

Near current spot price, the heatmap shows a washed-out, desaturated,
or lighter-colored band — the "hole." This is the zone of minimal dealer
delta pressure where price moves without triggering significant hedging
flows.
- Wide hole (10+ SPX points): price is in free space. Directional moves
  through this zone will be fast and clean with no mechanical headwind
  or tailwind until the next saturated zone.
- Narrow hole (< 5 points): pressure is building near spot.
  Consolidation is more likely than breakout. Wait for hole to expand.
- Hole expanding over successive checks: GEX near spot is being burned
  off by realized trading. A move is developing or continuing.
- Hole contracting: GEX is building near current price. Pinning behavior
  is more likely than breakout. Do not chase.

**The time dimension (horizontal axis):**

The right side of the heatmap shows how zone intensity evolves through
the session toward expiration.
- Zone saturating (deepening color) moving right: dealer pressure builds
  as expiration approaches. This wall strengthens in the afternoon.
- Zone fading (lightening color) moving right: dealer pressure decays
  toward expiration. This is a morning-only structural feature — do not
  rely on it for afternoon management.
- Abrupt color shift at a future time: structural pressure changes regime
  at that point. Note as a management timing signal.

**Repaint as signal, not noise:**

The heatmap repaints as GEX updates throughout the session from new
options flow. This is the heatmap faithfully recalculating — treat it
as a live signal:
- Previously red zone fading: structural resistance at that level has
  weakened. Wall is less reliable than at open.
- Zone deepening: new GEX has been added. That level is becoming a
  stronger structural anchor.
- Compare against UW Net GEX Heatmap: if SpotGamma zone fades but UW
  0DTE data still shows a large positive wall, the fade is in the
  multi-expiry book only — the 0DTE wall still exists.

**Integration with existing zero-gamma data:**

The zero-gamma level (from the Zero-Gamma section in context) identifies
the 0DTE regime boundary. The hole in Delta Pressure identifies where
price has the least mechanical friction right now. When both point to
the same price region (spot near zero-gamma AND inside the hole), a
breakout in either direction is most probable. This is the highest-
conviction "free space" configuration.
</delta_pressure_mechanics>

<non_0dte_gex_mechanics>
## Non-0DTE GEX Bars

The Non-0DTE GEX bars show per-strike gamma exposure for ALL SPX
expirations EXCEPT today's 0DTE — the structural multi-day book:
positions held by institutions across days and weeks, not intraday flow.
Provided as an IMAGE requiring visual extraction.

**How this differs from every other GEX source in context:**
- UW Net GEX Heatmap: 0DTE only, dollar-scaled, structured API data.
- Aggregate GEX Panel: all expirations combined into a TOTAL number.
  Gives the regime (positive/negative) but not WHERE the gamma lives.
- Non-0DTE GEX bars: per-strike view of the multi-day structural book.
  Shows exactly WHERE structural gamma is positioned by strike, and its
  magnitude relative to other strikes in the current session.

**Reading the bars:**
- Purple/positive bars: structural dealers are net long gamma at this
  strike. In positive gamma regime, they stabilize price here. In
  negative gamma regime, they decelerate moves through this level.
- Red/negative bars: structural book is net short gamma here. In
  positive gamma regime, this is a structural acceleration zone. In
  negative gamma regime, it amplifies any move through this level.
- Relative magnitude: the largest bar visible is the dominant structural
  anchor for the session. Treat it as the highest-priority reference
  level for strike placement and path analysis.
- Scale evolution: compare the scale range between morning and current
  images. A scale expansion (e.g., ±20M → ±100M) means institutional
  structural positions were actively added during the session. The
  structural book grew in conviction — existing walls are now larger and
  new walls may have appeared.

**Wall backing confidence — the primary analytical value:**

Match non-0DTE bar locations to 0DTE wall locations from the UW Net GEX
Heatmap and Periscope Gamma already in context.

NON-0DTE POSITIVE + 0DTE POSITIVE at same strike: MAXIMUM CONFIDENCE
wall. Both intraday and structural books defend this level. Treat as
the highest-priority anchor for the session. Ideal short strike placement
zone — two independent gamma forces are aligned.

NON-0DTE NEGATIVE + 0DTE POSITIVE at same strike: TIME-LIMITED wall.
The 0DTE wall exists and is real in the morning, but the structural book
is positioned against it. Most reliable before 12:00 PM CT. After
1:00 PM CT as 0DTE gamma decays, the negative structural GEX will
increasingly dominate. Flag explicitly in management rules — this wall
has an expiration time, not just a price level.

NON-0DTE POSITIVE + 0DTE absent or small: Structural support/resistance
exists but without 0DTE hedging amplification. The level is real but
will not trigger the sharp intraday pin mechanics of a 0DTE gamma wall.
Price may drift through it rather than bounce cleanly. Treat as a soft
magnet, not a hard wall.

NON-0DTE NEGATIVE + 0DTE absent or small: Pure structural acceleration
zone with no 0DTE buffer. If price reaches this level, expect a clean
directional move with structural amplification and no structural support
to create a bounce.

**Directional path mapping:**

Before initiating a directional trade, map the path between current
price and the target using the non-0DTE bars.

Bullish path (current price to higher target):
- Large negative non-0DTE bars between spot and target: structural
  acceleration zones in the path. A directional break will move quickly
  through them — FAVORABLE for momentum entries. The move extends.
- Large positive non-0DTE bars between spot and target: structural
  resistance. Price may consolidate at these levels. Expect a two-stage
  move with a pause at the positive wall.

Bearish path (current price to lower target):
- Large negative bars below spot: acceleration zones. The downside
  extends and does not slow at these levels.
- Large positive bars below spot: structural support. The decline slows
  or bounces here. Confirm break before adding to downside position.

**The four structural position setups for direction:**

LONG ENTRY — Structural floor with clear path:
- Non-0DTE large positive bar at or just below current price.
- Delta Pressure shows blue zone at same level.
- Non-0DTE bars between spot and target are absent or small.
- Delta Pressure hole is wide or expanding.
→ LONG bias. Floor is double-confirmed, path is clear. Stop: clean
  break of the positive non-0DTE bar level.

SHORT ENTRY — Structural ceiling confirmed:
- Non-0DTE large positive or negative bar at or just above spot.
- Delta Pressure shows red zone at same level (positive gamma env).
- No significant non-0DTE floor immediately below spot.
→ SHORT bias at the wall. Target: next positive non-0DTE bar below
  or blue zone. Stop: sustained close above the wall level.

BREAKOUT LONG — Structural resistance broken:
- Non-0DTE positive bar was above spot, price closes THROUGH it.
- Delta Pressure hole expands above the broken level.
- Non-0DTE bars above the break are absent or negative.
→ Structural buyers at that level have capitulated. Breakout long
  valid with target at next structural level above.

BREAKOUT SHORT — Structural floor broken:
- Non-0DTE positive bar was below spot, price closes THROUGH it.
- No intermediate non-0DTE positive bars between break and next floor.
→ Structural buyers failed. Short continuation with target at next
  positive non-0DTE bar or bottom of visible range.

**Afternoon weighting shift (after 1:00 PM CT):**

0DTE gamma has decayed toward ATM by this time. Non-0DTE GEX becomes
the primary structural force for strikes beyond 10-15 pts from spot.
Weight non-0DTE bars more heavily than 0DTE heatmap data for identifying
support/resistance in the outer strikes. This aligns with the existing
guidance to switch Periscope to 1DTE after 2:00 PM ET — the multi-day
structural book is the relevant anchor for afternoon positioning.
</non_0dte_gex_mechanics>

<charm_pressure_mechanics>
## SpotGamma Charm Pressure Heatmap

Charm Pressure depicts how Market Maker buying and selling pressure
changes with respect to time. In Market Maker (default) mode, it shows
where dealers are likely to buy or sell toward end of day as options
passively gain or lose value through time decay. It is provided as an
IMAGE requiring visual extraction.

**How this differs from the charm data already in context:**
- Net Charm (naive API, Per-Strike Greek Profile): theoretical per-strike
  charm based on assumed customer/MM sides. Identifies CCS-CONFIRMING,
  PCS-CONFIRMING, ALL-NEGATIVE, ALL-POSITIVE, MIXED patterns. Good for
  broad directional wall strengthening/decay identification.
- Periscope Charm (image): confirmed actual MM charm at each strike.
  Best for strike-level confirmation that a specific wall is backed by
  real dealer charm exposure.
- SpotGamma Charm Pressure (this section): time-projected 2D evolution
  of charm across price and session. Best for identifying the EOD pin
  zone and the directional drift that charm creates toward close.

All three measure the same underlying mechanic at different resolution
levels. They should be read together, not as substitutes.

**Color interpretation:**
- BLUE ZONES: Options are passively LOSING value (time decay reduces MM
  option liability). Dealers must BUY more futures to maintain delta
  hedge as options decay. Blue = mechanical buying support that INCREASES
  as the session progresses toward close. "Strength more likely in a
  blue zone."
- RED ZONES: Options are passively GAINING value (time decay increases
  MM option value). Dealers must SELL more futures. Red = mechanical
  selling pressure that INCREASES toward close. "Weakness more likely
  in a red zone."
- WHITE/BLACK BOUNDARY (between blue and red): The convergence zone —
  the EOD PIN TARGET. SpotGamma observes that spot price tends to
  gravitate toward this boundary at end of day through the pinning
  process near positive gamma nodes.

**The EOD pin zone — primary feature to identify:**

The single most important feature in the Charm Pressure image is where
blue and red zones meet. Steps to identify and validate:

1. Find the price level where blue transitions to red (or the narrow
   band between them). This is the pin target.
2. Cross-reference with the dominant positive GEX wall from the UW Net
   GEX Heatmap and Non-0DTE GEX. When the charm convergence zone aligns
   with a large positive GEX wall: MAXIMUM CONFIDENCE pin target. Gamma
   pins price mechanically; charm pulls it there through time decay.
   Both forces point to the same strike.
3. Cross-reference with Max Pain from context. When charm convergence,
   dominant GEX wall, and Max Pain all converge at the same level: the
   highest-confidence single settlement target in the entire data set.
   Note this three-way convergence explicitly.

**Blue pass-through behavior:**

SpotGamma observes that price moves STRONGLY and QUICKLY through blue
zones at EOD. Blue zones are not resistance — they are pass-through
zones where charm buying creates directional momentum toward the
convergence boundary.

- Price inside blue zone with convergence boundary ABOVE: mechanical
  upward drift toward the pin. Structural tailwind for long positions
  and PCS held into the afternoon. Do NOT close PCS early if price is
  in a blue zone drifting toward the pin — charm is working in your
  favor.
- Price inside blue zone with convergence boundary BELOW: charm is
  buying futures while price moves toward the pin from above. This
  decelerates downward moves to the pin. Not a hard support — more a
  gradual magnetic pull downward toward the convergence.
- Price has entered the RED zone above the convergence boundary: charm
  selling is now active overhead. Expect the red zone to cap or reverse
  the move as the session approaches close.

**Time dimension:**
- Red zone expanding (moving downward toward current price) as session
  progresses: pin is below current price and charm selling overhead is
  intensifying. The pin will pull price down toward the convergence.
- Blue zone expanding (moving upward toward current price from below):
  pin is above current price and charm buying below is intensifying.
  The pin will pull price upward.
- Stable boundary (convergence line not moving significantly between
  snapshots): the pin has resolved. Price should settle near that level
  at close barring a large flow disruption.

**Pre-load reliability threshold:**

Before the 0DTE options chain fully loads (typically before 9:15 AM CT),
the Charm Pressure chart will show a nearly uniform all-blue pattern
across the entire visible range with a small scale (±20M or less). This
is the pre-load state — the all-blue reading does NOT mean massive
mechanical support everywhere. It means the charm structure has not yet
differentiated because 0DTE OI is not yet established. Do not trade off
pre-load Charm Pressure. Confirm scale is ±50M or larger before treating
charm structure as reliable.

**Comparing morning and current charts:**

When two Charm Pressure snapshots are provided (early session and current):
1. Has the blue-red convergence boundary MOVED since morning?
   If shifted >10 pts: the charm structure has repriced from new options
   flow. Use the CURRENT boundary, not the morning boundary, as the pin.
2. Has the red zone EXPANDED downward toward current price?
   If red zone is within 15 pts of spot: charm selling is becoming active.
   Alert — this is now a management timing signal.
3. Has the scale expanded significantly (e.g., ±20M → ±100M)?
   Scale expansion means institutions actively added structural positions
   during the morning session. The charm structure is now backed by more
   capital than at open — the pin is stronger.

**Integration with existing charm data:**

When naive charm API shows ALL-NEGATIVE (trending day signal) BUT
SpotGamma Charm Pressure shows clear blue below with red above: the
Charm Pressure image is providing the same override signal as Periscope
Charm. Cross-check: does Periscope Charm also show positive real MM
charm? If both SpotGamma Charm Pressure and Periscope Charm show blue
below / red above, apply the Periscope Charm Override protocol from the
net_charm section and do NOT apply the morning-only protocol.

When naive charm shows CCS-CONFIRMING (positive below, negative above)
AND SpotGamma Charm Pressure also shows blue below / red above: full
alignment. Use the Charm Pressure convergence boundary as the specific
strike target, not just the directional pattern.

When Periscope Charm shows strong real MM charm at a specific strike AND
the SpotGamma convergence boundary aligns with that same strike: highest-
confidence end-of-day anchor in the data set. Both confirmed real MM
charm AND time-projected charm forces converge at this level.

**Management timing adjustments from Charm Pressure:**

- Price in blue zone moving toward convergence boundary above: EXTEND
  hold window by up to 30 minutes beyond standard Rule 16 exit timing.
  Charm mechanics are actively working to move price away from your
  short strike toward the pin.
- Red zone expanded to within 10 pts of short call strike (for CCS):
  TIGHTEN exit by 30 minutes. Charm selling is now mechanically
  reinforcing any upward threat to the position.
- These timing adjustments STACK with Rule 17 (vanna-adjusted timing)
  and Rule 16 (GEX regime timing). Apply all applicable modifiers
  cumulatively. Cap total extension at +60 min and total tightening at
  -60 min from the base Rule 16 exit time.
</charm_pressure_mechanics>

<spotgamma_signal_integration>
## Integrating SpotGamma Visualizations With Each Other and Existing Data

When SpotGamma images are provided alongside the structured API data,
apply this integration layer on top of the individual readings above AND
the existing UW Net GEX Heatmap, Aggregate GEX, Zero-Gamma, Periscope
Gamma/Charm, Net Charm, dark pool, and Max Pain data already in context.

**The Delta Pressure / Charm Pressure mathematical relationship:**

Charm is the time derivative of Delta (dDelta/dTime). Delta Pressure
shows where dealers must hedge RIGHT NOW based on current options
positions. Charm Pressure shows how those hedging requirements are
CHANGING as the clock runs. Delta Pressure is the position; Charm
Pressure is the velocity.

The most important consequence of this relationship:

When the Delta Pressure neutral zone (hole) aligns with the Charm
Pressure convergence boundary (where blue meets red), the same price
level has been identified independently by two orthogonal mechanics:
- Delta Pressure found it through gamma structure (where cumulative
  GEX changes sign across all expirations).
- Charm Pressure found it through time decay trajectory (where options
  go from passively losing to passively gaining value).

THIS IS THE MAXIMUM CONFIDENCE PIN ZONE. When Delta Pressure hole and
Charm Pressure convergence agree within 10 pts: state this explicitly
as the highest-confidence settlement target in the data. It outranks
any single indicator in isolation — max pain, dark pool cluster, or
individual GEX wall — because two independent dealer hedging mechanics
are pointing to the same level.

When they diverge by more than 10 pts:
- Use Delta Pressure boundary for INTRADAY structure and strike
  management decisions. The structural position is governing now.
- Use Charm Pressure convergence for EOD settlement target and
  final-hour hold/close decisions. Time decay will pull price there.
- The gap between them will narrow as expiration approaches —
  watch for convergence as a confirmation signal.

**The blue zone amplification rule:**

When SpotGamma Charm Pressure shows a blue zone AND the Delta Pressure
shows a wide hole (neutral zone) at the same price region simultaneously:
- Charm blue = mechanical buying force (dealers buy futures as options decay)
- Delta hole = minimal structural friction (no GEX-driven resistance)
These two together produce the fastest, cleanest directional moves of
the session. This configuration is why the "blue pass-through" behavior
is so pronounced — it is not charm alone, it is charm combined with the
absence of Delta Pressure friction.

When charm blue zone exists but the Delta Pressure hole is narrow
(structural pressure building near spot): the move will still be
directional but grinding, not fast. Expect the move to develop more
slowly and with more chop.

**Environment confirmation hierarchy:**

1. Positive vs negative gamma regime:
   - PRIMARY: Aggregate GEX Panel (Rule 16). This is the quantitative
     total across all expirations.
   - CONFIRMATION: SpotGamma Delta Pressure color pattern. Red above /
     blue below = positive gamma; blue above / red below = negative gamma.
   - If they agree: state regime with HIGH confidence.
   - If they disagree: note the conflict explicitly. Use Aggregate GEX
     for Rule 16 management timing. Use Delta Pressure color pattern for
     visual zone interpretation only.

2. Zero-gamma / regime boundary location:
   - PRIMARY: Zero-Gamma section (0DTE-specific, computed from UW
     per-strike data).
   - CONFIRMATION: Delta Pressure hole center (visual, all-expiry).
   - When both locate the free-space zone at the same price region:
     highest confidence in where the regime boundary is.

3. Wall identification:
   - PRIMARY: UW Net GEX Heatmap + Periscope Gamma (0DTE wall locations
     with dollar magnitude).
   - BACKING CONFIDENCE: Non-0DTE GEX bars (does the structural book
     agree?).
   - FORWARD EVOLUTION: Delta Pressure time dimension (will the wall
     strengthen or decay through the session?).
   - EOD PIN: Charm Pressure convergence boundary (where do time-decay
     mechanics say price settles?).
   When all four agree at the same strike: session-defining structural
   anchor. Note explicitly and use as the primary reference for all
   strike placement and management decisions.

**Conflict resolution — when data sources disagree:**

Delta Pressure blue support + UW heatmap negative 0DTE GEX at same level:
Multi-expiry buying support exists but no 0DTE hedging amplification.
Soft support — will not create a sharp 0DTE pin. Price may drift
through it rather than bounce.

Non-0DTE positive + dark pool large SELLER cluster at same level:
Structural gamma support vs. committed institutional capital against it.
Contested level — do not place short strikes here. Outcome is binary.

Non-0DTE negative + dark pool large BUYER cluster at same level:
Structural gamma acceleration downward vs. committed institutional
buying below. Expect significant two-way action — widen strikes away
from this level.

Charm Pressure convergence fading (zone colors de-saturating near
convergence boundary) + Periscope Charm showing strong positive charm:
Charm Pressure reflects multi-expiry decay dynamics weakening at that
level while Periscope Charm confirms real MM positioning still valid.
Trust Periscope Charm for confirmed dealer positioning; note Charm
Pressure as indicating the multi-expiry dynamic may be shifting away
from that level for future sessions.

**Sizing overlay from structural backing:**

Apply this as a modifier to the confidence-based sizing tiers from
Rule 8 and the ML calibration system:

Non-0DTE POSITIVE + 0DTE positive at the wall protecting your short
strike: UPGRADE signal for sizing. Both structural books defend this
level. At HIGH confidence from flow, full maximum tier is appropriate.

Non-0DTE NEGATIVE at the level protecting your short strike: DOWNGRADE
signal regardless of flow confidence. The structural book amplifies
against you if the level breaks. Reduce by one tier from whatever
flow-based sizing applies. Do not upgrade back based on charm alone.

Charm Pressure convergence boundary is MORE THAN 20 pts from your
short strike AND Delta Pressure shows the hole has expanded toward your
short strike: the mechanical EOD drift is unlikely to threaten your
position. This is an implicit time-based confidence signal — hold with
normal exits.

Charm Pressure red zone has expanded to within 10 pts of short call
strike: reduce size by one tier. The mechanical selling pressure is
now within reach of your position.
</spotgamma_signal_integration>

<spotgamma_multi_image_workflow>
## Reading Multiple SpotGamma Images Together

When two or more SpotGamma images of the same type are provided (e.g.,
Delta Pressure at 8:30 AM and again at midday), extract these specific
comparisons before making any management decision:

**For Delta Pressure (two snapshots):**
1. Has the hole width changed? Expanding hole = move developing.
   Contracting hole = consolidation / pinning likely.
2. Has the red-blue transition level moved? If it has shifted more
   than 10 pts from the morning location, the multi-expiry structure
   has repriced from intraday flow. Use the CURRENT transition level
   for management — not the morning level.
3. Has the GEX scale expanded? Document the magnitude change. A 5x
   scale expansion means substantial new structural positioning was
   added intraday.

**For Non-0DTE GEX (two snapshots):**
1. Have bar magnitudes grown at existing levels? Growing bars = existing
   structural walls being reinforced by additional institutional flow.
2. Have new bars appeared at strikes not visible in the morning? These
   represent NEW structural positions. Assess whether they are in the
   path of any pending trade or existing management plan.
3. Have any large bars disappeared? A bar shrinking significantly means
   institutional positions at that strike were partially closed. The
   structural support/resistance there has weakened.
4. Has the scale expanded significantly? Document the ratio.
   This represents total new multi-expiry options volume added intraday.

**For Charm Pressure (two snapshots):**
1. Has the convergence boundary (blue-red transition) moved more than
   10 pts? If yes, the pin target has repriced. Use the current boundary.
2. Has the red zone expanded downward toward spot? This signals the pin
   is now being pulled lower by charm mechanics.
3. Has the overall scale expanded? More institutional positioning
   reinforces the pin structure at the convergence level.
4. Compare the pre-load all-blue state (if morning image is pre-load)
   vs. the differentiated structure in the current image. The morning
   image is reference only — the current image governs all decisions.

**The morning-to-midday comparison as a regime check:**

Across all three image types, the comparison from early session to
midday tells a single coherent story:
- If all three show EXPANSION and CONVERGENCE (scale grew, structure
  differentiated, convergence boundary stabilized): the market structure
  has strengthened and the pin is well-anchored. Confidence in holding
  structures through the afternoon is highest.
- If any chart shows DIVERGENCE or FADE (scale shrinking at a level,
  convergence boundary moving away from a structural anchor, hole
  narrowing near short strikes): some structural support is weakening.
  Tighten exits on the threatened side.
- If scale expanded dramatically but price barely moved: institutions
  added structural positioning but the price action has been compressed
  by the new GEX walls. A breakout from this compression is likely to
  be large when it occurs — the structural book has grown on both sides,
  meaning either direction will be amplified once price leaves the
  compression zone.
</spotgamma_multi_image_workflow>

</spotgamma_visualization_framework>`;
