import pg from 'pg';
import type { Bar } from './bar-aggregator.js';
import logger from './logger.js';

const { Pool } = pg;
let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL not configured');
    pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      ssl: true,
    });
    pool.on('error', (err) => {
      logger.error({ err }, 'Idle database client error');
    });
  }
  return pool;
}

export async function verifyConnection(): Promise<void> {
  const p = getPool();
  const result = await p.query('SELECT 1 AS ok');
  if (result.rows[0]?.ok !== 1)
    throw new Error('Database connection verification failed');
  logger.info('Database connection verified');
}

export async function upsertBar(bar: Bar): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO es_bars (symbol, ts, open, high, low, close, volume, tick_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (symbol, ts) DO UPDATE SET
       open       = es_bars.open,
       high       = GREATEST(es_bars.high, EXCLUDED.high),
       low        = LEAST(es_bars.low, EXCLUDED.low),
       close      = EXCLUDED.close,
       volume     = GREATEST(es_bars.volume, EXCLUDED.volume),
       tick_count = GREATEST(es_bars.tick_count, EXCLUDED.tick_count)`,
    [
      bar.symbol,
      bar.ts,
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      bar.volume,
      bar.tickCount,
    ],
  );
}

export async function drainPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database pool drained');
  }
}
