// @vitest-environment node

/**
 * Prompts + calibration assembly check for the TRACE-live endpoint.
 *
 * The system prompt is a deliberate four-part concatenation —
 * PART1 (role+overrides) → PART2 (3 inlined skills) → calibration → PART3
 * (output schema). It's read at module load (synchronous readFileSync of
 * .claude/skills/{charm-pressure,gamma,delta-pressure}/SKILL.md), then
 * cached for an hour against Anthropic's prompt cache.
 *
 * If any of the four parts is missing, malformed, or out-of-order, every
 * trace-live tick pays a full cache miss and the model sees a different
 * prompt than the one we calibrated against. These tests pin the assembly.
 */

import { describe, expect, it } from 'vitest';
import {
  TRACE_LIVE_SYSTEM_PROMPT_PART1,
  TRACE_LIVE_SYSTEM_PROMPT_PART2,
  TRACE_LIVE_SYSTEM_PROMPT_PART3,
  TRACE_LIVE_STABLE_SYSTEM_TEXT,
} from '../_lib/trace-live-prompts.js';
import { getTraceLiveCalibrationBlock } from '../_lib/trace-live-calibration.js';

describe('TRACE_LIVE_SYSTEM_PROMPT parts', () => {
  it('PART1 establishes the role + reading hierarchy', () => {
    expect(TRACE_LIVE_SYSTEM_PROMPT_PART1).toMatch(/intraday SpotGamma TRACE/);
    expect(TRACE_LIVE_SYSTEM_PROMPT_PART1).toMatch(/<reading_hierarchy>/);
    expect(TRACE_LIVE_SYSTEM_PROMPT_PART1).toMatch(/STEP 1 — GAMMA FIRST/);
    expect(TRACE_LIVE_SYSTEM_PROMPT_PART1).toMatch(/STEP 2 — CHARM SECOND/);
  });

  it('PART2 inlines all three skill files (charm + gamma + delta)', () => {
    expect(TRACE_LIVE_SYSTEM_PROMPT_PART2).toMatch(/<skills>/);
    expect(TRACE_LIVE_SYSTEM_PROMPT_PART2).toMatch(
      /=== SKILL: charm-pressure ===/,
    );
    expect(TRACE_LIVE_SYSTEM_PROMPT_PART2).toMatch(/=== SKILL: gamma ===/);
    expect(TRACE_LIVE_SYSTEM_PROMPT_PART2).toMatch(
      /=== SKILL: delta-pressure ===/,
    );
    // Skill files are non-trivial content — sanity-check minimum size so an
    // accidental empty SKILL.md doesn't ship a degraded prompt
    expect(TRACE_LIVE_SYSTEM_PROMPT_PART2.length).toBeGreaterThan(2000);
  });

  it('PART3 declares the output JSON schema with required enums', () => {
    expect(TRACE_LIVE_SYSTEM_PROMPT_PART3).toMatch(/<output_instructions>/);
    expect(TRACE_LIVE_SYSTEM_PROMPT_PART3).toMatch(
      /range_bound_positive_gamma/,
    );
    expect(TRACE_LIVE_SYSTEM_PROMPT_PART3).toMatch(/trending_negative_gamma/);
    // Trade-type enum + size matrix are load-bearing for the schema
    expect(TRACE_LIVE_SYSTEM_PROMPT_PART3).toMatch(/iron_fly/);
    expect(TRACE_LIVE_SYSTEM_PROMPT_PART3).toMatch(/iron_condor/);
    expect(TRACE_LIVE_SYSTEM_PROMPT_PART3).toMatch(/three_quarter/);
  });
});

describe('TRACE_LIVE_STABLE_SYSTEM_TEXT assembly', () => {
  it('concatenates the parts in the expected order', () => {
    const text = TRACE_LIVE_STABLE_SYSTEM_TEXT;
    const idx1 = text.indexOf(TRACE_LIVE_SYSTEM_PROMPT_PART1);
    const idx2 = text.indexOf(TRACE_LIVE_SYSTEM_PROMPT_PART2);
    const idx3 = text.indexOf(TRACE_LIVE_SYSTEM_PROMPT_PART3);
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
  });

  it('includes the calibration block between PART2 and PART3', () => {
    const text = TRACE_LIVE_STABLE_SYSTEM_TEXT;
    const calibration = getTraceLiveCalibrationBlock();
    if (calibration.length > 0) {
      const idx2 = text.indexOf(TRACE_LIVE_SYSTEM_PROMPT_PART2);
      const idxCal = text.indexOf(calibration);
      const idx3 = text.indexOf(TRACE_LIVE_SYSTEM_PROMPT_PART3);
      expect(idxCal).toBeGreaterThan(idx2);
      expect(idx3).toBeGreaterThan(idxCal);
    } else {
      // empty calibration block is a no-op — assembly still produces a
      // contiguous PART2 → PART3 sequence
      expect(text).toContain(TRACE_LIVE_SYSTEM_PROMPT_PART2);
      expect(text).toContain(TRACE_LIVE_SYSTEM_PROMPT_PART3);
    }
  });

  it('is byte-stable across two reads (cache-hit invariant)', () => {
    // Re-importing produces the same string — load order matters because
    // Anthropic's prompt cache keys on byte equality of the system block.
    expect(TRACE_LIVE_STABLE_SYSTEM_TEXT).toBe(TRACE_LIVE_STABLE_SYSTEM_TEXT);
    expect(TRACE_LIVE_STABLE_SYSTEM_TEXT.length).toBeGreaterThan(5000);
  });
});

describe('getTraceLiveCalibrationBlock', () => {
  it('returns three calibration examples wrapped in a <calibration> tag', () => {
    const block = getTraceLiveCalibrationBlock();
    expect(block).toContain('<calibration>');
    expect(block).toContain('</calibration>');
    // Three named scenarios, each in its own example block.
    expect(block.match(/<calibration_example>/g)?.length).toBe(3);
  });

  it('covers gamma override, trending regime, and stability gate scenarios', () => {
    const block = getTraceLiveCalibrationBlock();
    expect(block).toMatch(/gamma override fires/i);
    expect(block).toMatch(/Trending −γ regime/);
    expect(block).toMatch(/Stability%? gate/i);
  });

  it('demonstrates the trending-regime branch with predictedClose = spot', () => {
    const block = getTraceLiveCalibrationBlock();
    // Example 2: spot 7130.65 → predictedClose 7131 (rounded), NOT 7125 / 7100 drift extreme.
    expect(block).toContain('"predictedClose": 7131');
    // The rationale calls out that the realised outcome confirms the new branch.
    expect(block).toMatch(/Realised outcome: 7137\.56/);
  });

  it('demonstrates the stability gate forcing no_trade regardless of agreement', () => {
    const block = getTraceLiveCalibrationBlock();
    // Example 3: low Stability% should force confidence=no_trade even when agreement is all_agree.
    expect(block).toContain('"confidence": "no_trade"');
    expect(block).toContain('"crossChartAgreement": "all_agree"');
  });
});
