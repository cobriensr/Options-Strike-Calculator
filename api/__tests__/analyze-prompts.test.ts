// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  SYSTEM_PROMPT_PART1,
  SYSTEM_PROMPT_PART2,
} from '../_lib/analyze-prompts.js';

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
      'VIX Futures Term Structure:',
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
      'ES basis, NQ divergence, ZN flight-to-safety, RTY breadth, CL oil shock, GC safe haven — which futures signals are active',
    );
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
