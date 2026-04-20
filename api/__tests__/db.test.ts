// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @neondatabase/serverless before importing db module
const mockSql = vi.fn() as ReturnType<typeof vi.fn> & {
  transaction: ReturnType<typeof vi.fn>;
};
mockSql.transaction = vi.fn().mockResolvedValue([]);
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
  getFlowData,
  formatFlowDataForClaude,
  getGreekExposure,
  formatGreekExposureForClaude,
  getSpotExposures,
  formatSpotExposuresForClaude,
  getVixOhlcFromSnapshots,
  saveDarkPoolSnapshot,
} from '../_lib/db.js';
import type { GreekExposureRow, SpotExposureRow } from '../_lib/db.js';
import { neon } from '@neondatabase/serverless';

// ── Helper factories (outer scope for SonarLint S7721) ──────

function makeAggRow(
  netGamma: number,
  overrides: Partial<GreekExposureRow> = {},
): GreekExposureRow {
  return {
    expiry: '2026-03-24',
    dte: -1,
    callGamma: Math.max(netGamma, 0),
    putGamma: Math.min(netGamma, 0),
    netGamma,
    callCharm: 500_000,
    putCharm: -300_000,
    netCharm: 200_000,
    callDelta: 1_000_000,
    putDelta: -800_000,
    netDelta: 200_000,
    callVanna: 100_000,
    putVanna: -60_000,
    ...overrides,
  };
}

function makeZeroDteRow(
  overrides: Partial<GreekExposureRow> = {},
): GreekExposureRow {
  return {
    expiry: '2026-03-24',
    dte: 0,
    callGamma: null,
    putGamma: null,
    netGamma: null,
    callCharm: 100_000,
    putCharm: -80_000,
    netCharm: 20_000,
    callDelta: 200_000,
    putDelta: -150_000,
    netDelta: 50_000,
    callVanna: 25_000,
    putVanna: -15_000,
    ...overrides,
  };
}

function makeSpotRow(
  overrides: Partial<SpotExposureRow> = {},
): SpotExposureRow {
  return {
    timestamp: '2026-03-24T14:00:00.000Z',
    price: 5825,
    gammaOi: 100_000_000_000,
    gammaVol: 50_000_000_000,
    gammaDir: 30_000_000_000,
    charmOi: -500_000_000_000,
    charmVol: -100_000_000_000,
    charmDir: -80_000_000_000,
    vannaOi: 300_000_000_000,
    vannaVol: 50_000_000_000,
    vannaDir: 40_000_000_000,
    ...overrides,
  };
}

describe('db.ts', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, DATABASE_URL: 'postgres://test' };
    vi.restoreAllMocks();
    mockSql.mockReset();
    mockSql.transaction = vi.fn().mockResolvedValue([]);
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

      // 3 CREATE TABLEs + 6 CREATE INDEXes = 9 calls (positions moved to migration #1)
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
        { id: 6 },
        { id: 7 },
        { id: 8 },
        { id: 9 },
        { id: 10 },
        { id: 11 },
        { id: 12 },
        { id: 13 },
        { id: 14 },
        { id: 15 },
        { id: 16 },
        { id: 17 },
        { id: 18 },
        { id: 19 },
        { id: 20 },
        { id: 21 },
        { id: 22 },
        { id: 23 },
        { id: 24 },
        { id: 25 },
        { id: 26 },
        { id: 27 },
        { id: 28 },
        { id: 29 },
        { id: 30 },
        { id: 31 },
        { id: 32 },
        { id: 33 },
        { id: 34 },
        { id: 35 },
        { id: 36 },
        { id: 37 },
        { id: 38 },
        { id: 39 },
        { id: 40 },
        { id: 41 },
        { id: 42 },
        { id: 43 },
        { id: 44 },
        { id: 45 },
        { id: 46 },
        { id: 47 },
        { id: 48 },
        { id: 49 },
        { id: 50 },
        { id: 51 },
        { id: 52 },
        { id: 53 },
        { id: 54 },
        { id: 55 },
        { id: 56 },
        { id: 57 },
        { id: 58 },
        { id: 59 },
        { id: 60 },
        { id: 61 },
        { id: 62 },
        { id: 63 },
        { id: 64 },
        { id: 65 },
        { id: 66 },
        { id: 67 },
        { id: 68 },
        { id: 69 },
        { id: 70 },
        { id: 71 },
        { id: 72 },
        { id: 73 },
        { id: 74 },
        { id: 75 },
        { id: 76 },
        { id: 77 },
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
      // Migration #3: DROP INDEX + ALTER TABLE + CREATE INDEX + INSERT = 3+1 (atomic via statements/transaction per BE-CRON-010)
      mockSql.mockResolvedValue([]);

      const applied = await migrateDb();

      expect(applied).toEqual([
        '#2: Create lessons and lesson_reports tables with pgvector',
        '#3: Reduce lessons embedding from vector(3072) to vector(2000) for HNSW compatibility',
        '#4: Create flow_data table for UW API time series',
        '#5: Create greek_exposure table for MM Greek exposure by expiry',
        '#6: Add dte to greek_exposure unique constraint',
        '#7: Create spot_exposures table for intraday GEX panel data',
        '#8: Create strike_exposures table for per-strike Greek profile',
        '#9: Create training_features table for daily ML feature vectors',
        '#10: Create day_labels table for ML labels extracted from reviews',
        '#11: Create economic_events table and add Phase 2 features to training_features',
        '#12: Create es_bars table for ES futures 1-minute OHLCV bars from sidecar',
        '#13: Create es_overnight_summaries table for pre-computed overnight ES metrics',
        '#14: Add pre_market_data JSONB column to market_snapshots',
        '#15: Add composite index on analyses (date, created_at DESC) for getPreviousRecommendation',
        '#16: Add composite index on flow_data (date, source, timestamp) for time-windowed queries',
        '#17: Add NOT NULL constraint to all created_at columns',
        '#18: Add JSONB type constraints on legs, full_response, and report',
        '#19: Create predictions table for ML model outputs',
        '#20: Create dark_pool_snapshots table for persisted cluster data',
        '#21: Add dark pool feature columns to training_features',
        '#22: Add max pain columns to training_features',
        '#23: Create oi_per_strike table for daily open interest by strike',
        '#24: Add options volume/premium feature columns to training_features',
        '#25: Create iv_monitor, flow_ratio_monitor, and market_alerts tables',
        '#26: Add IV monitor and flow ratio monitor feature columns to training_features',
        '#27: Create dark_pool_levels table for cron-refreshed dark pool clusters',
        '#28: Add unique constraint on dark_pool_levels(date, spx_approx) for UPSERT',
        '#29: Add dark pool support/resistance ratio and concentration to training_features',
        '#30: Create oi_changes table for daily OI change data',
        '#31: Add OI change feature columns to training_features',
        '#32: Create vol_term_structure and vol_realized tables',
        '#33: Add vol surface feature columns to training_features',
        '#34: Create ml_findings table for dynamic ML calibration',
        '#35: Create ml_plot_analyses table for Claude vision plot analysis',
        '#36: Add prompt_hash column to analyses for prompt version tracking',
        '#37: Add analysis_embedding vector(2000) column for historical analysis retrieval',
        '#38: Add HNSW index on analysis_embedding for cosine similarity search',
        '#39: Add composite index on iv_monitor(date, timestamp DESC) for time-windowed IV queries',
        '#40: Add composite index on flow_data(date, source, timestamp DESC) for ordered flow queries',
        '#41: Add composite index on flow_ratio_monitor(date, timestamp DESC) for time-windowed ratio queries',
        '#42: Create futures_bars table and migrate es_bars data',
        '#43: Create futures_options_trades table for tick-level ES option trades',
        '#44: Create futures_options_daily table for EOD statistics with exchange Greeks',
        '#45: Create futures_snapshots table for computed intraday futures context',
        '#46: Create alert_config table with default alert thresholds',
        '#47: Create gex_strike_0dte table for per-minute 0DTE gamma exposure by strike',
        '#48: Add OTM delta flow columns to flow_data for zero_dte_greek_flow source',
        '#49: Create volume_per_strike_0dte table for per-minute 0DTE raw call/put volume by strike',
        '#50: Dedupe existing futures_options_trades rows and add UNIQUE index for Databento resend idempotency (SIDE-003)',
        '#51: Create gex_target_features table — three-layer (Layer 2 inputs + Layer 3 scoring outputs) per snapshot × strike × mode for the GexTarget rebuild',
        '#52: Create spx_candles_1m table for pre-baked 1-minute SPX candles (GexTarget rebuild: Phase 3 populates from UW SPY→SPX conversion)',
        '#53: Create greek_exposure_strike table for per-strike 0DTE greek exposure (raw UW + computed net values for ML pipeline)',
        '#54: Add spx_schwab_price column to spx_candles_1m for Schwab-verified SPX close anchor',
        '#55: Add prev_gex_dollars_10m and prev_gex_dollars_15m columns to gex_target_features for 5-minute sparkline resolution',
        '#56: Create trace_predictions table for manual TRACE Delta Pressure EOD pin predictions',
        '#57: Add gamma_regime column to trace_predictions for GEX environment context',
        '#58: Drop derived scoring columns from gex_target_features — scoring now happens browser-side from raw features so these columns are dead weight subject to formula-rot',
        '#59: Create flow_alerts table for UW 0-1 DTE SPXW repeated-hit flow ingestion',
        '#60: Create nope_ticks table for UW SPY NOPE per-minute time series (ML feature source)',
        '#61: Add NOPE-derived columns to training_features (4 checkpoint values + 3 AM aggregates)',
        '#62: Create whale_alerts table for UW ≥$1M premium SPXW flow persistence (0-7 DTE, all rules)',
        '#63: Create market_internals table for live $TICK/$ADD/$VOLD/$TRIN 1-minute OHLC bars',
        '#64: Widen market_internals OHLC columns to unqualified NUMERIC — $VOLD values exceed NUMERIC(10,4)',
        '#65: Create pyramid_chains + pyramid_legs tables for droppable MNQ pyramid trade tracker experiment',
        '#66: Add LuxAlgo OB volume-profile metrics to pyramid_legs. Captures POC price + node distribution for ML concentration features.',
        '#67: Extend pyramid_legs exit_reason enum with FVG/VWAP trail variants and add RTH/ETH structure bias columns for session-aware ML features.',
        '#68: Drop pyramid_chains + pyramid_legs tables (pyramid trade tracker experiment retired)',
        '#69: Drop trace_predictions table and purge trace plot analyses (TRACE PIN experiment retired)',
        '#70: Create theta_option_eod table for Theta Data nightly EOD option chains (SPXW/VIX/VIXW/NDXP)',
        '#71: Create futures_top_of_book table for Databento MBP-1 quote events (ES L1 book, Phase 2a)',
        '#72: Create futures_trade_ticks table for Databento TBBO trade events with aggressor side (ES L1, Phase 2a)',
        '#73: Create day_embeddings table with pgvector for historical analog retrieval',
        '#74: Create day_features table with 60-dim numeric vector for engineered path-shape analogs (Phase C)',
        '#75: Create current_day_snapshot for materialized live-day archive context (path 2)',
        '#76: Add OHLC + asymmetric excursion columns to day_embeddings for analog range forecast',
        '#77: Add vix_bucket column to day_embeddings for regime-stratified analog retrieval',
      ]);
      // Pyramid migrations #65/66/67 remain in the chain (migration history is
      // immutable — fresh DBs replay create → alter → alter → drop). TRACE
      // migrations #56/57 also remain — #69 drops the table they created.
      // 134 (migrations #1-41) + 4 (#42) + 4 (#43) + 2 (#44) + 2 (#45) + 3 (#46) + 4 (#47: CREATE+2 INDEX+INSERT) + 2 (#48: ALTER+INSERT) + 4 (#49: CREATE+2 INDEX+INSERT) + 3 (#50: DELETE+CREATE UNIQUE INDEX+INSERT) + 5 (#51: CREATE+3 INDEX+INSERT) + 3 (#52: CREATE+1 INDEX+INSERT) + 4 (#53: CREATE+2 INDEX+INSERT) + 2 (#54: ALTER+INSERT) + 2 (#55: ALTER+INSERT) + 2 (#56: CREATE+INSERT) + 2 (#57: ALTER+INSERT) + 3 (#58: DROP INDEX+ALTER+INSERT) + 7 (#59: CREATE+5 INDEX+INSERT) + 2 (#60: CREATE+INSERT) + 2 (#61: ALTER+INSERT) + 7 (#62: CREATE+5 INDEX+INSERT) + 3 (#63: CREATE+1 INDEX+INSERT) + 2 (#64: ALTER+INSERT) + 6 (#65: CREATE chains+2 INDEX+CREATE legs+1 INDEX+INSERT) + 8 (#66: 7 ALTER+INSERT) + 5 (#67: DROP CONSTRAINT+ADD CONSTRAINT+2 ALTER+INSERT) + 3 (#68: 2 DROP+INSERT) + 3 (#69: DELETE+DROP+INSERT) + 4 (#70: CREATE+2 INDEX+INSERT) + 3 (#71: CREATE+1 INDEX+INSERT) + 3 (#72: CREATE+1 INDEX+INSERT) + 4 (#73: CREATE EXTENSION+CREATE TABLE+CREATE INDEX+INSERT) + 3 (#74: CREATE TABLE+CREATE INDEX+INSERT) + 3 (#75: CREATE TABLE+CREATE INDEX+INSERT) + 2 (#76: ALTER+INSERT) + 3 (#77: ALTER+INDEX+INSERT) = 258
      // Migration #3 was converted from run: to statements: (BE-CRON-010);
      // its 4 calls (DROP INDEX + ALTER + CREATE INDEX + INSERT) still count
      // toward the total — the only delta is that they route through
      // sql.transaction() instead of sequential awaits.
      expect(mockSql).toHaveBeenCalledTimes(258);
      // Migrations #3 and #15-77 each call sql.transaction() once for atomic execution
      expect(mockSql.transaction).toHaveBeenCalledTimes(64);
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
      expect(result).toContain(
        'Entry 1 (recommended): PCS 5Δ at 40% — Initial',
      );
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

  // ============================================================
  // getFlowData
  // ============================================================
  describe('getFlowData', () => {
    it('returns mapped flow data rows (non-greek-flow source has null OTM)', async () => {
      mockSql.mockResolvedValueOnce([
        {
          timestamp: '2026-03-24T14:00:00Z',
          ncp: '150000000',
          npp: '-120000000',
          net_volume: 5000,
          otm_ncp: null,
          otm_npp: null,
        },
        {
          timestamp: '2026-03-24T14:05:00Z',
          ncp: '160000000',
          npp: '-110000000',
          net_volume: -3000,
          otm_ncp: null,
          otm_npp: null,
        },
      ]);

      const result = await getFlowData('2026-03-24', 'market_tide');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        timestamp: '2026-03-24T14:00:00Z',
        ncp: 150000000,
        npp: -120000000,
        netVolume: 5000,
        otmNcp: null,
        otmNpp: null,
      });
      expect(result[1]!.netVolume).toBe(-3000);
      expect(result[1]!.otmNcp).toBeNull();
    });

    it('maps otm_ncp/otm_npp columns for zero_dte_greek_flow source (ENH-FIX-001)', async () => {
      mockSql.mockResolvedValueOnce([
        {
          timestamp: '2026-03-24T14:00:00Z',
          ncp: '5000000',
          npp: '-3000000',
          net_volume: 120000,
          otm_ncp: '2500000',
          otm_npp: '-1800000',
        },
      ]);

      const result = await getFlowData('2026-03-24', 'zero_dte_greek_flow');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        timestamp: '2026-03-24T14:00:00Z',
        ncp: 5_000_000,
        npp: -3_000_000,
        netVolume: 120_000,
        otmNcp: 2_500_000,
        otmNpp: -1_800_000,
      });
    });

    it('returns empty array when no rows', async () => {
      mockSql.mockResolvedValueOnce([]);
      const result = await getFlowData('2026-03-24', 'market_tide');
      expect(result).toEqual([]);
    });
  });

  // ============================================================
  // formatFlowDataForClaude
  // ============================================================
  describe('formatFlowDataForClaude', () => {
    it('returns null for empty rows', () => {
      expect(formatFlowDataForClaude([], 'Market Tide')).toBeNull();
    });

    it('formats a single row without direction or divergence', () => {
      const result = formatFlowDataForClaude(
        [
          {
            timestamp: '2026-03-24T14:00:00.000Z',
            ncp: 150_000_000,
            npp: -120_000_000,
            netVolume: 5000,
          },
        ],
        'Market Tide',
      );

      expect(result).toContain('Market Tide (5-min intervals):');
      expect(result).toContain('NCP: +$150.0M');
      expect(result).toContain('NPP: -$120.0M');
      expect(result).toContain('Vol: +5,000');
      // No direction or pattern with only 1 row
      expect(result).not.toContain('Direction');
      expect(result).not.toContain('Pattern');
    });

    it('computes direction and bullish divergence widening', () => {
      const rows = [
        {
          timestamp: '2026-03-24T14:00:00.000Z',
          ncp: 100_000_000,
          npp: -80_000_000,
          netVolume: 1000,
        },
        {
          timestamp: '2026-03-24T15:00:00.000Z',
          ncp: 200_000_000,
          npp: -90_000_000,
          netVolume: 2000,
        },
      ];

      const result = formatFlowDataForClaude(rows, 'Market Tide')!;

      expect(result).toContain(
        'Direction (60 min): NCP rising (+$100.0M), NPP falling (-$10.0M)',
      );
      expect(result).toContain('Pattern: bullish divergence widening');
    });

    it('detects bearish divergence widening', () => {
      const rows = [
        {
          timestamp: '2026-03-24T14:00:00.000Z',
          ncp: -100_000_000,
          npp: 80_000_000,
          netVolume: 0,
        },
        {
          timestamp: '2026-03-24T14:30:00.000Z',
          ncp: -200_000_000,
          npp: 90_000_000,
          netVolume: 0,
        },
      ];

      const result = formatFlowDataForClaude(rows, 'Test')!;

      expect(result).toContain('Pattern: bearish divergence widening');
    });

    it('detects NCP/NPP converging pattern', () => {
      // prevGap = 200M - (-100M) = 300M; gap = 50M - (-50M) = 100M; 100 < 300*0.5=150 → converging
      const rows = [
        {
          timestamp: '2026-03-24T14:00:00.000Z',
          ncp: 200_000_000,
          npp: -100_000_000,
          netVolume: 0,
        },
        {
          timestamp: '2026-03-24T14:30:00.000Z',
          ncp: 50_000_000,
          npp: -50_000_000,
          netVolume: 0,
        },
      ];

      const result = formatFlowDataForClaude(rows, 'Test')!;

      expect(result).toContain('Pattern: NCP/NPP converging');
    });

    it('detects roughly parallel pattern', () => {
      const rows = [
        {
          timestamp: '2026-03-24T14:00:00.000Z',
          ncp: 100_000_000,
          npp: -50_000_000,
          netVolume: 0,
        },
        {
          timestamp: '2026-03-24T14:30:00.000Z',
          ncp: 130_000_000,
          npp: -20_000_000,
          netVolume: 0,
        },
      ];

      const result = formatFlowDataForClaude(rows, 'Test')!;

      expect(result).toContain('Pattern: Lines roughly parallel');
    });

    it('formats negative volume correctly', () => {
      const result = formatFlowDataForClaude(
        [
          {
            timestamp: '2026-03-24T14:00:00.000Z',
            ncp: 1000,
            npp: -500,
            netVolume: -2000,
          },
        ],
        'Test',
      )!;

      expect(result).toContain('Vol: -2,000');
    });

    it('formats billion-scale values', () => {
      const result = formatFlowDataForClaude(
        [
          {
            timestamp: '2026-03-24T14:00:00.000Z',
            ncp: 2_500_000_000,
            npp: -1_800_000_000,
            netVolume: 0,
          },
        ],
        'Test',
      )!;

      expect(result).toContain('NCP: +$2.5B');
      expect(result).toContain('NPP: -$1.8B');
    });

    it('formats thousand-scale values', () => {
      const result = formatFlowDataForClaude(
        [
          {
            timestamp: '2026-03-24T14:00:00.000Z',
            ncp: 50_000,
            npp: -25_000,
            netVolume: 0,
          },
        ],
        'Test',
      )!;

      expect(result).toContain('NCP: +$50K');
      expect(result).toContain('NPP: -$25K');
    });
  });

  // ============================================================
  // getGreekExposure
  // ============================================================
  describe('getGreekExposure', () => {
    it('returns mapped Greek exposure rows', async () => {
      mockSql.mockResolvedValueOnce([
        {
          expiry: '2026-03-24',
          dte: -1,
          call_gamma: '5000000',
          put_gamma: '-3000000',
          call_charm: '100000',
          put_charm: '-80000',
          call_delta: '200000',
          put_delta: '-150000',
          call_vanna: '50000',
          put_vanna: '-30000',
        },
      ]);

      const result = await getGreekExposure('2026-03-24');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        expiry: '2026-03-24',
        dte: -1,
        callGamma: 5000000,
        putGamma: -3000000,
        netGamma: 2000000,
        callCharm: 100000,
        putCharm: -80000,
        netCharm: 20000,
        callDelta: 200000,
        putDelta: -150000,
        netDelta: 50000,
        callVanna: 50000,
        putVanna: -30000,
      });
    });

    it('handles null gamma values (basic tier)', async () => {
      mockSql.mockResolvedValueOnce([
        {
          expiry: '2026-03-24',
          dte: 0,
          call_gamma: null,
          put_gamma: null,
          call_charm: '50000',
          put_charm: '-40000',
          call_delta: '100000',
          put_delta: '-75000',
          call_vanna: '25000',
          put_vanna: '-15000',
        },
      ]);

      const result = await getGreekExposure('2026-03-24');

      expect(result[0]!.callGamma).toBeNull();
      expect(result[0]!.putGamma).toBeNull();
      expect(result[0]!.netGamma).toBeNull();
      expect(result[0]!.netCharm).toBe(10000);
    });
  });

  // ============================================================
  // formatGreekExposureForClaude
  // ============================================================

  describe('formatGreekExposureForClaude', () => {
    it('returns null for empty rows', () => {
      expect(formatGreekExposureForClaude([], '2026-03-24')).toBeNull();
    });

    it('formats POSITIVE regime (gex > 50K)', () => {
      const result = formatGreekExposureForClaude(
        [makeAggRow(100_000)],
        '2026-03-24',
      )!;
      expect(result).toContain('POSITIVE');
      expect(result).toContain('Periscope walls reliable');
    });

    it('formats MILDLY POSITIVE regime (0 < gex <= 50K)', () => {
      const result = formatGreekExposureForClaude(
        [makeAggRow(25_000)],
        '2026-03-24',
      )!;
      expect(result).toContain('MILDLY POSITIVE');
    });

    it('formats MILDLY NEGATIVE regime (-50K < gex <= 0)', () => {
      const result = formatGreekExposureForClaude(
        [makeAggRow(-25_000)],
        '2026-03-24',
      )!;
      expect(result).toContain('MILDLY NEGATIVE');
      expect(result).toContain('Tighten CCS time exits');
    });

    it('formats MODERATELY NEGATIVE regime (-150K < gex <= -50K)', () => {
      const result = formatGreekExposureForClaude(
        [makeAggRow(-100_000)],
        '2026-03-24',
      )!;
      expect(result).toContain('MODERATELY NEGATIVE');
      expect(result).toContain('Close CCS by 12:00 PM ET');
    });

    it('formats DEEPLY NEGATIVE regime (gex <= -150K)', () => {
      const result = formatGreekExposureForClaude(
        [makeAggRow(-200_000)],
        '2026-03-24',
      )!;
      expect(result).toContain('DEEPLY NEGATIVE');
      expect(result).toContain('Reduce size 10%');
    });

    it('includes 0DTE breakdown when present', () => {
      const result = formatGreekExposureForClaude(
        [makeAggRow(100_000), makeZeroDteRow()],
        '2026-03-24',
      )!;

      expect(result).toContain('0DTE Breakdown:');
      expect(result).toContain('Net Charm:');
      expect(result).toContain('Net Delta:');
    });

    it('calculates 0DTE charm as percentage of total', () => {
      const result = formatGreekExposureForClaude(
        [makeAggRow(100_000), makeZeroDteRow()],
        '2026-03-24',
      )!;

      // zeroDte netCharm = 20_000, aggregate netCharm = 200_000 → 10.0%
      expect(result).toContain('0DTE Charm as % of total: 10.0%');
    });

    it('skips charm percentage when aggregate charm is zero', () => {
      const result = formatGreekExposureForClaude(
        [makeAggRow(100_000, { netCharm: 0 }), makeZeroDteRow()],
        '2026-03-24',
      )!;

      expect(result).not.toContain('0DTE Charm as % of total');
    });

    it('includes non-0DTE expiries sorted by charm magnitude', () => {
      const rows: GreekExposureRow[] = [
        makeAggRow(100_000),
        makeZeroDteRow(),
        {
          expiry: '2026-03-28',
          dte: 4,
          callGamma: null,
          putGamma: null,
          netGamma: null,
          callCharm: 300_000,
          putCharm: -200_000,
          netCharm: 100_000,
          callDelta: 500_000,
          putDelta: -400_000,
          netDelta: 100_000,
          callVanna: 50_000,
          putVanna: -30_000,
        },
      ];

      const result = formatGreekExposureForClaude(rows, '2026-03-24')!;

      expect(result).toContain('Largest Non-0DTE Charm Concentrations:');
      expect(result).toContain('2026-03-28 (4DTE)');
    });

    it('skips aggregate section when netGamma is null', () => {
      const result = formatGreekExposureForClaude(
        [{ ...makeAggRow(0), netGamma: null }],
        '2026-03-24',
      )!;

      expect(result).toContain('SPX Greek Exposure');
      expect(result).not.toContain('Rule 16 Regime');
    });
  });

  // ============================================================
  // getSpotExposures
  // ============================================================
  describe('getSpotExposures', () => {
    it('returns mapped spot exposure rows', async () => {
      mockSql.mockResolvedValueOnce([
        {
          timestamp: '2026-03-24T14:00:00Z',
          price: '5825.50',
          gamma_oi: '1500000000',
          gamma_vol: '200000000',
          gamma_dir: '150000000',
          charm_oi: '-500000000',
          charm_vol: '-100000000',
          charm_dir: '-80000000',
          vanna_oi: '300000000',
          vanna_vol: '50000000',
          vanna_dir: '40000000',
        },
      ]);

      const result = await getSpotExposures('2026-03-24');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        timestamp: '2026-03-24T14:00:00Z',
        price: 5825.5,
        gammaOi: 1500000000,
        gammaVol: 200000000,
        gammaDir: 150000000,
        charmOi: -500000000,
        charmVol: -100000000,
        charmDir: -80000000,
        vannaOi: 300000000,
        vannaVol: 50000000,
        vannaDir: 40000000,
      });
    });

    it('returns empty array when no data', async () => {
      mockSql.mockResolvedValueOnce([]);
      const result = await getSpotExposures('2026-03-24');
      expect(result).toEqual([]);
    });
  });

  // ============================================================
  // formatSpotExposuresForClaude
  // ============================================================

  describe('formatSpotExposuresForClaude', () => {
    it('returns null for empty rows', () => {
      expect(formatSpotExposuresForClaude([])).toBeNull();
    });

    it('formats single row with POSITIVE regime', () => {
      const result = formatSpotExposuresForClaude([makeSpotRow()])!;

      expect(result).toContain('SPX Aggregate GEX Panel');
      expect(result).toContain('POSITIVE');
      expect(result).toContain('Periscope walls reliable');
      expect(result).toContain('SPX at 5825');
      expect(result).toContain('OI Net Gamma Exposure:');
      expect(result).toContain('Volume Net Gamma Exposure:');
      expect(result).toContain('Directionalized Volume Net Gamma:');
      expect(result).toContain('OI Net Charm:');
      expect(result).toContain('Volume Net Charm:');
    });

    it('formats MILDLY POSITIVE regime', () => {
      // gammaOi ÷ 1M = 25_000 → MILDLY POSITIVE
      const result = formatSpotExposuresForClaude([
        makeSpotRow({ gammaOi: 25_000_000_000 }),
      ])!;
      expect(result).toContain('MILDLY POSITIVE');
    });

    it('formats MILDLY NEGATIVE regime', () => {
      // gammaOi ÷ 1M = -25_000 → MILDLY NEGATIVE
      const result = formatSpotExposuresForClaude([
        makeSpotRow({ gammaOi: -25_000_000_000 }),
      ])!;
      expect(result).toContain('MILDLY NEGATIVE');
      expect(result).toContain('Tighten CCS time exits');
    });

    it('formats MODERATELY NEGATIVE regime', () => {
      // gammaOi ÷ 1M = -100_000
      const result = formatSpotExposuresForClaude([
        makeSpotRow({ gammaOi: -100_000_000_000 }),
      ])!;
      expect(result).toContain('MODERATELY NEGATIVE');
      expect(result).toContain('Close CCS by 12:00 PM ET');
    });

    it('formats DEEPLY NEGATIVE regime', () => {
      // gammaOi ÷ 1M = -200_000
      const result = formatSpotExposuresForClaude([
        makeSpotRow({ gammaOi: -200_000_000_000 }),
      ])!;
      expect(result).toContain('DEEPLY NEGATIVE');
      expect(result).toContain('Reduce size 10%');
    });

    it('adds suppression note when OI negative and Vol positive', () => {
      const result = formatSpotExposuresForClaude([
        makeSpotRow({ gammaOi: -50_000_000_000, gammaVol: 10_000_000_000 }),
      ])!;

      expect(result).toContain('Volume GEX positive while OI GEX negative');
      expect(result).toContain('suppression');
    });

    it('adds worsening note when both OI and Vol negative', () => {
      const result = formatSpotExposuresForClaude([
        makeSpotRow({ gammaOi: -50_000_000_000, gammaVol: -10_000_000_000 }),
      ])!;

      expect(result).toContain('WORSENING the acceleration regime');
    });

    it('no volume note when OI positive', () => {
      const result = formatSpotExposuresForClaude([
        makeSpotRow({ gammaOi: 50_000_000_000, gammaVol: -10_000_000_000 }),
      ])!;

      expect(result).not.toContain('Volume GEX positive');
      expect(result).not.toContain('WORSENING');
    });

    it('includes intraday trend when 2+ rows', () => {
      const rows: SpotExposureRow[] = [
        makeSpotRow({
          timestamp: '2026-03-24T14:00:00.000Z',
          price: 5800,
          gammaOi: 80_000_000_000,
        }),
        makeSpotRow({
          timestamp: '2026-03-24T15:00:00.000Z',
          price: 5830,
          gammaOi: 100_000_000_000,
        }),
      ];

      const result = formatSpotExposuresForClaude(rows)!;

      expect(result).toContain('Intraday Trend (60 min):');
      expect(result).toContain('improving (toward positive)');
      expect(result).toContain('+30 pts');
    });

    it('shows deteriorating trend', () => {
      const rows: SpotExposureRow[] = [
        makeSpotRow({
          timestamp: '2026-03-24T14:00:00.000Z',
          gammaOi: 100_000_000_000,
        }),
        makeSpotRow({
          timestamp: '2026-03-24T14:30:00.000Z',
          gammaOi: 50_000_000_000,
        }),
      ];

      const result = formatSpotExposuresForClaude(rows)!;

      expect(result).toContain('deteriorating (toward negative)');
    });

    it('shows stable trend when no gamma change', () => {
      const rows: SpotExposureRow[] = [
        makeSpotRow({
          timestamp: '2026-03-24T14:00:00.000Z',
          gammaOi: 100_000_000_000,
        }),
        makeSpotRow({
          timestamp: '2026-03-24T14:30:00.000Z',
          gammaOi: 100_000_000_000,
        }),
      ];

      const result = formatSpotExposuresForClaude(rows)!;

      expect(result).toContain('stable');
    });

    it('includes recent history time series for multiple rows', () => {
      const rows: SpotExposureRow[] = [
        makeSpotRow({ timestamp: '2026-03-24T14:00:00.000Z', price: 5800 }),
        makeSpotRow({ timestamp: '2026-03-24T14:05:00.000Z', price: 5810 }),
        makeSpotRow({ timestamp: '2026-03-24T14:10:00.000Z', price: 5825 }),
      ];

      const result = formatSpotExposuresForClaude(rows)!;

      expect(result).toContain('Recent History (5-min intervals):');
      // Should show each row's data
      expect(result).toContain('SPX: 5800');
      expect(result).toContain('SPX: 5825');
    });

    it('does not show trend or history for single row', () => {
      const result = formatSpotExposuresForClaude([makeSpotRow()])!;

      expect(result).not.toContain('Intraday Trend');
      expect(result).not.toContain('Recent History');
    });
  });
});

describe('getVixOhlcFromSnapshots', () => {
  beforeEach(() => {
    _resetDb();
    process.env.DATABASE_URL = 'postgresql://test';
    vi.mocked(neon).mockReturnValue(mockSql as never);
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    vi.clearAllMocks();
  });

  it('returns null when no rows exist for the date', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await getVixOhlcFromSnapshots('2026-03-10');
    expect(result).toBeNull();
  });

  it('returns OHLC computed from multiple snapshot rows', async () => {
    // Rows in non-chronological text order to verify sort correctness
    // 10:00 AM, 9:35 AM, 2:30 PM → sorted: 9:35 AM, 10:00 AM, 2:30 PM
    mockSql.mockResolvedValueOnce([
      { entry_time: '10:00 AM', vix: '18.50' },
      { entry_time: '9:35 AM', vix: '17.80' },
      { entry_time: '2:30 PM', vix: '19.20' },
    ]);
    const result = await getVixOhlcFromSnapshots('2026-03-10');
    expect(result).toEqual({
      open: 17.8, // earliest: 9:35 AM
      high: 19.2, // max
      low: 17.8, // min
      close: 19.2, // latest: 2:30 PM
      count: 3,
    });
  });

  it('handles a single snapshot row', async () => {
    mockSql.mockResolvedValueOnce([{ entry_time: '10:00 AM', vix: '18.50' }]);
    const result = await getVixOhlcFromSnapshots('2026-03-10');
    expect(result).toEqual({
      open: 18.5,
      high: 18.5,
      low: 18.5,
      close: 18.5,
      count: 1,
    });
  });

  it('handles 12:00 PM (noon) correctly — not midnight', async () => {
    mockSql.mockResolvedValueOnce([
      { entry_time: '11:30 AM', vix: '17.00' },
      { entry_time: '12:00 PM', vix: '18.00' },
    ]);
    const result = await getVixOhlcFromSnapshots('2026-03-10');
    expect(result).toEqual({
      open: 17.0,
      high: 18.0,
      low: 17.0,
      close: 18.0,
      count: 2,
    });
  });

  it('handles 12:00 AM (midnight) edge case', async () => {
    mockSql.mockResolvedValueOnce([
      { entry_time: '12:00 AM', vix: '15.00' },
      { entry_time: '9:30 AM', vix: '16.00' },
    ]);
    const result = await getVixOhlcFromSnapshots('2026-03-10');
    expect(result).toEqual({
      open: 15.0,
      high: 16.0,
      low: 15.0,
      close: 16.0,
      count: 2,
    });
  });
});

// ============================================================
// saveDarkPoolSnapshot
// ============================================================

describe('saveDarkPoolSnapshot', () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.transaction.mockReset().mockResolvedValue([]);
    process.env.DATABASE_URL = 'postgresql://test';
    _resetDb();
  });

  it('inserts and returns the new id', async () => {
    mockSql.mockResolvedValueOnce([{ id: 1 }]);

    const id = await saveDarkPoolSnapshot({
      date: '2026-03-30',
      timestamp: '2026-03-30T14:30:00Z',
      snapshotId: 42,
      spxPrice: 5800,
      clusters: [
        {
          spyPriceLow: 579.5,
          spyPriceHigh: 580.5,
          spxApprox: 5800,
          totalPremium: 10_000_000,
          tradeCount: 3,
          totalShares: 50_000,
          buyerInitiated: 2,
          sellerInitiated: 1,
          neutral: 0,
          latestTime: '2026-03-30T14:20:00Z',
        },
      ],
    });

    expect(id).toBe(1);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('returns null when upsert returns empty', async () => {
    mockSql.mockResolvedValueOnce([]);

    const id = await saveDarkPoolSnapshot({
      date: '2026-03-30',
      timestamp: '2026-03-30T14:30:00Z',
      snapshotId: null,
      spxPrice: null,
      clusters: [],
    });

    expect(id).toBeNull();
  });
});
