// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/embeddings.js', () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  fetchSimilarPastReads,
  formatRetrievalBlock,
  buildRetrievalBlock,
} from '../_lib/periscope-retrieval.js';
import { generateEmbedding } from '../_lib/embeddings.js';

const mockGenerateEmbedding = vi.mocked(generateEmbedding);

beforeEach(() => {
  mockSql.mockReset();
  mockGenerateEmbedding.mockReset();
});

describe('fetchSimilarPastReads', () => {
  it('returns empty when query embedding is empty', async () => {
    const result = await fetchSimilarPastReads({
      mode: 'read',
      queryEmbedding: [],
    });
    expect(result).toEqual([]);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns empty array on DB error (best-effort)', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB down'));
    const result = await fetchSimilarPastReads({
      mode: 'read',
      queryEmbedding: [0.1, 0.2, 0.3],
    });
    expect(result).toEqual([]);
  });

  it('parses rows with similarity scores', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: '5',
        mode: 'read',
        regime_tag: 'pin',
        trading_date: '2026-04-30',
        prose_text: 'Past pin day.',
        similarity: '0.85',
      },
    ]);
    const result = await fetchSimilarPastReads({
      mode: 'read',
      queryEmbedding: [0.1, 0.2, 0.3],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(5);
    expect(result[0]!.similarity).toBeCloseTo(0.85);
  });
});

describe('formatRetrievalBlock', () => {
  it('returns null on empty input', () => {
    expect(formatRetrievalBlock([], 'read')).toBeNull();
  });

  it('filters out rows below the similarity floor', () => {
    const result = formatRetrievalBlock(
      [
        {
          id: 1,
          mode: 'read',
          regime_tag: null,
          trading_date: '2026-04-30',
          prose_text: 'p',
          similarity: 0.1,
        },
      ],
      'read',
    );
    expect(result).toBeNull();
  });

  it('formats above-floor examples with similarity %', () => {
    const result = formatRetrievalBlock(
      [
        {
          id: 1,
          mode: 'read',
          regime_tag: 'pin',
          trading_date: '2026-04-30',
          prose_text: 'Pin day at 7120.',
          similarity: 0.78,
        },
      ],
      'read',
    );
    expect(result).not.toBeNull();
    expect(result).toContain('similarity: 78%');
    expect(result).toContain('Analogous past reads');
    expect(result).toContain('regime: pin');
  });

  it('truncates long prose with marker', () => {
    const result = formatRetrievalBlock(
      [
        {
          id: 1,
          mode: 'read',
          regime_tag: null,
          trading_date: '2026-04-30',
          prose_text: 'x'.repeat(3000),
          similarity: 0.5,
        },
      ],
      'read',
    );
    expect(result).toContain('truncated for brevity');
  });
});

describe('buildRetrievalBlock', () => {
  it('returns null when context is null', async () => {
    const result = await buildRetrievalBlock({
      mode: 'read',
      queryText: null,
    });
    expect(result).toBeNull();
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
  });

  it('returns null when context is empty / whitespace', async () => {
    const result = await buildRetrievalBlock({
      mode: 'read',
      queryText: '   ',
    });
    expect(result).toBeNull();
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
  });

  it('returns null when embedding generation fails', async () => {
    mockGenerateEmbedding.mockResolvedValueOnce(null);
    const result = await buildRetrievalBlock({
      mode: 'read',
      queryText: 'morning open',
    });
    expect(result).toBeNull();
  });

  it('returns null when no above-floor matches found', async () => {
    mockGenerateEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);
    mockSql.mockResolvedValueOnce([
      {
        id: '5',
        mode: 'read',
        regime_tag: 'pin',
        trading_date: '2026-04-30',
        prose_text: 'p',
        similarity: '0.05', // below floor
      },
    ]);
    const result = await buildRetrievalBlock({
      mode: 'read',
      queryText: 'morning open',
    });
    expect(result).toBeNull();
  });

  it('returns formatted block when above-floor matches exist', async () => {
    mockGenerateEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);
    mockSql.mockResolvedValueOnce([
      {
        id: '5',
        mode: 'read',
        regime_tag: 'pin',
        trading_date: '2026-04-30',
        prose_text: 'Past pin day at 7120.',
        similarity: '0.78',
      },
    ]);
    const result = await buildRetrievalBlock({
      mode: 'read',
      queryText: 'morning open, gap-down day',
    });
    expect(result).not.toBeNull();
    expect(result).toContain('Past pin day at 7120.');
    expect(result).toContain('similarity: 78%');
  });
});
