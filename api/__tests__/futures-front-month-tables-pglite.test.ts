// @vitest-environment node

/**
 * REAL-SQL test for migration #205: futures_contract_volume and
 * futures_front_month, the two tables behind the per-session front-month
 * rule (docs/superpowers/specs/2026-11-06-futures-session-front-month.md).
 *
 * Nothing in the app writes them yet, so this checks the schema itself, on
 * the real migration entry applied to pglite (real Postgres in WASM):
 * the key of each table, the closed list of sources each CHECK allows, the
 * NOT NULL columns and the database-side timestamps. The writers' protocol
 * (insert once with ON CONFLICT DO NOTHING, then re-read) relies on the
 * (product, trade_date) key, so it is run here against the real table.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration } from './pglite-migrations';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await applyMigration(db, 205);
});

beforeEach(async () => {
  await db.exec('TRUNCATE futures_contract_volume, futures_front_month');
});

afterAll(async () => {
  await db.close();
});

function insertVolume(
  over: Partial<{
    product: string;
    tradeDate: string;
    contract: string;
    volume: number | null;
    source: string | null;
  }> = {},
) {
  const v = {
    product: 'ES',
    tradeDate: '2026-11-05',
    contract: 'ESZ6',
    volume: 1000 as number | null,
    source: 'live' as string | null,
    ...over,
  };
  return db.query(
    `INSERT INTO futures_contract_volume
       (product, trade_date, contract, volume, source)
     VALUES ($1, $2, $3, $4, $5)`,
    [v.product, v.tradeDate, v.contract, v.volume, v.source],
  );
}

function insertFront(
  over: Partial<{
    product: string;
    tradeDate: string;
    contract: string;
    source: string | null;
  }> = {},
) {
  const v = {
    product: 'ES',
    tradeDate: '2026-11-05',
    contract: 'ESZ6',
    source: 'live' as string | null,
    ...over,
  };
  return db.query(
    `INSERT INTO futures_front_month (product, trade_date, contract, source)
     VALUES ($1, $2, $3, $4)`,
    [v.product, v.tradeDate, v.contract, v.source],
  );
}

describe('migration #205: the schema', () => {
  it('creates both tables with the columns, types and nullability the writers rely on', async () => {
    const { rows } = await db.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name IN ('futures_contract_volume', 'futures_front_month')
        ORDER BY table_name, ordinal_position`,
    );

    expect(
      rows.map((r) => [
        r.table_name,
        r.column_name,
        r.data_type,
        r.is_nullable,
      ]),
    ).toEqual([
      ['futures_contract_volume', 'product', 'text', 'NO'],
      ['futures_contract_volume', 'trade_date', 'date', 'NO'],
      ['futures_contract_volume', 'contract', 'text', 'NO'],
      ['futures_contract_volume', 'volume', 'bigint', 'NO'],
      ['futures_contract_volume', 'source', 'text', 'NO'],
      [
        'futures_contract_volume',
        'updated_at',
        'timestamp with time zone',
        'NO',
      ],
      ['futures_front_month', 'product', 'text', 'NO'],
      ['futures_front_month', 'trade_date', 'date', 'NO'],
      ['futures_front_month', 'contract', 'text', 'NO'],
      ['futures_front_month', 'source', 'text', 'NO'],
      ['futures_front_month', 'decided_at', 'timestamp with time zone', 'NO'],
    ]);
  });

  it('re-runs cleanly: a stored row survives a second apply', async () => {
    await insertVolume();
    await insertFront();

    await applyMigration(db, 205);

    const vol = await db.query(`SELECT 1 FROM futures_contract_volume`);
    const front = await db.query(`SELECT 1 FROM futures_front_month`);
    expect([vol.rows.length, front.rows.length]).toEqual([1, 1]);
  });

  it('fills updated_at and decided_at in the database, so a writer need not send them', async () => {
    await insertVolume();
    await insertFront();

    const { rows } = await db.query<{ stamped: boolean }>(
      `SELECT (SELECT updated_at IS NOT NULL FROM futures_contract_volume)
              AND (SELECT decided_at IS NOT NULL FROM futures_front_month)
              AS stamped`,
    );
    expect(rows).toEqual([{ stamped: true }]);
  });
});

describe('futures_contract_volume', () => {
  it('keeps one row per product, trade date and contract', async () => {
    await insertVolume();

    await expect(insertVolume({ volume: 5 })).rejects.toThrow(
      /futures_contract_volume_pkey/,
    );

    // Any one part of the key may differ.
    await insertVolume({ contract: 'ESH7' });
    await insertVolume({ tradeDate: '2026-11-06' });
    await insertVolume({ product: 'NQ', contract: 'NQZ6' });
    const { rows } = await db.query(`SELECT 1 FROM futures_contract_volume`);
    expect(rows).toHaveLength(4);
  });

  it.each(['live', 'candles'])('accepts the source %s', async (source) => {
    await expect(insertVolume({ source })).resolves.toBeDefined();
  });

  it.each(['cron', 'script', 'LIVE', ''])(
    'rejects the source %j',
    async (source) => {
      await expect(insertVolume({ source })).rejects.toThrow(
        /futures_contract_volume_source_check/,
      );
    },
  );

  it('rejects a NULL volume', async () => {
    await expect(insertVolume({ volume: null })).rejects.toThrow(
      /null value in column "volume"/,
    );
  });

  it('rejects a NULL source: a CHECK passes on NULL, so NOT NULL is the only guard', async () => {
    await expect(insertVolume({ source: null })).rejects.toThrow(
      /null value in column "source"/,
    );
  });

  it('stores a volume past 32 bits', async () => {
    await insertVolume({ volume: 5_000_000_000 });

    const { rows } = await db.query<{ volume: string }>(
      `SELECT volume::text AS volume FROM futures_contract_volume`,
    );
    expect(rows).toEqual([{ volume: '5000000000' }]);
  });
});

describe('futures_front_month', () => {
  it('keeps one decision per product and trade date, whatever the contract', async () => {
    await insertFront();

    await expect(insertFront({ contract: 'ESH7' })).rejects.toThrow(
      /futures_front_month_pkey/,
    );

    await insertFront({ tradeDate: '2026-11-06' });
    await insertFront({ product: 'NQ', contract: 'NQZ6' });
    const { rows } = await db.query(`SELECT 1 FROM futures_front_month`);
    expect(rows).toHaveLength(3);
  });

  it('lets the first writer win: ON CONFLICT DO NOTHING keeps its row, and the re-read returns it to every later writer', async () => {
    await insertFront({ contract: 'ESZ6', source: 'live' });

    const second = await db.query(
      `INSERT INTO futures_front_month (product, trade_date, contract, source)
       VALUES ('ES', '2026-11-05', 'ESH7', 'cron')
       ON CONFLICT DO NOTHING`,
    );
    const { rows } = await db.query<{ contract: string; source: string }>(
      `SELECT contract, source FROM futures_front_month
        WHERE product = 'ES' AND trade_date = '2026-11-05'`,
    );

    expect(second.affectedRows).toBe(0);
    expect(rows).toEqual([{ contract: 'ESZ6', source: 'live' }]);
  });

  it.each(['live', 'cron', 'script', 'candles'])(
    'accepts the source %s',
    async (source) => {
      await expect(insertFront({ source })).resolves.toBeDefined();
    },
  );

  it.each(['volume', 'seed', 'LIVE', ''])(
    'rejects the source %j',
    async (source) => {
      await expect(insertFront({ source })).rejects.toThrow(
        /futures_front_month_source_check/,
      );
    },
  );

  it('rejects a NULL source: a CHECK passes on NULL, so NOT NULL is the only guard', async () => {
    await expect(insertFront({ source: null })).rejects.toThrow(
      /null value in column "source"/,
    );
  });
});
