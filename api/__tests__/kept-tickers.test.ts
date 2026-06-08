// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// DB mock — same pattern as other api/__tests__ DB-backed module tests.
const mockSql = vi.fn() as ReturnType<typeof vi.fn> & {
  query: ReturnType<typeof vi.fn>;
};
mockSql.query = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

const { mockIncrement } = vi.hoisted(() => ({ mockIncrement: vi.fn() }));

vi.mock('../_lib/sentry.js', () => ({
  metrics: { increment: mockIncrement },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { readKeptTickers, addKeptTickers } from '../_lib/kept-tickers.js';

describe('kept-tickers (DB-backed)', () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.query.mockReset();
    mockIncrement.mockReset();
  });

  // ── readKeptTickers ──────────────────────────────────────────────────

  describe('readKeptTickers', () => {
    it('returns underlying_symbol array from the DB on success', async () => {
      mockSql.mockResolvedValueOnce([
        { underlying_symbol: 'SNDK' },
        { underlying_symbol: 'TSLA' },
      ]);
      const result = await readKeptTickers('2026-06-07');
      expect(result).toEqual(['SNDK', 'TSLA']);
      expect(mockIncrement).not.toHaveBeenCalled();
    });

    it('returns [] when no rows exist for the date', async () => {
      mockSql.mockResolvedValueOnce([]);
      const result = await readKeptTickers('2026-06-07');
      expect(result).toEqual([]);
      expect(mockIncrement).not.toHaveBeenCalled();
    });

    it('returns [] and increments db.error when the DB throws (never re-throws)', async () => {
      mockSql.mockRejectedValueOnce(new Error('connection timeout'));
      const result = await readKeptTickers('2026-06-07');
      expect(result).toEqual([]);
      expect(mockIncrement).toHaveBeenCalledWith('db.error');
    });
  });

  // ── addKeptTickers ───────────────────────────────────────────────────

  describe('addKeptTickers', () => {
    it('is a no-op on empty input — no DB call', async () => {
      await addKeptTickers('2026-06-07', []);
      expect(mockSql.query).not.toHaveBeenCalled();
      expect(mockIncrement).not.toHaveBeenCalled();
    });

    it('issues ONE batched INSERT with the deduped symbols', async () => {
      mockSql.query.mockResolvedValueOnce([]);
      await addKeptTickers('2026-06-07', ['SNDK', 'TSLA']);

      expect(mockSql.query).toHaveBeenCalledTimes(1);
      const [stmt, params] = mockSql.query.mock.calls[0] as [string, string[]];
      // Statement must reference the table and use ON CONFLICT DO NOTHING
      expect(stmt).toMatch(/INSERT INTO lottery_kept_tickers/i);
      expect(stmt).toMatch(/ON CONFLICT DO NOTHING/i);
      // Params: date + symbol per ticker
      expect(params).toEqual(['2026-06-07', 'SNDK', '2026-06-07', 'TSLA']);
      expect(mockIncrement).not.toHaveBeenCalled();
    });

    it('deduplicates input before inserting', async () => {
      mockSql.query.mockResolvedValueOnce([]);
      await addKeptTickers('2026-06-07', ['SNDK', 'SNDK', 'TSLA', 'TSLA']);

      expect(mockSql.query).toHaveBeenCalledTimes(1);
      const [, params] = mockSql.query.mock.calls[0] as [string, string[]];
      // Only 2 unique tickers → 4 params total
      expect(params).toHaveLength(4);
      expect(params).toEqual(['2026-06-07', 'SNDK', '2026-06-07', 'TSLA']);
    });

    it('swallows DB errors without throwing, increments db.error', async () => {
      mockSql.query.mockRejectedValueOnce(new Error('db unavailable'));
      await expect(
        addKeptTickers('2026-06-07', ['SNDK']),
      ).resolves.toBeUndefined();
      expect(mockIncrement).toHaveBeenCalledWith('db.error');
    });
  });
});
