// @vitest-environment node

/**
 * REAL-SQL test for the repair-futures-blocks upsert.
 *
 * repair-futures-blocks.test.ts mocks the DB and only sees SQL text. Here
 * the handler runs end to end against pglite (real Postgres in WASM):
 * futures_blocks comes from the REAL migration #196 and the handler's own
 * unnest upsert writes to it. It checks what the mocks can't: the
 * newest-wins guard (an older REST message never replaces a newer stored
 * one, a stored NULL reported_at is always replaced), NULLs inside the
 * unnest arrays, decimal strings at NUMERIC(18,8), and the JSONB casts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mockRequest, mockResponse } from './helpers';

const { pg, mockUwFetch, mockCronGuard } = vi.hoisted(() => ({
  pg: { db: null as PGlite | null },
  mockUwFetch: vi.fn(),
  mockCronGuard: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb:
    () =>
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.reduce((acc, s, i) => `${acc}$${i}${s}`);
      return pg.db!.query(text, values).then((r) => r.rows);
    },
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setTag: vi.fn(),
  },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({ reportCronRun: vi.fn() }));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  cronGuard: mockCronGuard,
  withRetry: (fn: () => unknown) => fn(),
}));

import handler from '../cron/repair-futures-blocks.js';
import { applyMigration } from './pglite-migrations.js';

const NOW = '2026-10-29T22:15:00Z';

function block(over: Record<string, unknown> = {}) {
  return {
    action: 'new',
    clr_sym: 'ES',
    exchange: 'XCME',
    executed_at: '2026-10-29T15:27:26Z',
    is_block: true,
    is_spread: false,
    legs: [],
    price: '6612.25',
    product: 'ES',
    qty: '250',
    quote_ask: null,
    quote_bid: null,
    quote_ts: null,
    reported_at: '2026-10-29T15:27:54.060Z',
    sec_type: 'FUT',
    strategy: null,
    strategy_link_id: null,
    sym: 'ESZ6',
    trade_date: '2026-10-29',
    trade_id: 100,
    ...over,
  };
}

const OLD = block({
  trade_id: 1,
  executed_at: '2026-10-25T23:00:00Z',
  reported_at: '2026-10-25T23:00:30Z',
  trade_date: '2026-10-26',
});

/** Serve one page of blocks, then a page that ends the window. */
function servePage(rows: unknown[]) {
  mockUwFetch.mockReset();
  mockUwFetch.mockResolvedValueOnce(rows).mockResolvedValueOnce([OLD]);
}

async function run() {
  const res = mockResponse();
  await handler(
    mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    }),
    res,
  );
  return res;
}

/**
 * A stored row as the websocket handler would have left it: websocket
 * frames carry the quote at execution, which REST sends as null.
 */
async function seed(
  tradeId: number,
  action: string,
  reportedAt: string | null,
  qty: string,
  quotes: [string, string, string] | null = null,
): Promise<void> {
  await pg.db!.query(
    `INSERT INTO futures_blocks
       (trade_id, exchange, trade_date, action, qty, reported_at,
        quote_bid, quote_ask, quote_ts, raw_payload)
     VALUES ($1, 'XCME', '2026-10-29', $2, $3, $4, $5, $6, $7,
             '{"src":"ws"}'::jsonb)`,
    [tradeId, action, qty, reportedAt, ...(quotes ?? [null, null, null])],
  );
}

async function stored(tradeId: number) {
  const { rows } = await pg.db!.query<{
    action: string;
    qty: string | null;
    price: string | null;
    product: string | null;
    reported_at: string | null;
    quote_bid: string | null;
    quote_ask: string | null;
    quote_ts: string | null;
    legs: unknown;
    raw_payload: Record<string, unknown>;
  }>(
    `SELECT action, qty::text, price::text, product,
            to_char(reported_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US') AS reported_at,
            quote_bid::text, quote_ask::text,
            to_char(quote_ts AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US') AS quote_ts,
            legs, raw_payload
       FROM futures_blocks
      WHERE trade_id = $1 AND exchange = 'XCME' AND trade_date = '2026-10-29'`,
    [tradeId],
  );
  return rows[0];
}

const WS_QUOTES: [string, string, string] = [
  '6612.00',
  '6612.25',
  '2026-10-29T15:27:25Z',
];

describe('repair-futures-blocks upsert (pglite)', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    mockCronGuard.mockReturnValue({ apiKey: 'k', today: '2026-10-29' });
    pg.db = new PGlite();
    await applyMigration(pg.db, 196);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await pg.db?.close();
    pg.db = null;
  });

  it('inserts REST blocks: NUMERIC(18,8) decimals, NULLs from the arrays, JSONB legs and raw payload', async () => {
    servePage([
      block(),
      block({
        trade_id: 101,
        price: null,
        product: null,
        sec_type: 'MLEG',
        legs: [{ leg_side: 'BUY', price: '772.75', qty: '3.0', sym: 'S5MG7' }],
      }),
    ]);

    const res = await run();

    expect(res._json).toMatchObject({ status: 'success', rows: 3 });
    expect(await stored(100)).toMatchObject({
      action: 'new',
      qty: '250.00000000',
      price: '6612.25000000',
      product: 'ES',
      reported_at: '2026-10-29T15:27:54.060000',
      legs: [],
      raw_payload: expect.objectContaining({ clr_sym: 'ES' }),
    });
    expect(await stored(101)).toMatchObject({
      price: null,
      product: null,
      legs: [expect.objectContaining({ sym: 'S5MG7' })],
    });
  });

  it('never replaces a newer stored message, always replaces a stored NULL reported_at, and keeps a delete as a row state', async () => {
    // The websocket already stored a newer update for 100.
    await seed(100, 'update', '2026-10-29T16:00:00Z', '300');
    // And a row with no reported_at for 102.
    await seed(102, 'new', null, '5');
    servePage([
      block({ trade_id: 100, reported_at: '2026-10-29T15:27:54Z' }),
      block({
        trade_id: 102,
        action: 'delete',
        qty: '6',
        reported_at: '2026-10-29T15:40:00Z',
      }),
    ]);

    const res = await run();

    // 102 replaced + OLD inserted; 100 skipped by the guard.
    expect(res._json).toMatchObject({ status: 'success', rows: 2 });
    expect(await stored(100)).toMatchObject({
      action: 'update',
      qty: '300.00000000',
      raw_payload: { src: 'ws' },
    });
    expect(await stored(102)).toMatchObject({
      action: 'delete',
      qty: '6.00000000',
      reported_at: '2026-10-29T15:40:00.000000',
    });
  });

  it('leaves the websocket row alone when REST carries the same message (a reported_at tie): quotes and raw payload kept, not counted', async () => {
    // The websocket stored this exact message, with its quote.
    await seed(100, 'new', '2026-10-29T15:27:54.060Z', '250', WS_QUOTES);
    servePage([block()]); // same reported_at, quotes null

    const res = await run();

    // Only OLD was written.
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
    expect(await stored(100)).toMatchObject({
      quote_bid: '6612.00000000',
      quote_ask: '6612.25000000',
      quote_ts: '2026-10-29T15:27:25.000000',
      raw_payload: { src: 'ws' },
    });
  });

  it('a newer REST message replaces the websocket row but keeps its quotes when REST has none', async () => {
    await seed(100, 'new', '2026-10-29T15:27:54.060Z', '250', WS_QUOTES);
    servePage([
      block({
        action: 'update',
        qty: '260',
        reported_at: '2026-10-29T15:30:00Z',
      }),
    ]);

    await run();

    expect(await stored(100)).toMatchObject({
      action: 'update',
      qty: '260.00000000',
      quote_bid: '6612.00000000',
      quote_ask: '6612.25000000',
      quote_ts: '2026-10-29T15:27:25.000000',
      raw_payload: expect.objectContaining({ action: 'update' }),
    });
  });

  it('a stored NULL reported_at is not replaced by an incoming NULL one', async () => {
    await seed(103, 'new', null, '5', WS_QUOTES);
    servePage([block({ trade_id: 103, qty: '9', reported_at: null })]);

    await run();

    expect(await stored(103)).toMatchObject({
      qty: '5.00000000',
      raw_payload: { src: 'ws' },
    });
  });

  it('a re-run with the same messages is a no-op: nothing rewritten, nothing counted', async () => {
    servePage([block()]);
    await run();
    const first = await stored(100);

    servePage([block()]);
    const res = await run();

    expect(res._json).toMatchObject({ status: 'success', rows: 0 });
    expect(await stored(100)).toEqual(first);
    const { rows } = await pg.db!.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM futures_blocks',
    );
    expect(rows[0]!.n).toBe(2);
  });
});
