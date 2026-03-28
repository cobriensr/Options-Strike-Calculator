/**
 * Postgres database helper using Neon serverless driver.
 *
 * Four tables:
 *   market_snapshots — complete calculator state at each date+time (UNIQUE)
 *   analyses         — Claude chart analysis responses (linked to snapshots)
 *   outcomes         — end-of-day settlement data (for future backtesting)
 *   positions        — live Schwab SPX 0DTE positions (linked to snapshots)
 *
 * Setup:
 *   1. Add Neon Postgres from Vercel Marketplace (Storage tab → Connect Database → Neon)
 *   2. This auto-creates DATABASE_URL env var
 *   3. Run `vercel env pull .env.local` to get it locally
 *   4. Call POST /api/journal/init once to create all tables
 *
 * Install: npm install @neondatabase/serverless
 *
 * Domain logic is split into focused modules:
 *   db-snapshots.ts  — saveSnapshot, getVixOhlcFromSnapshots
 *   db-analyses.ts   — saveAnalysis, saveOutcome, getPreviousRecommendation
 *   db-flow.ts       — flow data, Greek exposure, spot GEX queries + formatters
 *   db-positions.ts  — savePositions, getLatestPositions
 *
 * This file re-exports everything so existing imports from './db.js' still work.
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

let _db: NeonQueryFunction<false, false> | null = null;

export function getDb() {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL not configured');
    _db = neon(url);
  }
  return _db;
}

/** Reset the cached client. Exported for tests only. */
export function _resetDb() {
  _db = null;
}

// ============================================================
// SCHEMA INITIALIZATION
// ============================================================

export async function initDb() {
  const sql = getDb();

  // ── Market Snapshots ──────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS market_snapshots (
      id                        SERIAL PRIMARY KEY,
      date                      DATE NOT NULL,
      entry_time                TEXT NOT NULL,

      -- Prices
      spx                       DECIMAL(10,2),
      spy                       DECIMAL(8,2),
      spx_open                  DECIMAL(10,2),
      spx_high                  DECIMAL(10,2),
      spx_low                   DECIMAL(10,2),
      prev_close                DECIMAL(10,2),

      -- Volatility surface
      vix                       DECIMAL(6,2),
      vix1d                     DECIMAL(6,2),
      vix9d                     DECIMAL(6,2),
      vvix                      DECIMAL(6,2),
      vix1d_vix_ratio           DECIMAL(6,4),
      vix_vix9d_ratio           DECIMAL(6,4),

      -- Calculator inputs
      sigma                     DECIMAL(8,6),
      sigma_source              TEXT,
      t_years                   DECIMAL(10,8),
      hours_remaining           DECIMAL(6,2),
      skew_pct                  DECIMAL(4,2),

      -- Regime signals
      regime_zone               TEXT,
      cluster_mult              DECIMAL(6,4),
      dow_mult_hl               DECIMAL(6,4),
      dow_mult_oc               DECIMAL(6,4),
      dow_label                 TEXT,

      -- Delta guide outputs
      ic_ceiling                INTEGER,
      put_spread_ceiling        INTEGER,
      call_spread_ceiling       INTEGER,
      moderate_delta            INTEGER,
      conservative_delta        INTEGER,

      -- Range thresholds
      median_oc_pct             DECIMAL(6,4),
      median_hl_pct             DECIMAL(6,4),
      p90_oc_pct                DECIMAL(6,4),
      p90_hl_pct                DECIMAL(6,4),
      p90_oc_pts                INTEGER,
      p90_hl_pts                INTEGER,

      -- Opening range
      opening_range_available   BOOLEAN,
      opening_range_high        DECIMAL(10,2),
      opening_range_low         DECIMAL(10,2),
      opening_range_pct_consumed DECIMAL(6,4),
      opening_range_signal      TEXT,

      -- VIX term structure
      vix_term_signal           TEXT,

      -- Overnight context
      overnight_gap             DECIMAL(6,2),

      -- Strike distances at each delta
      strikes                   JSONB,

      -- Event flags
      is_early_close            BOOLEAN DEFAULT FALSE,
      is_event_day              BOOLEAN DEFAULT FALSE,
      event_names               TEXT[],

      is_backtest               BOOLEAN DEFAULT FALSE,
      created_at                TIMESTAMPTZ DEFAULT NOW(),

      UNIQUE(date, entry_time)
    )
  `;

  // ── Analyses ──────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS analyses (
      id              SERIAL PRIMARY KEY,
      snapshot_id     INTEGER REFERENCES market_snapshots(id),
      date            DATE NOT NULL,
      entry_time      TEXT NOT NULL,
      mode            TEXT NOT NULL,
      structure       TEXT NOT NULL,
      confidence      TEXT NOT NULL,
      suggested_delta INTEGER NOT NULL,
      spx             DECIMAL(10,2),
      vix             DECIMAL(6,2),
      vix1d           DECIMAL(6,2),
      hedge           TEXT,
      full_response   JSONB NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // ── Outcomes ──────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS outcomes (
      id              SERIAL PRIMARY KEY,
      date            DATE NOT NULL UNIQUE,
      settlement      DECIMAL(10,2),
      day_open        DECIMAL(10,2),
      day_high        DECIMAL(10,2),
      day_low         DECIMAL(10,2),
      day_range_pts   INTEGER,
      day_range_pct   DECIMAL(6,4),
      close_vs_open   DECIMAL(10,2),
      vix_close       DECIMAL(6,2),
      vix1d_close     DECIMAL(6,2),
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // ── Positions (live Schwab 0DTE SPX positions) ─────────
  await sql`
    CREATE TABLE IF NOT EXISTS positions (
      id              SERIAL PRIMARY KEY,
      snapshot_id     INTEGER REFERENCES market_snapshots(id),
      date            DATE NOT NULL,
      fetch_time      TEXT NOT NULL,
      account_hash    TEXT NOT NULL,
      spx_price       DECIMAL(10,2),

      -- Structured summary for Claude prompt context
      summary         TEXT NOT NULL,

      -- Raw position legs as JSONB array
      legs            JSONB NOT NULL,

      -- Aggregate stats
      total_spreads   INTEGER DEFAULT 0,
      call_spreads    INTEGER DEFAULT 0,
      put_spreads     INTEGER DEFAULT 0,
      net_delta       DECIMAL(8,4),
      net_theta       DECIMAL(8,4),
      net_gamma       DECIMAL(8,6),
      total_credit    DECIMAL(10,2),
      current_value   DECIMAL(10,2),
      unrealized_pnl  DECIMAL(10,2),

      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(date, fetch_time)
    )
  `;

  // ── Indexes ───────────────────────────────────────────────
  await sql`CREATE INDEX IF NOT EXISTS idx_snapshots_date ON market_snapshots (date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_analyses_date ON analyses (date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_analyses_structure ON analyses (structure)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_analyses_confidence ON analyses (confidence)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_analyses_snapshot ON analyses (snapshot_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_outcomes_date ON outcomes (date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_positions_date ON positions (date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_positions_snapshot ON positions (snapshot_id)`;
}

// ============================================================
// MIGRATIONS
// ============================================================

/**
 * Each migration is a numbered entry with a description and SQL function.
 * Migrations run in order and are tracked in a `schema_migrations` table
 * so each is applied at most once. Add new migrations to the end of the array.
 */
interface Migration {
  id: number;
  description: string;
  run: (sql: ReturnType<typeof getDb>) => Promise<void>;
}

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    description: 'Create positions table and indexes',
    run: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS positions (
          id              SERIAL PRIMARY KEY,
          snapshot_id     INTEGER REFERENCES market_snapshots(id),
          date            DATE NOT NULL,
          fetch_time      TEXT NOT NULL,
          account_hash    TEXT NOT NULL,
          spx_price       DECIMAL(10,2),
          summary         TEXT NOT NULL,
          legs            JSONB NOT NULL,
          total_spreads   INTEGER DEFAULT 0,
          call_spreads    INTEGER DEFAULT 0,
          put_spreads     INTEGER DEFAULT 0,
          net_delta       DECIMAL(8,4),
          net_theta       DECIMAL(8,4),
          net_gamma       DECIMAL(8,6),
          total_credit    DECIMAL(10,2),
          current_value   DECIMAL(10,2),
          unrealized_pnl  DECIMAL(10,2),
          created_at      TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(date, fetch_time)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_positions_date ON positions (date)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_positions_snapshot ON positions (snapshot_id)`;
    },
  },
  {
    id: 2,
    description: 'Create lessons and lesson_reports tables with pgvector',
    run: async (sql) => {
      await sql`CREATE EXTENSION IF NOT EXISTS vector`;

      await sql`
        CREATE TABLE IF NOT EXISTS lessons (
          id                  SERIAL PRIMARY KEY,
          text                TEXT NOT NULL,
          status              TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'superseded', 'archived')),
          superseded_by       INTEGER REFERENCES lessons(id),
          source_analysis_id  INTEGER REFERENCES analyses(id) ON DELETE RESTRICT,
          source_date         DATE NOT NULL,
          market_conditions   JSONB,
          tags                TEXT[],
          category            TEXT CHECK (category IN (
                                'regime', 'flow', 'gamma', 'management', 'entry', 'sizing'
                              )),
          embedding           vector(2000) NOT NULL,
          created_at          TIMESTAMPTZ DEFAULT NOW(),
          superseded_at       TIMESTAMPTZ,
          UNIQUE (source_analysis_id, text)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_lessons_status ON lessons (status)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_lessons_source ON lessons (source_analysis_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_lessons_source_date ON lessons (source_date)`;
      // HNSW index created in migration #3 after column is resized to vector(2000)

      await sql`
        CREATE TABLE IF NOT EXISTS lesson_reports (
          id                  SERIAL PRIMARY KEY,
          week_ending         DATE NOT NULL UNIQUE,
          reviews_processed   INTEGER DEFAULT 0,
          lessons_added       INTEGER DEFAULT 0,
          lessons_superseded  INTEGER DEFAULT 0,
          lessons_skipped     INTEGER DEFAULT 0,
          report              JSONB NOT NULL DEFAULT '{}',
          error               TEXT,
          created_at          TIMESTAMPTZ DEFAULT NOW()
        )
      `;
    },
  },
  {
    id: 3,
    description:
      'Reduce lessons embedding from vector(3072) to vector(2000) for HNSW compatibility',
    run: async (sql) => {
      // Drop the HNSW index if it exists (migration #2 may have failed on index creation)
      await sql`DROP INDEX IF EXISTS idx_lessons_embedding`;
      // Change column type from vector(3072) to vector(2000)
      await sql`ALTER TABLE lessons ALTER COLUMN embedding TYPE vector(2000)`;
      // Re-create the HNSW index with the new dimension
      await sql`CREATE INDEX IF NOT EXISTS idx_lessons_embedding ON lessons USING hnsw (embedding vector_cosine_ops)`;
    },
  },
  {
    id: 4,
    description: 'Create flow_data table for UW API time series',
    run: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS flow_data (
          id          SERIAL PRIMARY KEY,
          date        DATE NOT NULL,
          timestamp   TIMESTAMPTZ NOT NULL,
          source      TEXT NOT NULL,
          ncp         DECIMAL(14,2),
          npp         DECIMAL(14,2),
          net_volume  INTEGER,
          created_at  TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(date, timestamp, source)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_flow_data_date_source ON flow_data (date, source)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_flow_data_timestamp ON flow_data (timestamp)`;
    },
  },
  {
    id: 5,
    description: 'Create greek_exposure table for MM Greek exposure by expiry',
    run: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS greek_exposure (
          id          SERIAL PRIMARY KEY,
          date        DATE NOT NULL,
          ticker      TEXT NOT NULL,
          expiry      DATE NOT NULL,
          dte         INTEGER,
          call_gamma  DECIMAL(20,4),
          put_gamma   DECIMAL(20,4),
          call_charm  DECIMAL(20,4),
          put_charm   DECIMAL(20,4),
          call_delta  DECIMAL(20,4),
          put_delta   DECIMAL(20,4),
          call_vanna  DECIMAL(20,4),
          put_vanna   DECIMAL(20,4),
          created_at  TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(date, ticker, expiry)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_greek_exposure_date_ticker ON greek_exposure (date, ticker)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_greek_exposure_expiry ON greek_exposure (expiry)`;
    },
  },
  {
    id: 6,
    description: 'Add dte to greek_exposure unique constraint',
    run: async (sql) => {
      await sql`ALTER TABLE greek_exposure DROP CONSTRAINT IF EXISTS greek_exposure_date_ticker_expiry_key`;
      await sql`ALTER TABLE greek_exposure ADD CONSTRAINT greek_exposure_date_ticker_expiry_dte_key UNIQUE(date, ticker, expiry, dte)`;
    },
  },
  {
    id: 7,
    description: 'Create spot_exposures table for intraday GEX panel data',
    run: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS spot_exposures (
          id              SERIAL PRIMARY KEY,
          date            DATE NOT NULL,
          timestamp       TIMESTAMPTZ NOT NULL,
          ticker          TEXT NOT NULL DEFAULT 'SPX',
          price           DECIMAL(10,2),
          gamma_oi        DECIMAL(20,4),
          gamma_vol       DECIMAL(20,4),
          gamma_dir       DECIMAL(20,4),
          charm_oi        DECIMAL(20,4),
          charm_vol       DECIMAL(20,4),
          charm_dir       DECIMAL(20,4),
          vanna_oi        DECIMAL(20,4),
          vanna_vol       DECIMAL(20,4),
          vanna_dir       DECIMAL(20,4),
          created_at      TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(date, timestamp, ticker)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_spot_exposures_date_ticker ON spot_exposures (date, ticker)`;
    },
  },
  {
    id: 8,
    description: 'Create strike_exposures table for per-strike Greek profile',
    run: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS strike_exposures (
          id              SERIAL PRIMARY KEY,
          date            DATE NOT NULL,
          timestamp       TIMESTAMPTZ NOT NULL,
          ticker          TEXT NOT NULL DEFAULT 'SPX',
          expiry          DATE,
          strike          DECIMAL(10,2) NOT NULL,
          price           DECIMAL(10,2),
          call_gamma_oi   DECIMAL(20,4),
          put_gamma_oi    DECIMAL(20,4),
          call_gamma_ask  DECIMAL(20,4),
          call_gamma_bid  DECIMAL(20,4),
          put_gamma_ask   DECIMAL(20,4),
          put_gamma_bid   DECIMAL(20,4),
          call_charm_oi   DECIMAL(20,4),
          put_charm_oi    DECIMAL(20,4),
          call_charm_ask  DECIMAL(20,4),
          call_charm_bid  DECIMAL(20,4),
          put_charm_ask   DECIMAL(20,4),
          put_charm_bid   DECIMAL(20,4),
          call_delta_oi   DECIMAL(20,4),
          put_delta_oi    DECIMAL(20,4),
          call_vanna_oi   DECIMAL(20,4),
          put_vanna_oi    DECIMAL(20,4),
          created_at      TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(date, timestamp, ticker, strike, expiry)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_strike_exp_date_ticker ON strike_exposures (date, ticker)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_strike_exp_expiry ON strike_exposures (expiry)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_strike_exp_timestamp ON strike_exposures (timestamp)`;
    },
  },
  {
    id: 9,
    description: 'Create training_features table for daily ML feature vectors',
    run: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS training_features (
          date                    DATE PRIMARY KEY,

          -- Static features (from market_snapshots)
          vix                     DECIMAL(6,2),
          vix1d                   DECIMAL(6,2),
          vix9d                   DECIMAL(6,2),
          vvix                    DECIMAL(6,2),
          vix1d_vix_ratio         DECIMAL(6,4),
          vix_vix9d_ratio         DECIMAL(6,4),
          regime_zone             TEXT,
          cluster_mult            DECIMAL(6,4),
          dow_mult                DECIMAL(6,4),
          dow_label               TEXT,
          spx_open                DECIMAL(10,2),
          sigma                   DECIMAL(8,6),
          hours_remaining         DECIMAL(6,2),
          ic_ceiling              INTEGER,
          put_spread_ceiling      INTEGER,
          call_spread_ceiling     INTEGER,
          opening_range_signal    TEXT,
          opening_range_pct_consumed DECIMAL(6,4),
          day_of_week             INTEGER,
          is_friday               BOOLEAN,
          is_event_day            BOOLEAN,

          -- Flow checkpoint features (T1-T8)
          -- Market Tide
          mt_ncp_t1 DECIMAL(14,2), mt_npp_t1 DECIMAL(14,2),
          mt_ncp_t2 DECIMAL(14,2), mt_npp_t2 DECIMAL(14,2),
          mt_ncp_t3 DECIMAL(14,2), mt_npp_t3 DECIMAL(14,2),
          mt_ncp_t4 DECIMAL(14,2), mt_npp_t4 DECIMAL(14,2),
          -- SPX Net Flow
          spx_ncp_t1 DECIMAL(14,2), spx_npp_t1 DECIMAL(14,2),
          spx_ncp_t2 DECIMAL(14,2), spx_npp_t2 DECIMAL(14,2),
          spx_ncp_t3 DECIMAL(14,2), spx_npp_t3 DECIMAL(14,2),
          spx_ncp_t4 DECIMAL(14,2), spx_npp_t4 DECIMAL(14,2),
          -- SPY Net Flow
          spy_ncp_t1 DECIMAL(14,2), spy_npp_t1 DECIMAL(14,2),
          spy_ncp_t2 DECIMAL(14,2), spy_npp_t2 DECIMAL(14,2),
          -- QQQ Net Flow
          qqq_ncp_t1 DECIMAL(14,2), qqq_npp_t1 DECIMAL(14,2),
          qqq_ncp_t2 DECIMAL(14,2), qqq_npp_t2 DECIMAL(14,2),
          -- ETF Tide
          spy_etf_ncp_t1 DECIMAL(14,2), spy_etf_npp_t1 DECIMAL(14,2),
          spy_etf_ncp_t2 DECIMAL(14,2), spy_etf_npp_t2 DECIMAL(14,2),
          qqq_etf_ncp_t1 DECIMAL(14,2), qqq_etf_npp_t1 DECIMAL(14,2),
          qqq_etf_ncp_t2 DECIMAL(14,2), qqq_etf_npp_t2 DECIMAL(14,2),
          -- 0DTE flows
          zero_dte_ncp_t1 DECIMAL(14,2), zero_dte_npp_t1 DECIMAL(14,2),
          zero_dte_ncp_t2 DECIMAL(14,2), zero_dte_npp_t2 DECIMAL(14,2),
          delta_flow_total_t1 DECIMAL(14,2), delta_flow_dir_t1 DECIMAL(14,2),
          delta_flow_total_t2 DECIMAL(14,2), delta_flow_dir_t2 DECIMAL(14,2),

          -- Aggregated flow features
          flow_agreement_t1       INTEGER,
          flow_agreement_t2       INTEGER,
          etf_tide_divergence_t1  BOOLEAN,
          etf_tide_divergence_t2  BOOLEAN,
          ncp_npp_gap_spx_t1      DECIMAL(14,2),
          ncp_npp_gap_spx_t2      DECIMAL(14,2),

          -- GEX checkpoint features (from spot_exposures)
          gex_oi_t1 DECIMAL(20,4), gex_oi_t2 DECIMAL(20,4),
          gex_oi_t3 DECIMAL(20,4), gex_oi_t4 DECIMAL(20,4),
          gex_vol_t1 DECIMAL(20,4), gex_vol_t2 DECIMAL(20,4),
          gex_dir_t1 DECIMAL(20,4), gex_dir_t2 DECIMAL(20,4),
          gex_oi_slope            DECIMAL(20,4),
          charm_oi_t1 DECIMAL(20,4), charm_oi_t2 DECIMAL(20,4),

          -- Greek exposure features
          agg_net_gamma           DECIMAL(20,4),
          dte0_net_charm          DECIMAL(20,4),
          dte0_charm_pct          DECIMAL(6,4),

          -- Per-strike engineered features
          gamma_wall_above_dist   DECIMAL(10,2),
          gamma_wall_above_mag    DECIMAL(20,4),
          gamma_wall_below_dist   DECIMAL(10,2),
          gamma_wall_below_mag    DECIMAL(20,4),
          neg_gamma_nearest_dist  DECIMAL(10,2),
          neg_gamma_nearest_mag   DECIMAL(20,4),
          gamma_asymmetry         DECIMAL(10,4),
          charm_slope             DECIMAL(20,4),
          charm_max_pos_dist      DECIMAL(10,2),
          charm_max_neg_dist      DECIMAL(10,2),
          gamma_0dte_allexp_agree BOOLEAN,
          charm_pattern           TEXT,

          -- Metadata
          feature_completeness    DECIMAL(4,2),
          created_at              TIMESTAMPTZ DEFAULT NOW()
        )
      `;
    },
  },
  {
    id: 10,
    description: 'Create day_labels table for ML labels extracted from reviews',
    run: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS day_labels (
          date                    DATE PRIMARY KEY,
          analysis_id             INTEGER REFERENCES analyses(id),

          -- From review JSON
          structure_correct       BOOLEAN,
          recommended_structure   TEXT,
          confidence              TEXT,
          suggested_delta         INTEGER,

          -- Chart confidence signals
          charm_diverged          BOOLEAN,
          naive_charm_signal      TEXT,
          spx_flow_signal         TEXT,
          market_tide_signal      TEXT,
          spy_flow_signal         TEXT,
          gex_signal              TEXT,

          -- Derived from outcomes + features
          flow_was_directional    BOOLEAN,
          settlement_direction    TEXT,
          range_category          TEXT,

          label_completeness      DECIMAL(4,2),
          created_at              TIMESTAMPTZ DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_day_labels_analysis ON day_labels (analysis_id)`;
    },
  },
  {
    id: 11,
    description:
      'Create economic_events table and add Phase 2 features to training_features',
    run: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS economic_events (
          id              SERIAL PRIMARY KEY,
          date            DATE NOT NULL,
          event_name      TEXT NOT NULL,
          event_time      TIMESTAMPTZ,
          event_type      TEXT NOT NULL,
          forecast        TEXT,
          previous        TEXT,
          reported_period TEXT,
          created_at      TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(date, event_name, event_time)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_economic_events_date ON economic_events(date)`;
      await sql`
        ALTER TABLE training_features
          ADD COLUMN IF NOT EXISTS prev_day_range_pts   DECIMAL(10,2),
          ADD COLUMN IF NOT EXISTS prev_day_direction   TEXT,
          ADD COLUMN IF NOT EXISTS prev_day_vix_change  DECIMAL(6,2),
          ADD COLUMN IF NOT EXISTS prev_day_range_cat   TEXT,
          ADD COLUMN IF NOT EXISTS realized_vol_5d      DECIMAL(10,6),
          ADD COLUMN IF NOT EXISTS realized_vol_10d     DECIMAL(10,6),
          ADD COLUMN IF NOT EXISTS rv_iv_ratio          DECIMAL(6,4),
          ADD COLUMN IF NOT EXISTS vix_term_slope       DECIMAL(6,4),
          ADD COLUMN IF NOT EXISTS vvix_percentile      DECIMAL(5,4),
          ADD COLUMN IF NOT EXISTS event_type           TEXT,
          ADD COLUMN IF NOT EXISTS is_fomc              BOOLEAN,
          ADD COLUMN IF NOT EXISTS is_opex              BOOLEAN,
          ADD COLUMN IF NOT EXISTS days_to_next_event   INTEGER,
          ADD COLUMN IF NOT EXISTS event_count          INTEGER
      `;
    },
  },
  {
    id: 12,
    description:
      'Create es_bars table for ES futures 1-minute OHLCV bars from sidecar',
    run: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS es_bars (
          id          BIGSERIAL PRIMARY KEY,
          symbol      TEXT NOT NULL DEFAULT 'ES',
          ts          TIMESTAMPTZ NOT NULL,
          open        NUMERIC(10,2) NOT NULL,
          high        NUMERIC(10,2) NOT NULL,
          low         NUMERIC(10,2) NOT NULL,
          close       NUMERIC(10,2) NOT NULL,
          volume      INTEGER NOT NULL DEFAULT 0,
          tick_count  INTEGER NOT NULL DEFAULT 0,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_es_bars_sym_ts
        ON es_bars (symbol, ts)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_es_bars_ts
        ON es_bars (ts DESC)
      `;
    },
  },
  {
    id: 13,
    description:
      'Create es_overnight_summaries table for pre-computed overnight ES metrics',
    run: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS es_overnight_summaries (
          id                  SERIAL PRIMARY KEY,
          trade_date          DATE NOT NULL UNIQUE,
          globex_open         NUMERIC(10,2),
          globex_high         NUMERIC(10,2),
          globex_low          NUMERIC(10,2),
          globex_close        NUMERIC(10,2),
          vwap                NUMERIC(10,2),
          total_volume        INTEGER,
          bar_count           INTEGER,
          range_pts           NUMERIC(10,2),
          range_pct           NUMERIC(6,4),
          cash_open           NUMERIC(10,2),
          prev_cash_close     NUMERIC(10,2),
          gap_pts             NUMERIC(10,2),
          gap_pct             NUMERIC(6,4),
          gap_direction       TEXT,
          gap_size_class      TEXT,
          cash_open_pct_rank  NUMERIC(6,2),
          position_class      TEXT,
          vol_20d_avg         INTEGER,
          vol_ratio           NUMERIC(6,2),
          vol_class           TEXT,
          gap_vs_vwap_pts     NUMERIC(10,2),
          vwap_signal         TEXT,
          fill_score          INTEGER,
          fill_probability    TEXT,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
    },
  },
  {
    id: 14,
    description: 'Add pre_market_data JSONB column to market_snapshots',
    run: async (sql) => {
      await sql`
        ALTER TABLE market_snapshots
        ADD COLUMN IF NOT EXISTS pre_market_data jsonb
      `;
    },
  },
  {
    id: 15,
    description:
      'Add composite index on analyses (date, created_at DESC) for getPreviousRecommendation',
    run: async (sql) => {
      await sql`CREATE INDEX IF NOT EXISTS idx_analyses_date_created ON analyses (date, created_at DESC)`;
    },
  },
  {
    id: 16,
    description:
      'Add composite index on flow_data (date, source, timestamp) for time-windowed queries',
    run: async (sql) => {
      await sql`CREATE INDEX IF NOT EXISTS idx_flow_data_date_source_ts ON flow_data (date, source, timestamp)`;
    },
  },
  {
    id: 17,
    description: 'Add NOT NULL constraint to all created_at columns',
    run: async (sql) => {

      await sql`ALTER TABLE market_snapshots ALTER COLUMN created_at SET NOT NULL`;
      await sql`ALTER TABLE analyses ALTER COLUMN created_at SET NOT NULL`;
      await sql`ALTER TABLE outcomes ALTER COLUMN created_at SET NOT NULL`;
      await sql`ALTER TABLE positions ALTER COLUMN created_at SET NOT NULL`;
      await sql`ALTER TABLE lessons ALTER COLUMN created_at SET NOT NULL`;
      await sql`ALTER TABLE lesson_reports ALTER COLUMN created_at SET NOT NULL`;
      await sql`ALTER TABLE flow_data ALTER COLUMN created_at SET NOT NULL`;
      await sql`ALTER TABLE greek_exposure ALTER COLUMN created_at SET NOT NULL`;
      await sql`ALTER TABLE spot_exposures ALTER COLUMN created_at SET NOT NULL`;
      await sql`ALTER TABLE strike_exposures ALTER COLUMN created_at SET NOT NULL`;
      await sql`ALTER TABLE economic_events ALTER COLUMN created_at SET NOT NULL`;
      await sql`ALTER TABLE es_overnight_summaries ALTER COLUMN created_at SET NOT NULL`;
    },
  },
  {
    id: 18,
    description: 'Add JSONB type constraints on legs, full_response, and report',
    run: async (sql) => {
      await sql`ALTER TABLE positions ADD CONSTRAINT chk_legs_array CHECK (jsonb_typeof(legs) = 'array')`;
      await sql`ALTER TABLE analyses ADD CONSTRAINT chk_full_response_obj CHECK (jsonb_typeof(full_response) = 'object')`;
      await sql`ALTER TABLE lesson_reports ADD CONSTRAINT chk_report_obj CHECK (jsonb_typeof(report) = 'object')`;
    },
  },
];

/**
 * Run pending database migrations.
 * Creates a `schema_migrations` table to track applied migrations.
 * Safe to call multiple times — already-applied migrations are skipped.
 * Returns an array of descriptions for newly applied migrations.
 */
export async function migrateDb(): Promise<string[]> {
  const sql = getDb();

  // Ensure the tracking table exists
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // Find which migrations have already been applied
  const rows = await sql`SELECT id FROM schema_migrations`;
  const appliedIds = new Set(rows.map((r) => r.id as number));

  const applied: string[] = [];
  for (const migration of MIGRATIONS) {
    if (appliedIds.has(migration.id)) continue;

    await migration.run(sql);
    await sql`
      INSERT INTO schema_migrations (id, description) VALUES (${migration.id}, ${migration.description})
    `;
    applied.push(`#${migration.id}: ${migration.description}`);
  }

  return applied;
}

// ============================================================
// RE-EXPORTS (so existing imports from './db.js' still work)
// ============================================================

export * from './db-snapshots.js';
export * from './db-analyses.js';
export * from './db-flow.js';
export * from './db-positions.js';
