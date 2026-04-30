/**
 * Calibration scaffold for /api/trace-live-analyze.
 *
 * Three hand-graded examples that exemplify correct rule application across
 * the override hierarchy's main branches:
 *
 *   1. Gamma override fires (dominant +γ node ≥5B absolute) — the model
 *      should pin at the gamma node, not the charm junction. Realised
 *      outcome confirms <$1 error.
 *   2. Trending-regime branch fires — no override, regime is trending,
 *      so predictedClose = spot at capture, NOT the drift-target extreme.
 *      Realised outcome on 2026-04-29 was +6 from spot, +12 from the
 *      old "downside drift" prediction.
 *   3. Stability gate fires — Stability% well below 20%, confidence is
 *      no_trade regardless of cross-chart agreement. Trade size none.
 *
 * Each example is schema-complete against `traceAnalysisSchema` so the
 * model sees every required field and learns the full output shape, not
 * just the rule-relevant subset.
 *
 * This block sits inside the cached prompt prefix between PART2 (skills)
 * and PART3 (output spec). Updating it invalidates the 1h ephemeral
 * cache once. Re-grade after ~30 days of new captures.
 */

const PREAMBLE = `
<calibration>
Three worked examples covering the main override-hierarchy branches.
Each example is sourced from a real capture whose realised close is
known; the <rationale> blocks show the reasoning chain to follow.

Conventions:
  - predictedClose is rounded to the nearest integer (half-strikes are
    legal but the integer convention reduces visual noise).
  - All required schema fields are populated even when not directly
    relevant to the example's rule — emit the full schema in production.

Gate precedence (when multiple rules fire on the same capture):
  1. Stability% < 20% — forces confidence = no_trade. Evaluates AFTER
     the override hierarchy. Overrides the trending-branch's
     "confidence ≤ medium" cap.
  2. Charm flip-flop with no contour reorientation — forces confidence
     = no_trade. Same precedence as Stability gate.
  3. Last-30-min + EOQ/quad-witch event day — adds MOC risk warning;
     trade size capped at quarter or flat.
  4. The override hierarchy itself sets predictedClose and the trade
     center/wing.
</calibration_preamble>`.trim();

const EXAMPLE_1_OVERRIDE_PIN = `
<calibration_example>
<scenario>Pin trade — gamma override fires on a +5B dominant node</scenario>
<input>
  capturedAt: 2026-04-27T19:52 UTC (15:52 ET, 8 min to close)
  spot: 7177.90
  stabilityPct: 54.7
  netGex: +16.98B (positive gamma regime confirmed)
  dominantNode: 7175 strike, magnitude +5.81B (clears the ≥5B absolute override threshold)
  charm: mixed-color heatmap with junction at ~7175 — agrees with gamma on level
  delta: blue-below 7170, red-above 7185 — ~$15 corridor
</input>
<expected_output>
{
  "timestamp": "15:52 ET",
  "spot": 7177.90,
  "stabilityPct": 54.7,
  "regime": "range_bound_positive_gamma",
  "charm": {
    "predominantColor": "mixed",
    "direction": "short",
    "junctionStrike": 7175,
    "flipFlopDetected": false,
    "rejectionWicksAtRed": false,
    "notes": "- Stable mixed-color band centered on 7175\\n- Junction at 7175 agrees with gamma node\\n- No flip-flop across captures"
  },
  "gamma": {
    "signAtSpot": "positive_strong",
    "dominantNodeStrike": 7175,
    "dominantNodeMagnitudeB": 5.81,
    "dominantNodeRatio": 1.8,
    "floorStrike": 7170,
    "ceilingStrike": 7185,
    "overrideFires": true,
    "notes": "- Net GEX +16.98B, +γ regime\\n- Dominant +γ node at 7175 = +5.81B (≥5B absolute → override fires)\\n- Charm + gamma agree on level → high conviction"
  },
  "delta": {
    "blueBelowStrike": 7170,
    "redAboveStrike": 7185,
    "corridorWidth": 15,
    "zoneBehavior": "support_resistance",
    "notes": "- Blue 7170 below = +γ support\\n- Red 7185 above = +γ resistance\\n- Classic +γ mean-reverting corridor"
  },
  "synthesis": {
    "predictedClose": 7175,
    "predictedCloseRange": null,
    "confidence": "high",
    "crossChartAgreement": "all_agree",
    "overrideApplied": true,
    "trade": { "type": "iron_fly", "centerStrike": 7175, "wingWidth": 15, "size": "three_quarter" },
    "headline": "+γ range-bound +16.98B | pin 7175 high (gamma override ≥5B) | corridor 7170–7185",
    "warnings": []
  }
}
</expected_output>
<rationale>
STEP 1 — GAMMA: dominant node 7175 at +5.81B clears the absolute-magnitude override (≥5B). Override fires regardless of the 1.8× neighbor-ratio.
STEP 2 — CHARM: stable single-color band, junction at 7175. Charm + gamma agree on level → high conviction.
STEP 3 — SYNTHESIS: pin trade at gamma node. Three-quarter size because stability 54.7% is healthy but not extreme. Realised outcome: 7174.01 (error -$0.99 from prediction).
</rationale>
</calibration_example>`.trim();

const EXAMPLE_2_TRENDING_NO_OVERRIDE = `
<calibration_example>
<scenario>Trending −γ regime — no override fires; predictedClose = spot, NOT drift target</scenario>
<input>
  capturedAt: 2026-04-29T19:52 UTC (14:52 CT, 8 min to close)
  spot: 7130.65
  stabilityPct: 23.83
  netGex: −2.76B (negative gamma regime, procyclical hedging live)
  dominantNode: 7140 +γ at +0.60B (3.4× ratio — fails 10× and 5B absolute thresholds, override does NOT fire)
  charm: red-dominant ceiling at 7140–7155, junction at ~7140
  delta: blue above 7140 = bull fuel; red below 7120 = bear fuel — acceleration zones, not S/R
  warnings: 8 min to close + MOC risk in negative gamma regime
</input>
<expected_output>
{
  "timestamp": "14:52 CT",
  "spot": 7130.65,
  "stabilityPct": 23.83,
  "regime": "trending_negative_gamma",
  "charm": {
    "predominantColor": "red",
    "direction": "short",
    "junctionStrike": 7140,
    "flipFlopDetected": false,
    "rejectionWicksAtRed": true,
    "notes": "- Red dominant 7140–7155, rejection wicks visible at ceiling\\n- Junction 7140, direction = short\\n- Stability 23.83% borderline above 20% gate"
  },
  "gamma": {
    "signAtSpot": "negative_strong",
    "dominantNodeStrike": 7140,
    "dominantNodeMagnitudeB": 0.60,
    "dominantNodeRatio": 3.4,
    "floorStrike": null,
    "ceilingStrike": 7140,
    "overrideFires": false,
    "notes": "- Net GEX −2.76B, −γ regime\\n- 7140 +γ ratio 3.4× and magnitude 0.60B BOTH fail override thresholds\\n- No +γ floor below spot (7100–7125 entirely negative)"
  },
  "delta": {
    "blueBelowStrike": null,
    "redAboveStrike": null,
    "corridorWidth": null,
    "zoneBehavior": "acceleration",
    "notes": "- −γ regime: blue above 7140 = bull fuel, red below 7120 = bear fuel\\n- No support/resistance corridor; zones are accelerative\\n- Spot in 20pt unstable gap between bull-fuel and bear-fuel zones"
  },
  "synthesis": {
    "predictedClose": 7131,
    "predictedCloseRange": { "p25": 7115, "p50": 7131, "p75": 7150 },
    "confidence": "low",
    "crossChartAgreement": "mostly_agree",
    "overrideApplied": false,
    "trade": { "type": "flat", "centerStrike": null, "wingWidth": null, "size": "none" },
    "headline": "−γ trending −2.76B | short bias (no pin, 8min to close) | acceleration 7120–7140",
    "warnings": ["8 min to close — MOC risk in negative gamma regime", "Stability 23.83% borderline"]
  }
}
</expected_output>
<rationale>
STEP 1 — GAMMA: dominant-node ratio 3.4× and magnitude 0.60B both fail override. No +γ floor below spot. Override does NOT fire.
STEP 2 — CHARM: red-dominant with rejection wicks at 7140 ceiling. Direction call: short. Stability 23.83% borderline but above 20% gate.
STEP 3 — SYNTHESIS: regime is trending_negative_gamma AND no override → trending-regime branch fires → predictedClose = spot rounded to int (7131), confidence ≤ medium ("low" used here), trade type ≠ iron_fly/iron_condor, size ≤ half. 8min-to-close + MOC risk in negative gamma further caps to flat / none. Realised outcome: 7137.56 (close was +6 from spot, NOT at the 7100–7125 drift extreme the old "ELSE: charm_junction" branch would have predicted — this is the failure mode the new branch fixes).
</rationale>
</calibration_example>`.trim();

const EXAMPLE_3_STABILITY_GATE = `
<calibration_example>
<scenario>Stability% gate fires — confidence forced to no_trade regardless of agreement</scenario>
<input>
  capturedAt: 2026-04-28T19:22 UTC (14:22 CT, 38 min to close)
  spot: 7140.60
  stabilityPct: 1.42 (well below the 20% gate — predictive value is poor)
  netGex: −10.93B (negative gamma regime)
  dominantNode: 7155 +γ at +0.197B (5.3× ratio — fails magnitude and ratio thresholds)
  charm: red-dominant, junction at 7155
  delta: acceleration zones, no S/R
</input>
<expected_output>
{
  "timestamp": "14:22 CT",
  "spot": 7140.60,
  "stabilityPct": 1.42,
  "regime": "trending_negative_gamma",
  "charm": {
    "predominantColor": "red",
    "direction": "short",
    "junctionStrike": 7155,
    "flipFlopDetected": false,
    "rejectionWicksAtRed": false,
    "notes": "- Red dominant, junction 7155\\n- Direction call would normally be short\\n- Stability% 1.42% well below 20% gate"
  },
  "gamma": {
    "signAtSpot": "negative_strong",
    "dominantNodeStrike": 7155,
    "dominantNodeMagnitudeB": 0.197,
    "dominantNodeRatio": 5.3,
    "floorStrike": null,
    "ceilingStrike": 7155,
    "overrideFires": false,
    "notes": "- Net GEX −10.93B, deep −γ regime\\n- Dominant node 7155 magnitude 0.197B and ratio 5.3× both fail override\\n- No +γ floor below spot"
  },
  "delta": {
    "blueBelowStrike": null,
    "redAboveStrike": null,
    "corridorWidth": null,
    "zoneBehavior": "acceleration",
    "notes": "- Acceleration zones in −γ regime\\n- No support/resistance corridor"
  },
  "synthesis": {
    "predictedClose": 7141,
    "predictedCloseRange": { "p25": 7120, "p50": 7141, "p75": 7160 },
    "confidence": "no_trade",
    "crossChartAgreement": "all_agree",
    "overrideApplied": false,
    "trade": { "type": "flat", "centerStrike": null, "wingWidth": null, "size": "none" },
    "headline": "−γ trending −10.93B | no_trade (Stability 1.4% << 20% gate) | acceleration 7120–7160",
    "warnings": ["Stability% 1.42% well below 20% gate — projected EoD pockets unreliable", "38 min to close in deep −γ regime — MOC risk material"]
  }
}
</expected_output>
<rationale>
STEP 1 — GAMMA: weak dominant node (0.197B), no override.
STEP 2 — CHARM: stable red — direction call would normally be "short" — but Stability% 1.42% means projected EoD pockets migrate substantially, so the chart's directional read is unreliable.
STEP 3 — SYNTHESIS: regime trending + no override → trending-regime branch fires → predictedClose = spot rounded to int (7141). Per gate precedence, the Stability% < 20% gate evaluates AFTER the trending branch's "confidence ≤ medium" cap and overrides it to no_trade. Cross-chart agreement is "all_agree" but agreement on a low-Stability chart is agreement on noise. Trade type = flat, size = none. Realised outcome: 7139.24 (within $2 of spot — confirms that the trending-regime branch's spot-as-modal-close prediction was correct).
</rationale>
</calibration_example>`.trim();

/**
 * Block of calibration examples injected into the cached system prompt
 * between the override hierarchy (PART1) and the inlined skills (PART2).
 *
 * Returns an empty string when there are no examples so concatenation is
 * always safe; callers don't need to null-check.
 */
export function getTraceLiveCalibrationBlock(): string {
  return [
    PREAMBLE.replace('</calibration_preamble>', '').trim(),
    '',
    EXAMPLE_1_OVERRIDE_PIN,
    '',
    EXAMPLE_2_TRENDING_NO_OVERRIDE,
    '',
    EXAMPLE_3_STABILITY_GATE,
    '',
    '</calibration>',
  ].join('\n');
}
