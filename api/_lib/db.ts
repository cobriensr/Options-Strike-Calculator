/**
 * Postgres database helper using Neon serverless driver.
 *
 * Three tables:
 *   market_snapshots — complete calculator state at each date+time (UNIQUE)
 *   analyses         — Claude chart analysis responses (linked to snapshots)
 *   outcomes         — end-of-day settlement data (for future backtesting)
 *
 * Setup:
 *   1. Add Neon Postgres from Vercel Marketplace (Storage tab → Connect Database → Neon)
 *   2. This auto-creates DATABASE_URL env var
 *   3. Run `vercel env pull .env.local` to get it locally
 *   4. Call POST /api/journal/init once to create all tables
 *
 * Install: npm install @neondatabase/serverless
 */

import { neon } from '@neondatabase/serverless';

export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not configured');
  return neon(url);
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

  // ── Indexes ───────────────────────────────────────────────
  await sql`CREATE INDEX IF NOT EXISTS idx_snapshots_date ON market_snapshots (date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_analyses_date ON analyses (date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_analyses_structure ON analyses (structure)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_analyses_confidence ON analyses (confidence)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_analyses_snapshot ON analyses (snapshot_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_outcomes_date ON outcomes (date)`;
}

// ============================================================
// MARKET SNAPSHOT
// ============================================================

export interface SnapshotInput {
  date: string;
  entryTime: string;

  // Prices
  spx?: number;
  spy?: number;
  spxOpen?: number;
  spxHigh?: number;
  spxLow?: number;
  prevClose?: number;

  // Volatility
  vix?: number;
  vix1d?: number;
  vix9d?: number;
  vvix?: number;

  // Calculator
  sigma?: number;
  sigmaSource?: string;
  tYears?: number;
  hoursRemaining?: number;
  skewPct?: number;

  // Regime
  regimeZone?: string;
  clusterMult?: number;
  dowMultHL?: number;
  dowMultOC?: number;
  dowLabel?: string;

  // Delta guide
  icCeiling?: number;
  putSpreadCeiling?: number;
  callSpreadCeiling?: number;
  moderateDelta?: number;
  conservativeDelta?: number;

  // Range thresholds
  medianOcPct?: number;
  medianHlPct?: number;
  p90OcPct?: number;
  p90HlPct?: number;
  p90OcPts?: number;
  p90HlPts?: number;

  // Opening range
  openingRangeAvailable?: boolean;
  openingRangeHigh?: number;
  openingRangeLow?: number;
  openingRangePctConsumed?: number;
  openingRangeSignal?: string;

  // Term structure
  vixTermSignal?: string;

  // Overnight
  overnightGap?: number;

  // Strikes
  strikes?: Record<string, unknown>;

  // Events
  isEarlyClose?: boolean;
  isEventDay?: boolean;
  eventNames?: string[];

  isBacktest?: boolean;
}

/**
 * Save a market snapshot. Uses ON CONFLICT DO NOTHING so duplicate
 * date+time combinations are silently skipped.
 * Returns the snapshot ID (existing or new).
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
    ON CONFLICT (date, entry_time) DO NOTHING
    RETURNING id
  `;

  const inserted = result[0];
  if (inserted) {
    return inserted.id as number;
  }

  // Already existed — look up the ID
  const existing = await sql`
    SELECT id FROM market_snapshots WHERE date = ${input.date} AND entry_time = ${input.entryTime}
  `;
  const found = existing[0];
  return found ? (found.id as number) : null;
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
    suggestedDelta: number;
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
      ${analysis.suggestedDelta},
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
