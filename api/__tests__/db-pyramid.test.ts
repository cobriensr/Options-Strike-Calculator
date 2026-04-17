// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @neondatabase/serverless before importing db modules.
const mockSql = vi.fn() as ReturnType<typeof vi.fn> & {
  transaction: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
};
mockSql.transaction = vi.fn();
mockSql.query = vi.fn();

vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => mockSql),
}));

import {
  computeCompressionRatio,
  computeElapsedCalendarDays,
  createChain,
  getChains,
  getChainWithLegs,
  updateChain,
  deleteChain,
  createLeg,
  updateLeg,
  deleteLeg,
  getProgressCounts,
  PyramidLegOrderError,
} from '../_lib/db-pyramid.js';
import { _resetDb } from '../_lib/db.js';
import { neon } from '@neondatabase/serverless';

describe('db-pyramid.ts', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, DATABASE_URL: 'postgres://test' };
    vi.restoreAllMocks();
    mockSql.mockReset();
    mockSql.transaction = vi.fn();
    mockSql.query = vi.fn();
    vi.mocked(neon).mockReturnValue(mockSql as never);
    _resetDb();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ============================================================
  // computeCompressionRatio (pure function)
  // ============================================================

  describe('computeCompressionRatio', () => {
    it('returns 1 for leg 1 with present non-zero distance', () => {
      expect(computeCompressionRatio(1, 20, null)).toBe(1);
      expect(computeCompressionRatio(1, 20, 99)).toBe(1); // leg1Stop ignored
    });

    it('returns null for leg 1 when distance is zero (avoid sibling div-by-zero)', () => {
      expect(computeCompressionRatio(1, 0, null)).toBeNull();
    });

    it('returns null for leg 1 when distance is null or undefined', () => {
      expect(computeCompressionRatio(1, null, 20)).toBeNull();
      expect(computeCompressionRatio(1, undefined, 20)).toBeNull();
    });

    it('returns null for leg N>1 when leg 1 distance is null', () => {
      expect(computeCompressionRatio(2, 10, null)).toBeNull();
    });

    it('returns null for leg N>1 when leg 1 distance is zero', () => {
      expect(computeCompressionRatio(2, 10, 0)).toBeNull();
    });

    it('returns null for leg N>1 when current distance is null', () => {
      expect(computeCompressionRatio(2, null, 20)).toBeNull();
    });

    it('returns quotient for leg N>1 with both distances present', () => {
      expect(computeCompressionRatio(2, 10, 20)).toBe(0.5);
      expect(computeCompressionRatio(3, 5, 20)).toBe(0.25);
    });
  });

  // ============================================================
  // computeElapsedCalendarDays (pure function)
  // ============================================================

  describe('computeElapsedCalendarDays', () => {
    it('returns null for null / undefined / empty input', () => {
      expect(computeElapsedCalendarDays(null)).toBeNull();
      expect(computeElapsedCalendarDays(undefined)).toBeNull();
      expect(computeElapsedCalendarDays('')).toBeNull();
    });

    it('returns null for malformed date string', () => {
      expect(computeElapsedCalendarDays('not-a-date')).toBeNull();
      expect(computeElapsedCalendarDays('2026/04/16')).toBeNull();
    });

    it('returns 0 for today', () => {
      // Use vi.useFakeTimers to pin "now" to a known ET midnight so the
      // test is stable across host TZ and DST.
      vi.useFakeTimers();
      // 2026-04-16 noon UTC -> 2026-04-16 in ET (UTC-4 DST)
      vi.setSystemTime(new Date('2026-04-16T12:00:00Z'));
      expect(computeElapsedCalendarDays('2026-04-16')).toBe(0);
      vi.useRealTimers();
    });

    it('returns positive whole days for past dates', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-16T12:00:00Z'));
      expect(computeElapsedCalendarDays('2026-04-10')).toBe(6);
      expect(computeElapsedCalendarDays('2026-03-16')).toBe(31);
      vi.useRealTimers();
    });

    it('never returns negative (clamps at 0 for future dates)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-16T12:00:00Z'));
      expect(computeElapsedCalendarDays('2026-12-31')).toBe(0);
      vi.useRealTimers();
    });
  });

  // ============================================================
  // createChain
  // ============================================================

  describe('createChain', () => {
    it('inserts with defaults and returns the row', async () => {
      const row = {
        id: '2026-04-16-MNQ-1',
        status: 'open',
        total_legs: 0,
      };
      mockSql.mockResolvedValueOnce([row]);

      const result = await createChain({ id: '2026-04-16-MNQ-1' });

      expect(result).toEqual(row);
      expect(mockSql).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // getChains
  // ============================================================

  describe('getChains', () => {
    it('returns the list of chains in query order', async () => {
      const rows = [{ id: '2026-04-16-MNQ-1' }, { id: '2026-04-15-MNQ-1' }];
      mockSql.mockResolvedValueOnce(rows);

      const result = await getChains();

      expect(result).toEqual(rows);
      expect(mockSql).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // getChainWithLegs
  // ============================================================

  describe('getChainWithLegs', () => {
    it('returns null when chain does not exist', async () => {
      mockSql.mockResolvedValueOnce([]);

      const result = await getChainWithLegs('nonexistent');

      expect(result).toBeNull();
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('returns chain + legs when chain exists', async () => {
      const chain = { id: '2026-04-16-MNQ-1', status: 'open' };
      const legs = [
        { id: '2026-04-16-MNQ-1-L1', leg_number: 1 },
        { id: '2026-04-16-MNQ-1-L2', leg_number: 2 },
      ];
      mockSql.mockResolvedValueOnce([chain]);
      mockSql.mockResolvedValueOnce(legs);

      const result = await getChainWithLegs('2026-04-16-MNQ-1');

      expect(result).toEqual({ chain, legs });
      expect(mockSql).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================
  // updateChain
  // ============================================================

  describe('updateChain', () => {
    it('returns null when chain does not exist', async () => {
      mockSql.mockResolvedValueOnce([]);

      const result = await updateChain('nonexistent', { direction: 'long' });

      expect(result).toBeNull();
    });

    it('returns updated row on success', async () => {
      const row = { id: '2026-04-16-MNQ-1', direction: 'long' };
      mockSql.mockResolvedValueOnce([row]);

      const result = await updateChain('2026-04-16-MNQ-1', {
        direction: 'long',
      });

      expect(result).toEqual(row);
    });

    it('silently ignores status:null via COALESCE (matches schema policy)', async () => {
      // The Zod schema no longer accepts status:null at validation time,
      // but the runtime UPDATE still uses COALESCE — we document that
      // behavior here so a future change to drop COALESCE on status
      // breaks this test and prompts a conscious decision.
      const row = { id: '2026-04-16-MNQ-1', status: 'open' };
      mockSql.mockResolvedValueOnce([row]);

      const result = await updateChain('2026-04-16-MNQ-1', {
        // Cast through unknown because Zod correctly rejects null here;
        // we're testing the raw SQL layer's tolerance.
        status: null as unknown as undefined,
      });

      expect(result).toEqual(row);
    });
  });

  // ============================================================
  // deleteChain
  // ============================================================

  describe('deleteChain', () => {
    it('returns true when a row was deleted', async () => {
      mockSql.mockResolvedValueOnce([{ id: '2026-04-16-MNQ-1' }]);
      expect(await deleteChain('2026-04-16-MNQ-1')).toBe(true);
    });

    it('returns false when no row matched', async () => {
      mockSql.mockResolvedValueOnce([]);
      expect(await deleteChain('nonexistent')).toBe(false);
    });
  });

  // ============================================================
  // createLeg
  // ============================================================

  describe('createLeg', () => {
    it('leg 1 insert does NOT look up leg 1 first', async () => {
      // Only one mockSql call expected: the INSERT itself.
      const leg = {
        id: '2026-04-16-MNQ-1-L1',
        chain_id: '2026-04-16-MNQ-1',
        leg_number: 1,
        stop_distance_pts: 20,
        stop_compression_ratio: 1,
      };
      mockSql.mockResolvedValueOnce([leg]);

      const result = await createLeg({
        id: '2026-04-16-MNQ-1-L1',
        chain_id: '2026-04-16-MNQ-1',
        leg_number: 1,
        stop_distance_pts: 20,
      });

      expect(result).toEqual(leg);
      // Single INSERT call — no EXISTS check, no getLeg1StopDistance.
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('leg N>1 with leg 1 present: EXISTS check + leg1 lookup + INSERT', async () => {
      // Sequence: EXISTS probe → getLeg1StopDistance SELECT → INSERT
      mockSql.mockResolvedValueOnce([{ ok: 1 }]);
      mockSql.mockResolvedValueOnce([{ stop_distance_pts: 20 }]);
      const leg2 = {
        id: '2026-04-16-MNQ-1-L2',
        chain_id: '2026-04-16-MNQ-1',
        leg_number: 2,
        stop_distance_pts: 10,
        stop_compression_ratio: 0.5,
      };
      mockSql.mockResolvedValueOnce([leg2]);

      const result = await createLeg({
        id: '2026-04-16-MNQ-1-L2',
        chain_id: '2026-04-16-MNQ-1',
        leg_number: 2,
        stop_distance_pts: 10,
      });

      expect(result).toEqual(leg2);
      expect(mockSql).toHaveBeenCalledTimes(3);
    });

    it('leg N>1 without leg 1 throws PyramidLegOrderError', async () => {
      // EXISTS returns empty → throw before any INSERT runs.
      mockSql.mockResolvedValueOnce([]);

      await expect(
        createLeg({
          id: '2026-04-16-MNQ-1-L2',
          chain_id: '2026-04-16-MNQ-1',
          leg_number: 2,
          stop_distance_pts: 10,
        }),
      ).rejects.toBeInstanceOf(PyramidLegOrderError);

      // Only the EXISTS probe ran.
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('leg N>1 with null leg 1 distance → ratio stored as null', async () => {
      // EXISTS probe succeeds; leg 1 has null distance; INSERT proceeds.
      mockSql.mockResolvedValueOnce([{ ok: 1 }]);
      mockSql.mockResolvedValueOnce([{ stop_distance_pts: null }]);
      mockSql.mockResolvedValueOnce([
        {
          id: '2026-04-16-MNQ-1-L2',
          leg_number: 2,
          stop_compression_ratio: null,
        },
      ]);

      const result = await createLeg({
        id: '2026-04-16-MNQ-1-L2',
        chain_id: '2026-04-16-MNQ-1',
        leg_number: 2,
        stop_distance_pts: 10,
      });

      expect(result.stop_compression_ratio).toBeNull();
      expect(mockSql).toHaveBeenCalledTimes(3);
    });
  });

  // ============================================================
  // updateLeg
  // ============================================================

  describe('updateLeg', () => {
    it('returns null when leg does not exist (patch triggers lookup)', async () => {
      // Patch includes stop_distance_pts → triggers the existence SELECT.
      mockSql.mockResolvedValueOnce([]); // existence query returns empty

      const result = await updateLeg('nonexistent', { stop_distance_pts: 15 });

      expect(result).toBeNull();
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('patch on leg 1 stop_distance_pts cascades sibling ratios via transaction', async () => {
      // Sequence:
      //   1. Existence SELECT → { chain_id, leg_number: 1 }
      //   2. sql.transaction([ target UPDATE, cascade UPDATE ])
      //      transaction returns [targetRows, cascadeRows]
      mockSql.mockResolvedValueOnce([
        { chain_id: '2026-04-16-MNQ-1', leg_number: 1 },
      ]);
      const updatedLeg = {
        id: '2026-04-16-MNQ-1-L1',
        leg_number: 1,
        stop_distance_pts: 40,
        stop_compression_ratio: 1,
      };
      mockSql.transaction.mockResolvedValueOnce([[updatedLeg], []]);

      const result = await updateLeg('2026-04-16-MNQ-1-L1', {
        stop_distance_pts: 40,
      });

      expect(result).toEqual(updatedLeg);
      // Target update + cascade update were both enqueued into the
      // single transaction call — this is the critical bug-fix assertion.
      expect(mockSql.transaction).toHaveBeenCalledTimes(1);
      const txnArg = mockSql.transaction.mock.calls[0]![0];
      expect(Array.isArray(txnArg)).toBe(true);
      expect((txnArg as unknown[]).length).toBe(2);
    });

    it('patch on leg N>1 stop_distance_pts does NOT cascade', async () => {
      // Sequence:
      //   1. Existence SELECT → { chain_id, leg_number: 2 }
      //   2. getLeg1StopDistance SELECT → { stop_distance_pts: 20 }
      //   3. Target UPDATE (no transaction, no cascade)
      mockSql.mockResolvedValueOnce([
        { chain_id: '2026-04-16-MNQ-1', leg_number: 2 },
      ]);
      mockSql.mockResolvedValueOnce([{ stop_distance_pts: 20 }]);
      const updatedLeg = {
        id: '2026-04-16-MNQ-1-L2',
        leg_number: 2,
        stop_distance_pts: 5,
        stop_compression_ratio: 0.25,
      };
      mockSql.mockResolvedValueOnce([updatedLeg]);

      const result = await updateLeg('2026-04-16-MNQ-1-L2', {
        stop_distance_pts: 5,
      });

      expect(result).toEqual(updatedLeg);
      expect(mockSql.transaction).not.toHaveBeenCalled();
      expect(mockSql).toHaveBeenCalledTimes(3);
    });

    it('patch with stop_distance_pts: null clears distance and ratio together', async () => {
      // Explicit null in the patch should:
      //   - trigger recomputeRatio (patch.stop_distance_pts !== undefined)
      //   - clear stop_distance_pts (no COALESCE swallow)
      //   - set ratio to null (compute returns null for null input)
      mockSql.mockResolvedValueOnce([
        { chain_id: '2026-04-16-MNQ-1', leg_number: 2 },
      ]);
      mockSql.mockResolvedValueOnce([{ stop_distance_pts: 20 }]);
      const updatedLeg = {
        id: '2026-04-16-MNQ-1-L2',
        stop_distance_pts: null,
        stop_compression_ratio: null,
      };
      mockSql.mockResolvedValueOnce([updatedLeg]);

      const result = await updateLeg('2026-04-16-MNQ-1-L2', {
        stop_distance_pts: null,
      });

      expect(result).toEqual(updatedLeg);
    });

    it('patch without stop_distance_pts does NOT trigger existence SELECT', async () => {
      // Just the final UPDATE runs.
      mockSql.mockResolvedValueOnce([
        { id: '2026-04-16-MNQ-1-L2', notes: 'updated' },
      ]);

      await updateLeg('2026-04-16-MNQ-1-L2', { notes: 'updated' });

      expect(mockSql).toHaveBeenCalledTimes(1);
      expect(mockSql.transaction).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // deleteLeg
  // ============================================================

  describe('deleteLeg', () => {
    it('returns true when a row was deleted', async () => {
      mockSql.mockResolvedValueOnce([{ id: '2026-04-16-MNQ-1-L1' }]);
      expect(await deleteLeg('2026-04-16-MNQ-1-L1')).toBe(true);
    });

    it('returns false when no row matched', async () => {
      mockSql.mockResolvedValueOnce([]);
      expect(await deleteLeg('nonexistent')).toBe(false);
    });
  });

  // ============================================================
  // getProgressCounts
  // ============================================================

  describe('getProgressCounts', () => {
    it('returns zeros and null elapsed for empty DB', async () => {
      // Chain-level aggregate.
      mockSql.mockResolvedValueOnce([
        {
          total_chains: 0,
          trend: 0,
          chop: 0,
          news: 0,
          mixed: 0,
          unspecified: 0,
          first_trade_date: null,
        },
      ]);
      // Fill-rate query via sql.query().
      const emptyFillRow: Record<string, number> = { total_legs: 0 };
      mockSql.query.mockResolvedValueOnce([emptyFillRow]);

      const result = await getProgressCounts();

      expect(result.total_chains).toBe(0);
      expect(result.chains_by_day_type).toEqual({
        trend: 0,
        chop: 0,
        news: 0,
        mixed: 0,
        unspecified: 0,
      });
      expect(result.elapsed_calendar_days).toBeNull();
      // Every nullable feature column should read 0, not NaN.
      for (const [, rate] of Object.entries(result.fill_rates)) {
        expect(rate).toBe(0);
      }
    });

    it('returns zero fill rates when chains exist but no legs', async () => {
      mockSql.mockResolvedValueOnce([
        {
          total_chains: 3,
          trend: 1,
          chop: 1,
          news: 0,
          mixed: 0,
          unspecified: 1,
          first_trade_date: '2026-04-10',
        },
      ]);
      mockSql.query.mockResolvedValueOnce([{ total_legs: 0 }]);

      const result = await getProgressCounts();

      expect(result.total_chains).toBe(3);
      expect(result.chains_by_day_type.trend).toBe(1);
      expect(result.chains_by_day_type.chop).toBe(1);
      expect(result.chains_by_day_type.unspecified).toBe(1);
      for (const [, rate] of Object.entries(result.fill_rates)) {
        expect(rate).toBe(0);
        expect(Number.isNaN(rate)).toBe(false);
      }
    });

    it('divides non-null counts by total_legs for each feature column', async () => {
      mockSql.mockResolvedValueOnce([
        {
          total_chains: 2,
          trend: 2,
          chop: 0,
          news: 0,
          mixed: 0,
          unspecified: 0,
          first_trade_date: '2026-04-14',
        },
      ]);
      // 10 legs total: entry_price filled on 8, ob_quality on 5, notes on 0.
      const fillRow: Record<string, number> = {
        total_legs: 10,
        signal_type: 10,
        entry_time_ct: 0,
        entry_price: 8,
        stop_price: 0,
        stop_distance_pts: 0,
        stop_compression_ratio: 0,
        vwap_at_entry: 0,
        vwap_1sd_upper: 0,
        vwap_1sd_lower: 0,
        vwap_band_position: 0,
        vwap_band_distance_pts: 0,
        minutes_since_chain_start: 0,
        minutes_since_prior_bos: 0,
        ob_quality: 5,
        relative_volume: 0,
        session_phase: 0,
        session_high_at_entry: 0,
        session_low_at_entry: 0,
        retracement_extreme_before_entry: 0,
        exit_price: 0,
        exit_reason: 0,
        points_captured: 0,
        r_multiple: 0,
        was_profitable: 0,
        notes: 0,
      };
      mockSql.query.mockResolvedValueOnce([fillRow]);

      const result = await getProgressCounts();

      expect(result.fill_rates.signal_type).toBe(1);
      expect(result.fill_rates.entry_price).toBe(0.8);
      expect(result.fill_rates.ob_quality).toBe(0.5);
      expect(result.fill_rates.notes).toBe(0);
    });
  });
});
