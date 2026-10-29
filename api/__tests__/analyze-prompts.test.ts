// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  SYSTEM_PROMPT_PART1,
  SYSTEM_PROMPT_PART2,
} from '../_lib/analyze-prompts.js';
import {
  VIX_RATIO_BACKWARDATION_MIN,
  VIX_RATIO_CONTANGO_MAX,
} from '../_lib/vix-term-structure.js';
import { MARKET_MECHANICS_CONTEXT } from '../_lib/market-mechanics.js';
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
