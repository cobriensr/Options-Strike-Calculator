// @vitest-environment node

/**
 * REAL-SQL test for migration #199: drop the redundant
 * ws_net_flow_per_ticker_ticker_ts_idx and set per-table autovacuum options.
 *
 * ws_net_flow_per_ticker and its indexes come from the REAL migration #121;
 * the other seven tables are stubs (only the table has to exist for an
 * ALTER ... SET). #199 runs in one transaction, as migrateDb() runs it, and
 * twice, because on prod it is a no-op over the hand-applied change.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration } from './pglite-migrations.js';

const INSERT_TUNED = [
  'ws_net_flow_per_ticker',
  'strike_iv_snapshots',
  'strike_exposures',
  'lottery_finder_fires',
  'net_flow_per_ticker_history',
];
// Tuned on prod 2026-05-13 with the four base settings.
const PRE_TUNED = ['ws_gex_strike_expiry', 'ws_option_trades'];
// gex_strike_0dte is insert-only too, so it also gets the insert factor.
const INSERT_TUNED_LATE = 'gex_strike_0dte';

const BASE_OPTIONS = [
  'autovacuum_analyze_scale_factor=0.005',
  'autovacuum_analyze_threshold=1000',
  'autovacuum_vacuum_scale_factor=0.01',
  'autovacuum_vacuum_threshold=1000',
];

async function runInTransaction(pg: PGlite): Promise<void> {
  await pg.exec('BEGIN');
  try {
    await applyMigration(pg, 199);
    await pg.exec('COMMIT');
  } catch (err) {
    await pg.exec('ROLLBACK');
    throw err;
  }
}

async function reloptions(pg: PGlite, table: string): Promise<string[]> {
  const { rows } = await pg.query<{ reloptions: string[] | null }>(
    'SELECT reloptions FROM pg_class WHERE relname = $1',
    [table],
  );
  return [...(rows[0]?.reloptions ?? [])].sort();
}

async function indexNames(pg: PGlite): Promise<string[]> {
  const { rows } = await pg.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'ws_net_flow_per_ticker'`,
  );
  return rows.map((r) => r.indexname).sort();
}

describe('migration #199 (net-flow index drop + autovacuum)', () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    await applyMigration(pg, 121);
    for (const t of INSERT_TUNED.slice(1).concat(
      PRE_TUNED,
      INSERT_TUNED_LATE,
    )) {
      await pg.exec(`CREATE TABLE ${t} (id INT)`);
    }
  });

  afterEach(async () => {
    await pg.close();
  });

  it('starts with the redundant DESC index in place', async () => {
    expect(await indexNames(pg)).toContain(
      'ws_net_flow_per_ticker_ticker_ts_idx',
    );
  });

  it('drops only the redundant index, keeping the unique key and ts index', async () => {
    await runInTransaction(pg);
    expect(await indexNames(pg)).toEqual([
      'ws_net_flow_per_ticker_pkey',
      'ws_net_flow_per_ticker_ts_idx',
      'ws_net_flow_per_ticker_uq',
    ]);
  });

  it('sets the insert scale factor on the six insert-heavy tables', async () => {
    await runInTransaction(pg);
    for (const t of [...INSERT_TUNED, INSERT_TUNED_LATE]) {
      expect(await reloptions(pg, t), t).toEqual(
        [...BASE_OPTIONS, 'autovacuum_vacuum_insert_scale_factor=0.01'].sort(),
      );
    }
  });

  it('records the two other prod-tuned tables without the insert factor', async () => {
    await runInTransaction(pg);
    for (const t of PRE_TUNED) {
      expect(await reloptions(pg, t), t).toEqual(BASE_OPTIONS);
    }
  });

  it('is idempotent when the index is already gone and options are set', async () => {
    await runInTransaction(pg);
    await expect(runInTransaction(pg)).resolves.toBeUndefined();
    expect(await indexNames(pg)).not.toContain(
      'ws_net_flow_per_ticker_ticker_ts_idx',
    );
  });

  it('fails atomically when a target table is missing', async () => {
    await pg.exec('DROP TABLE gex_strike_0dte');
    await expect(runInTransaction(pg)).rejects.toThrow(/gex_strike_0dte/);
    // The earlier ALTERs ran before the failure, so these prove the rollback.
    expect(await reloptions(pg, 'ws_net_flow_per_ticker')).toEqual([]);
    expect(await reloptions(pg, 'strike_iv_snapshots')).toEqual([]);
    expect(await indexNames(pg)).toContain(
      'ws_net_flow_per_ticker_ticker_ts_idx',
    );
  });
});
