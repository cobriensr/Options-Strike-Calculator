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
import { DB_RETRY_ATTEMPTS } from './constants.js';
import { metrics } from './sentry.js';

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

/**
 * ⚠️ BEST-EFFORT ONLY. Runs `op`; on ANY throw, swallows it, increments the
 * `db.error` metric, and returns `fallback` — the caller NEVER sees the error.
 *
 * Use ONLY for idempotent or fire-and-forget DB ops where a silent failure is
 * acceptable (e.g. the kept-tickers accumulation, the retention prune). NEVER
 * wrap a write whose failure must surface to the caller or whose loss matters
 * (journal inserts, position saves, anything a user expects to persist) — those
 * MUST use `withDbRetry` (retries then rethrows) so the failure propagates.
 *
 * The DB-side mirror of `safeRedis` in `redis.ts`.
 *
 * @param op       the DB operation to run.
 * @param fallback the value to return if `op` throws.
 */
export async function safeDb<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await op();
  } catch {
    metrics.increment('db.error');
    return fallback;
  }
}

/**
 * ⚠️ BEST-EFFORT ONLY. Void-returning convenience wrapper over {@link safeDb}
 * for best-effort write paths that have no meaningful return value.
 *
 * Same contract as `safeDb`: swallows any throw and increments `db.error`.
 * Use ONLY for idempotent or fire-and-forget ops. NEVER for writes whose
 * failure must surface — use `withDbRetry` for those.
 */
export async function safeDbVoid(op: () => Promise<void>): Promise<void> {
  await safeDb(op, undefined);
}

// ============================================================
// TRANSIENT-ERROR RETRY
// ============================================================

/**
 * Neon's HTTP serverless driver occasionally surfaces transient TLS /
 * proxy / DNS hiccups as `NeonDbError: Error connecting to database:
 * TypeError: fetch failed`. The error is non-deterministic and
 * recovers on the next request. Read endpoints with high poll
 * cadences (e.g. `/api/gex-strike-expiry`, polled every 30 s × 4
 * tickers) amplify it into a Sentry firehose.
 *
 * `withDbRetry` is the DB-side analogue of
 * `withRetry` in `uw-fetch.ts`: linear backoff (1 s, 2 s, 3 s),
 * 2 retries by default, only retries when the error message looks
 * like a transient network failure. Non-transient `NeonDbError`s
 * (constraint violations, syntax errors) bubble up unchanged so the
 * caller's error path stays intact.
 *
 * Patterns added 2026-05-19 after a ~30-minute Neon recovery-mode
 * blip spilled ~35 distinct Sentry issues across endpoints that
 * never got past the first attempt:
 *   - `recovery_mode` / `server_login_retry`: the proxy responds to
 *     login attempts with a cached "database is in recovery mode"
 *     error while a node is being restarted. Resolves in seconds.
 *   - `Too many connections`: brief saturation when a compute node
 *     just started; resolves once the pool warms.
 *   - `server conn crashed` / `connection closed`: transient cut on
 *     an in-flight request. The HTTP serverless driver does not
 *     reconnect on retry — caller must reissue.
 */
const DB_RETRYABLE_RX =
  /timeout|ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|fetch failed|socket hang up|TLS connection|EAI_AGAIN|recovery_mode|server_login_retry|Too many connections|connection closed|server conn crashed/i;

/**
 * Thrown by withDbRetry when it exhausts retries on a transient (retryable)
 * DB error. A typed marker so HTTP handlers can distinguish a real Neon blip
 * from a genuine bug whose message happens to contain a transient token.
 */
export class TransientDbError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'TransientDbError';
    this.cause = cause;
  }
}

export function isRetryableDbError(err: unknown): boolean {
  // A TransientDbError is, by construction, a retry-exhausted transient
  // failure. Classify it as retryable so nested withDbRetry layers and
  // lottery-finder's degradeOnTimeout still treat a re-thrown wrapper as
  // transient. Must precede the `instanceof Error` check below since the
  // wrapper preserves the original message (which may or may not match the rx).
  if (err instanceof TransientDbError) return true;
  if (!(err instanceof Error)) return false;
  // NeonDbError wraps the underlying network failure on `sourceError`.
  // Inspect both layers so a `TypeError: fetch failed` cause matches
  // even when the outer message is generic ("Error connecting to
  // database").
  const source = (err as { sourceError?: unknown }).sourceError;
  const sourceMsg = source instanceof Error ? source.message : '';
  return DB_RETRYABLE_RX.test(`${err.message} ${sourceMsg}`);
}

/** Classification of a settled, degradable promise: no failure, a
 *  transient (retryable) DB error, or a genuine (non-retryable) error. */
export type SettleFailure = null | 'transient' | 'genuine';

export interface SettledDegradable<T> {
  value: T;
  failure: SettleFailure;
  reason?: unknown;
}

/**
 * Collapse one `Promise.allSettled` result into a value + failure kind for
 * fail-open fan-outs. A fulfilled result keeps its value with `failure:null`;
 * a rejected result falls open to `fallback` and is classified `'transient'`
 * (retryable per {@link isRetryableDbError} — a Neon blip / re-thrown
 * `TransientDbError`) or `'genuine'` (a real bug whose message does not match
 * the retryable rx, e.g. a renamed column). Callers decide the blast radius:
 * transient → degrade quietly (warning); genuine → page (error). Never throws.
 */
export function settleDegradable<T>(
  result: PromiseSettledResult<T>,
  fallback: T,
): SettledDegradable<T> {
  if (result.status === 'fulfilled')
    return { value: result.value, failure: null };
  return {
    value: fallback,
    failure: isRetryableDbError(result.reason) ? 'transient' : 'genuine',
    reason: result.reason,
  };
}

export async function withDbRetry<T>(
  fn: () => Promise<T>,
  retries: number = DB_RETRY_ATTEMPTS,
  perAttemptTimeoutMs?: number,
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (perAttemptTimeoutMs == null) return await fn();
      // Race against a per-attempt timeout. Neon's HTTP serverless
      // driver has no AbortSignal hook, so a hung connection would
      // otherwise consume the entire function budget (300s) and
      // prevent any retry. Throwing a retryable error here lets the
      // loop fall through to the next attempt — the retry classifier
      // matches `timeout` in the message via DB_RETRYABLE_RX above.
      //
      // Capture the timer handle so it can be cleared once the race
      // settles. Without this, a query that resolves before the timeout
      // leaves a live 10s timer armed — it never rejects anything (the
      // race is already settled) but keeps the event loop / function
      // alive and, in tests, leaks a pending fake timer.
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          fn(),
          new Promise<T>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error('db attempt timeout')),
              perAttemptTimeoutMs,
            );
          }),
        ]);
      } finally {
        if (timeoutHandle != null) clearTimeout(timeoutHandle);
      }
    } catch (err) {
      if (!isRetryableDbError(err)) throw err; // genuine error → raw
      if (attempt === retries) throw new TransientDbError(err); // exhausted transient
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error('unreachable');
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
 * Asserts that a migrations array has unique ids in strictly increasing order.
 *
 * Throws immediately (fail-fast) if any id is duplicated or not strictly
 * greater than the previous id. This is a compile-time / boot-time guard
 * against concurrent-branch merge mistakes (e.g. two branches each adding
 * id 189). The real MIGRATIONS array is always well-formed (ids 1..N, no
 * dups); this throws only on a developer/merge error, never on runtime data.
 *
 * @param migrations array of objects with a numeric `id` field.
 * @throws Error naming the first offending id or pair.
 */
export function assertMigrationsWellFormed(migrations: { id: number }[]): void {
  for (let i = 0; i < migrations.length; i++) {
    const curr = migrations[i]!.id;
    if (i === 0) continue;
    const prev = migrations[i - 1]!.id;
    if (curr <= prev) {
      throw new Error(
        `Malformed MIGRATIONS: id ${curr} is not strictly greater than previous id ${prev} (duplicate or out-of-order) at index ${i}`,
      );
    }
  }
}

/**
 * Run pending database migrations.
 * Creates a `schema_migrations` table to track applied migrations.
 * Safe to call multiple times — already-applied migrations are skipped.
 * Returns an array of descriptions for newly applied migrations.
 */
export async function migrateDb(): Promise<string[]> {
  // Fail-fast guard: a duplicate or out-of-order id in MIGRATIONS is always a
  // developer/merge error. Catch it at boot rather than silently skipping a
  // migration whose id was already recorded in schema_migrations.
  assertMigrationsWellFormed(MIGRATIONS);

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
