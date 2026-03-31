/**
 * Mode-specific calibration examples for the /api/analyze system prompt.
 *
 * Each example is a real analysis from March 25, 2026 that demonstrates
 * correct rule application, confidence calibration, and output structure.
 * Injected into the system prompt based on the analysis mode so the model
 * pattern-matches against the right reasoning style.
 */

// ============================================================
// ENTRY (PRE-TRADE) — March 25, 2026
// ============================================================

const CALIBRATION_ENTRY = `<calibration_example>
This is a real pre-trade analysis from March 25, 2026 that demonstrates correct application of all rules. Use it to calibrate your confidence levels, specificity of observations, strike guidance detail, and output structure.

Session context: SPX 6608, VIX 25.28, VIX1D 14.66 (42% below VIX = extreme inversion), entry time 9:35 AM CT. Calculator put spread ceiling: 15Δ. Periscope showed +3000 positive gamma wall at 6650-6660. No aggregate GEX data available.

Key reasoning chain:
1. Rule 8 weighting: SPX NCP +$102.5M (50%, BULLISH HIGH) + Market Tide NCP +$123M (25%, BULLISH HIGH) + SPY NCP +$6.3M (15%, CONFIRMS MODERATE) + QQQ neutral (10%, NEUTRAL) = net BULLISH at HIGH confidence
2. VIX1D 42% below VIX → extreme inversion → overrides VIX stop zone (Rule 3D validated)
3. Periscope: dominant +3000 wall at 6650-6660 = upside magnet. +1000 support at 6600-6605. No asymmetric negative gamma danger (Rule 1 does not trigger for IC override)
4. RV/IV 0.70 = IV-rich, premium sellers overcompensated
5. Structure: PCS. Not IC because triple-unanimity bullish flow is too directional for neutral structure. Not CCS because against all flow signals.
6. Confidence: HIGH — 3 primary flow signals confirm with widening divergence, 0 contradict
7. Strikes: Put spread ceiling is 15Δ (~6580 zone). Negative gamma cluster at 6575-6585 forces 1Δ adjustment → targeting 14Δ at 6570-6575, with positive gamma pocket at 6565 as structural support below

Correct output:
${JSON.stringify({
  mode: 'entry',
  structure: 'PUT CREDIT SPREAD',
  confidence: 'HIGH',
  suggestedDelta: 14,
  reasoning:
    'Triple-unanimity bullish flow (SPX NCP +$102.5M rising, Market Tide NCP +$123M rising, SPY confirming) combined with extreme VIX1D inversion (42% below VIX) signals a contained bullish session ideal for aggressive put credit spreads with the 6650-6660 positive gamma wall acting as an upside price magnet.',
  chartConfidence: {
    marketTide: {
      signal: 'BULLISH',
      confidence: 'HIGH',
      note: 'NCP at +$123.0M and rising monotonically from open; NPP at -$30.8M and falling. Divergence widening over 60 minutes (+$104.9M NCP rise). OTM confirms: NCP +$61.3M, NPP -$13.9M. This is a clean bullish divergence with no reversals — per Lesson 48 and 64, triple unanimity that strengthens warrants HIGH confidence.',
    },
    spxNetFlow: {
      signal: 'BULLISH',
      confidence: 'HIGH',
      note: 'Primary signal (50% weight). NCP at +$102.5M and rising, NPP at -$28.2M and falling. Divergence spread of ~$131M widening. NCP rose from +$191K to +$102.5M in 65 minutes — sustained bullish accumulation with no pauses or reversals.',
    },
    spyNetFlow: {
      signal: 'CONFIRMS',
      confidence: 'MODERATE',
      note: 'NCP at +$6.3M (mildly positive, rising from -$888K), NPP at -$14.8M (negative, falling). Both confirm bullish direction. Magnitude is modest compared to SPX but direction unambiguously confirms.',
    },
    qqqNetFlow: {
      signal: 'NEUTRAL',
      confidence: 'MODERATE',
      note: 'NCP at +$2.5M and NPP at +$2.0M — both near zero with tiny magnitudes. This is effectively neutral tech flow, not a divergence. Per Rule 2, since SPX/Market Tide/SPY all agree, QQQ neutrality should not reduce structure confidence.',
    },
    periscope: {
      signal: 'FAVORABLE',
      confidence: 'HIGH',
      note: 'Dominant +3000 positive gamma wall at 6650-6660 acts as upside magnet ~42-52 pts above price. Price sits on +1000 positive gamma at 6600-6605 providing immediate floor. Negative gamma cluster 6615-6640 between price and wall will ACCELERATE any upward move toward the magnet.',
    },
    netCharm: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'Naive Net Charm chart not provided. Cannot assess the broad directional charm slope for Rule 11 confirmation. Relying on Periscope Charm for strike-level charm assessment instead.',
    },
    aggregateGex: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'Aggregate GEX panel not provided. Cannot determine macro gamma regime (Rule 16). VIX at 25.28 suggests caution, but VIX1D extreme inversion (42% below) overrides this for premium selling. Defaulting to moderate management timing.',
    },
    periscopeCharm: {
      signal: 'MIXED',
      confidence: 'MODERATE',
      note: 'Positive charm ~+5-7M at 6665 confirms ceiling STRENGTHENS. Near-zero charm at 6600-6605 (immediate floor) — neutral, neither strengthening nor weakening. Deeper +3-5M charm at 6525. NOT all-negative — Override protocol does not apply.',
    },
    darkPool: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'No dark pool data available for this session.',
    },
    ivTermStructure: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'IV term structure data not available.',
    },
    spxCandles: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'Intraday candle data not yet available at entry time.',
    },
    overnightGap: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'Overnight gap data not available.',
    },
    vannaExposure: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'Vanna data not available without aggregate GEX panel.',
    },
    pinRisk: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'OI concentration data not provided.',
    },
    skew: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'Skew metrics not available.',
    },
  },
  observations: [
    "VIX1D at 14.66 is 42% below VIX 25.28 — extreme intraday term structure inversion. Per validated March 24 lesson and Rule 4 Override, this overrides stop zone restrictions for premium selling. VIX1D implies ~29 pt expected move vs the ~58 pt straddle cone, meaning the cone is roughly 2x wider than today's likely realized range.",
    'All three primary flow signals are unanimously bullish with widening divergence: SPX NCP +$102.5M (rising), Market Tide NCP +$123M (rising), SPY NCP +$6.3M (rising from negative). Per Lesson 64, triple unanimity from the first hour that strengthens warrants HIGH confidence and hold-to-expiration candidacy.',
    'The +3000 positive gamma wall at 6650-6660 is the dominant structural feature — approximately 3x larger than surrounding gamma. In a bullish flow environment, this acts as an afternoon magnet pulling price upward.',
    'RV/IV at 0.70 confirms an IV-rich environment — the market is pricing more movement than is occurring, which means theta decay heavily favors premium sellers. Combined with VIX1D extreme inversion, this is an ideal premium-selling setup.',
    'Periscope Charm confirms the upside ceiling zone will hold: +5-7M positive charm at 6665 strengthens the gamma wall through the afternoon. This supports the PCS thesis (price drifts up but has a defined ceiling).',
  ],
  strikeGuidance: {
    adjustments: [
      'Place short put at 6570-6575 (14Δ) — ceiling is 15Δ, adjusted 1Δ for negative gamma at 6575-6585. Positive gamma pocket at 6565 provides structural backstop',
      'AVOID short put at 6575-6580 — negative gamma zone at cone boundary creates acceleration risk toward the position',
      'The 6600-6605 positive gamma (+1000 each) is the primary structural floor — any short put below this level has 35-45 pts of cushion plus gamma suppression',
      'If considering IC add-on later: short call at 6670-6680 with the 6650-6660 wall (+3000) and positive charm at 6665 as structural ceiling',
    ],
    straddleCone: {
      lower: 6575.6,
      upper: 6666.2,
      priceRelation:
        'Price at 6608 is inside the cone — 58 pts to upper boundary, 32 pts to lower boundary. VIX1D implies actual expected move of ~29 pts, meaning the cone is roughly 2x the likely realized range. The 6650-6660 gamma wall sits just inside the upper cone, creating a double ceiling.',
    },
    putStrikeNote:
      'Calculator ceiling is 15Δ (~6580). Negative gamma at 6575-6585 forces 1Δ adjustment → short put at 6570-6575 (14Δ). Positive gamma pocket at 6565 provides structural support just below. The +1000 positive gamma floor at 6600-6605 gives 25-35 pts of structural protection above the short put.',
    callStrikeNote:
      'Not placing call leg. However, if converting to IC later, short call should be placed at 6670+ (above the 6666.20 upper cone boundary). The +3000 positive gamma wall at 6650-6660 with positive charm at 6665 provides a structural ceiling.',
  },
  managementRules: {
    profitTarget:
      'Target 50% profit by 1:00 PM ET as baseline. If Market Tide NCP/NPP spread exceeds $200M with zero reversals by 11:00 AM ET, override to 70% target or 2:00 PM ET per Market Tide magnitude rule. If spread exceeds $500M and Rule 16 VIX1D Extension conditions are met, hold to settlement. Set a GTC limit at 50% at entry to capture mechanically.',
    stopConditions: [
      'Close PCS if SPX breaks below 6575.60 (lower straddle cone) and sustains for 10+ minutes — this would exceed the VIX1D implied move and invalidate the contained-range thesis',
      'Close PCS if positive gamma at 6600-6605 is breached (SPX below 6595 sustained) AND NCP reverses below +$50M — the structural floor has broken with flow confirmation',
      'Do NOT close on upside moves — per Rule 5, upside cone breach CONFIRMS PCS thesis',
      'Close if VIX1D spikes above 20 intraday — the contained-range thesis would be invalidated',
    ],
    timeRules:
      'Without Aggregate GEX, default to moderate management: hold to 2:00 PM ET max if above 50% profit, hold to settlement if above 70%. If below 30% profit at 2:00 PM ET, close — remaining theta is not worth the gamma acceleration risk.',
    flowReversalSignal:
      'If SPX NCP drops below +$50M AND Market Tide NCP reverses direction (begins falling), the bullish thesis is weakening — take whatever profit is available. If NCP/NPP converge and cross, close immediately.',
  },
  entryPlan: {
    entry1: {
      timing: 'Now (9:35 AM CT / 10:35 AM ET)',
      sizePercent: 40,
      delta: 14,
      structure: 'PUT CREDIT SPREAD',
      note: 'FULL (40%) — triple-unanimity bullish flow at HIGH confidence with VIX1D extreme inversion. Place short put at 6570-6575 (14Δ), targeting calculator ceiling (15Δ) adjusted 1Δ for negative gamma at 6575-6585.',
    },
    entry2: {
      condition:
        'Flow still bullish at 10:30 AM CT (11:30 AM ET): SPX NCP above +$100M and NPP still negative. Price above 6600.',
      sizePercent: 30,
      delta: 14,
      structure: 'PUT CREDIT SPREAD',
      note: 'STANDARD (30%) — flow confirmed but awaiting second checkpoint. Same 14Δ target or step up to full 15Δ ceiling if the positive gamma wall at 6650-6660 has acted as a magnet and price has moved higher.',
    },
    entry3: {
      condition:
        'Flow strengthening at 11:30 AM CT (12:30 PM ET): NCP/NPP divergence wider than at Entry 1. Price approaching or above 6640.',
      sizePercent: 30,
      delta: 15,
      structure: 'PUT CREDIT SPREAD',
      note: 'STANDARD (30%) — final add, max position reached. If price is near 6650, step to full 15Δ ceiling as the move toward the gamma wall confirms the bullish thesis.',
    },
    maxTotalSize:
      '100% of daily risk budget across all entries. The VIX1D extreme inversion combined with triple-unanimity flow justifies full allocation.',
    noEntryConditions: [
      'Do NOT add Entry 2 if SPX NCP has dropped below +$50M — flow conviction weakening',
      'Do NOT add Entry 3 if SPX has dropped below 6585 at any point — structural floor tested',
      'Do NOT add entries if NCP/NPP divergence has begun narrowing',
      'Do NOT add if VIX1D rises above 20 intraday — the extreme inversion thesis is invalidated',
    ],
  },
  risks: [
    'VIX at 25.28 (stop zone) creates elevated tail risk despite VIX1D suppression — an exogenous shock could produce a move that exceeds even the VIX-implied range. The VIX1D inversion correctly predicts range 70%+ of the time but the 30% failure case is severe.',
    'Aggregate GEX not provided — cannot confirm whether the macro dealer gamma regime supports or undermines the per-strike Periscope walls.',
    'Periscope Charm shows near-zero charm at the 6600-6605 floor — this support will not strengthen through the day. If a selloff begins after 1:00 PM ET, this floor has no time-based reinforcement.',
    'QQQ NPP slightly positive (+$2.0M) while other signals are bullish — could indicate very early-stage tech hedging.',
  ],
  hedge: {
    recommendation: 'NO HEDGE',
    description:
      'No protective long recommended. The laddered entry plan (40/30/30) provides natural risk management. Full-size deployment only occurs after flow confirmation at each checkpoint.',
    rationale:
      'Triple-unanimity bullish flow + VIX1D extreme inversion (42% below VIX) + IV-rich environment (RV/IV 0.70) makes this a high-conviction setup where hedges erode returns without proportional risk reduction.',
    estimatedCost: 'N/A',
  },
  periscopeNotes:
    'Price at 6608-6610 sits on a +1000 positive gamma pocket at 6600-6605, providing immediate structural support. The dominant feature is the massive +3000 positive gamma wall at 6650-6660, approximately 42-52 pts above — in the bullish flow environment this acts as a powerful upside magnet. Between price and the wall, a negative gamma cluster at 6615-6640 will ACCELERATE any upward move, pushing price through that zone toward the wall. Below price, the lower cone at 6575.60 has negative gamma at 6575-6585 — if broken, this would accelerate downside. But positive gamma pockets at 6565 and 6550 provide stepping stones of support.',
  structureRationale:
    'PUT CREDIT SPREAD is the clear structure based on (1) triple-unanimity bullish flow across all three primary signals — SPX NCP +$102.5M rising, Market Tide NCP +$123M rising, SPY NCP +$6.3M rising — with QQQ neutral, (2) the dominant +3000 positive gamma wall at 6650-6660 acting as an upside magnet, and (3) the extreme VIX1D inversion (14.66 vs VIX 25.28, 42% below) confirming a contained daily range. IRON CONDOR was considered given the VIX1D extreme inversion override, but the flow is too directionally unanimous for a neutral structure. CALL CREDIT SPREAD is wrong-direction against all flow signals.',
  directionalOpportunity: null,
  review: null,
  imageIssues: [],
})}
</calibration_example>`;

// ============================================================
// MIDDAY — March 25, 2026 (first midday check, 10:20 AM CT)
// ============================================================

const CALIBRATION_MIDDAY = `<calibration_example>
This is a real mid-day re-analysis from March 25, 2026 that demonstrates correct continuity with a previous recommendation, use of actual Schwab position data, and condition assessment for additional entries.

Session context: SPX 6591, VIX 25.81, VIX1D 16.14 (37% below VIX = extreme inversion still intact), midday check at 10:20 AM CT. Trader has 4 open PCS positions: short puts at 6535/6540/6545/6550 with 20 contracts each. Entry analysis had recommended PCS at HIGH confidence.

Key reasoning chain:
1. Continuity: "Entry recommended PCS at HIGH with SPX at 6608. Now SPX ~6596 (down 12 pts). Core thesis remains valid — VIX1D inversion intact, flow still bullish."
2. Actual positions: calculated real cushion — 46-61 pts from each short put to gamma wall at 6605
3. SPX Net Flow STRENGTHENED since entry: NPP deepened from -$15.5M to -$114.5M (massive institutional put selling) — $196M bullish spread
4. BUT Market Tide converging: NCP fell $29M, NPP rose $41M in last 20 min — monitoring concern
5. Entry 2 conditions NOT met: SPX NCP at +$81.8M (below +$100M threshold), price ~6596 (below 6600). Do not add.
6. Confidence: HIGH maintained because SPX Net Flow (primary, 50% weight) strengthened despite Market Tide fade

Correct output:
${JSON.stringify({
  mode: 'midday',
  structure: 'PUT CREDIT SPREAD',
  confidence: 'HIGH',
  suggestedDelta: 14,
  reasoning:
    'SPX Net Flow NPP at -$114.5M (massive institutional put selling) is the strongest bullish signal of the session, maintaining PCS thesis despite Market Tide convergence in the last 20 minutes; existing positions have 45+ pts cushion to nearest short put with a dominant +3500 positive gamma wall at 6605 standing between price and all short strikes.',
  chartConfidence: {
    marketTide: {
      signal: 'BULLISH',
      confidence: 'MODERATE',
      note: 'NCP +$103.8M still positive but falling from peak of +$132.6M at 11:05. NPP surged from -$37.6M to +$3.0M in last 20 min — convergence warning. Still net bullish (NCP 30x NPP) but momentum is fading.',
    },
    spxNetFlow: {
      signal: 'BULLISH',
      confidence: 'HIGH',
      note: 'PRIMARY SIGNAL. NCP +$81.8M, NPP -$114.5M — a $196M bullish spread that has WIDENED since entry. NPP dropped from -$15.5M at 10:20 to -$114.5M now — massive institutional put selling in SPX specifically.',
    },
    spyNetFlow: {
      signal: 'CONFIRMS',
      confidence: 'MODERATE',
      note: 'NCP +$11.7M (stable around +$12M for an hour), NPP -$3.4M (converging from -$13.4M at 11:00). Mildly bullish but NPP convergence mirrors Market Tide fade.',
    },
    qqqNetFlow: {
      signal: 'CONTRADICTS',
      confidence: 'LOW',
      note: 'NCP +$1.9M (tiny), NPP +$8.3M (put buying = bearish). Bearish divergence widening. Per Rule 2, QQQ is only 10% weight — divergence reduces confidence, not structure.',
    },
    periscope: {
      signal: 'FAVORABLE',
      confidence: 'HIGH',
      note: 'DOMINANT +3500-4000 positive gamma wall at 6605 (purple bar) is the largest feature on the board, sitting just above current price (~6596). All four short puts (6535-6550) are 45-65 pts below this wall.',
    },
    netCharm: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'No naive Net Charm chart provided. Using Periscope Charm for strike-level analysis.',
    },
    aggregateGex: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'No aggregate GEX panel provided. Without GEX data, defaulting to conservative Rule 16 timing — target 50% by 1:00 PM ET.',
    },
    periscopeCharm: {
      signal: 'MIXED',
      confidence: 'MODERATE',
      note: 'CRITICAL: The 6605 gamma wall has slightly NEGATIVE real MM charm (-1 to -2M) — this wall will WEAKEN into the afternoon. Do not rely on it past ~1:00 PM ET. Deep floors at 6520-6525 have +5-7M positive charm and STRENGTHEN all day. Upside magnet at 6665-6670 has +25M positive charm.',
    },
    darkPool: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'No dark pool data available.',
    },
    ivTermStructure: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'IV term structure not available.',
    },
    spxCandles: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'Candle data not provided for this analysis.',
    },
    overnightGap: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'Overnight gap data not available.',
    },
    vannaExposure: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'Vanna data not available without aggregate GEX panel.',
    },
    pinRisk: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'OI concentration data not provided.',
    },
    skew: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'Skew metrics not available.',
    },
  },
  observations: [
    'CONSISTENCY CHECK: Entry recommended PCS at HIGH confidence with SPX at 6608, VIX 25.28, VIX1D 14.66. Now SPX ~6596 (down 12 pts), VIX 25.81 (slightly higher), VIX1D 16.14 (up but still 37% below VIX — extreme inversion intact). Core thesis remains valid: contained bullish day for premium selling.',
    'MARKET TIDE CONVERGENCE WARNING: NCP fell $29M and NPP rose $41M in the last 20 minutes. This is a $70M narrowing of the bullish divergence. If this rate continues, NCP/NPP could cross within 30-40 minutes. However, SPX Net Flow NPP at -$114.5M tells the opposite story: massive institutional put selling continues.',
    'ENTRY 2 CONDITIONS NOT MET: Original plan required SPX NCP above +$100M (currently +$81.8M — below threshold) and price above 6600 (currently ~6596 — below threshold). Do NOT add Entry 2 at this time.',
    'POSITION SAFETY: All 4 PCS positions (short puts 6535-6550) have massive structural protection: (1) +3500 gamma wall at 6605 just 9 pts above price, (2) positive gamma at 6600, (3) straddle cone lower at 6575.60, (4) deep charm floors at 6525 and 6500 that strengthen with time. The VIX1D-implied remaining move is ~27 pts — the nearest short put at 6550 is 46 pts away.',
    'CHARM TIMING RISK: The 6605 gamma wall has slightly negative Periscope Charm (-1 to -2M), meaning it will weaken into the afternoon. Plan to have 50% profit captured by 1:00 PM ET before this wall loses structural reliability.',
  ],
  strikeGuidance: {
    adjustments: [
      'HOLD: Short 6550P has 46 pts cushion — sits in positive gamma pocket, no adjustment needed',
      'HOLD: Short 6545P has 51 pts cushion — adequate spacing',
      'HOLD: Short 6540P has 56 pts cushion — protected by 3 layers above',
      'HOLD: Short 6535P has 61 pts cushion — in negative gamma zone BUT 65 pts of protection from 6605 wall, cone, and intermediate structure',
      'IF ADDING: Target 6540-6545 zone to maintain positive gamma pocket placement',
    ],
    straddleCone: {
      lower: 6575.6,
      upper: 6666.2,
      priceRelation:
        'Price at ~6596 is INSIDE the cone, 20 pts above the lower boundary and 70 pts below the upper boundary. The lower cone at 6575.60 is 26 pts above the nearest short put at 6550.',
    },
    putStrikeNote:
      'All existing short puts (6535-6550) are well-placed. The 6550 short put sits in a small positive gamma pocket. At 45-65 pts of cushion, all positions are safe. If adding Entry 2 later, target 6540-6545 to cluster with existing positions.',
    callStrikeNote:
      'Not adding call legs. However, if Market Tide flattens and flow shifts neutral later, a CCS at 6670-6680 would be structurally sound: above the 6666.20 upper cone, above the 6650-6660 positive gamma wall, and the 6665-6670 positive charm at +25M provides a STRENGTHENING ceiling.',
  },
  managementRules: {
    profitTarget:
      'Take 50% of total credit by 1:00 PM ET (12:00 PM CT). The 6605 gamma wall has negative charm and will weaken — capture profit while it is still holding. If SPX rallies above 6620 and holds, consider extending hold to 70% ONLY if Market Tide NCP re-diverges above +$120M.',
    stopConditions: [
      'CLOSE ALL if SPX breaks below 6575.60 (lower straddle cone) and sustains for 10+ minutes',
      'CLOSE ALL if SPX drops below 6595 sustained AND Market Tide NCP drops below +$50M simultaneously — the 6605 gamma wall has broken WITH flow confirmation',
      'CLOSE ALL if VIX1D spikes above 20 intraday',
      'TAKE PROFIT IMMEDIATELY if Market Tide NCP/NPP cross (NPP exceeds NCP) — currently NCP +$103.8M vs NPP +$3.0M, gap is $101M but narrowing rapidly',
      'Do NOT close on upside moves — per Rule 5, any rally confirms the PCS thesis',
    ],
    timeRules:
      'Without aggregate GEX data, use conservative timing. Target 50% profit by 1:00 PM ET. If 40%+ profit at 2:00 PM ET, close — the 6605 wall charm is slightly negative and cannot be trusted for final-2-hour protection. Hard close by 2:30 PM ET regardless.',
    flowReversalSignal:
      'WATCH CLOSELY: Market Tide NCP/NPP narrowed $70M in the last 20 minutes (spread from $170M to $101M). If NPP exceeds NCP (crossover), close ALL positions immediately. Also monitor SPX NCP — if it drops below +$50M, the primary bullish signal is failing.',
  },
  entryPlan: {
    entry1: {
      timing: 'FILLED — 4 PCS positions active',
      sizePercent: 100,
      delta: 14,
      structure: 'PUT CREDIT SPREAD',
      note: 'Positions are live: short puts at 6535/6540/6545/6550 with 20 contracts each across various widths. All are well-placed with 45-65 pts of cushion. Unrealized P&L: +$150.',
    },
    entry2: {
      condition:
        'REVISED: Wait for ALL THREE conditions: (1) SPX price above 6605, (2) Market Tide NCP/NPP spread widens back above $130M, (3) SPX NCP stabilizes above +$100M. The Market Tide convergence must REVERSE before adding risk.',
      sizePercent: 0,
      delta: 14,
      structure: 'PUT CREDIT SPREAD',
      note: 'Entry 2 conditions from original plan are NOT met: SPX NCP at +$81.8M (below +$100M threshold), price at ~6596 (below 6600 threshold). Market Tide convergence is a warning — adding now would increase risk into a potentially fading signal.',
    },
    entry3: {
      condition:
        'CANCELLED unless Entry 2 fills AND flow re-strengthens. With the Market Tide fade, the original plan for 3 entries is overly aggressive.',
      sizePercent: 0,
      delta: 12,
      structure: 'PUT CREDIT SPREAD',
      note: 'Conservative posture given Market Tide convergence. Do not over-allocate into a fading signal.',
    },
    maxTotalSize:
      'Current positions represent approximately 40-50% of daily risk budget. If Entry 2 fills, cap at 70%.',
    noEntryConditions: [
      'Do NOT add if Market Tide NCP drops below +$75M',
      'Do NOT add if Market Tide NPP exceeds NCP (crossover)',
      'Do NOT add if SPX breaks below 6580',
      'Do NOT add if VIX1D exceeds 19',
    ],
  },
  risks: [
    'MARKET TIDE CONVERGENCE: NCP fell $29M while NPP rose $41M in the last 20 minutes. If this rate continues, the bullish divergence could cross within 30-40 minutes. However, SPX Net Flow NPP at -$114.5M contradicts this fade.',
    'GAMMA WALL CHARM DECAY: The dominant 6605 positive gamma wall has slightly negative Periscope Charm (-1 to -2M). Per Rule 11, this wall is a morning ally that weakens into afternoon.',
    'VIX1D RISING: VIX1D increased from 14.66 to 16.14 (10% rise). While still in extreme inversion territory (37% below VIX), the direction of change reduces the safety cushion.',
    'NO AGGREGATE GEX DATA: Cannot determine whether the macro regime is positive or negative.',
    'QQQ BEARISH DIVERGENCE: QQQ NPP at +$8.3M contradicts the bullish thesis. Per Lesson 10, QQQ divergence on a directional day should tighten profit targets.',
  ],
  hedge: {
    recommendation: 'NO HEDGE',
    description:
      'Existing positions have 45-65 pts of cushion with massive gamma wall protection at 6605. Adding a protective long at this distance would be pure premium waste.',
    rationale:
      'SPX Net Flow is strongly bullish (NCP +$82M, NPP -$115M), VIX1D extreme inversion intact (37% below VIX), and the dominant +3500 gamma wall at 6605 stands between price and all short puts.',
    estimatedCost: 'N/A',
  },
  periscopeNotes:
    "The Periscope gamma profile is dominated by the massive +3500-4000 positive gamma wall at 6605 (purple bar) — this is the session's structural anchor and sits just 9 pts above current price (~6596). ABOVE PRICE: Negative gamma cluster at 6615-6640 creates acceleration potential for upside moves toward the positive gamma at 6650-6660. BELOW PRICE: Small negative gamma at 6580-6590, orange bar at 6565. Positive gamma pockets at 6550 and 6520 provide support. All PCS short puts (6535-6550) are in zero-gamma territory — completely unthreatened.",
  structureRationale:
    'PUT CREDIT SPREAD remains the correct structure, consistent with the entry analysis. The primary signal (SPX Net Flow, 50% weight) has actually STRENGTHENED since entry: NPP plunged from -$15.5M to -$114.5M. Market Tide is still bullish but the convergence is a monitoring concern, not yet a reversal. SPY confirms. QQQ contradicts (10% weight). VIX1D extreme inversion remains the strongest macro signal for premium selling.',
  directionalOpportunity: null,
  review: null,
  imageIssues: [],
})}
</calibration_example>`;

// ============================================================
// REVIEW (END-OF-DAY) — March 25, 2026
// ============================================================

const CALIBRATION_REVIEW = `<calibration_example>
This is a real end-of-day review from March 25, 2026 that demonstrates correct retrospective analysis: evaluating whether the recommendation was correct, identifying what signals predicted the outcome, what could have been improved, and whether the actual trade was the optimal tradeable option.

Session context: SPX settled ~6595, VIX 25.35, VIX1D 19.40. Actual range was ~25 pts (6585-6610), consuming only 28% of the 91-pt straddle cone. Entry recommended PCS at HIGH confidence — the recommendation was correct, all PCS positions expired worthless.

Key reasoning chain:
1. Was correct: Yes — all PCS short puts (6535-6550) expired worthless with 45-60 pts of cushion
2. What worked: VIX1D extreme inversion (23.5% below VIX) predicted 25 pt range, SPX NCP/NPP $293M spread (strongest bullish flow), Periscope Charm Override correctly invalidated naive ALL-NEGATIVE charm
3. What missed: one position closed early by mechanical stop at 3:35 PM — cost ~$100-200 but was process-correct
4. Optimal trade: the actual PCS was the optimal tradeable trade — IC call side would have also worked but flow didn't support neutral structure
5. Lessons: VIX1D extreme inversion validated 4th time, Periscope Charm Override essential on VIX 25+ days, orange gamma bars predict settlement

Correct output:
${JSON.stringify({
  mode: 'review',
  structure: 'PUT CREDIT SPREAD',
  confidence: 'HIGH',
  suggestedDelta: 10,
  reasoning:
    'PCS was the correct structure — VIX1D extreme inversion (23.5% below VIX) predicted a contained ~25 pt range on VIX 25.35, SPX-specific flow was strongly bullish all day (NCP +$114M, NPP -$179M at 2:55 PM), and all four PCS positions expired worthless at settlement ~6595.',
  chartConfidence: {
    marketTide: {
      signal: 'BULLISH',
      confidence: 'MODERATE',
      note: 'All-In NCP positive all day (peaked +$136M at 10:50 AM, faded to +$14M by 2:55 PM). OTM NCP turned bearish after 1:20 PM. Divergence between All-In (bullish) and OTM (bearish afternoon) reduced conviction.',
    },
    spxNetFlow: {
      signal: 'BULLISH',
      confidence: 'HIGH',
      note: 'The strongest signal of the day. NCP rose to +$120M by 10:10 AM and stayed +$60-114M all session. NPP deepened relentlessly from -$1.9M to -$179.3M by 2:55 PM. This NCP/NPP divergence (+$114M vs -$179M = $293M spread) represents massive institutional put selling and call buying in SPX.',
    },
    spyNetFlow: {
      signal: 'CONFIRMS',
      confidence: 'MODERATE',
      note: 'SPY NCP stayed positive (+$7.8-13.9M range), NPP deepened to -$20M by 2:55 PM. Bullish divergence confirmed the SPX-specific signal.',
    },
    qqqNetFlow: {
      signal: 'CONTRADICTS',
      confidence: 'LOW',
      note: 'QQQ NCP turned negative by 2:00 PM (-$4.8M), NPP positive (+$2.2M). Bearish divergence. Correctly discounted per Rule 2 at 10% weight.',
    },
    periscope: {
      signal: 'FAVORABLE',
      confidence: 'MODERATE',
      note: 'Late-day: MASSIVE orange positive gamma at 6590 (~+10,000) — the settlement magnet. Negative gamma flanking at 6585 and 6595. All PCS short puts (6535-6550) were in zero-gamma territory — completely safe.',
    },
    netCharm: {
      signal: 'DECAYING',
      confidence: 'LOW',
      note: 'Naive charm pattern classified ALL-NEGATIVE — would have predicted trending day with morning-only trading. However, the naive pattern was OVERRIDDEN by Periscope Charm. The all-expiry charm at 6595 was +439.3M (strengthening) — this multi-day anchor was the real structural floor.',
    },
    aggregateGex: {
      signal: 'NEGATIVE',
      confidence: 'MODERATE',
      note: 'OI Net Gamma -42K to -46.2K (mildly negative, Rule 16: tighten CCS exits by 30 min). Volume GEX deeply negative at -521.7K. However, the VIX1D extreme inversion correctly predicted that the negative GEX would NOT produce a trending day.',
    },
    periscopeCharm: {
      signal: 'CONFIRMS',
      confidence: 'HIGH',
      note: 'CRITICAL OVERRIDE APPLIED: Periscope Charm showed +100M at 6605 and +70-80M at 6545 — invalidating the naive ALL-NEGATIVE trending day signal. The day was range-bound, not trending. The 6605 ceiling held. The 6545 floor was never tested. Periscope Charm was the most valuable structural tool of the day.',
    },
    darkPool: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'Dark pool data not available for review.',
    },
    ivTermStructure: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'IV term structure data not available.',
    },
    spxCandles: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'Candle data not separately provided.',
    },
    overnightGap: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'Overnight gap data not available.',
    },
    vannaExposure: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'Vanna data not separately tracked.',
    },
    pinRisk: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'OI concentration not separately tracked.',
    },
    skew: {
      signal: 'NOT PROVIDED',
      confidence: 'LOW',
      note: 'Skew metrics not available.',
    },
  },
  observations: [
    'VIX1D EXTREME INVERSION VALIDATED: VIX1D at 19.4 was 23.5% below VIX 25.35. The actual session range was ~25 pts (6585-6610), consuming only 28% of the 91-pt straddle cone. RV/IV at 0.53 confirmed IV-rich conditions. This is now the 4th validated session.',
    "SPX NET FLOW WAS THE DOMINANT SIGNAL: The +$293M NCP/NPP spread at 2:55 PM was the session's strongest directional indicator. This flow never reversed or converged all day, making this a textbook hold-to-settlement PCS day.",
    "PERISCOPE CHARM OVERRIDE CORRECTLY APPLIED: Naive charm was ALL-NEGATIVE, predicting a trending day. Periscope Charm showed +100M at 6605 and +70-80M at 6545 — real MM charm anchors that held as the session's ceiling and floor. The day was range-bound, not trending. Validated for the 2nd time.",
    '6590 ORANGE GAMMA BAR = SETTLEMENT MAGNET: The recently-flipped +10,000 positive gamma at 6590 was the dominant late-day feature. After SPX dipped to 6585, the 6590 wall pulled price back to 6595 settlement.',
    '6550/6515 STOP CLOSURE WAS PROCESS-CORRECT: The mechanical stop was triggered and the closure recommendation was correct risk management. The estimated cost was ~$100-200 on a position that would have expired worthless 25 minutes later. Per Lesson 21: never optimize stops based on individual recovery outcomes.',
  ],
  strikeGuidance: {
    adjustments: [
      'All strikes were correctly placed below the lower cone boundary (6575.60)',
      'The 6545 short put coincided with the Periscope Charm +70-80M floor — this was the strongest structural anchor and should be the preferred strike on similar days',
      'The 6550 short put was the most exposed (closest to cone) — the mechanical stop was appropriate',
      'For future sessions with this VIX1D inversion profile: short puts at the lower cone boundary ±5 pts are well-protected. The 6535-6545 range is the sweet spot.',
    ],
    straddleCone: {
      lower: 6576,
      upper: 6666,
      priceRelation:
        'Settlement at 6595 was 19 pts above lower cone and 71 pts below upper cone — well inside the expected range. The actual ~25 pt range consumed only 28% of the cone.',
    },
    putStrikeNote:
      'All four short puts (6535-6550) were in zero-gamma territory. They were 35-60 pts below ATM. Strike placement was excellent: the 6545 had additional Periscope Charm protection, and the 6535/6540 were behind multiple layers of defense.',
    callStrikeNote:
      'No CCS entered. The gamma desert above 6610 meant any CCS at 6620+ would have been in clear air. An IC call leg at 6650+ would have had 55+ pts of cushion and expired worthless — structurally feasible but flow did not support it.',
  },
  managementRules: {
    profitTarget:
      'Max profit achieved on 3 held positions. The 6550/6515 was closed early per mechanical stop. Optimal: 50% by 1:00 PM, then hold remaining to settlement if Periscope Charm anchors are intact.',
    stopConditions: [
      'The 6590 mechanical stop for the 6550/6515 spread was CORRECTLY triggered at ~3:05 PM ET. Process-correct, minor outcome cost.',
      'The 6575 lower cone stop was never triggered (SPX low was ~6585).',
      'Flow-based stop (NCP/NPP convergence) was never triggered — spread widened all day.',
    ],
    timeRules:
      'Rule 16 mildly negative GEX called for tightening CCS exits by 30 min — not directly applicable since no CCS was held. For PCS, the VIX1D extreme inversion + Periscope Charm anchors justified holding to settlement.',
    flowReversalSignal:
      'No flow reversal occurred. SPX NCP/NPP divergence widened monotonically from +$93M spread at 10:00 AM to +$293M spread at 2:55 PM. Textbook no-reversal session.',
  },
  entryPlan: null,
  risks: [
    'The primary risk was the afternoon dip to 6585 (7 pts above the lower straddle cone) combined with deeply negative Volume GEX (-521.7K). The Periscope Charm anchors at 6545 and the all-expiry +439.3M charm at 6595 held.',
    'The naive ALL-NEGATIVE charm pattern, if taken at face value without Periscope, would have recommended morning-only trading — costing significant premium on a day where holding was optimal.',
  ],
  hedge: {
    recommendation: 'NO HEDGE',
    description:
      'No hedge was needed. The VIX1D extreme inversion, bullish SPX flow, and 35-60 pts of cushion made hedging unnecessary.',
    rationale:
      'With VIX1D at 19.4 predicting a contained ~35 pt range (actual: ~25 pts), short puts 35-60 pts below ATM were structurally safe.',
    estimatedCost: '$0 — no hedge warranted',
  },
  periscopeNotes:
    'GAMMA: Dominant orange positive gamma at 6590 (~+10,000) was the settlement magnet. Negative gamma flanking at 6585 and 6595. Small positive at 6600. Above 6610: gamma desert. All PCS short puts in zero-gamma territory. CHARM: Positive charm at 6605 (~+100M) served as the charm ceiling. Negative charm at 6585-6590 but massive positive gamma at 6590 counteracted this. Previous midday confirmed +70-80M at 6545. The all-expiry charm at 6595 was +439.3M.',
  structureRationale:
    'PUT CREDIT SPREAD was correct: (1) SPX Net Flow $293M spread widened all day. (2) Market Tide confirmed bullish morning. (3) SPY confirmed. (4) QQQ contradicted, correctly discounted. (5) VIX1D extreme inversion overrode stop zone, predicted contained range — validated by 25-pt realized range vs 91-pt cone. (6) Periscope Charm Override correctly invalidated naive ALL-NEGATIVE charm. An IC was structurally available but flow unanimity favored PCS.',
  review: {
    wasCorrect: true,
    whatWorked:
      'The PCS structure was exactly right — all four positions expired worthless at settlement ~6595 with 45-60 pts of cushion. Key signals: (1) VIX1D extreme inversion at 23.5% below VIX predicted contained range. (2) SPX NCP/NPP $293M spread — strongest bullish flow of recent sessions. (3) Periscope Charm Override correctly invalidating naive ALL-NEGATIVE charm. (4) The 6590 orange gamma bar acting as late-day settlement magnet. (5) Strike placement below the lower straddle cone with Periscope Charm protection at 6545.',
    whatMissed:
      'The 6550/6515 stop closure at 3:35 PM ET was the only management cost — estimated ~$100-200 on a position that expired worthless 25 minutes later. This was process-correct per Lessons 1, 21, and 56, but future similar setups with only 25 minutes remaining and Periscope Charm +70-80M at the short put could consider a narrower time threshold.',
    optimalTrade:
      'The actual PCS positions at 6535-6550 short puts were the optimal tradeable trade. An IC adding short calls at 6650+ would have been marginally better in hindsight (capturing an additional credit with 71 pts of upside cushion), but required accepting call-side risk that the strongly bullish flow did not support. Given real-time information, PCS-only was the highest risk-adjusted return structure. The 10-12Δ delta was appropriate.',
    lessonsLearned: [
      "VIX1D EXTREME INVERSION IS THE MOST RELIABLE REGIME SIGNAL FOR 0DTE PREMIUM SELLING: This is now the 4th validated session. When VIX1D is 20%+ below VIX, the market's own 1-day vol pricing tells you today will be calm. Target PCS at 10-12Δ with hold-to-settlement confidence.",
      'PERISCOPE CHARM OVERRIDE IS ESSENTIAL ON VIX 25+ DAYS: Naive charm showed ALL-NEGATIVE but Periscope showed +100M at 6605 and +70-80M at 6545. ALWAYS check Periscope Charm before applying the all-negative morning-only protocol. Validated on March 24 and March 25.',
      'ORANGE GAMMA BARS NEAR ATM IN THE FINAL 90 MINUTES PREDICT SETTLEMENT: The 6590 orange bar (~+10,000) pulled SPX from 6585 to 6595. Track orange bars after 2:30 PM ET as settlement zone indicators.',
      'SPX NCP/NPP SPREAD > $200M = HOLD-TO-SETTLEMENT PCS DAY: The $293M spread widened monotonically. On these days, override 50% profit targets and hold to settlement or 90%+.',
      'MECHANICAL STOPS WITH 25 MIN REMAINING AND 45+ PTS CUSHION MAY BE OVER-CONSERVATIVE: Consider a modified rule — in the final 30 minutes with 40+ pts cushion AND Periscope Charm +50M+ at the short strike, override mechanical stops unless the lower straddle cone itself is breached.',
    ],
  },
  imageIssues: [],
})}
</calibration_example>`;

// ============================================================
// SELECTOR
// ============================================================

/**
 * Return the calibration example for the given analysis mode.
 * Injected into the system prompt between PART1 and PART2.
 */
export function getCalibrationExample(mode: string): string {
  switch (mode) {
    case 'midday':
      return CALIBRATION_MIDDAY;
    case 'review':
      return CALIBRATION_REVIEW;
    default:
      return CALIBRATION_ENTRY;
  }
}
