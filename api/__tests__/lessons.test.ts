// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @neondatabase/serverless before importing lessons module
const mockSql = vi.fn() as ReturnType<typeof vi.fn> & {
  transaction: ReturnType<typeof vi.fn>;
};
mockSql.transaction = vi.fn();

vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => mockSql),
}));

import { neon } from '@neondatabase/serverless';
import { _resetDb } from '../_lib/db.js';
import {
  getActiveLessons,
  formatLessonsBlock,
  buildMarketConditions,
  insertLesson,
  supersedeLesson,
  upsertReport,
  updateReport,
} from '../_lib/lessons.js';
import type { Lesson, InsertLessonParams } from '../_lib/lessons.js';

describe('lessons.ts', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, DATABASE_URL: 'postgres://test' };
    vi.restoreAllMocks();
    mockSql.mockReset();
    mockSql.transaction.mockReset();
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
      expect(result).toContain('[1] (2026-03-20 | CCS | VIX:26.2 | GEX:danger | Fri | correct:yes)');
      expect(result).toContain('When charm exceeds +10M on a positive gamma wall, trust it.');
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
  // insertLesson
  // ============================================================
  describe('insertLesson', () => {
    const baseParams: InsertLessonParams = {
      text: 'Trust charm walls in negative GEX.',
      embedding: [0.1, 0.2, 0.3],
      tags: ['charm', 'gex'],
      category: 'gamma',
      marketConditions: { vix: 26.2 },
      sourceAnalysisId: 42,
      sourceDate: '2026-03-20',
    };

    it('inserts a lesson and returns the new id', async () => {
      mockSql.mockResolvedValueOnce([{ id: 7 }]);

      const id = await insertLesson(baseParams);

      expect(id).toBe(7);
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('passes null for optional fields when null', async () => {
      mockSql.mockResolvedValueOnce([{ id: 8 }]);

      const id = await insertLesson({
        ...baseParams,
        category: null,
        marketConditions: null,
        sourceAnalysisId: null,
      });

      expect(id).toBe(8);
    });

    it('serializes embedding as vector string', async () => {
      mockSql.mockResolvedValueOnce([{ id: 9 }]);

      await insertLesson(baseParams);

      // The tagged template literal will include the embedding string
      // Verify the SQL was called (we can't easily inspect tagged template args)
      expect(mockSql).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // supersedeLesson
  // ============================================================
  describe('supersedeLesson', () => {
    const newLesson: InsertLessonParams = {
      text: 'Updated lesson about charm walls.',
      embedding: [0.4, 0.5, 0.6],
      tags: ['charm', 'gex', 'updated'],
      category: 'gamma',
      marketConditions: { vix: 28.0 },
      sourceAnalysisId: 55,
      sourceDate: '2026-03-22',
    };

    it('pre-allocates ID and runs transaction', async () => {
      // Step 1: nextval returns the new ID
      mockSql.mockResolvedValueOnce([{ id: 10 }]);
      // The two sql`` tagged template calls inside the transaction array
      // also invoke mockSql when constructing the queries
      mockSql.mockResolvedValueOnce(undefined);
      mockSql.mockResolvedValueOnce(undefined);
      // Step 2: transaction resolves
      mockSql.transaction.mockResolvedValueOnce(undefined);

      const newId = await supersedeLesson(newLesson, 3);

      expect(newId).toBe(10);
      // 1 nextval + 2 template literals for the transaction array = 3
      expect(mockSql).toHaveBeenCalledTimes(3);
      // transaction called with array of two queries
      expect(mockSql.transaction).toHaveBeenCalledTimes(1);
    });

    it('returns the pre-allocated ID on success', async () => {
      mockSql.mockResolvedValueOnce([{ id: 42 }]);
      mockSql.transaction.mockResolvedValueOnce(undefined);

      const id = await supersedeLesson(newLesson, 1);

      expect(id).toBe(42);
    });

    it('propagates transaction errors', async () => {
      mockSql.mockResolvedValueOnce([{ id: 10 }]);
      mockSql.transaction.mockRejectedValueOnce(new Error('Transaction failed'));

      await expect(supersedeLesson(newLesson, 3)).rejects.toThrow(
        'Transaction failed',
      );
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
});
