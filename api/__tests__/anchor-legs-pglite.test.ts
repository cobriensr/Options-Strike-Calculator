// @vitest-environment node

/**
 * REAL-SQL test for lookupAnchorLegs' two statements.
 *
 * anchor-legs.test.ts mocks the db and only sees bound values. This file
 * runs the module's ACTUAL anchor and sibling queries against pglite (real
 * Postgres in WASM) on a ws_option_trades table built from the real
 * migration #109, so the spec's SQL rules are checked by Postgres itself:
 *
 *   - anchor: top price × size on the chain (and ticker) in
 *     [windowStart, windowEnd), canceled = false, price > 0, ties to the
 *     earliest print;
 *   - siblings: same ticker, the anchor's exact millisecond
 *     [ms, ms + 1 ms), uncanceled, multi-leg trade code (any case), any
 *     price (a zero-priced wing is still a leg).
 *
 * The session runs in America/Chicago, not Neon's UTC: nothing here may
 * depend on the session time zone.
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

const { pgRef } = vi.hoisted(() => ({
  pgRef: { current: null as PGlite | null },
}));

// getDb() returns a Neon-shaped tagged template over pglite.
vi.mock('../_lib/db.js', () => ({
  getDb:
    () =>
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const pg = pgRef.current;
      if (!pg) throw new Error('pglite not started');
      const text = strings.reduce((acc, part, i) => `${acc}$${i}${part}`);
      return pg.query(text, values).then((r) => r.rows);
    },
}));

import { applyMigration } from './pglite-migrations';
import {
  lookupAnchorLegs,
  type AnchorLegs,
  type AnchorRequest,
} from '../_lib/anchor-legs.js';

const EXP = '2026-10-30';
const T = '2026-10-29T14:00:00.250Z';
const WIN_START = '2026-10-29T13:59:30.000Z';
const WIN_END = '2026-10-29T14:00:30.000Z';

/** ISO instant `ms` milliseconds after `iso`. */
const plus = (iso: string, ms: number): string =>
  new Date(Date.parse(iso) + ms).toISOString();

/** OCC symbol, e.g. TSLA261030C00100000. */
function chainOf(root: string, type: 'C' | 'P', strike: number): string {
  const yymmdd = EXP.slice(2).replaceAll('-', '');
  return `${root}${yymmdd}${type}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}

interface SeedPrint {
  ticker?: string;
  type?: 'C' | 'P';
  strike: number;
  at: string;
  price: number;
  size: number;
  code?: string | null;
  canceled?: boolean;
}

let pg: PGlite;
let seq = 0;

/** Insert prints; returns their ws_trade_ids in input order. */
async function seed(prints: SeedPrint[]): Promise<string[]> {
  const ids = prints.map(() => {
    seq += 1;
    return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  });
  await pg.query(
    `INSERT INTO ws_option_trades (
       ws_trade_id, ticker, option_chain, option_type, strike, expiry,
       executed_at, price, size, side, canceled, raw_payload)
     SELECT t.id, t.ticker, t.chain, t.type, t.strike, $12::date,
            t.at, t.price, t.size, 'ask', t.canceled, t.payload::jsonb
       FROM unnest($1::uuid[], $2::text[], $3::text[], $4::char[],
                   $5::numeric[], $6::timestamptz[], $7::numeric[],
                   $8::int[], $9::bool[], $10::text[], $11::int[])
         AS t(id, ticker, chain, type, strike, at, price, size, canceled,
              payload, ord)
      ORDER BY t.ord`,
    [
      ids,
      prints.map((p) => p.ticker ?? 'TSLA'),
      prints.map((p) => chainOf(p.ticker ?? 'TSLA', p.type ?? 'C', p.strike)),
      prints.map((p) => p.type ?? 'C'),
      prints.map((p) => p.strike),
      prints.map((p) => p.at),
      prints.map((p) => p.price),
      prints.map((p) => p.size),
      prints.map((p) => p.canceled ?? false),
      prints.map((p) =>
        JSON.stringify(p.code === null ? {} : { trade_code: p.code ?? 'mlet' }),
      ),
      prints.map((_, i) => i),
      EXP,
    ],
  );
  return ids;
}

function request(
  key: string,
  strike: number,
  opts: {
    ticker?: string;
    chainTicker?: string;
    type?: 'C' | 'P';
    start?: string;
    end?: string;
  } = {},
): AnchorRequest {
  const ticker = opts.ticker ?? 'TSLA';
  return {
    key,
    ticker,
    optionChain: chainOf(opts.chainTicker ?? ticker, opts.type ?? 'C', strike),
    windowStart: new Date(opts.start ?? WIN_START),
    windowEnd: new Date(opts.end ?? WIN_END),
  };
}

async function lookupOne(req: AnchorRequest): Promise<AnchorLegs | null> {
  const result = await lookupAnchorLegs([req]);
  expect(result.has(req.key)).toBe(true);
  return result.get(req.key) ?? null;
}

const strikes = (a: AnchorLegs | null) =>
  a?.spreadLegs?.map((l) => l.strike) ?? null;

beforeAll(async () => {
  pg = await PGlite.create();
  pgRef.current = pg;
  await applyMigration(pg, 109);
  await pg.query(`SET TIME ZONE 'America/Chicago'`);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.query('TRUNCATE ws_option_trades');
});

describe('lookupAnchorLegs on real SQL (pglite): anchor', () => {
  it('(a) picks the highest price × size, not the earliest or priciest', async () => {
    const [, winner] = await seed([
      { strike: 100, at: plus(T, -10_000), price: 1, size: 10, code: 'auto' }, // 10
      { strike: 100, at: plus(T, 5_000), price: 2, size: 6, code: 'auto' }, // 12
      { strike: 100, at: plus(T, -5_000), price: 5, size: 2, code: 'auto' }, // 10
    ]);
    expect((await lookupOne(request('k', 100)))?.anchorWsTradeId).toBe(winner);
  });

  it('(b) breaks an equal price × size tie to the earlier print', async () => {
    // The later print is inserted first, so a lower id can't explain it.
    const [, earlier] = await seed([
      { strike: 100, at: plus(T, 5_000), price: 2, size: 5, code: 'auto' },
      { strike: 100, at: plus(T, -5_000), price: 1, size: 10, code: 'auto' },
    ]);
    expect((await lookupOne(request('k', 100)))?.anchorWsTradeId).toBe(earlier);
  });

  it('(c) never anchors on a canceled or zero-priced print', async () => {
    const [, , valid] = await seed([
      { strike: 100, at: T, price: 50, size: 100, canceled: true },
      { strike: 100, at: T, price: 0, size: 10_000 },
      { strike: 100, at: T, price: 0.1, size: 1 },
    ]);
    expect((await lookupOne(request('k', 100)))?.anchorWsTradeId).toBe(valid);

    await pg.query('TRUNCATE ws_option_trades');
    await seed([
      { strike: 100, at: T, price: 50, size: 100, canceled: true },
      { strike: 100, at: T, price: 0, size: 10_000 },
    ]);
    expect(await lookupOne(request('k', 100))).toBeNull();
  });

  it('(d) includes a print at windowStart and excludes one at windowEnd', async () => {
    const [atStart] = await seed([
      { strike: 100, at: WIN_START, price: 1, size: 1, code: 'auto' },
      { strike: 100, at: WIN_END, price: 100, size: 100, code: 'auto' },
    ]);
    expect((await lookupOne(request('k', 100)))?.anchorWsTradeId).toBe(atStart);
  });

  it('(j) gives a null anchor when the request ticker does not match the stored row', async () => {
    await seed([{ strike: 100, at: T, price: 1, size: 1 }]);
    expect(
      await lookupOne(
        request('k', 100, { ticker: 'AAPL', chainTicker: 'TSLA' }),
      ),
    ).toBeNull();
  });
});

describe('lookupAnchorLegs on real SQL (pglite): siblings', () => {
  it('(e) excludes siblings 1 ms after (and before) the anchor millisecond', async () => {
    await seed([
      { strike: 100, at: T, price: 2, size: 10 }, // anchor
      { strike: 105, at: T, price: 1, size: 10 },
      { strike: 110, at: plus(T, 1), price: 1, size: 10 },
      { strike: 95, at: plus(T, -1), price: 1, size: 10 },
    ]);
    const anchor = await lookupOne(request('k', 100));
    expect(anchor?.spreadShape).toBe('vertical');
    expect(strikes(anchor)).toEqual([100, 105]);
  });

  it('(f) includes an uppercase MLET sibling', async () => {
    await seed([
      { strike: 100, at: T, price: 2, size: 10, code: 'mlet' },
      { strike: 105, at: T, price: 1, size: 10, code: 'MLET' },
    ]);
    const anchor = await lookupOne(request('k', 100));
    expect(anchor?.spreadShape).toBe('vertical');
    expect(anchor?.spreadLegs?.[1]?.tradeCode).toBe('MLET');
  });

  it('(g) excludes same-ms auto-coded, other-ticker and canceled prints', async () => {
    await seed([
      { strike: 100, at: T, price: 2, size: 10 }, // anchor
      { strike: 105, at: T, price: 1, size: 10, code: 'auto' },
      { ticker: 'AAPL', strike: 105, at: T, price: 1, size: 10 },
      { strike: 110, at: T, price: 1, size: 10, canceled: true },
    ]);
    const anchor = await lookupOne(request('k', 100));
    expect(anchor?.legKind).toBe('multi_leg');
    expect(anchor?.spreadShape).toBe('unpaired');
    expect(strikes(anchor)).toEqual([100]);
  });

  it('(h) round-trips the anchor time to the exact millisecond', async () => {
    // If the anchor's ms came back off by one, its same-ms sibling would be
    // missed and the shape would read `unpaired`.
    const instants = [
      '2026-10-29T14:00:00.001Z',
      '2026-10-29T14:00:00.057Z',
      '2026-10-29T14:00:00.999Z',
    ];
    await seed(
      instants.flatMap((at, i) => [
        { strike: 100 + i * 10, at, price: 2, size: 10 },
        { strike: 105 + i * 10, at, price: 1, size: 10 },
      ]),
    );
    const result = await lookupAnchorLegs(
      instants.map((_, i) => request(`k${i}`, 100 + i * 10)),
    );
    expect(instants.map((_, i) => result.get(`k${i}`)?.spreadShape)).toEqual([
      'vertical',
      'vertical',
      'vertical',
    ]);
  });

  it('(i) keeps a zero-priced multi-leg sibling as a leg', async () => {
    await seed([
      { type: 'P', strike: 140, at: T, price: 2, size: 2 }, // body = anchor
      { type: 'P', strike: 135, at: T, price: 0, size: 1 },
      { type: 'P', strike: 145, at: T, price: 1, size: 1 },
    ]);
    const anchor = await lookupOne(request('k', 140, { type: 'P' }));
    expect(anchor?.spreadShape).toBe('butterfly');
    expect(anchor?.spreadLegs).toEqual([
      {
        optionType: 'P',
        strike: 140,
        expiry: EXP,
        size: 2,
        price: 2,
        tradeCode: 'mlet',
      },
      {
        optionType: 'P',
        strike: 135,
        expiry: EXP,
        size: 1,
        price: 0,
        tradeCode: 'mlet',
      },
      {
        optionType: 'P',
        strike: 145,
        expiry: EXP,
        size: 1,
        price: 1,
        tradeCode: 'mlet',
      },
    ]);
  });
});
