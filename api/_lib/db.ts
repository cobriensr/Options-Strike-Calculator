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
// MARKET SNAPSHOT
// ============================================================

type Maybe<T> = T | null | undefined;

export interface SnapshotInput {
  date: string;
  entryTime: string;

  // Prices
  spx?: Maybe<number>;
  spy?: Maybe<number>;
  spxOpen?: Maybe<number>;
  spxHigh?: Maybe<number>;
  spxLow?: Maybe<number>;
  prevClose?: Maybe<number>;

  // Volatility
  vix?: Maybe<number>;
  vix1d?: Maybe<number>;
  vix9d?: Maybe<number>;
  vvix?: Maybe<number>;

  // Calculator
  sigma?: Maybe<number>;
  sigmaSource?: Maybe<string>;
  tYears?: Maybe<number>;
  hoursRemaining?: Maybe<number>;
  skewPct?: Maybe<number>;

  // Regime
  regimeZone?: Maybe<string>;
  clusterMult?: Maybe<number>;
  dowMultHL?: Maybe<number>;
  dowMultOC?: Maybe<number>;
  dowLabel?: Maybe<string>;

  // Delta guide
  icCeiling?: Maybe<number>;
  putSpreadCeiling?: Maybe<number>;
  callSpreadCeiling?: Maybe<number>;
  moderateDelta?: Maybe<number>;
  conservativeDelta?: Maybe<number>;

  // Range thresholds
  medianOcPct?: Maybe<number>;
  medianHlPct?: Maybe<number>;
  p90OcPct?: Maybe<number>;
  p90HlPct?: Maybe<number>;
  p90OcPts?: Maybe<number>;
  p90HlPts?: Maybe<number>;

  // Opening range
  openingRangeAvailable?: Maybe<boolean>;
  openingRangeHigh?: Maybe<number>;
  openingRangeLow?: Maybe<number>;
  openingRangePctConsumed?: Maybe<number>;
  openingRangeSignal?: Maybe<string>;

  // Term structure
  vixTermSignal?: Maybe<string>;

  // Overnight
  overnightGap?: Maybe<number>;

  // Strikes
  strikes?: Maybe<Record<string, unknown>>;

  // Events
  isEarlyClose?: Maybe<boolean>;
  isEventDay?: Maybe<boolean>;
  eventNames?: Maybe<string[]>;

  isBacktest?: Maybe<boolean>;
}

/**
 * Save a market snapshot. Uses ON CONFLICT DO UPDATE so re-saves at the
 * same date+time overwrite with the latest calculator state.
 * Returns the snapshot ID (new or updated).
 */
export async function saveSnapshot(
  input: SnapshotInput,
): Promise<number | null> {
  const sql = getDb();

  const vix1dVixRatio =
    input.vix1d && input.vix && input.vix > 0 ? input.vix1d / input.vix : null;
  const vixVix9dRatio =
    input.vix && input.vix9d && input.vix9d > 0
      ? input.vix / input.vix9d
      : null;

  const result = await sql`
    INSERT INTO market_snapshots (
      date, entry_time,
      spx, spy, spx_open, spx_high, spx_low, prev_close,
      vix, vix1d, vix9d, vvix, vix1d_vix_ratio, vix_vix9d_ratio,
      sigma, sigma_source, t_years, hours_remaining, skew_pct,
      regime_zone, cluster_mult, dow_mult_hl, dow_mult_oc, dow_label,
      ic_ceiling, put_spread_ceiling, call_spread_ceiling, moderate_delta, conservative_delta,
      median_oc_pct, median_hl_pct, p90_oc_pct, p90_hl_pct, p90_oc_pts, p90_hl_pts,
      opening_range_available, opening_range_high, opening_range_low,
      opening_range_pct_consumed, opening_range_signal,
      vix_term_signal, overnight_gap,
      strikes,
      is_early_close, is_event_day, event_names,
      is_backtest
    ) VALUES (
      ${input.date}, ${input.entryTime},
      ${input.spx ?? null}, ${input.spy ?? null},
      ${input.spxOpen ?? null}, ${input.spxHigh ?? null},
      ${input.spxLow ?? null}, ${input.prevClose ?? null},
      ${input.vix ?? null}, ${input.vix1d ?? null},
      ${input.vix9d ?? null}, ${input.vvix ?? null},
      ${vix1dVixRatio}, ${vixVix9dRatio},
      ${input.sigma ?? null}, ${input.sigmaSource ?? null},
      ${input.tYears ?? null}, ${input.hoursRemaining ?? null},
      ${input.skewPct ?? null},
      ${input.regimeZone ?? null}, ${input.clusterMult ?? null},
      ${input.dowMultHL ?? null}, ${input.dowMultOC ?? null},
      ${input.dowLabel ?? null},
      ${input.icCeiling ?? null}, ${input.putSpreadCeiling ?? null},
      ${input.callSpreadCeiling ?? null}, ${input.moderateDelta ?? null},
      ${input.conservativeDelta ?? null},
      ${input.medianOcPct ?? null}, ${input.medianHlPct ?? null},
      ${input.p90OcPct ?? null}, ${input.p90HlPct ?? null},
      ${input.p90OcPts ?? null}, ${input.p90HlPts ?? null},
      ${input.openingRangeAvailable ?? null},
      ${input.openingRangeHigh ?? null}, ${input.openingRangeLow ?? null},
      ${input.openingRangePctConsumed ?? null}, ${input.openingRangeSignal ?? null},
      ${input.vixTermSignal ?? null}, ${input.overnightGap ?? null},
      ${input.strikes ? JSON.stringify(input.strikes) : null},
      ${input.isEarlyClose ?? false}, ${input.isEventDay ?? false},
      ${input.eventNames ?? null},
      ${input.isBacktest ?? false}
    )
    ON CONFLICT (date, entry_time) DO UPDATE SET
      spx = EXCLUDED.spx,
      spy = EXCLUDED.spy,
      spx_open = EXCLUDED.spx_open,
      spx_high = EXCLUDED.spx_high,
      spx_low = EXCLUDED.spx_low,
      prev_close = EXCLUDED.prev_close,
      vix = EXCLUDED.vix,
      vix1d = EXCLUDED.vix1d,
      vix9d = EXCLUDED.vix9d,
      vvix = EXCLUDED.vvix,
      vix1d_vix_ratio = EXCLUDED.vix1d_vix_ratio,
      vix_vix9d_ratio = EXCLUDED.vix_vix9d_ratio,
      sigma = EXCLUDED.sigma,
      sigma_source = EXCLUDED.sigma_source,
      t_years = EXCLUDED.t_years,
      hours_remaining = EXCLUDED.hours_remaining,
      skew_pct = EXCLUDED.skew_pct,
      regime_zone = EXCLUDED.regime_zone,
      cluster_mult = EXCLUDED.cluster_mult,
      dow_mult_hl = EXCLUDED.dow_mult_hl,
      dow_mult_oc = EXCLUDED.dow_mult_oc,
      dow_label = EXCLUDED.dow_label,
      ic_ceiling = EXCLUDED.ic_ceiling,
      put_spread_ceiling = EXCLUDED.put_spread_ceiling,
      call_spread_ceiling = EXCLUDED.call_spread_ceiling,
      moderate_delta = EXCLUDED.moderate_delta,
      conservative_delta = EXCLUDED.conservative_delta,
      median_oc_pct = EXCLUDED.median_oc_pct,
      median_hl_pct = EXCLUDED.median_hl_pct,
      p90_oc_pct = EXCLUDED.p90_oc_pct,
      p90_hl_pct = EXCLUDED.p90_hl_pct,
      p90_oc_pts = EXCLUDED.p90_oc_pts,
      p90_hl_pts = EXCLUDED.p90_hl_pts,
      opening_range_available = EXCLUDED.opening_range_available,
      opening_range_high = EXCLUDED.opening_range_high,
      opening_range_low = EXCLUDED.opening_range_low,
      opening_range_pct_consumed = EXCLUDED.opening_range_pct_consumed,
      opening_range_signal = EXCLUDED.opening_range_signal,
      vix_term_signal = EXCLUDED.vix_term_signal,
      overnight_gap = EXCLUDED.overnight_gap,
      strikes = EXCLUDED.strikes,
      is_early_close = EXCLUDED.is_early_close,
      is_event_day = EXCLUDED.is_event_day,
      event_names = EXCLUDED.event_names,
      is_backtest = EXCLUDED.is_backtest
    RETURNING id
  `;

  return result.length > 0 ? ((result[0]?.id as number) ?? null) : null;
}

// ============================================================
// ANALYSIS
// ============================================================

/**
 * Save a Claude analysis response, linked to a snapshot if available.
 */
export async function saveAnalysis(
  context: {
    selectedDate?: string;
    entryTime?: string;
    spx?: number;
    vix?: number;
    vix1d?: number;
  },
  analysis: {
    mode?: string;
    structure: string;
    confidence: string;
    suggestedDelta: number | null | undefined;
    hedge?: { recommendation: string } | null;
    [key: string]: unknown;
  },
  snapshotId?: number | null,
) {
  const sql = getDb();

  const date =
    context.selectedDate ??
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const entryTime = context.entryTime ?? 'unknown';
  const mode = analysis.mode ?? 'entry';

  await sql`
    INSERT INTO analyses (
      snapshot_id, date, entry_time, mode, structure, confidence,
      suggested_delta, spx, vix, vix1d, hedge, full_response
    ) VALUES (
      ${snapshotId ?? null},
      ${date}, ${entryTime}, ${mode},
      ${analysis.structure}, ${analysis.confidence},
      ${analysis.suggestedDelta ?? 0},
      ${context.spx ?? null}, ${context.vix ?? null}, ${context.vix1d ?? null},
      ${analysis.hedge?.recommendation ?? null},
      ${JSON.stringify(analysis)}
    )
  `;
}

// ============================================================
// OUTCOMES (for future use)
// ============================================================

export async function saveOutcome(input: {
  date: string;
  settlement: number;
  dayOpen: number;
  dayHigh: number;
  dayLow: number;
  vixClose?: number;
  vix1dClose?: number;
}) {
  const sql = getDb();
  const rangePts = Math.round(input.dayHigh - input.dayLow);
  const rangePct =
    input.dayOpen > 0 ? (input.dayHigh - input.dayLow) / input.dayOpen : null;
  const closeVsOpen = input.settlement - input.dayOpen;

  await sql`
    INSERT INTO outcomes (
      date, settlement, day_open, day_high, day_low,
      day_range_pts, day_range_pct, close_vs_open,
      vix_close, vix1d_close
    ) VALUES (
      ${input.date}, ${input.settlement},
      ${input.dayOpen}, ${input.dayHigh}, ${input.dayLow},
      ${rangePts}, ${rangePct}, ${closeVsOpen},
      ${input.vixClose ?? null}, ${input.vix1dClose ?? null}
    )
    ON CONFLICT (date) DO UPDATE SET
      settlement = EXCLUDED.settlement,
      day_open = EXCLUDED.day_open,
      day_high = EXCLUDED.day_high,
      day_low = EXCLUDED.day_low,
      day_range_pts = EXCLUDED.day_range_pts,
      day_range_pct = EXCLUDED.day_range_pct,
      close_vs_open = EXCLUDED.close_vs_open,
      vix_close = EXCLUDED.vix_close,
      vix1d_close = EXCLUDED.vix1d_close
  `;
}

// ============================================================
// POSITIONS (live Schwab 0DTE SPX)
// ============================================================

export interface PositionLeg {
  putCall: 'PUT' | 'CALL';
  symbol: string;
  strike: number;
  expiration: string;
  quantity: number;
  averagePrice: number;
  marketValue: number;
  delta?: number;
  theta?: number;
  gamma?: number;
}

export interface PositionInput {
  date: string;
  fetchTime: string;
  accountHash: string;
  spxPrice?: number;
  summary: string;
  legs: PositionLeg[];
  totalSpreads?: number;
  callSpreads?: number;
  putSpreads?: number;
  netDelta?: number;
  netTheta?: number;
  netGamma?: number;
  totalCredit?: number;
  currentValue?: number;
  unrealizedPnl?: number;
  snapshotId?: number | null;
}

/**
 * Save current positions. Uses ON CONFLICT DO UPDATE so re-fetching
 * the same date+time replaces the previous snapshot.
 */
export async function savePositions(
  input: PositionInput,
): Promise<number | null> {
  const sql = getDb();

  const result = await sql`
    INSERT INTO positions (
      snapshot_id, date, fetch_time, account_hash, spx_price,
      summary, legs,
      total_spreads, call_spreads, put_spreads,
      net_delta, net_theta, net_gamma,
      total_credit, current_value, unrealized_pnl
    ) VALUES (
      ${input.snapshotId ?? null},
      ${input.date}, ${input.fetchTime}, ${input.accountHash},
      ${input.spxPrice ?? null},
      ${input.summary}, ${JSON.stringify(input.legs)},
      ${input.totalSpreads ?? 0}, ${input.callSpreads ?? 0}, ${input.putSpreads ?? 0},
      ${input.netDelta ?? null}, ${input.netTheta ?? null}, ${input.netGamma ?? null},
      ${input.totalCredit ?? null}, ${input.currentValue ?? null}, ${input.unrealizedPnl ?? null}
    )
    ON CONFLICT (date, fetch_time) DO UPDATE SET
      snapshot_id = EXCLUDED.snapshot_id,
      account_hash = EXCLUDED.account_hash,
      spx_price = EXCLUDED.spx_price,
      summary = EXCLUDED.summary,
      legs = EXCLUDED.legs,
      total_spreads = EXCLUDED.total_spreads,
      call_spreads = EXCLUDED.call_spreads,
      put_spreads = EXCLUDED.put_spreads,
      net_delta = EXCLUDED.net_delta,
      net_theta = EXCLUDED.net_theta,
      net_gamma = EXCLUDED.net_gamma,
      total_credit = EXCLUDED.total_credit,
      current_value = EXCLUDED.current_value,
      unrealized_pnl = EXCLUDED.unrealized_pnl
    RETURNING id
  `;

  return result.length > 0 ? ((result[0]?.id as number) ?? null) : null;
}

/**
 * Get the most recent positions for a given date.
 * Returns the summary string for Claude prompt context and the full legs for display.
 */
export async function getLatestPositions(date: string): Promise<{
  summary: string;
  legs: PositionLeg[];
  fetchTime: string;
  stats: {
    totalSpreads: number;
    callSpreads: number;
    putSpreads: number;
    netDelta: number | null;
    netTheta: number | null;
    unrealizedPnl: number | null;
  };
} | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT summary, legs, fetch_time,
           total_spreads, call_spreads, put_spreads,
           net_delta, net_theta, unrealized_pnl
    FROM positions
    WHERE date = ${date}
    ORDER BY
      CASE WHEN total_spreads > 0 THEN 0 ELSE 1 END,
      created_at DESC
    LIMIT 1
  `;

  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    summary: row.summary as string,
    legs: (typeof row.legs === 'string'
      ? JSON.parse(row.legs)
      : row.legs) as PositionLeg[],
    fetchTime: row.fetch_time as string,
    stats: {
      totalSpreads: row.total_spreads as number,
      callSpreads: row.call_spreads as number,
      putSpreads: row.put_spreads as number,
      netDelta: row.net_delta as number | null,
      netTheta: row.net_theta as number | null,
      unrealizedPnl: row.unrealized_pnl as number | null,
    },
  };
}

// ============================================================
// PREVIOUS RECOMMENDATION (for analysis continuity)
// ============================================================

/**
 * Fetch the previous recommendation for a given date based on the current mode.
 *
 * Logic:
 *   - "entry" mode: No previous recommendation needed (returns null)
 *   - "midday" mode: Get the most recent analysis for this date
 *     (could be an entry or a previous midday — whatever came last)
 *   - "review" mode: Get the most recent midday analysis for this date,
 *     falling back to the most recent entry if no midday exists
 *
 * Returns a formatted string for Claude prompt context, or null if nothing found.
 */
export async function getPreviousRecommendation(
  date: string,
  currentMode: string,
): Promise<string | null> {
  if (currentMode === 'entry') return null;

  const sql = getDb();

  let rows;

  if (currentMode === 'midday') {
    // Get the most recent analysis for this date (any mode)
    rows = await sql`
      SELECT mode, entry_time, structure, confidence, suggested_delta, hedge,
             spx, vix, vix1d, full_response, created_at
      FROM analyses
      WHERE date = ${date}
      ORDER BY created_at DESC
      LIMIT 1
    `;
  } else if (currentMode === 'review') {
    // Prefer the most recent midday, fall back to most recent entry
    rows = await sql`
      SELECT mode, entry_time, structure, confidence, suggested_delta, hedge,
             spx, vix, vix1d, full_response, created_at
      FROM analyses
      WHERE date = ${date}
        AND mode IN ('midday', 'entry')
      ORDER BY
        CASE WHEN mode = 'midday' THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT 1
    `;
  } else {
    return null;
  }

  if (!rows || rows.length === 0) return null;

  const row = rows[0]!;
  const fullResponse = (
    typeof row.full_response === 'string'
      ? JSON.parse(row.full_response as string)
      : row.full_response
  ) as Record<string, unknown>;

  // Build a concise summary of the previous recommendation
  const lines: string[] = [
    `=== Previous ${(row.mode as string).toUpperCase()} Analysis (${row.entry_time}) ===`,
    `Structure: ${row.structure} | Confidence: ${row.confidence} | Delta: ${row.suggested_delta}Δ`,
    `SPX at analysis: ${row.spx} | VIX: ${row.vix} | VIX1D: ${row.vix1d}`,
    `Hedge: ${row.hedge ?? 'N/A'}`,
  ];

  // Include the reasoning
  if (fullResponse.reasoning) {
    lines.push(`Reasoning: ${fullResponse.reasoning}`);
  }

  // Include structure rationale for full context
  if (fullResponse.structureRationale) {
    lines.push(`Structure rationale: ${fullResponse.structureRationale}`);
  }

  // Include key management rules
  const mgmt = fullResponse.managementRules as
    | Record<string, unknown>
    | undefined;
  if (mgmt) {
    if (mgmt.profitTarget) lines.push(`Profit target: ${mgmt.profitTarget}`);
    if (Array.isArray(mgmt.stopConditions)) {
      lines.push('Stop conditions:');
      for (const stop of mgmt.stopConditions) {
        lines.push(`  - ${stop}`);
      }
    }
    if (mgmt.flowReversalSignal)
      lines.push(`Flow reversal signal: ${mgmt.flowReversalSignal}`);
  }

  // Include entry plan status
  const plan = fullResponse.entryPlan as Record<string, unknown> | undefined;
  if (plan) {
    if (plan.maxTotalSize) lines.push(`Max total size: ${plan.maxTotalSize}`);
    const e1 = plan.entry1 as Record<string, unknown> | undefined;
    const e2 = plan.entry2 as Record<string, unknown> | undefined;
    const e3 = plan.entry3 as Record<string, unknown> | undefined;
    if (e1?.sizePercent)
      lines.push(
        `Entry 1: ${e1.structure} ${e1.delta}Δ at ${e1.sizePercent}% — ${e1.note ?? ''}`,
      );
    if (e2?.condition) lines.push(`Entry 2 condition: ${e2.condition}`);
    if (e3?.condition) lines.push(`Entry 3 condition: ${e3.condition}`);
  }

  // Include observations (top 3 for context)
  if (Array.isArray(fullResponse.observations)) {
    lines.push('Key observations at that time:');
    for (const obs of fullResponse.observations.slice(0, 3)) {
      lines.push(`  - ${obs}`);
    }
  }

  // Include strike guidance
  const strikes = fullResponse.strikeGuidance as
    | Record<string, unknown>
    | undefined;
  if (strikes) {
    if (strikes.putStrikeNote)
      lines.push(`Put strike guidance: ${strikes.putStrikeNote}`);
    if (strikes.callStrikeNote)
      lines.push(`Call strike guidance: ${strikes.callStrikeNote}`);
  }

  return lines.join('\n');
}

// ============================================================
// FLOW DATA (UW API time series)
// ============================================================

/**
 * Get all flow data rows for a given date and source.
 * Returns rows ordered by timestamp ascending (oldest first).
 */
export async function getFlowData(
  date: string,
  source: string,
): Promise<
  Array<{
    timestamp: string;
    ncp: number;
    npp: number;
    netVolume: number;
  }>
> {
  const sql = getDb();
  const rows = await sql`
    SELECT timestamp, ncp, npp, net_volume
    FROM flow_data
    WHERE date = ${date} AND source = ${source}
    ORDER BY timestamp ASC
  `;

  return rows.map((r) => ({
    timestamp: r.timestamp as string,
    ncp: Number(r.ncp),
    npp: Number(r.npp),
    netVolume: r.net_volume as number,
  }));
}

/**
 * Get flow data rows within a time window (e.g., last 60 minutes).
 * Useful for building the time series context for Claude.
 */
export async function getRecentFlowData(
  date: string,
  source: string,
  minutesBack: number = 60,
): Promise<
  Array<{
    timestamp: string;
    ncp: number;
    npp: number;
    netVolume: number;
  }>
> {
  const sql = getDb();
  const cutoff = new Date(Date.now() - minutesBack * 60 * 1000).toISOString();

  const rows = await sql`
    SELECT timestamp, ncp, npp, net_volume
    FROM flow_data
    WHERE date = ${date}
      AND source = ${source}
      AND timestamp >= ${cutoff}
    ORDER BY timestamp ASC
  `;

  return rows.map((r) => ({
    timestamp: r.timestamp as string,
    ncp: Number(r.ncp),
    npp: Number(r.npp),
    netVolume: r.net_volume as number,
  }));
}

/**
 * Format flow data as a structured text block for Claude's context.
 * Includes the time series, computed direction, and divergence pattern.
 *
 * @param rows - Flow data rows (ordered by timestamp ascending)
 * @param label - Display name (e.g., "Market Tide", "Market Tide OTM")
 * @returns Formatted text block, or null if no data
 */
export function formatFlowDataForClaude(
  rows: Array<{
    timestamp: string;
    ncp: number;
    npp: number;
    netVolume: number;
  }>,
  label: string,
): string | null {
  if (rows.length === 0) return null;

  const lines: string[] = [`${label} (5-min intervals):`];

  // Format each row
  for (const row of rows) {
    const time = new Date(row.timestamp).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
    const ncpStr = formatPremium(row.ncp);
    const nppStr = formatPremium(row.npp);
    const volSign = row.netVolume >= 0 ? '+' : '';
    lines.push(
      `  ${time} ET — NCP: ${ncpStr}, NPP: ${nppStr}, Vol: ${volSign}${row.netVolume.toLocaleString()}`,
    );
  }

  // Compute direction summary from first and last rows
  if (rows.length >= 2) {
    const first = rows[0]!;
    const last = rows.at(-1)!;
    const ncpChange = last.ncp - first.ncp;
    const nppChange = last.npp - first.npp;
    const minutes = Math.round(
      (new Date(last.timestamp).getTime() -
        new Date(first.timestamp).getTime()) /
        60000,
    );

    const ncpDir =
      ncpChange > 0 ? 'rising' : ncpChange < 0 ? 'falling' : 'flat';
    const nppDir =
      nppChange > 0 ? 'rising' : nppChange < 0 ? 'falling' : 'flat';

    lines.push(
      `  Direction (${minutes} min): NCP ${ncpDir} (${formatPremium(ncpChange)}), NPP ${nppDir} (${formatPremium(nppChange)})`,
    );

    // Divergence pattern
    const gap = last.ncp - last.npp;
    const prevGap = first.ncp - first.npp;
    if (Math.abs(gap) > Math.abs(prevGap)) {
      const direction = gap > 0 ? 'bullish' : 'bearish';
      lines.push(`  Pattern: ${direction} divergence widening`);
    } else if (Math.abs(gap) < Math.abs(prevGap) * 0.5) {
      lines.push('  Pattern: NCP/NPP converging');
    } else {
      lines.push('  Pattern: Lines roughly parallel');
    }
  }

  return lines.join('\n');
}

/**
 * Format a premium value for display (e.g., -140000000 → "-$140M")
 */
function formatPremium(value: number): string {
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '-';
  if (abs >= 1_000_000_000)
    return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

// ── Greek Exposure (MM gamma/charm/delta/vanna by expiry) ───

export interface GreekExposureRow {
  expiry: string;
  dte: number;
  callGamma: number;
  putGamma: number;
  netGamma: number;
  callCharm: number;
  putCharm: number;
  netCharm: number;
  callDelta: number;
  putDelta: number;
  netDelta: number;
  callVanna: number;
  putVanna: number;
}

/**
 * Get all Greek exposure rows for a given date and ticker.
 * Returns rows ordered by DTE ascending (0DTE first).
 */
export async function getGreekExposure(
  date: string,
  ticker: string = 'SPX',
): Promise<GreekExposureRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT expiry, dte, call_gamma, put_gamma, call_charm, put_charm,
           call_delta, put_delta, call_vanna, put_vanna
    FROM greek_exposure
    WHERE date = ${date} AND ticker = ${ticker}
    ORDER BY dte ASC
  `;

  return rows.map((r) => ({
    expiry: r.expiry as string,
    dte: r.dte as number,
    callGamma: Number(r.call_gamma),
    putGamma: Number(r.put_gamma),
    netGamma: Number(r.call_gamma) + Number(r.put_gamma),
    callCharm: Number(r.call_charm),
    putCharm: Number(r.put_charm),
    netCharm: Number(r.call_charm) + Number(r.put_charm),
    callDelta: Number(r.call_delta),
    putDelta: Number(r.put_delta),
    netDelta: Number(r.call_delta) + Number(r.put_delta),
    callVanna: Number(r.call_vanna),
    putVanna: Number(r.put_vanna),
  }));
}

/**
 * Format Greek exposure data as a structured text block for Claude's context.
 * Includes aggregate totals, 0DTE breakdown, and regime classification.
 *
 * @param rows - Greek exposure rows (ordered by DTE ascending)
 * @param date - Analysis date (to identify 0DTE expiry)
 * @returns Formatted text block, or null if no data
 */
export function formatGreekExposureForClaude(
  rows: GreekExposureRow[],
  date: string,
): string | null {
  if (rows.length === 0) return null;

  // Aggregate across all expiries
  const aggGamma = rows.reduce((s, r) => s + r.netGamma, 0);
  const aggCharm = rows.reduce((s, r) => s + r.netCharm, 0);
  const aggDelta = rows.reduce((s, r) => s + r.netDelta, 0);

  // 0DTE specific
  const zeroDte = rows.find((r) => r.expiry === date || r.dte === 0);

  // Regime classification per Rule 16
  let regime: string;
  if (aggGamma > 50_000) {
    regime = 'POSITIVE — Normal management. Periscope walls reliable.';
  } else if (aggGamma > 0) {
    regime = 'MILDLY NEGATIVE (0 to +50K) — Tighten CCS time exits by 30 min.';
  } else if (aggGamma > -50_000) {
    regime = 'MILDLY NEGATIVE (0 to -50K) — Tighten CCS time exits by 30 min.';
  } else if (aggGamma > -150_000) {
    regime =
      'MODERATELY NEGATIVE — Close CCS by 12:00 PM ET. Target 40% profit.';
  } else {
    regime =
      'DEEPLY NEGATIVE — Close CCS by 11:30 AM ET. Reduce size 10%. Walls compromised.';
  }

  const lines: string[] = [
    'SPX Greek Exposure (OI-based, from API):',
    `  Aggregate Net Gamma (all expiries): ${formatGreekValue(aggGamma)}`,
    `  Aggregate Net Charm (all expiries): ${formatGreekValue(aggCharm)}`,
    `  Aggregate Net Delta (all expiries): ${formatGreekValue(aggDelta)}`,
    `  Rule 16 Regime: ${regime}`,
  ];

  if (zeroDte) {
    const pctOfTotal =
      aggGamma !== 0 ? ((zeroDte.netGamma / aggGamma) * 100).toFixed(1) : 'N/A';
    lines.push(
      '',
      '  0DTE Breakdown:',
      `    Net Gamma: ${formatGreekValue(zeroDte.netGamma)} (${pctOfTotal}% of total)`,
      `    Net Charm: ${formatGreekValue(zeroDte.netCharm)}`,
      `    Net Delta: ${formatGreekValue(zeroDte.netDelta)}`,
      `    Call Gamma: ${formatGreekValue(zeroDte.callGamma)} | Put Gamma: ${formatGreekValue(zeroDte.putGamma)}`,
    );
  }

  // Top 3 expiries by gamma magnitude (excluding 0DTE)
  const nonZeroDte = rows
    .filter((r) => r.expiry !== date && r.dte !== 0)
    .sort((a, b) => Math.abs(b.netGamma) - Math.abs(a.netGamma))
    .slice(0, 3);

  if (nonZeroDte.length > 0) {
    lines.push('', '  Largest Non-0DTE Gamma Concentrations:');
    for (const r of nonZeroDte) {
      lines.push(
        `    ${r.expiry} (${r.dte}DTE): Net Gamma ${formatGreekValue(r.netGamma)}, Net Charm ${formatGreekValue(r.netCharm)}`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Format a Greek exposure value for display (e.g., -12337386 → "-12.3M")
 */
function formatGreekValue(value: number): string {
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '-';
  if (abs >= 1_000_000_000)
    return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}
