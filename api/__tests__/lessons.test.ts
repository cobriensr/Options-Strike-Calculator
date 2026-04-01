// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @neondatabase/serverless before importing lessons module
const mockSql = vi.fn() as ReturnType<typeof vi.fn> & {
  transaction: ReturnType<typeof vi.fn>;
  unsafe: ReturnType<typeof vi.fn>;
};
mockSql.transaction = vi.fn();
mockSql.unsafe = vi.fn();

vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => mockSql),
}));

import { neon } from '@neondatabase/serverless';
import { _resetDb } from '../_lib/db.js';
import {
  getActiveLessons,
  formatLessonsBlock,
  buildMarketConditions,
  upsertReport,
  updateReport,
  getHistoricalWinRate,
  formatWinRateForClaude,
} from '../_lib/lessons.js';
import type { Lesson, WinRateResult } from '../_lib/lessons.js';

describe('lessons.ts', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, DATABASE_URL: 'postgres://test' };
    vi.restoreAllMocks();
    mockSql.mockReset();
    mockSql.transaction.mockReset();
    mockSql.unsafe.mockReset();
    vi.mocked(neon).mockReturnValue(mockSql as never);
    _resetDb();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ============================================================
  // getActiveLessons
  // ============================================================
  describe('getActiveLessons', () => {
    it('returns formatted lessons ordered by source_date DESC', async () => {
      mockSql.mockResolvedValueOnce([
        {
          id: 1,
          text: 'Trust charm walls in negative GEX.',
          source_date: '2026-03-20',
          market_conditions: { vix: 26.2, gexRegime: 'danger' },
          tags: ['charm', 'gex'],
          category: 'gamma',
        },
        {
          id: 2,
          text: 'Size down on FOMC days.',
          source_date: '2026-03-18',
          market_conditions: null,
          tags: ['sizing'],
          category: 'sizing',
        },
      ]);

      const lessons = await getActiveLessons();

      expect(lessons).toHaveLength(2);
      expect(lessons[0]).toEqual({
        id: 1,
        text: 'Trust charm walls in negative GEX.',
        sourceDate: '2026-03-20',
        marketConditions: { vix: 26.2, gexRegime: 'danger' },
        tags: ['charm', 'gex'],
        category: 'gamma',
      });
      expect(lessons[1]).toEqual({
        id: 2,
        text: 'Size down on FOMC days.',
        sourceDate: '2026-03-18',
        marketConditions: null,
        tags: ['sizing'],
        category: 'sizing',
      });
    });

    it('returns empty array when no active lessons exist', async () => {
      mockSql.mockResolvedValueOnce([]);

      const lessons = await getActiveLessons();

      expect(lessons).toEqual([]);
    });

    it('handles null tags and category gracefully', async () => {
      mockSql.mockResolvedValueOnce([
        {
          id: 3,
          text: 'Some lesson.',
          source_date: '2026-03-15',
          market_conditions: null,
          tags: null,
          category: null,
        },
      ]);

      const lessons = await getActiveLessons();

      expect(lessons[0]!.tags).toEqual([]);
      expect(lessons[0]!.category).toBeNull();
      expect(lessons[0]!.marketConditions).toBeNull();
    });
  });

  // ============================================================
  // formatLessonsBlock
  // ============================================================
  describe('formatLessonsBlock', () => {
    it('returns empty string for no lessons', () => {
      const result = formatLessonsBlock([]);
      expect(result).toBe('');
    });

    it('formats a single lesson with full market conditions', () => {
      const lessons: Lesson[] = [
        {
          id: 1,
          text: 'When charm exceeds +10M on a positive gamma wall, trust it.',
          sourceDate: '2026-03-20',
          marketConditions: {
            structure: 'CCS',
            vix: 26.2,
            gexRegime: 'danger',
            dayOfWeek: 'Fri',
            wasCorrect: true,
          },
          tags: ['charm', 'gex', 'management'],
          category: 'gamma',
        },
      ];

      const result = formatLessonsBlock(lessons);

      expect(result).toContain('<lessons_learned>');
      expect(result).toContain('</lessons_learned>');
      expect(result).toContain(
        '[1] (2026-03-20 | CCS | VIX:26.2 | GEX:danger | Fri | correct:yes)',
      );
      expect(result).toContain(
        'When charm exceeds +10M on a positive gamma wall, trust it.',
      );
      expect(result).toContain('Tags: charm, gex, management');
    });

    it('formats multiple lessons with numbered prefixes', () => {
      const lessons: Lesson[] = [
        {
          id: 1,
          text: 'Lesson one.',
          sourceDate: '2026-03-20',
          marketConditions: { vix: 20 },
          tags: ['a'],
          category: null,
        },
        {
          id: 2,
          text: 'Lesson two.',
          sourceDate: '2026-03-19',
          marketConditions: null,
          tags: [],
          category: null,
        },
      ];

      const result = formatLessonsBlock(lessons);

      expect(result).toContain('[1]');
      expect(result).toContain('[2]');
      expect(result).toContain('Lesson one.');
      expect(result).toContain('Lesson two.');
    });

    it('omits missing market condition fields instead of showing undefined', () => {
      const lessons: Lesson[] = [
        {
          id: 1,
          text: 'Partial conditions.',
          sourceDate: '2026-03-20',
          marketConditions: { vix: 18 },
          tags: [],
          category: null,
        },
      ];

      const result = formatLessonsBlock(lessons);

      expect(result).toContain('(2026-03-20 | VIX:18)');
      expect(result).not.toContain('undefined');
      expect(result).not.toContain('GEX:');
      expect(result).not.toContain('correct:');
    });

    it('shows only date when marketConditions is null', () => {
      const lessons: Lesson[] = [
        {
          id: 1,
          text: 'No conditions.',
          sourceDate: '2026-03-20',
          marketConditions: null,
          tags: [],
          category: null,
        },
      ];

      const result = formatLessonsBlock(lessons);

      expect(result).toContain('(2026-03-20)');
    });

    it('handles wasCorrect: false', () => {
      const lessons: Lesson[] = [
        {
          id: 1,
          text: 'Incorrect prediction.',
          sourceDate: '2026-03-20',
          marketConditions: { wasCorrect: false },
          tags: [],
          category: null,
        },
      ];

      const result = formatLessonsBlock(lessons);

      expect(result).toContain('correct:no');
    });

    it('omits Tags line when tags are empty', () => {
      const lessons: Lesson[] = [
        {
          id: 1,
          text: 'No tags.',
          sourceDate: '2026-03-20',
          marketConditions: null,
          tags: [],
          category: null,
        },
      ];

      const result = formatLessonsBlock(lessons);

      expect(result).not.toContain('Tags:');
    });

    it('includes the prompt instruction text', () => {
      const lessons: Lesson[] = [
        {
          id: 1,
          text: 'Test.',
          sourceDate: '2026-03-20',
          marketConditions: null,
          tags: [],
          category: null,
        },
      ];

      const result = formatLessonsBlock(lessons);

      expect(result).toContain('Validated lessons from past trading sessions');
      expect(result).toContain('Do not force-apply lessons');
    });
  });

  // ============================================================
  // buildMarketConditions
  // ============================================================
  describe('buildMarketConditions', () => {
    it('extracts all fields from analysis and snapshot rows', () => {
      const analysisRow = {
        spx: 5700,
        structure: 'IRON CONDOR',
        confidence: 'HIGH',
        full_response: JSON.stringify({
          review: { wasCorrect: true },
        }),
      };
      const snapshotRow = {
        vix: 26.2,
        vix1d: 22.1,
        regime_zone: 'danger',
        dow_label: 'Fri',
        vix_term_signal: 'contango',
      };

      const mc = buildMarketConditions(analysisRow, snapshotRow);

      expect(mc).toEqual({
        vix: 26.2,
        vix1d: 22.1,
        spx: 5700,
        gexRegime: 'danger',
        structure: 'IRON CONDOR',
        dayOfWeek: 'Fri',
        wasCorrect: true,
        confidence: 'HIGH',
        vixTermShape: 'contango',
      });
    });

    it('handles null snapshot gracefully', () => {
      const analysisRow = {
        spx: 5700,
        structure: 'PCS',
        confidence: 'MODERATE',
        full_response: JSON.stringify({ review: { wasCorrect: false } }),
      };

      const mc = buildMarketConditions(analysisRow, null);

      expect(mc.vix).toBeNull();
      expect(mc.vix1d).toBeNull();
      expect(mc.gexRegime).toBeNull();
      expect(mc.dayOfWeek).toBeNull();
      expect(mc.vixTermShape).toBeNull();
      expect(mc.spx).toBe(5700);
      expect(mc.structure).toBe('PCS');
      expect(mc.wasCorrect).toBe(false);
    });

    it('handles full_response already parsed as object', () => {
      const analysisRow = {
        spx: 5700,
        structure: 'IC',
        confidence: 'HIGH',
        full_response: { review: { wasCorrect: true } },
      };

      const mc = buildMarketConditions(analysisRow, null);

      expect(mc.wasCorrect).toBe(true);
    });

    it('handles missing review in full_response', () => {
      const analysisRow = {
        spx: 5700,
        structure: 'IC',
        confidence: 'HIGH',
        full_response: JSON.stringify({}),
      };

      const mc = buildMarketConditions(analysisRow, null);

      expect(mc.wasCorrect).toBeNull();
    });

    it('handles null full_response', () => {
      const analysisRow = {
        spx: null,
        structure: null,
        confidence: null,
        full_response: null,
      };

      const mc = buildMarketConditions(analysisRow, null);

      expect(mc.spx).toBeNull();
      expect(mc.structure).toBeNull();
      expect(mc.confidence).toBeNull();
      expect(mc.wasCorrect).toBeNull();
    });

    it('converts string numeric values to numbers', () => {
      const analysisRow = {
        spx: '5700.50',
        structure: 'PCS',
        confidence: 'HIGH',
        full_response: '{}',
      };
      const snapshotRow = {
        vix: '26.20',
        vix1d: '22.10',
        regime_zone: 'go',
        dow_label: 'Mon',
        vix_term_signal: 'backwardation',
      };

      const mc = buildMarketConditions(analysisRow, snapshotRow);

      expect(mc.vix).toBe(26.2);
      expect(mc.vix1d).toBe(22.1);
      expect(mc.spx).toBe(5700.5);
    });
  });

  // ============================================================
  // upsertReport
  // ============================================================
  describe('upsertReport', () => {
    it('inserts a new report row', async () => {
      mockSql.mockResolvedValueOnce([]);

      await upsertReport('2026-03-22');

      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('does not throw on conflict (upsert)', async () => {
      mockSql.mockResolvedValueOnce([]);

      await expect(upsertReport('2026-03-22')).resolves.toBeUndefined();
    });
  });

  // ============================================================
  // updateReport
  // ============================================================
  describe('updateReport', () => {
    it('updates report with all fields', async () => {
      mockSql.mockResolvedValueOnce([]);

      await updateReport('2026-03-22', {
        reviewsProcessed: 5,
        lessonsAdded: 3,
        lessonsSuperseded: 1,
        lessonsSkipped: 1,
        report: { changelog: ['added X', 'superseded Y'] },
        error: null,
      });

      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('updates report with error field', async () => {
      mockSql.mockResolvedValueOnce([]);

      await updateReport('2026-03-22', {
        reviewsProcessed: 0,
        lessonsAdded: 0,
        lessonsSuperseded: 0,
        lessonsSkipped: 0,
        report: {},
        error: 'OpenAI rate limit exceeded',
      });

      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('defaults error to null when not provided', async () => {
      mockSql.mockResolvedValueOnce([]);

      await updateReport('2026-03-22', {
        reviewsProcessed: 2,
        lessonsAdded: 2,
        lessonsSuperseded: 0,
        lessonsSkipped: 0,
        report: { items: [] },
      });

      expect(mockSql).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // getHistoricalWinRate
  // ============================================================
  describe('getHistoricalWinRate', () => {
    function makeWinRateRow(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        total: 10,
        wins: 7,
        avg_vix: 18.5,
        structures: ['IRON CONDOR', 'PUT CREDIT SPREAD'],
        ...overrides,
      };
    }

    it('returns null when fewer than 5 matching sessions', async () => {
      mockSql.unsafe.mockResolvedValueOnce([
        makeWinRateRow({ total: 3, wins: 2 }),
      ]);
      const result = await getHistoricalWinRate({ vix: 18 });
      expect(result).toBeNull();
    });

    it('returns null when query returns no rows', async () => {
      mockSql.unsafe.mockResolvedValueOnce([]);
      const result = await getHistoricalWinRate({ vix: 18 });
      expect(result).toBeNull();
    });

    it('returns win rate result when sample is sufficient', async () => {
      mockSql.unsafe.mockResolvedValueOnce([makeWinRateRow()]);
      const result = await getHistoricalWinRate({ vix: 18 });

      expect(result).not.toBeNull();
      expect(result!.total).toBe(10);
      expect(result!.wins).toBe(7);
      expect(result!.winRate).toBe(70);
      expect(result!.avgVix).toBe(18.5);
      expect(result!.structures).toEqual(['IRON CONDOR', 'PUT CREDIT SPREAD']);
    });

    it('rounds win rate to nearest integer', async () => {
      mockSql.unsafe.mockResolvedValueOnce([
        makeWinRateRow({ total: 7, wins: 5 }),
      ]);
      const result = await getHistoricalWinRate({});
      // 5/7 = 71.4... → 71
      expect(result!.winRate).toBe(71);
    });

    it('rounds avgVix to one decimal place', async () => {
      mockSql.unsafe.mockResolvedValueOnce([
        makeWinRateRow({ avg_vix: 22.3456 }),
      ]);
      const result = await getHistoricalWinRate({});
      expect(result!.avgVix).toBe(22.3);
    });

    it('returns null avgVix when DB returns null', async () => {
      mockSql.unsafe.mockResolvedValueOnce([makeWinRateRow({ avg_vix: null })]);
      const result = await getHistoricalWinRate({});
      expect(result!.avgVix).toBeNull();
    });

    it('defaults structures to empty array when DB returns null', async () => {
      mockSql.unsafe.mockResolvedValueOnce([
        makeWinRateRow({ structures: null }),
      ]);
      const result = await getHistoricalWinRate({});
      expect(result!.structures).toEqual([]);
    });

    it('builds VIX range filter with ±5', async () => {
      mockSql.unsafe.mockResolvedValueOnce([makeWinRateRow()]);
      await getHistoricalWinRate({ vix: 20 });

      const query = mockSql.unsafe.mock.calls[0]![0] as string;
      // VIX 20 → lo = floor(15) = 15, hi = ceil(25) = 25
      expect(query).toContain('BETWEEN 15 AND 25');
    });

    it('builds VIX range filter with fractional VIX', async () => {
      mockSql.unsafe.mockResolvedValueOnce([makeWinRateRow()]);
      await getHistoricalWinRate({ vix: 18.7 });

      const query = mockSql.unsafe.mock.calls[0]![0] as string;
      // lo = floor(13.7) = 13, hi = ceil(23.7) = 24
      expect(query).toContain('BETWEEN 13 AND 24');
    });

    it('builds gexRegime filter', async () => {
      mockSql.unsafe.mockResolvedValueOnce([makeWinRateRow()]);
      await getHistoricalWinRate({ gexRegime: 'GREEN' });

      const query = mockSql.unsafe.mock.calls[0]![0] as string;
      expect(query).toContain("market_conditions->>'gexRegime' = 'GREEN'");
    });

    it('builds structure filter', async () => {
      mockSql.unsafe.mockResolvedValueOnce([makeWinRateRow()]);
      await getHistoricalWinRate({ structure: 'IRON CONDOR' });

      const query = mockSql.unsafe.mock.calls[0]![0] as string;
      expect(query).toContain(
        "market_conditions->>'structure' = 'IRON CONDOR'",
      );
    });

    it('builds dayOfWeek filter', async () => {
      mockSql.unsafe.mockResolvedValueOnce([makeWinRateRow()]);
      await getHistoricalWinRate({ dayOfWeek: 'Friday' });

      const query = mockSql.unsafe.mock.calls[0]![0] as string;
      expect(query).toContain("market_conditions->>'dayOfWeek' = 'Friday'");
    });

    it('combines all filters when all conditions provided', async () => {
      mockSql.unsafe.mockResolvedValueOnce([makeWinRateRow()]);
      await getHistoricalWinRate({
        vix: 18,
        gexRegime: 'RED',
        structure: 'PUT CREDIT SPREAD',
        dayOfWeek: 'Monday',
      });

      const query = mockSql.unsafe.mock.calls[0]![0] as string;
      expect(query).toContain('BETWEEN');
      expect(query).toContain("'RED'");
      expect(query).toContain("'PUT CREDIT SPREAD'");
      expect(query).toContain("'Monday'");
    });

    it('omits optional filters when conditions are empty', async () => {
      mockSql.unsafe.mockResolvedValueOnce([makeWinRateRow()]);
      await getHistoricalWinRate({});

      const query = mockSql.unsafe.mock.calls[0]![0] as string;
      // Base filters always present
      expect(query).toContain("status = 'active'");
      expect(query).toContain("'wasCorrect' IS NOT NULL");
      // No optional filters
      expect(query).not.toContain('BETWEEN');
      expect(query).not.toContain("gexRegime' =");
      expect(query).not.toContain("structure' =");
      expect(query).not.toContain("dayOfWeek' =");
    });

    it('accepts exactly 5 sessions (minimum boundary)', async () => {
      mockSql.unsafe.mockResolvedValueOnce([
        makeWinRateRow({ total: 5, wins: 3 }),
      ]);
      const result = await getHistoricalWinRate({});
      expect(result).not.toBeNull();
      expect(result!.total).toBe(5);
      expect(result!.winRate).toBe(60);
    });

    it('rejects exactly 4 sessions (below minimum)', async () => {
      mockSql.unsafe.mockResolvedValueOnce([
        makeWinRateRow({ total: 4, wins: 3 }),
      ]);
      const result = await getHistoricalWinRate({});
      expect(result).toBeNull();
    });

    it('handles 100% win rate', async () => {
      mockSql.unsafe.mockResolvedValueOnce([
        makeWinRateRow({ total: 8, wins: 8 }),
      ]);
      const result = await getHistoricalWinRate({});
      expect(result!.winRate).toBe(100);
    });

    it('handles 0% win rate', async () => {
      mockSql.unsafe.mockResolvedValueOnce([
        makeWinRateRow({ total: 6, wins: 0 }),
      ]);
      const result = await getHistoricalWinRate({});
      expect(result!.winRate).toBe(0);
    });
  });

  // ============================================================
  // formatWinRateForClaude
  // ============================================================
  describe('formatWinRateForClaude', () => {
    const baseResult: WinRateResult = {
      total: 10,
      wins: 8,
      winRate: 80,
      avgVix: 18.5,
      structures: ['IRON CONDOR'],
    };

    it('formats high win rate (>=75%) with upgrade signal', () => {
      const output = formatWinRateForClaude(baseResult, { vix: 18 });
      expect(output).toContain('Win rate: 80%');
      expect(output).toContain('8/10');
      expect(output).toContain('Avg VIX: 18.5');
      expect(output).toContain('Supports upgrading confidence by one level.');
    });

    it('formats neutral win rate (>=50%, <75%) with neutral signal', () => {
      const result: WinRateResult = {
        ...baseResult,
        winRate: 60,
        wins: 6,
      };
      const output = formatWinRateForClaude(result, {});
      expect(output).toContain('Win rate: 60%');
      expect(output).toContain('6/10');
      expect(output).toContain('historical rate is neutral');
    });

    it('formats low win rate (<50%) with downgrade signal', () => {
      const result: WinRateResult = {
        ...baseResult,
        winRate: 40,
        wins: 4,
      };
      const output = formatWinRateForClaude(result, {});
      expect(output).toContain('Win rate: 40%');
      expect(output).toContain('Supports downgrading confidence by one level.');
    });

    it('formats exactly 75% as upgrade signal (boundary)', () => {
      const result: WinRateResult = {
        ...baseResult,
        winRate: 75,
        wins: 15,
        total: 20,
      };
      const output = formatWinRateForClaude(result, {});
      expect(output).toContain('Supports upgrading confidence by one level.');
    });

    it('formats exactly 50% as neutral signal (boundary)', () => {
      const result: WinRateResult = {
        ...baseResult,
        winRate: 50,
        wins: 5,
      };
      const output = formatWinRateForClaude(result, {});
      expect(output).toContain('historical rate is neutral');
    });

    it('formats 49% as downgrade signal (boundary)', () => {
      const result: WinRateResult = {
        ...baseResult,
        winRate: 49,
        wins: 49,
        total: 100,
      };
      const output = formatWinRateForClaude(result, {});
      expect(output).toContain('Supports downgrading confidence by one level.');
    });

    it('includes VIX range condition in header', () => {
      const output = formatWinRateForClaude(baseResult, { vix: 20 });
      // lo = floor(15) = 15, hi = ceil(25) = 25
      expect(output).toContain('VIX 15-25');
    });

    it('includes GEX regime condition in header', () => {
      const output = formatWinRateForClaude(baseResult, {
        gexRegime: 'GREEN',
      });
      expect(output).toContain('GEX: GREEN');
    });

    it('includes structure condition in header', () => {
      const output = formatWinRateForClaude(baseResult, {
        structure: 'IRON CONDOR',
      });
      expect(output).toContain('IRON CONDOR');
    });

    it('includes dayOfWeek condition in header', () => {
      const output = formatWinRateForClaude(baseResult, {
        dayOfWeek: 'Friday',
      });
      expect(output).toContain('Friday');
    });

    it('combines all conditions in header', () => {
      const output = formatWinRateForClaude(baseResult, {
        vix: 18,
        gexRegime: 'RED',
        structure: 'PUT CREDIT SPREAD',
        dayOfWeek: 'Monday',
      });
      expect(output).toContain('Historical Base Rate');
      // VIX 18 → lo = floor(13) = 13, hi = ceil(23) = 23
      expect(output).toContain('VIX 13-23');
      expect(output).toContain('GEX: RED');
      expect(output).toContain('PUT CREDIT SPREAD');
      expect(output).toContain('Monday');
    });

    it('shows N/A when avgVix is null', () => {
      const result: WinRateResult = { ...baseResult, avgVix: null };
      const output = formatWinRateForClaude(result, {});
      expect(output).toContain('Avg VIX: N/A');
    });

    it('shows matching sessions count', () => {
      const output = formatWinRateForClaude(baseResult, {});
      expect(output).toContain('Matching sessions: 10');
    });

    it('omits condition parts when no conditions given', () => {
      const output = formatWinRateForClaude(baseResult, {});
      // Header should be "Historical Base Rate ():" with empty parens
      expect(output).toContain('Historical Base Rate (');
    });
  });
});
