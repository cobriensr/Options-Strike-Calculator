// @vitest-environment node

/**
 * Phase 5g follow-up tests for `formatVolRealizedForClaude`.
 *
 * This pure prose factory feeds the analyze.ts prompt prefix; any
 * silent drift in its output (label text, hanging indent, branch
 * thresholds) invalidates Anthropic's cache and burns cost. These
 * equality assertions lock the rendering down so future edits are
 * caught by CI rather than by the next billing cycle.
 */

import { describe, expect, it } from 'vitest';

import {
  formatVolRealizedForClaude,
  type VolRealizedRow,
} from '../_lib/analyze-context-formatters.js';

const ALL_NULL: VolRealizedRow = {
  iv_30d: null,
  rv_30d: null,
  iv_rv_spread: null,
  iv_overpricing_pct: null,
  iv_rank: null,
};

describe('formatVolRealizedForClaude', () => {
  it('returns null when every column is null', () => {
    expect(formatVolRealizedForClaude(ALL_NULL)).toBeNull();
  });

  it('renders IV OVERPRICING when iv_rv_spread > 0', () => {
    const out = formatVolRealizedForClaude({
      ...ALL_NULL,
      iv_30d: 0.2,
      rv_30d: 0.15,
      iv_rv_spread: 0.05,
    });
    expect(out).toBe(
      '30D Implied Vol: 20.0% | 30D Realized Vol: 15.0%\n  IV-RV Spread: 5.0 vol pts (IV OVERPRICING)',
    );
  });

  it('renders IV UNDERPRICING when iv_rv_spread < 0', () => {
    const out = formatVolRealizedForClaude({
      ...ALL_NULL,
      iv_30d: 0.15,
      rv_30d: 0.22,
      iv_rv_spread: -0.07,
    });
    expect(out).toBe(
      '30D Implied Vol: 15.0% | 30D Realized Vol: 22.0%\n  IV-RV Spread: -7.0 vol pts (IV UNDERPRICING)',
    );
  });

  it('renders "premium is rich" when overpricing > 10', () => {
    const out = formatVolRealizedForClaude({
      ...ALL_NULL,
      iv_30d: 0.2,
      rv_30d: 0.15,
      iv_overpricing_pct: 15,
    });
    expect(out).toBe(
      '30D Implied Vol: 20.0% | 30D Realized Vol: 15.0%\n  Overpricing: 15.0% — premium is rich, favorable for selling',
    );
  });

  it('renders "premium is cheap" when overpricing < -10', () => {
    const out = formatVolRealizedForClaude({
      ...ALL_NULL,
      iv_30d: 0.15,
      rv_30d: 0.2,
      iv_overpricing_pct: -15,
    });
    expect(out).toBe(
      '30D Implied Vol: 15.0% | 30D Realized Vol: 20.0%\n  Overpricing: -15.0% — premium is cheap, caution selling',
    );
  });

  it('renders "fairly priced" when overpricing is in mid-range', () => {
    const out = formatVolRealizedForClaude({
      ...ALL_NULL,
      iv_30d: 0.2,
      rv_30d: 0.18,
      iv_overpricing_pct: 5,
    });
    expect(out).toBe(
      '30D Implied Vol: 20.0% | 30D Realized Vol: 18.0%\n  Overpricing: 5.0% — fairly priced',
    );
  });

  it('renders "elevated, rich premium" when rank > 70', () => {
    const out = formatVolRealizedForClaude({
      ...ALL_NULL,
      iv_rank: 85,
    });
    expect(out).toBe(
      'IV Rank (1-year): 85th percentile — elevated, rich premium',
    );
  });

  it('renders "low, cheap premium" when rank < 30', () => {
    const out = formatVolRealizedForClaude({
      ...ALL_NULL,
      iv_rank: 15,
    });
    expect(out).toBe('IV Rank (1-year): 15th percentile — low, cheap premium');
  });

  it('renders "mid-range" when rank is between 30 and 70', () => {
    const out = formatVolRealizedForClaude({
      ...ALL_NULL,
      iv_rank: 50,
    });
    expect(out).toBe('IV Rank (1-year): 50th percentile — mid-range');
  });

  it('preserves the two-space hanging indent across all line joins', () => {
    // Cache-prefix-stability guard: analyze.ts assembles the system
    // prompt from this output verbatim, so any change to "\n  " (the
    // hanging indent that visually nests sub-bullets under the IV/RV
    // header) shifts every downstream byte and breaks the prompt
    // cache. Lock it with an explicit substring assertion.
    const out = formatVolRealizedForClaude({
      iv_30d: 0.2,
      rv_30d: 0.15,
      iv_rv_spread: 0.05,
      iv_overpricing_pct: 33,
      iv_rank: 80,
    });
    expect(out).toBe(
      [
        '30D Implied Vol: 20.0% | 30D Realized Vol: 15.0%',
        '  IV-RV Spread: 5.0 vol pts (IV OVERPRICING)',
        '  Overpricing: 33.0% — premium is rich, favorable for selling',
        '  IV Rank (1-year): 80th percentile — elevated, rich premium',
      ].join('\n'),
    );
    // Sanity: every join is exactly "\n  " (newline + two spaces),
    // never "\n " or "\n" alone.
    expect(out).toContain('\n  IV-RV Spread');
    expect(out).toContain('\n  Overpricing');
    expect(out).toContain('\n  IV Rank');
    expect(out).not.toMatch(/\n [^ ]/);
    expect(out).not.toMatch(/\n {3,}/);
  });
});
