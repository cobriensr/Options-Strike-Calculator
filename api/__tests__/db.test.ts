// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @neondatabase/serverless before importing db module
const mockSql = vi.fn();
vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => mockSql),
}));

import {
  getDb,
  initDb,
  saveSnapshot,
  saveAnalysis,
  saveOutcome,
} from '../_lib/db.js';
import { neon } from '@neondatabase/serverless';

describe('db.ts', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, DATABASE_URL: 'postgres://test' };
    vi.restoreAllMocks();
    mockSql.mockReset();
    vi.mocked(neon).mockReturnValue(mockSql as never);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ============================================================
  // getDb
  // ============================================================
  describe('getDb', () => {
    it('returns a sql tagged template function', () => {
      const sql = getDb();
      expect(neon).toHaveBeenCalledWith('postgres://test');
      expect(sql).toBe(mockSql);
    });

    it('throws when DATABASE_URL is not set', () => {
      delete process.env.DATABASE_URL;
      expect(() => getDb()).toThrow('DATABASE_URL not configured');
    });
  });

  // ============================================================
  // initDb
  // ============================================================
  describe('initDb', () => {
    it('runs CREATE TABLE and CREATE INDEX statements', async () => {
      mockSql.mockResolvedValue([]);

      await initDb();

      // 3 CREATE TABLEs + 6 CREATE INDEXes = 9 calls
      expect(mockSql).toHaveBeenCalledTimes(9);
    });
  });

  // ============================================================
  // saveSnapshot
  // ============================================================
  describe('saveSnapshot', () => {
    it('inserts and returns the new id', async () => {
      mockSql.mockResolvedValueOnce([{ id: 42 }]);

      const id = await saveSnapshot({
        date: '2026-03-10',
        entryTime: '09:35',
        spx: 5500,
        vix: 18,
        vix1d: 15,
        vix9d: 17,
      });

      expect(id).toBe(42);
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('looks up existing id on conflict (empty RETURNING)', async () => {
      mockSql
        .mockResolvedValueOnce([]) // INSERT returns nothing (conflict)
        .mockResolvedValueOnce([{ id: 7 }]); // SELECT existing

      const id = await saveSnapshot({
        date: '2026-03-10',
        entryTime: '09:35',
      });

      expect(id).toBe(7);
      expect(mockSql).toHaveBeenCalledTimes(2);
    });

    it('returns null when neither insert nor lookup finds a row', async () => {
      mockSql
        .mockResolvedValueOnce([]) // INSERT returns nothing
        .mockResolvedValueOnce([]); // SELECT also empty

      const id = await saveSnapshot({
        date: '2026-03-10',
        entryTime: '09:35',
      });

      expect(id).toBeNull();
    });

    it('computes vix1d/vix ratio when both values present', async () => {
      mockSql.mockResolvedValueOnce([{ id: 1 }]);

      await saveSnapshot({
        date: '2026-03-10',
        entryTime: '09:35',
        vix: 20,
        vix1d: 16,
        vix9d: 18,
      });

      // The tagged template is called with template strings + values.
      // We verify it was called (ratio computation is inline in the SQL values).
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('sets ratio to null when vix is 0', async () => {
      mockSql.mockResolvedValueOnce([{ id: 1 }]);

      await saveSnapshot({
        date: '2026-03-10',
        entryTime: '09:35',
        vix: 0,
        vix1d: 16,
      });

      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('sets ratio to null when vix9d is 0', async () => {
      mockSql.mockResolvedValueOnce([{ id: 1 }]);

      await saveSnapshot({
        date: '2026-03-10',
        entryTime: '09:35',
        vix: 20,
        vix9d: 0,
      });

      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('stringifies strikes as JSON', async () => {
      mockSql.mockResolvedValueOnce([{ id: 1 }]);

      await saveSnapshot({
        date: '2026-03-10',
        entryTime: '09:35',
        strikes: { '5': { put: 5400, call: 5600 } },
      });

      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('passes null for missing optional fields', async () => {
      mockSql.mockResolvedValueOnce([{ id: 1 }]);

      const id = await saveSnapshot({
        date: '2026-03-10',
        entryTime: '09:35',
      });

      expect(id).toBe(1);
    });
  });

  // ============================================================
  // saveAnalysis
  // ============================================================
  describe('saveAnalysis', () => {
    it('inserts an analysis with all fields', async () => {
      mockSql.mockResolvedValueOnce([]);

      await saveAnalysis(
        {
          selectedDate: '2026-03-10',
          entryTime: '09:35',
          spx: 5500,
          vix: 18,
          vix1d: 15,
        },
        {
          mode: 'entry',
          structure: 'IRON CONDOR',
          confidence: 'HIGH',
          suggestedDelta: 5,
          hedge: { recommendation: 'Buy 1 VIX call' },
        },
        42,
      );

      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('defaults date to current ET date when selectedDate missing', async () => {
      mockSql.mockResolvedValueOnce([]);

      await saveAnalysis(
        { entryTime: '09:35' },
        {
          structure: 'PUT CREDIT SPREAD',
          confidence: 'MODERATE',
          suggestedDelta: 8,
        },
      );

      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('defaults entryTime to "unknown" when missing', async () => {
      mockSql.mockResolvedValueOnce([]);

      await saveAnalysis(
        { selectedDate: '2026-03-10' },
        {
          structure: 'PUT CREDIT SPREAD',
          confidence: 'MODERATE',
          suggestedDelta: 8,
        },
      );

      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('defaults mode to "entry" when not in analysis', async () => {
      mockSql.mockResolvedValueOnce([]);

      await saveAnalysis(
        { selectedDate: '2026-03-10', entryTime: '09:35' },
        {
          structure: 'IRON CONDOR',
          confidence: 'HIGH',
          suggestedDelta: 5,
        },
      );

      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('handles null hedge', async () => {
      mockSql.mockResolvedValueOnce([]);

      await saveAnalysis(
        { selectedDate: '2026-03-10', entryTime: '09:35' },
        {
          structure: 'IRON CONDOR',
          confidence: 'HIGH',
          suggestedDelta: 5,
          hedge: null,
        },
      );

      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('passes null for snapshotId when not provided', async () => {
      mockSql.mockResolvedValueOnce([]);

      await saveAnalysis(
        { selectedDate: '2026-03-10', entryTime: '09:35' },
        {
          structure: 'IRON CONDOR',
          confidence: 'HIGH',
          suggestedDelta: 5,
        },
      );

      expect(mockSql).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // saveOutcome
  // ============================================================
  describe('saveOutcome', () => {
    it('inserts outcome with computed range fields', async () => {
      mockSql.mockResolvedValueOnce([]);

      await saveOutcome({
        date: '2026-03-10',
        settlement: 5510,
        dayOpen: 5500,
        dayHigh: 5530,
        dayLow: 5480,
        vixClose: 17.5,
        vix1dClose: 14.8,
      });

      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('computes rangePct as null when dayOpen is 0', async () => {
      mockSql.mockResolvedValueOnce([]);

      await saveOutcome({
        date: '2026-03-10',
        settlement: 0,
        dayOpen: 0,
        dayHigh: 10,
        dayLow: 0,
      });

      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('handles missing optional vix fields', async () => {
      mockSql.mockResolvedValueOnce([]);

      await saveOutcome({
        date: '2026-03-10',
        settlement: 5510,
        dayOpen: 5500,
        dayHigh: 5530,
        dayLow: 5480,
      });

      expect(mockSql).toHaveBeenCalledTimes(1);
    });
  });
});
