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
      'You will receive up to 2 screenshots; only those labelled UW Periscope (Gamma or Charm) are Periscope data,',
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
      'In every case, a missing SPX Net Flow never counts toward either LOW trigger.',
    );
    // NB1: the absence sentence names UW Periscope, not "Its".
    expect(line).toContain(
      "UW Periscope's absence applies only the MODERATE cap.",
    );
    expect(line).not.toContain('Its absence applies only the MODERATE cap.');
  });

  it('keeps one failed feed at MODERATE when UW Periscope is absent (N1)', () => {
    // Without UW Periscope the structure primaries are SPX Net Flow and
    // Market Tide, so "only 1 primary available" would fire LOW on one
    // failed feed. The LOW triggers count the Missing Data Protocol's list.
    expect(
      lineStartingWith('Primary signals for structure selection'),
    ).toContain(
      'Without UW Periscope data, both LOW triggers ("only 1 primary signal is available" and "2+ primary data sources are unavailable") count only the Missing Data Protocol\'s primary API list (Market Tide, QQQ Net Flow, Aggregate GEX): one unavailable feed stays MODERATE, and a missing SPX Net Flow never lowers confidence.',
    );
    expect(PROMPT).not.toContain(
      'judge the LOW triggers on the API primaries alone',
    );
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

  it('pins the floor at 10Δ (owner decision 2026-10-28)', () => {
    expect(FLOOR_ENTRY_DELTA).toBe(10);
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

  it.each(MODES)('has no leftover 8Δ floor wording (%s)', (mode) => {
    const text = stableSystemText(mode);
    expect(text).not.toMatch(/\b8Δ (premium )?floor/i);
    expect(text).not.toContain('8Δ is the absolute minimum');
    expect(text).not.toMatch(/\b8Δ\+/);
    expect(text).not.toMatch(/\b8-10Δ/);
    expect(text).not.toMatch(/suggestedDelta must be >= 8\b/);
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
    expect(PROMPT).toContain(
      `Common mistake: Defaulting to ${FLOOR_ENTRY_DELTA}-${FLOOR_ENTRY_DELTA + 1}Δ when the calculator ceiling is 14-16Δ.`,
    );
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
