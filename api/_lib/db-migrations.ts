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
];
