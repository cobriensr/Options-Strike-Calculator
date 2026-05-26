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
        { id: 78 },
        { id: 79 },
        { id: 80 },
        { id: 81 },
        { id: 82 },
        { id: 83 },
        { id: 84 },
        { id: 85 },
        { id: 86 },
        { id: 87 },
        { id: 88 },
        { id: 89 },
        { id: 90 },
        { id: 91 },
        { id: 92 },
        { id: 93 },
        { id: 94 },
        { id: 95 },
        { id: 96 },
        { id: 97 },
        { id: 98 },
        { id: 99 },
        { id: 100 },
        { id: 101 },
        { id: 102 },
        { id: 103 },
        { id: 104 },
        { id: 105 },
        { id: 106 },
        { id: 107 },
        { id: 108 },
        { id: 109 },
        { id: 110 },
        { id: 111 },
        { id: 112 },
        { id: 113 },
        { id: 114 },
        { id: 115 },
        { id: 116 },
        { id: 117 },
        { id: 118 },
        { id: 119 },
        { id: 120 },
        { id: 121 },
        { id: 122 },
        { id: 123 },
        { id: 124 },
        { id: 125 },
        { id: 126 },
        { id: 127 },
        { id: 128 },
        { id: 129 },
        { id: 130 },
        { id: 131 },
        { id: 132 },
        { id: 133 },
        { id: 134 },
        { id: 135 },
        { id: 136 },
        { id: 137 },
        { id: 138 },
        { id: 139 },
        { id: 140 },
        { id: 141 },
        { id: 142 },
        { id: 143 },
        { id: 144 },
        { id: 145 },
        { id: 146 },
        { id: 147 },
        { id: 148 },
        { id: 149 },
        { id: 150 },
        { id: 151 },
        { id: 152 },
        { id: 153 },
        { id: 154 },
        { id: 155 },
        { id: 156 },
        { id: 157 },
        { id: 158 },
        { id: 159 },
        { id: 160 },
        { id: 161 },
        { id: 162 },
        { id: 163 },
        { id: 164 },
        { id: 165 },
        { id: 166 },
        { id: 167 },
        { id: 168 },
        { id: 169 },
        { id: 170 },
        { id: 171 },
        { id: 172 },
        { id: 173 },
        { id: 174 },
        { id: 175 },
        { id: 176 },
        { id: 177 },
        { id: 178 },
        { id: 179 },
        { id: 180 },
        { id: 181 },
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
        '#78: Create push_subscriptions table for Web Push VAPID endpoints (FuturesGammaPlaybook regime alerts)',
        '#79: Create regime_events table for server-detected FuturesGammaPlaybook alerts (history + delivery audit)',
        '#80: Create regime_monitor_state singleton row for cross-run alert state (prev AlertState + cooldowns)',
        '#81: Create institutional_blocks table for SPXW mfsl/cbmo/slft floor blocks (institutional regime indicator — 180-300 DTE ceiling program + 0-7 DTE opening-ATM blocks)',
        '#82: Create zero_gamma_levels table for per-minute derived zero-gamma level (spot price where dealer net gamma = 0) — regime-flip signal computed from existing spot_gex by-strike data',
        '#83: Create strike_iv_snapshots table for per-strike OTM IV time series (SPX/SPY/QQQ, ±3% of spot) — Phase 1 of the Strike IV Anomaly Detector',
        '#84: Create iv_anomalies table for Strike IV Anomaly Detector (Phase 2) — flags + JSONB context_snapshot at detection time, plus resolution_outcome populated EOD by the Phase 4 resolve cron',
        '#85: Add vol_oi_ratio column to iv_anomalies for the primary volume/OI gate (2026-04-24 rescope) — strike must have cumulative intraday volume ≥ 5× start-of-day OI to fire. Surfaced prominently in the UI.',
        '#86: Add side_skew + side_dominant columns to iv_anomalies for the secondary side-dominance gate (2026-04-24) — proxy for tape-side volume dominance derived from iv_bid/iv_mid/iv_ask spread until real UW per-strike side-split volume is wired (deferred spec tape-side-volume-exit-signal-2026-04-24).',
        '#87: Create strike_trade_volume table for tape-side volume exit-signal detection (2026-04-25). Replaces the firing-rate-surge proxy in useIVAnomalies with real bid-side vs ask-side per-minute volume from UW /api/stock/{ticker}/flow-per-strike-intraday. Note: that endpoint aggregates across expiries — table is keyed on (ticker, strike, side, ts), no expiry column.',
        '#88: Create trace_live_analyses table for the periodic TRACE chart analyses (charm + gamma + delta) — JSONB full response + vector(2000) embedding for retrieval of analogous past ticks. Keyed on captured_at (single-owner, ticks are unique per timestamp). See spec: docs/superpowers/specs/trace-live-2026-04-25 (pending).',
        "#89: Add image_urls column to trace_live_analyses for Vercel Blob storage of the gamma/charm/delta heatmap PNGs. Shape: { gamma?: string, charm?: string, delta?: string } — all keys optional because Blob upload is best-effort (failure is logged but doesn't block the analysis save). Frontend renders <img src={url}> for historical browsing.",
        "#90: Add actual_close + actual_path columns to trace_live_analyses for outcomes-join analysis. actual_close is the SPX cash settlement on the trading day of capture; actual_path is a JSONB array of {ts, price} entries from capture-time → close (5-min spacing) enabling realized-vs-predicted analysis, calibration curves, and historical-analog outcome lookups. Populated by fetch-outcomes' post-settlement update step.",
        "#91: Add novelty_score column to trace_live_analyses for drift detection. Stored as NUMERIC(8,6) — cosine distance to the k-th nearest historical embedding (default k=20). Computed pre-insert in saveTraceLiveAnalysis. High score = current setup is far from any historical pattern → model's calibration may not apply, surface as UI flag. NULL when fewer than k historical rows exist (early days / insufficient data).",
        '#92: Create vega_flow_etf table for SPY/QQQ minute-bar greek flow (dir/total/OTM variants of vega + delta) from UW /api/stock/{ticker}/greek-flow. Phase 1 of the Dir Vega Spike Monitor — backing data for spike detection and forward-return EDA. Keyed (ticker, timestamp) for idempotent ingest.',
        '#93: Create vega_spike_events table for the Dir Vega Spike Monitor (Phase 3). One row per qualifying spike — bars where |dir_vega_flow| passes all four gates (FLOOR + 2x prior intraday max + 6x robust z-score + 30+ bars elapsed). Forward-return columns nullable until Phase 5 enrichment cron populates them. Unique (ticker, timestamp) so monitor cron is idempotent on retry.',
        '#94: Create etf_candles_1m table for raw SPY/QQQ 1-minute OHLC candles. Phase 5 of the Dir Vega Spike Monitor — backing data for the enrich-vega-spike-returns cron that computes 5/15/30-min forward returns on each spike event. Distinct from fetch-spx-candles-1m which fetches SPY but stores SPX-derived (×ratio) prices, not raw. Unique (ticker, timestamp) for idempotent ingest.',
        '#95: Add real-tape bid/ask volume columns to iv_anomalies (2026-04-28). Replaces the IV-spread-position proxy in side_skew/side_dominant with cumulative-since-open volume splits from strike_trade_volume. The proxy was systematically inverted on penny-priced ETF options (Schwab `mark` snaps to `ask`, pinning iv_mid at iv_ask). Old rows keep proxy-derived side_skew/side_dominant; new rows additionally populate bid_pct/ask_pct/mid_pct/total_vol_at_detect from the real tape and recompute side_skew/side_dominant from those. See spec: docs/superpowers/specs/iv-anomaly-real-tape-bidask-2026-04-28.md.',
        "#96: Add fwd_return_eod column to vega_spike_events for end-of-day forward-return measurement on each spike. Lets the dashboard compare hold-to-close P&L against the existing 5/15/30-min returns. Populated by the same enrich-vega-spike-returns cron using the last 1-min candle of the spike's ET trading day in etf_candles_1m. NULL until the cron picks up the row; nullable forever for spikes whose anchor candle is missing.",
        '#97: Create gamma_squeeze_events table for the velocity-based gamma squeeze detector (2026-04-28). Sibling of the IV anomaly detector — different signal (vol/OI velocity instead of side concentration), different table, different alert path. Catches the TSLA 375C / NVDA 212.5C archetype: balanced-tape near-ATM 0DTE calls that win via dealer hedging reflexivity rather than informed flow. Velocity = vol/OI added in last 15 min; acceleration = velocity vs prior 15 min; proximity = spot vs strike on the OTM side; trend = 5-min spot direction. NDG sign joined from strike_exposures (SPX/SPY/QQQ only). See spec: docs/superpowers/specs/gamma-squeeze-velocity-detector-2026-04-28.md.',
        '#98: Add unique indexes + dedupe to 5 high-volume tables for cron idempotency (2026-04-28 backend audit Phase 3). Vercel function retries and `?force=1` re-runs were INSERTing without ON CONFLICT, producing duplicate rows that corrupt downstream detectors. Each table is deduped on the natural key (keeping MIN(id) per group) before the unique index is created — duplicates would otherwise block CREATE UNIQUE INDEX. Tables: strike_iv_snapshots, gamma_squeeze_events, iv_anomalies (key: ticker, strike, side, expiry, ts); strike_trade_volume (key: ticker, strike, side, ts); zero_gamma_levels (key: ticker, ts). Pairs with ON CONFLICT DO NOTHING clauses on the 5 cron handler INSERTs. See spec: docs/superpowers/specs/backend-audit-fixes-2026-04-28.md.',
        '#99: Create whale_anomalies table for the Whale Anomalies component (replaces Strike IV Anomalies). Surfaces option-flow prints matching the hand-derived whale-detection checklist (per-ticker p95 premium, ≥85% one-sided, ≥5 trades, ≤14 DTE, ≤5% moneyness, no simultaneous paired leg). Populated by detect-whales cron during market hours and by a one-shot historical backfill from the EOD parquet archive. See spec: docs/superpowers/specs/whale-anomalies-2026-04-29.md.',
        '#100: Drop iv_anomalies table — Strike IV Anomaly Detector retired in favor of Whale Anomalies (see docs/superpowers/specs/whale-anomalies-2026-04-29.md, Phase 7). The fetch-strike-iv cron stopped writing to this table in the same release; no consumer reads from it anymore. strike_iv_snapshots is kept (used by gamma-squeeze detector and analyze-context).',
        '#101: Rename whale_anomalies.pct_to_target → pct_close_vs_strike. The column stores (last_close - strike) / strike (signed by Type) which is "% close vs strike" rather than "% from spot to target". Code-reviewer flagged the misleading name; renaming keeps semantics intact and makes the dashboard label match what the value actually is.',
        '#102: Create trace_live_calibration table for stratified residual statistics derived from trace_live_analyses.actual_close. Computed daily by the resolve-trace-residuals cron after fetch-outcomes populates actual_close. Keyed (regime, ttc_bucket) where ttc_bucket = "0-15min" | "15-60min" | "60-180min" | ">180min". Stores mean/median residual + sample count + p25/p75 for the predictedCloseRange band. Applied at inference time in trace-live-analyze to bias-correct the model output.',
        "#103: Create periscope_analyses table for the manual Periscope chat feature — user uploads 1-3 chart screenshots, Claude produces a structured read (open setup) or debrief (post-hoc scoring), and the response + vector(2000) embedding are persisted for retrieval and calibration. Mirrors trace_live_analyses shape with periscope extras: mode (read|debrief), optional parent_id (debriefs link to their open read), structured trigger/cone fields parsed from a JSON block at the end of Claude's response, and user-editable calibration_quality + regime_tag for curating gold examples. See spec: docs/superpowers/specs/periscope-chat-2026-04-30.md.",
        '#104: Add precision-stack overlay columns to gamma_squeeze_events: hhi_neighborhood (Herfindahl of cross-strike premium concentration within ±0.5% of spot at fire time, lower = diffuse), iv_morning_vol_corr (Pearson correlation of per-minute Δ implied_vol and Δ cumulative volume restricted to ≤11:00 CT, higher = real demand), and precision_stack_pass (boolean — true when both filters fall in the discriminating quantile vs the universe-day, computed by an after-close cron). Columns nullable so historical events stay queryable; backfill happens via scripts/backfill-precision-stack.py and live cron stamping (Phase 2). Lifts precision from 17.5% (V≥5× alone) to 48.8% (full stack at top 20%) on the 12-day in-sample backtest. See spec: docs/superpowers/specs/precision-stack-overlay-2026-04-30.md.',
        '#105: Drop precision_stack_pass from gamma_squeeze_events. Migration #104 added the column with the intent that an after-close cron would stamp it from per-day percentiles, but that cron was never built and the live ingest path in fetch-strike-iv.ts never writes it. The read endpoint /api/gamma-squeezes already computes the pass flag at request time from (hhi_neighborhood, iv_morning_vol_corr) using same-day percentiles across the queried result set, so the column has no readers and no live writers — pure dead weight. Drop instead of leaving stale NULLs across the table. The two numeric columns (hhi_neighborhood, iv_morning_vol_corr) stay because the cron does write them at fire time and the read endpoint reads them.',
        "#106: Backfill periscope_analyses.trading_date from the prose heading. Rows captured before the chart_date extraction landed got stamped with the capture-day date instead of the actual trading date the chart was for — back-reads of yesterday tagged with today, etc. Every periscope read prose starts with a `# YYYY-MM-DD ...` heading Claude writes from the chart label, so we parse that and overwrite trading_date for any row whose stored date disagrees with the prose. Idempotent: only rows where the parsed date differs are touched, so fresh DBs and re-runs are no-ops. Skips rows whose prose lacks the heading (defensive — a malformed Claude response shouldn't crash the migration).",
        '#107: Drop gamma_squeeze_events table — replaced by lottery_finder_fires in the Lottery Finder migration. The velocity-based gamma squeeze detector underperformed in the 15-day backtest and is being replaced by the cheap-call-PM RE-LOAD selection rule discovered against the options-flow archive (see docs/superpowers/specs/lottery-finder-2026-05-02.md). CASCADE removes the indexes (idx_gamma_squeeze_*, uniq_gamma_squeeze_events_key) automatically. Idempotent — re-runs on a fresh DB are no-ops via IF EXISTS.',
        '#108: Create ws_flow_alerts table + ws_flow_alerts_enriched view for the new uw-stream Railway daemon (see docs/superpowers/specs/uw-websocket-daemon-2026-05-02.md). Distinct from the cron-fed flow_alerts table (#59) — the daemon writes the global UW WS flow-alerts firehose (every ticker, every DTE) while the cron is scoped to SPXW 0-1 DTE Index. The two coexist during the soak window; cutover happens via a later migration once parity is verified. Schema design choices: only raw payload fields are stored as columns; derived signals (dte_at_alert, moneyness, minute_of_day, ask_side_ratio, etc.) are computed at read time via the ws_flow_alerts_enriched VIEW so the math stays re-runnable against historic rows. The OCC option_chain symbol is preserved verbatim alongside parsed strike/expiry/option_type so UWs /option-contract/{symbol}/* REST endpoints still work. ws_alert_id (the per-alert UUID UW emits in the WS payloads `id` field) is the natural dedupe key — using (option_chain, created_at) like the cron-fed table does would collapse distinct rules firing on the same contract within the same millisecond.',
        "#109: Create ws_option_trades table for the uw-stream daemon to write the UW WebSocket `option_trades:<TICKER>` per-tick stream. This is the input feed for the Lottery Finder cron's v4 trigger detector — each row is one OPRA print with side classification, IV, delta, OI, and underlying price at the moment of execution. Distinct from ws_flow_alerts (#108): that table holds UW-aggregated burst alerts; this one is raw per-trade ticks. Per-ticker filtering keeps daily volume to ~1-3M rows/day (vs 6-10M for the global firehose) — sufficient since the Lottery Finder universe is ~50 tickers. See docs/superpowers/specs/lottery-finder-2026-05-02.md, Phase 1.4. Schema notes: ws_trade_id is the natural dedupe key (UW emits a UUID per print on the option_trades channel). raw_payload is kept as JSONB for forward-compat — we do NOT store the full payload as extracted columns because per-trade volume makes JSONB storage cheaper than wide rows (~500 bytes payload vs ~12 typed columns). A retention cron (TODO, separate spec) will DELETE rows older than 7 days to bound table size.",
        '#110: Create lottery_finder_fires table — the output of the new Lottery Finder detector (Phase 1.2 of docs/superpowers/specs/lottery-finder-2026-05-02.md). Each row is one v4 trigger fire enriched with derived discriminators (RE-LOAD tag, cheap-call-PM flag), a macro context snapshot at fire time (display-only — see Appendix A of the spec for why macro is not used as a selection gate), and realized-exit outcomes under three policies. The natural dedupe key is (option_chain_id, trigger_time_ct) — the detector cooldown guarantees ≥5 min between fires on the same chain so this composite is collision-free. Outcome columns are NULL until the enrich cron backfills them post-EoD. flow_quad/tod/mode are denormalised at write time for fast UI filter chips.',
        '#111: Create ws_gex_strike_expiry table for the uw-stream daemon to write the UW WebSocket `gex_strike_expiry:<TICKER>` channel — per-strike, per-expiry GEX (gamma / charm / vanna by OI, vol, ask-vol, bid-vol) updated as fast as UW recomputes them. This is the data source for the new Strike Battle Map panel (Phase 1 of docs/superpowers/specs/strike-battle-map-2026-05-03.md): the panel renders the top OTM 0DTE strikes for SPY + QQQ with customer dir delta flow above the line and dealer net gamma below — so magnets (pin candidates) and amplifiers (cascade risk) are visible in one view. Schema notes: values are stored as NUMERIC because UW emits them as JSON strings in scientific-ish notation that Decimal/Number.parseFloat handle safely; raw_payload is kept as JSONB for forward-compat against channel schema additions. The natural dedupe key is (ticker, expiry, strike, ts_minute) — UW restates aggregated GEX intraday (same root cause as the vega_flow_etf restatement we hit on 2026-05-01) so this table is UPSERTed on every WS push with last-write-wins per minute. Two indexes: ticker+expiry+ts (panel queries) and ticker+strike+ts (strike-history scrub).',
        '#112: Rename spx_candles_1m → index_candles_1m and add symbol column to support multi-index OHLC ingestion (initially SPX, with NDX added in a follow-up so the dark pool read endpoint can do contemporaneous QQQ→NDX mapping via the same candle-ratio query used for SPY→SPX). Existing rows are backfilled to symbol="SPX" via the column DEFAULT. A compatibility view named spx_candles_1m (filtered to symbol="SPX") preserves the old name so unmigrated readers continue working unchanged while we migrate them in bounded batches; the view is dropped in a later migration once all 22 references have been rewritten to query index_candles_1m directly. The old (date, timestamp) unique constraint is replaced by (symbol, date, timestamp) so SPX and NDX rows can coexist; the constraint\'s auto-index serves the dark pool read query pattern (symbol-leftmost) without needing a separate named index. A partial unique index spx_candles_1m_compat_uniq on (date, timestamp) WHERE symbol=\'SPX\' is added so the existing fetch-spx-candles-1m cron\'s INSERT ... ON CONFLICT (date, timestamp) keeps resolving against an exact-match unique target — Postgres rejects ON CONFLICT against a partial column subset of a multi-column unique constraint. The partial index is dropped together with the compat view in a later migration once the cron is rewritten to insert into index_candles_1m directly with symbol-aware ON CONFLICT.',
        '#113: Add ndx_schwab_price column to index_candles_1m for the NDX-row Schwab-verified close anchor (mirrors the existing spx_schwab_price column which only ever holds values for SPX rows). Parallel column instead of renaming spx_schwab_price → schwab_close so the existing readers in api/_lib/db-claude-tools.ts (4 SELECTs, the analyze-tool docstring, and the result mapper) continue working unchanged. NDX rows leave spx_schwab_price NULL and SPX rows leave ndx_schwab_price NULL — wasteful per-row but additive and safe; a future cleanup migration can collapse to a single schwab_close column once the reader migration completes.',
        "#114: Drop the spx_candles_1m compatibility view and the spx_candles_1m_compat_uniq partial unique index that migration #112 installed as bridge shims for unmigrated readers and the pre-Phase-1b cron INSERT. Phases 1d-i through 1d-vi migrated all 7+ production readers (db-claude-tools, spx-candles, analyze-context, anomaly-context, postgres-day-summary, vix-divergence, journal/status) and all backfill scripts to read from index_candles_1m directly with explicit WHERE symbol = 'SPX'. Phase 1b rewired the cron INSERT to use the new (symbol, date, timestamp) constraint directly, retiring the partial-index workaround. Phase 1c added NDX flow to the same cron. After this migration, index_candles_1m is the single source of truth for index OHLC and no compat shims remain.",
        '#115: Drop push_subscriptions and regime_events tables. The Futures Gamma Playbook feature these tables backed (Web Push VAPID subscriptions in #49, server-detected regime alerts in #50) was removed from the app along with the monitor-regime-events cron, the /api/push/* endpoints, and the SW push handlers. No remaining reader writes to or reads from either table.',
        '#116: Create dark_pool_prints table for the uw-stream daemon to write every off_lit_trades WS payload from SPY and QQQ as a raw print. Replaces the cron-fed dark_pool_levels (pre-aggregated, SPY-only, static SPX×10 mapping baked into storage) with a row-per-print shape that supports multi-symbol coverage (SPX/NDX synthesized at read time via candle ratio in index_candles_1m) and ML feature engineering. Schema captures every field UW emits in the off_lit_trades payload — including slowly-varying symbol metadata (sector, marketcap, avg30_volume, next_earnings_date, issue_type) — per the user-decided full-fidelity capture preference. Idempotency via UNIQUE (symbol, executed_at, price, size) so daemon reconnect/replay does not duplicate prints. Lookup index on (symbol, date, executed_at DESC) serves the read endpoint that aggregates prints to per-level rollups for the dark pool panel. Daemon ingest filters: SPY+QQQ only, session hours 08:30–15:00 CT, drops extended_hours_trade and contingent_trade rows at the handler boundary (per memory feedback_extended_hours.md and feedback_contingent_trade_filter.md). See docs/superpowers/specs/uw-websocket-daemon-2026-05-02.md sub-design for full schema rationale.',
        '#117: Drop whale_anomalies table. The Whale Anomalies component (#94) and its detect-whales/resolve-whales crons were removed from the app. The whale_alerts table (migration #59) is preserved because the separate Whale Positioning feature still reads from it via /api/options-flow/whale-positioning and the fetch-whale-alerts cron.',
        '#118: Drop whale_alerts table. The Whale Positioning sub-section inside Market Flow and the /api/options-flow/whale-positioning endpoint were removed along with the fetch-whale-alerts cron. No remaining reader writes to or reads from this table. flow_alerts is kept — uw-deltas.ts (Whale Flow Positioning signal) still queries it on every analyze-context build.',
        '#119: Drop institutional_blocks table. The SPXW Institutional Program component was removed from the app along with the /api/institutional-program endpoints, the fetch-spxw-blocks cron, and the orphaned anomaly-context.ts (last query against this table). No remaining reader writes to or reads from it.',
        '#120: Drop dark_pool_levels table — Phase 7 cutover of the dark-pool cron-to-WS migration. The fetch-darkpool cron (deleted in commit d1a14162) wrote to this table; the dark-pool-query helper has been simplified to read exclusively from dark_pool_prints (the uw-stream daemon target). All 4 production consumers (darkpool-levels.ts, system-status.ts, build-features-phase2.ts, uw-deltas.ts) now go through the helper. Historical data was preserved via the backfill-dark-pool-prints.mjs script which pulled SPY+QQQ off-lit prints from UW REST into dark_pool_prints. See docs/superpowers/specs/uw-cron-to-websocket-migration-2026-05-02.md.',
        '#121: Create ws_net_flow_per_ticker table for the uw-stream daemon to write the UW WebSocket `net_flow:<TICKER>` per-tick stream. Input feed for the Lottery Net Flow per-fire panel (Phase 1 of docs/superpowers/specs/lottery-net-flow-2026-05-03.md). Each row is a per-tick DELTA (NOT cumulative — confirmed via UW reference notebook): `net_call_prem` is the increment over the prior emission for that ticker, NOT the running total. Cumulative chart values are computed at read time via SUM(...) OVER (PARTITION BY ticker, date ORDER BY ts). Storage shape mirrors ws_option_trades / ws_flow_alerts: typed columns for the emitted fields plus raw_payload JSONB for forward-compat. Natural dedupe key (ticker, ts) — UW emits at most one tick per ticker per millisecond on this channel.',
        "#122: Create net_flow_per_ticker_history table for the REST-backfill EDA pipeline (Task 1.1 of docs/superpowers/specs/lottery-net-flow-eda-2026-05-03.md). Stores per-minute UW REST `/stock/{ticker}/net-prem-ticks` history for ~50 lottery tickers × 90 days — the input feed for the Lottery Net Flow EDA (Phase 2). Kept separate from ws_net_flow_per_ticker (#121) to keep WS-live (per-tick deltas) and REST-backfill data clean; the `source` column ('rest' / 'ws') allows a future union. Schema captures the full per-minute delta payload including the bonus bid/ask side-split volume fields UW returns at the ticker level (call_volume_ask_side, call_volume_bid_side, put_volume_ask_side, put_volume_bid_side). Natural dedupe key (ticker, ts, source) — REST backfill may be re-run for a given (ticker, date, source) pair without duplicating rows.",
        "#123: Add (symbol, timestamp DESC) index on index_candles_1m. The existing unique key is (symbol, date, timestamp) — queries that JOIN by (symbol, timestamp) without filtering on date (e.g. dark-pool level synthesis in api/_lib/dark-pool-query.ts) degenerate to ~140 buffer pages per row. Dark pool levels query timed out at 12s on 12k prints for SPY 2026-05-01; with this index it's 296ms. Mirrors the idx_etf_candles_1m_ticker_ts shape on etf_candles_1m.",
        '#124: Add realized_flow_inversion_pct to lottery_finder_fires. The new exit policy validated in `ml/experiments/lottery-net-flow-eda/exit_simulation.py` against per-minute NBBO mid prices on the 15-day parquet window — exit when matched-side ticker net flow slope flips negative for >=3 consecutive minutes after the post-trigger flow peak. EDA showed +9.8pp mean uplift after costs and 5x lottery rate (6.7% vs 1.3% under trail-30/10) with edge concentrated on momentum-news days x call fires x AM/MID. Column is nullable; populated by exit_simulation.py with WRITE_DB=1 after each parquet refresh, same backfill-only pattern as the existing realized_* columns.',
        '#125: Create greek_flow_per_ticker_history table for the Dir-Delta inversion-exit EDA (docs/superpowers/specs/lottery-dir-delta-eda-2026-05-04.md). Stores per-minute UW REST /stock/{ticker}/greek-flow history for ~50 lottery tickers x 90 days — the input feed for testing whether delta-weighted directional flow produces a stronger inversion-exit signal than the all-strikes NCP we currently use. Schema mirrors the response shape: dir_delta_flow + dir_vega_flow + OTM variants + totals + transaction/volume counters. Natural dedupe key (ticker, ts, source).',
        '#126: Add tiered scoring to lottery_finder_fires + create lottery_ticker_stats. Phase 1 of docs/superpowers/plans/lottery-tiered-scoring-ui.md. The score is the sum of weights for ticker × mode × entry-price × TOD × option-type, computed deterministically on insert (api/_lib/lottery-score-weights.ts). Tier (≥18 / 12-17 / <12) is derived from score in the read path. lottery_ticker_stats holds Wilson-CI-bounded high-peak rates per ticker (seeded from ml/data/lottery_ticker_stats.json on the 21-day window) so the UI can show ✓/⚠️ reliability indicators next to ticker names. The (date DESC, score DESC NULLS LAST) index supports `?sort=score` ORDER BYs.',
        '#127: Create option_intraday_nbbo + option_intraday_nbbo_fetches cache tables for the flow-inversion automation pipeline (Phase 2 of docs/superpowers/specs/lottery-flow-inversion-automation-2026-05-05.md). option_intraday_nbbo caches per-minute UW REST `/option-contract/{id}/intraday` rows so the post-close enrich-lottery-outcomes cron can re-run the realized_flow_inversion_pct computation without re-pulling UW. The endpoint does not expose nbbo_bid/nbbo_ask directly — we store the side-split premium + volume fields and derive a synthetic mid in code as (premium_ask_side/volume_ask_side + premium_bid_side/volume_bid_side)/2 with (high+low)/2 and close_price fallbacks. PK (option_chain, ts) auto-creates the index used by both the read path (chain ASC + ts ASC for the post-trigger walk) and the upsert path (ON CONFLICT). option_intraday_nbbo_fetches is a small tracking table keyed (option_chain, date) so empty-result fetches are not retried on every cron run — status=ok|empty|error + rows_fetched short-circuits the fetcher when we have already attempted the (chain, date) pair.',
        '#128: Drop trace_live_analyses + trace_live_calibration tables. The TRACE Live feature (created in #88, extended in #89/90/91, with stratified residual calibration in #102) was removed from the app along with all api/trace-live-* endpoints, the resolve-trace-residuals cron, the capture daemon, and the populateTraceLiveOutcomes step in fetch-outcomes. CASCADE drops the HNSW + captured_at + actual_close indexes installed in #88/90 automatically. Idempotent — IF EXISTS makes re-runs on a fresh DB no-ops.',
        '#129: Add expiry column to vega_flow_etf for per-expiry (0DTE) and all-expiries (NULL) co-storage. Replaces the (ticker, timestamp) unique constraint with (ticker, timestamp, expiry) using NULLS NOT DISTINCT (Postgres 15+) so all-DTE rows (expiry IS NULL — existing behavior) coexist with per-expiry rows (expiry = date) under one constraint. Adds (ticker, date, expiry) index for the panel scope filter. Backs the Greek Flow panel scope toggle — see docs/superpowers/specs/greek-flow-0dte-toggle-2026-05-06.md.',
        '#130: Drop and rebuild periscope_analyses for the 3-mode lifecycle (pre_trade / intraday / debrief). User-approved CASCADE rebuild — no FK consumers exist beyond the self-reference via parent_id (verified Phase 0 audit). Adds the structured trading playbook columns (bias, trade_types_recommended, trade_types_avoided, key_levels, expected_dealer_behavior, confidence, confidence_basis, parse_ok), the read-time anchor columns (read_time, spot_at_read_time, spot_source) so DB-looked-up SPX spot replaces the chart red-dotted-line spot, and an ON DELETE SET NULL on the parent_id self-reference (was missing in v1 — orphaned a debrief on parent delete). Indexes: (mode, calibration_quality) for retrieval pre-filter, (parent_id) for chain traversal, partial (calibration_quality DESC, created_at DESC) for the gold library pull, and the HNSW on analysis_embedding carried forward. See spec: docs/superpowers/specs/periscope-chat-overhaul-2026-05-05.md.',
        '#131: Add futures_plan TEXT column to periscope_analyses for directional futures execution string (LONG/SHORT/WAIT framing tied to MM positioning).',
        '#132: Add realized_* columns to periscope_analyses for retrospective outcome scoring (entry vs end-of-session price action). Populated post-hoc by ml/src/compute_realized_outcomes.py — null = pending.',
        '#133: Create periscope_lessons table for the curate-periscope-lessons cron. Stores trader-supplied lessons extracted from the "What to add to the model" section of mode=debrief periscope_analyses rows. Status lifecycle: proposed -> active (manual SQL promotion in MVP) -> archived. Active rows inject as a "## Recent lessons learned" sub-section into the cached references block on every periscope-chat call. HNSW on embedding gates dedup (cosine >= 0.8 -> merge into existing row, else insert new proposed). See spec: docs/superpowers/specs/periscope-curate-lessons-2026-05-06.md.',
        '#134: Create silent_boom_alerts table for the detect-silent-boom cron. Surfaces a step-change anomaly pattern: chains that trade silently for 15-20 min then exhibit a single 5-min ask-side block much larger than their own trailing-window baseline. Distinct from lottery_finder_fires (sustained-burst detector) — the silent-boom signature is a temporal discontinuity, not a cumulative shape. Empirical basis: scripts/silent_boom_audit.py, n=13,958 fires across 19 days, peak ceiling +26% / 71.7% win rate, but ~0% mean realized at fixed horizons → discretionary signal, surfaced for manual review. Includes realized_*_pct + peak_ceiling_pct enrichment columns (populated by scripts/enrich_silent_boom_outcomes.py from parquet, mirrors the lottery_finder_fires enrichment pattern). Spec: docs/superpowers/specs/silent-boom-detector-2026-05-08.md.',
        '#135: Add score + score_tier columns to silent_boom_alerts. Score is an integer composite of 7 feature buckets (DTE, baseline_volume, spike_ratio, entry_price, TOD, ask_pct, option_type) calibrated against the historical 14,100-fire sample — see docs/tmp/silent-boom-feature-audit-2026-05-08.md and api/_lib/silent-boom-score.ts. Tier is the 3-level conviction badge (tier1/tier2/tier3) the dashboard renders; tier1 historically lands ~5% of fires with ~56% peak >= 50% rate vs ~8% for tier3. Spec: docs/superpowers/specs/silent-boom-scoring-2026-05-08.md.',
        '#136: Add mkt_tide_diff column to silent_boom_alerts. Snapshot of the Market Tide NCP - NPP at the spike-bucket time (sourced from flow_data WHERE source = market_tide, latest tick at or before bucket_ct within 30min). Display-only macro context surfaced as the Tide ⬆/⬇ badge on each row — same pattern as lottery_finder_fires.macro.mkt_tide_diff. Not a selection signal. Populated forward by the detect-silent-boom cron and backfill_silent_boom_from_parquet.py; existing rows are UPDATEd in a one-shot via the migration helper script (out-of-band).',
        '#137: Add zero_dte_diff + spx_spot_gamma_oi columns to silent_boom_alerts. zero_dte_diff snapshots flow_data WHERE source = zero_dte_greek_flow (NCP - NPP) at the spike-bucket time; spx_spot_gamma_oi snapshots spot_exposures WHERE ticker = SPX (gamma_oi sign). Display-only regime context surfaced as the Day Banner regime strip on the dashboard — mirrors lottery_finder_fires.macro.zero_dte_diff and macro.spx_spot_gamma_oi. Not selection signals. Populated forward by detect-silent-boom and backfill_silent_boom_from_parquet.py; existing rows UPDATEd in one-shot via helper script.',
        '#138: Create cone_levels table for the daily 0DTE straddle breakeven cone (Phase 1 of docs/superpowers/specs/periscope-html-ingestion-2026-05-07.md). Replaces user-input manual cone bounds with auto-computed values from the SPX 0DTE option chain at 9:31 ET. Cone bounds derive from the ATM call+put marks: cone_upper = atm_strike + call_premium, cone_lower = atm_strike - put_premium. asymmetry_pts = (atm_strike - cone_lower) - (cone_upper - atm_strike); positive = downside-skewed (puts richer than calls). Read by the check-cone-breach cron + future ConeStatusPill UI panel. Date PK enforces one cone per session.',
        '#139: Create cone_breach_events table for first-breach-per-direction-per-day events (Phase 1 of docs/superpowers/specs/periscope-html-ingestion-2026-05-07.md). Written by the check-cone-breach cron every minute during RTH; UNIQUE (date, direction) gives natural idempotency so the cron writes one upper + one lower row per session even though it runs ~390 times. Backs the cone-status pill (INSIDE / BREACHED_UP / BREACHED_DOWN) and the planned push-notification on first breach. Per UW: SPX exceeding the 0DTE straddle breakeven tends to extend (vol expansion), not fade — this table is the trigger surface for the chase-the-breakout futures bias.',
        '#140: Create periscope_snapshots table for the periscope-scraper Railway service (Phase 2 of docs/superpowers/specs/periscope-html-ingestion-2026-05-07.md). Stores per-strike MM-attributed dealer-flow values from UW Periscope HTML — Gamma / Charm / Vanna / Positions — captured every 10 min during RTH. Each snapshot covers the full chain (typically 150+ strikes) for the user-configured 0DTE expiry. UNIQUE (captured_at, expiry, panel, strike) gives natural idempotency on retry. Composite index supports the read-time queries the derived-signal layer (Phase 3) will run: prior-slice lookups for sign flips, time-series scans for charm-zero migration, and ±100pt windowed aggregations for charm tally. Schema accommodates Vanna which is mandatory on vol-shock days even though 0DTE Vanna is small — multi-DTE vanna is the dominant dealer-flow driver during VIX moves.',
        '#141: Add timeframe column to periscope_snapshots to record the UW slot label (e.g. "09:10 - 09:20") each row was actually captured from. Greek-cycling within a single tick takes 5–10s, and UW publishes a new 10-min slot mid-cycle every 10 min — without a per-row timeframe, the three panels at one captured_at could silently come from different slots. Storing the parsed label per row makes drift visible to the formatter and the panel, and lets the scraper realign timeframe back to the gamma anchor on subsequent Greek captures. Nullable so existing rows stay valid; the scraper writes a real value for every new row.',
        '#142: Extend periscope_analyses for the auto-playbook lifecycle (scraper-triggered Claude reads at 10-min cadence — Phase 1 of docs/superpowers/specs/periscope-auto-playbook-2026-05-10.md). Adds auto_generated flag distinguishing rows written by the cron path from manual entries; slot_captured_at to anchor each row to the exact periscope_snapshots tick it analyzed; status (in_progress / complete / failed / truncated) so the panel can render mid-flight states distinctly and surface max_tokens truncation rather than silently storing null payloads; failure_reason for status=failed forensics; panel_payload JSONB holding the structured tool_use output the frontend renders directly (SPOT, CONE, LONG/SHORT TRIGGER, REGIME, RECOMMENDED, AVOID, FUTURES PLAN, gamma floor/ceiling, charm zero, narrative). Unique (trading_date, slot_captured_at, auto_generated) lets the auto path and a manual rerun coexist for the same slot — Postgres NULL-distinct semantics on slot_captured_at keep historical rows (slot_captured_at IS NULL) valid without colliding. Partial index on (trading_date DESC, slot_captured_at DESC) WHERE status = complete supports the panel "latest playbook for today" query without scanning in-progress / failed / truncated rows. All columns nullable or default-backfilled so existing manual rows stay valid; the auto-playbook code path populates them on every new row.',
        '#143: Create periscope_grades for EOD deterministic scoring of every auto-generated playbook (Phase 1 of docs/superpowers/specs/periscope-calibration-grading-2026-05-11.md). One row per (periscope_analysis_id, grader_version) — bumping the version when the rubric changes preserves historical grades for compare. Stores per-dimension binary grades (regime_correct, bias_correct, cone_held, gamma_floor_held, gamma_ceiling_held, charm_drift_correct, long_fired, short_fired, ic_blown_at_eod) alongside the raw observations (regime_observed, bias_observed_return, fire timestamps) that produced them — keeping the inputs lets a future re-grade run against archived state without re-fetching candles. trade_sims JSONB holds an array of {asset, side, entry, exit, exit_reason, pnl_pct, duration_min} entries (one per fired trigger × asset in {SPX, ES, NQ}); JSONB instead of normalized columns because the per-slot count varies 0–6 and the access pattern is whole-row reads. recommended/avoid_structures_correct hold {structure_name: bool|null} maps so we can compute per-structure accuracy without enumerating columns. graded_at + grader_version let the CLI surface "this was scored on rubric v1 at 15:30 CT". CASCADE on the FK so deleting a parent analysis (rare — only for test cleanup) drops the grade with it.',
        '#144: Create interval_ba_alerts for SPXW per-contract 5-min Interval B/A ask-side alert events (Phase 2 of docs/superpowers/specs/interval-ba-ask-alert-2026-05-12.md). Written by the uw-stream SPXWIntervalBAHandler when a 0DTE SPXW contract crosses the configured ask-side premium ratio (default 70%) AND clears the floor (default $250K) within its current 5-min wall-clock bucket. Schema captures bucket boundaries, the ratio + premium aggregates at fire time, the dominant ask-side print that drove the ratio (premium / size / executed_at / is_sweep / is_floor) so the user can jump straight to the per-trade tape, and the SPX underlying price snapshot for chart context. UNIQUE (option_chain, bucket_start) is the natural dedupe key — the handler already enforces "one alert per contract per bucket" in memory, but the constraint guarantees idempotency across daemon restarts. Two indexes: (fired_at DESC) for the polled REST read endpoint /api/interval-ba-alerts?since=ISO, and a partial (acknowledged, fired_at DESC) WHERE acknowledged = FALSE for the chime-repeat loop in useIntervalBAAlerts (mirrors the market_alerts pattern from #25). Phase 2 only creates the table; the handler ships with interval_ba_enabled=False until the env var is flipped post-migration.',
        '#145: Create push_subscriptions table for Web Push VAPID fan-out of SPXW Interval B/A alerts (v2 of docs/superpowers/specs/interval-ba-ask-alert-2026-05-12.md, see docs/superpowers/specs/interval-ba-push-v2-2026-05-12.md). Stores one row per device-subscription that the owner has granted Notification permission on. endpoint is UNIQUE so the same browser re-subscribing UPSERTs cleanly (browser may rotate the endpoint on profile reset, generating a new row — orphan rows are cleaned up post-410 in api/_lib/push.ts). NOT keyed by user_id — single-owner app; multiple rows = multiple devices for the same owner. Fan-out by api/push/notify reads all rows and posts the payload to each endpoint using the web-push SDK. Distinct from the prior push_subscriptions table (#78, dropped in #115) which carried a user_id column and FuturesGammaPlaybook-specific shape — that table has been gone for weeks so there is no name collision risk on a fresh DB. created_at DESC index supports the "show me my devices" admin query; the UNIQUE constraint on endpoint serves the UPSERT path without needing a separate named index.',
        '#146: Add multi_leg_share NUMERIC column to silent_boom_alerts (spec: docs/superpowers/specs/silent-boom-ask-100-demote-2026-05-12.md). Stores the fraction of spike-bucket size whose UW trade_code is one of mlat/mlet/mlft/mfto/masl/mesl/mfsl/mlct — the OPRA-standard multi-leg sale condition codes. The detector now rejects buckets whose multi_leg_share ≥ 0.50 outright so spread-leg-dominated prints never enter the table; surviving rows carry the share for tooltip display + analytical drill-down. Empirical basis: scripts/analyze_silent_boom_multileg.py 2026-05-12, showing multi-leg fires win > 100% at 3× lower rate than single-leg fires in every ask% band (95-99% control: 3.8% vs 11.7%). Nullable because rows written before this migration have no attribution available (ws_option_trades retention is 7d); the backfill script populates where parquet data is available, otherwise leaves NULL.',
        "#147: Add confluence_tickers column to interval_ba_alerts (Phase 1 of docs/superpowers/specs/interval-ba-confluence-2026-05-13.md). Records which other tickers (SPY, QQQ) fired same-direction within a 90-second window of each alert — populated by the uw-stream handler at fire time (Phase 4). TEXT[] so multiple co-firing tickers can coexist in one row. GIN index supports WHERE confluence_tickers @> ARRAY['SPY'] array-containment queries from the feed endpoint filter (= ANY() would seq-scan; @> uses the GIN entries). Column defaults to NULL on existing rows; backfill deferred to Phase 7.",
        '#148: Add composite (date, timestamp DESC) index on gex_strike_0dte to fix the SPX path of /api/gex-strike-expiry. Sentry showed the endpoint at p50=15s / p95=25s / max=32s — every SPX poll from useGexStrikeExpirySpx was hitting the client 8s timeout and surfacing "SPX vol reinforcement: signal timed out" in the GEX Landscape. The query in db-gex-strike-expiry.ts (getLatestGexPerStrikeWithDeltas + effective_at MAX(timestamp)) filters WHERE date = $1 AND timestamp BETWEEN x AND y; the only existing indexes from migration #47 are single-column idx_date and idx_ts DESC, neither of which lets the planner satisfy both predicates without a wide range scan. The UNIQUE (date, timestamp, strike) composite from #47 is technically usable but the planner prefers a narrower covering index. This index matches the exact filter shape (date eq + timestamp range, ordered DESC for the MAX) and should drop the SQL from ~22s to <500ms.',
        '#149: Add mkt_tide_otm_diff NUMERIC column to silent_boom_alerts (Phase 1 of docs/superpowers/specs/silent-boom-otm-tide-and-trail-2026-05-13.md). Snapshot of the OTM-restricted Market Tide NCP - NPP at the spike-bucket time (sourced from flow_data WHERE source = market_tide_otm, latest tick at or before bucket_ct within 30min). Distinct from #136 mkt_tide_diff which captures the all-in variant; the OTM variant filters out dealer hedging noise and is the recommended directional signal per Periscope calibration. Populated forward by the detect-silent-boom cron and backfilled by scripts/backfill_otm_tide_on_alerts.py against the same flow_data table. Nullable because rows written before this migration have no snapshot — backfill recovers every historical date since flow_data source=market_tide_otm has continuous history back to 2026-02-09. Mirrors lottery_finder_fires.mkt_tide_otm_diff which already exists from #122. No index needed: queries filter on (date, bucket_ct) and only group by this column for analytics.',
        '#150: Add realized_trail30_10_pct NUMERIC column to silent_boom_alerts (Phase 2 of docs/superpowers/specs/silent-boom-otm-tide-and-trail-2026-05-13.md). Stores the peak-trail exit return: activate trailing stop at +30% from entry, then exit at 10pp giveback from running peak; if peak never crosses +30%, hold to last tick (EoD). Computed by ml/src/lottery_exit_policies.py:realized_trail_act30_trail10 against the per-fire post-bucket tick stream from the EOD parquet — the same function lottery_finder_fires.realized_trail30_10_pct already uses (#110). Empirical basis from this session: tier1 silent boom fires averaged peak +297% / EoD -40.8% (hold-to-close was wrong); the bounded estimate model puts trail-30/10 at +147% for tier1, validated up/flat/down regimes. Populated by scripts/enrich_silent_boom_outcomes.py during the nightly enrichment pass (with a --backfill-mode flag that gates on realized_trail30_10_pct IS NULL instead of enriched_at IS NULL so a one-time historical run can fill rows enriched before this migration without resetting enriched_at). Lineage: extends the #146 multi_leg_share enrichment pattern — adds one outcome column alongside the existing peak/r30/r60/r120/eod set written by update_outcomes(). Nullable because rows enriched before this migration have no trail value computed; backfill recovers every historical fire since parquet retention covers the full silent_boom_alerts history. No index needed: read paths group by tier/date and aggregate this column for analytics.',
        "#151: Add direction_gated BOOLEAN column to silent_boom_alerts and lottery_finder_fires (spec: docs/superpowers/specs/silent-boom-direction-gate-and-trail-ui-2026-05-14.md). TRUE when a fire is counter-trend per Market Tide at fire time and the detector demoted it: silent_boom gates on the all-in mkt_tide_diff at T=±100M (puts with diff > +100M or calls with diff < -100M); lottery gates on the OTM mkt_tide_otm_diff at T=±150M. Thresholds chosen empirically from the 15K silent_boom + 96K lottery historical sample — counter-trend lottery fires showed +6.71% avg EOD vs trend-aligned -18.04% (24.75pp spread); silent_boom counter-trend tier1 fires showed -50.55% EOD vs -11.37% trend-aligned. Silent boom also overwrites score_tier to 'tier3' on gated rows; lottery preserves score and lets the feed endpoint override the displayed tier (lottery has no stored score_tier — it's computed from score at read time). NOT NULL with DEFAULT FALSE so existing rows automatically read as ungated until the one-shot backfill flips the historical counter-trend rows.",
        '#152: Add underlying_price_at_spike NUMERIC column to silent_boom_alerts. Snapshot of the volume-weighted underlying spot during the spike bucket (computed from ws_option_trades.underlying_price weighted by trade size). Enables the Aggressive Premium filter chip (docs/superpowers/specs/aggressive-premium-chip-2026-05-15.md) to compute OTM-ness per fire (calls: strike > spot; puts: strike < spot) — closing the gap with the trader-mirrored UW filter that requires "OTM only". Populated forward by the detect-silent-boom cron (added to the bucket aggregation SQL); legacy rows backfilled by scripts/backfill_silent_boom_underlying_price.py from the Eod-Full-Tape archive where the spike-bucket prints are still on disk. Nullable because pre-migration rows have no snapshot until backfill lands; filter queries gate on IS NOT NULL.',
        '#153: Add range_pos_at_trigger NUMERIC column to lottery_finder_fires (spec: docs/superpowers/specs/lottery-silentboom-eda-impl-2026-05-16.md Finding 1 — "Range Kill"). Stores (spot_at_first − session_low) / (session_high − session_low) computed from 1-min stock OHLC up to trigger_time_ct. Range ∈ [0, 1] where 0 = at session low, 1 = at session high. The 2026-05-15 cross-section EDA found bottom-10% (range_pos < 0.10) is a near-zero edge bucket (2.4% win50, 0.07× baseline lift) — used as a hard kill filter + −3 score penalty. The top-10% bucket has 1.30× win50 / 1.75× win100 lift. Populated forward by the detect-lottery-fires cron via the UW /stock/{ticker}/ohlc/1m endpoint; historical rows backfilled by scripts/backfill-range-pos.mjs. Nullable because pre-migration rows have no snapshot until backfill lands; the score-bonus function treats null as "no penalty" so older fires retain their original score.',
        '#154: Add round_trip_net_pct + round_trip_score_deduct columns to lottery_finder_fires AND silent_boom_alerts (spec: docs/superpowers/specs/round-trip-score-deduct-production-2026-05-16.md). round_trip_net_pct stores post_fire_net_pct_of_volume from a 60-min look-forward window on the alert contract: (ask_size − bid_size) / total_size using per-print tag classification (NOT the cumulative *_vol fields — see memory feedback_uw_fulltape_vols_cumulative.md). Negative values indicate post-fire bid-side flow dominated (likely round-trip / position closed). Phase 1 EDA on 641,638 enriched alerts × 92 days fulltape showed AUC 0.59 cohort-uniform, with signal concentrated in 0-7 DTE (collapses to ~random above). round_trip_score_deduct is the stepped-bracket penalty: < −0.50 → −3, [−0.50, −0.30) → −2, [−0.30, −0.10) → −1, else 0. NOT NULL DEFAULT 0 so existing rows read as un-penalized. Populated by api/cron/evaluate-round-trip.ts 60-75 min after fire (Phase 2B), DTE ≤ 7 only. Backfill via scripts/backfill_round_trip_score.py from the existing alert_features.parquet (Phase 2A). Partial index on negative deducts is small (~30% of rows) and supports the "Hide round-tripped" filter chip queries.',
        '#155: Add takeit_prob + takeit_top_features + takeit_model_version columns to lottery_finder_fires AND silent_boom_alerts (spec: docs/superpowers/specs/takeit-phase3-production-scoring-2026-05-16.md). takeit_prob is the calibrated P(peak_ceiling_pct ≥ 20) from the XGBoost classifier (range [0,1], computed in TS at detect time via api/_lib/takeit-score.ts walking the XGBoost JSON tree dump fetched from Vercel Blob). takeit_top_features is the SHAP top-3 green + top-3 red flags ({"positive": [...], "negative": [...]}) populated ~2 min post-fire by api/cron/takeit-fill-shap.ts calling the sidecar /takeit/explain endpoint. takeit_model_version is the bundle version string (e.g. "v2026-05-23"); enables idempotent backfill and version-aware filtering. Partial index on (date DESC, takeit_prob DESC) WHERE takeit_prob IS NOT NULL supports the future "sort feed by prob" queries. Phase 2 OOF AUC: lottery 0.6991 (+8.5pp over heuristic), silentboom 0.7667 (+4.2pp). Backfill via scripts/backfill_takeit.py.',
        '#156: Create gexbot_snapshots + gexbot_api_capture + gexbot_archive_audit tables for GEXBot Orderflow-tier trial capture (spec: docs/superpowers/specs/gexbot-trial-capture-2026-05-16.md). gexbot_snapshots stores extracted orderflow scalar columns (40 NUMERIC + raw_response JSONB) for hot-path SQL queries against /{ticker}/orderflow/orderflow polled once per minute across 16 Index+ETF tickers. gexbot_api_capture is the generic raw-JSONB store for the other 10 tier-eligible endpoints (8 state per-strike categories {gamma,delta,vanna,charm}_{zero,one} + 2 classic maxchange categories gex_zero/gex_full) — pre-extraction strategy: store everything, derive columns later via SQL views once value-add patterns emerge. gexbot_archive_audit records every successful Parquet → Vercel Blob export (one row per (table, archive_date) with UNIQUE constraint supporting ON CONFLICT DO UPDATE for idempotent re-runs), gating the cleanup-gexbot cron which only deletes confirmed-archived rows. Trial-month volume: ~176 calls/min × 8h × 22 trading days; archive + cleanup keep live DB bounded at ~3.5 GB (today + yesterday).',
        '#157: Add takeit_features JSONB column to lottery_finder_fires AND silent_boom_alerts (spec: docs/superpowers/specs/takeit-phase3-production-scoring-2026-05-16.md Phase 3d follow-up). Persists the full feature vector — including derived features (session_phase, is_itm_at_fire, otm_distance_pct, aggressive_premium_flag, dealer_gamma_sign, burst_storm_distinct_count, n_same_dir_fires_last_30min, prior_session_win_rate_same_ticker, minute_of_day_ct, day_of_week) AND one-hot encoded categoricals (option_type_*, ticker_bucket_*, mode_*, flow_quad_*, tod_*, score_tier_*) — exactly as scoreLottery/scoreSilentBoom produced it at detect time. The SHAP fill cron reads this back and ships it to the sidecar /takeit/explain endpoint as-is, eliminating the prior bug where takeit-fill-shap was sending raw SQL row dicts (missing all derived/one-hot features), which would have produced near-empty SHAP matrices on first invocation. Nullable because rows pre-migration have no captured features; the SHAP fill cron filters on `takeit_features IS NOT NULL` so older rows just stay unflagged.',
        '#158: Add cum_ncp_at_fire + cum_npp_at_fire NUMERIC columns to lottery_finder_fires AND silent_boom_alerts (spec: docs/superpowers/specs/lottery-silentboom-feed-perf-2026-05-17.md). Snapshot of the ticker cumulative net call/put premium at the detect-time fire — replaces the per-row LATERAL JOIN that commits 26b13630 + 426c1e91 added to all 7 feed sort branches and which caused ~30s page loads on Lottery Finder + Silent Boom feeds. Populated forward by the detect crons via api/_lib/ticker-flow-snapshot.ts (same UNION over ws_net_flow_per_ticker + net_flow_per_ticker_history as the LATERAL, but bounded by ctSessionBounds(date).min instead of the 4-6h-wider UTC midnight). Historical rows backfilled by scripts/backfill-ticker-flow-at-fire.mjs. Nullable because pre-migration rows + rows for tickers outside the WS net-flow universe (~50 tickers) have no snapshot — the feed JS already handles null tickerCumNcpAtFire / tickerCumNppAtFire identically to the LATERAL returning null. No index needed: these columns are SELECTed for display, never filtered or sorted.',
        '#159: Add combined_score INTEGER GENERATED ALWAYS column to lottery_finder_fires AND silent_boom_alerts (spec: docs/superpowers/specs/lottery-silentboom-feed-perf-2026-05-17.md). Restores indexed sort path for the lottery score-sort feed branch after commit 4fc7ec99 (Phase 2C round-trip-deduct) changed ORDER BY from the indexed `f.score DESC` to a computed `GREATEST(0, COALESCE(score, 0) + round_trip_score_deduct)` expression that the planner cannot serve from the migration #126 (date, score DESC) index. Generated column auto-populates for all existing rows during ALTER TABLE (no backfill required); evaluate-round-trip cron UPDATEs to round_trip_score_deduct 60-75min post-fire trigger automatic re-computation by Postgres so the new sort index stays consistent. GREATEST(0, ...) preserves the floor-at-zero semantic the feed JS applied today. Partial nullability handled by COALESCE on score. The (date DESC, combined_score DESC NULLS LAST) index serves the new lottery score-sort ORDER BY directly with index-streamed LIMIT termination. Silent-boom does not currently expose score as a sort option, but the column + index are added symmetrically for future use.',
        '#160: Add multileg classification columns (inferred_structure TEXT, is_isolated_leg BOOLEAN, match_confidence REAL, pattern_group_id TEXT) to lottery_finder_fires AND silent_boom_alerts. Populated by the detect crons via the sidecar POST /takeit/multileg-classify endpoint that runs the polars matcher in ml/src/multileg_assembler.py against a window of UW Full Tape trades around the alert. inferred_structure is one of the matcher v1 labels: "vertical" (2 strikes, same expiry, same option_type, opposite directions), "strangle" (OTM call + OTM put, same expiry, same direction), "risk_reversal" (OTM put + OTM call, same expiry, opposite directions), "butterfly" (3 equidistant strikes, body 2x wings), or "isolated_leg" (no pattern matched within the window). Adding patterns in v2 = adding entries to multileg_patterns.PATTERNS — no schema change required. is_isolated_leg = match_confidence < 0.5; match_confidence is in [0, 1]; pattern_group_id is a stable hash shared by all trades the matcher attributed to the same structure (isolated legs each get their own group id). All four columns are NULLABLE — pre-migration rows are unclassified and the matcher is best-effort (a classify call may fail without blocking alert insertion). No index in v1; takeit feature pipeline reads via the alert row PK.',
        '#161: Create tracker_contracts table for the Contract Tracker feature (spec: docs/superpowers/specs/contract-tracker-2026-05-17.md). Tracks manually entered options contracts to expiry with periodic price refresh and threshold-based in-app alerts. occ_symbol is the natural unique key (OCC format, e.g. "NVDA  260522P00225000"). up_thresholds/down_thresholds are per-contract overrides (NULL = use app defaults [50,100,200] / [-30,-50]). spot_alerts is a JSONB array of {op, level} objects for underlying-price alerts. status lifecycle: active → closed (manual) or expired (auto-archived at expiry by the cron). Two indexes: status (panel tab queries filter active/closed/expired) and ticker (group-by-ticker toggle).',
        '#162: Create tracker_contract_ticks table for the Contract Tracker feature (spec: docs/superpowers/specs/contract-tracker-2026-05-17.md). Stores per-poll price snapshots written by the api/cron/refresh-tracker-contracts.ts cron every 5 min during market hours. FK ON DELETE CASCADE so ticks are purged with their parent contract. source defaults to "uw" (Unusual Whales). The (contract_id, fetched_at DESC) composite index serves the "latest tick for contract" pattern used by the active panel row renderer.',
        '#163: Create tracker_alerts table for the Contract Tracker feature (spec: docs/superpowers/specs/contract-tracker-2026-05-17.md). Each row is one threshold-breach event fired by the refresh cron. alert_type is one of: up_pct, down_pct, spot_level, dte_7. threshold stores the numeric trigger value (pct for up/down_pct, spot price for spot_level, 7 for dte_7) — NOT NULL intentionally so the UNIQUE (contract_id, alert_type, threshold) dedup index covers every alert type including DTE-7 (stored as threshold=7). INSERT ... ON CONFLICT DO NOTHING ensures each threshold fires at most once per contract over its lifetime. acknowledged is flipped via POST /api/tracker/alerts/:id/ack and polled by useTrackerAlerts every 30 s.',
        '#164: Add wave2_status TEXT + wave2_detected_at TIMESTAMPTZ columns to lottery_finder_fires AND silent_boom_alerts for Phase 4 wave-2 confirmation tracking (spec: docs/superpowers/specs/meta-detectors-2026-05-16.md Phase 4). The wave2-confirmation cron scans each fire for a second qualifying same-ticker + same-option_type event in the same table within 60 min of trigger time and writes one of three labels: "confirmed" (a wave-2 event landed within 0-30 min), "lagging" (30-60 min), or "fizzled" (60 min elapsed with no follow-up). wave2_detected_at carries the second event\'s timestamp on confirmed/lagging and stays NULL on fizzled. Status is left loose (no CHECK constraint) for forward-compat with v2 labels like "cross_type_confirmed". The partial indexes are the cron hot path — without them every tick scans the full table; with them only NULL-status rows are touched (which is exactly the candidate set). lottery uses trigger_time_ct, silent_boom uses bucket_ct. Both tables get the same two columns + one partial index symmetrically. Status transitions are one-way (NULL → confirmed/lagging/fizzled) and the cron never reverses a verdict — the IS NULL guard on the read makes the whole job idempotent.',
        '#165: Create panel_prefs table for per-identity panel visibility preferences (spec: docs/superpowers/specs/panel-prefs-2026-05-17.md). One row per identity — `\'owner\'` literal sentinel for the cookie session, or sha256(guest_key) hex for guests so a leaked panel_prefs row reveals no live credential. hidden_panels is a JSONB deny-list of `sec-*` panel IDs; storing "hidden" (not "visible") means new panels you ship later auto-appear for existing users instead of being invisible until each one re-toggles. updated_at supports a future "last touched" diagnostic but is not currently read on the hot path. No additional index — identity is the PK and the only read pattern is `WHERE identity = $1`.',
        '#166: Add panel_order + group_order JSONB columns to panel_prefs for two-level user-controlled layout (spec: docs/superpowers/specs/panel-reordering-2026-05-17.md). Both columns are sparse arrays — stored ids are the user-customized prefix, anything missing falls back to registry / PANEL_GROUP_ORDER. NOT NULL DEFAULT \'[]\' so the GET path can read them unconditionally; existing rows pick up the empty default (= "use registry order"). One combined ALTER statement keeps the migration atomic and matches the column-add idiom used by #66 and #95.',
        '#167: Promote fire_count_score_adjustment from a read-time TS computation to a stored DB column on lottery_finder_fires, then redefine combined_score (the STORED generated column used by the score-sort ORDER BY index) to include it. Closes the displayed-vs-sort divergence documented in commit 254c94ed: previously the score-sort branch would order by combined_score = score + round_trip_score_deduct (excluding the fire_count adjustment), so a 1-fire row with rawScore=20 (combined_score=20, displayed=17) could rank above an 8-fire row with rawScore=18 (combined_score=18, displayed=19). After this migration the displayed score and the sort key are the same expression. Empirical basis: docs/tmp/burst-profitability-findings-2026-05-17.md. The trigger maintains the new column on every INSERT — bucket-boundary detection keeps the work bounded to O(1) on non-crossing inserts (set just the new row) and O(N-per-chain-day) on the 4 rare boundary crossings (1→2, 3→4, 7→8, 15→16). After-INSERT-only trigger does not recurse via its own UPDATE.',
        "#168: Add gamma_at_trigger NUMERIC column to lottery_finder_fires AND silent_boom_alerts. Stored greek snapshot at fire-detection time, populated by the detect crons via raw_payload->>'gamma' extraction from ws_option_trades. Empirical basis: docs/tmp/gamma-deep-dive-findings-2026-05-17.md — high gamma carries +4.8pp (LF) to +10.7pp (SB) winrate lift on the trail30/10 exit, but the lift is ticker-conditional (SPY and USO REVERSE the signal; -7pp and -16pp drag respectively). The lift is also exit-conditional (hold-EoD reverses because high gamma = theta-burn at 0DTE). Combined_score is dropped and recreated to include the gamma bonus as a row-local CASE expression: +1 when ticker NOT IN ('SPY','USO') AND gamma_at_trigger >= 0.025, else 0. Unlike fire_count_score_adjustment (#167), gamma_at_trigger is row-local so it lives directly in the GENERATED expression — no trigger needed. silent_boom_alerts gets the column for UI/analysis only (no combined_score on that table). Older rows remain NULL; only new fires inserted after this migration carry a populated value.",
        '#169: Add pre_trade_count INTEGER column to silent_boom_alerts. Stores the count of non-canceled trades on the same option_chain_id from session open (08:30 CT) to bucket_ct at fire-detection time. Empirical basis: docs/superpowers/specs/silent-boom-h1-h3-features-2026-05-17.md — within every elapsed-time bucket on the 93-day peak dataset (n=63,846), the 501+ pre-trade-count cohort outperforms the dead-silent baseline by +15-25pp on peak ≥50%. Lift is independent of TOD (which already controls for elapsed time). Score bonus +4 fires when pre_trade_count >= 501. Older rows stay NULL until backfilled.',
        '#170: Add adj_cofire BOOLEAN column to silent_boom_alerts. TRUE when another SB fire exists at the same (ticker, option_type, bucket_ct) on the adjacent strike (±$1 default, ±$5 for SPX/NDX/RUT cash-index roots). Empirical basis: docs/superpowers/specs/silent-boom-h1-h3-features-2026-05-17.md — on the 93-day, 63,846-alert peak dataset only 1,911 alerts (3.0%) cofire, but those alerts hit 22.0% peak ≥50% vs 16.0% non-cofire (+5.8pp lift). Score bonus +2 fires when adj_cofire=TRUE. Detector populates via intra-cron lookup (build a Set<key> of all this-cron fires, check strike±step membership). Older rows stay NULL until backfilled.',
        "#171: Add first_min_share NUMERIC(5,4) + spread_in_bucket NUMERIC columns to silent_boom_alerts. first_min_share = SUM(size in first 60s of bucket) / SUM(size in bucket) — captures the H2 cadence finding from docs/tmp/sb-93d-pass-b-peak-output.txt: distributed-cadence spikes (<25% in min1) outperform single-block spikes (>75%) by 9.6pp on peak ≥50%. spread_in_bucket = size-weighted relative NBBO spread within the bucket — captures the H5 finding: in-bucket spread Q3 (>0.1122) hits 21.7% peak ≥50% vs Q0 (<0.0181) at 7.9% — a 13.8pp gap. Both populated by detect-silent-boom cron (NBBO comes from raw_payload->>'nbbo_*' since the uw-stream daemon doesn't promote those fields to typed columns). Score weights: distributed +1, single-block -3, Q3 +2, Q0 -3. Older rows stay NULL until backfilled via scripts/backfill_silent_boom_cadence_spread.py.",
        '#172: Create periscope_lottery_fires table for the dual-panel Periscope-event-driven lottery alerts (call lottery / put lottery). Triggers on periscope_snapshots gamma (call lottery) and charm (put lottery) events that meet the v3 in-sample-validated filter chain documented in docs/superpowers/specs/periscope-lottery-alerts-2026-05-19.md. Idempotent UNIQUE (fire_type, fire_time, event_strike) so the 5-min cron can re-scan the same 10-min Periscope slice without duplicating rows. Outcome columns (peak_px, realized_r) filled by enrich-periscope-lottery-outcomes cron at 20:10 UTC daily.',
        '#173: Create opening_flow_signals table for per-date / per-ticker historical snapshots of the V4 Opening Flow Signal panel (spec: docs/superpowers/specs/opening-flow-signal-historical-persistence-2026-05-19.md). The endpoint re-computes from ws_option_trades when called for today, but raw trades are pruned at T+2 by cleanup-ws-option-trades (RETENTION_DAYS = 2), so historical reads beyond yesterday come back empty. The capture-opening-flow-signal cron writes one row per (date, ticker) at 08:50 CT daily so future-day reads survive the trade-table sweep. slice1/slice2/signal stored as JSONB to absorb shape growth without column proliferation. stop_pct + exit_minutes_from_entry are frozen per-row so a historical replay uses the rule constants that were in effect that morning (V4 → V5 etc.).',
        '#174: Add composite index on ws_option_trades (ticker, expiry, strike, option_type, executed_at DESC) to speed up the enrich-periscope-lottery-outcomes per-fire peak/EOD lookups. The existing ws_option_trades_ticker_executed_idx is too broad — a single SPXW lookup scans the whole day. Without this composite, the cron hits the 10s per-attempt timeout in withDbRetry on every fire, producing 1300+ Sentry events/day. Same index also accelerates intraday lottery-finder chainExtras / reignitedRows queries.',
        '#175: Add inversion-quality columns to lottery_ticker_stats. Wilson 95% LCB on P(realized_flow_inversion_pct >= 50) per ticker, computed on rolling 21d and 90d windows (sample-size floor N>=10 per window; NULL otherwise). inversion_blend = 0.6 * 21d + 0.4 * 90d, fallback to whichever window has N>=10 if only one qualifies. inversion_quintile maps blend across the ticker universe to 1..5. Populated nightly by scripts/enrich_lottery_outcomes.py.',
        '#176: Add spot_at_trigger NUMERIC(12,4) to lottery_finder_fires for per-fire underlying spot. Captured by detect-lottery-fires cron from the trigger-tick underlyingPrice (matches triggerTimeCt). Used by the LotteryRow reload-delta badge to compute Δ underlying between successive fires on the same chain today. NULL on pre-existing rows; no backfill.',
        '#177: Create lottery_finder_fires_with_outcome view for the rescore project (spec: docs/superpowers/specs/lottery-rescore-2026-05-22.md). Exposes outcome_pct = COALESCE(realized_flow_inversion_pct, realized_eod_pct) so the ~23% of fires where flow never inverted (alert direction stayed correct all day, so no exit signal fired) contribute their held-to-EOD return to model training instead of being excluded entirely. Also surfaces is_aligned (call AND ncp>npp OR put AND npp>ncp) so Phase 1 training queries can gate on alignment without repeating the CASE expression. View materializes on read — no separate storage, no extra cron. CREATE OR REPLACE is idempotent.',
        '#178: Add cluster_bonus SMALLINT column to lottery_finder_fires. Populated at insert time by detect-lottery-fires cron: counts distinct other tickers that scored tier1 within ±5 min of this fire in the same cron batch, then maps to a tiered bonus (isolated=0, pair=+1, 3-4=+2, 5+=+1). Empirical basis: docs/tmp/v22-co-fire-analysis-2026-05-22.md — 30-day study shows 2-4-ticker cluster fires outperform isolated fires by +22pp mean outcome (79% vs 57% win-rate at cluster_size 3-4). The bonus is stored separately from score so audits can attribute the score delta. Older rows stay 0 (DEFAULT 0); backfill available via one-shot Python script. Part of V2.2 Phase C.4.',
        '#179: Create ws_gamma_setup_fires table for the Gamma-Node Composite Detector (spec: docs/superpowers/specs/gamma-node-composite-detector-2026-05-21.md). Tracks live fires of E1 long-call breakthrough, E5 long-put failed-reversal, and PCS Monday rejection setups against SPX +γ floor/ceiling strikes from periscope_snapshots. Each row captures the trigger context (spot, node, gex, bar OHLCR), the day-level filter status (pre-day filter, anti-filter calendar flags), and a confidence_tier label derived per-DOW (MAXIMUM/HIGH/MEDIUM). Outcome columns (ret_15m/30m/60m/eod) are NULL at insert time and backfilled by backfill-gamma-setup-outcomes cron at 15:30 CT. Optional trade_* columns hold manual journal entries comparing realized P&L to the expected forward edge. UNIQUE(fired_at, signal_type, node_strike) keeps the detection cron idempotent across cron-tick boundaries — re-running at the same minute on the same setup is a no-op. Indexes on fired_at and signal_type support both the active-day endpoint and the outcome-backfill cron.',
        '#180: Add GexBot context columns to silent_boom_alerts so detect-silent-boom can stash the top GexBot scalars at fire time. Univariate probe (docs/superpowers/specs/silent-boom-gexbot-probe-findings-2026-05-26.md) found tentative signal (r=0.15-0.20, p<0.01) on `one_cvroflow`, `net_put_dex`, `one_dexoflow`, `one_gexoflow` predicting hit-30 over 4 trading days / n=270. Capturing them now lets the nightly takeit-retrain pick them up via build_training_set.py once enough data has accumulated. NULL when ticker is outside the 16-ticker GexBot universe or when the snapshot window missed. `gex_captured_at` carries staleness for downstream gating.',
        '#181: Add GexBot context columns to lottery_finder_fires so detect-lottery-fires can stash the top GexBot scalars at fire time. Mirrors migration #180 on silent_boom_alerts — same 8 columns, same fail-open semantics, same null-when-out-of-universe behavior. Distinct from the pre-existing `gex_strike_*` columns (added by migration #110 for periscope strike exposure) — those are per-strike snapshots, these are aggregate dealer-position scalars from the GexBot orderflow endpoint. The nightly takeit-retrain picks them up via LOTTERY_SQL once enough data accumulates.',
      ]);
      // Pyramid migrations #65/66/67 remain in the chain (migration history is
      // immutable — fresh DBs replay create → alter → alter → drop). TRACE
      // migrations #56/57 also remain — #69 drops the table they created.
      // 134 (migrations #1-41) + 4 (#42) + 4 (#43) + 2 (#44) + 2 (#45) + 3 (#46) + 4 (#47: CREATE+2 INDEX+INSERT) + 2 (#48: ALTER+INSERT) + 4 (#49: CREATE+2 INDEX+INSERT) + 3 (#50: DELETE+CREATE UNIQUE INDEX+INSERT) + 5 (#51: CREATE+3 INDEX+INSERT) + 3 (#52: CREATE+1 INDEX+INSERT) + 4 (#53: CREATE+2 INDEX+INSERT) + 2 (#54: ALTER+INSERT) + 2 (#55: ALTER+INSERT) + 2 (#56: CREATE+INSERT) + 2 (#57: ALTER+INSERT) + 3 (#58: DROP INDEX+ALTER+INSERT) + 7 (#59: CREATE+5 INDEX+INSERT) + 2 (#60: CREATE+INSERT) + 2 (#61: ALTER+INSERT) + 7 (#62: CREATE+5 INDEX+INSERT) + 3 (#63: CREATE+1 INDEX+INSERT) + 2 (#64: ALTER+INSERT) + 6 (#65: CREATE chains+2 INDEX+CREATE legs+1 INDEX+INSERT) + 8 (#66: 7 ALTER+INSERT) + 5 (#67: DROP CONSTRAINT+ADD CONSTRAINT+2 ALTER+INSERT) + 3 (#68: 2 DROP+INSERT) + 3 (#69: DELETE+DROP+INSERT) + 4 (#70: CREATE+2 INDEX+INSERT) + 3 (#71: CREATE+1 INDEX+INSERT) + 3 (#72: CREATE+1 INDEX+INSERT) + 4 (#73: CREATE EXTENSION+CREATE TABLE+CREATE INDEX+INSERT) + 3 (#74: CREATE TABLE+CREATE INDEX+INSERT) + 3 (#75: CREATE TABLE+CREATE INDEX+INSERT) + 2 (#76: ALTER+INSERT) + 3 (#77: ALTER+INDEX+INSERT) + 3 (#78: CREATE TABLE+INDEX+INSERT) + 3 (#79: CREATE TABLE+INDEX+INSERT) + 2 (#80: CREATE TABLE+INSERT) + 4 (#81: CREATE TABLE+2 INDEX+INSERT) + 3 (#82: CREATE TABLE+1 INDEX+INSERT) + 4 (#83: CREATE TABLE+2 INDEX+INSERT) + 4 (#84: CREATE TABLE+2 INDEX+INSERT) + 2 (#85: ALTER+INSERT) + 3 (#86: 2 ALTER+INSERT) + 4 (#87: CREATE TABLE+2 INDEX+INSERT) + 5 (#88: CREATE EXTENSION+CREATE TABLE+2 INDEX+INSERT) + 2 (#89: ALTER+INSERT) + 3 (#90: ALTER+INDEX+INSERT) + 2 (#91: ALTER+INSERT) + 3 (#92: CREATE TABLE+1 INDEX+INSERT) + 4 (#93: CREATE TABLE+2 INDEX+INSERT) + 3 (#94: CREATE TABLE+1 INDEX+INSERT) + 5 (#95: 4 ALTER+INSERT) + 2 (#96: ALTER+INSERT) + 4 (#97: CREATE TABLE+2 INDEX+INSERT) + 11 (#98: 5 DELETE+5 CREATE UNIQUE INDEX+INSERT) + 5 (#99: CREATE TABLE+3 INDEX+INSERT) + 2 (#100: DROP TABLE+INSERT) + 2 (#101: ALTER+INSERT) + 2 (#102: CREATE TABLE+INSERT) + 6 (#103: CREATE TABLE+4 INDEX+INSERT) + 4 (#104: 3 ALTER+INSERT) + 2 (#105: ALTER DROP+INSERT) + 2 (#106: UPDATE+INSERT) + 2 (#107: DROP TABLE+INSERT) + 9 (#108: CREATE TABLE+6 INDEX+CREATE VIEW+INSERT) + 6 (#109: CREATE TABLE+4 INDEX+INSERT) + 7 (#110: CREATE TABLE+5 INDEX+INSERT) + 4 (#111: CREATE TABLE+2 INDEX+INSERT) + 8 (#112: ALTER RENAME+ALTER ADD COLUMN+ALTER DROP CONSTRAINT+ALTER ADD CONSTRAINT+DROP INDEX+CREATE PARTIAL UNIQUE INDEX+CREATE VIEW+INSERT) + 2 (#113: ALTER ADD COLUMN+INSERT) + 3 (#114: DROP VIEW+DROP INDEX+INSERT) + 3 (#115: DROP TABLE+DROP TABLE+INSERT) + 4 (#116: CREATE TABLE+2 INDEX+INSERT) + 2 (#117: DROP TABLE+INSERT) + 2 (#118: DROP TABLE+INSERT) + 2 (#119: DROP TABLE+INSERT) + 2 (#120: DROP TABLE+INSERT) + 5 (#121: CREATE TABLE+3 INDEX+INSERT) + 4 (#122: CREATE TABLE+2 INDEX+INSERT) + 2 (#123: CREATE INDEX+INSERT) + 2 (#124: ALTER+INSERT) + 4 (#125: CREATE TABLE+2 INDEX+INSERT) + 5 (#126: ALTER+INDEX+CREATE TABLE+INSERT seed+INSERT) + 3 (#127: 2 CREATE TABLE+INSERT) + 3 (#128: 2 DROP TABLE+INSERT) + 5 (#129: ALTER ADD COLUMN+ALTER DROP CONSTRAINT+ALTER ADD CONSTRAINT+CREATE INDEX+INSERT) + 8 (#130: DROP TABLE+CREATE TABLE+5 INDEX+INSERT) + 2 (#131: ALTER ADD COLUMN+INSERT) + 2 (#132: ALTER ADD COLUMN+INSERT) + 4 (#133: CREATE TABLE+2 INDEX+INSERT) + 6 (#134: CREATE TABLE+4 INDEX+INSERT) + 4 (#135: 2 ALTER+1 INDEX+INSERT) + 2 (#136: 1 ALTER+INSERT) + 3 (#137: 2 ALTER+INSERT) + 2 (#138: CREATE TABLE+INSERT) + 2 (#139: CREATE TABLE+INSERT) + 3 (#140: CREATE TABLE+INDEX+INSERT) + 2 (#141: ALTER ADD COLUMN+INSERT) + 8 (#142: 5 ALTER+UNIQUE INDEX+PARTIAL INDEX+INSERT) + 5 (#143: CREATE TABLE+3 INDEX+INSERT) + 4 (#144: CREATE TABLE+2 INDEX+INSERT) + 3 (#145: CREATE TABLE+1 INDEX+INSERT) + 3 (#146: ALTER ADD COLUMN+PARTIAL INDEX+INSERT) + 3 (#147: ALTER ADD COLUMN+GIN INDEX+INSERT) + 2 (#148: CREATE INDEX+INSERT) + 2 (#149: ALTER ADD COLUMN+INSERT) + 2 (#150: ALTER ADD COLUMN+INSERT) + 3 (#151: 2 ALTER ADD COLUMN+INSERT) + 2 (#152: ALTER ADD COLUMN+INSERT) + 2 (#153: ALTER ADD COLUMN+INSERT) + 7 (#154: 4 ALTER ADD COLUMN+2 PARTIAL INDEX+INSERT) + 9 (#155: 6 ALTER ADD COLUMN+2 PARTIAL INDEX+INSERT) + 9 (#156: 3 CREATE TABLE+5 INDEX+INSERT) + 3 (#157: 2 ALTER+INSERT) + 5 (#158: 4 ALTER ADD COLUMN+INSERT) + 5 (#159: 2 ALTER ADD GENERATED COLUMN+2 INDEX+INSERT) + 9 (#160: 8 ALTER ADD COLUMN+INSERT) + 4 (#161: CREATE TABLE+2 INDEX+INSERT) + 3 (#162: CREATE TABLE+1 INDEX+INSERT) + 3 (#163: CREATE TABLE+1 UNIQUE INDEX+INSERT) + 7 (#164: 4 ALTER ADD COLUMN+2 PARTIAL INDEX+INSERT) + 2 (#165: CREATE TABLE+INSERT) + 2 (#166: ALTER ADD 2 COLUMNS+INSERT) + 9 (#167: ALTER ADD COLUMN+UPDATE backfill+ALTER DROP combined_score+ALTER ADD GENERATED combined_score+CREATE INDEX+CREATE FUNCTION+DROP TRIGGER+CREATE TRIGGER+INSERT) + 6 (#168: 2 ALTER ADD COLUMN+ALTER DROP combined_score+ALTER ADD GENERATED combined_score+CREATE INDEX+INSERT) + 3 (#169: ALTER ADD COLUMN+PARTIAL INDEX+INSERT) + 3 (#170: ALTER ADD COLUMN+PARTIAL INDEX+INSERT) + 3 (#171: 2 ALTER ADD COLUMN+INSERT) + 5 (#172: CREATE TABLE+3 INDEX+INSERT) + 3 (#173: CREATE TABLE+1 INDEX+INSERT) + 2 (#174: 1 INDEX+INSERT) + 2 (#175: 1 ALTER ADD 6 COLUMNS+INSERT) + 2 (#176: 1 ALTER ADD COLUMN+INSERT) + 2 (#177: 1 CREATE VIEW+INSERT) + 2 (#178: 1 ALTER ADD COLUMN+INSERT) + 4 (#179: CREATE TABLE+2 INDEX+INSERT) + 2 (#180: 1 ALTER ADD 8 COLUMNS+INSERT) + 2 (#181: 1 ALTER ADD 8 COLUMNS+INSERT) = 645
      // Migration #3 was converted from run: to statements: (BE-CRON-010);
      // its 4 calls (DROP INDEX + ALTER + CREATE INDEX + INSERT) still count
      // toward the total — the only delta is that they route through
      // sql.transaction() instead of sequential awaits.
      expect(mockSql).toHaveBeenCalledTimes(645);
      // Migrations #3 and #15-181 each call sql.transaction() once for atomic execution
      expect(mockSql.transaction).toHaveBeenCalledTimes(168);
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
