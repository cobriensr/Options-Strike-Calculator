// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  SYSTEM_PROMPT_PART1,
  SYSTEM_PROMPT_PART2,
} from '../_lib/analyze-prompts.js';
import { MARKET_MECHANICS_CONTEXT } from '../_lib/market-mechanics.js';
import {
  VIX_RATIO_BACKWARDATION_MIN,
  VIX_RATIO_CONTANGO_MAX,
} from '../_lib/vix-term-structure.js';
import { SPOTGAMMA_MECHANICS_CONTEXT } from '../_lib/spotgamma-mechanics.js';
import { formatStrikeExposuresForClaude } from '../_lib/db-strike-formatters.js';
import { getCalibrationExample } from '../_lib/analyze-calibration.js';
import { FLOOR_ENTRY_DELTA } from '../../src/constants/index.js';

const PROMPT = SYSTEM_PROMPT_PART1 + SYSTEM_PROMPT_PART2;

/** Text between `<tag>` and `</tag>`, or null when the tag is absent. */
function section(tag: string): string | null {
  const open = PROMPT.indexOf(`<${tag}>`);
  const close = PROMPT.indexOf(`</${tag}>`);
  if (open === -1 || close === -1) return null;
  return PROMPT.slice(open, close);
}

describe('analyze system prompt — Databento-only sources removed', () => {
  // DX (ICE), ES options (trades + daily stats), and top-of-book / OFI
  // microstructure were Databento-only feeds with no Unusual Whales
  // substitute. Rules that reference data the context never carries
  // invite the model to invent readings.

  it('has no DX / dollar-index rules or references', () => {
    expect(PROMPT).not.toMatch(/\bDX\b/);
    expect(PROMPT).not.toMatch(/dollar index/i);
    expect(PROMPT).not.toMatch(/dollar (strength|weakness|headwind)/i);
  });

  it('has no ES options open-interest rules', () => {
    expect(PROMPT).not.toMatch(/ES options/i);
    expect(PROMPT).not.toContain('Top Put OI');
    expect(PROMPT).not.toContain('Top Call OI');
    expect(PROMPT).not.toContain('Databento');
  });

  it('has no microstructure / OFI / top-of-book rules', () => {
    expect(section('microstructure_signals_rules')).toBeNull();
    expect(PROMPT).not.toMatch(/\bOFI\b/);
    expect(PROMPT).not.toMatch(/order flow imbalance/i);
    expect(PROMPT).not.toMatch(/top-of-book/i);
    expect(PROMPT).not.toMatch(/\bTBBO\b/);
  });

  it('keeps the generic time-of-day session patterns (not OFI-derived)', () => {
    expect(section('time_of_day')).toContain(
      'Intraday Microstructure Patterns',
    );
  });
});

describe('analyze system prompt — remaining futures rules stay coherent', () => {
  it('keeps the rules for every futures symbol the context still renders', () => {
    const rules = section('futures_context_rules');
    expect(rules).not.toBeNull();
    for (const heading of [
      'ES-SPX Basis:',
      'NQ-QQQ Divergence:',
      'VIX Term Structure (VIX/VIX3M):',
      'ZN Flight-to-Safety:',
      'RTY Breadth:',
      'CL Crude Oil:',
      'GC Gold (Safe Haven):',
    ]) {
      expect(rules).toContain(heading);
    }
  });

  it('tells the model to treat symbols in the stale-omitted line as unknown', () => {
    const rules = section('futures_context_rules');
    expect(rules).toContain('Omitted (stale >15m)');
    expect(rules).toMatch(/treat them as unknown \(not flat or neutral\)/);
    expect(rules).toMatch(/do not apply their rules/);
  });

  it('lists only live futures signals in the cross-reference step', () => {
    expect(PROMPT).toContain(
      'Do futures signals (ES basis, ZN flight-to-safety, RTY breadth, CL/GC) lead or contradict options flow?',
    );
  });

  it('lists only live futures signals in the futuresContext output note', () => {
    expect(PROMPT).toContain(
      'ES basis, NQ divergence, VIX/VIX3M term structure, ZN flight-to-safety, RTY breadth, CL oil shock, GC safe haven — which futures signals are active',
    );
  });
});

describe('analyze system prompt — VIX term structure from VIX/VIX3M', () => {
  // VX1/VX2 futures never had a feed; the context now carries spot
  // VIX / VIX3M (live + prior close) plus UW's VIX-futures label instead.

  it('has no VX front/back-month futures rules', () => {
    const rules = section('futures_context_rules');
    expect(rules).not.toContain('VIX Futures Term Structure');
    expect(rules).not.toMatch(/VX front|VX1|VX2|front < back|front > back/);
  });

  it('states the band thresholds the formatter classifies with', () => {
    const rules = section('futures_context_rules')!.replace(/\s+/g, ' ');
    const contangoMax = VIX_RATIO_CONTANGO_MAX.toFixed(2);
    const backwardationMin = VIX_RATIO_BACKWARDATION_MIN.toFixed(2);
    expect(rules).toContain(`CONTANGO at or below ${contangoMax}`);
    expect(rules).toContain(
      `FLAT between ${contangoMax} and ${backwardationMin}`,
    );
    expect(rules).toContain(`BACKWARDATION at or above ${backwardationMin}`);
  });

  it('names the context lines it gives rules for', () => {
    const rules = section('futures_context_rules')!;
    for (const line of [
      '"Live"',
      '"Prior close"',
      'VIX futures regime line',
      '"Shift:" line',
    ]) {
      expect(rules).toContain(line);
    }
  });

  it('treats a missing VIX section as unknown, not as a band', () => {
    expect(section('futures_context_rules')).toContain(
      'If no "VIX Term Structure" section appears, the ratio is unknown — apply no term-structure rule and do not infer a band.',
    );
  });

  it('applies the band rules to the live ratio only and never calls UW data a close', () => {
    const rules = section('futures_context_rules')!.replace(/\s+/g, ' ');
    expect(rules).toContain(
      '"Live" is the current intraday ratio and the only reading the band rules below apply to.',
    );
    expect(rules).not.toMatch(/Latest daily close|end-of-day reading/);
  });

  it('keeps the stable system text free of live VIX readings', () => {
    // Values belong in the per-request Futures Context block; a number
    // like "VIX 16.39" here would also break the prompt cache.
    expect(PROMPT).not.toMatch(/VIX3M \d/);
    expect(PROMPT).not.toMatch(/= 0\.\d{3} \((CONTANGO|FLAT|BACKWARDATION)\)/);
  });

  it('keeps the neighbouring cross-asset, volume-profile, VIX-divergence and UW-deltas rules', () => {
    for (const tag of [
      'cross_asset_regime_rules',
      'volume_profile_rules',
      'vix_divergence_rules',
      'uw_deltas_rules',
    ]) {
      expect(section(tag)).not.toBeNull();
    }
  });
});

describe('analyze system prompt — Periscope rules run on UW data only (D1 revised)', () => {
  // Owner decision 2026-10-29: GEXBot is a classified taker-flow imbalance,
  // UW Periscope was a market-maker position estimate (per-strike Spearman
  // ≈ +0.04 on the cutover day). Rules tuned on UW must not fire on GEXBot.
  const periscope = (): string => section('periscope') ?? '';

  /** The line (or paragraph) of PROMPT that starts with `head`. */
  function lineStartingWith(head: string): string {
    const line = PROMPT.split('\n').find((l) => l.startsWith(head));
    expect(line, `no prompt line starts with "${head}"`).toBeDefined();
    return line ?? '';
  }

  it('defines Periscope as UW data only, in one SOURCE SCOPE instruction', () => {
    const block = periscope();
    expect(block).toContain(
      "SOURCE SCOPE — UW Periscope only. In this prompt, 'Periscope' always means UW Periscope (uploaded screenshots or UW-era/UW-websocket data). The GEXBot block is not Periscope data.",
    );
    expect(block).toContain('Apply them ONLY to UW Periscope data');
    expect(block).toContain('uploaded Periscope screenshots');
    expect(block).toContain('"Periscope Exposure — UW Periscope" block');
    expect(block).toContain('before 2026-05-26 17:20 UTC (12:20 CT)');
    expect(block).toContain(
      'Generic gamma/charm rules read UW sources only (UW Periscope, the API Per-Strike Profile, the Net GEX Heatmap, Zero-Gamma, All-Expiry).',
    );
  });

  it('makes the GEXBot Taker-Flow Greeks block context only, with the vendor meaning and no MM reading', () => {
    const block = periscope();
    expect(block).toContain('"GEXBot Taker-Flow Greeks" block');
    expect(block).not.toMatch(/"Periscope Exposure" block comes from GEXBot/);
    expect(block).toContain('It is CONTEXT ONLY');
    expect(block).toContain(
      'never use it for any structure, strike, stop, target, timing or sizing decision',
    );
    expect(block).toMatch(/classified taker-flow imbalance/);
    expect(block).toMatch(
      /never call its strikes market-maker walls, floors, ceilings or acceleration zones/,
    );
    expect(block).toMatch(/traders are net long gamma there/);
    expect(block).toContain(
      "tend to hold price in falling vol (vendor's description)",
    );
    expect(block).not.toMatch(/act as a wall/);
    expect(block).toMatch(/pass through in rising vol/);
    expect(block).toMatch(/not validated in this system/);
  });

  it('rates the Periscope chart-confidence fields from UW data only, consistently', () => {
    expect(periscope()).toContain(
      'rate chartConfidence.periscope and chartConfidence.periscopeCharm from UW Periscope data only',
    );
    const exception =
      '(Exception: chartConfidence.periscope/periscopeCharm — a GEXBot block does not count; see SOURCE SCOPE.)';
    expect(lineStartingWith('If an API data section is present')).toContain(
      exception,
    );
    expect(lineStartingWith('9. If any chartConfidence field')).toContain(
      exception,
    );
    expect(
      lineStartingWith('- The chartConfidence breakdown is always required'),
    ).toContain(
      'populate from UW Periscope data (images labelled UW Periscope or a UW-sourced block). Mark as "NOT PROVIDED" only if no UW Periscope data (screenshots labelled UW Periscope or a UW-sourced block) is present; a GEXBot block does not count.',
    );
    expect(PROMPT).not.toContain('only if no Periscope images were uploaded');
  });

  it('tags each strike-picking gamma rule and charm override as UW-only', () => {
    // Each rule that picks strikes, structures or deadlines off Periscope
    // gamma or charm names UW Periscope as its input.
    expect(periscope()).toContain(
      'For strike selection using UW Periscope (UW data only — see SOURCE SCOPE):',
    );
    expect(lineStartingWith('PERISCOPE CHARM OVERRIDE')).toContain(
      'PERISCOPE CHARM OVERRIDE (UW Periscope only — see SOURCE SCOPE in <periscope>): When naive charm (from API) shows all-negative BUT UW Periscope Charm',
    );
    expect(lineStartingWith('PERISCOPE CHARM CEILING OVERRIDE')).toContain(
      'PERISCOPE CHARM CEILING OVERRIDE (UW Periscope only): When UW Periscope Charm shows',
    );
    expect(lineStartingWith('(4) ')).toContain(
      '(4) UW Periscope Charm (screenshot or UW-era block; GEXBot charm never counts) confirms',
    );
    expect(lineStartingWith('When flow signals are neutral')).toContain(
      'BUT the UW Periscope gamma profile (GEXBot gamma never triggers this rule — see SOURCE SCOPE) shows',
    );
    expect(lineStartingWith('- Example: flow is neutral')).toContain(
      'UW Periscope shows -10,000 gamma',
    );
    expect(lineStartingWith('At 2:30 PM ET, check whether')).toContain(
      '(from UW Periscope or the per-strike API data; never from GEXBot)',
    );
    expect(lineStartingWith('- If the highest-OI strike aligns')).toContain(
      'positive gamma wall (from UW Periscope)',
    );
    expect(lineStartingWith('- When a dark pool buyer cluster')).toContain(
      'positive gamma wall from UW Periscope',
    );
    expect(
      lineStartingWith('- In the observations, note any dark pool'),
    ).toContain('the UW Periscope gamma profile');
    expect(
      lineStartingWith('- When the top gamma walls from the heatmap'),
    ).toContain('match the UW Periscope walls');
    expect(lineStartingWith('- When heatmap shows a large wall')).toContain(
      'but UW Periscope Gamma shows small bars',
    );
    expect(PROMPT).not.toContain(
      '- When Periscope shows a dominant gamma wall',
    );
    expect(PROMPT).toContain('- When UW Periscope shows a dominant gamma wall');
    expect(lineStartingWith('4. Periscope Charm Overrides')).toContain(
      '4. Periscope Charm Overrides (UW Periscope data only)',
    );
    expect(lineStartingWith('If UW Periscope data is provided')).toContain(
      "map the calculator's theoretical strikes against its gamma profile",
    );
    expect(section('periscope_charm')).toContain(
      'UW Periscope Charm (uploaded screenshot or UW-era block only — never the GEXBot charm; see SOURCE SCOPE in <periscope>) shows CONFIRMED',
    );
  });

  it('keeps the UW-calibrated rules themselves for UW data', () => {
    // Paused for GEXBot, not deleted: UW screenshots and UW-era replays
    // still use them.
    expect(periscope()).toContain(
      '- Place short strikes in positive gamma zones (price suppression helps you).',
    );
    expect(PROMPT).toContain('RULE 1: Gamma Asymmetry Overrides Neutral Flow');
    expect(PROMPT).toContain(
      'Validated March 24: naive showed all-negative, Periscope showed +120M at 6500',
    );
    expect(PROMPT).toContain(
      'Validated March 24: 6620 wall with +160M Periscope Charm held as ceiling all day',
    );
  });

  it('points strike, cushion and wall reads at UW gamma data, never GEXBot', () => {
    const uwGamma =
      'UW Periscope if present, otherwise the API Per-Strike Greek Profile and Net GEX Heatmap; never the GEXBot block';
    expect(lineStartingWith('2. Calculate actual cushion distances')).toContain(
      uwGamma,
    );
    expect(
      lineStartingWith('- When the opening range is unavailable'),
    ).toContain(uwGamma);
    expect(PROMPT).toContain(
      '2. Specific Strike Placement (from UW gamma data)',
    );
    expect(lineStartingWith('If UW Periscope data is provided')).toContain(
      'otherwise map them against the API Per-Strike Greek Profile and Net GEX Heatmap (UW data) — never against the GEXBot block:',
    );
    for (const field of ['putStrikeNote', 'callStrikeNote']) {
      const line = PROMPT.split('\n').find((l) => l.includes(`"${field}"`));
      expect(line).toContain(
        'UW gamma zones (UW Periscope, else the API Per-Strike Greek Profile and Net GEX Heatmap; never the GEXBot block). null only if none of these is present.',
      );
    }
    expect(section('aggregate_gex')).toContain(
      'the per-strike 0DTE gamma profile (UW Periscope, or the API Per-Strike Greek Profile and Net GEX Heatmap) sits inside',
    );
    expect(section('aggregate_gex')).toContain(
      'The UW per-strike profile (UW Periscope, or the API Per-Strike Greek Profile and Net GEX Heatmap; never GEXBot) answers WHERE',
    );
    expect(section('zero_gamma')).toContain(
      'It is derived from the UW per-strike profile (the "SPX 0DTE Per-Strike Greek Profile", UW spot exposures by strike), not from Periscope or the GEXBot block',
    );
    expect(lineStartingWith('- If charm contradicts the flow-based')).toContain(
      'may not behave as UW Periscope suggests',
    );
    expect(lineStartingWith('- GOOD: "SPX NCP at +$102.5M')).toContain(
      '(from UW Periscope)',
    );
    expect(PROMPT).toContain(
      'Do the top walls match UW Periscope (if present)?',
    );
  });

  it('counts UW Periscope as primary only when present; its absence is the MODERATE cap only', () => {
    // Owner decision (I4): one failed feed on a day with no UW Periscope
    // stays MODERATE; GEXBot never counts as Periscope.
    expect(lineStartingWith('- UW Periscope absent')).toContain(
      'caps confidence at MODERATE independently of API availability. That cap is the only effect of its absence: a missing UW Periscope never counts toward the LOW triggers',
    );
    expect(PROMPT).not.toContain('- Periscope not uploaded (no images)');
    expect(
      lineStartingWith('Primary signals for structure selection'),
    ).toContain(
      'SPX Net Flow, Market Tide, and the UW Periscope Gamma profile when UW Periscope data is present.',
    );
    expect(
      lineStartingWith('Primary signals for structure selection'),
    ).toContain(
      'GEXBot data never counts as Periscope or as a primary signal.',
    );
    expect(PROMPT).toContain(
      'UW Periscope availability is determined separately: it is present when screenshots labelled UW Periscope were uploaded or a "Periscope Exposure — UW Periscope" block is in the context; a GEXBot block never counts, and an image labelled "Unlabeled (not Periscope)" is not UW Periscope.',
    );
  });

  it('defines UW Periscope absence by labelled screenshots, not any upload (NB2)', () => {
    // Since m6 an upload can be "Unlabeled (not Periscope)"; it must not
    // count as UW Periscope and skip the MODERATE cap.
    expect(lineStartingWith('- UW Periscope absent')).toContain(
      '- UW Periscope absent (no screenshots labelled UW Periscope and no UW Periscope block): caps confidence at MODERATE',
    );
    expect(PROMPT).toContain(
      'You will receive up to 2 screenshots. Periscope data means only screenshots labelled UW Periscope (Gamma or Charm) or a "Periscope Exposure — UW Periscope" block in the context. The rest of the structured API data (flow, GEX, per-strike Greek profiles, and any GEXBot block) is separate from Periscope. You also receive the trader\'s current calculator context and analysis mode.',
    );
    expect(PROMPT).not.toContain(
      'You will receive up to 2 Periscope screenshots',
    );
    expect(PROMPT).not.toContain(
      'Only Periscope Gamma and Periscope Charm are provided as images',
    );
    expect(
      PROMPT.split(
        'Only images labelled UW Periscope (Gamma or Charm) are read as Periscope images requiring visual extraction.',
      ).length - 1,
    ).toBe(2);
  });

  it('never counts a missing SPX Net Flow toward a LOW trigger, in every case (I4)', () => {
    const line = lineStartingWith('Primary signals for structure selection');
    expect(line).toContain(
      'In every case, a missing SPX Net Flow never counts toward either LOW trigger or as a "missing primary data source" in the MODERATE clause.',
    );
    // NB1: the absence sentence names UW Periscope, not "Its".
    expect(line).toContain(
      "UW Periscope's absence applies only the MODERATE cap;",
    );
    expect(line).not.toContain('Its absence applies only the MODERATE cap.');
  });

  it('defines "primary" for both LOW triggers as the Missing Data Protocol API list, Periscope or not (CR1/CR2)', () => {
    // Owner decision (I4). Scenarios the sentence must settle:
    //  - Periscope present, QQQ + Aggregate GEX missing: two missing
    //    protocol primaries -> LOW (was MODERATE under the old structure
    //    primaries SPX Net Flow / Market Tide / Periscope).
    //  - Periscope present, Market Tide + SPX Net Flow missing: one counted
    //    feed -> MODERATE (SPX Net Flow never counts).
    //  - No Periscope, one feed missing: MODERATE cap only.
    const line = lineStartingWith('Primary signals for structure selection');
    expect(line).toContain(
      `Whether or not UW Periscope data is present, both LOW triggers ("only 1 primary signal is available" and "2+ primary data sources are unavailable") count only the Missing Data Protocol's primary API list (Market Tide, QQQ Net Flow, Aggregate GEX): one unavailable feed stays MODERATE, and two or more is LOW.`,
    );
    expect(line).toContain(
      "UW Periscope's absence applies only the MODERATE cap; when present it adds its own confirm/contradict weight and never changes which feeds count toward the LOW triggers.",
    );
    expect(line).toContain(
      'a missing SPX Net Flow never counts toward either LOW trigger or as a "missing primary data source" in the MODERATE clause.',
    );
    expect(line).not.toContain('Without UW Periscope data, both LOW triggers');
    // The protocol list the sentence points at stays as the definition.
    expect(PROMPT).toContain(
      'A missing PRIMARY API signal (Market Tide, QQQ Net Flow, Aggregate GEX) automatically caps confidence at MODERATE. Two or more missing primary API signals caps confidence at LOW.',
    );
  });

  it('rates a flow-vs-gamma split LOW, directly after the LOW line (owner 2026-11-05)', () => {
    // Settles the old contradiction between MODERATE ("at most 1
    // contradicting primary signal") and LOW ("flow says one direction,
    // gamma says another"): LOW wins.
    const rule =
      '- Flow vs gamma outranks MODERATE: when the Rule 8 flow consensus (Market Tide, QQQ Net Flow, ETF Tide) points one way and the UW Periscope Gamma profile points the other, the answer is LOW even if that is the only contradicting primary signal. SPX Net Flow alone disagreeing with gamma is not a flow-vs-gamma conflict (Rule 8 treats it as an anti-signal).';
    expect(PROMPT.split(rule).length - 1).toBe(1);
    const lowAt = PROMPT.indexOf('\n- LOW: Primary signals conflict');
    const ruleAt = PROMPT.indexOf(rule);
    const primaryAt = PROMPT.indexOf(
      '\nPrimary signals for structure selection:',
    );
    expect(lowAt).toBeGreaterThan(-1);
    expect(ruleAt).toBeGreaterThan(lowAt);
    // The LOW line, then the new item on the very next line, then the
    // "Primary signals" line.
    expect(PROMPT.slice(lowAt + 1, ruleAt).split('\n')).toHaveLength(2);
    expect(primaryAt).toBe(ruleAt + rule.length);
  });

  it('keeps QQQ flow out of the "Secondary signals:" list (I2)', () => {
    expect(lineStartingWith('Secondary signals:')).toContain(
      'Secondary signals: SPY Net Flow, charm,',
    );
    expect(lineStartingWith('Secondary signals:')).not.toContain('QQQ');
  });

  it('shows no QQQ-as-secondary wording in the Prior-Day Flow Trend rules (m6)', () => {
    // QQQ flow is a Missing Data Protocol primary; the formatter labels the
    // prior-day readings "Confirmation:", so the rules say the same.
    expect(PROMPT).toContain(
      'Market Tide intraday arc (open → midday → close) and confirmation-source terminal values',
    );
    expect(PROMPT).toContain(
      '- Confirmation-source alignment (SPX Flow, SPY Flow, QQQ Flow, SPY ETF Tide, QQQ ETF Tide)',
    );
    expect(PROMPT).not.toContain('secondary flow source terminal values');
    expect(PROMPT).not.toContain('Secondary source alignment');
  });

  it('keeps a missing SPX Net Flow at no confidence change in the sample observation (I4)', () => {
    expect(PROMPT).toContain(
      '"SPX Net Flow unavailable — flow assessment relies on Market Tide, QQQ Net Flow and SPY Net Flow. No confidence change."',
    );
    expect(PROMPT).not.toContain('reducing directional conviction');
    expect(PROMPT).not.toContain('relies on Market Tide and SPY only');
  });

  it('scopes periscopeNotes to UW Periscope data', () => {
    const line = PROMPT.split('\n').find((l) => l.includes('"periscopeNotes"'));
    expect(line).toContain(
      'null if no UW Periscope data (screenshots or a UW-sourced block).',
    );
    expect(line).not.toContain('null if no Periscope images provided');
  });

  it('scopes the SpotGamma cross-checks to uploaded UW Periscope', () => {
    const sg = SPOTGAMMA_MECHANICS_CONTEXT;
    expect(sg).not.toContain('Heatmap and Periscope Gamma already in context');
    expect(sg).toContain(
      'UW Net GEX Heatmap and UW Periscope Gamma (if uploaded; never the GEXBot block)',
    );
    expect(sg).toContain(
      'Cross-check (only when UW Periscope Charm was uploaded; GEXBot charm never counts)',
    );
    expect(sg).toContain('When UW Periscope Charm shows strong real MM charm');
    expect(sg).toContain(
      'PRIMARY: UW Net GEX Heatmap + UW Periscope Gamma when uploaded (never the GEXBot block)',
    );
    expect(sg).toContain('+ UW Periscope Charm showing strong positive charm');
    expect(sg).toContain(
      'Trust UW Periscope Charm for confirmed dealer positioning',
    );
    // m1: the "already in context" lists no longer name Periscope as
    // context data; UW Periscope is named as an upload.
    expect(sg).not.toMatch(/Zero-Gamma, Periscope\s+Gamma\/Charm/);
    expect(sg).toContain(
      'with UW Periscope Gamma/Charm when uploaded, or a UW-era block is in context (never the GEXBot block)',
    );
    expect(sg).toContain(
      'and UW Periscope Gamma/Charm when uploaded, or a UW-era block is in context (never the GEXBot block)',
    );
  });

  it('keeps per-request source state out of the cached system text', () => {
    // Which source today's block came from is decided per request, in the
    // context block; the cached prompt only states the rule.
    expect(PROMPT).not.toMatch(/today's Periscope block is (GEXBot|UW)/i);
    expect(PROMPT).not.toMatch(/latest 10-min slice \d/);
  });
});

describe('analyze system prompt — Rule 9 short-strike delta floor', () => {
  // The per-call "Chain Delta Rungs" block prints `Floor: ${FLOOR_ENTRY_DELTA}Δ.
  // Never go below floor`. The cached rules must state the same floor, or
  // Claude gets two different minimums in one request.
  const floor = `${FLOOR_ENTRY_DELTA}Δ`;
  const MODES = ['entry', 'midday', 'review'] as const;

  /** The cached stable system block, composed exactly as api/analyze.ts does. */
  function stableSystemText(mode: (typeof MODES)[number]): string {
    return (
      SYSTEM_PROMPT_PART1 +
      '\n' +
      MARKET_MECHANICS_CONTEXT +
      '\n' +
      SPOTGAMMA_MECHANICS_CONTEXT +
      '\n' +
      getCalibrationExample(mode) +
      '\n' +
      SYSTEM_PROMPT_PART2
    );
  }

  /** suggestedDelta from a mode's JSON.stringify'd calibration output. */
  function calibrationSuggestedDelta(mode: (typeof MODES)[number]): number {
    const match = /"suggestedDelta":\s*(\d+)/.exec(getCalibrationExample(mode));
    expect(match).not.toBeNull();
    return Number(match![1]);
  }

  it('pins the floor at 8Δ (owner decision 2026-10-29)', () => {
    expect(FLOOR_ENTRY_DELTA).toBe(8);
  });

  it('states the floor the Chain Delta Rungs block enforces', () => {
    const text = PROMPT.replace(/\s+/g, ' ');
    for (const line of [
      `Apply Rule 9 (${floor} premium floor`,
      `7. Rule 9 (${floor} Premium Floor)`,
      `If the widened delta still falls below the ${floor} floor, Rule 9 takes precedence`,
      `Never adjust below the ${floor} floor: if ceiling minus 2-3Δ lands under ${floor}, the FLOOR line applies.`,
      `FLOOR: ${floor} is the absolute minimum. Below ${floor},`,
      `If neither side can reach the higher of its ceiling minus 3Δ or the ${floor} floor while maintaining structural protection, recommend SIT OUT.`,
      `If the structurally correct trade cannot achieve ${floor}, recommend SIT OUT.`,
      `The ${floor} floor exists for days when extreme structural risk`,
      `${floor}+ premium (Rule 9)`,
      `must meet ${floor}+ minimum (Rule 9)`,
      `suggestedDelta must be >= ${FLOOR_ENTRY_DELTA} (Rule 9) for entry mode`,
    ]) {
      expect(text).toContain(line);
    }
  });

  it.each(MODES)('names no other delta as the Rule 9 floor (%s)', (mode) => {
    // Scoped to floor / "(Rule 9)" phrasing: the directional-long section's
    // "50Δ minimum" is a separate rule for bought options.
    const stated = [
      ...stableSystemText(mode).matchAll(
        /(\d+)Δ\+? (?:premium floor|floor|(?:premium|minimum) \(Rule 9\))/gi,
      ),
    ].map((m) => Number(m[1]));
    expect(stated.length).toBeGreaterThanOrEqual(6);
    expect(new Set(stated)).toEqual(new Set([FLOOR_ENTRY_DELTA]));
  });

  it.each(MODES)('states no other floor in any other phrasing (%s)', (mode) => {
    // Covers the floor phrasings the check above doesn't match. A plain
    // "10Δ" stays allowed: the examples cite 10Δ trades and a 10Δ ceiling.
    const text = stableSystemText(mode);
    const stated = (re: RegExp) =>
      new Set([...text.matchAll(re)].map((m) => Number(m[1])));
    const floorOnly = new Set([FLOOR_ENTRY_DELTA]);
    expect(stated(/\b(\d+)Δ\+/g)).toEqual(floorOnly);
    expect(stated(/\b(\d+)Δ is the absolute minimum/g)).toEqual(floorOnly);
    expect(stated(/suggestedDelta must be >= (\d+)\b/g)).toEqual(floorOnly);
  });

  it('shows no sub-floor suggestedDelta in the entry calibration example', () => {
    expect(calibrationSuggestedDelta('entry')).toBeGreaterThanOrEqual(
      FLOOR_ENTRY_DELTA,
    );
  });

  it('shows 0 or an at-floor suggestedDelta in the midday calibration example', () => {
    // Self-validation check 5: midday may be 0 when recommending no new entry.
    const delta = calibrationSuggestedDelta('midday');
    expect(
      delta === 0 || delta >= FLOOR_ENTRY_DELTA,
      `midday suggestedDelta ${delta}`,
    ).toBe(true);
  });

  it('keeps the "ceiling is the recommendation" guidance above the floor', () => {
    // The range the model wrongly defaults to starts at the floor and stays
    // under the 14-16Δ ceiling the line contrasts it with.
    const mistake =
      /Common mistake: Defaulting to (\d+)-(\d+)Δ when the calculator ceiling is 14-16Δ\./.exec(
        PROMPT,
      );
    expect(mistake).not.toBeNull();
    expect(Number(mistake![1])).toBe(FLOOR_ENTRY_DELTA);
    expect(Number(mistake![2])).toBeGreaterThan(FLOOR_ENTRY_DELTA);
    expect(Number(mistake![2])).toBeLessThan(14);
    expect(PROMPT).toContain(
      'On most days, the ceiling IS the recommendation.',
    );
  });

  it('shows no sub-floor suggestedDelta in the response-format example', () => {
    const example = /"suggestedDelta": (\d+),/.exec(PROMPT);
    expect(example).not.toBeNull();
    expect(Number(example![1])).toBeGreaterThanOrEqual(FLOOR_ENTRY_DELTA);
  });
});

// The re-checks of 2026-11-27 (docs/tmp/prompt-check-*-2026-11-27.md) measured
// five statements of the prompt again, and each failed or rested on data the
// live analysis does not have:
//
// - "IV Spike Alert": ~127 vs ~87 pts was one day against 28 (2026-04-02), the
//   IV monitor has had no writer since 2026-04-30, and the direction clause has
//   no backing.
// - "Options volume PCR: contrarian signal": never measured, and the live
//   context has no options-volume PCR.
// - "PCR trend (T1->T2) ... 64% UP ... 31% UP": true on 27 days, 57% vs 52% UP
//   on 175 (p = 0.65), and the live analysis never receives the trend.
// - The dark-pool line and the <ml_calibration> block: restated from the
//   146-day and 52-day data, in wording the owner approved.
//
// The system text is cached, so each old claim is asserted gone and each
// replacement is pinned word for word.

const DARK_POOL_LINE =
  "- Dark pool distance to top cluster and total premium: not yet testable at entry time. The stored full-day versions rise with the same day's range (146 days through 2026-11-25), but they include prints after entry, so that is not evidence they predict anything. The idea that a dark pool floor near price helps in deeply negative GEX has no support in the full-day data. Use dark pool levels as context only.";

const CALIBRATION_LINES = [
  'Self-calibration context (end-of-day review labels, 52 days, 2026-01-02 to 2026-04-20; no labels since):',
  '- The review graded 94% of days correct (49/52). Three losses are too few to calibrate on.',
  '- Stated confidence has not been shown to separate outcomes: HIGH 31/32 (97%) vs MODERATE 17/19 (89%), Fisher p = 0.55, Wilson 95% intervals overlap. Do not size on confidence alone: the confidence label caps size per <sizing_tiers>, but does not raise it on its own.',
  '- There is no stored repeat-yesterday correctness baseline and no real sizing backtest; do not cite one.',
];

// The owner-approved range-risk text (docs/superpowers/specs/
// 2026-11-27-analyze-prev-day-range-vix-design.md, approved 18:15 CT with the
// range bullet corrected 22:24 CT). It replaces the two-tier hierarchy, whose
// Tier 1 rested on a 39-day backtest and one outlier day. The cached system
// text carries it, so it is pinned word for word.
const HIERARCHY_LINES = [
  'Re-checked 2026-11-27. Structure-correctness labels: 52 days (2026-01-02 to 04-20), only 3 wrong. Range data: about 210 days to 2026-11-25. No signal below has been shown to predict structure correctness; the only supported effect is range risk.',
  '',
  'What the data supports:',
  "- Range risk: judge it in multiples of today's VIX-implied move (in the Previous Session section), not in fixed points; 100 pts is about 1.5× the implied move at VIX 15 but 0.8× at VIX 28. These multiples measure the session's whole high-to-low range, not how far price travels from the open toward one short strike. Over 207 sessions (2026-01-28 to 11-25) the median day's range was 0.79× its implied move; 27% reached 1.0×, 13.5% reached 1.25× (about 12% when the prior VIX close was below 19, 17% above it) and 6.8% reached 1.5×. Once VIX is known, a 100+ pt previous day and a 2+ pt VIX rise add nothing measurable; don't treat either as a flag.",
  '',
  'Context only (no demonstrated edge):',
  "- Gamma asymmetry (the % above/below ATM split in the Per-Strike Greek Profile; Rule 1's negative-gamma cliff is a separate rule): its link to structure errors rests on one wrong day of 21 (2026-03-23) and shows nothing on 41 days. Don't lower confidence on the skew alone.",
  '- GEX volume: no test supports it as a correctness predictor, and it adds nothing to OI gamma for range. A sign mismatch with OI gamma went with somewhat wider days (85 vs 74 pts, not adjusted for VIX); a mild flag only.',
  "- Flow agreement count (the ML pipeline's count of agreeing flow sources, not shown in this context): it hasn't been shown to predict correctness or direction. Don't rate confidence or size on the count.",
  '',
  'Other signals (untested or context-only):',
  DARK_POOL_LINE,
  '- Max pain: only predictive in the final 2 hours when combined with gamma wall alignment. In isolation it has near-zero predictive power.',
];

// The :1144 directional check is NOT changed by the range-risk work: the owner
// approved dropping "7/9" from the two entry gates only.
const DIRECTIONAL_CHECK_LINE =
  '2. Directional flow agreement from ML-validated sources: Market Tide + at least 2 of (QQQ Net Flow, SPY ETF Tide, QQQ ETF Tide) agree on direction at MODERATE+ confidence. NOTE: For directional conviction, do NOT rely on SPX Net Flow — ML validation across 36 sessions shows it predicts settlement direction only 31% of the time (anti-signal). The reliable directional sources are QQQ Net Flow (61%), Market Tide (61%), SPY ETF Tide (59%), QQQ ETF Tide (59%). This weighting applies ONLY to directionalOpportunity — Rule 8 credit spread weighting is unchanged.';

describe('analyze system prompt — the IV Spike Alert is gone', () => {
  it('has no IV Spike Alert paragraph and none of its figures', () => {
    expect(PROMPT).not.toContain('IV Spike Alert');
    expect(PROMPT).not.toContain('127 pts');
    expect(PROMPT).not.toContain('~87 pts');
    expect(PROMPT).not.toContain('iv_spike_count');
    expect(PROMPT).not.toContain('informed flow buying protection');
  });

  it('keeps the term-structure rules before it and the skew rules after it, adjacent', () => {
    expect(PROMPT).toContain(
      'If the term structure is flat (0DTE ≈ 30D): no additional signal. Use flow and gamma for structure selection.\nIV Skew Metrics (when provided from chain data):',
    );
  });
});

describe('analyze system prompt — the signal hierarchy keeps no unmeasured PCR claim', () => {
  const hierarchy = section('ml_signal_hierarchy');

  it('has the hierarchy block', () => {
    expect(hierarchy).not.toBeNull();
  });

  it('has no options-volume PCR line and no PCR-trend line', () => {
    expect(PROMPT).not.toContain('Options volume PCR');
    expect(PROMPT).not.toContain('contrarian signal that requires');
    expect(PROMPT).not.toContain('PCR trend (T1');
    expect(PROMPT).not.toContain('64% UP settlement');
    expect(PROMPT).not.toContain('31% UP');
    expect(hierarchy).not.toMatch(/\bPCR\b/);
  });

  it('keeps the max pain line, and no longer ends on a rule that ranks tiers', () => {
    expect(hierarchy).toContain(
      '- Max pain: only predictive in the final 2 hours when combined with gamma wall alignment.',
    );
    // The tiers are gone, so "When Tier 1 signals conflict with Tier 2, trust
    // Tier 1." has nothing left to rank.
    expect(hierarchy).not.toContain('When Tier 1 signals conflict');
    expect(hierarchy).not.toContain('trust Tier 1');
  });

  it('states the dark-pool line as not yet testable at entry time, word for word', () => {
    expect(hierarchy).toContain(`${DARK_POOL_LINE}\n- Max pain:`);
    expect(PROMPT).not.toContain('early EDA (39 days)');
    expect(PROMPT).not.toContain('developing hypothesis');
  });
});

describe('analyze system prompt — the hierarchy judges range risk in multiples of the implied move', () => {
  const hierarchy = section('ml_signal_hierarchy');

  it('is the owner-approved block, word for word', () => {
    expect(hierarchy).toBe(
      `<ml_signal_hierarchy>\n${HIERARCHY_LINES.join('\n')}\n`,
    );
  });

  it('drops the tier text and the figures behind it', () => {
    for (const gone of [
      'Backtested feature importance analysis (39 trading days)',
      'TIER 1',
      'TIER 2',
      'Universal predictors',
      'Conditional predictors',
      'validated by both statistical correlation and ML model gain',
      'captured by ML through non-linear interactions',
      'the single strongest predictor',
      'bias toward the defended side',
      'After a 100+ pt range day',
      'Below 4, structure calls are unreliable',
      'trust Tier 1',
      '32%',
      '36% vs 16%',
    ]) {
      expect(hierarchy, gone).not.toContain(gone);
    }
    expect(hierarchy).not.toMatch(/\bTier\b|\bTIER\b/);
  });

  it('renames the second group, and it keeps its two bullets', () => {
    expect(hierarchy).toContain(
      'Other signals (untested or context-only):\n- Dark pool distance',
    );
    expect(hierarchy).toContain('\n- Max pain: only predictive');
  });

  it('points at the section the context carries by the name it is given there', () => {
    expect(hierarchy).toContain('(in the Previous Session section)');
  });

  // The gamma bullet describes a line of the context, so the name it gives and
  // the line it describes are taken from the formatter that prints them.
  it('names the heading the gamma split sits under, and the form the split takes, as the context prints them', () => {
    const row = (strike: number, netGamma: number) => ({
      strike,
      price: 5800,
      timestamp: '2026-03-24T15:00:00Z',
      netGamma,
      netCharm: 0,
      netDelta: 0,
      callGammaOi: 0,
      putGammaOi: 0,
      callCharmOi: 0,
      putCharmOi: 0,
      dirGamma: 0,
      dirCharm: 0,
    });
    const out = formatStrikeExposuresForClaude([row(5850, 80), row(5750, 20)])!;

    expect(out.split('\n')[0]).toContain('Per-Strike Greek Profile');
    expect(out).toMatch(/Gamma Asymmetry: \d+% above \/ \d+% below ATM/);
    expect(hierarchy).toContain(
      '(the % above/below ATM split in the Per-Strike Greek Profile;',
    );
  });

  it("keeps Rule 1's negative-gamma cliff apart from the % split, and Rule 1 itself still stands", () => {
    expect(hierarchy).toContain(
      "Rule 1's negative-gamma cliff is a separate rule)",
    );
    expect(PROMPT).toContain('RULE 1: Gamma Asymmetry Overrides Neutral Flow');
  });

  it('says the flow agreement count is the ML pipeline count, not a line of this context', () => {
    expect(hierarchy).toContain(
      "Flow agreement count (the ML pipeline's count of agreeing flow sources, not shown in this context):",
    );
    expect(hierarchy).not.toContain(
      'Flow agreement count (how many of the flow sources agree)',
    );
  });
});

describe('analyze system prompt — the two entry gates no longer ask for 7/9 flow agreement', () => {
  it('has no 7/9 anywhere', () => {
    expect(PROMPT).not.toContain('7/9');
  });

  it('keeps the BACKWARDATION widening advice, without its agreement sentence', () => {
    expect(PROMPT).toContain(
      '  cones may be understated. Widen IC strikes by 5-10 pts or avoid IC entirely.\n- A "Shift:" line',
    );
    expect(PROMPT).not.toContain('Require flow agreement');
  });

  it('asks for HIGH confidence alone on the ZN flight-to-safety gate', () => {
    expect(PROMPT).toContain(
      'Require HIGH confidence to\n  enter, or SIT OUT.\n- ZN selling + ES selling',
    );
    expect(PROMPT).not.toContain('HIGH confidence + ');
  });

  it('leaves the directional check exactly as it was', () => {
    // Not approved for change: it still asks for Market Tide plus 2 of 3.
    expect(PROMPT).toContain(DIRECTIONAL_CHECK_LINE);
  });
});

describe('analyze system prompt — the calibration block states what the 52 labeled days support', () => {
  it('extends the do-not-size line with the sizing_tiers clause, on that line', () => {
    const block = section('ml_calibration')!;
    const line = block
      .split('\n')
      .find((l) => l.includes('Do not size on confidence alone'));

    expect(line).toMatch(
      /Wilson 95% intervals overlap\. Do not size on confidence alone: the confidence label caps size per <sizing_tiers>, but does not raise it on its own\.$/,
    );
    // One line, not a new bullet: the block is still a header and 3 bullets.
    expect(block.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(3);
  });

  it('does not use the 18:15 wording that contradicted four sizing rules', () => {
    expect(PROMPT).not.toContain('Sizing follows <sizing_tiers>');
    expect(PROMPT).not.toContain('also requires the primary signals to agree');
    expect(PROMPT).not.toContain("by itself doesn't change size");
  });

  it('is the four owner-approved lines and nothing else', () => {
    expect(section('ml_calibration')).toBe(
      `<ml_calibration>\n${CALIBRATION_LINES.join('\n')}\n`,
    );
  });

  it('keeps none of the figures the re-check could not reproduce', () => {
    expect(PROMPT).not.toContain('75% accuracy');
    expect(PROMPT).not.toContain('HIGH confidence calls are 96% accurate');
    expect(PROMPT).not.toContain('$2,600');
    expect(PROMPT).not.toContain('walk-forward ML validation');
  });

  it('no longer points at an "ML Calibration Update" section the context does not carry', () => {
    expect(PROMPT).not.toContain('ML Calibration Update');
    expect(PROMPT).not.toContain('ML Calibration update');
    expect(PROMPT).not.toContain('use updated percentages');
  });

  // Case-sensitive on purpose: the tag is the lowercase <ml_calibration>, and
  // "Self-calibration context" opens the block, so neither can match this.
  it('does not list "ML Calibration" among the structured API sources', () => {
    expect(PROMPT).not.toContain('ML Calibration');
    expect(PROMPT).toContain('Market Internals, GEX Landscape Bias)');
  });

  it('points the SpotGamma sizing overlay at <sizing_tiers>, not at an ML calibration system', () => {
    // Rule 8 is flow weighting, not sizing, so the old "tiers from Rule 8 and
    // the ML calibration system" named two things that do not hold the tiers.
    expect(SPOTGAMMA_MECHANICS_CONTEXT).not.toMatch(/ML calibration/i);
    expect(SPOTGAMMA_MECHANICS_CONTEXT).toContain(
      'Apply this as a modifier to the confidence-based sizing tiers in\n<sizing_tiers>:',
    );
    // The tag it names exists, as a pair, in the system prompt.
    expect(PROMPT).toContain('<sizing_tiers>\n');
    expect(PROMPT).toContain('</sizing_tiers>');
  });
});
