// @vitest-environment node

/**
 * Coverage-fill tests for analyze-context-formatters.ts.
 *
 * The companion suite `format-vol-realized.test.ts` covers
 * `formatVolRealizedForClaude`. This file targets the remaining uncovered
 * surface:
 *   - `formatMlFindingsForClaude` early-return branch when findings.dataset
 *     is missing (line 91).
 *   - `formatSimilarDaysForClaude` full body (lines 524-543), including the
 *     empty-cohort fast path and the multi-analog rendering.
 *
 * These are pure string formatters that feed the analyze.ts cached prompt
 * prefix — silent drift in the output bytes invalidates Anthropic's cache
 * and burns dollars, so the assertions lock the rendered text where it
 * matters.
 */

import { describe, expect, it } from 'vitest';

import {
  formatMlFindingsForClaude,
  formatSimilarDaysForClaude,
  type HistoricalAnalog,
} from '../_lib/analyze-context-formatters.js';

// ── formatMlFindingsForClaude — line 91 (no-dataset fast path) ────────

describe('formatMlFindingsForClaude (no-dataset fast path)', () => {
  const FIXED_UPDATED_AT = new Date('2026-04-04T09:37:49Z');

  it('returns the "data unavailable" line when findings is empty', () => {
    const out = formatMlFindingsForClaude({}, FIXED_UPDATED_AT);
    expect(out).toBe('Latest ML pipeline run: 2026-04-04 (data unavailable)');
  });

  it('returns the "data unavailable" line when findings.dataset is explicitly missing', () => {
    // Other top-level keys are present but `dataset` is not — guard must
    // still short-circuit. This pins the precise key check (`!findings?.dataset`).
    const out = formatMlFindingsForClaude(
      {
        confidence_calibration: { HIGH: { correct: 1, total: 1, rate: 1 } },
        flow_reliability: {},
      },
      FIXED_UPDATED_AT,
    );
    expect(out).toBe('Latest ML pipeline run: 2026-04-04 (data unavailable)');
  });

  it('formats the date as ISO-8601 YYYY-MM-DD (not localized)', () => {
    // The slice(0, 10) on toISOString() makes the date UTC-stable. A late
    // afternoon UTC instant on April 4 must still render as 2026-04-04,
    // not the local-tz April 3/4 boundary.
    const lateUtc = new Date('2026-04-04T23:59:59Z');
    const out = formatMlFindingsForClaude({}, lateUtc);
    expect(out).toBe('Latest ML pipeline run: 2026-04-04 (data unavailable)');
  });
});

// ── formatSimilarDaysForClaude — lines 525-543 (full body) ────────────

describe('formatSimilarDaysForClaude', () => {
  const TODAY_SUMMARY =
    'SPX 5700, GEX -2.1B, VIX 18.3, breadth weak, gap +0.3%';

  it('returns an empty string when analogs is empty', () => {
    // Empty-cohort fast path — callers compare against '' (falsy) to drop
    // the historical-analogs section from the prompt.
    expect(formatSimilarDaysForClaude(TODAY_SUMMARY, [])).toBe('');
  });

  it('renders today summary + one analog row + closing prose for a single analog', () => {
    const analogs: HistoricalAnalog[] = [
      {
        date: '2025-11-12',
        symbol: 'SPX',
        summary: '2025-11-12 SPX 5680, GEX -1.8B, closed +0.45%',
        distance: 0.083,
      },
    ];

    const out = formatSimilarDaysForClaude(TODAY_SUMMARY, analogs);

    // Today header + indented summary
    expect(out).toContain('Today:');
    expect(out).toContain(`  ${TODAY_SUMMARY}`);

    // The "Top N" header should report the cohort size verbatim.
    expect(out).toContain(
      'Top 1 historical analog days (by embedding cosine similarity):',
    );

    // Single row is rank " 1." (two-space pad on a 1-char rank) followed
    // by the summary text.
    expect(out).toContain(
      '   1. 2025-11-12 SPX 5680, GEX -1.8B, closed +0.45%',
    );

    // Closing prose primes Claude on how to treat the cohort.
    expect(out).toContain('structurally similar setups');
    expect(out).toContain('Do not treat as deterministic.');
  });

  it('renders all rows in source order and right-pads single-digit ranks', () => {
    const analogs: HistoricalAnalog[] = [
      {
        date: '2025-11-12',
        symbol: 'SPX',
        summary: 'A first analog summary',
        distance: 0.05,
      },
      {
        date: '2025-10-30',
        symbol: 'SPX',
        summary: 'A second analog summary',
        distance: 0.07,
      },
      {
        date: '2025-09-21',
        symbol: 'SPX',
        summary: 'A third analog summary',
        distance: 0.11,
      },
    ];

    const out = formatSimilarDaysForClaude(TODAY_SUMMARY, analogs);

    // Header reflects the cohort size.
    expect(out).toContain(
      'Top 3 historical analog days (by embedding cosine similarity):',
    );

    // Each row is present and in input order.
    expect(out).toContain('   1. A first analog summary');
    expect(out).toContain('   2. A second analog summary');
    expect(out).toContain('   3. A third analog summary');

    // Order is preserved end-to-end — the index of row 1 < row 2 < row 3.
    const idx1 = out.indexOf('   1. A first analog summary');
    const idx2 = out.indexOf('   2. A second analog summary');
    const idx3 = out.indexOf('   3. A third analog summary');
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
  });

  it('right-pads ranks to width 2 so 1-9 align with 10+', () => {
    // Build a cohort with 10 analogs so ranks span both 1-digit and
    // 2-digit. Rank " 9." has a leading space; rank "10." does not.
    const analogs: HistoricalAnalog[] = Array.from({ length: 10 }, (_, i) => ({
      date: `2025-10-${(i + 1).toString().padStart(2, '0')}`,
      symbol: 'SPX',
      summary: `Analog #${i + 1} summary`,
      distance: 0.01 * (i + 1),
    }));

    const out = formatSimilarDaysForClaude(TODAY_SUMMARY, analogs);

    // Single-digit rank carries a leading space inside the two-space indent.
    expect(out).toContain('   9. Analog #9 summary');
    // Double-digit rank consumes both pad characters.
    expect(out).toContain('  10. Analog #10 summary');

    // The header should say "Top 10" (not "Top  10" or similar).
    expect(out).toContain(
      'Top 10 historical analog days (by embedding cosine similarity):',
    );
  });

  it('preserves the exact line structure: today block, blank, header, rows, blank, prose', () => {
    const analogs: HistoricalAnalog[] = [
      {
        date: '2025-11-12',
        symbol: 'SPX',
        summary: 'Row one',
        distance: 0.05,
      },
      {
        date: '2025-10-30',
        symbol: 'SPX',
        summary: 'Row two',
        distance: 0.07,
      },
    ];

    const out = formatSimilarDaysForClaude('TODAY_LINE', analogs);
    const lines = out.split('\n');

    // The exact line layout is part of the prompt prefix cache key:
    // [0] "Today:"
    // [1] "  TODAY_LINE"
    // [2] ""           (blank)
    // [3] "Top 2 historical analog days (by embedding cosine similarity):"
    // [4] "   1. Row one"
    // [5] "   2. Row two"
    // [6] ""           (blank)
    // [7] prose
    expect(lines[0]).toBe('Today:');
    expect(lines[1]).toBe('  TODAY_LINE');
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe(
      'Top 2 historical analog days (by embedding cosine similarity):',
    );
    expect(lines[4]).toBe('   1. Row one');
    expect(lines[5]).toBe('   2. Row two');
    expect(lines[6]).toBe('');
    expect(lines[7]).toMatch(/^These are structurally similar setups/);
  });

  it('ignores the distance field when rendering (rank is the only ordinal surfaced)', () => {
    // The docstring specifies that raw cosine distance is intentionally
    // hidden — only the integer rank is surfaced. Pin that contract so a
    // future "helpful" edit that prints distance is caught here.
    const analogs: HistoricalAnalog[] = [
      {
        date: '2025-11-12',
        symbol: 'SPX',
        summary: 'Row alpha',
        distance: 0.123456789,
      },
    ];

    const out = formatSimilarDaysForClaude(TODAY_SUMMARY, analogs);
    expect(out).not.toContain('0.123');
    expect(out).not.toContain('distance');
    expect(out).not.toContain('cosine distance');
  });
});
