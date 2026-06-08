// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// DB mock — same pattern as other api/__tests__ DB-backed module tests.
// Both helpers use the tagged-template `sql\`…\`` form (no `sql.query()`).
const mockSql = vi.fn();

// Override `getDb` only; keep the REAL `safeDb`/`safeDbVoid` (kept-tickers now
// routes its swallow-and-`db.error` behavior through them) so the error-swallow
// path under test exercises the production wrapper, not a stub.
vi.mock('../_lib/db.js', async () => {
  const actual =
    await vi.importActual<typeof import('../_lib/db.js')>('../_lib/db.js');
  return {
    ...actual,
    getDb: vi.fn(() => mockSql),
  };
});

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
      expect(mockSql).not.toHaveBeenCalled();
      expect(mockIncrement).not.toHaveBeenCalled();
    });

    it('issues ONE batched UNNEST INSERT binding the date + ticker array', async () => {
      mockSql.mockResolvedValueOnce([]);
      await addKeptTickers('2026-06-07', ['SNDK', 'TSLA']);

      expect(mockSql).toHaveBeenCalledTimes(1);
      // Tagged template: call is [staticStrings, ...interpolatedParams].
      const call = mockSql.mock.calls[0] as [readonly string[], ...unknown[]];
      const [strings, ...params] = call;
      const stmt = strings.join('');
      // Statement must reference the table, use unnest, and ON CONFLICT.
      expect(stmt).toMatch(/INSERT INTO lottery_kept_tickers/i);
      expect(stmt).toMatch(/unnest\(/i);
      expect(stmt).toMatch(/ON CONFLICT DO NOTHING/i);
      // Bound params: the date scalar + the ticker string array (ONE array
      // param, not 2/row).
      expect(params).toEqual(['2026-06-07', ['SNDK', 'TSLA']]);
      expect(mockIncrement).not.toHaveBeenCalled();
    });

    it('relies on ON CONFLICT DO NOTHING for dedup — passes the array through as-is', async () => {
      // The caller already supplies a distinct set-difference, so there is no
      // client-side Set dedup: residual duplicates are absorbed by the
      // ON CONFLICT clause, not filtered in JS.
      mockSql.mockResolvedValueOnce([]);
      await addKeptTickers('2026-06-07', ['SNDK', 'SNDK', 'TSLA']);

      expect(mockSql).toHaveBeenCalledTimes(1);
      const call = mockSql.mock.calls[0] as [readonly string[], ...unknown[]];
      const [, ...params] = call;
      // Array is passed verbatim (duplicate SNDK retained) — DB dedups it.
      expect(params).toEqual(['2026-06-07', ['SNDK', 'SNDK', 'TSLA']]);
    });

    it('swallows DB errors without throwing, increments db.error', async () => {
      mockSql.mockRejectedValueOnce(new Error('db unavailable'));
      await expect(
        addKeptTickers('2026-06-07', ['SNDK']),
      ).resolves.toBeUndefined();
      expect(mockIncrement).toHaveBeenCalledWith('db.error');
    });
  });
});
