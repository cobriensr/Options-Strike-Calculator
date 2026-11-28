// @vitest-environment node

/**
 * Coverage-fill tests for analyze-context-formatters.ts.
 *
 * The companion suite `format-vol-realized.test.ts` covers
 * `formatVolRealizedForClaude`. This file targets the remaining uncovered
 * surface:
 *   - `formatSimilarDaysForClaude` full body, including the empty-cohort
 *     fast path and the multi-analog rendering.
 *   - `formatPrevSessionForClaude`: the previous session's range and VIX
 *     change, and today's VIX-implied move, from two `outcomes` rows.
 *
 * These are pure string formatters that feed the analyze.ts cached prompt
 * prefix — silent drift in the output bytes invalidates Anthropic's cache
 * and burns dollars, so the assertions lock the rendered text where it
 * matters.
 */

import { describe, expect, it, vi } from 'vitest';

// The calendar is real except for one spy: the half-day line must take its
// close hour from getEarlyCloseHourET, not from a literal. isHalfDay reads the
// calendar's own map, so only the hour the formatter prints is changed.
vi.mock('../../src/data/marketHours.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/data/marketHours.js')>();
  return {
    ...actual,
    getEarlyCloseHourET: vi.fn(actual.getEarlyCloseHourET),
  };
});

import { getEarlyCloseHourET } from '../../src/data/marketHours.js';
import {
  formatPrevSessionForClaude,
  formatSimilarDaysForClaude,
  type HistoricalAnalog,
  type OutcomesDay,
  type PrevSessionInput,
} from '../_lib/analyze-context-formatters.js';

// ── formatSimilarDaysForClaude (full body) ────────────────────────────

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

// ── formatPrevSessionForClaude ────────────────────────────────────────
//
// The worked example is the spec's: D = 2026-11-27 (Black Friday, a half day),
// P1 = 11-25 (Thanksgiving was closed) and P2 = 11-24.

describe('formatPrevSessionForClaude', () => {
  const P1: OutcomesDay = {
    settlement: 7182.73,
    day_high: 7199.31,
    day_low: 6970.11,
    day_range_pts: 229,
    vix_close: 28.29,
  };
  const P2: OutcomesDay = {
    settlement: 7202.45,
    day_high: 7230,
    day_low: 7100.1,
    day_range_pts: 130,
    vix_close: 26.36,
  };
  // No history: the recent-sessions line reads "unavailable" until a test below
  // supplies one.
  const NO_RECENT = new Map<string, OutcomesDay>();
  const WORKED: PrevSessionInput = {
    analysisDate: '2026-11-27',
    p1Date: '2026-11-25',
    p2Date: '2026-11-24',
    p1: P1,
    p2: P2,
    recent: NO_RECENT,
  };
  // An ordinary Wednesday: neither D nor P1 is a half day.
  const NORMAL: PrevSessionInput = {
    ...WORKED,
    analysisDate: '2026-12-02',
    p1Date: '2026-12-01',
    p2Date: '2026-11-30',
  };

  const implied = (p1Date: string) =>
    `Today's VIX-implied move (prior-close VIX): 128.0 pts (SPX close 7182.73 × VIX 28.29 / 100 / √252, ${p1Date}). Session high-to-low range at 1.0× = 128, 1.25× = 160, 1.5× = 192 pts (whole range, not distance from the open).`;
  const RECENT_UNAVAILABLE =
    'Recent sessions: unavailable (fewer than 10 usable sessions).';
  const range = (p1Date: string) =>
    `Previous day range (${p1Date}): 229 pts (high 7199.31, low 6970.11) = 1.92× that day's implied move (119.6 pts).`;
  const vixChange = (p1Date: string) =>
    `VIX change (${p1Date}, close to close): +1.93 (26.36 → 28.29), +7.3%.`;
  const HALF_DAY_TODAY =
    "Today is a half day (close 12:00 CT); the prompt's base rates come from full sessions and overstate today's range.";

  const withP1 = (over: Partial<OutcomesDay>): PrevSessionInput => ({
    ...NORMAL,
    p1: { ...P1, ...over },
  });
  const withP2 = (over: Partial<OutcomesDay>): PrevSessionInput => ({
    ...NORMAL,
    p2: { ...P2, ...over },
  });

  it('renders the worked example exactly: recent sessions after the VIX change, the half-day line last', () => {
    expect(formatPrevSessionForClaude(WORKED)).toBe(
      [
        implied('2026-11-25'),
        range('2026-11-25'),
        vixChange('2026-11-25'),
        RECENT_UNAVAILABLE,
        HALF_DAY_TODAY,
      ].join('\n'),
    );
  });

  it('adds no half-day line on a normal day', () => {
    const out = formatPrevSessionForClaude(NORMAL);

    expect(out).toBe(
      [
        implied('2026-12-01'),
        range('2026-12-01'),
        vixChange('2026-12-01'),
        RECENT_UNAVAILABLE,
      ].join('\n'),
    );
    expect(out).not.toContain('half day');
  });

  it('labels the implied move as the prior-close VIX move, on the unavailable line too', () => {
    // So it is not mistaken for the 0DTE ATM implied move in the IV term
    // structure block, or for the live VIX.
    expect(formatPrevSessionForClaude(NORMAL)).toContain(
      "Today's VIX-implied move (prior-close VIX): 128.0 pts",
    );
    expect(
      formatPrevSessionForClaude({
        ...NORMAL,
        p1: { ...P1, settlement: null },
      }),
    ).toContain("Today's VIX-implied move (prior-close VIX): unavailable");
  });

  it('says the levels are the whole high-to-low range, not distance from the open', () => {
    expect(formatPrevSessionForClaude(NORMAL)).toContain(
      '(whole range, not distance from the open)',
    );
  });

  it('rounds the 1.0x, 1.25x and 1.5x levels to whole points from the unrounded move', () => {
    // 5000 x 20 / 100 / sqrt(252) = 62.99 pts: 63.0 shown, levels 63 / 79 / 94
    // (78.74 and 94.49 round to 79 and 94).
    const out = formatPrevSessionForClaude(
      withP1({ settlement: 5000, vix_close: 20 }),
    );

    expect(out).toContain(
      "Today's VIX-implied move (prior-close VIX): 63.0 pts (SPX close 5000.00 × VIX 20.00 / 100 / √252, 2026-12-01).",
    );
    expect(out).toContain('1.0× = 63, 1.25× = 79, 1.5× = 94 pts');
  });

  it('signs a falling VIX with a minus on both the change and the percent', () => {
    // 27.44 - 28.29 = -0.85; -0.85 / 28.29 = -3.0%.
    const out = formatPrevSessionForClaude({
      ...NORMAL,
      p1: { ...P1, vix_close: 27.44 },
      p2: { ...P2, vix_close: 28.29 },
    });

    expect(out).toContain(
      'VIX change (2026-12-01, close to close): -0.85 (28.29 → 27.44), -3.0%.',
    );
  });

  it('signs an unchanged VIX as plus zero', () => {
    const out = formatPrevSessionForClaude({
      ...NORMAL,
      p1: { ...P1, vix_close: 28.29 },
      p2: { ...P2, vix_close: 28.29 },
    });

    expect(out).toContain('+0.00 (28.29 → 28.29), +0.0%.');
  });

  describe('P2 missing (no row at all)', () => {
    const out = formatPrevSessionForClaude({ ...NORMAL, p2: null });

    it('still shows the implied move', () => {
      expect(out.split('\n')[0]).toBe(implied('2026-12-01'));
    });

    it('prints the range with no multiple, and says why', () => {
      expect(out.split('\n')[1]).toBe(
        'Previous day range (2026-12-01): 229 pts (high 7199.31, low 6970.11); no implied-move multiple, because 2026-11-30 has no usable SPX close and VIX close.',
      );
    });

    it('says the VIX change is unavailable', () => {
      expect(out.split('\n')[2]).toBe(
        'VIX change (2026-12-01, close to close): unavailable (needs a usable VIX close for 2026-12-01 and 2026-11-30).',
      );
    });
  });

  describe('P1 close or VIX unusable', () => {
    const IMPLIED_UNAVAILABLE =
      "Today's VIX-implied move (prior-close VIX): unavailable (no usable SPX close and VIX close for 2026-12-01).";

    it.each([
      ['settlement NULL', { settlement: null }],
      ['settlement zero', { settlement: 0 }],
      ['settlement negative', { settlement: -7182.73 }],
      ['vix_close NULL', { vix_close: null }],
      ['vix_close zero', { vix_close: 0 }],
      ['vix_close negative', { vix_close: -28.29 }],
    ])('says the implied move is unavailable: %s', (_label, over) => {
      const out = formatPrevSessionForClaude(withP1(over));

      expect(out.split('\n')[0]).toBe(IMPLIED_UNAVAILABLE);
      expect(out).not.toMatch(/NaN|Infinity/);
    });

    it('keeps the range and the VIX change when only the close is bad', () => {
      const out = formatPrevSessionForClaude(withP1({ settlement: null }));

      // The range's multiple needs P2's close and VIX, and the VIX change
      // needs both VIX closes; neither reads P1's settlement.
      expect(out).toContain(range('2026-12-01'));
      expect(out).toContain(vixChange('2026-12-01'));
    });

    it.each([
      ['NULL', null],
      ['zero', 0],
      ['negative', -28.29],
    ])('also loses the VIX change when vix_close is %s', (_label, vix) => {
      const out = formatPrevSessionForClaude(withP1({ vix_close: vix }));

      expect(out).toContain(
        'VIX change (2026-12-01, close to close): unavailable (needs a usable VIX close for 2026-12-01 and 2026-11-30).',
      );
    });
  });

  describe('P2 close or VIX unusable', () => {
    const NO_MULTIPLE =
      'Previous day range (2026-12-01): 229 pts (high 7199.31, low 6970.11); no implied-move multiple, because 2026-11-30 has no usable SPX close and VIX close.';

    it.each([
      ['settlement NULL', { settlement: null }],
      ['settlement zero', { settlement: 0 }],
      ['settlement negative', { settlement: -1 }],
      ['vix_close NULL', { vix_close: null }],
      ['vix_close zero', { vix_close: 0 }],
      ['vix_close negative', { vix_close: -26.36 }],
    ])('prints the range with no multiple: %s', (_label, over) => {
      const out = formatPrevSessionForClaude(withP2(over));

      expect(out.split('\n')[1]).toBe(NO_MULTIPLE);
      // Today's implied move reads only P1.
      expect(out.split('\n')[0]).toBe(implied('2026-12-01'));
      expect(out).not.toMatch(/NaN|Infinity/);
    });

    it('keeps the VIX change when only the close is bad', () => {
      expect(
        formatPrevSessionForClaude(withP2({ settlement: null })),
      ).toContain(vixChange('2026-12-01'));
    });

    it('loses the VIX change when vix_close is bad', () => {
      expect(formatPrevSessionForClaude(withP2({ vix_close: null }))).toContain(
        'VIX change (2026-12-01, close to close): unavailable',
      );
    });
  });

  describe('P1 range columns', () => {
    it.each([
      ['day_range_pts', { day_range_pts: null }],
      ['day_high', { day_high: null }],
      ['day_low', { day_low: null }],
    ])('says the range is unavailable when %s is NULL', (_label, over) => {
      const out = formatPrevSessionForClaude(withP1(over));

      expect(out.split('\n')[1]).toBe(
        'Previous day range (2026-12-01): unavailable (no usable high, low and range in outcomes).',
      );
      // The other two lines read other columns and are unaffected.
      expect(out.split('\n')[0]).toBe(implied('2026-12-01'));
      expect(out.split('\n')[2]).toBe(vixChange('2026-12-01'));
    });

    // A day cannot have a high at or below its low, so a stored pair like that
    // is bad data, not a quiet day: it must not print a negative multiple or a
    // "0.00×" one.
    it.each([
      [
        'an inverted range (high below low)',
        { day_high: 6970.11, day_low: 7199.31 },
      ],
      ['a zero range (high equal to low)', { day_high: 7000, day_low: 7000 }],
    ])(
      'says the range is unavailable, with no multiple, for %s',
      (_label, over) => {
        const out = formatPrevSessionForClaude(withP1(over));

        expect(out.split('\n')[1]).toBe(
          'Previous day range (2026-12-01): unavailable (no usable high, low and range in outcomes).',
        );
        expect(out).not.toMatch(/-\d+\.\d+×|0\.00×/);
      },
    );
  });

  it('never prints NaN or Infinity, whatever the inputs hold', () => {
    const junk: OutcomesDay = {
      settlement: Number.NaN,
      day_high: Number.POSITIVE_INFINITY,
      day_low: Number.NEGATIVE_INFINITY,
      day_range_pts: Number.NaN,
      vix_close: Number.POSITIVE_INFINITY,
    };

    for (const input of [
      { ...NORMAL, p1: junk, p2: junk },
      { ...NORMAL, p1: junk },
      { ...NORMAL, p2: junk },
      {
        ...NORMAL,
        p1: { ...P1, settlement: 0, vix_close: 0 },
        p2: { ...P2, settlement: 0, vix_close: 0 },
      },
    ]) {
      expect(formatPrevSessionForClaude(input)).not.toMatch(/NaN|Infinity/);
    }
  });

  describe('recent sessions line', () => {
    // sqrt(252) is the spec's annualisation. A day's implied move is its close
    // x VIX / 100 / sqrt(252); here every ordinary row has close 7000, VIX 25.
    /**
     * Rows for `datesDesc` (newest first). Row i is a session whose high-to-low
     * range is `multiples[i]` times the implied move of row i + 1, the day
     * before it. The last row is only that day before the oldest session.
     * `real` overrides named rows (the spec's worked-example rows).
     */
    function history(
      datesDesc: string[],
      multiples: number[],
      real: Record<string, Partial<OutcomesDay>> = {},
    ): Map<string, OutcomesDay> {
      const close = (date: string) => real[date]?.settlement ?? 7000;
      const vix = (date: string) => real[date]?.vix_close ?? 25;
      const rows = new Map<string, OutcomesDay>();
      datesDesc.forEach((date, i) => {
        const priorDate = datesDesc[i + 1];
        const em =
          priorDate === undefined
            ? 0
            : (close(priorDate) * vix(priorDate)) / 100 / Math.sqrt(252);
        const range = (multiples[i] ?? 0) * em;
        rows.set(date, {
          settlement: close(date),
          vix_close: vix(date),
          day_low: 6900,
          day_high: 6900 + Math.round(range * 100) / 100,
          day_range_pts: Math.round(range),
          ...real[date],
        });
      });
      return rows;
    }

    /** 21 consecutive trading days ending 2026-11-25 (11-26 was closed). */
    const DATES_21 = [
      '2026-11-25',
      '2026-11-24',
      '2026-11-23',
      '2026-11-20',
      '2026-11-19',
      '2026-11-18',
      '2026-11-17',
      '2026-11-16',
      '2026-11-13',
      '2026-11-12',
      '2026-11-11',
      '2026-11-10',
      '2026-11-09',
      '2026-11-06',
      '2026-11-05',
      '2026-11-04',
      '2026-11-03',
      '2026-11-02',
      '2026-10-30',
      '2026-10-29',
      '2026-10-28',
    ];
    // The first five are the lead's 1.92, 0.70, 0.91, 2.46 and 2.14 (to two
    // places); of all 20, 11 reach 1.0x, 9 reach 1.25x and 4 reach 1.5x.
    const MULTIPLES_20 = [
      1.916, 0.696, 0.906, 2.456, 2.136, 1.6, 1.3, 0.5, 1.4, 0.6, 1.35, 1.1,
      0.55, 1.45, 0.8, 1.26, 1.05, 0.9, 0.65, 0.75,
    ];
    // The worked example's own two days: 11-25 is P1 (all of its row), and
    // 11-24 is P2 (its close and VIX only: its range stays the 0.696x of its
    // own prior day, 11-23, that the list above gives it).
    const REAL = {
      '2026-11-25': P1,
      '2026-11-24': { settlement: P2.settlement, vix_close: P2.vix_close },
    };
    const WORKED_LINE =
      'Recent sessions (last 20 full sessions, 2026-10-29 to 2026-11-25): 11 reached 1.0× their implied move (55%), 9 reached 1.25× (45%), 4 reached 1.5× (20%). Average multiple over the last 5: 1.62×.';

    const recentLine = (recent: Map<string, OutcomesDay>, over = {}) =>
      formatPrevSessionForClaude({ ...NORMAL, ...over, recent })
        .split('\n')
        .find((l) => l.startsWith('Recent sessions'));

    it('renders the worked example exactly, between the VIX change and the half-day line', () => {
      const out = formatPrevSessionForClaude({
        ...WORKED,
        recent: history(DATES_21, MULTIPLES_20, REAL),
      });

      expect(out).toBe(
        [
          implied('2026-11-25'),
          range('2026-11-25'),
          vixChange('2026-11-25'),
          WORKED_LINE,
          HALF_DAY_TODAY,
        ].join('\n'),
      );
    });

    it('takes only the 20 most recent sessions when more are stored', () => {
      // Five older sessions at 3.0x would add to every count if they were kept.
      const dates = [
        ...DATES_21,
        '2026-10-27',
        '2026-10-26',
        '2026-10-23',
        '2026-10-22',
        '2026-10-21',
      ];
      const multiples = [...MULTIPLES_20, 3, 3, 3, 3, 3];

      expect(recentLine(history(dates, multiples, REAL))).toBe(WORKED_LINE);
    });

    it('says "last N" and still prints with 10 usable sessions', () => {
      const recent = history(
        DATES_21.slice(0, 11),
        MULTIPLES_20.slice(0, 10),
        REAL,
      );

      expect(recentLine(recent)).toBe(
        'Recent sessions (last 10 full sessions, 2026-11-12 to 2026-11-25): 6 reached 1.0× their implied move (60%), 6 reached 1.25× (60%), 4 reached 1.5× (40%). Average multiple over the last 5: 1.62×.',
      );
    });

    it('says it is unavailable with 9 usable sessions', () => {
      const recent = history(
        DATES_21.slice(0, 10),
        MULTIPLES_20.slice(0, 9),
        REAL,
      );

      expect(recentLine(recent)).toBe(RECENT_UNAVAILABLE);
    });

    it('skips a half day inside the window and reaches one session further back', () => {
      // 2026-11-27 closed at 13:00 ET. It is not a full session, so it is not
      // counted (its 9.0x would show) and the window runs on to 11-02, one
      // session further back than 11-03. The session after it, 11-30, still
      // uses its close and VIX as a prior.
      const dates = [
        '2026-12-01',
        '2026-11-30',
        '2026-11-27',
        ...DATES_21.slice(0, 19),
      ];
      const multiples = dates.map((d) => (d === '2026-11-27' ? 9 : 1.3));

      const line = recentLine(history(dates, multiples));

      expect(line).toBe(
        'Recent sessions (last 20 full sessions, 2026-11-02 to 2026-12-01): 20 reached 1.0× their implied move (100%), 20 reached 1.25× (100%), 0 reached 1.5× (0%). Average multiple over the last 5: 1.30×.',
      );
    });

    it('drops only the pair that a missing row breaks', () => {
      // No row for 11-18: that day is no session, and 11-19 has no prior to
      // measure against. Both leave; the 18 others stay.
      const recent = history(DATES_21, MULTIPLES_20, REAL);
      recent.delete('2026-11-18');

      expect(recentLine(recent)).toBe(
        'Recent sessions (last 18 full sessions, 2026-10-29 to 2026-11-25): 9 reached 1.0× their implied move (50%), 7 reached 1.25× (39%), 2 reached 1.5× (11%). Average multiple over the last 5: 1.45×.',
      );
    });

    it.each([
      ['a NULL close on the prior day', { settlement: null }],
      ['a zero VIX on the prior day', { vix_close: 0 }],
    ])('does not count the session that follows %s', (_label, over) => {
      const recent = history(DATES_21, MULTIPLES_20, REAL);
      // 11-16 is the day before 11-17, so it is 11-17's yardstick: only 11-17
      // is lost. 11-16 still counts as a session of its own.
      recent.set('2026-11-16', { ...recent.get('2026-11-16')!, ...over });

      expect(recentLine(recent)).toContain('last 19 full sessions');
    });

    it('does not count a session whose high is at or below its low', () => {
      const recent = history(DATES_21, MULTIPLES_20, REAL);
      recent.set('2026-11-16', {
        ...recent.get('2026-11-16')!,
        day_high: 6900,
        day_low: 6950,
      });

      expect(recentLine(recent)).toContain('last 19 full sessions');
    });

    it('never prints NaN or Infinity from unusable history', () => {
      const junk: OutcomesDay = {
        settlement: Number.NaN,
        day_high: Number.POSITIVE_INFINITY,
        day_low: Number.NEGATIVE_INFINITY,
        day_range_pts: Number.NaN,
        vix_close: Number.POSITIVE_INFINITY,
      };
      const recent = history(DATES_21, MULTIPLES_20, REAL);
      for (const date of DATES_21.slice(2, 9)) recent.set(date, junk);

      const out = formatPrevSessionForClaude({ ...WORKED, recent });

      expect(out).not.toMatch(/NaN|Infinity/);
      expect(recentLine(recent, WORKED)).toBeDefined();
    });
  });

  describe('half days', () => {
    it('says so on the range line when P1 was a half day', () => {
      // 2026-11-27 is the day after Thanksgiving: closed at 13:00 ET = 12:00 CT.
      const out = formatPrevSessionForClaude({
        ...NORMAL,
        analysisDate: '2026-11-30',
        p1Date: '2026-11-27',
        p2Date: '2026-11-25',
      });

      expect(out.split('\n')[1]).toBe(
        "Previous day range (2026-11-27, a half day with a 12:00 CT close): 229 pts (high 7199.31, low 6970.11) = 1.92× that day's implied move (119.6 pts).",
      );
      // D itself is an ordinary Monday.
      expect(out).not.toContain('Today is a half day');
    });

    it('takes the close hour of today from the calendar, converted ET to CT', () => {
      // 13 ET reads 12:00 CT; a calendar that said 12 ET must read 11:00 CT.
      vi.mocked(getEarlyCloseHourET).mockReturnValueOnce(12);

      const out = formatPrevSessionForClaude(WORKED);

      expect(getEarlyCloseHourET).toHaveBeenCalledWith('2026-11-27');
      expect(out.split('\n').at(-1)).toBe(
        "Today is a half day (close 11:00 CT); the prompt's base rates come from full sessions and overstate today's range.",
      );
    });
  });
});
