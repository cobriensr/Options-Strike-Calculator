// @vitest-environment node

/**
 * REAL-SQL test for the sibling taker-flow lookup. The mocked
 * gexbot-queries tests can only match SQL text; this one runs the actual
 * query against pglite on the table built by migration #156, so "the
 * snapshot at or before the fire time, not the latest" is proven by data:
 * a later row of the opposite sign sits in the table and must not be read.
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

import { applyMigration } from './pglite-migrations';

const holder = vi.hoisted(() => ({
  pg: null as unknown as {
    query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }>;
  },
}));

vi.mock('../_lib/db.js', () => ({
  getDb: () => {
    const tag = (strings: TemplateStringsArray, ...params: unknown[]) => {
      const text = strings.reduce((acc, part, i) => `${acc}$${i}${part}`);
      return holder.pg.query(text, params).then((r) => r.rows);
    };
    return tag;
  },
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

import { getSiblingConfirmation } from '../_lib/gexbot-queries.js';

let pg: PGlite;

async function seed(
  ticker: string,
  capturedAt: string,
  netDex: number | null,
  zgr: number | null = null,
) {
  await pg.query(
    `INSERT INTO gexbot_snapshots (ticker, captured_at, net_dex, zgr, raw_response)
     VALUES ($1, $2::timestamptz, $3, $4, '{}'::jsonb)`,
    [ticker, capturedAt, netDex, zgr],
  );
}

describe('getSiblingConfirmation against real SQL', () => {
  beforeAll(async () => {
    pg = new PGlite();
    holder.pg = pg;
    await applyMigration(pg, 156);
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await pg.query('DELETE FROM gexbot_snapshots');
  });

  const FIRE = new Date('2026-10-29T14:00:10.000Z');

  it('reads the snapshot at or before the fire time, not a later one', async () => {
    await seed('QQQ', '2026-10-29T14:00:00Z', 2_000_000, 0.9);
    // Later row, opposite sign: the current-minute read the old code made.
    await seed('QQQ', '2026-10-29T14:00:40Z', -9_000_000, 1.1);
    const rows = await getSiblingConfirmation('SPY', 'call', FIRE);
    const qqq = rows.find((r) => r.ticker === 'QQQ');
    expect(qqq).toMatchObject({
      netDex: 2_000_000,
      zgr: 0.9,
      capturedAt: '2026-10-29T14:00:00.000Z',
      verdict: 'agree',
    });
    const put = await getSiblingConfirmation('SPY', 'put', FIRE);
    expect(put.find((r) => r.ticker === 'QQQ')?.verdict).toBe('disagree');
  });

  it('includes a snapshot exactly at the fire time', async () => {
    await seed('QQQ', '2026-10-29T14:00:10Z', -1_000_000);
    const rows = await getSiblingConfirmation('SPY', 'put', FIRE);
    expect(rows.find((r) => r.ticker === 'QQQ')?.verdict).toBe('agree');
  });

  it('picks the newest of several rows inside the window', async () => {
    await seed('QQQ', '2026-10-29T13:58:00Z', -1_000_000);
    await seed('QQQ', '2026-10-29T14:00:05Z', 3_000_000);
    const rows = await getSiblingConfirmation('SPY', 'call', FIRE);
    expect(rows.find((r) => r.ticker === 'QQQ')?.netDex).toBe(3_000_000);
  });

  it('returns no data when the only snapshot is older than 180 s', async () => {
    await seed('QQQ', '2026-10-29T13:56:00Z', 2_000_000);
    const rows = await getSiblingConfirmation('SPY', 'call', FIRE);
    expect(rows.find((r) => r.ticker === 'QQQ')).toMatchObject({
      netDex: null,
      capturedAt: null,
      verdict: 'none',
    });
  });

  it('returns no data for a fire from a session the live table no longer holds', async () => {
    await seed('QQQ', '2026-10-29T14:00:00Z', 2_000_000);
    const rows = await getSiblingConfirmation(
      'SPY',
      'call',
      new Date('2026-10-20T14:00:10.000Z'),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.verdict === 'none')).toBe(true);
  });

  it('reads none for a zero net_dex and for a null one', async () => {
    await seed('QQQ', '2026-10-29T14:00:00Z', 0);
    await seed('IWM', '2026-10-29T14:00:00Z', null, 1.2);
    const rows = await getSiblingConfirmation('SPY', 'call', FIRE);
    expect(rows.find((r) => r.ticker === 'QQQ')?.verdict).toBe('none');
    expect(rows.find((r) => r.ticker === 'IWM')?.verdict).toBe('none');
  });

  it('never reads the futures views even when they have rows', async () => {
    await seed('ES_SPX', '2026-10-29T14:00:00Z', 5_000_000);
    await seed('NQ_NDX', '2026-10-29T14:00:00Z', 5_000_000);
    const rows = await getSiblingConfirmation('SPX', 'call', FIRE);
    expect(rows.map((r) => r.ticker)).not.toContain('ES_SPX');
    expect(rows.map((r) => r.ticker)).not.toContain('NQ_NDX');
  });
});
