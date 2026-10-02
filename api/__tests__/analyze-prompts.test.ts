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
