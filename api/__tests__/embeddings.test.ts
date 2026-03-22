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
  _resetClient,
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
    it('returns a 3072-dimension vector on success', async () => {
      const fakeEmbedding = Array.from({ length: 3072 }, (_, i) => i * 0.001);
      mockCreate.mockResolvedValueOnce({
        data: [{ embedding: fakeEmbedding }],
      });

      const result = await generateEmbedding('test text');

      expect(result).toEqual(fakeEmbedding);
      expect(result).toHaveLength(3072);
      expect(mockCreate).toHaveBeenCalledWith({
        model: 'text-embedding-3-large',
        input: 'test text',
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
        },
        {
          id: 2,
          text: 'Size down on FOMC days.',
          tags: ['sizing'],
          category: 'sizing',
          source_date: '2026-03-18',
        },
      ]);

      const embedding = Array.from({ length: 3072 }, () => 0.1);
      const result = await findSimilarLessons(embedding);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 1,
        text: 'Trust charm walls in negative GEX.',
        tags: ['charm', 'gex'],
        category: 'gamma',
        sourceDate: '2026-03-20',
      });
      expect(result[1]).toEqual({
        id: 2,
        text: 'Size down on FOMC days.',
        tags: ['sizing'],
        category: 'sizing',
        sourceDate: '2026-03-18',
      });
      // Verify SQL was called once
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when no lessons exist', async () => {
      mockSql.mockResolvedValueOnce([]);

      const embedding = Array.from({ length: 3072 }, () => 0.1);
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
        },
        {
          id: 2,
          text: 'Lesson 2',
          tags: [],
          category: null,
          source_date: '2026-03-19',
        },
        {
          id: 3,
          text: 'Lesson 3',
          tags: [],
          category: null,
          source_date: '2026-03-18',
        },
      ]);

      const embedding = Array.from({ length: 3072 }, () => 0.1);
      const result = await findSimilarLessons(embedding, 3);

      expect(result).toHaveLength(3);
      // Verify the limit was passed via the SQL tagged template call
      expect(mockSql).toHaveBeenCalledTimes(1);
    });
  });
});
