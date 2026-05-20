// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
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
      mode: 'intraday',
      queryEmbedding: [],
    });
    expect(result).toEqual([]);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns empty array on DB error (best-effort)', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB down'));
    const result = await fetchSimilarPastReads({
      mode: 'intraday',
      queryEmbedding: [0.1, 0.2, 0.3],
    });
    expect(result).toEqual([]);
  });

  it('parses rows with similarity scores', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: '5',
        mode: 'intraday',
        regime_tag: 'pin',
        trading_date: '2026-04-30',
        prose_text: 'Past pin day.',
        similarity: '0.85',
        realized_r: null,
        realized_trigger_fired: null,
      },
    ]);
    const result = await fetchSimilarPastReads({
      mode: 'intraday',
      queryEmbedding: [0.1, 0.2, 0.3],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(5);
    expect(result[0]!.similarity).toBeCloseTo(0.85);
    expect(result[0]!.realized_r).toBeNull();
    expect(result[0]!.realized_trigger_fired).toBeNull();
  });

  it('coerces numeric realized_r and realized_trigger_fired enum', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: '7',
        mode: 'pre_trade',
        regime_tag: 'cone-breach',
        trading_date: '2026-05-01',
        prose_text: 'Open trended up.',
        similarity: '0.6',
        realized_r: '0.62',
        realized_trigger_fired: 'long',
      },
      {
        id: '8',
        mode: 'pre_trade',
        regime_tag: null,
        trading_date: '2026-05-02',
        prose_text: 'No setup fired.',
        similarity: '0.4',
        realized_r: null,
        realized_trigger_fired: 'neither',
      },
    ]);
    const result = await fetchSimilarPastReads({
      mode: 'pre_trade',
      queryEmbedding: [0.1, 0.2, 0.3],
    });
    expect(result).toHaveLength(2);
    expect(result[0]!.realized_r).toBeCloseTo(0.62);
    expect(result[0]!.realized_trigger_fired).toBe('long');
    expect(result[1]!.realized_r).toBeNull();
    expect(result[1]!.realized_trigger_fired).toBe('neither');
  });
});

describe('formatRetrievalBlock', () => {
  it('returns null on empty input', () => {
    expect(formatRetrievalBlock([], 'intraday')).toBeNull();
  });

  it('filters out rows below the similarity floor', () => {
    const result = formatRetrievalBlock(
      [
        {
          id: 1,
          mode: 'intraday',
          regime_tag: null,
          trading_date: '2026-04-30',
          prose_text: 'p',
          similarity: 0.1,
          realized_r: null,
          realized_trigger_fired: null,
        },
      ],
      'intraday',
    );
    expect(result).toBeNull();
  });

  it('formats above-floor examples with similarity %', () => {
    const result = formatRetrievalBlock(
      [
        {
          id: 1,
          mode: 'intraday',
          regime_tag: 'pin',
          trading_date: '2026-04-30',
          prose_text: 'Pin day at 7120.',
          similarity: 0.78,
          realized_r: null,
          realized_trigger_fired: null,
        },
      ],
      'intraday',
    );
    expect(result).not.toBeNull();
    expect(result).toContain('similarity: 78%');
    expect(result).toContain('Analogous past intradays');
    expect(result).toContain('regime: pin');
  });

  it('truncates long prose with marker', () => {
    const result = formatRetrievalBlock(
      [
        {
          id: 1,
          mode: 'intraday',
          regime_tag: null,
          trading_date: '2026-04-30',
          prose_text: 'x'.repeat(3000),
          similarity: 0.5,
          realized_r: null,
          realized_trigger_fired: null,
        },
      ],
      'intraday',
    );
    expect(result).toContain('truncated for brevity');
  });

  it('renders realized: pending when realized_r is null', () => {
    const result = formatRetrievalBlock(
      [
        {
          id: 1,
          mode: 'intraday',
          regime_tag: null,
          trading_date: '2026-04-30',
          prose_text: 'Pending row.',
          similarity: 0.78,
          realized_r: null,
          realized_trigger_fired: null,
        },
      ],
      'intraday',
    );
    expect(result).toContain('realized: pending');
  });

  it('renders realized: no_trigger when neither side fired', () => {
    const result = formatRetrievalBlock(
      [
        {
          id: 1,
          mode: 'intraday',
          regime_tag: null,
          trading_date: '2026-04-30',
          prose_text: 'No fire.',
          similarity: 0.78,
          realized_r: null,
          realized_trigger_fired: 'neither',
        },
      ],
      'intraday',
    );
    expect(result).toContain('realized: no_trigger');
  });

  it('renders signed +R / loser tag when realized_r is populated', () => {
    const result = formatRetrievalBlock(
      [
        {
          id: 1,
          mode: 'intraday',
          regime_tag: null,
          trading_date: '2026-04-30',
          prose_text: 'Long winner.',
          similarity: 0.78,
          realized_r: 0.6,
          realized_trigger_fired: 'long',
        },
        {
          id: 2,
          mode: 'intraday',
          regime_tag: null,
          trading_date: '2026-05-01',
          prose_text: 'Short loser.',
          similarity: 0.55,
          realized_r: -1.2,
          realized_trigger_fired: 'short',
        },
      ],
      'intraday',
    );
    expect(result).toContain('realized: +0.6R, long_winner');
    expect(result).toContain('realized: -1.2R, short_loser');
  });
});

describe('buildRetrievalBlock', () => {
  it('returns null when context is null', async () => {
    const result = await buildRetrievalBlock({
      mode: 'intraday',
      queryText: null,
    });
    expect(result).toBeNull();
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
  });

  it('returns null when context is empty / whitespace', async () => {
    const result = await buildRetrievalBlock({
      mode: 'intraday',
      queryText: '   ',
    });
    expect(result).toBeNull();
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
  });

  it('returns null when embedding generation fails', async () => {
    mockGenerateEmbedding.mockResolvedValueOnce(null);
    const result = await buildRetrievalBlock({
      mode: 'intraday',
      queryText: 'morning open',
    });
    expect(result).toBeNull();
  });

  it('returns null when no above-floor matches found', async () => {
    mockGenerateEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);
    mockSql.mockResolvedValueOnce([
      {
        id: '5',
        mode: 'intraday',
        regime_tag: 'pin',
        trading_date: '2026-04-30',
        prose_text: 'p',
        similarity: '0.05', // below floor
        realized_r: null,
        realized_trigger_fired: null,
      },
    ]);
    const result = await buildRetrievalBlock({
      mode: 'intraday',
      queryText: 'morning open',
    });
    expect(result).toBeNull();
  });

  it('returns formatted block when above-floor matches exist', async () => {
    mockGenerateEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);
    mockSql.mockResolvedValueOnce([
      {
        id: '5',
        mode: 'intraday',
        regime_tag: 'pin',
        trading_date: '2026-04-30',
        prose_text: 'Past pin day at 7120.',
        similarity: '0.78',
        realized_r: '0.4',
        realized_trigger_fired: 'long',
      },
    ]);
    const result = await buildRetrievalBlock({
      mode: 'intraday',
      queryText: 'morning open, gap-down day',
    });
    expect(result).not.toBeNull();
    expect(result).toContain('Past pin day at 7120.');
    expect(result).toContain('similarity: 78%');
    expect(result).toContain('realized: +0.4R, long_winner');
  });
});
