// @vitest-environment node

/**
 * REAL-SQL test for listTickersStoredOnOrBefore (Amendment 2 of the GEXBot
 * EOD capture spec): the tickers with a stored report dated on or before D.
 * The mocked-DB tests in gexbot-eod.test.ts only see the SQL text; "on or
 * before" (D itself in, D+1 out) is the behavior, so this file runs the
 * helper's actual statement against pglite (real Postgres in WASM).
 *
 * gexbot_eod_reports is built from the real migration #195. Only the DB
 * handle is replaced; withDbRetry is the real one.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration, neonOverPglite } from './pglite-migrations';

const holder = vi.hoisted(() => ({
  pg: null as unknown as PGlite,
}));

vi.mock('../_lib/db.js', async () => {
  const actual =
    await vi.importActual<typeof import('../_lib/db.js')>('../_lib/db.js');
  return { ...actual, getDb: () => neonOverPglite(holder.pg) };
});

// gexbot-eod.ts imports the R2 client at module level; no R2 call is made.
vi.mock('../_lib/r2.js', () => ({
  r2PutObject: vi.fn(),
  r2HeadObject: vi.fn(),
}));

import { listTickersStoredOnOrBefore } from '../_lib/gexbot-eod.js';

beforeAll(async () => {
  holder.pg = await PGlite.create();
  await applyMigration(holder.pg, 195);
}, 60_000);

afterAll(async () => {
  await holder.pg.close();
});

beforeEach(async () => {
  await holder.pg.query('TRUNCATE gexbot_eod_reports RESTART IDENTITY');
});

async function insertReport(ticker: string, date: string): Promise<void> {
  await holder.pg.query(
    `INSERT INTO gexbot_eod_reports
       (ticker, report_date, r2_key, bytes, sha256, entry_count, source)
     VALUES ($1, $2, $3, 1, 'sha', 15, 'cron')`,
    [ticker, date, `gexbot-eod/${ticker}/${date}.zip`],
  );
}

describe('listTickersStoredOnOrBefore (real SQL)', () => {
  it('includes a report dated on the bound and before it, not after it', async () => {
    await insertReport('BEFORE', '2026-11-19');
    await insertReport('ON', '2026-11-20');
    await insertReport('AFTER', '2026-11-21');
    const out = await listTickersStoredOnOrBefore('2026-11-20');
    expect([...out].sort()).toEqual(['BEFORE', 'ON']);
  });

  it('does not list a ticker first stored after the bound (a new listing)', async () => {
    await insertReport('SPX', '2026-11-19');
    await insertReport('SPX', '2026-11-20');
    await insertReport('ANT', '2026-11-23');
    const out = await listTickersStoredOnOrBefore('2026-11-20');
    expect(out).toEqual(new Set(['SPX']));
  });

  it('lists a ticker with an old report and a gap (a re-added ticker)', async () => {
    await insertReport('ROKU', '2026-10-29');
    const out = await listTickersStoredOnOrBefore('2026-11-20');
    expect(out).toEqual(new Set(['ROKU']));
  });

  it('returns each ticker once however many days it has', async () => {
    await insertReport('SPX', '2026-11-18');
    await insertReport('SPX', '2026-11-19');
    await insertReport('SPX', '2026-11-20');
    const out = await listTickersStoredOnOrBefore('2026-11-20');
    expect(out.size).toBe(1);
    expect(out.has('SPX')).toBe(true);
  });

  it('returns an empty set when nothing is stored on or before the bound', async () => {
    await insertReport('SPX', '2026-11-21');
    expect(await listTickersStoredOnOrBefore('2026-11-20')).toEqual(new Set());
  });
});
