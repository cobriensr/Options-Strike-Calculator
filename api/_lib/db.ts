/**
 * Postgres database helper using Neon serverless driver.
 *
 * Base tables (created by initDb):
 *   market_snapshots — complete calculator state at each date+time (UNIQUE)
 *   analyses         — Claude chart analysis responses (linked to snapshots)
 *   outcomes         — end-of-day settlement data (for future backtesting)
 *
 * All other tables (positions, lessons, flow_data, etc.) are created by migrations.
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
import { MIGRATIONS } from './db-migrations.js';

export type { Migration } from './db-migrations.js';

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

  // ── Positions table is created by migration #1 ─────────
  // Do not add new tables here — use migrations instead.

  // ── Indexes ───────────────────────────────────────────────
  await sql`CREATE INDEX IF NOT EXISTS idx_snapshots_date ON market_snapshots (date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_analyses_date ON analyses (date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_analyses_structure ON analyses (structure)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_analyses_confidence ON analyses (confidence)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_analyses_snapshot ON analyses (snapshot_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_outcomes_date ON outcomes (date)`;
}

// ============================================================
// MIGRATIONS (extracted to db-migrations.ts)
// ============================================================

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

    if (migration.statements) {
      // Atomic: migration statements + tracking INSERT all-or-nothing
      await sql.transaction([
        ...migration.statements(sql),
        sql`INSERT INTO schema_migrations (id, description) VALUES (${migration.id}, ${migration.description})`,
      ]);
    } else if (migration.run) {
      // Legacy: sequential execution (not atomic)
      await migration.run(sql);
      await sql`
        INSERT INTO schema_migrations (id, description) VALUES (${migration.id}, ${migration.description})
      `;
    }
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
