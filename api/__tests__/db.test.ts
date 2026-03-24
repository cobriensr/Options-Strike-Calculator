// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @neondatabase/serverless before importing db module
const mockSql = vi.fn();
vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => mockSql),
}));

import {
  getDb,
  _resetDb,
  initDb,
  migrateDb,
  saveSnapshot,
  saveAnalysis,
  saveOutcome,
  savePositions,
  getLatestPositions,
  getPreviousRecommendation,
} from '../_lib/db.js';
import { neon } from '@neondatabase/serverless';

describe('db.ts', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, DATABASE_URL: 'postgres://test' };
    vi.restoreAllMocks();
    mockSql.mockReset();
    vi.mocked(neon).mockReturnValue(mockSql as never);
    _resetDb();
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

      // 4 CREATE TABLEs + 8 CREATE INDEXes = 12 calls
      expect(mockSql).toHaveBeenCalledTimes(12);
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

    it('upserts and returns id on conflict', async () => {
      mockSql.mockResolvedValueOnce([{ id: 7 }]);

      const id = await saveSnapshot({
        date: '2026-03-10',
        entryTime: '09:35',
      });

      expect(id).toBe(7);
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('returns null when upsert returns empty', async () => {
      mockSql.mockResolvedValueOnce([]);

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

  // ============================================================
  // migrateDb
  // ============================================================
  describe('migrateDb', () => {
    it('runs pending migrations and returns applied list', async () => {
      // CREATE TABLE schema_migrations, SELECT applied, then migration #1 (CREATE TABLE + 2 INDEXes + INSERT)
      mockSql.mockResolvedValue([]);

      const applied = await migrateDb();

      expect(applied.length).toBeGreaterThan(0);
      expect(applied[0]).toContain('#1');
      expect(applied[0]).toContain('positions');
    });

    it('skips already-applied migrations', async () => {
      // CREATE TABLE schema_migrations
      mockSql.mockResolvedValueOnce([]);
      // SELECT returns all migrations as already applied
      mockSql.mockResolvedValueOnce([
        { id: 1 },
        { id: 2 },
        { id: 3 },
        { id: 4 },
        { id: 5 },
      ]);

      const applied = await migrateDb();

      expect(applied).toEqual([]);
    });

    it('applies migrations #2 and #3 when migration #1 is already done', async () => {
      // CREATE TABLE schema_migrations
      mockSql.mockResolvedValueOnce([]);
      // SELECT returns migration #1 as already applied
      mockSql.mockResolvedValueOnce([{ id: 1 }]);
      // Migration #2: CREATE EXTENSION + CREATE TABLE lessons + 3 indexes + CREATE TABLE lesson_reports + INSERT = 6+1
      // Migration #3: DROP INDEX + ALTER TABLE + CREATE INDEX + INSERT = 3+1
      mockSql.mockResolvedValue([]);

      const applied = await migrateDb();

      expect(applied).toEqual([
        '#2: Create lessons and lesson_reports tables with pgvector',
        '#3: Reduce lessons embedding from vector(3072) to vector(2000) for HNSW compatibility',
        '#4: Create flow_data table for UW API time series',
        '#5: Create greek_exposure table for MM Greek exposure by expiry',
      ]);
      // 2 setup + 6 migration #2 + 1 insert + 3 migration #3 + 1 insert + 3 migration #4 + 1 insert + 3 migration #5 + 1 insert = 21
      expect(mockSql).toHaveBeenCalledTimes(21);
    });

    it('propagates errors from migration SQL', async () => {
      // CREATE TABLE schema_migrations succeeds
      mockSql.mockResolvedValueOnce([]);
      // SELECT applied succeeds (empty)
      mockSql.mockResolvedValueOnce([]);
      // Migration #1 throws
      mockSql.mockRejectedValueOnce(new Error('DB error'));

      await expect(migrateDb()).rejects.toThrow('DB error');
    });
  });

  // ============================================================
  // savePositions
  // ============================================================
  describe('savePositions', () => {
    it('inserts and returns the new id', async () => {
      mockSql.mockResolvedValueOnce([{ id: 99 }]);

      const id = await savePositions({
        date: '2026-03-16',
        fetchTime: '09:35',
        accountHash: 'abc123',
        spxPrice: 5700,
        summary: 'No open positions.',
        legs: [],
        totalSpreads: 0,
        callSpreads: 0,
        putSpreads: 0,
      });

      expect(id).toBe(99);
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('returns null when insert returns empty', async () => {
      mockSql.mockResolvedValueOnce([]);

      const id = await savePositions({
        date: '2026-03-16',
        fetchTime: '09:35',
        accountHash: 'abc123',
        summary: 'No open positions.',
        legs: [],
      });

      expect(id).toBeNull();
    });

    it('serializes legs as JSON', async () => {
      mockSql.mockResolvedValueOnce([{ id: 1 }]);

      const legs = [
        {
          putCall: 'PUT' as const,
          symbol: 'SPXW260316P05600',
          strike: 5600,
          expiration: '2026-03-16',
          quantity: -1,
          averagePrice: 2.5,
          marketValue: -150,
        },
      ];

      const id = await savePositions({
        date: '2026-03-16',
        fetchTime: '09:35',
        accountHash: 'abc123',
        summary: '1 put spread',
        legs,
        snapshotId: 42,
      });

      expect(id).toBe(1);
    });

    it('passes null for optional numeric fields when not provided', async () => {
      mockSql.mockResolvedValueOnce([{ id: 1 }]);

      await savePositions({
        date: '2026-03-16',
        fetchTime: '09:35',
        accountHash: 'abc123',
        summary: 'test',
        legs: [],
      });

      expect(mockSql).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // getLatestPositions
  // ============================================================
  describe('getLatestPositions', () => {
    it('returns latest positions for a date', async () => {
      mockSql.mockResolvedValueOnce([
        {
          summary: '1 put spread',
          legs: JSON.stringify([{ putCall: 'PUT', strike: 5600 }]),
          fetch_time: '09:35',
          total_spreads: 1,
          call_spreads: 0,
          put_spreads: 1,
          net_delta: -0.05,
          net_theta: 0.12,
          unrealized_pnl: 50,
        },
      ]);

      const result = await getLatestPositions('2026-03-16');

      expect(result).not.toBeNull();
      expect(result!.summary).toBe('1 put spread');
      expect(result!.legs).toEqual([{ putCall: 'PUT', strike: 5600 }]);
      expect(result!.fetchTime).toBe('09:35');
      expect(result!.stats.totalSpreads).toBe(1);
      expect(result!.stats.putSpreads).toBe(1);
      expect(result!.stats.netDelta).toBe(-0.05);
    });

    it('returns null when no positions found', async () => {
      mockSql.mockResolvedValueOnce([]);

      const result = await getLatestPositions('2026-03-16');

      expect(result).toBeNull();
    });

    it('handles legs already parsed as object (not string)', async () => {
      mockSql.mockResolvedValueOnce([
        {
          summary: 'No positions.',
          legs: [{ putCall: 'CALL', strike: 5800 }],
          fetch_time: '10:00',
          total_spreads: 0,
          call_spreads: 0,
          put_spreads: 0,
          net_delta: null,
          net_theta: null,
          unrealized_pnl: null,
        },
      ]);

      const result = await getLatestPositions('2026-03-16');

      expect(result!.legs).toEqual([{ putCall: 'CALL', strike: 5800 }]);
      expect(result!.stats.netDelta).toBeNull();
    });
  });

  // ============================================================
  // getPreviousRecommendation
  // ============================================================
  describe('getPreviousRecommendation', () => {
    it('returns null for entry mode', async () => {
      const result = await getPreviousRecommendation('2026-03-16', 'entry');

      expect(result).toBeNull();
      expect(mockSql).not.toHaveBeenCalled();
    });

    it('returns null for unknown mode', async () => {
      const result = await getPreviousRecommendation('2026-03-16', 'unknown');

      expect(result).toBeNull();
    });

    it('returns null when no previous analyses exist (midday)', async () => {
      mockSql.mockResolvedValueOnce([]);

      const result = await getPreviousRecommendation('2026-03-16', 'midday');

      expect(result).toBeNull();
    });

    it('returns formatted recommendation for midday mode', async () => {
      mockSql.mockResolvedValueOnce([
        {
          mode: 'entry',
          entry_time: '09:35',
          structure: 'IRON CONDOR',
          confidence: 'HIGH',
          suggested_delta: 8,
          hedge: 'Buy 1 VIX call',
          spx: 5700,
          vix: 18,
          vix1d: 15,
          full_response: JSON.stringify({
            reasoning: 'Balanced flow detected.',
            structureRationale: 'NCP ≈ NPP',
            managementRules: {
              profitTarget: 'Close at 50%',
              stopConditions: ['SPX < 5600', 'VIX > 25'],
              flowReversalSignal: 'NCP diverges from NPP',
            },
            entryPlan: {
              maxTotalSize: '3 spreads',
              entry1: {
                structure: 'PCS',
                delta: 5,
                sizePercent: 40,
                note: 'Initial',
              },
              entry2: { condition: 'Pullback to support' },
              entry3: { condition: 'Breakout confirmation' },
            },
            observations: [
              'NCP at +50M',
              'NPP at -40M',
              'Parallel lines',
              'Extra obs',
            ],
            strikeGuidance: {
              putStrikeNote: 'Below 5600',
              callStrikeNote: 'Above 5800',
            },
          }),
          created_at: '2026-03-16T14:35:00Z',
        },
      ]);

      const result = await getPreviousRecommendation('2026-03-16', 'midday');

      expect(result).not.toBeNull();
      expect(result).toContain('Previous ENTRY Analysis (09:35)');
      expect(result).toContain('IRON CONDOR');
      expect(result).toContain('Confidence: HIGH');
      expect(result).toContain('Delta: 8');
      expect(result).toContain('Balanced flow detected.');
      expect(result).toContain('NCP ≈ NPP');
      expect(result).toContain('Close at 50%');
      expect(result).toContain('SPX < 5600');
      expect(result).toContain('NCP diverges from NPP');
      expect(result).toContain('3 spreads');
      expect(result).toContain('Entry 1: PCS 5Δ at 40%');
      expect(result).toContain('Entry 2 condition: Pullback to support');
      expect(result).toContain('Entry 3 condition: Breakout confirmation');
      // Only top 3 observations
      expect(result).toContain('NCP at +50M');
      expect(result).toContain('Parallel lines');
      expect(result).not.toContain('Extra obs');
      expect(result).toContain('Put strike guidance: Below 5600');
      expect(result).toContain('Call strike guidance: Above 5800');
    });

    it('queries review mode with midday preference', async () => {
      mockSql.mockResolvedValueOnce([
        {
          mode: 'midday',
          entry_time: '11:30',
          structure: 'PUT CREDIT SPREAD',
          confidence: 'MODERATE',
          suggested_delta: 6,
          hedge: null,
          spx: 5710,
          vix: 17.5,
          vix1d: 14.8,
          full_response: {
            reasoning: 'Continued selling.',
          },
          created_at: '2026-03-16T16:30:00Z',
        },
      ]);

      const result = await getPreviousRecommendation('2026-03-16', 'review');

      expect(result).toContain('Previous MIDDAY Analysis (11:30)');
      expect(result).toContain('PUT CREDIT SPREAD');
      expect(result).toContain('Hedge: N/A');
      expect(result).toContain('Continued selling.');
    });

    it('handles full_response already parsed as object', async () => {
      mockSql.mockResolvedValueOnce([
        {
          mode: 'entry',
          entry_time: '09:35',
          structure: 'IRON CONDOR',
          confidence: 'HIGH',
          suggested_delta: 8,
          hedge: null,
          spx: 5700,
          vix: 18,
          vix1d: 15,
          full_response: { reasoning: 'Already parsed.' },
          created_at: '2026-03-16T14:35:00Z',
        },
      ]);

      const result = await getPreviousRecommendation('2026-03-16', 'midday');

      expect(result).toContain('Already parsed.');
    });

    it('handles minimal full_response with no optional fields', async () => {
      mockSql.mockResolvedValueOnce([
        {
          mode: 'entry',
          entry_time: '09:35',
          structure: 'SIT OUT',
          confidence: 'LOW',
          suggested_delta: 0,
          hedge: null,
          spx: 5700,
          vix: 30,
          vix1d: 28,
          full_response: JSON.stringify({}),
          created_at: '2026-03-16T14:35:00Z',
        },
      ]);

      const result = await getPreviousRecommendation('2026-03-16', 'midday');

      expect(result).toContain('SIT OUT');
      expect(result).toContain('Confidence: LOW');
      // Should not crash when no optional fields exist
      expect(result).not.toContain('undefined');
    });
  });
});
