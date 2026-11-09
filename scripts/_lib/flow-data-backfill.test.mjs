// @vitest-environment node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { neonMock, sqlQuery } = vi.hoisted(() => ({
  neonMock: vi.fn(),
  sqlQuery: vi.fn(),
}));
vi.mock('@neondatabase/serverless', () => ({ neon: neonMock }));

import {
  DayFailure,
  runDays,
  summarizeItemRun,
  summarizeRun,
} from './backfill-cli.mjs';
import {
  ETF_TIDE,
  FLOW_DATA_TARGET,
  loggedFlowDataTarget,
  MARKET_TIDE,
  NET_FLOW,
  planFlowDays,
  processFlowDay,
  runFlowScript,
  sampleFiveMinuteRows,
  storeSampledDay,
  toEtfTideRows,
  toMarketTideRows,
  toNetFlowRows,
} from './flow-data-backfill.mjs';

// 2026-11-06 is a Friday, EST (UTC−5); 03:00 ET. "Today" in ET is 2026-11-06,
// so every date below is a finished day.
const TODAY = '2026-11-06T08:00:00Z';
// 2026-08-12 and 2026-08-13 are a Wednesday and Thursday in EDT (UTC−4).
const D1 = '2026-08-12';
const D2 = '2026-08-13';
const D3 = '2026-08-14';
// 2026-11-04 is a Wednesday in EST (UTC−5): 19:30 ET is already the next UTC day.
const WINTER = '2026-11-04';

const SECRETS = { uwKey: 'uw-key-for-tests', databaseUrl: undefined };
const noWait = async () => {};

function atTime(iso, toFake = ['Date']) {
  vi.useFakeTimers({ toFake });
  vi.setSystemTime(new Date(iso));
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body, text: async () => 'body text' };
}

const iso = (ms) => new Date(ms).toISOString();

/** `n` UW market-tide / ETF-tide rows, five minutes apart from 13:30Z (EDT). */
function tideRows(n, date = D1, overrides = {}) {
  const open = Date.parse(`${date}T13:30:00Z`);
  return Array.from({ length: n }, (_, i) => ({
    date: `${date}T00:00:00.000Z`,
    timestamp: iso(open + i * 300_000),
    net_call_premium: '660338.0000',
    net_put_premium: '-547564.0000',
    net_volume: 23558 + i,
    ...overrides,
  }));
}

/** `n` UW net-prem-ticks, five minutes apart from 13:30Z (EDT). */
function ticks(n, date = D1, overrides = {}) {
  const open = Date.parse(`${date}T13:30:00Z`);
  return Array.from({ length: n }, (_, i) => ({
    date: `${date}T00:00:00.000Z`,
    tape_time: iso(open + i * 300_000),
    net_call_premium: '1000.00',
    net_put_premium: '-500.00',
    net_call_volume: 10,
    net_put_volume: -4,
    ...overrides,
  }));
}

/**
 * A sql handle whose query() answers like Postgres' RETURNING id: one row per
 * row inserted (six columns a row; a statement that logs to the revision log
 * binds one more value, the writer), minus `conflicts` rows that ON CONFLICT DO
 * NOTHING skipped.
 */
function fakeSql({ conflicts = 0 } = {}) {
  return {
    query: vi.fn(async (_text, values) =>
      Array.from(
        { length: Math.max(0, Math.floor(values.length / 6) - conflicts) },
        (_, i) => ({ id: i }),
      ),
    ),
  };
}

// ── The table and its unique key ───────────────────────────

describe('FLOW_DATA_TARGET', () => {
  const migrations = readFileSync(
    path.resolve(process.cwd(), 'api', '_lib', 'db-migrations.ts'),
    'utf8',
  );
  // Migration #4's CREATE TABLE statement, up to the end of its template
  // literal. Empty when the statement is not found, which fails both tests below.
  const tableStart = migrations.indexOf(
    'CREATE TABLE IF NOT EXISTS flow_data (',
  );
  const createTable =
    tableStart === -1
      ? ''
      : migrations.slice(tableStart, migrations.indexOf('`;', tableStart));

  it('conflicts on the key the migration creates, not on a key the script made up', () => {
    // Migration #4: UNIQUE(date, timestamp, source).
    expect(createTable).toContain('UNIQUE(date, timestamp, source)');
    expect(FLOW_DATA_TARGET.table).toBe('flow_data');
    expect(FLOW_DATA_TARGET.conflictTarget).toBe('(date, timestamp, source)');
  });

  it('writes only columns the table has', () => {
    for (const column of FLOW_DATA_TARGET.columns) {
      expect(createTable).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it('is not re-keyed by a later migration: no constraint change, no unique index, nothing on the key behind the constraint', () => {
    // The plain idx_flow_data_* indexes and a CHECK constraint may come and
    // go; only a unique or primary key, or a unique index, could change the
    // conflict key. Dropping the constraint is caught by its index name below.
    expect(migrations).not.toMatch(
      /ALTER TABLE flow_data[^`]*(UNIQUE|PRIMARY KEY)/i,
    );
    expect(migrations).not.toMatch(/CREATE UNIQUE INDEX[^`]*ON flow_data\b/i);
    expect(migrations).not.toContain('flow_data_date_timestamp_source_key');
  });
});

// ── Market tide rows ───────────────────────────────────────

describe('toMarketTideRows', () => {
  /** One tide row at 14:<minute>Z, with `overrides` on top of the defaults. */
  const at = (minute, overrides) =>
    tideRows(1, D1, {
      timestamp: `2026-08-12T14:${minute}:00.000Z`,
      ...overrides,
    })[0];

  it('maps UW rows to flow_data rows: the asked date, the source, numbers, UW timestamps as sent', () => {
    const { rows, dropped } = toMarketTideRows(D1, 'market_tide', tideRows(2));

    expect(dropped).toBe(0);
    expect(rows).toEqual([
      {
        date: D1,
        timestamp: '2026-08-12T13:30:00.000Z',
        source: 'market_tide',
        ncp: 660338,
        npp: -547564,
        net_volume: 23558,
      },
      {
        date: D1,
        timestamp: '2026-08-12T13:35:00.000Z',
        source: 'market_tide',
        ncp: 660338,
        npp: -547564,
        net_volume: 23559,
      },
    ]);
  });

  it('does not move a timestamp onto a 5-minute boundary: the live cron stores them as UW sends them', () => {
    const uw = tideRows(1, D1, { timestamp: '2026-08-12T13:34:00.000Z' });
    expect(toMarketTideRows(D1, 'market_tide', uw).rows[0].timestamp).toBe(
      '2026-08-12T13:34:00.000Z',
    );
  });

  it('returns the rows oldest first', () => {
    const uw = tideRows(3).reverse();
    expect(
      toMarketTideRows(D1, 'market_tide', uw).rows.map((r) => r.timestamp),
    ).toEqual([
      '2026-08-12T13:30:00.000Z',
      '2026-08-12T13:35:00.000Z',
      '2026-08-12T13:40:00.000Z',
    ]);
  });

  it('stores an absent net_volume as NULL, not 0', () => {
    const [row] = toMarketTideRows(
      D1,
      'market_tide_otm',
      tideRows(1, D1, { net_volume: undefined }),
    ).rows;
    expect(row.net_volume).toBeNull();
  });

  it('leaves out a net_volume the INTEGER column cannot hold, and counts it, instead of failing the whole INSERT', () => {
    const uw = [
      at('00', { net_volume: 2_147_483_647 }),
      at('05', { net_volume: -2_147_483_648 }),
      at('10', { net_volume: 2_147_483_648 }),
      at('15', { net_volume: -2_147_483_649 }),
      at('20', { net_volume: 1e15 }),
    ];

    const { rows, dropped } = toMarketTideRows(D1, 'market_tide', uw);

    expect(rows.map((r) => r.net_volume)).toEqual([
      2_147_483_647, -2_147_483_648,
    ]);
    expect(dropped).toBe(3);
  });

  it('leaves out a premium the DECIMAL(14,2) column cannot hold, and counts it, instead of failing the whole INSERT', () => {
    const uw = [
      // the largest and smallest values that fit: 12 digits and 2 decimals
      at('00', {
        net_call_premium: '999999999999.99',
        net_put_premium: '-999999999999.99',
      }),
      // one past each end, call side then put side, as a number and a string
      at('05', { net_call_premium: 1_000_000_000_000 }),
      at('10', { net_put_premium: '-1000000000000.00' }),
      at('15', { net_call_premium: '-1000000000000' }),
      at('20', { net_put_premium: 1e15 }),
    ];

    const { rows, dropped } = toMarketTideRows(D1, 'market_tide', uw);

    expect(rows.map((r) => [r.ncp, r.npp])).toEqual([
      [999_999_999_999.99, -999_999_999_999.99],
    ]);
    expect(dropped).toBe(4);
    // The ETF tide shares the rule.
    expect(toEtfTideRows(D1, 'spy_etf_tide', uw)).toMatchObject({
      dropped: 4,
    });
  });

  it('rounds a premium to a cent before it checks the range, as Postgres does: .994 fits, .995 rounds up past the end', () => {
    const uw = [
      // rounds down to 999,999,999,999.99: kept
      at('00', {
        net_call_premium: '999999999999.994',
        net_put_premium: '-999999999999.994',
      }),
      // round to 1,000,000,000,000.00: Postgres would reject the INSERT
      at('05', { net_call_premium: '999999999999.995' }),
      at('10', { net_call_premium: '-999999999999.995' }),
      at('15', { net_put_premium: '999999999999.995' }),
      at('20', { net_put_premium: '-999999999999.995' }),
    ];

    const market = toMarketTideRows(D1, 'market_tide', uw);
    const etf = toEtfTideRows(D1, 'spy_etf_tide', uw);

    for (const { rows, dropped } of [market, etf]) {
      expect(rows.map((r) => [r.ncp, r.npp])).toEqual([
        [999_999_999_999.994, -999_999_999_999.994],
      ]);
      expect(dropped).toBe(4);
    }
  });

  it('counts a row it leaves out instead of storing it', () => {
    const good = tideRows(1);
    const uw = [
      ...good,
      // another ET day (09:30 ET on the 13th)
      ...tideRows(1, D2),
      // premiums that are not numbers
      ...tideRows(1, D1, {
        timestamp: '2026-08-12T14:00:00.000Z',
        net_call_premium: 'n/a',
      }),
      ...tideRows(1, D1, {
        timestamp: '2026-08-12T14:05:00.000Z',
        net_put_premium: null,
      }),
      // a volume that is not a whole number
      ...tideRows(1, D1, {
        timestamp: '2026-08-12T14:10:00.000Z',
        net_volume: 12.5,
      }),
      ...tideRows(1, D1, {
        timestamp: '2026-08-12T14:15:00.000Z',
        net_volume: 'abc',
      }),
      // a timestamp that does not parse
      ...tideRows(1, D1, { timestamp: 'yesterday' }),
      // the same minute again: the first one stays, as ON CONFLICT DO NOTHING keeps it
      ...tideRows(1, D1, { net_volume: 1 }),
    ];

    const { rows, dropped } = toMarketTideRows(D1, 'market_tide', uw);

    expect(rows).toHaveLength(1);
    expect(rows[0].net_volume).toBe(23558);
    expect(dropped).toBe(7);
  });

  it('reads the day in ET, not UTC: 19:30 ET in winter is already the next UTC date', () => {
    // 2026-11-05T00:30Z is 19:30 ET on the 4th.
    const late = tideRows(1, WINTER, { timestamp: '2026-11-05T00:30:00.000Z' });
    expect(toMarketTideRows(WINTER, 'market_tide', late).rows).toHaveLength(1);
    expect(toMarketTideRows('2026-11-05', 'market_tide', late)).toEqual({
      rows: [],
      dropped: 1,
    });
  });

  it('maps no rows to no rows', () => {
    expect(toMarketTideRows(D1, 'market_tide', [])).toEqual({
      rows: [],
      dropped: 0,
    });
  });
});

// ── ETF tide rows ──────────────────────────────────────────

describe('toEtfTideRows', () => {
  /** One-minute rows from 13:30Z, `volumeAt(i)` the net volume of minute i. */
  function minuteRows(n, volumeAt = (i) => i) {
    const open = Date.parse(`${D1}T13:30:00Z`);
    return Array.from({ length: n }, (_, i) => ({
      date: `${D1}T00:00:00.000Z`,
      timestamp: iso(open + i * 60_000),
      net_call_premium: String(100 * (i + 1)),
      net_put_premium: String(-10 * (i + 1)),
      net_volume: volumeAt(i),
    }));
  }

  it('keeps the last row of each 5-minute window, stamped at the window start', () => {
    // Minutes 0-4 are one window, 5-9 the next, 10 starts a third.
    const { rows, dropped } = toEtfTideRows(D1, 'spy_etf_tide', minuteRows(11));

    expect(dropped).toBe(0);
    expect(rows.map((r) => [r.timestamp, r.ncp, r.npp, r.net_volume])).toEqual([
      ['2026-08-12T13:30:00.000Z', 500, -50, 4],
      ['2026-08-12T13:35:00.000Z', 1000, -100, 9],
      ['2026-08-12T13:40:00.000Z', 1100, -110, 10],
    ]);
    expect(
      rows.every((r) => r.date === D1 && r.source === 'spy_etf_tide'),
    ).toBe(true);
  });

  it('puts the rows in time order before it picks the last of a window, whatever order UW sent them in', () => {
    const shuffled = minuteRows(5).reverse();
    const [row] = toEtfTideRows(D1, 'spy_etf_tide', shuffled).rows;
    // Minute 4 is the last of the window, though UW sent it first.
    expect(row.net_volume).toBe(4);
  });

  it('leaves out a row whose premium is not a number instead of storing a 0', () => {
    const uw = minuteRows(5);
    uw[4].net_call_premium = 'n/a';

    const { rows, dropped } = toEtfTideRows(D1, 'qqq_etf_tide', uw);

    expect(dropped).toBe(1);
    // Minute 3 is now the last good row of the window.
    expect(rows).toHaveLength(1);
    expect(rows[0].ncp).toBe(400);
    expect(rows[0].net_volume).toBe(3);
  });

  it('leaves out a row from another ET day', () => {
    const uw = [...minuteRows(2), ...tideRows(1, D2)];
    const { rows, dropped } = toEtfTideRows(D1, 'spy_etf_tide', uw);
    expect(rows).toHaveLength(1);
    expect(dropped).toBe(1);
  });
});

// ── Net flow rows ──────────────────────────────────────────

describe('toNetFlowRows', () => {
  /** One-minute ticks from 13:30Z. */
  function minuteTicks(specs) {
    const open = Date.parse(`${D1}T13:30:00Z`);
    return specs.map(([ncp, npp, callVol, putVol], i) => ({
      date: `${D1}T00:00:00.000Z`,
      tape_time: iso(open + i * 60_000),
      net_call_premium: ncp,
      net_put_premium: npp,
      net_call_volume: callVol,
      net_put_volume: putVol,
    }));
  }

  it('adds the per-minute ticks up and keeps the running total at the last tick of each 5-minute window', () => {
    const uw = minuteTicks([
      ['100', '-10', 5, -1],
      ['100', '-10', 5, -1],
      ['100', '-10', 5, -1],
      ['100', '-10', 5, -1],
      ['100', '-10', 5, -1],
      ['50', '-5', 2, -2],
    ]);

    const { rows, dropped } = toNetFlowRows(D1, 'spx_flow', uw);

    expect(dropped).toBe(0);
    expect(rows).toEqual([
      {
        date: D1,
        timestamp: '2026-08-12T13:30:00.000Z',
        source: 'spx_flow',
        ncp: 500,
        npp: -50,
        // net call volume + net put volume, summed: 5 * (5 - 1)
        net_volume: 20,
      },
      {
        date: D1,
        timestamp: '2026-08-12T13:35:00.000Z',
        source: 'spx_flow',
        ncp: 550,
        npp: -55,
        net_volume: 20,
      },
    ]);
  });

  it('puts the ticks in time order before it adds them: UW does not promise an order', () => {
    // Three ticks in three different 5-minute windows: the running total at
    // each window depends on the ticks before it, so a different order shows.
    const inOrder = ticks(3).map((tick, i) => ({
      ...tick,
      net_call_premium: String(100 * 2 ** i),
    }));
    const forward = toNetFlowRows(D1, 'spy_flow', inOrder);
    const backward = toNetFlowRows(D1, 'spy_flow', [...inOrder].reverse());

    expect(forward.rows.map((r) => r.ncp)).toEqual([100, 300, 700]);
    expect(backward).toEqual(forward);
  });

  it('reads a volume sent as a string as a number: no string glued onto the total', () => {
    const uw = minuteTicks([
      ['1', '0', '3', '-1'],
      ['1', '0', '3', '-1'],
    ]);
    expect(toNetFlowRows(D1, 'qqq_flow', uw).rows[0].net_volume).toBe(4);
  });

  it('counts a tick with a bad premium, adds it as a premium of 0, and still adds its volumes', () => {
    const uw = minuteTicks([
      ['100', '-10', 1, 0],
      ['n/a', '-10', 1, 0],
      ['100', null, 1, 0],
      ['100', '-10', 1, 0],
    ]);

    const { rows, dropped } = toNetFlowRows(D1, 'spx_flow', uw);

    expect(dropped).toBe(2);
    expect(rows).toHaveLength(1);
    // A bad premium counts as 0 (the live cron's `|| 0`); a good one beside it stays.
    expect(rows[0].ncp).toBe(300);
    expect(rows[0].npp).toBe(-30);
    expect(rows[0].net_volume).toBe(4);
  });

  it('keeps the volume of a tick with a bad premium in every later row: the running net volume does not shift', () => {
    // Window 13:30 holds a good tick; window 13:35 a bad-premium tick that
    // carries volume 600/-100; window 13:40 a good tick. Leaving the bad tick
    // out would take 500 off the net volume of the 13:35 and 13:40 rows.
    const uw = ticks(3).map((tick, i) => ({
      ...tick,
      net_call_premium: i === 1 ? 'n/a' : '100',
      net_put_premium: '-10',
      net_call_volume: [10, 600, 20][i],
      net_put_volume: [-4, -100, -5][i],
    }));

    const { rows, dropped } = toNetFlowRows(D1, 'spx_flow', uw);

    expect(dropped).toBe(1);
    expect(rows.map((r) => r.net_volume)).toEqual([6, 506, 521]);
    expect(rows.map((r) => r.ncp)).toEqual([100, 100, 200]);
  });

  describe('a running total that leaves its column', () => {
    // Ticks 5 minutes apart from 13:30Z, so the third is 13:40Z.
    const withTicks = (...fields) =>
      ticks(fields.length).map((tick, i) => ({
        ...tick,
        net_call_premium: '0',
        net_put_premium: '0',
        net_call_volume: 0,
        net_put_volume: 0,
        ...fields[i],
      }));
    const failure = (uw) => {
      try {
        toNetFlowRows(D1, 'spx_flow', uw);
      } catch (error) {
        return error;
      }
      return null;
    };

    it('fails the item as malformed, naming the source, the date, the column and the first bad minute, instead of dropping ticks', () => {
      // 999,999,999,999.99 fits DECIMAL(14,2); one cent more does not.
      const error = failure(
        withTicks(
          { net_call_premium: '999999999999.00' },
          { net_call_premium: '0.99' },
          { net_call_premium: '0.01' },
          { net_call_premium: '0.01' },
        ),
      );

      expect(error).toBeInstanceOf(DayFailure);
      expect(error.kind).toBe('malformed');
      expect(error.message).toContain('spx_flow for 2026-08-12');
      expect(error.message).toContain('ncp');
      // The third tick (13:40Z) is the first to push the total past the end.
      expect(error.message).toContain('2026-08-12T13:40:00.000Z');
    });

    it.each([
      ['ncp', { net_call_premium: '600000000000' }],
      ['npp', { net_put_premium: '-600000000000' }],
      ['net_volume', { net_call_volume: 1_500_000_000 }],
      ['net_volume', { net_put_volume: -1_500_000_000 }],
    ])(
      'fails on %s when the second tick takes the total past the end',
      (column, tick) => {
        const error = failure(withTicks(tick, tick));

        expect(error).toBeInstanceOf(DayFailure);
        expect(error.message).toContain(column);
        expect(error.message).toContain('2026-08-12T13:35:00.000Z');
      },
    );

    it('takes totals that end exactly on the limits', () => {
      const { rows } = toNetFlowRows(
        D1,
        'spx_flow',
        withTicks(
          {
            net_call_premium: '999999999999.99',
            net_put_premium: '-999999999999.99',
            net_call_volume: 2_147_483_647,
          },
          // this tick's own volume is the lowest INTEGER; the total goes from
          // 2,147,483,647 to -1
          { net_put_volume: -2_147_483_648 },
        ),
      );

      expect(rows.map((r) => [r.ncp, r.npp, r.net_volume])).toEqual([
        [999_999_999_999.99, -999_999_999_999.99, 2_147_483_647],
        [999_999_999_999.99, -999_999_999_999.99, -1],
      ]);
    });

    it('keeps a net_volume total that lands exactly on a limit, and fails one past it', () => {
      const atLowest = toNetFlowRows(
        D1,
        'spx_flow',
        withTicks({ net_put_volume: -2_147_483_648 }),
      );
      expect(atLowest.rows.map((r) => r.net_volume)).toEqual([-2_147_483_648]);

      const belowLowest = failure(
        withTicks({ net_put_volume: -2_147_483_648 }, { net_put_volume: -1 }),
      );
      expect(belowLowest).toBeInstanceOf(DayFailure);
      expect(belowLowest.message).toContain('net_volume');
      expect(belowLowest.message).toContain('2026-08-12T13:35:00.000Z');

      const aboveHighest = failure(
        withTicks({ net_call_volume: 2_147_483_647 }, { net_call_volume: 1 }),
      );
      expect(aboveHighest).toBeInstanceOf(DayFailure);
      expect(aboveHighest.message).toContain('2026-08-12T13:35:00.000Z');
    });

    it('lets one corrupt tick fail the whole item, not just its own row', () => {
      // A tick in the middle of a day sends every later total out of range.
      const error = failure(
        withTicks({}, { net_call_premium: '1e13' }, {}, {}),
      );

      expect(error).toBeInstanceOf(DayFailure);
      expect(error.message).toContain('2026-08-12T13:35:00.000Z');
    });
  });

  it('leaves out a tick from another ET day before adding anything up', () => {
    const uw = [
      ...minuteTicks([['100', '0', 1, 0]]),
      ...ticks(1, D2, { net_call_premium: '99999' }),
    ];

    const { rows, dropped } = toNetFlowRows(D1, 'spx_flow', uw);

    expect(dropped).toBe(1);
    expect(rows[0].ncp).toBe(100);
  });

  it('maps no ticks to no rows', () => {
    expect(toNetFlowRows(D1, 'spx_flow', [])).toEqual({ rows: [], dropped: 0 });
  });
});

// ── The day worker, per script ─────────────────────────────

const CASES = [
  {
    name: 'market tide',
    spec: MARKET_TIDE,
    items: ['market_tide', 'market_tide_otm'],
    sources: ['market_tide', 'market_tide_otm'],
    urls: [
      'https://api.unusualwhales.com/api/market/market-tide?date=2026-08-12&interval_5m=true',
      'https://api.unusualwhales.com/api/market/market-tide?date=2026-08-12&interval_5m=true&otm_only=true',
    ],
    itemOf: (url) =>
      url.includes('otm_only=true') ? 'market_tide_otm' : 'market_tide',
    answer: (n, date) => tideRows(n, date),
    zero: (n, date) =>
      tideRows(n, date, { net_call_premium: '0', net_put_premium: '0.0000' }),
  },
  {
    name: 'ETF tide',
    spec: ETF_TIDE,
    items: ['SPY', 'QQQ'],
    sources: ['spy_etf_tide', 'qqq_etf_tide'],
    urls: [
      'https://api.unusualwhales.com/api/market/SPY/etf-tide?date=2026-08-12',
      'https://api.unusualwhales.com/api/market/QQQ/etf-tide?date=2026-08-12',
    ],
    itemOf: (url) => /market\/([A-Z]+)\/etf-tide/.exec(url)[1],
    answer: (n, date) => tideRows(n, date),
    zero: (n, date) =>
      tideRows(n, date, { net_call_premium: '0', net_put_premium: '0.0000' }),
  },
  {
    name: 'net flow',
    spec: NET_FLOW,
    items: ['SPX', 'SPY', 'QQQ'],
    sources: ['spx_flow', 'spy_flow', 'qqq_flow'],
    urls: [
      'https://api.unusualwhales.com/api/stock/SPX/net-prem-ticks?date=2026-08-12',
      'https://api.unusualwhales.com/api/stock/SPY/net-prem-ticks?date=2026-08-12',
      'https://api.unusualwhales.com/api/stock/QQQ/net-prem-ticks?date=2026-08-12',
    ],
    itemOf: (url) => /stock\/([A-Z]+)\/net-prem-ticks/.exec(url)[1],
    answer: (n, date) => ticks(n, date),
    zero: (n, date) =>
      ticks(n, date, { net_call_premium: '0.00', net_put_premium: '0.00' }),
  },
];

/**
 * Stub the global fetch. `answerFor(item, date, url)` gives, per request, the
 * UW rows (an array), a response object (has `ok`) or an Error to throw.
 */
function stubFetch(testCase, answerFor) {
  const fetchMock = vi.fn(async (url) => {
    const text = String(url);
    const date = /date=([\d-]+)/.exec(text)[1];
    const answer = answerFor(testCase.itemOf(text), date, text);
    if (answer instanceof Error) throw answer;
    if (answer && !Array.isArray(answer) && 'ok' in answer) return answer;
    return jsonResponse({ data: answer });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function runWorker(dates, worker) {
  const pending = runDays(
    dates,
    { allowMarketHours: true, secrets: SECRETS },
    worker,
  );
  await vi.advanceTimersByTimeAsync(10_000);
  return pending;
}

describe.each(CASES)('processFlowDay: $name', (testCase) => {
  const { spec, items, sources } = testCase;
  const ctx = (sql, extra = {}) => ({
    apiKey: 'uw-key-for-tests',
    sql,
    dryRun: false,
    waitForSlot: noWait,
    ...extra,
  });
  const work = (sql, extra) => (date) =>
    processFlowDay(date, ctx(sql, extra), spec);
  const everyItem = (n) => (_item, date) => testCase.answer(n, date);

  beforeEach(() => atTime(TODAY, ['Date', 'setTimeout']));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('asks UW for each item and writes its rows: counts, URLs, key, one statement each', async () => {
    const fetchMock = stubFetch(testCase, everyItem(4));
    const sql = fakeSql();

    const run = await runWorker([D1], work(sql));

    const n = items.length;
    expect(spec.items).toEqual(items);
    expect(run.days).toEqual([
      {
        date: D1,
        ok: true,
        value: {
          fetched: 4 * n,
          stored: 4 * n,
          kept: 4 * n,
          dropped: 0,
          emptyItems: 0,
        },
      },
    ]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(testCase.urls);
    expect(sql.query).toHaveBeenCalledTimes(n);
    for (const [index, [text, values]] of sql.query.mock.calls.entries()) {
      expect(text).toContain('INSERT INTO flow_data');
      expect(text).toContain(
        'ON CONFLICT (date, timestamp, source) DO NOTHING',
      );
      expect(values.slice(0, 3)).toEqual([
        D1,
        expect.stringContaining(`${D1}T`),
        sources[index],
      ]);
    }
    expect(summarizeRun(run).exitCode).toBe(0);
  });

  it('sends the key, an explicit User-Agent of its own, and waits on the throttle before every request', async () => {
    const fetchMock = stubFetch(testCase, everyItem(1));
    const waitForSlot = vi.fn(async () => {});

    await runWorker([D1], work(fakeSql(), { waitForSlot }));

    expect(waitForSlot).toHaveBeenCalledTimes(items.length);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers.Authorization).toBe('Bearer uw-key-for-tests');
      expect(init.headers['User-Agent']).toBe(spec.userAgent);
    }
    expect(spec.userAgent).toMatch(/^strike-calculator-[a-z-]+ \(node\)$/);
  });

  it('on a dry run fetches and maps but writes nothing: stored 0, kept the would-be count', async () => {
    stubFetch(testCase, everyItem(3));
    const sql = fakeSql();

    const run = await runWorker([D1], work(sql, { dryRun: true }));

    expect(run.days[0].value).toMatchObject({
      fetched: 3 * items.length,
      stored: 0,
      kept: 3 * items.length,
    });
    expect(sql.query).not.toHaveBeenCalled();
  });

  it('on the 07-22 partial day the live morning rows stay: stored reads below kept', async () => {
    stubFetch(testCase, everyItem(10));
    // Four rows per item were already there from the live cron.
    const sql = fakeSql({ conflicts: 4 });

    const run = await runWorker([D1], work(sql));

    const n = items.length;
    expect(run.days[0].value).toMatchObject({
      kept: 10 * n,
      stored: 6 * n,
    });
    expect(sql.query.mock.calls[0][0]).toContain('DO NOTHING');
  });

  it('reports a trading day UW has no rows for as an empty day, not a failure', async () => {
    stubFetch(testCase, () => []);
    const sql = fakeSql();

    const run = await runWorker([D1], work(sql));

    expect(run.days[0]).toMatchObject({
      ok: true,
      value: { fetched: 0, stored: 0, emptyItems: items.length },
    });
    const summary = summarizeRun(run);
    expect(summary.emptyDays).toEqual([D1]);
    expect(summary.exitCode).toBe(0);
    expect(sql.query).not.toHaveBeenCalled();
  });

  it('shows an item UW had no rows for: emptyItems on the day, the date in the summary, exit 0', async () => {
    const [first] = items;
    stubFetch(testCase, (item, date) =>
      item === first ? [] : testCase.answer(2, date),
    );
    const sql = fakeSql();

    const run = await runWorker([D1], work(sql));

    expect(run.days[0].value).toMatchObject({
      fetched: 2 * (items.length - 1),
      emptyItems: 1,
    });
    // The empty item wrote nothing.
    expect(sql.query).toHaveBeenCalledTimes(items.length - 1);
    expect(sql.query.mock.calls.map(([, v]) => v[2])).not.toContain(sources[0]);
    const { lines, exitCode } = summarizeItemRun(
      run,
      items.length,
      spec.itemLabel,
      'rows',
    );
    expect(lines.at(-1)).toBe(
      `partly empty days (UW had no rows for some of the ${items.length} ` +
        `${spec.itemLabel}; a hole to look at, not a failure): ${D1} (1 empty)`,
    );
    expect(exitCode).toBe(0);
    expect(summarizeRun(run).emptyDays).toEqual([]);
  });

  it('fails the day as uw_http_503 when UW keeps answering 503, retries once, and still tries the other items', async () => {
    const [first] = items;
    const down = jsonResponse({}, { ok: false, status: 503 });
    const fetchMock = stubFetch(testCase, (item, date) =>
      item === first ? down : testCase.answer(3, date),
    );
    const sql = fakeSql();

    const run = await runWorker([D1], work(sql));

    expect(run.days[0].ok).toBe(false);
    expect(run.days[0].failure.kind).toBe('uw_http_503');
    expect(run.days[0].failure.detail).toContain(
      `1 of ${items.length} ${spec.itemLabel} failed`,
    );
    expect(run.days[0].failure.detail).toContain(`first (${first})`);
    // The first item twice (one retry), every other item once; theirs still went in.
    expect(fetchMock).toHaveBeenCalledTimes(items.length + 1);
    expect(sql.query).toHaveBeenCalledTimes(items.length - 1);
    expect(summarizeRun(run).exitCode).toBe(1);
  });

  it('fails the day as uw_http_403 for a date outside the plan, never as an empty day', async () => {
    stubFetch(testCase, () => jsonResponse({}, { ok: false, status: 403 }));

    const run = await runWorker([D1], work(fakeSql()));

    expect(run.days[0].failure.kind).toBe('uw_http_403');
    expect(summarizeRun(run).emptyDays).toEqual([]);
    expect(summarizeRun(run).exitCode).toBe(1);
  });

  it('fails the day as network when the fetch itself throws', async () => {
    const reset = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET' },
    });
    stubFetch(testCase, () => reset);

    const run = await runWorker([D1], work(fakeSql()));

    expect(run.days[0].failure.kind).toBe('network');
    expect(summarizeRun(run).exitCode).toBe(1);
  });

  it('fails the day as timeout when UW does not answer in time', async () => {
    const slow = Object.assign(new Error('The operation timed out'), {
      name: 'TimeoutError',
    });
    stubFetch(testCase, () => slow);

    const run = await runWorker([D1], work(fakeSql()));

    expect(run.days[0].failure.kind).toBe('timeout');
  });

  it('fails the day as malformed when UW sends a body that is not JSON', async () => {
    const notJson = {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    };
    stubFetch(testCase, () => notJson);

    const run = await runWorker([D1], work(fakeSql()));

    expect(run.days[0].failure.kind).toBe('malformed');
    expect(summarizeRun(run).exitCode).toBe(1);
  });

  it('fails the day as malformed when a row has no timestamp', async () => {
    stubFetch(testCase, (_item, date) => [{ date, net_call_premium: '1' }]);

    const run = await runWorker([D1], work(fakeSql()));

    expect(run.days[0].failure.kind).toBe('malformed');
    expect(run.days[0].failure.detail).toContain(`has no ${spec.rowField}`);
  });

  it('fails the day as malformed when UW sends rows and none is usable for the day, names the source, and still tries the other items', async () => {
    // UW ignores ?date= for the first item and answers another ET day.
    const [first] = items;
    stubFetch(testCase, (item, date) =>
      item === first ? testCase.answer(5, D2) : testCase.answer(2, date),
    );
    const sql = fakeSql();

    const run = await runWorker([D1], work(sql));

    expect(run.days[0].ok).toBe(false);
    expect(run.days[0].failure.kind).toBe('malformed');
    expect(run.days[0].failure.detail).toContain(
      `1 of ${items.length} ${spec.itemLabel} failed`,
    );
    expect(run.days[0].failure.detail).toContain(`first (${first})`);
    expect(run.days[0].failure.detail).toContain(
      `UW sent 5 rows for ${sources[0]}, none usable for ${D1}`,
    );
    // Not a healthy day with kept 0 and dropped 5: the failed item wrote
    // nothing, the others still did.
    expect(sql.query).toHaveBeenCalledTimes(items.length - 1);
    expect(sql.query.mock.calls.map(([, v]) => v[2])).not.toContain(sources[0]);
    expect(summarizeRun(run).exitCode).toBe(1);
  });

  it('fails the day as malformed when ten rows have every premium at zero, and writes nothing for that item', async () => {
    const [first] = items;
    stubFetch(testCase, (item, date) =>
      item === first ? testCase.zero(10, date) : testCase.answer(2, date),
    );
    const sql = fakeSql();

    const run = await runWorker([D1], work(sql));

    expect(run.days[0].failure.kind).toBe('malformed');
    expect(run.days[0].failure.detail).toContain(`first (${first})`);
    expect(run.days[0].failure.detail).toContain(
      `${sources[0]} for ${D1}: 10 rows and every premium is zero`,
    );
    expect(sql.query).toHaveBeenCalledTimes(items.length - 1);
    expect(sql.query.mock.calls.map(([, v]) => v[2])).not.toContain(sources[0]);
    expect(summarizeRun(run).exitCode).toBe(1);
  });

  it('takes nine all-zero rows as a quiet item, and a single call or put premium among many zero rows as data', async () => {
    const [first] = items;
    // Eleven zero rows, then a last row with one premium in it.
    const withLast = (date, field) =>
      testCase
        .zero(12, date)
        .map((row, i) => (i === 11 ? { ...row, [field]: '500.00' } : row));
    stubFetch(testCase, (item, date) => {
      if (item !== first) return testCase.answer(2, date);
      if (date === D1) return testCase.zero(9, date);
      return withLast(
        date,
        date === D2 ? 'net_call_premium' : 'net_put_premium',
      );
    });
    const sql = fakeSql();

    const run = await runWorker([D1, D2, D3], work(sql));

    expect(run.days.map((d) => d.ok)).toEqual([true, true, true]);
    // Each day wrote the first item: 9 rows, then 12, then 12.
    const firstWrites = sql.query.mock.calls.filter(
      ([, v]) => v[2] === sources[0],
    );
    // Six values a row; a statement that logs to the revision log has the
    // writer after them (ETF tide).
    expect(firstWrites.map(([, v]) => Math.floor(v.length / 6))).toEqual([
      9, 12, 12,
    ]);
  });

  it('fails the day as db when the write rejects, says which item, and exits 1: no warn-and-carry-on', async () => {
    stubFetch(testCase, everyItem(2));
    const sql = {
      query: vi.fn(async () => {
        throw new Error('permission denied for table flow_data');
      }),
    };

    const run = await runWorker([D1], work(sql));

    expect(run.days[0].failure.kind).toBe('db');
    expect(run.days[0].failure.detail).toContain(
      `${items.length} of ${items.length} ${spec.itemLabel} failed`,
    );
    expect(run.days[0].failure.detail).toContain(
      'permission denied for table flow_data',
    );
    const { lines, exitCode } = summarizeItemRun(
      run,
      items.length,
      spec.itemLabel,
      'rows',
    );
    expect(exitCode).toBe(1);
    expect(lines).toContain('failures by kind:');
    expect(lines.some((l) => l.startsWith('  db: 1 day'))).toBe(true);
  });

  it('carries on after a failed day: the next day still runs and writes', async () => {
    stubFetch(testCase, (_item, date) =>
      date === D1
        ? jsonResponse({}, { ok: false, status: 404 })
        : testCase.answer(2, date),
    );
    const sql = fakeSql();

    const run = await runWorker([D1, D2], work(sql));

    expect(run.days.map((d) => d.ok)).toEqual([false, true]);
    expect(run.days[0].failure.kind).toBe('uw_http_404');
    expect(sql.query).toHaveBeenCalledTimes(items.length);
    expect(sql.query.mock.calls[0][1][0]).toBe(D2);
    expect(summarizeRun(run).exitCode).toBe(1);
  });

  it('drops what is not that ET day and counts it, so kept + dropped is what UW sent', async () => {
    stubFetch(testCase, (_item, date) => [
      ...testCase.answer(2, date),
      ...testCase.answer(1, D2),
    ]);
    const sql = fakeSql();

    const run = await runWorker([D1], work(sql));

    expect(run.days[0].value).toMatchObject({
      fetched: 3 * items.length,
      dropped: items.length,
      kept: 2 * items.length,
      stored: 2 * items.length,
    });
  });
});

describe('processFlowDay: a net-flow total that leaves its column', () => {
  const netFlow = CASES.find((c) => c.name === 'net flow');

  beforeEach(() => atTime(TODAY, ['Date', 'setTimeout']));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fails the day as malformed naming the source and the first bad minute, stores nothing for that ticker, and still stores the others', async () => {
    // One corrupt tick in the middle of the SPX day.
    stubFetch(netFlow, (item, date) =>
      item === 'SPX'
        ? ticks(3, date).map((tick, i) =>
            i === 1 ? { ...tick, net_call_premium: '1e13' } : tick,
          )
        : netFlow.answer(2, date),
    );
    const sql = fakeSql();

    const run = await runWorker([D1], (date) =>
      processFlowDay(
        date,
        { apiKey: 'uw-key-for-tests', sql, dryRun: false, waitForSlot: noWait },
        NET_FLOW,
      ),
    );

    expect(run.days[0].ok).toBe(false);
    expect(run.days[0].failure.kind).toBe('malformed');
    expect(run.days[0].failure.detail).toContain('1 of 3 tickers failed');
    expect(run.days[0].failure.detail).toContain('first (SPX)');
    expect(run.days[0].failure.detail).toContain('spx_flow for 2026-08-12');
    expect(run.days[0].failure.detail).toContain('2026-08-12T13:35:00.000Z');
    // SPY and QQQ were written; SPX was not, and no row of it was dropped one
    // by one to get the rest through.
    expect(sql.query.mock.calls.map(([, v]) => v[2])).toEqual([
      'spy_flow',
      'qqq_flow',
    ]);
    expect(summarizeRun(run).exitCode).toBe(1);
  });
});

// ── The revision log ───────────────────────────────────────

describe('the revision log (spec P0.8)', () => {
  const etf = CASES.find((c) => c.name === 'ETF tide');

  beforeEach(() => atTime(TODAY, ['Date', 'setTimeout']));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const write = async (testCase) => {
    stubFetch(testCase, (_item, date) => testCase.answer(2, date));
    const sql = fakeSql();
    const run = await runWorker([D1], (date) =>
      processFlowDay(
        date,
        { apiKey: 'uw-key-for-tests', sql, dryRun: false, waitForSlot: noWait },
        testCase.spec,
      ),
    );
    return { sql, run };
  };

  it('names the flow_data target and the log table, and keeps the key', () => {
    expect(loggedFlowDataTarget('some-script')).toEqual({
      ...FLOW_DATA_TARGET,
      revisionLog: { table: 'flow_data_revisions', writer: 'some-script' },
    });
    expect(FLOW_DATA_TARGET).not.toHaveProperty('revisionLog');
  });

  it('logs the ETF tide rows it inserts to flow_data_revisions, in the same statement, under its own name', async () => {
    const { sql, run } = await write(etf);

    expect(run.days[0].ok).toBe(true);
    expect(sql.query).toHaveBeenCalledTimes(2);
    for (const [text, values] of sql.query.mock.calls) {
      expect(text).toMatch(/^WITH ins AS \(INSERT INTO flow_data /);
      expect(text).toContain(
        'ON CONFLICT (date, timestamp, source) DO NOTHING',
      );
      expect(text).toContain('INSERT INTO flow_data_revisions');
      // 2 rows of 6 values, then the writer.
      expect(values).toHaveLength(13);
      expect(values.at(-1)).toBe('backfill-etf-tide');
    }
  });

  it.each(['market tide', 'net flow'])(
    'does not log %s: it is a first-write-wins source outside the log',
    async (name) => {
      const { sql } = await write(CASES.find((c) => c.name === name));

      for (const [text, values] of sql.query.mock.calls) {
        expect(text).not.toContain('flow_data_revisions');
        expect(values.length % 6).toBe(0);
      }
    },
  );
});

// ── The two inline scripts: sample a day, store it once ────

describe('sampleFiveMinuteRows and storeSampledDay (the two inline scripts)', () => {
  const tickAt = (hhmmss, extra = {}) => ({
    timestamp: `2026-03-24T${hhmmss}Z`,
    ...extra,
  });
  const valueOf = (tick) => ({
    ncp: tick.a,
    npp: tick.b,
    net_volume: tick.c,
  });
  const options = (totals = { failed: 0 }) => ({
    date: D1,
    source: 'zero_dte_index',
    writer: 'backfill-zero-dte-flow',
    valueOf,
    totals,
  });
  /** `n` one-minute ticks from 13:30Z, values naming their minute. */
  const minuteTicks = (n) =>
    Array.from({ length: n }, (_, i) =>
      tickAt(
        `${String(13 + Math.floor((30 + i) / 60)).padStart(2, '0')}:${String(
          (30 + i) % 60,
        ).padStart(2, '0')}:00`,
        { a: `a${i}`, b: `b${i}`, c: i },
      ),
    );

  afterEach(() => vi.restoreAllMocks());

  it('keeps the last tick of each 5-minute window, stamped at the window start, in the order the windows appear', () => {
    const rows = sampleFiveMinuteRows(
      [
        tickAt('13:31:00', { a: 'first', b: 'x', c: 1 }),
        tickAt('13:34:00', { a: 'last', b: 'y', c: 2 }),
        tickAt('13:36:00', { a: 'next', b: 'z', c: 3 }),
      ],
      options(),
    );

    expect(rows).toEqual([
      {
        date: D1,
        timestamp: '2026-03-24T13:30:00.000Z',
        source: 'zero_dte_index',
        ncp: 'last',
        npp: 'y',
        net_volume: 2,
      },
      {
        date: D1,
        timestamp: '2026-03-24T13:35:00.000Z',
        source: 'zero_dte_index',
        ncp: 'next',
        npp: 'z',
        net_volume: 3,
      },
    ]);
  });

  it('floors a window to the epoch-aligned 5 minutes, also on the day the clocks fall back (2026-11-01)', () => {
    // 07:07Z is 03:07 EDT, an hour into the repeated 01:00-02:00 hour; the
    // window is epoch-aligned (300 s), not a wall-clock one.
    const rows = sampleFiveMinuteRows(
      [{ timestamp: '2026-11-01T07:07:00Z', a: 'x', b: 'y', c: 1 }],
      { ...options(), date: '2026-11-01' },
    );

    expect(rows.map((r) => r.timestamp)).toEqual(['2026-11-01T07:05:00.000Z']);
  });

  it('writes a whole day with ONE statement, not one per candle (R5)', async () => {
    // 390 minutes is 78 windows.
    const sql = fakeSql();

    const result = await storeSampledDay(sql, minuteTicks(390), options());

    expect(result).toEqual({ stored: 78, sampled: 78 });
    expect(sql.query).toHaveBeenCalledTimes(1);
    const [text, values] = sql.query.mock.calls[0];
    expect(text).toContain('INSERT INTO flow_data_revisions');
    // 78 rows of six values, then the writer.
    expect(values).toHaveLength(78 * 6 + 1);
    expect(values.at(-1)).toBe('backfill-zero-dte-flow');
  });

  it('writes nothing for a day with no ticks', async () => {
    const sql = fakeSql();

    expect(await storeSampledDay(sql, [], options())).toEqual({
      stored: 0,
      sampled: 0,
    });
    expect(sql.query).not.toHaveBeenCalled();
  });

  it('counts a failed insert, prints it and does not throw, so the script can exit non-zero', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const totals = { failed: 0 };
    const sql = {
      query: vi.fn(async () => {
        throw new Error('relation "flow_data_revisions" does not exist');
      }),
    };

    const result = await storeSampledDay(sql, minuteTicks(10), options(totals));

    expect(result).toEqual({ stored: 0, sampled: 2 });
    expect(totals.failed).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Insert error: relation "flow_data_revisions"'),
    );
  });

  it('adds a failure per failed day and none for a day that wrote', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const totals = { failed: 0 };
    const failing = {
      query: vi.fn(async () => Promise.reject(new Error('x'))),
    };

    await storeSampledDay(fakeSql(), minuteTicks(10), options(totals));
    expect(totals.failed).toBe(0);
    await storeSampledDay(failing, minuteTicks(10), options(totals));
    await storeSampledDay(failing, minuteTicks(10), options(totals));
    expect(totals.failed).toBe(2);
  });
});

// Each test below spawns node: Windows process spawn under full-suite load is
// slow, so the spawn and the test share one generous limit.
const SPAWN_TIMEOUT = 60_000;

/**
 * The two scripts run end to end as child processes, with the network replaced
 * by inline-backfill-stub.mjs (UW answers a canned day; the database answers
 * like Postgres, or refuses with a missing-table error). The exit code and the
 * number of statements cannot be seen any other way: the scripts run on import.
 */
describe(
  'the inline backfill scripts, run end to end',
  { timeout: SPAWN_TIMEOUT },
  () => {
    const SCRIPTS = [
      {
        file: 'backfill-greek-flow.mjs',
        writer: 'backfill-greek-flow',
        failedLine: /Insert failures: 1/,
      },
      {
        file: 'backfill-zero-dte-flow.mjs',
        writer: 'backfill-zero-dte-flow',
        failedLine: /Failed \(API \+ insert errors\): 1/,
      },
    ];

    function run(file, sqlMode) {
      const clean = { ...process.env };
      delete clean.SENTRY_DSN;
      return spawnSync(
        process.execPath,
        [
          '--import',
          // A file URL: on Windows node rejects a bare absolute path here.
          pathToFileURL(
            path.resolve(
              process.cwd(),
              'scripts/_lib/inline-backfill-stub.mjs',
            ),
          ).href,
          path.resolve(process.cwd(), 'scripts', file),
          '1',
        ],
        {
          env: {
            ...clean,
            UW_API_KEY: 'uw-key-for-tests',
            DATABASE_URL: 'postgresql://user:pass@db.invalid/db',
            STUB_SQL: sqlMode,
          },
          encoding: 'utf8',
          timeout: SPAWN_TIMEOUT,
        },
      );
    }
    const statements = (result) =>
      result.stderr.split('\n').filter((line) => line.startsWith('sql '));

    it.each(SCRIPTS)(
      '$file stores a day with one logged statement under its own name and exits 0',
      ({ file, writer }) => {
        const result = run(file, 'ok');

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('10 ticks → 2 candles (2 new)');
        // One statement for the day, not one per candle: 2 rows of six values,
        // then the writer.
        expect(statements(result)).toEqual([`sql 13 ${writer}`]);
      },
    );

    it.each(SCRIPTS)(
      '$file exits 1 and says so when the insert fails (R4), not 0 with "Newly stored: 0"',
      ({ file, failedLine }) => {
        const result = run(file, 'error');

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          'Insert error: relation "flow_data_revisions" does not exist',
        );
        expect(result.stdout).toContain('Newly stored: 0');
        expect(result.stdout).toMatch(failedLine);
        // The failed day made one attempt, not one per candle.
        expect(statements(result)).toHaveLength(1);
      },
    );

    it('the stub throws on any host but Unusual Whales and the test database (no real network from a child process)', () => {
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(
            path.resolve(
              process.cwd(),
              'scripts/_lib/inline-backfill-stub.mjs',
            ),
          ).href,
          '-e',
          "fetch('https://example.com/x').catch((e) => { console.error(e.message); process.exit(3); })",
        ],
        { encoding: 'utf8', timeout: SPAWN_TIMEOUT },
      );

      expect(result.status).toBe(3);
      expect(result.stderr).toContain('unexpected host example.com');
    });
  },
);

// ── The flags ──────────────────────────────────────────────

describe('planFlowDays', () => {
  beforeEach(() => atTime(TODAY));
  afterEach(() => vi.useRealTimers());

  it('plans the trading days of the range', () => {
    const { dates } = planFlowDays([
      '--from',
      '2026-07-22',
      '--to',
      '2026-07-24',
      '--limit',
      '2',
    ]);
    expect(dates).toEqual(['2026-07-22', '2026-07-23']);
  });

  it.each([
    [[], '--from and --to are required: the flow_data backfills'],
    // The positional lookback N of the old scripts is not a flag any more.
    [['30'], 'Unknown argument: 30'],
    [['--from', D1, '--to', D1, 'SPY'], 'Unknown argument: SPY'],
    [['--from', '2026-11-05', '--to', '2026-11-06'], 'not a finished day'],
  ])('rejects %j', (argv, message) => {
    expect(() => planFlowDays(argv)).toThrow(message);
  });
});

// ── The script runner, in process ──────────────────────────

describe('runFlowScript', () => {
  const DB_URL = 'postgresql://user:p4ssw0rdxyz@db.example.test/neondb';
  const savedArgv = process.argv;
  const savedExitCode = process.exitCode;

  class ExitSignal extends Error {
    constructor(code) {
      super(`exit ${code}`);
      this.code = code;
    }
  }

  let out;
  let err;
  const printed = () => out.mock.calls.map(([line]) => line).join('\n');

  function run(args) {
    process.argv = ['node', 'script.mjs', ...args];
    return runFlowScript(MARKET_TIDE);
  }

  beforeEach(() => {
    out = vi.spyOn(console, 'log').mockImplementation(() => {});
    err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(code);
    });
    vi.stubEnv('UW_API_KEY', 'uw-key-for-tests');
    vi.stubEnv('DATABASE_URL', DB_URL);
    neonMock.mockReset().mockReturnValue({ query: sqlQuery });
    sqlQuery
      .mockReset()
      .mockImplementation(async (_text, values) =>
        Array.from({ length: values.length / 6 }, (_, i) => ({ id: i })),
      );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: tideRows(3) })),
    );
  });

  afterEach(() => {
    process.argv = savedArgv;
    process.exitCode = savedExitCode;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('prints the plan, each day and the totals, writes through the Neon client, and leaves exit code 0', async () => {
    await run(['--from', D1, '--to', D1, '--allow-market-hours']);

    expect(neonMock).toHaveBeenCalledWith(DB_URL);
    expect(sqlQuery).toHaveBeenCalledTimes(2);
    const text = printed();
    expect(text).toContain('Backfilling flow_data market tide');
    expect(text).not.toContain('DRY RUN');
    expect(text).toContain('1 trading days, 2026-08-12 → 2026-08-12');
    expect(text).toContain('days: 1 run, 1 done, 0 failed');
    expect(text).toContain(
      '  2026-08-12  fetched 6  stored 6  kept 6  dropped 0  emptyItems 0',
    );
    expect(process.exitCode).toBe(0);
  });

  it('on a dry run needs no database URL, builds no client, and says stored 0 is by design', async () => {
    vi.stubEnv('DATABASE_URL', '');

    await run(['--from', D1, '--to', D1, '--allow-market-hours', '--dry-run']);

    expect(neonMock).not.toHaveBeenCalled();
    expect(sqlQuery).not.toHaveBeenCalled();
    const text = printed();
    expect(text).toContain('(DRY RUN: no writes)');
    expect(text).toContain('fetched 6  stored 0  kept 6');
    expect(text).toContain('dry run: stored is 0 by design');
    expect(process.exitCode).toBe(0);
  });

  it('exits 1 when a write fails, and prints the failure with the connection string redacted', async () => {
    sqlQuery.mockRejectedValue(
      new Error(`password authentication failed for ${DB_URL}`),
    );

    await run(['--from', D1, '--to', D1, '--allow-market-hours']);

    expect(process.exitCode).toBe(1);
    const text = printed();
    expect(text).toContain('days: 1 run, 0 done, 1 failed');
    expect(text).toContain('failures by kind:');
    expect(text).toContain('  db: 1 day (2026-08-12)');
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('p4ssw0rdxyz');
    expect(text).not.toContain(DB_URL);
  });

  it('scrubs the UW key and the database URL from every line it prints, not only from failure details', async () => {
    process.argv = [
      'node',
      'script.mjs',
      ...['--from', D1, '--to', D1, '--allow-market-hours', '--dry-run'],
    ];

    await runFlowScript({
      ...MARKET_TIDE,
      title: `leaky uw-key-for-tests ${DB_URL}`,
    });

    expect(out.mock.calls[0][0]).toBe(
      'Backfilling leaky [redacted] [redacted] (DRY RUN: no writes)',
    );
    expect(printed()).not.toContain('uw-key-for-tests');
    expect(printed()).not.toContain('p4ssw0rdxyz');
  });

  it('prints "backfill aborted" with the connection string scrubbed, and exits 1, when the Neon client cannot be built', async () => {
    neonMock.mockImplementation(() => {
      throw new Error(`invalid connection string ${DB_URL}`);
    });

    await run(['--from', D1, '--to', D1, '--allow-market-hours']);

    expect(process.exitCode).toBe(1);
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toBe(
      'backfill aborted: invalid connection string [redacted]',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exits 1 when a day fails at UW, and says which kind', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, { ok: false, status: 404 })),
    );

    await run(['--from', D1, '--to', D1, '--allow-market-hours']);

    expect(process.exitCode).toBe(1);
    expect(printed()).toContain('  uw_http_404: 1 day (2026-08-12)');
    expect(sqlQuery).not.toHaveBeenCalled();
  });

  it('refuses 08:15–15:30 CT on a weekday with exit 3, before the env, the client or the network', async () => {
    // 18:00Z on Wednesday 2026-11-04 is 12:00 CT.
    atTime('2026-11-04T18:00:00Z');

    await expect(run(['--from', D1, '--to', D1])).rejects.toMatchObject({
      code: 3,
    });

    expect(err.mock.calls[0][0]).toContain('Refusing to run 08:15–15:30 CT');
    expect(neonMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exits 2 and names the flag when the flags do not parse', async () => {
    await expect(run(['--from', D1])).rejects.toMatchObject({ code: 2 });
    expect(err.mock.calls[0][0]).toContain('--from and --to go together');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exits 1 naming a missing UW key or database URL', async () => {
    vi.stubEnv('UW_API_KEY', '');
    await expect(
      run(['--from', D1, '--to', D1, '--allow-market-hours']),
    ).rejects.toMatchObject({ code: 1 });
    expect(err.mock.calls.at(-1)[0]).toContain('Missing UW_API_KEY');

    vi.stubEnv('UW_API_KEY', 'uw-key-for-tests');
    vi.stubEnv('DATABASE_URL', '');
    await expect(
      run(['--from', D1, '--to', D1, '--allow-market-hours']),
    ).rejects.toMatchObject({ code: 1 });
    expect(err.mock.calls.at(-1)[0]).toContain('Missing DATABASE_URL');
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── The scripts' own flags and env, through plain node ─────

describe(
  'the flow_data scripts exit before any network on bad flags or a missing key',
  { timeout: SPAWN_TIMEOUT },
  () => {
    const scripts = [
      path.resolve(process.cwd(), 'scripts', 'backfill-local.mjs'),
      path.resolve(process.cwd(), 'scripts', 'backfill-etf-tide.mjs'),
      path.resolve(process.cwd(), 'scripts', 'backfill-netflow.mjs'),
    ];

    function runCli(script, args, env = {}) {
      const clean = { ...process.env };
      delete clean.UW_API_KEY;
      delete clean.DATABASE_URL;
      return spawnSync(process.execPath, [script, ...args], {
        env: { ...clean, ...env },
        encoding: 'utf8',
      });
    }

    it.each(scripts)('%s needs a range', (script) => {
      const result = runCli(script, []);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('--from and --to are required');
    });

    it.each(scripts)(
      '%s no longer takes the positional day count',
      (script) => {
        const result = runCli(script, ['30']);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('Unknown argument: 30');
      },
    );

    it.each(scripts)('%s refuses half a range', (script) => {
      const result = runCli(script, ['--from', '2026-07-22']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('--from and --to go together');
    });

    it.each(scripts)('%s exits 1 naming the missing UW key', (script) => {
      const result = runCli(script, [
        '--from',
        D1,
        '--to',
        D1,
        '--allow-market-hours',
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Missing UW_API_KEY');
    });

    it.each(scripts)(
      '%s exits 1 naming the missing database URL unless it is a dry run',
      (script) => {
        const result = runCli(
          script,
          ['--from', D1, '--to', D1, '--allow-market-hours'],
          { UW_API_KEY: 'uw-key-for-tests' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Missing DATABASE_URL');
      },
    );
  },
);
