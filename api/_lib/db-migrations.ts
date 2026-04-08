/**
 * Database migrations for the 0DTE SPX Strike Calculator.
 *
 * Each migration is a numbered entry with a description and SQL function.
 * Migrations run in order and are tracked in a `schema_migrations` table
 * so each is applied at most once. Add new migrations to the end of the array.
 *
 * Consumed by migrateDb() in db.ts.
 */

import { getDb } from './db.js';

export interface Migration {
  id: number;
  description: string;
  /** Legacy sequential execution. Use `statements` for new migrations. */
  run?: (sql: ReturnType<typeof getDb>) => Promise<void>;
  /**
   * Return an array of query promises for atomic execution.
   * migrateDb() wraps these + the tracking INSERT in a single
   * sql.transaction() — all-or-nothing. Prefer this for new migrations.
   */
  statements?: (
    sql: ReturnType<typeof getDb>,
  ) => ReturnType<ReturnType<typeof getDb>>[];
}

export const MIGRATIONS: Migration[] = [
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
    statements: (sql) => [
      sql`CREATE INDEX IF NOT EXISTS idx_analyses_date_created ON analyses (date, created_at DESC)`,
    ],
  },
  {
    id: 16,
    description:
      'Add composite index on flow_data (date, source, timestamp) for time-windowed queries',
    statements: (sql) => [
      sql`CREATE INDEX IF NOT EXISTS idx_flow_data_date_source_ts ON flow_data (date, source, timestamp)`,
    ],
  },
  {
    id: 17,
    description: 'Add NOT NULL constraint to all created_at columns',
    statements: (sql) => [
      sql`ALTER TABLE market_snapshots ALTER COLUMN created_at SET NOT NULL`,
      sql`ALTER TABLE analyses ALTER COLUMN created_at SET NOT NULL`,
      sql`ALTER TABLE outcomes ALTER COLUMN created_at SET NOT NULL`,
      sql`ALTER TABLE positions ALTER COLUMN created_at SET NOT NULL`,
      sql`ALTER TABLE lessons ALTER COLUMN created_at SET NOT NULL`,
      sql`ALTER TABLE lesson_reports ALTER COLUMN created_at SET NOT NULL`,
      sql`ALTER TABLE flow_data ALTER COLUMN created_at SET NOT NULL`,
      sql`ALTER TABLE greek_exposure ALTER COLUMN created_at SET NOT NULL`,
      sql`ALTER TABLE spot_exposures ALTER COLUMN created_at SET NOT NULL`,
      sql`ALTER TABLE strike_exposures ALTER COLUMN created_at SET NOT NULL`,
      sql`ALTER TABLE economic_events ALTER COLUMN created_at SET NOT NULL`,
      sql`ALTER TABLE es_overnight_summaries ALTER COLUMN created_at SET NOT NULL`,
    ],
  },
  {
    id: 18,
    description:
      'Add JSONB type constraints on legs, full_response, and report',
    statements: (sql) => [
      sql`ALTER TABLE positions DROP CONSTRAINT IF EXISTS chk_legs_array`,
      sql`ALTER TABLE positions ADD CONSTRAINT chk_legs_array CHECK (jsonb_typeof(legs) = 'array')`,
      sql`ALTER TABLE analyses DROP CONSTRAINT IF EXISTS chk_full_response_obj`,
      sql`ALTER TABLE analyses ADD CONSTRAINT chk_full_response_obj CHECK (jsonb_typeof(full_response) = 'object')`,
      sql`ALTER TABLE lesson_reports DROP CONSTRAINT IF EXISTS chk_report_obj`,
      sql`ALTER TABLE lesson_reports ADD CONSTRAINT chk_report_obj CHECK (jsonb_typeof(report) = 'object')`,
    ],
  },
  {
    id: 19,
    description: 'Create predictions table for ML model outputs',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS predictions (
          date              DATE PRIMARY KEY,
          ccs_prob          NUMERIC(5,4),
          pcs_prob          NUMERIC(5,4),
          ic_prob           NUMERIC(5,4),
          sit_out_prob      NUMERIC(5,4),
          predicted_class   TEXT,
          model_version     TEXT NOT NULL,
          feature_count     INTEGER,
          top_features      JSONB,
          created_at        TIMESTAMPTZ DEFAULT NOW()
        )
      `,
    ],
  },
  {
    id: 20,
    description: 'Create dark_pool_snapshots table for persisted cluster data',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS dark_pool_snapshots (
          id          SERIAL PRIMARY KEY,
          date        DATE NOT NULL,
          timestamp   TIMESTAMPTZ NOT NULL,
          snapshot_id INTEGER REFERENCES market_snapshots(id),
          spx_price   DECIMAL(10,2),
          clusters    JSONB NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(date, timestamp)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_dp_snapshots_date
        ON dark_pool_snapshots (date)
      `,
    ],
  },
  {
    id: 21,
    description: 'Add dark pool feature columns to training_features',
    statements: (sql) => [
      sql`
        ALTER TABLE training_features
          ADD COLUMN IF NOT EXISTS dp_total_premium    DECIMAL(14,2),
          ADD COLUMN IF NOT EXISTS dp_buyer_initiated  INTEGER,
          ADD COLUMN IF NOT EXISTS dp_seller_initiated INTEGER,
          ADD COLUMN IF NOT EXISTS dp_net_bias         TEXT,
          ADD COLUMN IF NOT EXISTS dp_cluster_count    INTEGER,
          ADD COLUMN IF NOT EXISTS dp_top_cluster_dist DECIMAL(10,2),
          ADD COLUMN IF NOT EXISTS dp_support_premium  DECIMAL(14,2),
          ADD COLUMN IF NOT EXISTS dp_resistance_premium DECIMAL(14,2)
      `,
    ],
  },
  {
    id: 22,
    description: 'Add max pain columns to training_features',
    statements: (sql) => [
      sql`
        ALTER TABLE training_features
          ADD COLUMN IF NOT EXISTS max_pain_0dte  DECIMAL(10,2),
          ADD COLUMN IF NOT EXISTS max_pain_dist  DECIMAL(10,2)
      `,
    ],
  },
  {
    id: 23,
    description: 'Create oi_per_strike table for daily open interest by strike',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS oi_per_strike (
          id            SERIAL PRIMARY KEY,
          date          DATE NOT NULL,
          strike        DECIMAL(10,2) NOT NULL,
          call_oi       INTEGER,
          put_oi        INTEGER,
          total_oi      INTEGER GENERATED ALWAYS AS (COALESCE(call_oi, 0) + COALESCE(put_oi, 0)) STORED,
          created_at    TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(date, strike)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_oi_per_strike_date ON oi_per_strike(date)
      `,
    ],
  },
  {
    id: 24,
    description:
      'Add options volume/premium feature columns to training_features',
    statements: (sql) => [
      sql`
        ALTER TABLE training_features
          ADD COLUMN IF NOT EXISTS opt_call_volume       INTEGER,
          ADD COLUMN IF NOT EXISTS opt_put_volume        INTEGER,
          ADD COLUMN IF NOT EXISTS opt_call_oi           INTEGER,
          ADD COLUMN IF NOT EXISTS opt_put_oi            INTEGER,
          ADD COLUMN IF NOT EXISTS opt_call_premium      DECIMAL(14,2),
          ADD COLUMN IF NOT EXISTS opt_put_premium       DECIMAL(14,2),
          ADD COLUMN IF NOT EXISTS opt_bullish_premium   DECIMAL(14,2),
          ADD COLUMN IF NOT EXISTS opt_bearish_premium   DECIMAL(14,2),
          ADD COLUMN IF NOT EXISTS opt_call_vol_ask      INTEGER,
          ADD COLUMN IF NOT EXISTS opt_put_vol_bid       INTEGER,
          ADD COLUMN IF NOT EXISTS opt_vol_pcr           DECIMAL(6,4),
          ADD COLUMN IF NOT EXISTS opt_oi_pcr            DECIMAL(6,4),
          ADD COLUMN IF NOT EXISTS opt_premium_ratio     DECIMAL(6,4),
          ADD COLUMN IF NOT EXISTS opt_call_vol_vs_avg30 DECIMAL(6,4),
          ADD COLUMN IF NOT EXISTS opt_put_vol_vs_avg30  DECIMAL(6,4)
      `,
    ],
  },
  {
    id: 25,
    description:
      'Create iv_monitor, flow_ratio_monitor, and market_alerts tables',
    statements: (sql) => [
      // ── iv_monitor: 1-minute ATM IV time series ──────────
      sql`
        CREATE TABLE IF NOT EXISTS iv_monitor (
          id           SERIAL PRIMARY KEY,
          date         DATE NOT NULL,
          timestamp    TIMESTAMPTZ NOT NULL,
          volatility   DECIMAL(8,4) NOT NULL,
          implied_move DECIMAL(8,6),
          percentile   DECIMAL(6,2),
          spx_price    DECIMAL(10,2),
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(date, timestamp)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_iv_monitor_date
          ON iv_monitor(date)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_iv_monitor_ts
          ON iv_monitor(timestamp DESC)
      `,
      // ── flow_ratio_monitor: 1-minute put/call ratio ──────
      sql`
        CREATE TABLE IF NOT EXISTS flow_ratio_monitor (
          id         SERIAL PRIMARY KEY,
          date       DATE NOT NULL,
          timestamp  TIMESTAMPTZ NOT NULL,
          abs_npp    DECIMAL(14,2) NOT NULL,
          abs_ncp    DECIMAL(14,2) NOT NULL,
          ratio      DECIMAL(8,4),
          spx_price  DECIMAL(10,2),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(date, timestamp)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_flow_ratio_date
          ON flow_ratio_monitor(date)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_flow_ratio_ts
          ON flow_ratio_monitor(timestamp DESC)
      `,
      // ── market_alerts: alert records for frontend polling ─
      sql`
        CREATE TABLE IF NOT EXISTS market_alerts (
          id             SERIAL PRIMARY KEY,
          date           DATE NOT NULL,
          timestamp      TIMESTAMPTZ NOT NULL,
          type           TEXT NOT NULL,
          severity       TEXT NOT NULL,
          direction      TEXT NOT NULL,
          title          TEXT NOT NULL,
          body           TEXT NOT NULL,
          current_values JSONB NOT NULL,
          delta_values   JSONB NOT NULL,
          acknowledged   BOOLEAN DEFAULT FALSE,
          sms_sent       BOOLEAN DEFAULT FALSE,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_market_alerts_date
          ON market_alerts(date)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_market_alerts_created
          ON market_alerts(created_at DESC)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_market_alerts_unack
          ON market_alerts(date, acknowledged)
          WHERE NOT acknowledged
      `,
    ],
  },
  {
    id: 26,
    description:
      'Add IV monitor and flow ratio monitor feature columns to training_features',
    statements: (sql) => [
      sql`
        ALTER TABLE training_features
          ADD COLUMN IF NOT EXISTS iv_open          DECIMAL(8,4),
          ADD COLUMN IF NOT EXISTS iv_max           DECIMAL(8,4),
          ADD COLUMN IF NOT EXISTS iv_range         DECIMAL(8,4),
          ADD COLUMN IF NOT EXISTS iv_crush_rate    DECIMAL(8,4),
          ADD COLUMN IF NOT EXISTS iv_spike_count   INTEGER,
          ADD COLUMN IF NOT EXISTS iv_at_t2         DECIMAL(8,4),
          ADD COLUMN IF NOT EXISTS pcr_open         DECIMAL(8,4),
          ADD COLUMN IF NOT EXISTS pcr_max          DECIMAL(8,4),
          ADD COLUMN IF NOT EXISTS pcr_min          DECIMAL(8,4),
          ADD COLUMN IF NOT EXISTS pcr_range        DECIMAL(8,4),
          ADD COLUMN IF NOT EXISTS pcr_trend_t1_t2  DECIMAL(8,4),
          ADD COLUMN IF NOT EXISTS pcr_spike_count  INTEGER
      `,
    ],
  },
  {
    id: 27,
    description:
      'Create dark_pool_levels table for cron-refreshed dark pool clusters',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS dark_pool_levels (
          id               SERIAL PRIMARY KEY,
          date             DATE NOT NULL,
          spx_approx       INTEGER NOT NULL,
          spy_price_low    DECIMAL(8,2),
          spy_price_high   DECIMAL(8,2),
          total_premium    DECIMAL(16,2) NOT NULL,
          trade_count      INTEGER NOT NULL,
          total_shares     INTEGER NOT NULL,
          buyer_initiated  INTEGER NOT NULL DEFAULT 0,
          seller_initiated INTEGER NOT NULL DEFAULT 0,
          neutral          INTEGER NOT NULL DEFAULT 0,
          latest_time      TIMESTAMPTZ,
          updated_at       TIMESTAMPTZ DEFAULT NOW()
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_dark_pool_levels_date
          ON dark_pool_levels(date)
      `,
    ],
  },
  {
    id: 28,
    description:
      'Add unique constraint on dark_pool_levels(date, spx_approx) for UPSERT',
    statements: (sql) => [
      sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dark_pool_levels_date_spx
          ON dark_pool_levels(date, spx_approx)
      `,
    ],
  },
  {
    id: 29,
    description:
      'Add dark pool support/resistance ratio and concentration to training_features',
    statements: (sql) => [
      sql`
        ALTER TABLE training_features
          ADD COLUMN IF NOT EXISTS dp_support_resistance_ratio DECIMAL(8,4),
          ADD COLUMN IF NOT EXISTS dp_concentration            DECIMAL(8,4)
      `,
    ],
  },
  {
    id: 30,
    description: 'Create oi_changes table for daily OI change data',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS oi_changes (
          id                    SERIAL PRIMARY KEY,
          date                  DATE NOT NULL,
          option_symbol         TEXT NOT NULL,
          strike                DECIMAL(10,2),
          is_call               BOOLEAN,
          oi_diff               INTEGER,
          curr_oi               INTEGER,
          last_oi               INTEGER,
          avg_price             DECIMAL(10,4),
          prev_ask_volume       INTEGER,
          prev_bid_volume       INTEGER,
          prev_multi_leg_volume INTEGER,
          prev_total_premium    DECIMAL(14,2),
          created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(date, option_symbol)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_oi_changes_date
          ON oi_changes(date)
      `,
    ],
  },
  {
    id: 31,
    description: 'Add OI change feature columns to training_features',
    statements: (sql) => [
      sql`
        ALTER TABLE training_features
          ADD COLUMN IF NOT EXISTS oic_net_oi_change        INTEGER,
          ADD COLUMN IF NOT EXISTS oic_call_oi_change       INTEGER,
          ADD COLUMN IF NOT EXISTS oic_put_oi_change        INTEGER,
          ADD COLUMN IF NOT EXISTS oic_oi_change_pcr        DECIMAL(8,4),
          ADD COLUMN IF NOT EXISTS oic_net_premium           DECIMAL(14,2),
          ADD COLUMN IF NOT EXISTS oic_call_premium          DECIMAL(14,2),
          ADD COLUMN IF NOT EXISTS oic_put_premium           DECIMAL(14,2),
          ADD COLUMN IF NOT EXISTS oic_ask_ratio             DECIMAL(8,4),
          ADD COLUMN IF NOT EXISTS oic_multi_leg_pct         DECIMAL(6,4),
          ADD COLUMN IF NOT EXISTS oic_top_strike_dist       DECIMAL(10,2),
          ADD COLUMN IF NOT EXISTS oic_concentration         DECIMAL(8,4)
      `,
    ],
  },
  {
    id: 32,
    description: 'Create vol_term_structure and vol_realized tables',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS vol_term_structure (
          id            SERIAL PRIMARY KEY,
          date          DATE NOT NULL,
          days          INTEGER NOT NULL,
          volatility    DECIMAL(8,6) NOT NULL,
          implied_move  DECIMAL(8,6),
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(date, days)
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS idx_vol_ts_date ON vol_term_structure(date)`,
      sql`
        CREATE TABLE IF NOT EXISTS vol_realized (
          id                  SERIAL PRIMARY KEY,
          date                DATE NOT NULL UNIQUE,
          iv_30d              DECIMAL(10,6),
          rv_30d              DECIMAL(10,6),
          iv_rv_spread        DECIMAL(8,4),
          iv_overpricing_pct  DECIMAL(8,4),
          iv_rank             DECIMAL(6,2),
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
    ],
  },
  {
    id: 33,
    description: 'Add vol surface feature columns to training_features',
    statements: (sql) => [
      sql`
        ALTER TABLE training_features
          ADD COLUMN IF NOT EXISTS iv_ts_slope_0d_30d    DECIMAL(8,4),
          ADD COLUMN IF NOT EXISTS iv_ts_contango        BOOLEAN,
          ADD COLUMN IF NOT EXISTS iv_ts_spread          DECIMAL(8,4),
          ADD COLUMN IF NOT EXISTS uw_rv_30d             DECIMAL(10,6),
          ADD COLUMN IF NOT EXISTS uw_iv_rv_spread       DECIMAL(8,4),
          ADD COLUMN IF NOT EXISTS uw_iv_overpricing_pct DECIMAL(8,4),
          ADD COLUMN IF NOT EXISTS iv_rank               DECIMAL(6,2)
      `,
    ],
  },
  {
    id: 34,
    description: 'Create ml_findings table for dynamic ML calibration',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS ml_findings (
          id          INTEGER PRIMARY KEY DEFAULT 1,
          findings    JSONB NOT NULL,
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT  ml_findings_singleton CHECK (id = 1)
        )
      `,
    ],
  },
  {
    id: 35,
    description:
      'Create ml_plot_analyses table for Claude vision plot analysis',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS ml_plot_analyses (
          plot_name      TEXT PRIMARY KEY,
          blob_url       TEXT NOT NULL,
          analysis       JSONB NOT NULL,
          pipeline_date  DATE NOT NULL,
          model          TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
    ],
  },
  {
    id: 36,
    description:
      'Add prompt_hash column to analyses for prompt version tracking',
    statements: (sql) => [
      sql`
        ALTER TABLE analyses
          ADD COLUMN IF NOT EXISTS prompt_hash VARCHAR(12)
      `,
    ],
  },
  {
    id: 37,
    description:
      'Add analysis_embedding vector(2000) column for historical analysis retrieval',
    statements: (sql) => [
      sql`
        ALTER TABLE analyses
          ADD COLUMN IF NOT EXISTS analysis_embedding vector(2000)
      `,
    ],
  },
  {
    id: 38,
    description:
      'Add HNSW index on analysis_embedding for cosine similarity search',
    statements: (sql) => [
      sql`
        CREATE INDEX IF NOT EXISTS idx_analyses_embedding_hnsw
          ON analyses USING hnsw (analysis_embedding vector_cosine_ops)
      `,
    ],
  },
  {
    id: 39,
    description:
      'Add composite index on iv_monitor(date, timestamp DESC) for time-windowed IV queries',
    statements: (sql) => [
      sql`CREATE INDEX IF NOT EXISTS idx_iv_monitor_date_ts ON iv_monitor(date, timestamp DESC)`,
    ],
  },
  {
    id: 40,
    description:
      'Add composite index on flow_data(date, source, timestamp DESC) for ordered flow queries',
    statements: (sql) => [
      sql`CREATE INDEX IF NOT EXISTS idx_flow_data_date_source_ts_desc ON flow_data(date, source, timestamp DESC)`,
    ],
  },
  {
    id: 41,
    description:
      'Add composite index on flow_ratio_monitor(date, timestamp DESC) for time-windowed ratio queries',
    statements: (sql) => [
      sql`CREATE INDEX IF NOT EXISTS idx_flow_ratio_date_ts ON flow_ratio_monitor(date, timestamp DESC)`,
    ],
  },
  {
    id: 42,
    description: 'Create futures_bars table and migrate es_bars data',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS futures_bars (
          id      BIGSERIAL PRIMARY KEY,
          symbol  TEXT NOT NULL,
          ts      TIMESTAMPTZ NOT NULL,
          open    NUMERIC(12,4) NOT NULL,
          high    NUMERIC(12,4) NOT NULL,
          low     NUMERIC(12,4) NOT NULL,
          close   NUMERIC(12,4) NOT NULL,
          volume  BIGINT NOT NULL DEFAULT 0,
          UNIQUE(symbol, ts)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_futures_bars_symbol_ts
          ON futures_bars (symbol, ts DESC)
      `,
      sql`
        INSERT INTO futures_bars
          (symbol, ts, open, high, low, close, volume)
        SELECT
          'ES', ts, open, high, low, close, COALESCE(volume, 0)
        FROM es_bars
        ON CONFLICT DO NOTHING
      `,
    ],
  },
  {
    id: 43,
    description:
      'Create futures_options_trades table for tick-level ES option trades',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS futures_options_trades (
          id          BIGSERIAL PRIMARY KEY,
          underlying  TEXT NOT NULL,
          expiry      DATE NOT NULL,
          strike      NUMERIC(10,2) NOT NULL,
          option_type CHAR(1) NOT NULL,
          ts          TIMESTAMPTZ NOT NULL,
          price       NUMERIC(10,4) NOT NULL,
          size        INT NOT NULL,
          side        CHAR(1) NOT NULL,
          trade_date  DATE NOT NULL
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_fot_strike_ts
          ON futures_options_trades (underlying, strike, ts DESC)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_fot_trade_date
          ON futures_options_trades (trade_date)
      `,
    ],
  },
  {
    id: 44,
    description:
      'Create futures_options_daily table for EOD statistics with exchange Greeks',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS futures_options_daily (
          id            BIGSERIAL PRIMARY KEY,
          underlying    TEXT NOT NULL,
          trade_date    DATE NOT NULL,
          expiry        DATE NOT NULL,
          strike        NUMERIC(10,2) NOT NULL,
          option_type   CHAR(1) NOT NULL,
          open_interest BIGINT,
          volume        BIGINT,
          settlement    NUMERIC(10,4),
          implied_vol   NUMERIC(8,6),
          delta         NUMERIC(8,6),
          is_final      BOOLEAN DEFAULT false,
          UNIQUE(underlying, trade_date, expiry, strike, option_type)
        )
      `,
    ],
  },
  {
    id: 45,
    description:
      'Create futures_snapshots table for computed intraday futures context',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS futures_snapshots (
          id              SERIAL PRIMARY KEY,
          trade_date      DATE NOT NULL,
          ts              TIMESTAMPTZ NOT NULL,
          symbol          TEXT NOT NULL,
          price           NUMERIC(12,4) NOT NULL,
          change_1h_pct   NUMERIC(8,4),
          change_day_pct  NUMERIC(8,4),
          volume_ratio    NUMERIC(8,4),
          UNIQUE(symbol, ts)
        )
      `,
    ],
  },
  {
    id: 46,
    description: 'Create alert_config table with default alert thresholds',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS alert_config (
          id               SERIAL PRIMARY KEY,
          alert_type       TEXT NOT NULL UNIQUE,
          enabled          BOOLEAN NOT NULL DEFAULT true,
          params           JSONB NOT NULL,
          cooldown_minutes INT NOT NULL DEFAULT 30,
          updated_at       TIMESTAMPTZ DEFAULT NOW()
        )
      `,
      sql`
        INSERT INTO alert_config (alert_type, params) VALUES
          ('es_momentum', '{"pts_threshold": 30, "window_minutes": 10, "volume_multiple": 2.0}'),
          ('vx_backwardation', '{"spread_threshold": 0}'),
          ('es_nq_divergence', '{"divergence_pct": 0.5, "window_minutes": 30}'),
          ('zn_flight_safety', '{"zn_move_pts": 0.5, "es_move_pts": -20, "window_minutes": 30}'),
          ('cl_spike', '{"change_pct": 2.0, "window_minutes": 60}'),
          ('es_options_volume', '{"volume_multiple": 5.0, "window_minutes": 15}')
        ON CONFLICT (alert_type) DO NOTHING
      `,
    ],
  },
  {
    id: 47,
    description:
      'Create gex_strike_0dte table for per-minute 0DTE gamma exposure by strike',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS gex_strike_0dte (
          id              SERIAL PRIMARY KEY,
          date            DATE NOT NULL,
          timestamp       TIMESTAMPTZ NOT NULL,
          strike          DECIMAL(10,2) NOT NULL,
          price           DECIMAL(10,2) NOT NULL,
          call_gamma_oi   DECIMAL(20,4),
          put_gamma_oi    DECIMAL(20,4),
          call_gamma_vol  DECIMAL(20,4),
          put_gamma_vol   DECIMAL(20,4),
          call_gamma_ask  DECIMAL(20,4),
          call_gamma_bid  DECIMAL(20,4),
          put_gamma_ask   DECIMAL(20,4),
          put_gamma_bid   DECIMAL(20,4),
          call_charm_oi   DECIMAL(20,4),
          put_charm_oi    DECIMAL(20,4),
          call_charm_vol  DECIMAL(20,4),
          put_charm_vol   DECIMAL(20,4),
          call_delta_oi   DECIMAL(20,4),
          put_delta_oi    DECIMAL(20,4),
          call_vanna_oi   DECIMAL(20,4),
          put_vanna_oi    DECIMAL(20,4),
          call_vanna_vol  DECIMAL(20,4),
          put_vanna_vol   DECIMAL(20,4),
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(date, timestamp, strike)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_gex_strike_0dte_date
        ON gex_strike_0dte(date)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_gex_strike_0dte_ts
        ON gex_strike_0dte(timestamp DESC)
      `,
    ],
  },
  {
    id: 48,
    description:
      'Add OTM delta flow columns to flow_data for zero_dte_greek_flow source',
    statements: (sql) => [
      sql`
        ALTER TABLE flow_data
          ADD COLUMN IF NOT EXISTS otm_ncp DECIMAL(14,2),
          ADD COLUMN IF NOT EXISTS otm_npp DECIMAL(14,2)
      `,
    ],
  },
  {
    id: 49,
    description:
      'Create volume_per_strike_0dte table for per-minute 0DTE raw call/put volume by strike',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS volume_per_strike_0dte (
          id           SERIAL PRIMARY KEY,
          date         DATE NOT NULL,
          timestamp    TIMESTAMPTZ NOT NULL,
          strike       DECIMAL(10,2) NOT NULL,
          call_volume  INTEGER NOT NULL DEFAULT 0,
          put_volume   INTEGER NOT NULL DEFAULT 0,
          call_oi      INTEGER NOT NULL DEFAULT 0,
          put_oi       INTEGER NOT NULL DEFAULT 0,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(date, timestamp, strike)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_volume_per_strike_0dte_date
        ON volume_per_strike_0dte(date)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_volume_per_strike_0dte_ts
        ON volume_per_strike_0dte(timestamp DESC)
      `,
    ],
  },
];
