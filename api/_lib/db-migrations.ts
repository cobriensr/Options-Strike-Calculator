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
import { LOTTERY_TICKER_STATS_SEED } from './lottery-ticker-stats-seed.js';

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
    // BE-CRON-010 hardening: converted from legacy `run:` pattern to atomic
    // `statements:` pattern so that a future failure of the ALTER (unlikely
    // in current state — see below) cannot leave the lessons table without
    // its HNSW index.
    //
    // Current state: migration #2 creates `embedding vector(2000)` directly
    // and `api/_lib/embeddings.ts` generates 2000-dim vectors via OpenAI's
    // `text-embedding-3-large` with `dimensions: 2000`. On any DB that
    // reaches this migration, the column type either already matches
    // vector(2000) (fresh DB) or held 3072-dim data before the operator
    // truncated it (legacy DB). The ALTER is effectively a no-op in
    // Postgres when the type already matches, and the whole sequence is
    // idempotent via IF EXISTS / IF NOT EXISTS guards.
    id: 3,
    description:
      'Reduce lessons embedding from vector(3072) to vector(2000) for HNSW compatibility',
    statements: (sql) => [
      // Drop the HNSW index if it exists (migration #2 may have historically
      // created an index at vector(3072) that is no longer valid).
      sql`DROP INDEX IF EXISTS idx_lessons_embedding`,
      // Change column type from vector(3072) to vector(2000). No-op in
      // Postgres when the type already matches.
      sql`ALTER TABLE lessons ALTER COLUMN embedding TYPE vector(2000)`,
      // Re-create the HNSW index at the corrected dimension.
      sql`CREATE INDEX IF NOT EXISTS idx_lessons_embedding ON lessons USING hnsw (embedding vector_cosine_ops)`,
    ],
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
  {
    id: 50,
    description:
      'Dedupe existing futures_options_trades rows and add UNIQUE index for Databento resend idempotency (SIDE-003)',
    statements: (sql) => [
      // Pre-dedup: delete any rows that share the full natural-key tuple
      // with an earlier row (keeping MIN(id) per group). This is needed
      // because any pre-existing Databento re-sends would block the
      // UNIQUE index creation below. The natural key for a trade is the
      // nanosecond-precision ts plus strike/option_type/price/size/side —
      // Databento cannot legitimately emit two distinct trades with that
      // exact combination.
      sql`
        DELETE FROM futures_options_trades
        WHERE id NOT IN (
          SELECT MIN(id)
          FROM futures_options_trades
          GROUP BY ts, underlying, expiry, strike, option_type, price, size, side
        )
      `,
      // Now that duplicates are gone, create the unique index. Naming
      // it so it's distinguishable from the existing non-unique indexes
      // on this table.
      sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fot_identity_unique
          ON futures_options_trades (ts, underlying, expiry, strike, option_type, price, size, side)
      `,
    ],
  },
  {
    id: 51,
    description:
      'Create gex_target_features table — three-layer (Layer 2 inputs + Layer 3 scoring outputs) per snapshot × strike × mode for the GexTarget rebuild',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS gex_target_features (
          id                    SERIAL PRIMARY KEY,
          date                  DATE NOT NULL,
          timestamp             TIMESTAMPTZ NOT NULL,
          mode                  TEXT NOT NULL CHECK (mode IN ('oi','vol','dir')),
          math_version          TEXT NOT NULL,
          strike                NUMERIC NOT NULL,

          -- Identity / ranking metadata
          rank_in_mode          SMALLINT NOT NULL,
          rank_by_size          SMALLINT NOT NULL,
          is_target             BOOLEAN NOT NULL,

          -- Layer 2: calculated features (inputs to scoring)
          gex_dollars           NUMERIC NOT NULL,
          delta_gex_1m          NUMERIC,
          delta_gex_5m          NUMERIC,
          delta_gex_20m         NUMERIC,
          delta_gex_60m         NUMERIC,
          prev_gex_dollars_1m   NUMERIC,
          prev_gex_dollars_5m   NUMERIC,
          prev_gex_dollars_20m  NUMERIC,
          prev_gex_dollars_60m  NUMERIC,
          delta_pct_1m          NUMERIC,
          delta_pct_5m          NUMERIC,
          delta_pct_20m         NUMERIC,
          delta_pct_60m         NUMERIC,
          call_ratio            NUMERIC,
          charm_net             NUMERIC,
          delta_net             NUMERIC,
          vanna_net             NUMERIC,
          dist_from_spot        NUMERIC NOT NULL,
          spot_price            NUMERIC NOT NULL,
          minutes_after_noon_ct NUMERIC NOT NULL,
          nearest_pos_wall_dist NUMERIC,
          nearest_pos_wall_gex  NUMERIC,
          nearest_neg_wall_dist NUMERIC,
          nearest_neg_wall_gex  NUMERIC,

          -- Layer 3: scoring outputs (what the UI displays)
          flow_confluence       NUMERIC NOT NULL,
          price_confirm         NUMERIC NOT NULL,
          charm_score           NUMERIC NOT NULL,
          dominance             NUMERIC NOT NULL,
          clarity               NUMERIC NOT NULL,
          proximity             NUMERIC NOT NULL,
          final_score           NUMERIC NOT NULL,
          tier                  TEXT NOT NULL CHECK (tier IN ('HIGH','MEDIUM','LOW','NONE')),
          wall_side             TEXT NOT NULL CHECK (wall_side IN ('CALL','PUT','NEUTRAL')),

          created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

          UNIQUE (date, timestamp, mode, strike, math_version)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_gex_target_features_date_time
          ON gex_target_features (date, timestamp)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_gex_target_features_mode_target
          ON gex_target_features (mode, is_target) WHERE is_target = TRUE
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_gex_target_features_math_version
          ON gex_target_features (math_version)
      `,
    ],
  },
  {
    id: 52,
    description:
      'Create spx_candles_1m table for pre-baked 1-minute SPX candles (GexTarget rebuild: Phase 3 populates from UW SPY→SPX conversion)',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS spx_candles_1m (
          id          SERIAL PRIMARY KEY,
          date        DATE NOT NULL,
          timestamp   TIMESTAMPTZ NOT NULL,
          open        NUMERIC NOT NULL,
          high        NUMERIC NOT NULL,
          low         NUMERIC NOT NULL,
          close       NUMERIC NOT NULL,
          volume      BIGINT NOT NULL,
          market_time TEXT NOT NULL CHECK (market_time IN ('pr','r','po')),
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

          UNIQUE (date, timestamp)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_spx_candles_1m_date_time
          ON spx_candles_1m (date, timestamp)
      `,
    ],
  },
  {
    id: 53,
    description:
      'Create greek_exposure_strike table for per-strike 0DTE greek exposure (raw UW + computed net values for ML pipeline)',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS greek_exposure_strike (
          id                SERIAL PRIMARY KEY,
          date              DATE NOT NULL,
          expiry            DATE NOT NULL,
          strike            DECIMAL(10,2) NOT NULL,
          dte               INTEGER NOT NULL DEFAULT 0,
          -- Layer 1: raw values from UW /greek-exposure/strike-expiry (greek × OI, no dollar weighting)
          call_gex          DECIMAL(20,6),
          put_gex           DECIMAL(20,6),
          call_delta        DECIMAL(20,6),
          put_delta         DECIMAL(20,6),
          call_charm        DECIMAL(20,6),
          put_charm         DECIMAL(20,6),
          call_vanna        DECIMAL(20,6),
          put_vanna         DECIMAL(20,6),
          -- Layer 2: computed from raw (stored for ML pipeline access)
          net_gex           DECIMAL(20,6),
          net_delta         DECIMAL(20,6),
          net_charm         DECIMAL(20,6),
          net_vanna         DECIMAL(20,6),
          abs_gex           DECIMAL(20,6),
          call_gex_fraction DECIMAL(10,6),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

          UNIQUE (date, expiry, strike)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_greek_exposure_strike_date
          ON greek_exposure_strike (date)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_greek_exposure_strike_expiry
          ON greek_exposure_strike (date, expiry)
      `,
    ],
  },
  {
    id: 54,
    description:
      'Add spx_schwab_price column to spx_candles_1m for Schwab-verified SPX close anchor',
    statements: (sql) => [
      sql`
        ALTER TABLE spx_candles_1m
        ADD COLUMN IF NOT EXISTS spx_schwab_price NUMERIC
      `,
    ],
  },
  {
    id: 55,
    description:
      'Add prev_gex_dollars_10m and prev_gex_dollars_15m columns to gex_target_features for 5-minute sparkline resolution',
    statements: (sql) => [
      sql`
        ALTER TABLE gex_target_features
        ADD COLUMN IF NOT EXISTS prev_gex_dollars_10m NUMERIC,
        ADD COLUMN IF NOT EXISTS prev_gex_dollars_15m NUMERIC
      `,
    ],
  },
  {
    id: 56,
    description:
      'Create trace_predictions table for manual TRACE Delta Pressure EOD pin predictions',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS trace_predictions (
          id              SERIAL PRIMARY KEY,
          date            DATE UNIQUE NOT NULL,
          predicted_close DECIMAL(10,2) NOT NULL,
          confidence      VARCHAR(10) CHECK (confidence IN ('high', 'medium', 'low')),
          notes           TEXT,
          current_price   DECIMAL(10,2),
          actual_close    DECIMAL(10,2),
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `,
    ],
  },
  {
    id: 57,
    description:
      'Add gamma_regime column to trace_predictions for GEX environment context',
    statements: (sql) => [
      sql`
        ALTER TABLE trace_predictions
        ADD COLUMN IF NOT EXISTS gamma_regime VARCHAR(10)
          CHECK (gamma_regime IN ('positive', 'negative'))
      `,
    ],
  },
  {
    id: 58,
    description:
      'Drop derived scoring columns from gex_target_features — scoring now happens browser-side from raw features so these columns are dead weight subject to formula-rot',
    statements: (sql) => [
      sql`
        DROP INDEX IF EXISTS idx_gex_target_features_mode_target
      `,
      sql`
        ALTER TABLE gex_target_features
          DROP COLUMN IF EXISTS rank_in_mode,
          DROP COLUMN IF EXISTS rank_by_size,
          DROP COLUMN IF EXISTS is_target,
          DROP COLUMN IF EXISTS flow_confluence,
          DROP COLUMN IF EXISTS price_confirm,
          DROP COLUMN IF EXISTS charm_score,
          DROP COLUMN IF EXISTS dominance,
          DROP COLUMN IF EXISTS clarity,
          DROP COLUMN IF EXISTS proximity,
          DROP COLUMN IF EXISTS final_score,
          DROP COLUMN IF EXISTS tier,
          DROP COLUMN IF EXISTS wall_side
      `,
    ],
  },
  {
    id: 59,
    description:
      'Create flow_alerts table for UW 0-1 DTE SPXW repeated-hit flow ingestion',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS flow_alerts (
          -- Primary key
          id                     BIGSERIAL PRIMARY KEY,

          -- Identity & rule (from UW list response).
          -- NOTE: uw_alert_id and rule_id are reserved for future enrichment
          -- via UW's detail endpoint (/api/option-trades/flow-alerts/{id}).
          -- The current list-endpoint cron does not populate them; a
          -- secondary cron or backfill script can fill them later without
          -- a migration.
          uw_alert_id            UUID,
          rule_id                UUID,
          alert_rule             TEXT NOT NULL,
          ticker                 TEXT NOT NULL,
          issue_type             TEXT,
          option_chain           TEXT NOT NULL,
          strike                 NUMERIC NOT NULL,
          expiry                 DATE NOT NULL,
          type                   TEXT NOT NULL,

          -- Timing.
          -- NOTE: start_time and end_time are reserved for the UW detail
          -- endpoint (list endpoint only exposes created_at).
          created_at             TIMESTAMPTZ NOT NULL,
          start_time             TIMESTAMPTZ,
          end_time               TIMESTAMPTZ,
          ingested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

          -- Pricing & volatility.
          -- NOTE: bid, ask, iv_start, iv_end are reserved for UW detail
          -- endpoint enrichment (list endpoint exposes price only).
          price                  NUMERIC,
          underlying_price       NUMERIC,
          bid                    NUMERIC,
          ask                    NUMERIC,
          iv_start               NUMERIC,
          iv_end                 NUMERIC,

          -- Premium & size
          total_premium          NUMERIC NOT NULL,
          total_ask_side_prem    NUMERIC,
          total_bid_side_prem    NUMERIC,
          total_size             INTEGER,
          trade_count            INTEGER,
          expiry_count           INTEGER,
          volume                 INTEGER,
          open_interest          INTEGER,
          volume_oi_ratio        NUMERIC,

          -- Flags
          has_sweep              BOOLEAN,
          has_floor              BOOLEAN,
          has_multileg           BOOLEAN,
          has_singleleg          BOOLEAN,
          all_opening_trades     BOOLEAN,

          -- Denormalized derived (computed at ingest for ML speed)
          ask_side_ratio         NUMERIC,
          bid_side_ratio         NUMERIC,
          net_premium            NUMERIC,
          dte_at_alert           INTEGER,
          distance_from_spot     NUMERIC,
          distance_pct           NUMERIC,
          moneyness              NUMERIC,
          is_itm                 BOOLEAN,
          minute_of_day          INTEGER,
          session_elapsed_min    INTEGER,
          day_of_week            INTEGER,

          -- Safety net
          raw_response           JSONB,

          UNIQUE (option_chain, created_at)
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS idx_flow_alerts_created_at ON flow_alerts (created_at DESC)`,
      sql`CREATE INDEX IF NOT EXISTS idx_flow_alerts_expiry_strike ON flow_alerts (expiry, strike)`,
      sql`CREATE INDEX IF NOT EXISTS idx_flow_alerts_alert_rule ON flow_alerts (alert_rule)`,
      sql`CREATE INDEX IF NOT EXISTS idx_flow_alerts_type_created_at ON flow_alerts (type, created_at DESC)`,
      sql`CREATE INDEX IF NOT EXISTS idx_flow_alerts_minute_of_day ON flow_alerts (minute_of_day)`,
    ],
  },
  {
    id: 60,
    description:
      'Create nope_ticks table for UW SPY NOPE per-minute time series (ML feature source)',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS nope_ticks (
          ticker            TEXT            NOT NULL,
          timestamp         TIMESTAMPTZ     NOT NULL,
          call_vol          INTEGER         NOT NULL,
          put_vol           INTEGER         NOT NULL,
          stock_vol         INTEGER         NOT NULL,
          call_delta        NUMERIC(20, 4)  NOT NULL,
          put_delta         NUMERIC(20, 4)  NOT NULL,
          call_fill_delta   NUMERIC(20, 4)  NOT NULL,
          put_fill_delta    NUMERIC(20, 4)  NOT NULL,
          nope              NUMERIC(20, 10) NOT NULL,
          nope_fill         NUMERIC(20, 10) NOT NULL,
          ingested_at       TIMESTAMPTZ     NOT NULL DEFAULT now(),
          PRIMARY KEY (ticker, timestamp)
        )
      `,
    ],
  },
  {
    id: 61,
    description:
      'Add NOPE-derived columns to training_features (4 checkpoint values + 3 AM aggregates)',
    statements: (sql) => [
      sql`
        ALTER TABLE training_features
          ADD COLUMN IF NOT EXISTS nope_t1              DECIMAL(14, 10),
          ADD COLUMN IF NOT EXISTS nope_t2              DECIMAL(14, 10),
          ADD COLUMN IF NOT EXISTS nope_t3              DECIMAL(14, 10),
          ADD COLUMN IF NOT EXISTS nope_t4              DECIMAL(14, 10),
          ADD COLUMN IF NOT EXISTS nope_am_mean         DECIMAL(14, 10),
          ADD COLUMN IF NOT EXISTS nope_am_sign_flips   INTEGER,
          ADD COLUMN IF NOT EXISTS nope_am_cum_delta    DECIMAL(18, 4)
      `,
    ],
  },
  {
    id: 62,
    description:
      'Create whale_alerts table for UW ≥$1M premium SPXW flow persistence (0-7 DTE, all rules)',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS whale_alerts (
          -- Primary key
          id                     BIGSERIAL PRIMARY KEY,

          -- Identity & rule (from UW list response).
          -- NOTE: uw_alert_id and rule_id are reserved for future enrichment
          -- via UW's detail endpoint (/api/option-trades/flow-alerts/{id}).
          -- Mirrors the flow_alerts schema (migration #59). The whale cron
          -- only consumes the list endpoint; a secondary cron or backfill
          -- script can populate these later without a migration.
          uw_alert_id            UUID,
          rule_id                UUID,
          alert_rule             TEXT NOT NULL,
          ticker                 TEXT NOT NULL,
          issue_type             TEXT,
          option_chain           TEXT NOT NULL,
          strike                 NUMERIC NOT NULL,
          expiry                 DATE NOT NULL,
          type                   TEXT NOT NULL,

          -- Timing.
          -- NOTE: start_time and end_time are reserved for the UW detail
          -- endpoint (list endpoint only exposes created_at).
          created_at             TIMESTAMPTZ NOT NULL,
          start_time             TIMESTAMPTZ,
          end_time               TIMESTAMPTZ,
          ingested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          age_minutes_at_ingest  INTEGER,

          -- Pricing & volatility.
          -- NOTE: bid, ask, iv_start, iv_end are reserved for UW detail
          -- endpoint enrichment (list endpoint exposes price only).
          price                  NUMERIC,
          underlying_price       NUMERIC,
          bid                    NUMERIC,
          ask                    NUMERIC,
          iv_start               NUMERIC,
          iv_end                 NUMERIC,

          -- Premium & size
          total_premium          NUMERIC NOT NULL,
          total_ask_side_prem    NUMERIC,
          total_bid_side_prem    NUMERIC,
          total_size             INTEGER,
          trade_count            INTEGER,
          expiry_count           INTEGER,
          volume                 INTEGER,
          open_interest          INTEGER,
          volume_oi_ratio        NUMERIC,

          -- Flags
          has_sweep              BOOLEAN,
          has_floor              BOOLEAN,
          has_multileg           BOOLEAN,
          has_singleleg          BOOLEAN,
          all_opening_trades     BOOLEAN,

          -- Denormalized derived (computed at ingest for ML speed)
          ask_side_ratio         NUMERIC,
          bid_side_ratio         NUMERIC,
          net_premium            NUMERIC,
          dte_at_alert           INTEGER,
          distance_from_spot     NUMERIC,
          distance_pct           NUMERIC,
          moneyness              NUMERIC,
          is_itm                 BOOLEAN,
          minute_of_day          INTEGER,
          session_elapsed_min    INTEGER,
          day_of_week            INTEGER,

          -- Safety net
          raw_response           JSONB,

          UNIQUE (option_chain, created_at)
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS idx_whale_alerts_created_at ON whale_alerts (created_at DESC)`,
      sql`CREATE INDEX IF NOT EXISTS idx_whale_alerts_expiry_strike ON whale_alerts (expiry, strike)`,
      sql`CREATE INDEX IF NOT EXISTS idx_whale_alerts_alert_rule ON whale_alerts (alert_rule)`,
      sql`CREATE INDEX IF NOT EXISTS idx_whale_alerts_type_created_at ON whale_alerts (type, created_at DESC)`,
      sql`CREATE INDEX IF NOT EXISTS idx_whale_alerts_premium ON whale_alerts (total_premium DESC)`,
    ],
  },
  {
    id: 63,
    description:
      'Create market_internals table for live $TICK/$ADD/$VOLD/$TRIN 1-minute OHLC bars',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS market_internals (
          ts      TIMESTAMPTZ NOT NULL,
          symbol  TEXT NOT NULL,
          open    NUMERIC(10, 4) NOT NULL,
          high    NUMERIC(10, 4) NOT NULL,
          low     NUMERIC(10, 4) NOT NULL,
          close   NUMERIC(10, 4) NOT NULL,
          PRIMARY KEY (ts, symbol)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_market_internals_symbol_ts
          ON market_internals (symbol, ts DESC)
      `,
    ],
  },
  {
    id: 64,
    description:
      'Widen market_internals OHLC columns to unqualified NUMERIC — $VOLD values exceed NUMERIC(10,4)',
    statements: (sql) => [
      sql`
        ALTER TABLE market_internals
          ALTER COLUMN open TYPE NUMERIC,
          ALTER COLUMN high TYPE NUMERIC,
          ALTER COLUMN low  TYPE NUMERIC,
          ALTER COLUMN close TYPE NUMERIC
      `,
    ],
  },
  {
    id: 65,
    description:
      'Create pyramid_chains + pyramid_legs tables for droppable MNQ pyramid trade tracker experiment',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS pyramid_chains (
          id                  TEXT PRIMARY KEY,
          trade_date          DATE DEFAULT CURRENT_DATE,
          instrument          TEXT,
          direction           TEXT CHECK (direction IN ('long', 'short')),
          entry_time_ct       TIME,
          exit_time_ct        TIME,
          initial_entry_price NUMERIC,
          final_exit_price    NUMERIC,
          exit_reason         TEXT CHECK (exit_reason IN ('reverse_choch', 'stopped_out', 'manual', 'eod')),
          total_legs          INTEGER DEFAULT 0,
          winning_legs        INTEGER DEFAULT 0,
          net_points          NUMERIC DEFAULT 0,
          session_atr_pct     NUMERIC,
          day_type            TEXT CHECK (day_type IN ('trend', 'chop', 'news', 'mixed')),
          higher_tf_bias      TEXT,
          notes               TEXT,
          status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS idx_pyramid_chains_date ON pyramid_chains (trade_date DESC)`,
      sql`CREATE INDEX IF NOT EXISTS idx_pyramid_chains_status ON pyramid_chains (status)`,
      sql`
        CREATE TABLE IF NOT EXISTS pyramid_legs (
          id                              TEXT PRIMARY KEY,
          chain_id                        TEXT NOT NULL REFERENCES pyramid_chains(id) ON DELETE CASCADE,
          leg_number                      INTEGER NOT NULL,
          signal_type                     TEXT CHECK (signal_type IN ('CHoCH', 'BOS')),
          entry_time_ct                   TIME,
          entry_price                     NUMERIC,
          stop_price                      NUMERIC,
          stop_distance_pts               NUMERIC,
          stop_compression_ratio          NUMERIC,
          vwap_at_entry                   NUMERIC,
          vwap_1sd_upper                  NUMERIC,
          vwap_1sd_lower                  NUMERIC,
          vwap_band_position              TEXT CHECK (vwap_band_position IN ('outside_upper', 'at_upper', 'inside', 'at_lower', 'outside_lower')),
          vwap_band_distance_pts          NUMERIC,
          minutes_since_chain_start       INTEGER,
          minutes_since_prior_bos         INTEGER,
          ob_quality                      INTEGER CHECK (ob_quality BETWEEN 1 AND 5),
          relative_volume                 INTEGER CHECK (relative_volume BETWEEN 1 AND 5),
          session_phase                   TEXT CHECK (session_phase IN ('pre_open', 'open_drive', 'morning_drive', 'lunch', 'afternoon', 'power_hour', 'close')),
          session_high_at_entry           NUMERIC,
          session_low_at_entry            NUMERIC,
          retracement_extreme_before_entry NUMERIC,
          exit_price                      NUMERIC,
          exit_reason                     TEXT CHECK (exit_reason IN ('reverse_choch', 'trailed_stop', 'manual')),
          points_captured                 NUMERIC,
          r_multiple                      NUMERIC,
          was_profitable                  BOOLEAN,
          notes                           TEXT,
          created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS idx_pyramid_legs_chain ON pyramid_legs (chain_id, leg_number)`,
    ],
  },
  {
    id: 66,
    description:
      'Add LuxAlgo OB volume-profile metrics to pyramid_legs. Captures POC price + node distribution for ML concentration features.',
    statements: (sql) => [
      sql`ALTER TABLE pyramid_legs ADD COLUMN IF NOT EXISTS ob_high NUMERIC`,
      sql`ALTER TABLE pyramid_legs ADD COLUMN IF NOT EXISTS ob_low NUMERIC`,
      sql`ALTER TABLE pyramid_legs ADD COLUMN IF NOT EXISTS ob_poc_price NUMERIC`,
      sql`ALTER TABLE pyramid_legs ADD COLUMN IF NOT EXISTS ob_poc_pct NUMERIC CHECK (ob_poc_pct BETWEEN 0 AND 100)`,
      sql`ALTER TABLE pyramid_legs ADD COLUMN IF NOT EXISTS ob_secondary_node_pct NUMERIC CHECK (ob_secondary_node_pct BETWEEN 0 AND 100)`,
      sql`ALTER TABLE pyramid_legs ADD COLUMN IF NOT EXISTS ob_tertiary_node_pct NUMERIC CHECK (ob_tertiary_node_pct BETWEEN 0 AND 100)`,
      sql`ALTER TABLE pyramid_legs ADD COLUMN IF NOT EXISTS ob_total_volume NUMERIC`,
    ],
  },
  {
    id: 67,
    description:
      'Extend pyramid_legs exit_reason enum with FVG/VWAP trail variants and add RTH/ETH structure bias columns for session-aware ML features.',
    statements: (sql) => [
      // Swap the inline CHECK constraint Postgres auto-named on table
      // creation (pyramid_legs_exit_reason_check). The original migration
      // 65 used `exit_reason TEXT CHECK (... 3 values)`. We drop and
      // re-add with 6 values to support the new FVG/VWAP/failed-re-extension
      // trail exits discussed in the session-analysis thread.
      sql`ALTER TABLE pyramid_legs DROP CONSTRAINT IF EXISTS pyramid_legs_exit_reason_check`,
      sql`ALTER TABLE pyramid_legs ADD CONSTRAINT pyramid_legs_exit_reason_check CHECK (exit_reason IS NULL OR exit_reason IN ('reverse_choch', 'trailed_stop', 'manual', 'fvg_close_below', 'vwap_band_break', 'failed_re_extension'))`,
      sql`ALTER TABLE pyramid_legs ADD COLUMN IF NOT EXISTS rth_structure_bias TEXT CHECK (rth_structure_bias IS NULL OR rth_structure_bias IN ('bullish', 'bearish', 'neutral'))`,
      sql`ALTER TABLE pyramid_legs ADD COLUMN IF NOT EXISTS eth_structure_bias TEXT CHECK (eth_structure_bias IS NULL OR eth_structure_bias IN ('bullish', 'bearish', 'neutral'))`,
    ],
  },
  {
    id: 68,
    description:
      'Drop pyramid_chains + pyramid_legs tables (pyramid trade tracker experiment retired)',
    statements: (sql) => [
      // Order: child (pyramid_legs) before parent (pyramid_chains) is
      // REQUIRED. ON DELETE CASCADE on the FK is a row-level behavior and
      // has no effect on DDL — dropping pyramid_chains first without a
      // CASCADE keyword on DROP TABLE would fail: "cannot drop table
      // pyramid_chains because other objects depend on it."
      sql`DROP TABLE IF EXISTS pyramid_legs`,
      sql`DROP TABLE IF EXISTS pyramid_chains`,
    ],
  },
  {
    id: 69,
    description:
      'Drop trace_predictions table and purge trace plot analyses (TRACE PIN experiment retired)',
    statements: (sql) => [
      // Remove orphan rows in ml_plot_analyses whose plot_name targets
      // trace_* plots — once the source table and frontend are gone these
      // rows have no consumer and would otherwise accumulate forever.
      sql`DELETE FROM ml_plot_analyses WHERE plot_name LIKE 'trace_%'`,
      sql`DROP TABLE IF EXISTS trace_predictions`,
    ],
  },
  {
    id: 70,
    description:
      'Create theta_option_eod table for Theta Data nightly EOD option chains (SPXW/VIX/VIXW/NDXP)',
    statements: (sql) => [
      // Theta Data v2 returns one row per (symbol, expiration, strike, right, trade_date)
      // with OHLC + NBBO-at-17:15 + volume. Column `option_type` matches the
      // futures_options_daily convention and avoids the `right` SQL reserved word.
      // Strikes stored as dollars (converted from Theta's integer-thousandths at ingest).
      sql`
        CREATE TABLE IF NOT EXISTS theta_option_eod (
          symbol       TEXT NOT NULL,
          expiration   DATE NOT NULL,
          strike       NUMERIC(10,2) NOT NULL,
          option_type  CHAR(1) NOT NULL CHECK (option_type IN ('C', 'P')),
          date         DATE NOT NULL,
          open         NUMERIC(10,2),
          high         NUMERIC(10,2),
          low          NUMERIC(10,2),
          close        NUMERIC(10,2),
          volume       BIGINT,
          trade_count  INTEGER,
          bid          NUMERIC(10,2),
          ask          NUMERIC(10,2),
          bid_size     INTEGER,
          ask_size     INTEGER,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (symbol, expiration, strike, option_type, date)
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS ix_theta_option_eod_symbol_date ON theta_option_eod (symbol, date DESC)`,
      sql`CREATE INDEX IF NOT EXISTS ix_theta_option_eod_expiration ON theta_option_eod (expiration)`,
    ],
  },
  {
    id: 71,
    description:
      'Create futures_top_of_book table for Databento MBP-1 quote events (ES L1 book, Phase 2a)',
    statements: (sql) => [
      // MBP-1 is a high-volume quote stream (thousands of rows/min during
      // active CME trading). No UNIQUE constraint — dedup isn't meaningful
      // at this layer and the write-path cost of maintaining one would
      // dominate. Consumers read by (symbol, ts) range, hence the composite
      // index with ts DESC for "latest N quotes" queries.
      sql`
        CREATE TABLE IF NOT EXISTS futures_top_of_book (
          id        BIGSERIAL PRIMARY KEY,
          symbol    TEXT NOT NULL,
          ts        TIMESTAMPTZ NOT NULL,
          bid       NUMERIC(12,4) NOT NULL,
          bid_size  INTEGER NOT NULL,
          ask       NUMERIC(12,4) NOT NULL,
          ask_size  INTEGER NOT NULL
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS idx_ftob_symbol_ts ON futures_top_of_book (symbol, ts DESC)`,
    ],
  },
  {
    id: 72,
    description:
      'Create futures_trade_ticks table for Databento TBBO trade events with aggressor side (ES L1, Phase 2a)',
    statements: (sql) => [
      // TBBO records = trade + pre-trade BBO. We store the trade with an
      // aggressor classification derived from trade price vs the pre-trade
      // bid/ask (see quote_processor.classify_aggressor). 'B' buyer-
      // initiated, 'S' seller-initiated, 'N' trade printed between the
      // spread (rare but possible for auction crosses).
      sql`
        CREATE TABLE IF NOT EXISTS futures_trade_ticks (
          id             BIGSERIAL PRIMARY KEY,
          symbol         TEXT NOT NULL,
          ts             TIMESTAMPTZ NOT NULL,
          price          NUMERIC(12,4) NOT NULL,
          size           INTEGER NOT NULL,
          aggressor_side CHAR(1) NOT NULL CHECK (aggressor_side IN ('B','S','N'))
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS idx_ftt_symbol_ts ON futures_trade_ticks (symbol, ts DESC)`,
    ],
  },
  {
    id: 73,
    description:
      'Create day_embeddings table with pgvector for historical analog retrieval',
    statements: (sql) => [
      // pgvector 0.8.0 is already installed on Neon — the CREATE EXTENSION
      // is idempotent and makes the migration self-bootstrapping on
      // staging/dev DBs that may not have it yet.
      sql`CREATE EXTENSION IF NOT EXISTS vector`,
      // One row per trading day. `summary` is the deterministic text fed
      // to OpenAI so we can diff/regenerate when the summary format
      // changes. `embedding_model` is stored so we can run A/B model
      // migrations without nuking the table.
      sql`
        CREATE TABLE IF NOT EXISTS day_embeddings (
          date            DATE PRIMARY KEY,
          symbol          TEXT NOT NULL,
          summary         TEXT NOT NULL,
          embedding       vector(2000) NOT NULL,
          embedding_model TEXT NOT NULL,
          created_at      TIMESTAMPTZ DEFAULT NOW()
        )
      `,
      // HNSW cosine index — fast approximate k-NN. 2000 dims matches
      // existing embeddings.ts (text-embedding-3-large truncated to fit
      // Neon's HNSW 2000-dim cap). ~4000 rows query in single-digit ms.
      sql`
        CREATE INDEX IF NOT EXISTS day_embeddings_vec_idx
          ON day_embeddings
          USING hnsw (embedding vector_cosine_ops)
      `,
    ],
  },
  {
    id: 74,
    description:
      'Create day_features table with 60-dim numeric vector for engineered path-shape analogs (Phase C)',
    statements: (sql) => [
      // Engineered-feature backend: sidecar computes a 60-dim vector of
      // first-hour minute-close percent-changes (shape-only, scale-free).
      // Kept as a separate table from day_embeddings so both backends
      // coexist and can be A/B compared without row-level collisions.
      sql`
        CREATE TABLE IF NOT EXISTS day_features (
          date         DATE PRIMARY KEY,
          symbol       TEXT NOT NULL,
          features     vector(60) NOT NULL,
          feature_set  TEXT NOT NULL,
          created_at   TIMESTAMPTZ DEFAULT NOW()
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS day_features_vec_idx
          ON day_features
          USING hnsw (features vector_cosine_ops)
      `,
    ],
  },
  {
    id: 75,
    description:
      'Create current_day_snapshot for materialized live-day archive context (path 2)',
    statements: (sql) => [
      // Materialized live-day cache. A Vercel cron refreshes this every
      // 5 min during market hours so the analyze endpoint never has to
      // call the DuckDB-backed sidecar on the hot path — it reads the
      // pre-computed summary + feature vector straight from Neon.
      // Primary key on date lets us upsert without a second lookup.
      sql`
        CREATE TABLE IF NOT EXISTS current_day_snapshot (
          date            DATE PRIMARY KEY,
          symbol          TEXT NOT NULL,
          summary         TEXT NOT NULL,
          features        vector(60) NOT NULL,
          computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS current_day_snapshot_computed_idx
          ON current_day_snapshot (computed_at DESC)
      `,
    ],
  },
  {
    id: 76,
    description:
      'Add OHLC + asymmetric excursion columns to day_embeddings for analog range forecast',
    statements: (sql) => [
      // Cohort-conditional range/excursion forecasting needs per-date
      // numeric OHLC alongside the existing text summary. The sidecar's
      // day-summary-batch endpoint already emits these — this migration
      // makes the analyze endpoint able to read them from Neon instead
      // of round-tripping the sidecar. up_exc/down_exc are pre-computed
      // (high-open, open-low) so analyze queries skip arithmetic.
      sql`
        ALTER TABLE day_embeddings
          ADD COLUMN IF NOT EXISTS day_open   DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS day_high   DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS day_low    DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS day_close  DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS range_pt   DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS up_exc     DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS down_exc   DOUBLE PRECISION
      `,
    ],
  },
  {
    id: 77,
    description:
      'Add vix_bucket column to day_embeddings for regime-stratified analog retrieval',
    statements: (sql) => [
      // Enables Phase 4 of the analog range forecast: filter the cohort
      // to same-VIX-regime historical mornings so forecast calibration
      // tightens in elevated/crisis vol (where the unstratified global
      // distribution is catastrophically miscalibrated, per validation
      // in comparison-v16). Bucket is a string label — {low, normal,
      // elevated, crisis} at 15/22/30 VIX close cuts — so query
      // filtering is an index-friendly equality check rather than a
      // range scan. Column is NULL for rows that haven't been
      // backfilled from public/vix-data.json yet; the forecast module
      // treats NULL as "no regime data, use unstratified cohort".
      sql`
        ALTER TABLE day_embeddings
          ADD COLUMN IF NOT EXISTS vix_bucket TEXT
      `,
      sql`
        CREATE INDEX IF NOT EXISTS day_embeddings_vix_bucket_idx
          ON day_embeddings (vix_bucket)
          WHERE vix_bucket IS NOT NULL
      `,
    ],
  },
  {
    id: 78,
    description:
      'Create push_subscriptions table for Web Push VAPID endpoints (FuturesGammaPlaybook regime alerts)',
    statements: (sql) => [
      // One row per browser/device. `endpoint` is the push-service URL
      // (FCM/Mozilla/etc) and is globally unique per subscription, so we
      // use it as the PK rather than a surrogate SERIAL — upserts on
      // re-subscribe are natural conflict-target matches. `p256dh` and
      // `auth` are the VAPID per-device public keys the web-push SDK
      // needs to encrypt payloads; they're not secrets but also never
      // logged. `failure_count` lets the delivery cron back off or prune
      // dead endpoints after repeated 410 Gone responses. The DESC index
      // on `created_at` supports both the "oldest first" cap enforcement
      // in /api/push/subscribe and any future admin listing.
      sql`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          endpoint          TEXT PRIMARY KEY,
          p256dh            TEXT NOT NULL,
          auth              TEXT NOT NULL,
          user_agent        TEXT,
          failure_count     INTEGER NOT NULL DEFAULT 0,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_delivered_at TIMESTAMPTZ
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_push_subscriptions_created
          ON push_subscriptions (created_at DESC)
      `,
    ],
  },
  {
    id: 79,
    description:
      'Create regime_events table for server-detected FuturesGammaPlaybook alerts (history + delivery audit)',
    statements: (sql) => [
      // Append-only history of every alert edge the monitor-regime-events
      // cron has fired. `payload` holds the full AlertEvent JSON (≤ 4KB)
      // so the frontend history strip can replay titles/bodies without
      // re-deriving them. `delivered_count` is stamped from web-push
      // wrapper's result at insert time — used for "delivered to N
      // devices" badges in Phase 2A.4.
      sql`
        CREATE TABLE IF NOT EXISTS regime_events (
          id              SERIAL PRIMARY KEY,
          ts              TIMESTAMPTZ NOT NULL,
          type            TEXT NOT NULL,
          severity        TEXT NOT NULL,
          title           TEXT NOT NULL,
          body            TEXT NOT NULL,
          payload         JSONB,
          delivered_count INTEGER NOT NULL DEFAULT 0
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_regime_events_ts
          ON regime_events (ts DESC)
      `,
    ],
  },
  {
    id: 80,
    description:
      'Create regime_monitor_state singleton row for cross-run alert state (prev AlertState + cooldowns)',
    statements: (sql) => [
      // Exactly one row ever, keyed by `singleton_key = 'current'`. The
      // monitor-regime-events cron reads this row for prev_state at the
      // start of each run and upserts with ON CONFLICT (singleton_key)
      // DO UPDATE on the way out. Simpler than inferring prev state
      // from regime_events itself and avoids races if the cron misses
      // a beat (the last written state is always the authoritative
      // prev for the next run).
      sql`
        CREATE TABLE IF NOT EXISTS regime_monitor_state (
          singleton_key TEXT PRIMARY KEY,
          prev_state    JSONB,
          last_run      TIMESTAMPTZ
        )
      `,
    ],
  },
  {
    id: 81,
    description:
      'Create institutional_blocks table for SPXW mfsl/cbmo/slft floor ' +
      'blocks (institutional regime indicator — 180-300 DTE ceiling ' +
      'program + 0-7 DTE opening-ATM blocks)',
    statements: (sql) => [
      // Raw capture of SPXW institutional-tier block trades. One row
      // per UW trade; trade_id PK dedupes across the 4 daily polls.
      // The program_track column classifies each block as either the
      // long-dated "ceiling" regime indicator, the near-ATM opening-
      // hour "opening_atm" signal, or "other" — so downstream queries
      // filter cleanly without re-classifying on the read path.
      //
      // Source: docs/0dte-findings.md Finding 1 + the full mfsl
      // explanation in docs/institutional-program-tracker.md.
      sql`
        CREATE TABLE IF NOT EXISTS institutional_blocks (
          trade_id         TEXT PRIMARY KEY,
          executed_at      TIMESTAMPTZ NOT NULL,
          option_chain_id  TEXT NOT NULL,
          strike           DOUBLE PRECISION NOT NULL,
          option_type      TEXT NOT NULL,
          expiry           DATE NOT NULL,
          dte              INTEGER NOT NULL,
          size             INTEGER NOT NULL,
          price            DOUBLE PRECISION NOT NULL,
          premium          DOUBLE PRECISION NOT NULL,
          side             TEXT,
          condition        TEXT NOT NULL,
          exchange         TEXT,
          underlying_price DOUBLE PRECISION NOT NULL,
          moneyness_pct    DOUBLE PRECISION NOT NULL,
          open_interest    INTEGER,
          delta            DOUBLE PRECISION,
          gamma            DOUBLE PRECISION,
          iv               DOUBLE PRECISION,
          program_track    TEXT NOT NULL DEFAULT 'other'
            CHECK (program_track IN ('ceiling', 'opening_atm', 'other')),
          ingested_at      TIMESTAMPTZ DEFAULT NOW()
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_instblocks_executed_at
          ON institutional_blocks (executed_at DESC)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_instblocks_track_date
          ON institutional_blocks (program_track, executed_at DESC)
      `,
    ],
  },
  {
    id: 82,
    description:
      'Create zero_gamma_levels table for per-minute derived zero-gamma ' +
      'level (spot price where dealer net gamma = 0) — regime-flip signal ' +
      'computed from existing spot_gex by-strike data',
    statements: (sql) => [
      // Volume: ~540 rows/day × 1 ticker (SPX, MVP scope). Nullable
      // zero_gamma handles the "no sign change in ±3% range" case —
      // downstream consumers must null-check before trusting it.
      sql`
        CREATE TABLE IF NOT EXISTS zero_gamma_levels (
          id                BIGSERIAL PRIMARY KEY,
          ticker            TEXT NOT NULL,
          spot              NUMERIC(10,4) NOT NULL,
          zero_gamma        NUMERIC(10,4),
          confidence        NUMERIC(4,3),
          net_gamma_at_spot NUMERIC(14,2),
          gamma_curve       JSONB,
          ts                TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_zero_gamma_ticker_ts
          ON zero_gamma_levels (ticker, ts DESC)
      `,
    ],
  },
  {
    id: 83,
    description:
      'Create strike_iv_snapshots table for per-strike OTM IV time series ' +
      '(SPX/SPY/QQQ, ±3% of spot) — Phase 1 of the Strike IV Anomaly Detector',
    statements: (sql) => [
      // One row per ticker × strike × side × expiry × 1-min snapshot. Volume:
      // ~30 strikes × 3 tickers × 3 expiries × 540 polls/day ≈ 145K rows/day.
      // Numeric precision is sized for both SPX ($5 strikes, 4-digit prices)
      // and SPY/QQQ ($1 strikes, 2-digit prices). Nullable IV columns handle
      // the case where the Newton-Raphson solver can't invert a broken quote
      // (price below intrinsic, vega-collapse tail); we still insert the row
      // so the mid_price / OI / volume time series stays contiguous.
      sql`
        CREATE TABLE IF NOT EXISTS strike_iv_snapshots (
          id          BIGSERIAL PRIMARY KEY,
          ticker      TEXT NOT NULL,
          strike      NUMERIC(10,2) NOT NULL,
          side        TEXT NOT NULL,
          expiry      DATE NOT NULL,
          spot        NUMERIC(10,4) NOT NULL,
          iv_mid      NUMERIC(8,5),
          iv_bid      NUMERIC(8,5),
          iv_ask      NUMERIC(8,5),
          mid_price   NUMERIC(8,4),
          oi          INTEGER,
          volume      INTEGER,
          ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      // Fast scan for "latest N snapshots per ticker" queries that Phase 2's
      // detector + Phase 3's per-ticker tab view will drive. ts DESC keeps
      // recent data on the leading index pages.
      sql`
        CREATE INDEX IF NOT EXISTS idx_strike_iv_snapshots_ticker_ts
          ON strike_iv_snapshots (ticker, ts DESC)
      `,
      // Composite for Phase 3's per-strike history chart: given (ticker,
      // strike, side, expiry), return the last N samples in descending time
      // order. Index-only scan since it covers every WHERE + ORDER BY column.
      sql`
        CREATE INDEX IF NOT EXISTS idx_strike_iv_snapshots_lookup
          ON strike_iv_snapshots (ticker, strike, side, expiry, ts DESC)
      `,
    ],
  },
  {
    id: 84,
    description:
      'Create iv_anomalies table for Strike IV Anomaly Detector (Phase 2) — ' +
      'flags + JSONB context_snapshot at detection time, plus ' +
      'resolution_outcome populated EOD by the Phase 4 resolve cron',
    statements: (sql) => [
      // One row per detected anomaly. Volume is bounded: at the 2.0σ /
      // 1.5-vol-pt thresholds we expect single-digit rows per session per
      // ticker, so no partitioning or retention policy is needed. The
      // flag_reasons TEXT[] lets the frontend and Phase 4 resolve cron
      // filter by flag type without parsing a composite TEXT column.
      sql`
        CREATE TABLE IF NOT EXISTS iv_anomalies (
          id                 BIGSERIAL PRIMARY KEY,
          ticker             TEXT NOT NULL,
          strike             NUMERIC(10,2) NOT NULL,
          side               TEXT NOT NULL,
          expiry             DATE NOT NULL,
          spot_at_detect     NUMERIC(10,4) NOT NULL,
          iv_at_detect       NUMERIC(8,5) NOT NULL,
          skew_delta         NUMERIC(6,4),
          z_score            NUMERIC(6,4),
          ask_mid_div        NUMERIC(6,4),
          flag_reasons       TEXT[] NOT NULL,
          flow_phase         TEXT,
          context_snapshot   JSONB,
          resolution_outcome JSONB,
          ts                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      // Per-ticker recency scan for the Phase 3 frontend list endpoint.
      sql`
        CREATE INDEX IF NOT EXISTS idx_iv_anomalies_ticker_ts
          ON iv_anomalies (ticker, ts DESC)
      `,
      // Partial index accelerates the Phase 4 EOD resolve cron's "what's
      // still unscored?" query without bloating the base index.
      sql`
        CREATE INDEX IF NOT EXISTS idx_iv_anomalies_unresolved
          ON iv_anomalies (ts) WHERE resolution_outcome IS NULL
      `,
    ],
  },
  {
    id: 85,
    description:
      'Add vol_oi_ratio column to iv_anomalies for the primary volume/OI ' +
      'gate (2026-04-24 rescope) — strike must have cumulative intraday ' +
      'volume ≥ 5× start-of-day OI to fire. Surfaced prominently in the UI.',
    statements: (sql) => [
      // NUMERIC(8,2) fits ratios up to 999999.99× — effectively unbounded
      // for our use case (anything above ~50× is already saturated signal).
      // Nullable so historical rows (pre-rescope) stay valid without a
      // backfill; the UI renders null as `—` and the detector will always
      // populate it going forward.
      sql`
        ALTER TABLE iv_anomalies
          ADD COLUMN IF NOT EXISTS vol_oi_ratio NUMERIC(8,2)
      `,
    ],
  },
  {
    id: 86,
    description:
      'Add side_skew + side_dominant columns to iv_anomalies for the ' +
      'secondary side-dominance gate (2026-04-24) — proxy for tape-side ' +
      'volume dominance derived from iv_bid/iv_mid/iv_ask spread until ' +
      'real UW per-strike side-split volume is wired (deferred spec ' +
      'tape-side-volume-exit-signal-2026-04-24).',
    statements: (sql) => [
      // side_skew: max(ask_skew, bid_skew), 0..1 → NUMERIC(4,3) keeps full
      // resolution at 0.001 granularity. Nullable for legacy rows + the
      // edge case where the spread was non-positive at detect.
      sql`
        ALTER TABLE iv_anomalies
          ADD COLUMN IF NOT EXISTS side_skew NUMERIC(4,3)
      `,
      // side_dominant: 'ask' | 'bid' | 'mixed' (text, no enum since we
      // already use plain text for `side` and `flow_phase`). 'mixed' is
      // present for type-completeness — the gate filters those rows out
      // before insert, so this column will only see 'ask' or 'bid' in
      // production rows. Nullable for legacy rows.
      sql`
        ALTER TABLE iv_anomalies
          ADD COLUMN IF NOT EXISTS side_dominant TEXT
      `,
    ],
  },
  {
    id: 87,
    description:
      'Create strike_trade_volume table for tape-side volume exit-signal ' +
      'detection (2026-04-25). Replaces the firing-rate-surge proxy in ' +
      'useIVAnomalies with real bid-side vs ask-side per-minute volume ' +
      'from UW /api/stock/{ticker}/flow-per-strike-intraday. Note: that ' +
      'endpoint aggregates across expiries — table is keyed on (ticker, ' +
      'strike, side, ts), no expiry column.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS strike_trade_volume (
          id            BIGSERIAL PRIMARY KEY,
          ticker        TEXT NOT NULL,
          strike        NUMERIC(10,2) NOT NULL,
          side          TEXT NOT NULL,                 -- 'call' | 'put'
          ts            TIMESTAMPTZ NOT NULL,
          bid_side_vol  INTEGER NOT NULL DEFAULT 0,
          ask_side_vol  INTEGER NOT NULL DEFAULT 0,
          mid_vol       INTEGER NOT NULL DEFAULT 0,
          total_vol     INTEGER NOT NULL DEFAULT 0,
          ingested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_strike_trade_volume_lookup
          ON strike_trade_volume (ticker, strike, side, ts DESC)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_strike_trade_volume_ticker_ts
          ON strike_trade_volume (ticker, ts DESC)
      `,
    ],
  },
  {
    id: 88,
    description:
      'Create trace_live_analyses table for the periodic TRACE chart ' +
      'analyses (charm + gamma + delta) — JSONB full response + ' +
      'vector(2000) embedding for retrieval of analogous past ticks. ' +
      'Keyed on captured_at (single-owner, ticks are unique per timestamp). ' +
      'See spec: docs/superpowers/specs/trace-live-2026-04-25 (pending).',
    statements: (sql) => [
      sql`CREATE EXTENSION IF NOT EXISTS vector`,
      sql`
        CREATE TABLE IF NOT EXISTS trace_live_analyses (
          id                 BIGSERIAL PRIMARY KEY,
          captured_at        TIMESTAMPTZ NOT NULL,
          spot               NUMERIC(10,2) NOT NULL,
          stability_pct      NUMERIC(5,2),
          regime             TEXT,
          predicted_close    NUMERIC(10,2),
          confidence         TEXT,
          override_applied   BOOLEAN,
          headline           TEXT,
          full_response      JSONB NOT NULL,
          analysis_embedding vector(2000),
          model              TEXT NOT NULL,
          input_tokens       INTEGER,
          output_tokens      INTEGER,
          cache_read_tokens  INTEGER,
          cache_write_tokens INTEGER,
          duration_ms        INTEGER,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_trace_live_captured_at
          ON trace_live_analyses (captured_at DESC)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_trace_live_embedding_hnsw
          ON trace_live_analyses USING hnsw (analysis_embedding vector_cosine_ops)
      `,
    ],
  },
  {
    id: 89,
    description:
      'Add image_urls column to trace_live_analyses for Vercel Blob ' +
      'storage of the gamma/charm/delta heatmap PNGs. Shape: ' +
      '{ gamma?: string, charm?: string, delta?: string } — all keys ' +
      'optional because Blob upload is best-effort (failure is logged but ' +
      "doesn't block the analysis save). Frontend renders <img src={url}> " +
      'for historical browsing.',
    statements: (sql) => [
      sql`
        ALTER TABLE trace_live_analyses
          ADD COLUMN IF NOT EXISTS image_urls JSONB
      `,
    ],
  },
  {
    id: 90,
    description:
      'Add actual_close + actual_path columns to trace_live_analyses for ' +
      'outcomes-join analysis. actual_close is the SPX cash settlement on ' +
      'the trading day of capture; actual_path is a JSONB array of ' +
      '{ts, price} entries from capture-time → close (5-min spacing) ' +
      'enabling realized-vs-predicted analysis, calibration curves, and ' +
      "historical-analog outcome lookups. Populated by fetch-outcomes' " +
      'post-settlement update step.',
    statements: (sql) => [
      sql`
        ALTER TABLE trace_live_analyses
          ADD COLUMN IF NOT EXISTS actual_close NUMERIC(10, 2),
          ADD COLUMN IF NOT EXISTS actual_path JSONB
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_trace_live_actual_close_filter
          ON trace_live_analyses (captured_at DESC)
          WHERE actual_close IS NOT NULL
      `,
    ],
  },
  {
    id: 91,
    description:
      'Add novelty_score column to trace_live_analyses for drift detection. ' +
      'Stored as NUMERIC(8,6) — cosine distance to the k-th nearest historical ' +
      'embedding (default k=20). Computed pre-insert in saveTraceLiveAnalysis. ' +
      'High score = current setup is far from any historical pattern → ' +
      "model's calibration may not apply, surface as UI flag. NULL when " +
      'fewer than k historical rows exist (early days / insufficient data).',
    statements: (sql) => [
      sql`
        ALTER TABLE trace_live_analyses
          ADD COLUMN IF NOT EXISTS novelty_score NUMERIC(8, 6)
      `,
    ],
  },
  {
    id: 92,
    description:
      'Create vega_flow_etf table for SPY/QQQ minute-bar greek flow ' +
      '(dir/total/OTM variants of vega + delta) from UW /api/stock/{ticker}/greek-flow. ' +
      'Phase 1 of the Dir Vega Spike Monitor — backing data for spike detection ' +
      'and forward-return EDA. Keyed (ticker, timestamp) for idempotent ingest.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS vega_flow_etf (
          id                    BIGSERIAL PRIMARY KEY,
          ticker                TEXT NOT NULL,
          date                  DATE NOT NULL,
          timestamp             TIMESTAMPTZ NOT NULL,
          dir_vega_flow         NUMERIC NOT NULL,
          otm_dir_vega_flow     NUMERIC NOT NULL,
          total_vega_flow       NUMERIC NOT NULL,
          otm_total_vega_flow   NUMERIC NOT NULL,
          dir_delta_flow        NUMERIC NOT NULL,
          otm_dir_delta_flow    NUMERIC NOT NULL,
          total_delta_flow      NUMERIC NOT NULL,
          otm_total_delta_flow  NUMERIC NOT NULL,
          transactions          INTEGER NOT NULL,
          volume                INTEGER NOT NULL,
          inserted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (ticker, timestamp)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_vega_flow_etf_ticker_date
          ON vega_flow_etf (ticker, date)
      `,
    ],
  },
  {
    id: 93,
    description:
      'Create vega_spike_events table for the Dir Vega Spike Monitor (Phase 3). ' +
      'One row per qualifying spike — bars where |dir_vega_flow| passes all four ' +
      'gates (FLOOR + 2x prior intraday max + 6x robust z-score + 30+ bars elapsed). ' +
      'Forward-return columns nullable until Phase 5 enrichment cron populates them. ' +
      'Unique (ticker, timestamp) so monitor cron is idempotent on retry.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS vega_spike_events (
          id              BIGSERIAL PRIMARY KEY,
          ticker          TEXT NOT NULL,
          date            DATE NOT NULL,
          timestamp       TIMESTAMPTZ NOT NULL,
          dir_vega_flow   NUMERIC NOT NULL,
          z_score         NUMERIC NOT NULL,
          vs_prior_max    NUMERIC NOT NULL,
          prior_max       NUMERIC NOT NULL,
          baseline_mad    NUMERIC NOT NULL,
          bars_elapsed    INTEGER NOT NULL,
          confluence      BOOLEAN NOT NULL DEFAULT false,
          fwd_return_5m   NUMERIC,
          fwd_return_15m  NUMERIC,
          fwd_return_30m  NUMERIC,
          inserted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (ticker, timestamp)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_vega_spike_events_date_ticker
          ON vega_spike_events (date DESC, ticker)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_vega_spike_events_pending_returns
          ON vega_spike_events (timestamp)
          WHERE fwd_return_30m IS NULL
      `,
    ],
  },
  {
    id: 94,
    description:
      'Create etf_candles_1m table for raw SPY/QQQ 1-minute OHLC candles. ' +
      'Phase 5 of the Dir Vega Spike Monitor — backing data for the ' +
      'enrich-vega-spike-returns cron that computes 5/15/30-min forward ' +
      'returns on each spike event. Distinct from fetch-spx-candles-1m ' +
      'which fetches SPY but stores SPX-derived (×ratio) prices, not raw. ' +
      'Unique (ticker, timestamp) for idempotent ingest.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS etf_candles_1m (
          id          BIGSERIAL PRIMARY KEY,
          ticker      TEXT NOT NULL,
          timestamp   TIMESTAMPTZ NOT NULL,
          open        NUMERIC NOT NULL,
          high        NUMERIC NOT NULL,
          low         NUMERIC NOT NULL,
          close       NUMERIC NOT NULL,
          volume      BIGINT,
          inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (ticker, timestamp)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_etf_candles_1m_ticker_ts
          ON etf_candles_1m (ticker, timestamp DESC)
      `,
    ],
  },
  {
    id: 95,
    description:
      'Add real-tape bid/ask volume columns to iv_anomalies (2026-04-28). ' +
      'Replaces the IV-spread-position proxy in side_skew/side_dominant ' +
      'with cumulative-since-open volume splits from strike_trade_volume. ' +
      'The proxy was systematically inverted on penny-priced ETF options ' +
      '(Schwab `mark` snaps to `ask`, pinning iv_mid at iv_ask). Old rows ' +
      'keep proxy-derived side_skew/side_dominant; new rows additionally ' +
      'populate bid_pct/ask_pct/mid_pct/total_vol_at_detect from the real ' +
      'tape and recompute side_skew/side_dominant from those. See spec: ' +
      'docs/superpowers/specs/iv-anomaly-real-tape-bidask-2026-04-28.md.',
    statements: (sql) => [
      sql`ALTER TABLE iv_anomalies ADD COLUMN IF NOT EXISTS bid_pct NUMERIC(4,3)`,
      sql`ALTER TABLE iv_anomalies ADD COLUMN IF NOT EXISTS ask_pct NUMERIC(4,3)`,
      sql`ALTER TABLE iv_anomalies ADD COLUMN IF NOT EXISTS mid_pct NUMERIC(4,3)`,
      sql`ALTER TABLE iv_anomalies ADD COLUMN IF NOT EXISTS total_vol_at_detect INTEGER`,
    ],
  },
  {
    id: 96,
    description:
      'Add fwd_return_eod column to vega_spike_events for end-of-day ' +
      'forward-return measurement on each spike. Lets the dashboard ' +
      'compare hold-to-close P&L against the existing 5/15/30-min ' +
      'returns. Populated by the same enrich-vega-spike-returns cron ' +
      "using the last 1-min candle of the spike's ET trading day in " +
      'etf_candles_1m. NULL until the cron picks up the row; nullable ' +
      'forever for spikes whose anchor candle is missing.',
    statements: (sql) => [
      sql`ALTER TABLE vega_spike_events ADD COLUMN IF NOT EXISTS fwd_return_eod NUMERIC`,
    ],
  },
  {
    id: 97,
    description:
      'Create gamma_squeeze_events table for the velocity-based gamma squeeze ' +
      'detector (2026-04-28). Sibling of the IV anomaly detector — different ' +
      'signal (vol/OI velocity instead of side concentration), different ' +
      'table, different alert path. Catches the TSLA 375C / NVDA 212.5C ' +
      'archetype: balanced-tape near-ATM 0DTE calls that win via dealer ' +
      'hedging reflexivity rather than informed flow. Velocity = vol/OI ' +
      'added in last 15 min; acceleration = velocity vs prior 15 min; ' +
      'proximity = spot vs strike on the OTM side; trend = 5-min spot ' +
      'direction. NDG sign joined from strike_exposures (SPX/SPY/QQQ only). ' +
      'See spec: docs/superpowers/specs/gamma-squeeze-velocity-detector-2026-04-28.md.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS gamma_squeeze_events (
          id                    BIGSERIAL PRIMARY KEY,
          ticker                TEXT NOT NULL,
          strike                NUMERIC(10,2) NOT NULL,
          side                  TEXT NOT NULL,
          expiry                DATE NOT NULL,
          ts                    TIMESTAMPTZ NOT NULL,
          spot_at_detect        NUMERIC NOT NULL,
          pct_from_strike       NUMERIC NOT NULL,
          spot_trend_5m         NUMERIC NOT NULL,
          vol_oi_15m            NUMERIC NOT NULL,
          vol_oi_15m_prior      NUMERIC NOT NULL,
          vol_oi_acceleration   NUMERIC NOT NULL,
          vol_oi_total          NUMERIC NOT NULL,
          net_gamma_sign        TEXT NOT NULL,
          squeeze_phase         TEXT NOT NULL,
          context_snapshot      JSONB,
          spot_at_close         NUMERIC,
          reached_strike        BOOLEAN,
          max_call_pnl_pct      NUMERIC,
          inserted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_gamma_squeeze_ticker_ts
          ON gamma_squeeze_events (ticker, ts DESC)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_gamma_squeeze_compound_key
          ON gamma_squeeze_events (ticker, strike, side, expiry, ts DESC)
      `,
    ],
  },
  {
    id: 98,
    description:
      'Add unique indexes + dedupe to 5 high-volume tables for cron ' +
      'idempotency (2026-04-28 backend audit Phase 3). Vercel function ' +
      'retries and `?force=1` re-runs were INSERTing without ON CONFLICT, ' +
      'producing duplicate rows that corrupt downstream detectors. Each ' +
      'table is deduped on the natural key (keeping MIN(id) per group) ' +
      'before the unique index is created — duplicates would otherwise ' +
      'block CREATE UNIQUE INDEX. Tables: strike_iv_snapshots, ' +
      'gamma_squeeze_events, iv_anomalies (key: ticker, strike, side, ' +
      'expiry, ts); strike_trade_volume (key: ticker, strike, side, ts); ' +
      'zero_gamma_levels (key: ticker, ts). Pairs with ON CONFLICT DO ' +
      'NOTHING clauses on the 5 cron handler INSERTs. See spec: ' +
      'docs/superpowers/specs/backend-audit-fixes-2026-04-28.md.',
    statements: (sql) => [
      sql`
        DELETE FROM strike_iv_snapshots
        WHERE id NOT IN (
          SELECT MIN(id) FROM strike_iv_snapshots
          GROUP BY ticker, strike, side, expiry, ts
        )
      `,
      sql`
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_strike_iv_snapshots_key
          ON strike_iv_snapshots (ticker, strike, side, expiry, ts)
      `,
      sql`
        DELETE FROM gamma_squeeze_events
        WHERE id NOT IN (
          SELECT MIN(id) FROM gamma_squeeze_events
          GROUP BY ticker, strike, side, expiry, ts
        )
      `,
      sql`
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_gamma_squeeze_events_key
          ON gamma_squeeze_events (ticker, strike, side, expiry, ts)
      `,
      sql`
        DELETE FROM iv_anomalies
        WHERE id NOT IN (
          SELECT MIN(id) FROM iv_anomalies
          GROUP BY ticker, strike, side, expiry, ts
        )
      `,
      sql`
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_iv_anomalies_key
          ON iv_anomalies (ticker, strike, side, expiry, ts)
      `,
      sql`
        DELETE FROM strike_trade_volume
        WHERE id NOT IN (
          SELECT MIN(id) FROM strike_trade_volume
          GROUP BY ticker, strike, side, ts
        )
      `,
      sql`
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_strike_trade_volume_key
          ON strike_trade_volume (ticker, strike, side, ts)
      `,
      sql`
        DELETE FROM zero_gamma_levels
        WHERE id NOT IN (
          SELECT MIN(id) FROM zero_gamma_levels
          GROUP BY ticker, ts
        )
      `,
      sql`
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_zero_gamma_levels_key
          ON zero_gamma_levels (ticker, ts)
      `,
    ],
  },
  {
    id: 99,
    description:
      'Create whale_anomalies table for the Whale Anomalies component (replaces Strike IV Anomalies). Surfaces option-flow prints matching the hand-derived whale-detection checklist (per-ticker p95 premium, ≥85% one-sided, ≥5 trades, ≤14 DTE, ≤5% moneyness, no simultaneous paired leg). Populated by detect-whales cron during market hours and by a one-shot historical backfill from the EOD parquet archive. See spec: docs/superpowers/specs/whale-anomalies-2026-04-29.md.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS whale_anomalies (
          id                BIGSERIAL PRIMARY KEY,
          source_alert_id   BIGINT,
          source            TEXT NOT NULL CHECK (source IN ('live', 'eod_backfill')),
          ticker            TEXT NOT NULL,
          option_chain      TEXT NOT NULL,
          strike            NUMERIC NOT NULL,
          option_type       TEXT NOT NULL CHECK (option_type IN ('call', 'put')),
          expiry            DATE NOT NULL,
          first_ts          TIMESTAMPTZ NOT NULL,
          last_ts           TIMESTAMPTZ NOT NULL,
          detected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          side              TEXT NOT NULL CHECK (side IN ('ASK', 'BID')),
          ask_pct           NUMERIC(4,3),
          total_premium     NUMERIC NOT NULL,
          trade_count       INTEGER NOT NULL,
          vol_oi_ratio      NUMERIC,
          underlying_price  NUMERIC,
          moneyness         NUMERIC(6,4),
          dte               INTEGER NOT NULL,
          whale_type        SMALLINT NOT NULL CHECK (whale_type BETWEEN 1 AND 4),
          direction         TEXT NOT NULL CHECK (direction IN ('bullish', 'bearish')),
          pairing_status    TEXT NOT NULL CHECK (pairing_status IN ('alone', 'sequential')),
          resolved_at       TIMESTAMPTZ,
          hit_target        BOOLEAN,
          pct_to_target     NUMERIC,
          CONSTRAINT uniq_whale_anomalies UNIQUE (option_chain, first_ts)
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS idx_whale_anomalies_ticker_ts ON whale_anomalies (ticker, first_ts DESC)`,
      sql`CREATE INDEX IF NOT EXISTS idx_whale_anomalies_unresolved ON whale_anomalies (first_ts) WHERE resolved_at IS NULL`,
      sql`CREATE INDEX IF NOT EXISTS idx_whale_anomalies_type ON whale_anomalies (whale_type)`,
    ],
  },
  {
    id: 100,
    description:
      'Drop iv_anomalies table — Strike IV Anomaly Detector retired in favor of Whale Anomalies (see docs/superpowers/specs/whale-anomalies-2026-04-29.md, Phase 7). The fetch-strike-iv cron stopped writing to this table in the same release; no consumer reads from it anymore. strike_iv_snapshots is kept (used by gamma-squeeze detector and analyze-context).',
    statements: (sql) => [sql`DROP TABLE IF EXISTS iv_anomalies CASCADE`],
  },
  {
    id: 101,
    description:
      'Rename whale_anomalies.pct_to_target → pct_close_vs_strike. The column stores (last_close - strike) / strike (signed by Type) which is "% close vs strike" rather than "% from spot to target". Code-reviewer flagged the misleading name; renaming keeps semantics intact and makes the dashboard label match what the value actually is.',
    statements: (sql) => [
      sql`ALTER TABLE whale_anomalies RENAME COLUMN pct_to_target TO pct_close_vs_strike`,
    ],
  },
  {
    id: 102,
    description:
      'Create trace_live_calibration table for stratified residual statistics derived from trace_live_analyses.actual_close. Computed daily by the resolve-trace-residuals cron after fetch-outcomes populates actual_close. Keyed (regime, ttc_bucket) where ttc_bucket = "0-15min" | "15-60min" | "60-180min" | ">180min". Stores mean/median residual + sample count + p25/p75 for the predictedCloseRange band. Applied at inference time in trace-live-analyze to bias-correct the model output.',
    // NOTE: ttc_bucket uses an inline CHECK constraint over a fixed enum.
    // Adding a new bucket requires a follow-up migration:
    //   ALTER TABLE trace_live_calibration DROP CONSTRAINT trace_live_calibration_ttc_bucket_check;
    //   ALTER TABLE trace_live_calibration ADD CONSTRAINT trace_live_calibration_ttc_bucket_check CHECK (ttc_bucket IN (...new list...));
    // Keeping the CHECK rather than promoting to a Postgres ENUM type because
    // ENUMs are harder to mutate (need ALTER TYPE ... ADD VALUE) and the bucket
    // set is small + unlikely to grow frequently.
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS trace_live_calibration (
          regime          TEXT NOT NULL,
          ttc_bucket      TEXT NOT NULL CHECK (ttc_bucket IN ('0-15min','15-60min','60-180min','>180min')),
          n               INTEGER NOT NULL CHECK (n >= 0),
          residual_mean   NUMERIC,
          residual_median NUMERIC,
          residual_p25    NUMERIC,
          residual_p75    NUMERIC,
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (regime, ttc_bucket)
        )
      `,
    ],
  },
  {
    id: 103,
    description:
      'Create periscope_analyses table for the manual Periscope chat ' +
      'feature — user uploads 1-3 chart screenshots, Claude produces a ' +
      'structured read (open setup) or debrief (post-hoc scoring), and ' +
      'the response + vector(2000) embedding are persisted for retrieval ' +
      'and calibration. Mirrors trace_live_analyses shape with periscope ' +
      'extras: mode (read|debrief), optional parent_id (debriefs link to ' +
      'their open read), structured trigger/cone fields parsed from a ' +
      "JSON block at the end of Claude's response, and user-editable " +
      'calibration_quality + regime_tag for curating gold examples. ' +
      'See spec: docs/superpowers/specs/periscope-chat-2026-04-30.md.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS periscope_analyses (
          id                  BIGSERIAL PRIMARY KEY,
          trading_date        DATE NOT NULL,
          captured_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          mode                TEXT NOT NULL CHECK (mode IN ('read', 'debrief')),
          parent_id           BIGINT REFERENCES periscope_analyses(id),
          user_context        TEXT,
          image_urls          JSONB NOT NULL DEFAULT '[]'::jsonb,
          prose_text          TEXT NOT NULL,
          full_response       JSONB NOT NULL,
          analysis_embedding  vector(2000),
          spot                NUMERIC(10,2),
          cone_lower          NUMERIC(10,2),
          cone_upper          NUMERIC(10,2),
          long_trigger        NUMERIC(10,2),
          short_trigger       NUMERIC(10,2),
          regime_tag          TEXT,
          calibration_quality SMALLINT CHECK (calibration_quality BETWEEN 1 AND 5),
          model               TEXT NOT NULL,
          input_tokens        INTEGER,
          output_tokens       INTEGER,
          cache_read_tokens   INTEGER,
          cache_write_tokens  INTEGER,
          duration_ms         INTEGER,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_periscope_analyses_trading_date
          ON periscope_analyses (trading_date DESC)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_periscope_analyses_parent_id
          ON periscope_analyses (parent_id) WHERE parent_id IS NOT NULL
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_periscope_analyses_calibration_quality
          ON periscope_analyses (calibration_quality DESC) WHERE calibration_quality IS NOT NULL
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_periscope_analyses_embedding_hnsw
          ON periscope_analyses USING hnsw (analysis_embedding vector_cosine_ops)
          WHERE analysis_embedding IS NOT NULL
      `,
    ],
  },
  {
    id: 104,
    description:
      'Add precision-stack overlay columns to gamma_squeeze_events: ' +
      'hhi_neighborhood (Herfindahl of cross-strike premium concentration ' +
      'within ±0.5% of spot at fire time, lower = diffuse), ' +
      'iv_morning_vol_corr (Pearson correlation of per-minute Δ implied_vol ' +
      'and Δ cumulative volume restricted to ≤11:00 CT, higher = real demand), ' +
      'and precision_stack_pass (boolean — true when both filters fall in ' +
      'the discriminating quantile vs the universe-day, computed by an ' +
      'after-close cron). Columns nullable so historical events stay ' +
      'queryable; backfill happens via scripts/backfill-precision-stack.py ' +
      'and live cron stamping (Phase 2). Lifts precision from 17.5% (V≥5× ' +
      'alone) to 48.8% (full stack at top 20%) on the 12-day in-sample ' +
      'backtest. See spec: docs/superpowers/specs/precision-stack-overlay-2026-04-30.md.',
    statements: (sql) => [
      sql`ALTER TABLE gamma_squeeze_events ADD COLUMN IF NOT EXISTS hhi_neighborhood NUMERIC`,
      sql`ALTER TABLE gamma_squeeze_events ADD COLUMN IF NOT EXISTS iv_morning_vol_corr NUMERIC`,
      sql`ALTER TABLE gamma_squeeze_events ADD COLUMN IF NOT EXISTS precision_stack_pass BOOLEAN`,
    ],
  },
  {
    id: 105,
    description:
      'Drop precision_stack_pass from gamma_squeeze_events. Migration #104 ' +
      'added the column with the intent that an after-close cron would ' +
      'stamp it from per-day percentiles, but that cron was never built ' +
      'and the live ingest path in fetch-strike-iv.ts never writes it. ' +
      'The read endpoint /api/gamma-squeezes already computes the pass ' +
      'flag at request time from (hhi_neighborhood, iv_morning_vol_corr) ' +
      'using same-day percentiles across the queried result set, so the ' +
      'column has no readers and no live writers — pure dead weight. ' +
      'Drop instead of leaving stale NULLs across the table. The two ' +
      'numeric columns (hhi_neighborhood, iv_morning_vol_corr) stay ' +
      'because the cron does write them at fire time and the read ' +
      'endpoint reads them.',
    statements: (sql) => [
      sql`ALTER TABLE gamma_squeeze_events DROP COLUMN IF EXISTS precision_stack_pass`,
    ],
  },
  {
    id: 106,
    description:
      'Backfill periscope_analyses.trading_date from the prose heading. ' +
      'Rows captured before the chart_date extraction landed got stamped ' +
      'with the capture-day date instead of the actual trading date the ' +
      'chart was for — back-reads of yesterday tagged with today, etc. ' +
      'Every periscope read prose starts with a `# YYYY-MM-DD ...` heading ' +
      'Claude writes from the chart label, so we parse that and overwrite ' +
      'trading_date for any row whose stored date disagrees with the prose. ' +
      'Idempotent: only rows where the parsed date differs are touched, so ' +
      'fresh DBs and re-runs are no-ops. Skips rows whose prose lacks the ' +
      "heading (defensive — a malformed Claude response shouldn't crash " +
      'the migration).',
    statements: (sql) => [
      sql`
        UPDATE periscope_analyses
        SET trading_date = m.matched_date
        FROM (
          SELECT id,
                 (regexp_match(prose_text, '^#\s+(\d{4}-\d{2}-\d{2})'))[1]::date
                   AS matched_date
          FROM periscope_analyses
          WHERE prose_text ~ '^#\s+\d{4}-\d{2}-\d{2}'
        ) AS m
        WHERE periscope_analyses.id = m.id
          AND periscope_analyses.trading_date <> m.matched_date
      `,
    ],
  },
  {
    id: 107,
    description:
      'Drop gamma_squeeze_events table — replaced by lottery_finder_fires ' +
      'in the Lottery Finder migration. The velocity-based gamma squeeze ' +
      'detector underperformed in the 15-day backtest and is being replaced ' +
      'by the cheap-call-PM RE-LOAD selection rule discovered against the ' +
      'options-flow archive (see docs/superpowers/specs/lottery-finder-' +
      '2026-05-02.md). CASCADE removes the indexes (idx_gamma_squeeze_*, ' +
      'uniq_gamma_squeeze_events_key) automatically. Idempotent — re-runs ' +
      'on a fresh DB are no-ops via IF EXISTS.',
    statements: (sql) => [
      sql`DROP TABLE IF EXISTS gamma_squeeze_events CASCADE`,
    ],
  },
  {
    id: 108,
    description:
      'Create ws_flow_alerts table + ws_flow_alerts_enriched view for the ' +
      'new uw-stream Railway daemon (see docs/superpowers/specs/' +
      'uw-websocket-daemon-2026-05-02.md). Distinct from the cron-fed ' +
      'flow_alerts table (#59) — the daemon writes the global UW WS ' +
      'flow-alerts firehose (every ticker, every DTE) while the cron is ' +
      'scoped to SPXW 0-1 DTE Index. The two coexist during the soak ' +
      'window; cutover happens via a later migration once parity is ' +
      'verified. Schema design choices: only raw payload fields are ' +
      'stored as columns; derived signals (dte_at_alert, moneyness, ' +
      'minute_of_day, ask_side_ratio, etc.) are computed at read time ' +
      'via the ws_flow_alerts_enriched VIEW so the math stays re-runnable ' +
      'against historic rows. The OCC option_chain symbol is preserved ' +
      'verbatim alongside parsed strike/expiry/option_type so UWs ' +
      '/option-contract/{symbol}/* REST endpoints still work. ws_alert_id ' +
      '(the per-alert UUID UW emits in the WS payloads `id` field) is the ' +
      'natural dedupe key — using (option_chain, created_at) like the ' +
      'cron-fed table does would collapse distinct rules firing on the ' +
      'same contract within the same millisecond.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS ws_flow_alerts (
          id BIGSERIAL PRIMARY KEY,

          -- WS-side identity. UW emits a per-alert UUID in the WS
          -- payloads "id" field; we make it NOT NULL so the daemon
          -- rejects malformed payloads up front.
          ws_alert_id UUID NOT NULL,
          rule_id UUID,
          rule_name TEXT,

          -- Contract identification.
          ticker TEXT NOT NULL,
          option_chain TEXT NOT NULL,
          issue_type TEXT,
          expiry DATE NOT NULL,
          strike NUMERIC(10, 3) NOT NULL,
          option_type CHAR(1) NOT NULL,
          CONSTRAINT ws_flow_alerts_option_type_chk CHECK (option_type IN ('C', 'P')),

          -- Timing. created_at is derived from WS executed_at (ms epoch → UTC TIMESTAMPTZ).
          created_at TIMESTAMPTZ NOT NULL,
          start_time TIMESTAMPTZ,
          end_time TIMESTAMPTZ,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

          -- Pricing.
          price NUMERIC(12, 4),
          underlying_price NUMERIC(12, 4),
          bid NUMERIC(12, 4),
          ask NUMERIC(12, 4),

          -- Flow stats.
          volume INTEGER,
          total_size INTEGER,
          total_premium NUMERIC(18, 2),
          total_ask_side_prem NUMERIC(18, 2),
          total_bid_side_prem NUMERIC(18, 2),
          open_interest INTEGER,
          volume_oi_ratio NUMERIC(10, 4),
          trade_count INTEGER,
          expiry_count INTEGER,

          -- Side breakdown.
          ask_vol INTEGER,
          bid_vol INTEGER,
          no_side_vol INTEGER,
          mid_vol INTEGER,
          multi_vol INTEGER,
          stock_multi_vol INTEGER,

          -- Boolean flags.
          has_multileg BOOLEAN,
          has_sweep BOOLEAN,
          has_floor BOOLEAN,
          has_singleleg BOOLEAN,
          all_opening_trades BOOLEAN,

          -- Array fields kept as JSONB for flexibility.
          upstream_condition_details JSONB,
          exchanges JSONB,
          trade_ids JSONB,

          -- Misc.
          url TEXT,
          raw_payload JSONB NOT NULL
        )
      `,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS ws_flow_alerts_alert_id_uq ON ws_flow_alerts (ws_alert_id)`,
      sql`CREATE INDEX IF NOT EXISTS ws_flow_alerts_chain_created_idx ON ws_flow_alerts (option_chain, created_at)`,
      sql`CREATE INDEX IF NOT EXISTS ws_flow_alerts_created_at_idx ON ws_flow_alerts (created_at DESC)`,
      sql`CREATE INDEX IF NOT EXISTS ws_flow_alerts_ticker_created_idx ON ws_flow_alerts (ticker, created_at DESC)`,
      sql`CREATE INDEX IF NOT EXISTS ws_flow_alerts_rule_name_idx ON ws_flow_alerts (rule_name)`,
      sql`CREATE INDEX IF NOT EXISTS ws_flow_alerts_expiry_strike_idx ON ws_flow_alerts (expiry, strike)`,
      sql`
        CREATE OR REPLACE VIEW ws_flow_alerts_enriched AS
        SELECT
          a.*,
          (a.expiry - (a.created_at AT TIME ZONE 'America/Chicago')::date) AS dte_at_alert,
          (a.strike - a.underlying_price) AS distance_from_spot,
          CASE
            WHEN a.underlying_price IS NULL OR a.underlying_price = 0 THEN NULL
            ELSE (a.strike - a.underlying_price) / a.underlying_price
          END AS distance_pct,
          CASE
            WHEN a.option_type = 'C' AND a.strike < a.underlying_price THEN TRUE
            WHEN a.option_type = 'P' AND a.strike > a.underlying_price THEN TRUE
            ELSE FALSE
          END AS is_itm,
          CASE
            WHEN a.underlying_price IS NULL THEN 'unknown'
            WHEN a.option_type = 'C' AND a.strike < a.underlying_price THEN 'itm'
            WHEN a.option_type = 'C' AND a.strike > a.underlying_price THEN 'otm'
            WHEN a.option_type = 'P' AND a.strike > a.underlying_price THEN 'itm'
            WHEN a.option_type = 'P' AND a.strike < a.underlying_price THEN 'otm'
            ELSE 'atm'
          END AS moneyness,
          (
            EXTRACT(HOUR FROM a.created_at AT TIME ZONE 'America/Chicago') * 60
            + EXTRACT(MINUTE FROM a.created_at AT TIME ZONE 'America/Chicago')
          )::INTEGER AS minute_of_day,
          (
            EXTRACT(HOUR FROM a.created_at AT TIME ZONE 'America/Chicago') * 60
            + EXTRACT(MINUTE FROM a.created_at AT TIME ZONE 'America/Chicago')
            - 510
          )::INTEGER AS session_elapsed_min,
          EXTRACT(DOW FROM a.created_at AT TIME ZONE 'America/Chicago')::INTEGER AS day_of_week,
          CASE
            WHEN a.total_premium IS NULL OR a.total_premium = 0 THEN NULL
            ELSE a.total_ask_side_prem / a.total_premium
          END AS ask_side_ratio,
          CASE
            WHEN a.total_premium IS NULL OR a.total_premium = 0 THEN NULL
            ELSE a.total_bid_side_prem / a.total_premium
          END AS bid_side_ratio,
          (COALESCE(a.total_ask_side_prem, 0) - COALESCE(a.total_bid_side_prem, 0)) AS net_premium
        FROM ws_flow_alerts a
      `,
    ],
  },
  {
    id: 109,
    description:
      'Create ws_option_trades table for the uw-stream daemon to write the ' +
      'UW WebSocket `option_trades:<TICKER>` per-tick stream. This is the ' +
      "input feed for the Lottery Finder cron's v4 trigger detector — " +
      'each row is one OPRA print with side classification, IV, delta, OI, ' +
      'and underlying price at the moment of execution. Distinct from ' +
      'ws_flow_alerts (#108): that table holds UW-aggregated burst alerts; ' +
      'this one is raw per-trade ticks. Per-ticker filtering keeps daily ' +
      'volume to ~1-3M rows/day (vs 6-10M for the global firehose) — ' +
      'sufficient since the Lottery Finder universe is ~50 tickers. See ' +
      'docs/superpowers/specs/lottery-finder-2026-05-02.md, Phase 1.4. ' +
      'Schema notes: ws_trade_id is the natural dedupe key (UW emits a ' +
      'UUID per print on the option_trades channel). raw_payload is kept ' +
      'as JSONB for forward-compat — we do NOT store the full payload as ' +
      'extracted columns because per-trade volume makes JSONB storage ' +
      'cheaper than wide rows (~500 bytes payload vs ~12 typed columns). ' +
      'A retention cron (TODO, separate spec) will DELETE rows older than ' +
      '7 days to bound table size.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS ws_option_trades (
          id BIGSERIAL PRIMARY KEY,

          -- WS-side identity. UW emits a per-trade UUID on the option_trades
          -- channel. NOT NULL so the daemon rejects malformed payloads up
          -- front (mirrors the ws_alert_id pattern in ws_flow_alerts).
          ws_trade_id UUID NOT NULL,

          -- Contract identification.
          ticker TEXT NOT NULL,
          option_chain TEXT NOT NULL,        -- OCC OSI symbol, e.g. "SPY260502C00500000"
          option_type CHAR(1) NOT NULL,      -- 'C' or 'P', parsed from option_chain
          CONSTRAINT ws_option_trades_option_type_chk CHECK (option_type IN ('C', 'P')),
          strike NUMERIC(10, 3) NOT NULL,    -- parsed from option_chain
          expiry DATE NOT NULL,              -- parsed from option_chain

          -- Timing. executed_at is derived from the WS payload's tape time
          -- (ms epoch → UTC TIMESTAMPTZ). received_at is the daemon's local
          -- write time — the gap is the end-to-end latency we instrument.
          executed_at TIMESTAMPTZ NOT NULL,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

          -- Trade fields.
          price NUMERIC(12, 4) NOT NULL,
          size INTEGER NOT NULL,
          underlying_price NUMERIC(12, 4),
          side TEXT NOT NULL,                -- 'ask' | 'bid' | 'mid' | 'no_side'
          CONSTRAINT ws_option_trades_side_chk
            CHECK (side IN ('ask', 'bid', 'mid', 'no_side')),

          -- Greeks at trade time (used by the v4 trigger 5-min rolling means).
          implied_volatility NUMERIC(10, 6),
          delta NUMERIC(10, 6),

          -- Open interest snapshot at trade time. The detector takes
          -- max(open_interest) per chain per day so a single non-null
          -- value per chain is sufficient.
          open_interest INTEGER,

          -- Cancellation flag. UW emits canceled trades; the detector
          -- filters these out (matches the parquet data convention).
          canceled BOOLEAN NOT NULL DEFAULT FALSE,

          -- Optional context retained as JSONB for forward-compat.
          -- Holds anything the daemon doesn't extract into typed columns
          -- (exchange, sip flags, sale_cond_codes, etc.).
          raw_payload JSONB NOT NULL
        )
      `,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS ws_option_trades_trade_id_uq
            ON ws_option_trades (ws_trade_id)`,
      // Primary read pattern: detector reads recent trades for one chain
      // (WHERE option_chain = X AND executed_at >= now - 5min).
      sql`CREATE INDEX IF NOT EXISTS ws_option_trades_chain_executed_idx
            ON ws_option_trades (option_chain, executed_at DESC)`,
      // Per-ticker browsing + per-ticker scan for the trigger fan-out.
      sql`CREATE INDEX IF NOT EXISTS ws_option_trades_ticker_executed_idx
            ON ws_option_trades (ticker, executed_at DESC)`,
      // Retention cron + global time-window queries.
      sql`CREATE INDEX IF NOT EXISTS ws_option_trades_executed_idx
            ON ws_option_trades (executed_at)`,
    ],
  },
  {
    id: 110,
    description:
      'Create lottery_finder_fires table — the output of the new Lottery ' +
      'Finder detector (Phase 1.2 of docs/superpowers/specs/lottery-finder-' +
      '2026-05-02.md). Each row is one v4 trigger fire enriched with ' +
      'derived discriminators (RE-LOAD tag, cheap-call-PM flag), a macro ' +
      'context snapshot at fire time (display-only — see Appendix A of ' +
      'the spec for why macro is not used as a selection gate), and ' +
      'realized-exit outcomes under three policies. The natural dedupe ' +
      'key is (option_chain_id, trigger_time_ct) — the detector cooldown ' +
      'guarantees ≥5 min between fires on the same chain so this composite ' +
      'is collision-free. Outcome columns are NULL until the enrich cron ' +
      'backfills them post-EoD. flow_quad/tod/mode are denormalised at ' +
      'write time for fast UI filter chips.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS lottery_finder_fires (
          id BIGSERIAL PRIMARY KEY,

          -- Identity ─────────────────────────────────────────
          date                          DATE NOT NULL,
          trigger_time_ct               TIMESTAMPTZ NOT NULL,
          entry_time_ct                 TIMESTAMPTZ NOT NULL,
          option_chain_id               TEXT NOT NULL,
          underlying_symbol             TEXT NOT NULL,
          option_type                   CHAR(1) NOT NULL,
          CONSTRAINT lottery_finder_fires_option_type_chk
            CHECK (option_type IN ('C', 'P')),
          strike                        NUMERIC(12, 4) NOT NULL,
          expiry                        DATE NOT NULL,
          dte                           SMALLINT NOT NULL,

          -- Trigger features (5-min rolling, from the v4 detector) ──
          trigger_vol_to_oi_window      NUMERIC NOT NULL,
          trigger_vol_to_oi_cum         NUMERIC NOT NULL,
          trigger_iv                    NUMERIC NOT NULL,
          trigger_delta                 NUMERIC NOT NULL,
          trigger_ask_pct               NUMERIC NOT NULL,
          trigger_window_size           INTEGER NOT NULL,
          trigger_window_prints         INTEGER NOT NULL,

          -- Entry context ─────────────────────────────────────
          entry_price                   NUMERIC(12, 4) NOT NULL,
          open_interest                 INTEGER NOT NULL,
          spot_at_first                 NUMERIC(12, 4) NOT NULL,
          alert_seq                     INTEGER NOT NULL,
          minutes_since_prev_fire       NUMERIC NOT NULL DEFAULT 0,

          -- Derived discriminators ────────────────────────────
          flow_quad                     TEXT NOT NULL,         -- call_ask | call_bid | call_mixed | put_*
          tod                           TEXT NOT NULL,         -- AM_open | MID | LUNCH | PM
          mode                          TEXT NOT NULL,         -- A_intraday_0DTE | B_multi_day_DTE1_3
          reload_tagged                 BOOLEAN NOT NULL,
          cheap_call_pm_tagged          BOOLEAN NOT NULL,
          burst_ratio_vs_prev           NUMERIC,               -- NULL on alert_seq=1
          entry_drop_pct_vs_prev        NUMERIC,               -- NULL on alert_seq=1

          -- Macro snapshot at fire time (display-only) ────────
          mkt_tide_ncp                  NUMERIC,
          mkt_tide_npp                  NUMERIC,
          mkt_tide_diff                 NUMERIC,               -- ncp - npp
          mkt_tide_otm_diff             NUMERIC,
          spx_flow_diff                 NUMERIC,
          spy_etf_diff                  NUMERIC,
          qqq_etf_diff                  NUMERIC,
          zero_dte_diff                 NUMERIC,
          spx_spot_gamma_oi             NUMERIC,
          spx_spot_gamma_vol            NUMERIC,
          spx_spot_charm_oi             NUMERIC,
          spx_spot_vanna_oi             NUMERIC,
          gex_strike_call_minus_put     NUMERIC,               -- index/ETF only; ~4% coverage
          gex_strike_call_ask_minus_bid NUMERIC,
          gex_strike_put_ask_minus_bid  NUMERIC,
          gex_strike_actual_strike      NUMERIC,

          -- Outcomes (populated by enrich cron post-EoD) ──────
          realized_trail30_10_pct       NUMERIC,
          realized_hard30m_pct          NUMERIC,
          realized_tier50_holdeod_pct   NUMERIC,
          realized_eod_pct              NUMERIC,
          peak_ceiling_pct              NUMERIC,
          minutes_to_peak               NUMERIC,

          inserted_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          enriched_at                   TIMESTAMPTZ
        )
      `,
      // Natural dedupe key — detector cooldown guarantees uniqueness.
      sql`CREATE UNIQUE INDEX IF NOT EXISTS lottery_finder_fires_chain_ts_uq
            ON lottery_finder_fires (option_chain_id, trigger_time_ct)`,
      // Primary read pattern: recent fires (UI), most-recent first.
      sql`CREATE INDEX IF NOT EXISTS lottery_finder_fires_date_ts_idx
            ON lottery_finder_fires (date DESC, trigger_time_ct DESC)`,
      // Cheap-call-PM filter chip + RE-LOAD chip — partial index keeps it
      // tiny since these flags fire on a small subset of all rows.
      sql`CREATE INDEX IF NOT EXISTS lottery_finder_fires_cheap_call_pm_idx
            ON lottery_finder_fires (date DESC, cheap_call_pm_tagged, reload_tagged)
            WHERE cheap_call_pm_tagged = TRUE`,
      // Per-ticker browsing.
      sql`CREATE INDEX IF NOT EXISTS lottery_finder_fires_ticker_ts_idx
            ON lottery_finder_fires (underlying_symbol, trigger_time_ct DESC)`,
      // Enrich cron picks unenriched rows by inserted_at watermark.
      sql`CREATE INDEX IF NOT EXISTS lottery_finder_fires_unenriched_idx
            ON lottery_finder_fires (inserted_at)
            WHERE enriched_at IS NULL`,
    ],
  },
  {
    id: 111,
    description:
      'Create ws_gex_strike_expiry table for the uw-stream daemon to write ' +
      'the UW WebSocket `gex_strike_expiry:<TICKER>` channel — per-strike, ' +
      'per-expiry GEX (gamma / charm / vanna by OI, vol, ask-vol, bid-vol) ' +
      'updated as fast as UW recomputes them. This is the data source for ' +
      'the new Strike Battle Map panel (Phase 1 of docs/superpowers/specs/' +
      'strike-battle-map-2026-05-03.md): the panel renders the top OTM 0DTE ' +
      'strikes for SPY + QQQ with customer dir delta flow above the line ' +
      'and dealer net gamma below — so magnets (pin candidates) and ' +
      'amplifiers (cascade risk) are visible in one view. Schema notes: ' +
      'values are stored as NUMERIC because UW emits them as JSON strings ' +
      'in scientific-ish notation that Decimal/Number.parseFloat handle ' +
      'safely; raw_payload is kept as JSONB for forward-compat against ' +
      'channel schema additions. The natural dedupe key is (ticker, expiry, ' +
      'strike, ts_minute) — UW restates aggregated GEX intraday (same root ' +
      'cause as the vega_flow_etf restatement we hit on 2026-05-01) so this ' +
      'table is UPSERTed on every WS push with last-write-wins per minute. ' +
      'Two indexes: ticker+expiry+ts (panel queries) and ticker+strike+ts ' +
      '(strike-history scrub).',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS ws_gex_strike_expiry (
          id                  BIGSERIAL PRIMARY KEY,
          ticker              TEXT        NOT NULL,
          expiry              DATE        NOT NULL,
          strike              NUMERIC(12, 4) NOT NULL,
          ts_minute           TIMESTAMPTZ NOT NULL,
          price               NUMERIC,
          call_gamma_oi       NUMERIC,
          put_gamma_oi        NUMERIC,
          call_charm_oi       NUMERIC,
          put_charm_oi        NUMERIC,
          call_vanna_oi       NUMERIC,
          put_vanna_oi        NUMERIC,
          call_gamma_vol      NUMERIC,
          put_gamma_vol       NUMERIC,
          call_charm_vol      NUMERIC,
          put_charm_vol       NUMERIC,
          call_vanna_vol      NUMERIC,
          put_vanna_vol       NUMERIC,
          call_gamma_ask_vol  NUMERIC,
          call_gamma_bid_vol  NUMERIC,
          put_gamma_ask_vol   NUMERIC,
          put_gamma_bid_vol   NUMERIC,
          call_charm_ask_vol  NUMERIC,
          call_charm_bid_vol  NUMERIC,
          put_charm_ask_vol   NUMERIC,
          put_charm_bid_vol   NUMERIC,
          call_vanna_ask_vol  NUMERIC,
          call_vanna_bid_vol  NUMERIC,
          put_vanna_ask_vol   NUMERIC,
          put_vanna_bid_vol   NUMERIC,
          raw_payload         JSONB,
          received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (ticker, expiry, strike, ts_minute)
        )
      `,
      // Panel queries: "all strikes for ticker X on expiry Y, latest minute"
      sql`CREATE INDEX IF NOT EXISTS ws_gex_strike_expiry_ticker_expiry_ts_idx
            ON ws_gex_strike_expiry (ticker, expiry, ts_minute DESC)`,
      // Strike-history scrub: "this strike across the whole day"
      sql`CREATE INDEX IF NOT EXISTS ws_gex_strike_expiry_ticker_strike_ts_idx
            ON ws_gex_strike_expiry (ticker, strike, ts_minute DESC)`,
    ],
  },
  {
    id: 112,
    description:
      'Rename spx_candles_1m → index_candles_1m and add symbol column to ' +
      'support multi-index OHLC ingestion (initially SPX, with NDX added in a ' +
      'follow-up so the dark pool read endpoint can do contemporaneous ' +
      'QQQ→NDX mapping via the same candle-ratio query used for SPY→SPX). ' +
      'Existing rows are backfilled to symbol="SPX" via the column DEFAULT. ' +
      'A compatibility view named spx_candles_1m (filtered to symbol="SPX") ' +
      'preserves the old name so unmigrated readers continue working unchanged ' +
      'while we migrate them in bounded batches; the view is dropped in a later ' +
      'migration once all 22 references have been rewritten to query ' +
      'index_candles_1m directly. The old (date, timestamp) unique constraint ' +
      'is replaced by (symbol, date, timestamp) so SPX and NDX rows can ' +
      "coexist; the constraint's auto-index serves the dark pool read query " +
      'pattern (symbol-leftmost) without needing a separate named index. A ' +
      'partial unique index spx_candles_1m_compat_uniq on (date, timestamp) ' +
      "WHERE symbol='SPX' is added so the existing fetch-spx-candles-1m cron's " +
      'INSERT ... ON CONFLICT (date, timestamp) keeps resolving against an ' +
      'exact-match unique target — Postgres rejects ON CONFLICT against a ' +
      'partial column subset of a multi-column unique constraint. The partial ' +
      'index is dropped together with the compat view in a later migration ' +
      'once the cron is rewritten to insert into index_candles_1m directly ' +
      'with symbol-aware ON CONFLICT.',
    statements: (sql) => [
      sql`ALTER TABLE spx_candles_1m RENAME TO index_candles_1m`,
      sql`ALTER TABLE index_candles_1m
            ADD COLUMN symbol TEXT NOT NULL DEFAULT 'SPX'`,
      sql`ALTER TABLE index_candles_1m
            DROP CONSTRAINT spx_candles_1m_date_timestamp_key`,
      sql`ALTER TABLE index_candles_1m
            ADD CONSTRAINT index_candles_1m_symbol_date_timestamp_key
            UNIQUE (symbol, date, timestamp)`,
      sql`DROP INDEX IF EXISTS idx_spx_candles_1m_date_time`,
      sql`CREATE UNIQUE INDEX spx_candles_1m_compat_uniq
            ON index_candles_1m (date, timestamp)
            WHERE symbol = 'SPX'`,
      sql`CREATE VIEW spx_candles_1m AS
            SELECT id, date, timestamp, open, high, low, close, volume,
                   market_time, created_at, spx_schwab_price
            FROM index_candles_1m
            WHERE symbol = 'SPX'`,
    ],
  },
  {
    id: 113,
    description:
      'Add ndx_schwab_price column to index_candles_1m for the NDX-row ' +
      'Schwab-verified close anchor (mirrors the existing spx_schwab_price ' +
      'column which only ever holds values for SPX rows). Parallel column ' +
      'instead of renaming spx_schwab_price → schwab_close so the existing ' +
      'readers in api/_lib/db-claude-tools.ts (4 SELECTs, the analyze-tool ' +
      'docstring, and the result mapper) continue working unchanged. NDX ' +
      'rows leave spx_schwab_price NULL and SPX rows leave ndx_schwab_price ' +
      'NULL — wasteful per-row but additive and safe; a future cleanup ' +
      'migration can collapse to a single schwab_close column once the ' +
      'reader migration completes.',
    statements: (sql) => [
      sql`ALTER TABLE index_candles_1m
            ADD COLUMN IF NOT EXISTS ndx_schwab_price NUMERIC`,
    ],
  },
  {
    id: 114,
    description:
      'Drop the spx_candles_1m compatibility view and the ' +
      'spx_candles_1m_compat_uniq partial unique index that migration ' +
      '#112 installed as bridge shims for unmigrated readers and the ' +
      'pre-Phase-1b cron INSERT. Phases 1d-i through 1d-vi migrated all ' +
      '7+ production readers (db-claude-tools, spx-candles, ' +
      'analyze-context, anomaly-context, postgres-day-summary, ' +
      'vix-divergence, journal/status) and all backfill scripts to read ' +
      'from index_candles_1m directly with explicit WHERE symbol = ' +
      "'SPX'. Phase 1b rewired the cron INSERT to use the new (symbol, " +
      'date, timestamp) constraint directly, retiring the partial-index ' +
      'workaround. Phase 1c added NDX flow to the same cron. After this ' +
      'migration, index_candles_1m is the single source of truth for ' +
      'index OHLC and no compat shims remain.',
    statements: (sql) => [
      sql`DROP VIEW IF EXISTS spx_candles_1m`,
      sql`DROP INDEX IF EXISTS spx_candles_1m_compat_uniq`,
    ],
  },
  {
    id: 115,
    description:
      'Drop push_subscriptions and regime_events tables. The Futures ' +
      'Gamma Playbook feature these tables backed (Web Push VAPID ' +
      'subscriptions in #49, server-detected regime alerts in #50) was ' +
      'removed from the app along with the monitor-regime-events cron, ' +
      'the /api/push/* endpoints, and the SW push handlers. No remaining ' +
      'reader writes to or reads from either table.',
    statements: (sql) => [
      sql`DROP TABLE IF EXISTS push_subscriptions`,
      sql`DROP TABLE IF EXISTS regime_events`,
    ],
  },
  {
    id: 116,
    description:
      'Create dark_pool_prints table for the uw-stream daemon to write ' +
      'every off_lit_trades WS payload from SPY and QQQ as a raw print. ' +
      'Replaces the cron-fed dark_pool_levels (pre-aggregated, SPY-only, ' +
      'static SPX×10 mapping baked into storage) with a row-per-print ' +
      'shape that supports multi-symbol coverage (SPX/NDX synthesized at ' +
      'read time via candle ratio in index_candles_1m) and ML feature ' +
      'engineering. Schema captures every field UW emits in the ' +
      'off_lit_trades payload — including slowly-varying symbol metadata ' +
      '(sector, marketcap, avg30_volume, next_earnings_date, issue_type) ' +
      '— per the user-decided full-fidelity capture preference. ' +
      'Idempotency via UNIQUE (symbol, executed_at, price, size) so ' +
      'daemon reconnect/replay does not duplicate prints. Lookup index on ' +
      '(symbol, date, executed_at DESC) serves the read endpoint that ' +
      'aggregates prints to per-level rollups for the dark pool panel. ' +
      'Daemon ingest filters: SPY+QQQ only, session hours 08:30–15:00 CT, ' +
      'drops extended_hours_trade and contingent_trade rows at the handler ' +
      'boundary (per memory feedback_extended_hours.md and ' +
      'feedback_contingent_trade_filter.md). See ' +
      'docs/superpowers/specs/uw-websocket-daemon-2026-05-02.md sub-design ' +
      'for full schema rationale.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS dark_pool_prints (
          id                  BIGSERIAL     PRIMARY KEY,
          date                DATE          NOT NULL,
          symbol              TEXT          NOT NULL,
          executed_at         TIMESTAMPTZ   NOT NULL,
          price               NUMERIC(12,4) NOT NULL,
          size                INTEGER       NOT NULL,
          volume              BIGINT,
          type                TEXT,
          trade_settlement    TEXT,
          trade_code          TEXT,
          ext_hour_sold_codes TEXT,
          sale_cond_codes     TEXT,
          nbbo_bid            NUMERIC(12,4),
          nbbo_ask            NUMERIC(12,4),
          nbbo_bid_quantity   INTEGER,
          nbbo_ask_quantity   INTEGER,
          sector              TEXT,
          next_earnings_date  DATE,
          avg30_volume        NUMERIC(18,2),
          issue_type          TEXT,
          marketcap           NUMERIC(20,2),
          premium             NUMERIC(18,2) NOT NULL,
          ingested_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
        )
      `,
      sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dark_pool_prints_dedup
          ON dark_pool_prints (symbol, executed_at, price, size)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_dark_pool_prints_symbol_date
          ON dark_pool_prints (symbol, date, executed_at DESC)
      `,
    ],
  },
  {
    id: 117,
    description:
      'Drop whale_anomalies table. The Whale Anomalies component (#94) ' +
      'and its detect-whales/resolve-whales crons were removed from the ' +
      'app. The whale_alerts table (migration #59) is preserved because ' +
      'the separate Whale Positioning feature still reads from it via ' +
      '/api/options-flow/whale-positioning and the fetch-whale-alerts cron.',
    statements: (sql) => [sql`DROP TABLE IF EXISTS whale_anomalies`],
  },
  {
    id: 118,
    description:
      'Drop whale_alerts table. The Whale Positioning sub-section inside ' +
      'Market Flow and the /api/options-flow/whale-positioning endpoint ' +
      'were removed along with the fetch-whale-alerts cron. No remaining ' +
      'reader writes to or reads from this table. flow_alerts is kept — ' +
      'uw-deltas.ts (Whale Flow Positioning signal) still queries it on ' +
      'every analyze-context build.',
    statements: (sql) => [sql`DROP TABLE IF EXISTS whale_alerts`],
  },
  {
    id: 119,
    description:
      'Drop institutional_blocks table. The SPXW Institutional Program ' +
      'component was removed from the app along with the ' +
      '/api/institutional-program endpoints, the fetch-spxw-blocks cron, ' +
      'and the orphaned anomaly-context.ts (last query against this ' +
      'table). No remaining reader writes to or reads from it.',
    statements: (sql) => [sql`DROP TABLE IF EXISTS institutional_blocks`],
  },
  {
    id: 120,
    description:
      'Drop dark_pool_levels table — Phase 7 cutover of the dark-pool ' +
      'cron-to-WS migration. The fetch-darkpool cron (deleted in commit ' +
      'd1a14162) wrote to this table; the dark-pool-query helper has ' +
      'been simplified to read exclusively from dark_pool_prints (the ' +
      'uw-stream daemon target). All 4 production consumers ' +
      '(darkpool-levels.ts, system-status.ts, build-features-phase2.ts, ' +
      'uw-deltas.ts) now go through the helper. Historical data was ' +
      'preserved via the backfill-dark-pool-prints.mjs script which ' +
      'pulled SPY+QQQ off-lit prints from UW REST into dark_pool_prints. ' +
      'See docs/superpowers/specs/uw-cron-to-websocket-migration-2026-05-02.md.',
    statements: (sql) => [sql`DROP TABLE IF EXISTS dark_pool_levels`],
  },
  {
    id: 121,
    description:
      'Create ws_net_flow_per_ticker table for the uw-stream daemon ' +
      'to write the UW WebSocket `net_flow:<TICKER>` per-tick stream. ' +
      'Input feed for the Lottery Net Flow per-fire panel (Phase 1 of ' +
      'docs/superpowers/specs/lottery-net-flow-2026-05-03.md). Each ' +
      'row is a per-tick DELTA (NOT cumulative — confirmed via UW ' +
      'reference notebook): `net_call_prem` is the increment over the ' +
      'prior emission for that ticker, NOT the running total. ' +
      'Cumulative chart values are computed at read time via ' +
      'SUM(...) OVER (PARTITION BY ticker, date ORDER BY ts). Storage ' +
      'shape mirrors ws_option_trades / ws_flow_alerts: typed columns ' +
      'for the emitted fields plus raw_payload JSONB for forward-compat. ' +
      'Natural dedupe key (ticker, ts) — UW emits at most one tick ' +
      'per ticker per millisecond on this channel.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS ws_net_flow_per_ticker (
          id BIGSERIAL PRIMARY KEY,
          ticker TEXT NOT NULL,
          ts TIMESTAMPTZ NOT NULL,
          net_call_prem NUMERIC(18, 2) NOT NULL,
          net_call_vol INTEGER NOT NULL,
          net_put_prem NUMERIC(18, 2) NOT NULL,
          net_put_vol INTEGER NOT NULL,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          raw_payload JSONB NOT NULL
        )
      `,
      // Dedupe key: UW emits at most one tick per ticker per ms.
      sql`CREATE UNIQUE INDEX IF NOT EXISTS ws_net_flow_per_ticker_uq
            ON ws_net_flow_per_ticker (ticker, ts)`,
      // Primary read pattern: time-series for a single ticker on a day.
      sql`CREATE INDEX IF NOT EXISTS ws_net_flow_per_ticker_ticker_ts_idx
            ON ws_net_flow_per_ticker (ticker, ts DESC)`,
      // Retention cron + cross-ticker time-window queries.
      sql`CREATE INDEX IF NOT EXISTS ws_net_flow_per_ticker_ts_idx
            ON ws_net_flow_per_ticker (ts)`,
    ],
  },
  {
    id: 122,
    description:
      'Create net_flow_per_ticker_history table for the REST-backfill EDA ' +
      'pipeline (Task 1.1 of docs/superpowers/specs/lottery-net-flow-eda-2026-05-03.md). ' +
      'Stores per-minute UW REST `/stock/{ticker}/net-prem-ticks` history for ' +
      '~50 lottery tickers × 90 days — the input feed for the Lottery Net Flow ' +
      'EDA (Phase 2). Kept separate from ws_net_flow_per_ticker (#121) to keep ' +
      'WS-live (per-tick deltas) and REST-backfill data clean; the `source` column ' +
      "('rest' / 'ws') allows a future union. Schema captures the full per-minute " +
      'delta payload including the bonus bid/ask side-split volume fields UW returns ' +
      'at the ticker level (call_volume_ask_side, call_volume_bid_side, ' +
      'put_volume_ask_side, put_volume_bid_side). Natural dedupe key ' +
      '(ticker, ts, source) — REST backfill may be re-run for a given ' +
      '(ticker, date, source) pair without duplicating rows.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS net_flow_per_ticker_history (
          id BIGSERIAL PRIMARY KEY,
          ticker TEXT NOT NULL,
          ts TIMESTAMPTZ NOT NULL,
          net_call_prem NUMERIC(18, 2) NOT NULL,
          net_call_vol INTEGER NOT NULL,
          net_put_prem NUMERIC(18, 2) NOT NULL,
          net_put_vol INTEGER NOT NULL,
          call_volume INTEGER NOT NULL,
          call_volume_ask_side INTEGER NOT NULL,
          call_volume_bid_side INTEGER NOT NULL,
          put_volume INTEGER NOT NULL,
          put_volume_ask_side INTEGER NOT NULL,
          put_volume_bid_side INTEGER NOT NULL,
          source TEXT NOT NULL,
          fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      // Dedupe key: REST backfill is re-runnable on (ticker, ts, source).
      sql`CREATE UNIQUE INDEX IF NOT EXISTS net_flow_per_ticker_history_ticker_ts_src_idx
            ON net_flow_per_ticker_history (ticker, ts, source)`,
      // Primary read pattern: time-series for a single ticker.
      sql`CREATE INDEX IF NOT EXISTS net_flow_per_ticker_history_ticker_ts_idx
            ON net_flow_per_ticker_history (ticker, ts DESC)`,
    ],
  },
  {
    id: 123,
    description:
      'Add (symbol, timestamp DESC) index on index_candles_1m. The existing ' +
      'unique key is (symbol, date, timestamp) — queries that JOIN by ' +
      '(symbol, timestamp) without filtering on date (e.g. dark-pool level ' +
      'synthesis in api/_lib/dark-pool-query.ts) degenerate to ~140 buffer ' +
      'pages per row. Dark pool levels query timed out at 12s on 12k prints ' +
      "for SPY 2026-05-01; with this index it's 296ms. Mirrors the " +
      'idx_etf_candles_1m_ticker_ts shape on etf_candles_1m.',
    statements: (sql) => [
      sql`CREATE INDEX IF NOT EXISTS idx_index_candles_1m_symbol_ts
            ON index_candles_1m (symbol, "timestamp" DESC)`,
    ],
  },
  {
    id: 124,
    description:
      'Add realized_flow_inversion_pct to lottery_finder_fires. The new exit policy validated in ' +
      '`ml/experiments/lottery-net-flow-eda/exit_simulation.py` against per-minute NBBO mid prices ' +
      'on the 15-day parquet window — exit when matched-side ticker net flow slope flips negative ' +
      'for >=3 consecutive minutes after the post-trigger flow peak. EDA showed +9.8pp mean uplift ' +
      'after costs and 5x lottery rate (6.7% vs 1.3% under trail-30/10) with edge concentrated on ' +
      'momentum-news days x call fires x AM/MID. Column is nullable; populated by exit_simulation.py ' +
      'with WRITE_DB=1 after each parquet refresh, same backfill-only pattern as the existing realized_* columns.',
    statements: (sql) => [
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS realized_flow_inversion_pct NUMERIC`,
    ],
  },
  {
    id: 125,
    description:
      'Create greek_flow_per_ticker_history table for the Dir-Delta inversion-exit EDA ' +
      '(docs/superpowers/specs/lottery-dir-delta-eda-2026-05-04.md). Stores per-minute UW REST ' +
      '/stock/{ticker}/greek-flow history for ~50 lottery tickers x 90 days — the input feed for ' +
      'testing whether delta-weighted directional flow produces a stronger inversion-exit signal ' +
      'than the all-strikes NCP we currently use. Schema mirrors the response shape: dir_delta_flow ' +
      '+ dir_vega_flow + OTM variants + totals + transaction/volume counters. Natural dedupe key ' +
      '(ticker, ts, source).',
    statements: (sql) => [
      sql`CREATE TABLE IF NOT EXISTS greek_flow_per_ticker_history (
        id BIGSERIAL PRIMARY KEY,
        ticker TEXT NOT NULL,
        ts TIMESTAMPTZ NOT NULL,
        dir_delta_flow NUMERIC,
        dir_vega_flow NUMERIC,
        otm_dir_delta_flow NUMERIC,
        otm_dir_vega_flow NUMERIC,
        total_delta_flow NUMERIC,
        total_vega_flow NUMERIC,
        otm_total_delta_flow NUMERIC,
        otm_total_vega_flow NUMERIC,
        transactions INTEGER,
        volume INTEGER,
        source TEXT NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS greek_flow_per_ticker_history_ticker_ts_src_idx
          ON greek_flow_per_ticker_history (ticker, ts, source)`,
      sql`CREATE INDEX IF NOT EXISTS greek_flow_per_ticker_history_ticker_ts_idx
          ON greek_flow_per_ticker_history (ticker, ts DESC)`,
    ],
  },
  {
    id: 126,
    description:
      'Add tiered scoring to lottery_finder_fires + create lottery_ticker_stats. ' +
      'Phase 1 of docs/superpowers/plans/lottery-tiered-scoring-ui.md. The score ' +
      'is the sum of weights for ticker × mode × entry-price × TOD × option-type, ' +
      'computed deterministically on insert (api/_lib/lottery-score-weights.ts). ' +
      'Tier (≥18 / 12-17 / <12) is derived from score in the read path. ' +
      'lottery_ticker_stats holds Wilson-CI-bounded high-peak rates per ticker ' +
      '(seeded from ml/data/lottery_ticker_stats.json on the 21-day window) so ' +
      'the UI can show ✓/⚠️ reliability indicators next to ticker names. The ' +
      '(date DESC, score DESC NULLS LAST) index supports `?sort=score` ORDER BYs.',
    statements: (sql) => [
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS score INTEGER`,
      sql`CREATE INDEX IF NOT EXISTS lottery_finder_fires_date_score_idx
            ON lottery_finder_fires (date DESC, score DESC NULLS LAST)`,
      sql`CREATE TABLE IF NOT EXISTS lottery_ticker_stats (
        ticker TEXT PRIMARY KEY,
        n_fires INTEGER NOT NULL,
        high_peak_rate NUMERIC NOT NULL,
        ci_lower NUMERIC NOT NULL,
        ci_upper NUMERIC NOT NULL,
        ci_width NUMERIC NOT NULL,
        tier TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      sql`INSERT INTO lottery_ticker_stats
            (ticker, n_fires, high_peak_rate, ci_lower, ci_upper, ci_width, tier)
          SELECT
            ticker, n_fires, high_peak_rate, ci_lower, ci_upper, ci_width, tier
          FROM jsonb_to_recordset(${JSON.stringify(LOTTERY_TICKER_STATS_SEED)}::jsonb)
            AS s(
              ticker TEXT,
              n_fires INTEGER,
              high_peak_rate NUMERIC,
              ci_lower NUMERIC,
              ci_upper NUMERIC,
              ci_width NUMERIC,
              tier TEXT
            )
          ON CONFLICT (ticker) DO UPDATE SET
            n_fires = EXCLUDED.n_fires,
            high_peak_rate = EXCLUDED.high_peak_rate,
            ci_lower = EXCLUDED.ci_lower,
            ci_upper = EXCLUDED.ci_upper,
            ci_width = EXCLUDED.ci_width,
            tier = EXCLUDED.tier,
            updated_at = NOW()`,
    ],
  },
  {
    id: 127,
    description:
      'Create option_intraday_nbbo + option_intraday_nbbo_fetches cache tables for the ' +
      'flow-inversion automation pipeline (Phase 2 of ' +
      'docs/superpowers/specs/lottery-flow-inversion-automation-2026-05-05.md). ' +
      'option_intraday_nbbo caches per-minute UW REST `/option-contract/{id}/intraday` rows ' +
      'so the post-close enrich-lottery-outcomes cron can re-run the ' +
      'realized_flow_inversion_pct computation without re-pulling UW. The endpoint does ' +
      'not expose nbbo_bid/nbbo_ask directly — we store the side-split premium + volume ' +
      'fields and derive a synthetic mid in code as ' +
      '(premium_ask_side/volume_ask_side + premium_bid_side/volume_bid_side)/2 with ' +
      '(high+low)/2 and close_price fallbacks. PK (option_chain, ts) auto-creates the ' +
      'index used by both the read path (chain ASC + ts ASC for the post-trigger walk) ' +
      'and the upsert path (ON CONFLICT). option_intraday_nbbo_fetches is a small ' +
      'tracking table keyed (option_chain, date) so empty-result fetches are not retried ' +
      'on every cron run — status=ok|empty|error + rows_fetched short-circuits the ' +
      'fetcher when we have already attempted the (chain, date) pair.',
    statements: (sql) => [
      sql`CREATE TABLE IF NOT EXISTS option_intraday_nbbo (
        option_chain TEXT NOT NULL,
        ts TIMESTAMPTZ NOT NULL,
        avg_price NUMERIC(14, 6),
        close_price NUMERIC(14, 6),
        high_price NUMERIC(14, 6),
        low_price NUMERIC(14, 6),
        premium_ask_side NUMERIC(20, 4),
        premium_bid_side NUMERIC(20, 4),
        premium_mid_side NUMERIC(20, 4),
        volume_ask_side INTEGER,
        volume_bid_side INTEGER,
        volume_mid_side INTEGER,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (option_chain, ts)
      )`,
      sql`CREATE TABLE IF NOT EXISTS option_intraday_nbbo_fetches (
        option_chain TEXT NOT NULL,
        date DATE NOT NULL,
        rows_fetched INTEGER NOT NULL,
        status TEXT NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (option_chain, date),
        CONSTRAINT option_intraday_nbbo_fetches_status_chk
          CHECK (status IN ('ok', 'empty', 'error'))
      )`,
    ],
  },
  {
    id: 128,
    description:
      'Drop trace_live_analyses + trace_live_calibration tables. The TRACE Live feature (created in #88, extended in #89/90/91, with stratified residual calibration in #102) was removed from the app along with all api/trace-live-* endpoints, the resolve-trace-residuals cron, the capture daemon, and the populateTraceLiveOutcomes step in fetch-outcomes. CASCADE drops the HNSW + captured_at + actual_close indexes installed in #88/90 automatically. Idempotent — IF EXISTS makes re-runs on a fresh DB no-ops.',
    statements: (sql) => [
      sql`DROP TABLE IF EXISTS trace_live_analyses CASCADE`,
      sql`DROP TABLE IF EXISTS trace_live_calibration CASCADE`,
    ],
  },
  {
    id: 129,
    description:
      'Add expiry column to vega_flow_etf for per-expiry (0DTE) and all-expiries (NULL) co-storage. ' +
      'Replaces the (ticker, timestamp) unique constraint with (ticker, timestamp, expiry) using ' +
      'NULLS NOT DISTINCT (Postgres 15+) so all-DTE rows (expiry IS NULL — existing behavior) coexist ' +
      'with per-expiry rows (expiry = date) under one constraint. Adds (ticker, date, expiry) index ' +
      'for the panel scope filter. Backs the Greek Flow panel scope toggle — see ' +
      'docs/superpowers/specs/greek-flow-0dte-toggle-2026-05-06.md.',
    statements: (sql) => [
      sql`ALTER TABLE vega_flow_etf ADD COLUMN IF NOT EXISTS expiry DATE`,
      sql`ALTER TABLE vega_flow_etf DROP CONSTRAINT IF EXISTS vega_flow_etf_ticker_timestamp_key`,
      sql`ALTER TABLE vega_flow_etf ADD CONSTRAINT vega_flow_etf_ticker_timestamp_expiry_key UNIQUE NULLS NOT DISTINCT (ticker, timestamp, expiry)`,
      sql`CREATE INDEX IF NOT EXISTS idx_vega_flow_etf_ticker_date_expiry ON vega_flow_etf (ticker, date, expiry)`,
    ],
  },
  {
    id: 130,
    description:
      'Drop and rebuild periscope_analyses for the 3-mode lifecycle ' +
      '(pre_trade / intraday / debrief). User-approved CASCADE rebuild — ' +
      'no FK consumers exist beyond the self-reference via parent_id ' +
      '(verified Phase 0 audit). Adds the structured trading playbook ' +
      'columns (bias, trade_types_recommended, trade_types_avoided, ' +
      'key_levels, expected_dealer_behavior, confidence, confidence_basis, ' +
      'parse_ok), the read-time anchor columns (read_time, ' +
      'spot_at_read_time, spot_source) so DB-looked-up SPX spot replaces ' +
      'the chart red-dotted-line spot, and an ON DELETE SET NULL on the ' +
      'parent_id self-reference (was missing in v1 — orphaned a debrief ' +
      'on parent delete). Indexes: (mode, calibration_quality) for ' +
      'retrieval pre-filter, (parent_id) for chain traversal, partial ' +
      '(calibration_quality DESC, created_at DESC) for the gold library ' +
      'pull, and the HNSW on analysis_embedding carried forward. See ' +
      'spec: docs/superpowers/specs/periscope-chat-overhaul-2026-05-05.md.',
    statements: (sql) => [
      sql`DROP TABLE IF EXISTS periscope_analyses CASCADE`,
      sql`
        CREATE TABLE periscope_analyses (
          id                          BIGSERIAL PRIMARY KEY,
          trading_date                DATE NOT NULL,
          captured_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          read_time                   TIMESTAMPTZ NOT NULL,
          spot_at_read_time           NUMERIC(10,2) NOT NULL,
          spot_source                 TEXT NOT NULL
                                      CHECK (spot_source IN ('db_exact', 'db_snapped')),
          mode                        TEXT NOT NULL
                                      CHECK (mode IN ('pre_trade', 'intraday', 'debrief')),
          parent_id                   BIGINT REFERENCES periscope_analyses(id) ON DELETE SET NULL,
          user_context                TEXT,
          image_urls                  JSONB NOT NULL DEFAULT '[]'::jsonb,
          prose_text                  TEXT NOT NULL,
          full_response               JSONB NOT NULL,
          analysis_embedding          vector(2000),
          spot                        NUMERIC(10,2),
          cone_lower                  NUMERIC(10,2),
          cone_upper                  NUMERIC(10,2),
          long_trigger                NUMERIC(10,2),
          short_trigger               NUMERIC(10,2),
          regime_tag                  TEXT,
          bias                        TEXT
                                      CHECK (bias IN ('long-only', 'short-only', 'fade-only', 'two-sided', 'no-trade')),
          trade_types_recommended     JSONB NOT NULL DEFAULT '[]'::jsonb,
          trade_types_avoided         JSONB NOT NULL DEFAULT '[]'::jsonb,
          key_levels                  JSONB,
          expected_dealer_behavior    TEXT,
          confidence                  TEXT
                                      CHECK (confidence IN ('low', 'medium', 'high')),
          confidence_basis            TEXT,
          parse_ok                    BOOLEAN NOT NULL DEFAULT FALSE,
          calibration_quality         SMALLINT
                                      CHECK (calibration_quality BETWEEN 1 AND 5),
          model                       TEXT NOT NULL,
          input_tokens                INTEGER,
          output_tokens               INTEGER,
          cache_read_tokens           INTEGER,
          cache_write_tokens          INTEGER,
          duration_ms                 INTEGER,
          created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      sql`
        CREATE INDEX idx_periscope_analyses_trading_date
          ON periscope_analyses (trading_date DESC)
      `,
      sql`
        CREATE INDEX idx_periscope_analyses_mode_calibration
          ON periscope_analyses (mode, calibration_quality)
      `,
      sql`
        CREATE INDEX idx_periscope_analyses_parent_chain
          ON periscope_analyses (parent_id)
      `,
      sql`
        CREATE INDEX idx_periscope_analyses_calibration_quality
          ON periscope_analyses (calibration_quality DESC, created_at DESC)
          WHERE calibration_quality IS NOT NULL
      `,
      sql`
        CREATE INDEX idx_periscope_analyses_embedding_hnsw
          ON periscope_analyses USING hnsw (analysis_embedding vector_cosine_ops)
          WHERE analysis_embedding IS NOT NULL
      `,
    ],
  },
  {
    id: 131,
    description:
      'Add futures_plan TEXT column to periscope_analyses for directional futures execution string (LONG/SHORT/WAIT framing tied to MM positioning).',
    statements: (sql) => [
      sql`ALTER TABLE periscope_analyses ADD COLUMN IF NOT EXISTS futures_plan TEXT`,
    ],
  },
  {
    id: 132,
    description:
      'Add realized_* columns to periscope_analyses for retrospective outcome scoring (entry vs end-of-session price action). Populated post-hoc by ml/src/compute_realized_outcomes.py — null = pending.',
    statements: (sql) => [
      sql`ALTER TABLE periscope_analyses
        ADD COLUMN IF NOT EXISTS realized_r NUMERIC,
        ADD COLUMN IF NOT EXISTS realized_close_pts NUMERIC,
        ADD COLUMN IF NOT EXISTS realized_max_favorable_pts NUMERIC,
        ADD COLUMN IF NOT EXISTS realized_max_adverse_pts NUMERIC,
        ADD COLUMN IF NOT EXISTS realized_trigger_fired TEXT
          CHECK (realized_trigger_fired IN ('long', 'short', 'neither')),
        ADD COLUMN IF NOT EXISTS realized_computed_at TIMESTAMPTZ`,
    ],
  },
  {
    id: 133,
    description:
      'Create periscope_lessons table for the curate-periscope-lessons cron. Stores trader-supplied lessons extracted from the "What to add to the model" section of mode=debrief periscope_analyses rows. Status lifecycle: proposed -> active (manual SQL promotion in MVP) -> archived. Active rows inject as a "## Recent lessons learned" sub-section into the cached references block on every periscope-chat call. HNSW on embedding gates dedup (cosine >= 0.8 -> merge into existing row, else insert new proposed). See spec: docs/superpowers/specs/periscope-curate-lessons-2026-05-06.md.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS periscope_lessons (
          id             BIGSERIAL PRIMARY KEY,
          lesson_text    TEXT NOT NULL,
          source_ids     BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
          embedding      vector(2000),
          status         TEXT NOT NULL DEFAULT 'proposed'
                         CHECK (status IN ('proposed', 'active', 'archived')),
          citation_count INT NOT NULL DEFAULT 1,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          promoted_at    TIMESTAMPTZ,
          archived_at    TIMESTAMPTZ
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_periscope_lessons_status
          ON periscope_lessons (status)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_periscope_lessons_embedding
          ON periscope_lessons USING hnsw (embedding vector_cosine_ops)
          WHERE embedding IS NOT NULL AND status != 'archived'
      `,
    ],
  },
  {
    id: 134,
    description:
      'Create silent_boom_alerts table for the detect-silent-boom cron. Surfaces a step-change anomaly pattern: chains that trade silently for 15-20 min then exhibit a single 5-min ask-side block much larger than their own trailing-window baseline. Distinct from lottery_finder_fires (sustained-burst detector) — the silent-boom signature is a temporal discontinuity, not a cumulative shape. Empirical basis: scripts/silent_boom_audit.py, n=13,958 fires across 19 days, peak ceiling +26% / 71.7% win rate, but ~0% mean realized at fixed horizons → discretionary signal, surfaced for manual review. Includes realized_*_pct + peak_ceiling_pct enrichment columns (populated by scripts/enrich_silent_boom_outcomes.py from parquet, mirrors the lottery_finder_fires enrichment pattern). Spec: docs/superpowers/specs/silent-boom-detector-2026-05-08.md.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS silent_boom_alerts (
          id                BIGSERIAL PRIMARY KEY,
          date              DATE NOT NULL,
          bucket_ct         TIMESTAMPTZ NOT NULL,
          option_chain_id   TEXT NOT NULL,
          underlying_symbol TEXT NOT NULL,
          option_type       CHAR(1) NOT NULL
                            CHECK (option_type IN ('C', 'P')),
          strike            NUMERIC NOT NULL,
          expiry            DATE NOT NULL,
          dte               SMALLINT NOT NULL,
          spike_volume      INT NOT NULL,
          baseline_volume   NUMERIC NOT NULL,
          spike_ratio       NUMERIC NOT NULL,
          ask_pct           NUMERIC NOT NULL,
          vol_oi            NUMERIC NOT NULL,
          entry_price       NUMERIC NOT NULL,
          open_interest     INT NOT NULL,
          -- Enrichment columns — populated by enrich_silent_boom_outcomes.py
          -- from the parquet trade tape after market close. Same shape
          -- as lottery_finder_fires realized_* columns.
          peak_ceiling_pct      NUMERIC,
          minutes_to_peak       NUMERIC,
          realized_30m_pct      NUMERIC,
          realized_60m_pct      NUMERIC,
          realized_120m_pct     NUMERIC,
          realized_eod_pct      NUMERIC,
          enriched_at           TIMESTAMPTZ,
          inserted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS silent_boom_alerts_chain_bucket_uq
            ON silent_boom_alerts (option_chain_id, bucket_ct)`,
      sql`CREATE INDEX IF NOT EXISTS silent_boom_alerts_date_bucket_idx
            ON silent_boom_alerts (date DESC, bucket_ct DESC)`,
      sql`CREATE INDEX IF NOT EXISTS silent_boom_alerts_ticker_idx
            ON silent_boom_alerts (underlying_symbol, date DESC)`,
      sql`CREATE INDEX IF NOT EXISTS silent_boom_alerts_unenriched_idx
            ON silent_boom_alerts (date) WHERE enriched_at IS NULL`,
    ],
  },
  {
    id: 135,
    description:
      'Add score + score_tier columns to silent_boom_alerts. Score is an integer composite of 7 feature buckets (DTE, baseline_volume, spike_ratio, entry_price, TOD, ask_pct, option_type) calibrated against the historical 14,100-fire sample — see docs/tmp/silent-boom-feature-audit-2026-05-08.md and api/_lib/silent-boom-score.ts. Tier is the 3-level conviction badge (tier1/tier2/tier3) the dashboard renders; tier1 historically lands ~5% of fires with ~56% peak >= 50% rate vs ~8% for tier3. Spec: docs/superpowers/specs/silent-boom-scoring-2026-05-08.md.',
    statements: (sql) => [
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS score SMALLINT`,
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS score_tier TEXT
            CHECK (score_tier IN ('tier1', 'tier2', 'tier3'))`,
      sql`CREATE INDEX IF NOT EXISTS silent_boom_alerts_date_tier_idx
            ON silent_boom_alerts (date DESC, score_tier)`,
    ],
  },
  {
    id: 136,
    description:
      'Add mkt_tide_diff column to silent_boom_alerts. Snapshot of the Market Tide NCP - NPP at the spike-bucket time (sourced from flow_data WHERE source = market_tide, latest tick at or before bucket_ct within 30min). Display-only macro context surfaced as the Tide ⬆/⬇ badge on each row — same pattern as lottery_finder_fires.macro.mkt_tide_diff. Not a selection signal. Populated forward by the detect-silent-boom cron and backfill_silent_boom_from_parquet.py; existing rows are UPDATEd in a one-shot via the migration helper script (out-of-band).',
    statements: (sql) => [
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS mkt_tide_diff NUMERIC`,
    ],
  },
  {
    id: 137,
    description:
      'Add zero_dte_diff + spx_spot_gamma_oi columns to silent_boom_alerts. zero_dte_diff snapshots flow_data WHERE source = zero_dte_greek_flow (NCP - NPP) at the spike-bucket time; spx_spot_gamma_oi snapshots spot_exposures WHERE ticker = SPX (gamma_oi sign). Display-only regime context surfaced as the Day Banner regime strip on the dashboard — mirrors lottery_finder_fires.macro.zero_dte_diff and macro.spx_spot_gamma_oi. Not selection signals. Populated forward by detect-silent-boom and backfill_silent_boom_from_parquet.py; existing rows UPDATEd in one-shot via helper script.',
    statements: (sql) => [
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS zero_dte_diff NUMERIC`,
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS spx_spot_gamma_oi NUMERIC`,
    ],
  },
  {
    id: 138,
    description:
      'Create cone_levels table for the daily 0DTE straddle breakeven cone (Phase 1 of docs/superpowers/specs/periscope-html-ingestion-2026-05-07.md). Replaces user-input manual cone bounds with auto-computed values from the SPX 0DTE option chain at 9:31 ET. Cone bounds derive from the ATM call+put marks: cone_upper = atm_strike + call_premium, cone_lower = atm_strike - put_premium. asymmetry_pts = (atm_strike - cone_lower) - (cone_upper - atm_strike); positive = downside-skewed (puts richer than calls). Read by the check-cone-breach cron + future ConeStatusPill UI panel. Date PK enforces one cone per session.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS cone_levels (
          date          DATE PRIMARY KEY,
          calc_time     TIMESTAMPTZ NOT NULL,
          spot_at_calc  NUMERIC(10,2) NOT NULL,
          atm_strike    INT NOT NULL,
          call_premium  NUMERIC(10,4) NOT NULL,
          put_premium   NUMERIC(10,4) NOT NULL,
          cone_upper    NUMERIC(10,2) NOT NULL,
          cone_lower    NUMERIC(10,2) NOT NULL,
          cone_width    NUMERIC(8,2) NOT NULL,
          asymmetry_pts NUMERIC(8,2) NOT NULL,
          inserted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
    ],
  },
  {
    id: 139,
    description:
      'Create cone_breach_events table for first-breach-per-direction-per-day events (Phase 1 of docs/superpowers/specs/periscope-html-ingestion-2026-05-07.md). Written by the check-cone-breach cron every minute during RTH; UNIQUE (date, direction) gives natural idempotency so the cron writes one upper + one lower row per session even though it runs ~390 times. Backs the cone-status pill (INSIDE / BREACHED_UP / BREACHED_DOWN) and the planned push-notification on first breach. Per UW: SPX exceeding the 0DTE straddle breakeven tends to extend (vol expansion), not fade — this table is the trigger surface for the chase-the-breakout futures bias.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS cone_breach_events (
          id                   BIGSERIAL PRIMARY KEY,
          date                 DATE NOT NULL,
          direction            TEXT NOT NULL CHECK (direction IN ('upper', 'lower')),
          breach_time          TIMESTAMPTZ NOT NULL,
          spot_at_breach       NUMERIC(10,2) NOT NULL,
          cone_bound_at_breach NUMERIC(10,2) NOT NULL,
          pts_past_bound       NUMERIC(8,2) NOT NULL,
          inserted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (date, direction)
        )
      `,
    ],
  },
  {
    id: 140,
    description:
      'Create periscope_snapshots table for the periscope-scraper Railway service (Phase 2 of docs/superpowers/specs/periscope-html-ingestion-2026-05-07.md). Stores per-strike MM-attributed dealer-flow values from UW Periscope HTML — Gamma / Charm / Vanna / Positions — captured every 10 min during RTH. Each snapshot covers the full chain (typically 150+ strikes) for the user-configured 0DTE expiry. UNIQUE (captured_at, expiry, panel, strike) gives natural idempotency on retry. Composite index supports the read-time queries the derived-signal layer (Phase 3) will run: prior-slice lookups for sign flips, time-series scans for charm-zero migration, and ±100pt windowed aggregations for charm tally. Schema accommodates Vanna which is mandatory on vol-shock days even though 0DTE Vanna is small — multi-DTE vanna is the dominant dealer-flow driver during VIX moves.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS periscope_snapshots (
          id          BIGSERIAL PRIMARY KEY,
          captured_at TIMESTAMPTZ NOT NULL,
          expiry      DATE NOT NULL,
          panel       TEXT NOT NULL CHECK (panel IN ('gamma', 'charm', 'vanna', 'positions')),
          strike      INT NOT NULL,
          value       NUMERIC(14,2) NOT NULL,
          inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (captured_at, expiry, panel, strike)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_periscope_snapshots_lookup
          ON periscope_snapshots (expiry, panel, captured_at, strike)
      `,
    ],
  },
  {
    id: 141,
    description:
      'Add timeframe column to periscope_snapshots to record the UW slot label (e.g. "09:10 - 09:20") each row was actually captured from. Greek-cycling within a single tick takes 5–10s, and UW publishes a new 10-min slot mid-cycle every 10 min — without a per-row timeframe, the three panels at one captured_at could silently come from different slots. Storing the parsed label per row makes drift visible to the formatter and the panel, and lets the scraper realign timeframe back to the gamma anchor on subsequent Greek captures. Nullable so existing rows stay valid; the scraper writes a real value for every new row.',
    statements: (sql) => [
      sql`
        ALTER TABLE periscope_snapshots
        ADD COLUMN IF NOT EXISTS timeframe TEXT
      `,
    ],
  },
  {
    id: 142,
    description:
      'Extend periscope_analyses for the auto-playbook lifecycle (scraper-triggered Claude reads at 10-min cadence — Phase 1 of docs/superpowers/specs/periscope-auto-playbook-2026-05-10.md). Adds auto_generated flag distinguishing rows written by the cron path from manual entries; slot_captured_at to anchor each row to the exact periscope_snapshots tick it analyzed; status (in_progress / complete / failed / truncated) so the panel can render mid-flight states distinctly and surface max_tokens truncation rather than silently storing null payloads; failure_reason for status=failed forensics; panel_payload JSONB holding the structured tool_use output the frontend renders directly (SPOT, CONE, LONG/SHORT TRIGGER, REGIME, RECOMMENDED, AVOID, FUTURES PLAN, gamma floor/ceiling, charm zero, narrative). Unique (trading_date, slot_captured_at, auto_generated) lets the auto path and a manual rerun coexist for the same slot — Postgres NULL-distinct semantics on slot_captured_at keep historical rows (slot_captured_at IS NULL) valid without colliding. Partial index on (trading_date DESC, slot_captured_at DESC) WHERE status = complete supports the panel "latest playbook for today" query without scanning in-progress / failed / truncated rows. All columns nullable or default-backfilled so existing manual rows stay valid; the auto-playbook code path populates them on every new row.',
    statements: (sql) => [
      sql`
        ALTER TABLE periscope_analyses
        ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN NOT NULL DEFAULT FALSE
      `,
      sql`
        ALTER TABLE periscope_analyses
        ADD COLUMN IF NOT EXISTS slot_captured_at TIMESTAMPTZ
      `,
      sql`
        ALTER TABLE periscope_analyses
        ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'complete'
        CHECK (status IN ('in_progress', 'complete', 'failed', 'truncated'))
      `,
      sql`
        ALTER TABLE periscope_analyses
        ADD COLUMN IF NOT EXISTS failure_reason TEXT
      `,
      sql`
        ALTER TABLE periscope_analyses
        ADD COLUMN IF NOT EXISTS panel_payload JSONB
      `,
      sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_periscope_analyses_unique_slot
          ON periscope_analyses (trading_date, slot_captured_at, auto_generated)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_periscope_analyses_latest
          ON periscope_analyses (trading_date DESC, slot_captured_at DESC)
          WHERE status = 'complete'
      `,
    ],
  },
  {
    id: 143,
    description:
      'Create periscope_grades for EOD deterministic scoring of every auto-generated playbook (Phase 1 of docs/superpowers/specs/periscope-calibration-grading-2026-05-11.md). One row per (periscope_analysis_id, grader_version) — bumping the version when the rubric changes preserves historical grades for compare. Stores per-dimension binary grades (regime_correct, bias_correct, cone_held, gamma_floor_held, gamma_ceiling_held, charm_drift_correct, long_fired, short_fired, ic_blown_at_eod) alongside the raw observations (regime_observed, bias_observed_return, fire timestamps) that produced them — keeping the inputs lets a future re-grade run against archived state without re-fetching candles. trade_sims JSONB holds an array of {asset, side, entry, exit, exit_reason, pnl_pct, duration_min} entries (one per fired trigger × asset in {SPX, ES, NQ}); JSONB instead of normalized columns because the per-slot count varies 0–6 and the access pattern is whole-row reads. recommended/avoid_structures_correct hold {structure_name: bool|null} maps so we can compute per-structure accuracy without enumerating columns. graded_at + grader_version let the CLI surface "this was scored on rubric v1 at 15:30 CT". CASCADE on the FK so deleting a parent analysis (rare — only for test cleanup) drops the grade with it.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS periscope_grades (
          id BIGSERIAL PRIMARY KEY,
          periscope_analysis_id BIGINT NOT NULL
            REFERENCES periscope_analyses(id) ON DELETE CASCADE,
          trading_date DATE NOT NULL,
          slot_captured_at TIMESTAMPTZ NOT NULL,
          mode VARCHAR(20) NOT NULL
            CHECK (mode IN ('pre_trade', 'intraday', 'debrief')),
          confidence VARCHAR(20),
          grader_version INTEGER NOT NULL DEFAULT 1,

          regime_call TEXT,
          regime_observed TEXT,
          regime_correct BOOLEAN,

          bias_call TEXT,
          bias_observed_return NUMERIC(10, 6),
          bias_correct BOOLEAN,

          cone_lower NUMERIC(10, 3),
          cone_upper NUMERIC(10, 3),
          cone_held BOOLEAN,
          gamma_floor NUMERIC(10, 3),
          gamma_floor_held BOOLEAN,
          gamma_ceiling NUMERIC(10, 3),
          gamma_ceiling_held BOOLEAN,

          charm_zero NUMERIC(10, 3),
          charm_drift_call TEXT,
          charm_drift_observed_pct NUMERIC(10, 6),
          charm_drift_correct BOOLEAN,

          long_trigger NUMERIC(10, 3),
          long_fired BOOLEAN NOT NULL DEFAULT FALSE,
          long_fired_at TIMESTAMPTZ,
          short_trigger NUMERIC(10, 3),
          short_fired BOOLEAN NOT NULL DEFAULT FALSE,
          short_fired_at TIMESTAMPTZ,

          trade_sims JSONB NOT NULL DEFAULT '[]'::jsonb,

          eod_close NUMERIC(10, 3),
          ic_blown_at_eod BOOLEAN,

          recommended_structures_correct JSONB NOT NULL DEFAULT '{}'::jsonb,
          avoid_structures_correct JSONB NOT NULL DEFAULT '{}'::jsonb,

          graded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_periscope_grades_unique
          ON periscope_grades (periscope_analysis_id, grader_version)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_periscope_grades_date
          ON periscope_grades (trading_date DESC, slot_captured_at DESC)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_periscope_grades_date_version
          ON periscope_grades (trading_date DESC, grader_version)
      `,
    ],
  },
  {
    id: 144,
    description:
      'Create interval_ba_alerts for SPXW per-contract 5-min Interval B/A ask-side alert events (Phase 2 of docs/superpowers/specs/interval-ba-ask-alert-2026-05-12.md). Written by the uw-stream SPXWIntervalBAHandler when a 0DTE SPXW contract crosses the configured ask-side premium ratio (default 70%) AND clears the floor (default $250K) within its current 5-min wall-clock bucket. Schema captures bucket boundaries, the ratio + premium aggregates at fire time, the dominant ask-side print that drove the ratio (premium / size / executed_at / is_sweep / is_floor) so the user can jump straight to the per-trade tape, and the SPX underlying price snapshot for chart context. UNIQUE (option_chain, bucket_start) is the natural dedupe key — the handler already enforces "one alert per contract per bucket" in memory, but the constraint guarantees idempotency across daemon restarts. Two indexes: (fired_at DESC) for the polled REST read endpoint /api/interval-ba-alerts?since=ISO, and a partial (acknowledged, fired_at DESC) WHERE acknowledged = FALSE for the chime-repeat loop in useIntervalBAAlerts (mirrors the market_alerts pattern from #25). Phase 2 only creates the table; the handler ships with interval_ba_enabled=False until the env var is flipped post-migration.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS interval_ba_alerts (
          id BIGSERIAL PRIMARY KEY,
          option_chain TEXT NOT NULL,
          ticker TEXT NOT NULL,
          option_type CHAR(1) NOT NULL CHECK (option_type IN ('C', 'P')),
          strike NUMERIC(10, 3) NOT NULL,
          expiry DATE NOT NULL,
          bucket_start TIMESTAMPTZ NOT NULL,
          bucket_end TIMESTAMPTZ NOT NULL,
          fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ratio_pct NUMERIC(5, 2) NOT NULL,
          ask_premium NUMERIC(14, 2) NOT NULL,
          total_premium NUMERIC(14, 2) NOT NULL,
          trade_count INTEGER NOT NULL,
          top_trade_premium NUMERIC(14, 2),
          top_trade_size INTEGER,
          top_trade_executed_at TIMESTAMPTZ,
          top_trade_is_sweep BOOLEAN,
          top_trade_is_floor BOOLEAN,
          underlying_price NUMERIC(10, 2),
          acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
          UNIQUE (option_chain, bucket_start)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_interval_ba_alerts_fired_at
          ON interval_ba_alerts (fired_at DESC)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_interval_ba_alerts_ack
          ON interval_ba_alerts (acknowledged, fired_at DESC)
          WHERE acknowledged = FALSE
      `,
    ],
  },
  {
    id: 145,
    description:
      'Create push_subscriptions table for Web Push VAPID fan-out of SPXW Interval B/A alerts (v2 of docs/superpowers/specs/interval-ba-ask-alert-2026-05-12.md, see docs/superpowers/specs/interval-ba-push-v2-2026-05-12.md). Stores one row per device-subscription that the owner has granted Notification permission on. endpoint is UNIQUE so the same browser re-subscribing UPSERTs cleanly (browser may rotate the endpoint on profile reset, generating a new row — orphan rows are cleaned up post-410 in api/_lib/push.ts). NOT keyed by user_id — single-owner app; multiple rows = multiple devices for the same owner. Fan-out by api/push/notify reads all rows and posts the payload to each endpoint using the web-push SDK. Distinct from the prior push_subscriptions table (#78, dropped in #115) which carried a user_id column and FuturesGammaPlaybook-specific shape — that table has been gone for weeks so there is no name collision risk on a fresh DB. created_at DESC index supports the "show me my devices" admin query; the UNIQUE constraint on endpoint serves the UPSERT path without needing a separate named index.',
    statements: (sql) => [
      sql`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id BIGSERIAL PRIMARY KEY,
          endpoint TEXT NOT NULL UNIQUE,
          p256dh_key TEXT NOT NULL,
          auth_key TEXT NOT NULL,
          user_agent TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_used_at TIMESTAMPTZ
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_push_subscriptions_created_at
          ON push_subscriptions (created_at DESC)
      `,
    ],
  },
  {
    id: 146,
    description:
      'Add multi_leg_share NUMERIC column to silent_boom_alerts (spec: docs/superpowers/specs/silent-boom-ask-100-demote-2026-05-12.md). Stores the fraction of spike-bucket size whose UW trade_code is one of mlat/mlet/mlft/mfto/masl/mesl/mfsl/mlct — the OPRA-standard multi-leg sale condition codes. The detector now rejects buckets whose multi_leg_share ≥ 0.50 outright so spread-leg-dominated prints never enter the table; surviving rows carry the share for tooltip display + analytical drill-down. Empirical basis: scripts/analyze_silent_boom_multileg.py 2026-05-12, showing multi-leg fires win > 100% at 3× lower rate than single-leg fires in every ask% band (95-99% control: 3.8% vs 11.7%). Nullable because rows written before this migration have no attribution available (ws_option_trades retention is 7d); the backfill script populates where parquet data is available, otherwise leaves NULL.',
    statements: (sql) => [
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS multi_leg_share NUMERIC`,
      sql`CREATE INDEX IF NOT EXISTS silent_boom_alerts_ml_share_idx
            ON silent_boom_alerts (multi_leg_share)
            WHERE multi_leg_share IS NOT NULL`,
    ],
  },
  {
    id: 147,
    description:
      "Add confluence_tickers column to interval_ba_alerts (Phase 1 of docs/superpowers/specs/interval-ba-confluence-2026-05-13.md). Records which other tickers (SPY, QQQ) fired same-direction within a 90-second window of each alert — populated by the uw-stream handler at fire time (Phase 4). TEXT[] so multiple co-firing tickers can coexist in one row. GIN index supports WHERE confluence_tickers @> ARRAY['SPY'] array-containment queries from the feed endpoint filter (= ANY() would seq-scan; @> uses the GIN entries). Column defaults to NULL on existing rows; backfill deferred to Phase 7.",
    statements: (sql) => [
      sql`
        ALTER TABLE interval_ba_alerts
        ADD COLUMN IF NOT EXISTS confluence_tickers TEXT[]
      `,
      sql`
        CREATE INDEX IF NOT EXISTS idx_interval_ba_alerts_confluence
          ON interval_ba_alerts USING GIN (confluence_tickers)
      `,
    ],
  },
  {
    id: 148,
    description:
      'Add composite (date, timestamp DESC) index on gex_strike_0dte to fix the SPX path of /api/gex-strike-expiry. Sentry showed the endpoint at p50=15s / p95=25s / max=32s — every SPX poll from useGexStrikeExpirySpx was hitting the client 8s timeout and surfacing "SPX vol reinforcement: signal timed out" in the GEX Landscape. The query in db-gex-strike-expiry.ts (getLatestGexPerStrikeWithDeltas + effective_at MAX(timestamp)) filters WHERE date = $1 AND timestamp BETWEEN x AND y; the only existing indexes from migration #47 are single-column idx_date and idx_ts DESC, neither of which lets the planner satisfy both predicates without a wide range scan. The UNIQUE (date, timestamp, strike) composite from #47 is technically usable but the planner prefers a narrower covering index. This index matches the exact filter shape (date eq + timestamp range, ordered DESC for the MAX) and should drop the SQL from ~22s to <500ms.',
    statements: (sql) => [
      sql`
        CREATE INDEX IF NOT EXISTS idx_gex_strike_0dte_date_ts
          ON gex_strike_0dte (date, timestamp DESC)
      `,
    ],
  },
  {
    id: 149,
    description:
      'Add mkt_tide_otm_diff NUMERIC column to silent_boom_alerts (Phase 1 of docs/superpowers/specs/silent-boom-otm-tide-and-trail-2026-05-13.md). Snapshot of the OTM-restricted Market Tide NCP - NPP at the spike-bucket time (sourced from flow_data WHERE source = market_tide_otm, latest tick at or before bucket_ct within 30min). Distinct from #136 mkt_tide_diff which captures the all-in variant; the OTM variant filters out dealer hedging noise and is the recommended directional signal per Periscope calibration. Populated forward by the detect-silent-boom cron and backfilled by scripts/backfill_otm_tide_on_alerts.py against the same flow_data table. Nullable because rows written before this migration have no snapshot — backfill recovers every historical date since flow_data source=market_tide_otm has continuous history back to 2026-02-09. Mirrors lottery_finder_fires.mkt_tide_otm_diff which already exists from #122. No index needed: queries filter on (date, bucket_ct) and only group by this column for analytics.',
    statements: (sql) => [
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS mkt_tide_otm_diff NUMERIC`,
    ],
  },
  {
    id: 150,
    description:
      'Add realized_trail30_10_pct NUMERIC column to silent_boom_alerts (Phase 2 of docs/superpowers/specs/silent-boom-otm-tide-and-trail-2026-05-13.md). Stores the peak-trail exit return: activate trailing stop at +30% from entry, then exit at 10pp giveback from running peak; if peak never crosses +30%, hold to last tick (EoD). Computed by ml/src/lottery_exit_policies.py:realized_trail_act30_trail10 against the per-fire post-bucket tick stream from the EOD parquet — the same function lottery_finder_fires.realized_trail30_10_pct already uses (#110). Empirical basis from this session: tier1 silent boom fires averaged peak +297% / EoD -40.8% (hold-to-close was wrong); the bounded estimate model puts trail-30/10 at +147% for tier1, validated up/flat/down regimes. Populated by scripts/enrich_silent_boom_outcomes.py during the nightly enrichment pass (with a --backfill-mode flag that gates on realized_trail30_10_pct IS NULL instead of enriched_at IS NULL so a one-time historical run can fill rows enriched before this migration without resetting enriched_at). Lineage: extends the #146 multi_leg_share enrichment pattern — adds one outcome column alongside the existing peak/r30/r60/r120/eod set written by update_outcomes(). Nullable because rows enriched before this migration have no trail value computed; backfill recovers every historical fire since parquet retention covers the full silent_boom_alerts history. No index needed: read paths group by tier/date and aggregate this column for analytics.',
    statements: (sql) => [
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS realized_trail30_10_pct NUMERIC`,
    ],
  },
  {
    id: 151,
    description:
      "Add direction_gated BOOLEAN column to silent_boom_alerts and lottery_finder_fires (spec: docs/superpowers/specs/silent-boom-direction-gate-and-trail-ui-2026-05-14.md). TRUE when a fire is counter-trend per Market Tide at fire time and the detector demoted it: silent_boom gates on the all-in mkt_tide_diff at T=±100M (puts with diff > +100M or calls with diff < -100M); lottery gates on the OTM mkt_tide_otm_diff at T=±150M. Thresholds chosen empirically from the 15K silent_boom + 96K lottery historical sample — counter-trend lottery fires showed +6.71% avg EOD vs trend-aligned -18.04% (24.75pp spread); silent_boom counter-trend tier1 fires showed -50.55% EOD vs -11.37% trend-aligned. Silent boom also overwrites score_tier to 'tier3' on gated rows; lottery preserves score and lets the feed endpoint override the displayed tier (lottery has no stored score_tier — it's computed from score at read time). NOT NULL with DEFAULT FALSE so existing rows automatically read as ungated until the one-shot backfill flips the historical counter-trend rows.",
    statements: (sql) => [
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS direction_gated BOOLEAN NOT NULL DEFAULT FALSE`,
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS direction_gated BOOLEAN NOT NULL DEFAULT FALSE`,
    ],
  },
  {
    id: 152,
    description:
      'Add underlying_price_at_spike NUMERIC column to silent_boom_alerts. Snapshot of the volume-weighted underlying spot during the spike bucket (computed from ws_option_trades.underlying_price weighted by trade size). Enables the Aggressive Premium filter chip (docs/superpowers/specs/aggressive-premium-chip-2026-05-15.md) to compute OTM-ness per fire (calls: strike > spot; puts: strike < spot) — closing the gap with the trader-mirrored UW filter that requires "OTM only". Populated forward by the detect-silent-boom cron (added to the bucket aggregation SQL); legacy rows backfilled by scripts/backfill_silent_boom_underlying_price.py from the Eod-Full-Tape archive where the spike-bucket prints are still on disk. Nullable because pre-migration rows have no snapshot until backfill lands; filter queries gate on IS NOT NULL.',
    statements: (sql) => [
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS underlying_price_at_spike NUMERIC`,
    ],
  },
  {
    id: 153,
    description:
      'Add range_pos_at_trigger NUMERIC column to lottery_finder_fires (spec: docs/superpowers/specs/lottery-silentboom-eda-impl-2026-05-16.md Finding 1 — "Range Kill"). Stores (spot_at_first − session_low) / (session_high − session_low) computed from 1-min stock OHLC up to trigger_time_ct. Range ∈ [0, 1] where 0 = at session low, 1 = at session high. The 2026-05-15 cross-section EDA found bottom-10% (range_pos < 0.10) is a near-zero edge bucket (2.4% win50, 0.07× baseline lift) — used as a hard kill filter + −3 score penalty. The top-10% bucket has 1.30× win50 / 1.75× win100 lift. Populated forward by the detect-lottery-fires cron via the UW /stock/{ticker}/ohlc/1m endpoint; historical rows backfilled by scripts/backfill-range-pos.mjs. Nullable because pre-migration rows have no snapshot until backfill lands; the score-bonus function treats null as "no penalty" so older fires retain their original score.',
    statements: (sql) => [
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS range_pos_at_trigger NUMERIC`,
    ],
  },
  {
    id: 154,
    description:
      'Add round_trip_net_pct + round_trip_score_deduct columns to lottery_finder_fires AND silent_boom_alerts (spec: docs/superpowers/specs/round-trip-score-deduct-production-2026-05-16.md). round_trip_net_pct stores post_fire_net_pct_of_volume from a 60-min look-forward window on the alert contract: (ask_size − bid_size) / total_size using per-print tag classification (NOT the cumulative *_vol fields — see memory feedback_uw_fulltape_vols_cumulative.md). Negative values indicate post-fire bid-side flow dominated (likely round-trip / position closed). Phase 1 EDA on 641,638 enriched alerts × 92 days fulltape showed AUC 0.59 cohort-uniform, with signal concentrated in 0-7 DTE (collapses to ~random above). round_trip_score_deduct is the stepped-bracket penalty: < −0.50 → −3, [−0.50, −0.30) → −2, [−0.30, −0.10) → −1, else 0. NOT NULL DEFAULT 0 so existing rows read as un-penalized. Populated by api/cron/evaluate-round-trip.ts 60-75 min after fire (Phase 2B), DTE ≤ 7 only. Backfill via scripts/backfill_round_trip_score.py from the existing alert_features.parquet (Phase 2A). Partial index on negative deducts is small (~30% of rows) and supports the "Hide round-tripped" filter chip queries.',
    statements: (sql) => [
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS round_trip_net_pct NUMERIC`,
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS round_trip_score_deduct SMALLINT NOT NULL DEFAULT 0`,
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS round_trip_net_pct NUMERIC`,
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS round_trip_score_deduct SMALLINT NOT NULL DEFAULT 0`,
      sql`CREATE INDEX IF NOT EXISTS lottery_finder_fires_rt_deduct_idx
            ON lottery_finder_fires (round_trip_score_deduct)
            WHERE round_trip_score_deduct < 0`,
      sql`CREATE INDEX IF NOT EXISTS silent_boom_alerts_rt_deduct_idx
            ON silent_boom_alerts (round_trip_score_deduct)
            WHERE round_trip_score_deduct < 0`,
    ],
  },
  {
    id: 155,
    description:
      'Add takeit_prob + takeit_top_features + takeit_model_version columns to lottery_finder_fires AND silent_boom_alerts (spec: docs/superpowers/specs/takeit-phase3-production-scoring-2026-05-16.md). takeit_prob is the calibrated P(peak_ceiling_pct ≥ 20) from the XGBoost classifier (range [0,1], computed in TS at detect time via api/_lib/takeit-score.ts walking the XGBoost JSON tree dump fetched from Vercel Blob). takeit_top_features is the SHAP top-3 green + top-3 red flags ({"positive": [...], "negative": [...]}) populated ~2 min post-fire by api/cron/takeit-fill-shap.ts calling the sidecar /takeit/explain endpoint. takeit_model_version is the bundle version string (e.g. "v2026-05-23"); enables idempotent backfill and version-aware filtering. Partial index on (date DESC, takeit_prob DESC) WHERE takeit_prob IS NOT NULL supports the future "sort feed by prob" queries. Phase 2 OOF AUC: lottery 0.6991 (+8.5pp over heuristic), silentboom 0.7667 (+4.2pp). Backfill via scripts/backfill_takeit.py.',
    statements: (sql) => [
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS takeit_prob NUMERIC`,
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS takeit_top_features JSONB`,
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS takeit_model_version TEXT`,
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS takeit_prob NUMERIC`,
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS takeit_top_features JSONB`,
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS takeit_model_version TEXT`,
      sql`CREATE INDEX IF NOT EXISTS lottery_finder_fires_takeit_prob_idx
            ON lottery_finder_fires (date DESC, takeit_prob DESC)
            WHERE takeit_prob IS NOT NULL`,
      sql`CREATE INDEX IF NOT EXISTS silent_boom_alerts_takeit_prob_idx
            ON silent_boom_alerts (date DESC, takeit_prob DESC)
            WHERE takeit_prob IS NOT NULL`,
    ],
  },
  {
    id: 156,
    description:
      'Create gexbot_snapshots + gexbot_api_capture + gexbot_archive_audit tables for GEXBot Orderflow-tier trial capture (spec: docs/superpowers/specs/gexbot-trial-capture-2026-05-16.md). gexbot_snapshots stores extracted orderflow scalar columns (40 NUMERIC + raw_response JSONB) for hot-path SQL queries against /{ticker}/orderflow/orderflow polled once per minute across 16 Index+ETF tickers. gexbot_api_capture is the generic raw-JSONB store for the other 10 tier-eligible endpoints (8 state per-strike categories {gamma,delta,vanna,charm}_{zero,one} + 2 classic maxchange categories gex_zero/gex_full) — pre-extraction strategy: store everything, derive columns later via SQL views once value-add patterns emerge. gexbot_archive_audit records every successful Parquet → Vercel Blob export (one row per (table, archive_date) with UNIQUE constraint supporting ON CONFLICT DO UPDATE for idempotent re-runs), gating the cleanup-gexbot cron which only deletes confirmed-archived rows. Trial-month volume: ~176 calls/min × 8h × 22 trading days; archive + cleanup keep live DB bounded at ~3.5 GB (today + yesterday).',
    statements: (sql) => [
      sql`CREATE TABLE IF NOT EXISTS gexbot_snapshots (
            id BIGSERIAL PRIMARY KEY,
            captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            ticker TEXT NOT NULL,
            source_timestamp BIGINT,
            spot NUMERIC,
            zero_gamma NUMERIC,
            z_mlgamma NUMERIC,
            z_msgamma NUMERIC,
            zero_mcall NUMERIC,
            zero_mput NUMERIC,
            zcvr NUMERIC,
            zgr NUMERIC,
            zvanna NUMERIC,
            zcharm NUMERIC,
            o_mlgamma NUMERIC,
            o_msgamma NUMERIC,
            one_mcall NUMERIC,
            one_mput NUMERIC,
            ocvr NUMERIC,
            ogr NUMERIC,
            ovanna NUMERIC,
            ocharm NUMERIC,
            agg_dex NUMERIC,
            one_agg_dex NUMERIC,
            agg_call_dex NUMERIC,
            one_agg_call_dex NUMERIC,
            agg_put_dex NUMERIC,
            one_agg_put_dex NUMERIC,
            net_dex NUMERIC,
            one_net_dex NUMERIC,
            net_call_dex NUMERIC,
            one_net_call_dex NUMERIC,
            net_put_dex NUMERIC,
            one_net_put_dex NUMERIC,
            dexoflow NUMERIC,
            gexoflow NUMERIC,
            cvroflow NUMERIC,
            one_dexoflow NUMERIC,
            one_gexoflow NUMERIC,
            one_cvroflow NUMERIC,
            sum_gex_vol NUMERIC,
            sum_gex_oi NUMERIC,
            major_pos_vol NUMERIC,
            major_pos_oi NUMERIC,
            major_neg_vol NUMERIC,
            major_neg_oi NUMERIC,
            delta_risk_reversal NUMERIC,
            min_dte INT,
            sec_min_dte INT,
            raw_response JSONB NOT NULL
          )`,
      sql`CREATE INDEX IF NOT EXISTS gexbot_snapshots_ticker_time_idx
            ON gexbot_snapshots (ticker, captured_at DESC)`,
      sql`CREATE INDEX IF NOT EXISTS gexbot_snapshots_captured_at_idx
            ON gexbot_snapshots (captured_at DESC)`,
      sql`CREATE TABLE IF NOT EXISTS gexbot_api_capture (
            id BIGSERIAL PRIMARY KEY,
            captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            ticker TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            category TEXT NOT NULL,
            source_timestamp BIGINT,
            raw_response JSONB NOT NULL
          )`,
      sql`CREATE INDEX IF NOT EXISTS gexbot_api_capture_ticker_time_idx
            ON gexbot_api_capture (ticker, endpoint, category, captured_at DESC)`,
      sql`CREATE INDEX IF NOT EXISTS gexbot_api_capture_captured_at_idx
            ON gexbot_api_capture (captured_at DESC)`,
      sql`CREATE TABLE IF NOT EXISTS gexbot_archive_audit (
            id BIGSERIAL PRIMARY KEY,
            table_name TEXT NOT NULL,
            archive_date DATE NOT NULL,
            row_count BIGINT NOT NULL,
            blob_url TEXT NOT NULL,
            blob_size_bytes BIGINT NOT NULL,
            sha256 TEXT NOT NULL,
            archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (table_name, archive_date)
          )`,
      sql`CREATE INDEX IF NOT EXISTS gexbot_archive_audit_date_idx
            ON gexbot_archive_audit (archive_date DESC)`,
    ],
  },
  {
    id: 157,
    description:
      'Add takeit_features JSONB column to lottery_finder_fires AND silent_boom_alerts (spec: docs/superpowers/specs/takeit-phase3-production-scoring-2026-05-16.md Phase 3d follow-up). Persists the full feature vector — including derived features (session_phase, is_itm_at_fire, otm_distance_pct, aggressive_premium_flag, dealer_gamma_sign, burst_storm_distinct_count, n_same_dir_fires_last_30min, prior_session_win_rate_same_ticker, minute_of_day_ct, day_of_week) AND one-hot encoded categoricals (option_type_*, ticker_bucket_*, mode_*, flow_quad_*, tod_*, score_tier_*) — exactly as scoreLottery/scoreSilentBoom produced it at detect time. The SHAP fill cron reads this back and ships it to the sidecar /takeit/explain endpoint as-is, eliminating the prior bug where takeit-fill-shap was sending raw SQL row dicts (missing all derived/one-hot features), which would have produced near-empty SHAP matrices on first invocation. Nullable because rows pre-migration have no captured features; the SHAP fill cron filters on `takeit_features IS NOT NULL` so older rows just stay unflagged.',
    statements: (sql) => [
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS takeit_features JSONB`,
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS takeit_features JSONB`,
    ],
  },
  {
    id: 158,
    description:
      'Add cum_ncp_at_fire + cum_npp_at_fire NUMERIC columns to lottery_finder_fires AND silent_boom_alerts (spec: docs/superpowers/specs/lottery-silentboom-feed-perf-2026-05-17.md). Snapshot of the ticker cumulative net call/put premium at the detect-time fire — replaces the per-row LATERAL JOIN that commits 26b13630 + 426c1e91 added to all 7 feed sort branches and which caused ~30s page loads on Lottery Finder + Silent Boom feeds. Populated forward by the detect crons via api/_lib/ticker-flow-snapshot.ts (same UNION over ws_net_flow_per_ticker + net_flow_per_ticker_history as the LATERAL, but bounded by ctSessionBounds(date).min instead of the 4-6h-wider UTC midnight). Historical rows backfilled by scripts/backfill-ticker-flow-at-fire.mjs. Nullable because pre-migration rows + rows for tickers outside the WS net-flow universe (~50 tickers) have no snapshot — the feed JS already handles null tickerCumNcpAtFire / tickerCumNppAtFire identically to the LATERAL returning null. No index needed: these columns are SELECTed for display, never filtered or sorted.',
    statements: (sql) => [
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS cum_ncp_at_fire NUMERIC`,
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS cum_npp_at_fire NUMERIC`,
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS cum_ncp_at_fire NUMERIC`,
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS cum_npp_at_fire NUMERIC`,
    ],
  },
  {
    id: 159,
    description:
      'Add combined_score INTEGER GENERATED ALWAYS column to lottery_finder_fires AND silent_boom_alerts (spec: docs/superpowers/specs/lottery-silentboom-feed-perf-2026-05-17.md). Restores indexed sort path for the lottery score-sort feed branch after commit 4fc7ec99 (Phase 2C round-trip-deduct) changed ORDER BY from the indexed `f.score DESC` to a computed `GREATEST(0, COALESCE(score, 0) + round_trip_score_deduct)` expression that the planner cannot serve from the migration #126 (date, score DESC) index. Generated column auto-populates for all existing rows during ALTER TABLE (no backfill required); evaluate-round-trip cron UPDATEs to round_trip_score_deduct 60-75min post-fire trigger automatic re-computation by Postgres so the new sort index stays consistent. GREATEST(0, ...) preserves the floor-at-zero semantic the feed JS applied today. Partial nullability handled by COALESCE on score. The (date DESC, combined_score DESC NULLS LAST) index serves the new lottery score-sort ORDER BY directly with index-streamed LIMIT termination. Silent-boom does not currently expose score as a sort option, but the column + index are added symmetrically for future use.',
    statements: (sql) => [
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS combined_score INTEGER
            GENERATED ALWAYS AS (GREATEST(0, COALESCE(score, 0) + round_trip_score_deduct)) STORED`,
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS combined_score INTEGER
            GENERATED ALWAYS AS (GREATEST(0, COALESCE(score, 0) + round_trip_score_deduct)) STORED`,
      sql`CREATE INDEX IF NOT EXISTS lottery_finder_fires_date_combined_idx
            ON lottery_finder_fires (date DESC, combined_score DESC NULLS LAST)`,
      sql`CREATE INDEX IF NOT EXISTS silent_boom_alerts_date_combined_idx
            ON silent_boom_alerts (date DESC, combined_score DESC NULLS LAST)`,
    ],
  },
  {
    id: 160,
    description:
      'Add multileg classification columns (inferred_structure TEXT, is_isolated_leg BOOLEAN, match_confidence REAL, pattern_group_id TEXT) to lottery_finder_fires AND silent_boom_alerts. Populated by the detect crons via the sidecar POST /takeit/multileg-classify endpoint that runs the polars matcher in ml/src/multileg_assembler.py against a window of UW Full Tape trades around the alert. inferred_structure is one of the matcher v1 labels: "vertical" (2 strikes, same expiry, same option_type, opposite directions), "strangle" (OTM call + OTM put, same expiry, same direction), "risk_reversal" (OTM put + OTM call, same expiry, opposite directions), "butterfly" (3 equidistant strikes, body 2x wings), or "isolated_leg" (no pattern matched within the window). Adding patterns in v2 = adding entries to multileg_patterns.PATTERNS — no schema change required. is_isolated_leg = match_confidence < 0.5; match_confidence is in [0, 1]; pattern_group_id is a stable hash shared by all trades the matcher attributed to the same structure (isolated legs each get their own group id). All four columns are NULLABLE — pre-migration rows are unclassified and the matcher is best-effort (a classify call may fail without blocking alert insertion). No index in v1; takeit feature pipeline reads via the alert row PK.',
    statements: (sql) => [
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS inferred_structure TEXT`,
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS is_isolated_leg BOOLEAN`,
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS match_confidence REAL`,
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS pattern_group_id TEXT`,
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS inferred_structure TEXT`,
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS is_isolated_leg BOOLEAN`,
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS match_confidence REAL`,
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS pattern_group_id TEXT`,
    ],
  },
  {
    id: 161,
    description:
      'Create tracker_contracts table for the Contract Tracker feature (spec: docs/superpowers/specs/contract-tracker-2026-05-17.md). Tracks manually entered options contracts to expiry with periodic price refresh and threshold-based in-app alerts. occ_symbol is the natural unique key (OCC format, e.g. "NVDA  260522P00225000"). up_thresholds/down_thresholds are per-contract overrides (NULL = use app defaults [50,100,200] / [-30,-50]). spot_alerts is a JSONB array of {op, level} objects for underlying-price alerts. status lifecycle: active → closed (manual) or expired (auto-archived at expiry by the cron). Two indexes: status (panel tab queries filter active/closed/expired) and ticker (group-by-ticker toggle).',
    statements: (sql) => [
      sql`CREATE TABLE IF NOT EXISTS tracker_contracts (
        id              SERIAL PRIMARY KEY,
        occ_symbol      TEXT NOT NULL UNIQUE,
        ticker          TEXT NOT NULL,
        expiry          DATE NOT NULL,
        strike          NUMERIC(10,2) NOT NULL,
        side            TEXT NOT NULL CHECK (side IN ('C','P')),
        direction       TEXT NOT NULL CHECK (direction IN ('long','short')),
        entry_price     NUMERIC(10,4) NOT NULL,
        quantity        INTEGER NOT NULL CHECK (quantity > 0),
        notes           TEXT,
        status          TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','closed','expired')),
        closed_at       TIMESTAMPTZ,
        closed_price    NUMERIC(10,4),
        up_thresholds   NUMERIC[],
        down_thresholds NUMERIC[],
        spot_alerts     JSONB,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )`,
      sql`CREATE INDEX IF NOT EXISTS tracker_contracts_status_idx
            ON tracker_contracts (status)`,
      sql`CREATE INDEX IF NOT EXISTS tracker_contracts_ticker_idx
            ON tracker_contracts (ticker)`,
    ],
  },
  {
    id: 162,
    description:
      'Create tracker_contract_ticks table for the Contract Tracker feature (spec: docs/superpowers/specs/contract-tracker-2026-05-17.md). Stores per-poll price snapshots written by the api/cron/refresh-tracker-contracts.ts cron every 5 min during market hours. FK ON DELETE CASCADE so ticks are purged with their parent contract. source defaults to "uw" (Unusual Whales). The (contract_id, fetched_at DESC) composite index serves the "latest tick for contract" pattern used by the active panel row renderer.',
    statements: (sql) => [
      sql`CREATE TABLE IF NOT EXISTS tracker_contract_ticks (
        id           BIGSERIAL PRIMARY KEY,
        contract_id  INTEGER NOT NULL REFERENCES tracker_contracts (id) ON DELETE CASCADE,
        fetched_at   TIMESTAMPTZ NOT NULL,
        last         NUMERIC(10,4),
        bid          NUMERIC(10,4),
        ask          NUMERIC(10,4),
        volume       INTEGER,
        open_int     INTEGER,
        underlying   NUMERIC(10,4),
        source       TEXT NOT NULL DEFAULT 'uw'
      )`,
      sql`CREATE INDEX IF NOT EXISTS tracker_ticks_contract_time_idx
            ON tracker_contract_ticks (contract_id, fetched_at DESC)`,
    ],
  },
  {
    id: 163,
    description:
      'Create tracker_alerts table for the Contract Tracker feature (spec: docs/superpowers/specs/contract-tracker-2026-05-17.md). Each row is one threshold-breach event fired by the refresh cron. alert_type is one of: up_pct, down_pct, spot_level, dte_7. threshold stores the numeric trigger value (pct for up/down_pct, spot price for spot_level, 7 for dte_7) — NOT NULL intentionally so the UNIQUE (contract_id, alert_type, threshold) dedup index covers every alert type including DTE-7 (stored as threshold=7). INSERT ... ON CONFLICT DO NOTHING ensures each threshold fires at most once per contract over its lifetime. acknowledged is flipped via POST /api/tracker/alerts/:id/ack and polled by useTrackerAlerts every 30 s.',
    statements: (sql) => [
      sql`CREATE TABLE IF NOT EXISTS tracker_alerts (
        id                 BIGSERIAL PRIMARY KEY,
        contract_id        INTEGER NOT NULL REFERENCES tracker_contracts (id) ON DELETE CASCADE,
        fired_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        alert_type         TEXT NOT NULL,
        threshold          NUMERIC NOT NULL,
        price_at_fire      NUMERIC(10,4),
        underlying_at_fire NUMERIC(10,4),
        acknowledged       BOOLEAN DEFAULT FALSE
      )`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS tracker_alerts_dedup_idx
            ON tracker_alerts (contract_id, alert_type, threshold)`,
    ],
  },
  {
    id: 164,
    description:
      'Add wave2_status TEXT + wave2_detected_at TIMESTAMPTZ columns to lottery_finder_fires AND silent_boom_alerts for Phase 4 wave-2 confirmation tracking (spec: docs/superpowers/specs/meta-detectors-2026-05-16.md Phase 4). The wave2-confirmation cron scans each fire for a second qualifying same-ticker + same-option_type event in the same table within 60 min of trigger time and writes one of three labels: "confirmed" (a wave-2 event landed within 0-30 min), "lagging" (30-60 min), or "fizzled" (60 min elapsed with no follow-up). wave2_detected_at carries the second event\'s timestamp on confirmed/lagging and stays NULL on fizzled. Status is left loose (no CHECK constraint) for forward-compat with v2 labels like "cross_type_confirmed". The partial indexes are the cron hot path — without them every tick scans the full table; with them only NULL-status rows are touched (which is exactly the candidate set). lottery uses trigger_time_ct, silent_boom uses bucket_ct. Both tables get the same two columns + one partial index symmetrically. Status transitions are one-way (NULL → confirmed/lagging/fizzled) and the cron never reverses a verdict — the IS NULL guard on the read makes the whole job idempotent.',
    statements: (sql) => [
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS wave2_status TEXT`,
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS wave2_detected_at TIMESTAMPTZ`,
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS wave2_status TEXT`,
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS wave2_detected_at TIMESTAMPTZ`,
      sql`CREATE INDEX IF NOT EXISTS lottery_finder_fires_wave2_pending_idx
            ON lottery_finder_fires (trigger_time_ct)
            WHERE wave2_status IS NULL`,
      sql`CREATE INDEX IF NOT EXISTS silent_boom_alerts_wave2_pending_idx
            ON silent_boom_alerts (bucket_ct)
            WHERE wave2_status IS NULL`,
    ],
  },
  {
    id: 165,
    description:
      'Create panel_prefs table for per-identity panel visibility preferences (spec: docs/superpowers/specs/panel-prefs-2026-05-17.md). One row per identity — `\'owner\'` literal sentinel for the cookie session, or sha256(guest_key) hex for guests so a leaked panel_prefs row reveals no live credential. hidden_panels is a JSONB deny-list of `sec-*` panel IDs; storing "hidden" (not "visible") means new panels you ship later auto-appear for existing users instead of being invisible until each one re-toggles. updated_at supports a future "last touched" diagnostic but is not currently read on the hot path. No additional index — identity is the PK and the only read pattern is `WHERE identity = $1`.',
    statements: (sql) => [
      sql`CREATE TABLE IF NOT EXISTS panel_prefs (
            identity      TEXT PRIMARY KEY,
            hidden_panels JSONB NOT NULL DEFAULT '[]'::jsonb,
            updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
    ],
  },
  {
    id: 166,
    description:
      'Add panel_order + group_order JSONB columns to panel_prefs for two-level user-controlled layout (spec: docs/superpowers/specs/panel-reordering-2026-05-17.md). Both columns are sparse arrays — stored ids are the user-customized prefix, anything missing falls back to registry / PANEL_GROUP_ORDER. NOT NULL DEFAULT \'[]\' so the GET path can read them unconditionally; existing rows pick up the empty default (= "use registry order"). One combined ALTER statement keeps the migration atomic and matches the column-add idiom used by #66 and #95.',
    statements: (sql) => [
      sql`ALTER TABLE panel_prefs
            ADD COLUMN IF NOT EXISTS panel_order JSONB NOT NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS group_order JSONB NOT NULL DEFAULT '[]'::jsonb`,
    ],
  },
  {
    id: 167,
    description:
      'Promote fire_count_score_adjustment from a read-time TS computation to a stored DB column on lottery_finder_fires, then redefine combined_score (the STORED generated column used by the score-sort ORDER BY index) to include it. Closes the displayed-vs-sort divergence documented in commit 254c94ed: previously the score-sort branch would order by combined_score = score + round_trip_score_deduct (excluding the fire_count adjustment), so a 1-fire row with rawScore=20 (combined_score=20, displayed=17) could rank above an 8-fire row with rawScore=18 (combined_score=18, displayed=19). After this migration the displayed score and the sort key are the same expression. Empirical basis: docs/tmp/burst-profitability-findings-2026-05-17.md. The trigger maintains the new column on every INSERT — bucket-boundary detection keeps the work bounded to O(1) on non-crossing inserts (set just the new row) and O(N-per-chain-day) on the 4 rare boundary crossings (1→2, 3→4, 7→8, 15→16). After-INSERT-only trigger does not recurse via its own UPDATE.',
    statements: (sql) => [
      // Step 1: add the new column with the bucket-default 0 for the
      // neutral 4-7 fire range. Backfill in step 2 will correct it.
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS fire_count_score_adjustment SMALLINT NOT NULL DEFAULT 0`,
      // Step 2: backfill existing rows from chain-day fire counts.
      // The CASE ladder mirrors the TS fireCountScoreAdjustment helper.
      sql`WITH chain_day_counts AS (
            SELECT date, option_chain_id, COUNT(*)::int AS fc
              FROM lottery_finder_fires
             GROUP BY date, option_chain_id
          )
          UPDATE lottery_finder_fires lf
             SET fire_count_score_adjustment = CASE
               WHEN cdc.fc = 1 THEN -3
               WHEN cdc.fc <= 3 THEN -1
               WHEN cdc.fc <= 7 THEN 0
               WHEN cdc.fc <= 15 THEN 1
               ELSE 2
             END
            FROM chain_day_counts cdc
           WHERE lf.date = cdc.date
             AND lf.option_chain_id = cdc.option_chain_id`,
      // Step 3: drop the existing STORED combined_score column so we
      // can redefine its GENERATED expression to include the new
      // adjustment. The combined_score index (created in migration
      // #159) is dropped automatically when its column drops.
      sql`ALTER TABLE lottery_finder_fires DROP COLUMN IF EXISTS combined_score`,
      // Step 4: recreate combined_score including the new adjustment.
      // GREATEST(0, ...) preserves the historical no-negative-score
      // floor. NULL-COALESCE on every component matches the existing
      // TS computation semantics (rt_deduct null → 0).
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN combined_score INT GENERATED ALWAYS AS (
              GREATEST(
                0,
                COALESCE(score, 0)
                + COALESCE(round_trip_score_deduct, 0)
                + COALESCE(fire_count_score_adjustment, 0)
              )
            ) STORED`,
      // Step 5: recreate the index used by the score-sort ORDER BY
      // (migration #159's indexed-LIMIT path). Without this, score-sort
      // queries fall back to a full scan.
      sql`CREATE INDEX IF NOT EXISTS lottery_finder_fires_combined_score_idx
            ON lottery_finder_fires (date DESC, combined_score DESC NULLS LAST)`,
      // Step 6: trigger function. On every INSERT, recount the chain-
      // day, recompute the bucket adjustment, and either (a) update
      // ONLY the just-inserted row (no boundary crossing — the new
      // row inherits the existing bucket's adjustment), or (b) update
      // ALL rows for the chain-day (boundary crossing — every row's
      // bucket changed in lockstep). The boundary count is fixed at
      // 4 (1→2, 3→4, 7→8, 15→16), so the heavy O(N-per-chain-day)
      // path runs at most 4 times per chain over its full session.
      sql`CREATE OR REPLACE FUNCTION update_lottery_fire_count_score_adj()
          RETURNS TRIGGER AS $$
          -- Concurrency note: COUNT(*) below could race under concurrent
          -- INSERTs into the same chain-day. The final state still
          -- converges (all rows end at the same bucket adjustment) but
          -- the boundary branch could fire redundantly. The
          -- detect-lottery-fires cron is single-process so this won't
          -- materialize in practice.
          DECLARE
            new_count INT;
            new_adj   SMALLINT;
          BEGIN
            SELECT COUNT(*)::int INTO new_count
              FROM lottery_finder_fires
             WHERE date = NEW.date AND option_chain_id = NEW.option_chain_id;

            new_adj := CASE
              WHEN new_count = 1 THEN -3
              WHEN new_count <= 3 THEN -1
              WHEN new_count <= 7 THEN 0
              WHEN new_count <= 15 THEN 1
              ELSE 2
            END;

            IF new_count IN (1, 2, 4, 8, 16) THEN
              UPDATE lottery_finder_fires
                 SET fire_count_score_adjustment = new_adj
               WHERE date = NEW.date
                 AND option_chain_id = NEW.option_chain_id;
            ELSE
              UPDATE lottery_finder_fires
                 SET fire_count_score_adjustment = new_adj
               WHERE id = NEW.id;
            END IF;

            RETURN NULL;
          END;
          $$ LANGUAGE plpgsql`,
      sql`DROP TRIGGER IF EXISTS lottery_finder_fires_fc_adj_trg
            ON lottery_finder_fires`,
      sql`CREATE TRIGGER lottery_finder_fires_fc_adj_trg
            AFTER INSERT ON lottery_finder_fires
            FOR EACH ROW
            EXECUTE FUNCTION update_lottery_fire_count_score_adj()`,
    ],
  },
  {
    id: 168,
    description:
      "Add gamma_at_trigger NUMERIC column to lottery_finder_fires AND silent_boom_alerts. Stored greek snapshot at fire-detection time, populated by the detect crons via raw_payload->>'gamma' extraction from ws_option_trades. Empirical basis: docs/tmp/gamma-deep-dive-findings-2026-05-17.md — high gamma carries +4.8pp (LF) to +10.7pp (SB) winrate lift on the trail30/10 exit, but the lift is ticker-conditional (SPY and USO REVERSE the signal; -7pp and -16pp drag respectively). The lift is also exit-conditional (hold-EoD reverses because high gamma = theta-burn at 0DTE). Combined_score is dropped and recreated to include the gamma bonus as a row-local CASE expression: +1 when ticker NOT IN ('SPY','USO') AND gamma_at_trigger >= 0.025, else 0. Unlike fire_count_score_adjustment (#167), gamma_at_trigger is row-local so it lives directly in the GENERATED expression — no trigger needed. silent_boom_alerts gets the column for UI/analysis only (no combined_score on that table). Older rows remain NULL; only new fires inserted after this migration carry a populated value.",
    statements: (sql) => [
      // Step 1: add the new column to both tables. Nullable — older
      // rows have no value, only fires inserted after this migration
      // by the updated detect crons carry a populated gamma.
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN IF NOT EXISTS gamma_at_trigger NUMERIC`,
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS gamma_at_trigger NUMERIC`,
      // Step 2: drop the existing combined_score generated column so
      // we can redefine its expression to include the gamma bonus.
      sql`ALTER TABLE lottery_finder_fires DROP COLUMN IF EXISTS combined_score`,
      // Step 3: recreate combined_score with the gamma CASE
      // expression added. SPY + USO are excluded because the
      // per-ticker analysis showed those two tickers REVERSE the
      // gamma signal (-7pp to -16pp drag). The 0.025 threshold is
      // the LF step-function inflection point identified in the
      // decile sweep (deciles 5-9 cluster at +4-5pp lift; deciles 0-4
      // are flat or drag). gamma_at_trigger IS NULL → 0 so rows
      // inserted pre-#168 (or via cron paths that don't populate
      // gamma) keep their existing score semantics.
      sql`ALTER TABLE lottery_finder_fires
            ADD COLUMN combined_score INT GENERATED ALWAYS AS (
              GREATEST(
                0,
                COALESCE(score, 0)
                + COALESCE(round_trip_score_deduct, 0)
                + COALESCE(fire_count_score_adjustment, 0)
                + CASE
                    WHEN underlying_symbol IN ('SPY', 'USO') THEN 0
                    WHEN gamma_at_trigger IS NULL THEN 0
                    WHEN gamma_at_trigger >= 0.025 THEN 1
                    ELSE 0
                  END
              )
            ) STORED`,
      // Step 4: recreate the indexed-LIMIT path index that migration
      // #159 added and #167 already rebuilt once.
      sql`CREATE INDEX IF NOT EXISTS lottery_finder_fires_combined_score_idx
            ON lottery_finder_fires (date DESC, combined_score DESC NULLS LAST)`,
    ],
  },
  {
    id: 169,
    description:
      'Add pre_trade_count INTEGER column to silent_boom_alerts. Stores the count of non-canceled trades on the same option_chain_id from session open (08:30 CT) to bucket_ct at fire-detection time. Empirical basis: docs/superpowers/specs/silent-boom-h1-h3-features-2026-05-17.md — within every elapsed-time bucket on the 93-day peak dataset (n=63,846), the 501+ pre-trade-count cohort outperforms the dead-silent baseline by +15-25pp on peak ≥50%. Lift is independent of TOD (which already controls for elapsed time). Score bonus +4 fires when pre_trade_count >= 501. Older rows stay NULL until backfilled.',
    statements: (sql) => [
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS pre_trade_count INTEGER`,
      // Partial index — query path is "WHERE pre_trade_count >= 501"
      // for cohort analysis; full-table index would be wasteful since
      // ~97% of rows fall below the threshold.
      sql`CREATE INDEX IF NOT EXISTS silent_boom_alerts_pre_trade_count_high_idx
            ON silent_boom_alerts (date DESC, pre_trade_count)
         WHERE pre_trade_count >= 501`,
    ],
  },
  {
    id: 170,
    description:
      'Add adj_cofire BOOLEAN column to silent_boom_alerts. TRUE when another SB fire exists at the same (ticker, option_type, bucket_ct) on the adjacent strike (±$1 default, ±$5 for SPX/NDX/RUT cash-index roots). Empirical basis: docs/superpowers/specs/silent-boom-h1-h3-features-2026-05-17.md — on the 93-day, 63,846-alert peak dataset only 1,911 alerts (3.0%) cofire, but those alerts hit 22.0% peak ≥50% vs 16.0% non-cofire (+5.8pp lift). Score bonus +2 fires when adj_cofire=TRUE. Detector populates via intra-cron lookup (build a Set<key> of all this-cron fires, check strike±step membership). Older rows stay NULL until backfilled.',
    statements: (sql) => [
      sql`ALTER TABLE silent_boom_alerts
            ADD COLUMN IF NOT EXISTS adj_cofire BOOLEAN`,
      // Partial index — cofire is rare (~3% of alerts) so a partial
      // index on the TRUE rows keeps the index small and fast for
      // the cohort-analysis query path.
      sql`CREATE INDEX IF NOT EXISTS silent_boom_alerts_adj_cofire_idx
            ON silent_boom_alerts (date DESC, adj_cofire)
         WHERE adj_cofire = TRUE`,
    ],
  },
];
