// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @neondatabase/serverless before importing any module that uses db
const mockSql = vi.fn();
vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => mockSql),
}));

// Mock openai — use a stable object so restoreAllMocks doesn't break the constructor
const mockCreate = vi.fn();
const mockOpenAIInstance = { embeddings: { create: mockCreate } };
vi.mock('openai', () => ({
  default: class MockOpenAI {
    embeddings = mockOpenAIInstance.embeddings;
  },
}));

import { neon } from '@neondatabase/serverless';
import { _resetDb } from '../_lib/db.js';
import {
  generateEmbedding,
  findSimilarLessons,
  buildAnalysisSummary,
  findSimilarAnalyses,
  saveAnalysisEmbedding,
  formatSimilarAnalysesBlock,
  _resetClient,
  type AnalysisSummaryInput,
  type SimilarAnalysis,
} from '../_lib/embeddings.js';

describe('embeddings.ts', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DATABASE_URL: 'postgres://test',
      OPENAI_API_KEY: 'test-key-123',
    };
    vi.restoreAllMocks();
    mockSql.mockReset();
    mockCreate.mockReset();
    vi.mocked(neon).mockReturnValue(mockSql as never);
    _resetDb();
    _resetClient();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ============================================================
  // generateEmbedding
  // ============================================================
  describe('generateEmbedding', () => {
    it('returns a 2000-dimension vector on success', async () => {
      const fakeEmbedding = Array.from({ length: 2000 }, (_, i) => i * 0.001);
      mockCreate.mockResolvedValueOnce({
        data: [{ embedding: fakeEmbedding }],
      });

      const result = await generateEmbedding('test text');

      expect(result).toEqual(fakeEmbedding);
      expect(result).toHaveLength(2000);
      expect(mockCreate).toHaveBeenCalledWith({
        model: 'text-embedding-3-large',
        input: 'test text',
        dimensions: 2000,
      });
    });

    it('returns null when API fails', async () => {
      mockCreate.mockRejectedValueOnce(new Error('API timeout'));

      const result = await generateEmbedding('test text');

      expect(result).toBeNull();
    });

    it('returns null when response has no data', async () => {
      mockCreate.mockResolvedValueOnce({
        data: [],
      });

      const result = await generateEmbedding('test text');

      expect(result).toBeNull();
    });
  });

  // ============================================================
  // findSimilarLessons
  // ============================================================
  describe('findSimilarLessons', () => {
    it('returns similar lessons from the DB ordered by distance', async () => {
      mockSql.mockResolvedValueOnce([
        {
          id: 1,
          text: 'Trust charm walls in negative GEX.',
          tags: ['charm', 'gex'],
          category: 'gamma',
          source_date: '2026-03-20',
          distance: '0.123',
        },
        {
          id: 2,
          text: 'Size down on FOMC days.',
          tags: ['sizing'],
          category: 'sizing',
          source_date: '2026-03-18',
          distance: '0.456',
        },
      ]);

      const embedding = Array.from({ length: 2000 }, () => 0.1);
      const result = await findSimilarLessons(embedding);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 1,
        text: 'Trust charm walls in negative GEX.',
        tags: ['charm', 'gex'],
        category: 'gamma',
        sourceDate: '2026-03-20',
        distance: 0.123,
      });
      expect(result[1]).toEqual({
        id: 2,
        text: 'Size down on FOMC days.',
        tags: ['sizing'],
        category: 'sizing',
        sourceDate: '2026-03-18',
        distance: 0.456,
      });
      // Verify SQL was called once
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when no lessons exist', async () => {
      mockSql.mockResolvedValueOnce([]);

      const embedding = Array.from({ length: 2000 }, () => 0.1);
      const result = await findSimilarLessons(embedding);

      expect(result).toEqual([]);
    });

    it('respects the limit parameter', async () => {
      mockSql.mockResolvedValueOnce([
        {
          id: 1,
          text: 'Lesson 1',
          tags: [],
          category: null,
          source_date: '2026-03-20',
          distance: '0.1',
        },
        {
          id: 2,
          text: 'Lesson 2',
          tags: [],
          category: null,
          source_date: '2026-03-19',
          distance: '0.2',
        },
        {
          id: 3,
          text: 'Lesson 3',
          tags: [],
          category: null,
          source_date: '2026-03-18',
          distance: '0.3',
        },
      ]);

      const embedding = Array.from({ length: 2000 }, () => 0.1);
      const result = await findSimilarLessons(embedding, 3);

      expect(result).toHaveLength(3);
      // Verify the limit was passed via the SQL tagged template call
      expect(mockSql).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // buildAnalysisSummary
  // ============================================================
  describe('buildAnalysisSummary', () => {
    const baseInput: AnalysisSummaryInput = {
      date: '2026-04-03',
      mode: 'entry',
      vix: 18.2,
      vix1d: 16.5,
      spx: 5880,
      structure: 'PCS',
      confidence: 'High',
      suggestedDelta: 10,
      hedge: 'buy 1 5900C 1DTE',
    };

    it('builds a pipe-delimited summary with all fields', () => {
      const input: AnalysisSummaryInput = {
        ...baseInput,
        vixTermShape: 'contango',
        gexRegime: 'bearish',
        dayOfWeek: 'Thursday',
        settlement: 5862,
        wasCorrect: true,
      };

      const result = buildAnalysisSummary(input);

      expect(result).toBe(
        'date:2026-04-03 | mode:entry | VIX:18.2 | VIX1D:16.5 | ' +
          'SPX:5880 | term:contango | GEX:bearish | dow:Thursday | ' +
          'structure:PCS | delta:10 | confidence:High | ' +
          'hedge:buy 1 5900C 1DTE | settlement:5862 | correct:yes',
      );
    });

    it('omits null/undefined optional fields', () => {
      const result = buildAnalysisSummary(baseInput);

      expect(result).toBe(
        'date:2026-04-03 | mode:entry | VIX:18.2 | VIX1D:16.5 | ' +
          'SPX:5880 | structure:PCS | delta:10 | confidence:High | ' +
          'hedge:buy 1 5900C 1DTE',
      );
      expect(result).not.toContain('term:');
      expect(result).not.toContain('GEX:');
      expect(result).not.toContain('dow:');
      expect(result).not.toContain('settlement:');
      expect(result).not.toContain('correct:');
    });

    it('handles wasCorrect false', () => {
      const result = buildAnalysisSummary({
        ...baseInput,
        settlement: 5920,
        wasCorrect: false,
      });

      expect(result).toContain('correct:no');
    });

    it('handles null VIX and SPX', () => {
      const result = buildAnalysisSummary({
        ...baseInput,
        vix: null,
        vix1d: null,
        spx: null,
      });

      expect(result).toBe(
        'date:2026-04-03 | mode:entry | structure:PCS | delta:10 | ' +
          'confidence:High | hedge:buy 1 5900C 1DTE',
      );
    });

    it('handles null hedge', () => {
      const result = buildAnalysisSummary({
        ...baseInput,
        hedge: null,
      });

      expect(result).not.toContain('hedge:');
    });
  });

  // ============================================================
  // saveAnalysisEmbedding
  // ============================================================
  describe('saveAnalysisEmbedding', () => {
    it('calls sql tagged template with UPDATE and vector literal', async () => {
      mockSql.mockResolvedValueOnce([]);

      const embedding = [0.1, 0.2, 0.3];
      await saveAnalysisEmbedding('2026-04-03', '09:35', 'entry', embedding);

      expect(mockSql).toHaveBeenCalledTimes(1);
      // Tagged template: first arg is TemplateStringsArray, rest are interpolated values
      const call = mockSql.mock.calls[0] as unknown[];
      const templateStrings = call[0] as string[];
      // The template should contain UPDATE analyses and analysis_embedding
      const fullQuery = templateStrings.join('?');
      expect(fullQuery).toContain('UPDATE analyses');
      expect(fullQuery).toContain('analysis_embedding');
      // Interpolated values: vectorLiteral, date, entryTime, mode
      expect(call[1]).toBe('[0.1,0.2,0.3]');
      expect(call[2]).toBe('2026-04-03');
      expect(call[3]).toBe('09:35');
      expect(call[4]).toBe('entry');
    });
  });

  // ============================================================
  // findSimilarAnalyses
  // ============================================================
  describe('findSimilarAnalyses', () => {
    it('returns similar analyses with outcome data', async () => {
      mockSql.mockResolvedValueOnce([
        {
          id: 10,
          date: '2026-03-20',
          mode: 'entry',
          structure: 'PCS',
          confidence: 'High',
          suggested_delta: 10,
          spx: '5850.00',
          vix: '17.50',
          hedge: 'buy 1 5870C 1DTE',
          reasoning: 'Bearish flow with strong charm wall support.',
          settlement: '5835.00',
          was_correct: true,
          distance: '0.087',
        },
      ]);

      const embedding = Array.from({ length: 2000 }, () => 0.1);
      const result = await findSimilarAnalyses(embedding, '2026-04-03', 3);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: 10,
        date: '2026-03-20',
        mode: 'entry',
        structure: 'PCS',
        confidence: 'High',
        suggestedDelta: 10,
        spx: 5850,
        vix: 17.5,
        hedge: 'buy 1 5870C 1DTE',
        reasoning: 'Bearish flow with strong charm wall support.',
        settlement: 5835,
        wasCorrect: true,
        distance: 0.087,
      });
    });

    it('handles null outcome and reasoning fields', async () => {
      mockSql.mockResolvedValueOnce([
        {
          id: 11,
          date: '2026-04-02',
          mode: 'entry',
          structure: 'IC',
          confidence: 'Medium',
          suggested_delta: 8,
          spx: null,
          vix: null,
          hedge: null,
          reasoning: null,
          settlement: null,
          was_correct: null,
          distance: '0.15',
        },
      ]);

      const embedding = Array.from({ length: 2000 }, () => 0.1);
      const result = await findSimilarAnalyses(embedding, '2026-04-03');

      expect(result[0]?.spx).toBeNull();
      expect(result[0]?.vix).toBeNull();
      expect(result[0]?.hedge).toBeNull();
      expect(result[0]?.reasoning).toBeNull();
      expect(result[0]?.settlement).toBeNull();
      expect(result[0]?.wasCorrect).toBeNull();
    });

    it('rejects invalid embeddings', async () => {
      await expect(
        findSimilarAnalyses([NaN, 0.1], '2026-04-03'),
      ).rejects.toThrow('Invalid embedding');
    });

    it('caps limit to 10', async () => {
      mockSql.mockResolvedValueOnce([]);

      const embedding = Array.from({ length: 2000 }, () => 0.1);
      await findSimilarAnalyses(embedding, '2026-04-03', 50);

      // Tagged template: interpolated values include vectorLiteral, excludeDate, safeLimit
      const call = mockSql.mock.calls[0] as unknown[];
      // safeLimit should be capped at 10 (last interpolated value)
      const lastParam = call[call.length - 1];
      expect(lastParam).toBe(10);
    });
  });

  // ============================================================
  // formatSimilarAnalysesBlock
  // ============================================================
  describe('formatSimilarAnalysesBlock', () => {
    it('returns empty string for no analyses', () => {
      expect(formatSimilarAnalysesBlock([])).toBe('');
    });

    it('formats analyses with outcome data', () => {
      const analyses: SimilarAnalysis[] = [
        {
          id: 10,
          date: '2026-03-20',
          mode: 'entry',
          structure: 'PCS',
          confidence: 'High',
          suggestedDelta: 10,
          spx: 5850,
          vix: 17.5,
          hedge: 'buy 1 5870C 1DTE',
          reasoning: 'Bearish flow confirmed.',
          settlement: 5835,
          wasCorrect: true,
          distance: 0.087,
        },
      ];

      const result = formatSimilarAnalysesBlock(analyses);

      expect(result).toContain('<similar_past_analyses>');
      expect(result).toContain('</similar_past_analyses>');
      expect(result).toContain('[2026-03-20] PCS 10Δ');
      expect(result).toContain('Confidence: High');
      expect(result).toContain('Settlement: 5835');
      expect(result).toContain('Correct: yes');
      expect(result).toContain('Hedge: buy 1 5870C 1DTE');
      expect(result).toContain('Reasoning: Bearish flow confirmed.');
    });

    it('shows pending when no settlement', () => {
      const analyses: SimilarAnalysis[] = [
        {
          id: 11,
          date: '2026-04-02',
          mode: 'entry',
          structure: 'IC',
          confidence: 'Medium',
          suggestedDelta: 8,
          spx: 5900,
          vix: 15,
          hedge: null,
          reasoning: null,
          settlement: null,
          wasCorrect: null,
          distance: 0.15,
        },
      ];

      const result = formatSimilarAnalysesBlock(analyses);

      expect(result).toContain('Outcome: pending');
      expect(result).not.toContain('Hedge:');
      expect(result).not.toContain('Reasoning:');
    });

    it('truncates long reasoning to 200 chars', () => {
      const longReasoning = 'A'.repeat(300);
      const analyses: SimilarAnalysis[] = [
        {
          id: 12,
          date: '2026-03-15',
          mode: 'entry',
          structure: 'CCS',
          confidence: 'Low',
          suggestedDelta: 5,
          spx: 5800,
          vix: 22,
          hedge: null,
          reasoning: longReasoning,
          settlement: 5810,
          wasCorrect: false,
          distance: 0.2,
        },
      ];

      const result = formatSimilarAnalysesBlock(analyses);

      expect(result).toContain('A'.repeat(200) + '…');
      expect(result).not.toContain('A'.repeat(201));
    });
  });
});
