// @vitest-environment node

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classifyFailure, runDays, summarizeRun } from './backfill-cli.mjs';
import {
  ETF_TARGET,
  ETF_TICKERS,
  INDEX_TARGET,
  INDEXES,
  UW_CANDLE_LIMIT,
  UW_USER_AGENT,
  WRITE_BATCH,
  fetchSchwabDailyCloses,
  fetchUwCandles,
  loadSchwabCloses,
  planCandleDays,
  processEtfDay,
  processIndexDay,
  ratioFor,
  ratioLines,
  storeCandleRows,
  toEtfRows,
  toIndexRows,
} from './candles-backfill.mjs';

// 2026-11-06 is a Friday, EST (UTC−5); 02:00 CT. Chosen so "today" in ET is
// 2026-11-06 and the finished days before it are plain.
const TODAY = '2026-11-06T08:00:00Z';
// 2026-08-12 and 2026-08-13 are a Wednesday and Thursday in EDT (UTC−4).
const D1 = '2026-08-12';
const D2 = '2026-08-13';
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

/** A UW 1-minute bar; prices are strings, as UW sends them. */
function bar(startTime, overrides = {}) {
  return {
    start_time: startTime,
    end_time: startTime,
    open: '637.10',
    high: '637.50',
    low: '636.90',
    close: '637.30',
    volume: 1200,
    total_volume: 99999,
    market_time: 'r',
    ...overrides,
  };
}

/** `n` consecutive regular-session bars from 13:30Z on `date` (EDT). */
function bars(n, date = D1, overrides = {}) {
  const open = Date.parse(`${date}T13:30:00Z`);
  return Array.from({ length: n }, (_, i) =>
    bar(new Date(open + i * 60_000).toISOString(), overrides),
  );
}

// ── Schwab fixtures ────────────────────────────────────────

/** Midnight CDT/EDT-ish: 05:00Z on the date. Schwab's daily candle stamp. */
function dailyCandle(date, close) {
  return {
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    datetime: Date.parse(`${date}T05:00:00Z`),
  };
}

/**
 * Daily closes for the four symbols the ratio needs, by date. These are
 * made-up numbers for the tests; nothing here is a real close.
 */
const FIXTURE_CLOSES = {
  [D1]: { $SPX: 6401.28, SPY: 637.14, $NDX: 23510.5, QQQ: 573.2 },
  [D2]: { $SPX: 6455.92, SPY: 642.55, $NDX: 23688.1, QQQ: 577.0 },
};

function schwabClosesMap(overrides = {}) {
  const closes = new Map();
  for (const symbol of ['$SPX', 'SPY', '$NDX', 'QQQ']) {
    closes.set(symbol, {
      closes: new Map(
        Object.entries(FIXTURE_CLOSES).map(([date, row]) => [
          date,
          row[symbol],
        ]),
      ),
    });
  }
  for (const [symbol, entry] of Object.entries(overrides)) {
    closes.set(symbol, entry);
  }
  return closes;
}

/** An Upstash stand-in holding a good token, so no refresh happens. */
function fakeRedis() {
  return {
    get: vi.fn(async () => ({
      accessToken: 'schwab-access',
      refreshToken: 'schwab-refresh',
      expiresAt: Date.now() + 20 * 60_000,
      refreshExpiresAt: Date.now() + 3 * 86_400_000,
    })),
    eval: vi.fn(),
  };
}

// ── DB fixture ─────────────────────────────────────────────

/**
 * A sql handle whose query() answers like Postgres' RETURNING id: one row per
 * row inserted, minus `conflicts` rows that ON CONFLICT DO NOTHING skipped.
 */
function fakeSql({ conflicts = 0, columns = 7 } = {}) {
  return {
    query: vi.fn(async (_text, values) =>
      Array.from(
        { length: Math.max(0, values.length / columns - conflicts) },
        (_, i) => ({ id: i }),
      ),
    ),
  };
}

// ── args ───────────────────────────────────────────────────

describe('planCandleDays', () => {
  beforeEach(() => atTime(TODAY));
  afterEach(() => vi.useRealTimers());

  it('plans the trading days of the range, holidays skipped', () => {
    // 2026-09-07 is Labor Day.
    const { args, dates } = planCandleDays([
      '--from',
      '2026-09-03',
      '--to',
      '2026-09-08',
    ]);
    expect(dates).toEqual(['2026-09-03', '2026-09-04', '2026-09-08']);
    expect(args).toMatchObject({ dryRun: false, allowMarketHours: false });
  });

  it('keeps the first N trading days for --limit, in ascending order', () => {
    const { dates } = planCandleDays([
      '--from',
      '2026-07-22',
      '--to',
      '2026-09-04',
      '--limit',
      '3',
    ]);
    expect(dates).toEqual(['2026-07-22', '2026-07-23', '2026-07-24']);
  });

  it('reads --dry-run and --allow-market-hours', () => {
    const { args } = planCandleDays([
      '--from',
      D1,
      '--to',
      D1,
      '--dry-run',
      '--allow-market-hours',
    ]);
    expect(args).toMatchObject({ dryRun: true, allowMarketHours: true });
  });

  it.each([
    [[], '--from and --to are required'],
    [['--dry-run'], '--from and --to are required'],
    [['--from', D1], '--from and --to go together'],
    [['--to', D1], '--from and --to go together'],
    [['--from', D2, '--to', D1], 'is after --to'],
    [['--from', D1, '--to', D1, '--days', '5'], 'Unknown argument'],
    // The positional N of the old etf script is not a flag any more.
    [['5'], 'Unknown argument'],
    [['--from', D1, '--to', D1, '--limit', '0'], '--limit'],
    [
      ['--from', '2026-09-05', '--to', '2026-09-07'],
      'no trading days between --from 2026-09-05 and --to 2026-09-07',
    ],
  ])('rejects %j', (argv, message) => {
    expect(() => planCandleDays(argv)).toThrow(message);
  });

  it('refuses a range that reaches today: the live crons own the unfinished day', () => {
    expect(() =>
      planCandleDays(['--from', '2026-11-05', '--to', '2026-11-06']),
    ).toThrow('--to 2026-11-06 is not a finished day (today is 2026-11-06 ET)');
    expect(
      planCandleDays(['--from', '2026-11-05', '--to', '2026-11-05']).dates,
    ).toEqual(['2026-11-05']);
  });

  it('late in the evening CT, already the next day in ET and UTC, the day that just ended is finished and the new one is not', () => {
    // 23:30 CT on the 5th is 00:30 ET on the 6th.
    atTime('2026-11-06T05:30:00Z');
    expect(
      planCandleDays(['--from', '2026-11-05', '--to', '2026-11-05']).dates,
    ).toEqual(['2026-11-05']);
    expect(() =>
      planCandleDays(['--from', '2026-11-05', '--to', '2026-11-06']),
    ).toThrow(/is after today|not a finished day/);
  });
});

// ── Schwab daily closes ────────────────────────────────────

describe('fetchSchwabDailyCloses', () => {
  beforeEach(() => atTime(TODAY));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('asks for daily candles of the symbol over the padded range, with the token', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ candles: [dailyCandle(D1, 6401.28)], symbol: '$SPX' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchSchwabDailyCloses('tok', '$SPX', D1, D2);

    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      'https://api.schwabapi.com/marketdata/v1/pricehistory',
    );
    expect(url).toContain('symbol=%24SPX');
    expect(parsed.searchParams.get('periodType')).toBe('year');
    expect(parsed.searchParams.get('frequencyType')).toBe('daily');
    expect(parsed.searchParams.get('frequency')).toBe('1');
    // Two days of padding either side of [from 00:00Z, to 23:59:59Z].
    expect(Number(parsed.searchParams.get('startDate'))).toBe(
      Date.parse(`${D1}T00:00:00Z`) - 2 * 86_400_000,
    );
    expect(Number(parsed.searchParams.get('endDate'))).toBe(
      Date.parse(`${D2}T23:59:59Z`) + 2 * 86_400_000,
    );
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('never asks past now', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ candles: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchSchwabDailyCloses('tok', 'SPY', '2026-11-04', '2026-11-05');

    const endDate = Number(
      new URL(fetchMock.mock.calls[0][0]).searchParams.get('endDate'),
    );
    expect(endDate).toBe(Date.now());
  });

  it('keys each close on the ET date of the candle stamp, whichever midnight Schwab uses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          candles: [
            // Midnight CDT (05:00Z), midnight EDT (04:00Z), midnight CST
            // (06:00Z): all 01:00 or 00:00 ET on the day itself.
            { ...dailyCandle(D1, 1), datetime: Date.parse(`${D1}T05:00:00Z`) },
            { ...dailyCandle(D2, 2), datetime: Date.parse(`${D2}T04:00:00Z`) },
            {
              ...dailyCandle('2026-11-04', 3),
              datetime: Date.parse('2026-11-04T06:00:00Z'),
            },
          ],
        }),
      ),
    );

    const closes = await fetchSchwabDailyCloses('tok', 'SPY', D1, '2026-11-04');

    expect([...closes]).toEqual([
      [D1, 1],
      [D2, 2],
      ['2026-11-04', 3],
    ]);
  });

  it('reads the stamp as an ET date, the way fetch-outcomes.ts does: 03:30Z is still the evening before', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          candles: [
            { ...dailyCandle(D1, 7), datetime: Date.parse(`${D2}T03:30:00Z`) },
          ],
        }),
      ),
    );

    const closes = await fetchSchwabDailyCloses('tok', 'SPY', D1, D2);

    expect([...closes]).toEqual([[D1, 7]]);
  });

  it('leaves out a candle with no usable close', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          candles: [
            dailyCandle(D1, 6401.28),
            { ...dailyCandle(D2, 0) },
            { ...dailyCandle('2026-08-14', null) },
            { ...dailyCandle('2026-08-17', 'abc') },
          ],
        }),
      ),
    );

    const closes = await fetchSchwabDailyCloses(
      'tok',
      '$SPX',
      D1,
      '2026-08-17',
    );

    expect([...closes.keys()]).toEqual([D1]);
  });

  it('reads an empty answer as no closes, not an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ candles: [], empty: true })),
    );
    const closes = await fetchSchwabDailyCloses('tok', '$NDX', D1, D2);
    expect(closes.size).toBe(0);
  });

  it('throws on an HTTP error, naming the status and masking token-like text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized abcdefghijklmnopqrstuvwxyz012345',
      })),
    );

    const err = await fetchSchwabDailyCloses('tok', '$SPX', D1, D2).catch(
      (e) => e,
    );

    expect(err.message).toContain('pricehistory $SPX');
    expect(err.message).toContain('HTTP 401');
    expect(err.message).toContain('Unauthorized [redacted]');
    expect(err.message).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
  });

  it('throws a SyntaxError when the body has no candles array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ symbol: '$SPX' })),
    );
    const err = await fetchSchwabDailyCloses('tok', '$SPX', D1, D2).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(SyntaxError);
    expect(err.message).toContain('no candles array');
  });

  it('throws a SyntaxError when a candle lands on a non-trading day: the datetime mapping is off', async () => {
    // Midnight UTC of a Monday is Sunday 20:00 in New York.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          candles: [
            {
              ...dailyCandle(D1, 1),
              datetime: Date.parse('2026-08-10T00:00:00Z'),
            },
          ],
        }),
      ),
    );
    const err = await fetchSchwabDailyCloses('tok', '$SPX', D1, D2).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(SyntaxError);
    expect(err.message).toContain('2026-08-09');
    expect(err.message).toContain('not a trading day');
  });
});

describe('loadSchwabCloses', () => {
  beforeEach(() => atTime(TODAY));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const creds = { clientId: 'id', clientSecret: 'secret' };

  /** pricehistory answers by symbol; the closes are FIXTURE_CLOSES. */
  function schwabFetch(failFor = {}) {
    return vi.fn(async (url) => {
      const symbol = new URL(url).searchParams.get('symbol');
      if (failFor[symbol]) return failFor[symbol];
      return jsonResponse({
        candles: Object.entries(FIXTURE_CLOSES).map(([date, row]) =>
          dailyCandle(date, row[symbol]),
        ),
      });
    });
  }

  it('fetches the four symbols one call each', async () => {
    const fetchMock = schwabFetch();
    vi.stubGlobal('fetch', fetchMock);

    const closes = await loadSchwabCloses(fakeRedis(), creds, D1, D2);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect([...closes.keys()]).toEqual(['$SPX', 'SPY', '$NDX', 'QQQ']);
    expect(closes.get('$SPX').closes.get(D1)).toBe(6401.28);
    expect(closes.get('QQQ').closes.get(D2)).toBe(577);
  });

  it('records one symbol failing without losing the others', async () => {
    vi.stubGlobal(
      'fetch',
      schwabFetch({
        $NDX: { ok: false, status: 503, text: async () => 'unavailable' },
      }),
    );

    const closes = await loadSchwabCloses(fakeRedis(), creds, D1, D2);

    expect(closes.get('$NDX').failure.kind).toBe('other');
    expect(closes.get('$NDX').failure.detail).toContain('HTTP 503');
    expect(closes.get('$SPX').closes.size).toBe(2);
    expect(closes.get('SPY').closes.size).toBe(2);
  });

  it('classifies a network failure and a timeout like any other thrown error', async () => {
    const down = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET' },
    });
    const slow = Object.assign(new Error('timed out'), {
      name: 'TimeoutError',
    });
    const fetchMock = vi.fn(async (url) => {
      const symbol = new URL(url).searchParams.get('symbol');
      if (symbol === '$SPX') throw down;
      if (symbol === 'SPY') throw slow;
      return jsonResponse({ candles: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const closes = await loadSchwabCloses(fakeRedis(), creds, D1, D2);

    expect(closes.get('$SPX').failure.kind).toBe('network');
    expect(closes.get('SPY').failure.kind).toBe('timeout');
  });

  it('fails all four symbols, by name, when the token cannot be had', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const redis = { get: vi.fn(async () => null), eval: vi.fn() };

    const closes = await loadSchwabCloses(redis, creds, D1, D2);

    expect(fetchMock).not.toHaveBeenCalled();
    for (const symbol of ['$SPX', 'SPY', '$NDX', 'QQQ']) {
      expect(closes.get(symbol).failure).toEqual({
        kind: 'other',
        detail: expect.stringContaining('No Schwab tokens in Redis'),
      });
    }
  });
});

// ── The per-day ratio ──────────────────────────────────────

describe('ratioFor', () => {
  it('is the index close over the ETF close for that date, not a constant', () => {
    const closes = schwabClosesMap();

    const spx1 = ratioFor(closes, 'SPX', D1);
    const spx2 = ratioFor(closes, 'SPX', D2);
    const ndx1 = ratioFor(closes, 'NDX', D1);

    expect(spx1.ratio).toBeCloseTo(6401.28 / 637.14, 10);
    expect(spx1).toMatchObject({ indexClose: 6401.28, etfClose: 637.14 });
    expect(spx2.ratio).toBeCloseTo(6455.92 / 642.55, 10);
    expect(spx1.ratio).not.toBe(spx2.ratio);
    expect(spx1.ratio).not.toBe(10);
    expect(ndx1.ratio).toBeCloseTo(23510.5 / 573.2, 10);
    expect(ndx1.ratio).not.toBe(41);
  });

  it('records three sample ratios from the fixture (for the plan note)', () => {
    const closes = schwabClosesMap();
    const sample = [
      ['SPX', D1],
      ['SPX', D2],
      ['NDX', D1],
    ].map(([symbol, date]) => ratioFor(closes, symbol, date).ratio.toFixed(4));
    expect(sample).toEqual(['10.0469', '10.0473', '41.0162']);
  });

  it('fails the day, by name, when a date has no close for the index', () => {
    const closes = schwabClosesMap();
    closes.get('$SPX').closes.delete(D2);

    const err = catchError(() => ratioFor(closes, 'SPX', D2));

    expect(err.name).toBe('DayFailure');
    expect(classifyFailure(err).kind).toBe('other');
    expect(err.message).toBe(
      `no ratio for SPX on ${D2}: Schwab has no $SPX daily close for ${D2}`,
    );
  });

  it('fails the day, by name, when a date has no close for the ETF', () => {
    const closes = schwabClosesMap();
    closes.get('QQQ').closes.delete(D1);

    const err = catchError(() => ratioFor(closes, 'NDX', D1));

    expect(classifyFailure(err).kind).toBe('other');
    expect(err.message).toContain('Schwab has no QQQ daily close');
  });

  it('never falls back to a constant: no close means no ratio', () => {
    const closes = new Map([
      ['$SPX', { closes: new Map() }],
      ['SPY', { closes: new Map() }],
      ['$NDX', { closes: new Map() }],
      ['QQQ', { closes: new Map() }],
    ]);
    for (const symbol of ['SPX', 'NDX']) {
      expect(() => ratioFor(closes, symbol, D1)).toThrow('no ratio for');
    }
  });

  it('keeps the kind of a Schwab fetch failure and says which call failed', () => {
    const closes = schwabClosesMap({
      SPY: {
        failure: { kind: 'network', detail: 'fetch failed (ECONNRESET)' },
      },
    });

    const err = catchError(() => ratioFor(closes, 'SPX', D1));

    expect(classifyFailure(err).kind).toBe('network');
    expect(err.message).toBe(
      `no ratio for SPX on ${D1}: Schwab SPY daily history failed: ` +
        'fetch failed (ECONNRESET)',
    );
  });

  it('refuses a zero or negative close', () => {
    const closes = schwabClosesMap();
    closes.get('SPY').closes.set(D1, 0);
    expect(() => ratioFor(closes, 'SPX', D1)).toThrow('no ratio for SPX');
  });
});

function catchError(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

describe('ratioLines', () => {
  it('prints each date with both ratios and the closes behind them', () => {
    const lines = ratioLines(schwabClosesMap(), [D1, D2]);
    expect(lines[0]).toContain('ratio = index close ÷ ETF close');
    expect(lines[1]).toBe(
      `  ${D1}  SPX 6401.28 ÷ SPY 637.14 = 10.046897  ` +
        'NDX 23510.5 ÷ QQQ 573.2 = 41.016225',
    );
    expect(lines).toHaveLength(3);
  });

  it('prints a date with no ratio as missing, on one line', () => {
    const closes = schwabClosesMap();
    closes.get('$NDX').closes.delete(D2);

    const lines = ratioLines(closes, [D2]);

    expect(lines.at(-1)).toContain('SPX 6455.92 ÷ SPY 642.55');
    expect(lines.at(-1)).toContain(
      `NDX NO RATIO (Schwab has no $NDX daily close for ${D2})`,
    );
    expect(lines.at(-1)).not.toContain('\n');
  });
});

// ── Bar mapping ────────────────────────────────────────────

describe('toEtfRows', () => {
  it('maps a bar to the live cron row: raw prices as sent, ISO minute, bigint volume', () => {
    const { rows, dropped } = toEtfRows('SPY', D1, [
      bar('2026-08-12T13:30:00Z'),
    ]);
    expect(dropped).toBe(0);
    expect(rows).toEqual([
      {
        ticker: 'SPY',
        timestamp: '2026-08-12T13:30:00.000Z',
        open: '637.10',
        high: '637.50',
        low: '636.90',
        close: '637.30',
        volume: 1200,
      },
    ]);
    expect(Object.keys(rows[0])).toEqual(ETF_TARGET.columns);
  });

  it('keeps pre-market and post-market bars, as the live cron does', () => {
    const { rows } = toEtfRows('QQQ', D1, [
      bar('2026-08-12T08:00:00Z', { market_time: 'pr' }),
      bar('2026-08-12T13:30:00Z'),
      bar('2026-08-12T23:59:00Z', { market_time: 'po' }),
    ]);
    expect(rows.map((r) => r.timestamp)).toEqual([
      '2026-08-12T08:00:00.000Z',
      '2026-08-12T13:30:00.000Z',
      '2026-08-12T23:59:00.000Z',
    ]);
  });

  it('keeps a bar after midnight UTC that is still the same ET day', () => {
    const { rows, dropped } = toEtfRows('SPY', WINTER, [
      bar('2026-11-05T00:30:00Z'), // 19:30 ET on the 4th
    ]);
    expect(rows).toHaveLength(1);
    expect(dropped).toBe(0);
  });

  it('writes a null volume when UW sends none, and drops a fractional one', () => {
    const noVolume = bar('2026-08-12T13:30:00Z');
    delete noVolume.volume;
    const { rows, dropped } = toEtfRows('SPY', D1, [
      noVolume,
      bar('2026-08-12T13:31:00Z', { volume: '1500' }),
      bar('2026-08-12T13:32:00Z', { volume: 12.5 }),
    ]);
    expect(rows.map((r) => r.volume)).toEqual([null, 1500]);
    expect(dropped).toBe(1);
  });

  it('sorts oldest first and keeps one bar a minute, counting the rest as dropped', () => {
    const { rows, dropped } = toEtfRows('SPY', D1, [
      bar('2026-08-12T13:31:00Z', { close: '2' }),
      bar('2026-08-12T13:30:00Z'),
      bar('2026-08-12T13:31:00Z', { close: '3' }),
    ]);
    expect(rows.map((r) => r.timestamp)).toEqual([
      '2026-08-12T13:30:00.000Z',
      '2026-08-12T13:31:00.000Z',
    ]);
    expect(rows[1].close).toBe('2');
    expect(dropped).toBe(1);
  });

  it.each([
    ['an unparseable start_time', { start_time: 'not a time' }],
    ['a non-numeric open', { open: 'n/a' }],
    ['a missing high', { high: undefined }],
    ['an empty low', { low: '  ' }],
    ['a NaN close', { close: Number.NaN }],
  ])('drops a bar with %s', (_label, overrides) => {
    const { rows, dropped } = toEtfRows('SPY', D1, [
      bar('2026-08-12T13:30:00Z', overrides),
      bar('2026-08-12T13:31:00Z'),
    ]);
    expect(rows).toHaveLength(1);
    expect(dropped).toBe(1);
  });

  it('drops a bar whose ET date is not the requested one, so a stray bar cannot land under the wrong day', () => {
    const { rows, dropped } = toEtfRows('SPY', D1, [
      bar('2026-08-11T20:00:00Z'), // the day before
      bar('2026-08-12T13:30:00Z'),
      bar('2026-08-13T08:00:00Z'), // the day after
    ]);
    expect(rows).toHaveLength(1);
    expect(dropped).toBe(2);
  });
});

describe('toIndexRows', () => {
  const ratio = 6401.28 / 637.14;

  it('multiplies every price by the ratio and writes the live cron columns', () => {
    const { rows, dropped } = toIndexRows(
      'SPX',
      D1,
      [bar('2026-08-12T13:30:00Z')],
      ratio,
    );
    expect(dropped).toBe(0);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(Object.keys(row)).toEqual(INDEX_TARGET.columns);
    expect(row).toMatchObject({
      symbol: 'SPX',
      date: D1,
      timestamp: '2026-08-12T13:30:00.000Z',
      volume: 1200,
      market_time: 'r',
    });
    expect(row.open).toBeCloseTo(637.1 * ratio, 8);
    expect(row.high).toBeCloseTo(637.5 * ratio, 8);
    expect(row.low).toBeCloseTo(636.9 * ratio, 8);
    expect(row.close).toBeCloseTo(637.3 * ratio, 8);
  });

  it('leaves both Schwab price columns NULL on every row', () => {
    const { rows } = toIndexRows(
      'NDX',
      D1,
      [
        bar('2026-08-12T13:30:00Z'),
        bar('2026-08-12T19:59:00Z'),
        bar('2026-08-12T20:00:00Z', { market_time: 'po' }),
      ],
      41,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.spx_schwab_price).toBeNull();
      expect(row.ndx_schwab_price).toBeNull();
    }
  });

  it('keeps pr, r and po bars, each with its market_time', () => {
    const { rows } = toIndexRows(
      'SPX',
      D1,
      [
        bar('2026-08-12T08:00:00Z', { market_time: 'pr' }),
        bar('2026-08-12T13:30:00Z', { market_time: 'r' }),
        bar('2026-08-12T22:00:00Z', { market_time: 'po' }),
      ],
      10,
    );
    expect(rows.map((r) => r.market_time)).toEqual(['pr', 'r', 'po']);
  });

  it.each([
    ['a market_time the table CHECK rejects', { market_time: 'rth' }],
    ['no market_time', { market_time: undefined }],
    ['no volume (volume is NOT NULL)', { volume: undefined }],
    ['a null volume', { volume: null }],
    ['a fractional volume', { volume: 10.5 }],
    ['a non-numeric price', { close: 'x' }],
    ['an unparseable start_time', { start_time: 'soon' }],
  ])('drops a bar with %s', (_label, overrides) => {
    const { rows, dropped } = toIndexRows(
      'SPX',
      D1,
      [bar('2026-08-12T13:30:00Z', overrides), bar('2026-08-12T13:31:00Z')],
      10,
    );
    expect(rows).toHaveLength(1);
    expect(dropped).toBe(1);
  });

  it('writes zero volume as zero', () => {
    const { rows } = toIndexRows(
      'SPX',
      D1,
      [bar('2026-08-12T13:30:00Z', { volume: 0 })],
      10,
    );
    expect(rows[0].volume).toBe(0);
  });

  it('drops an off-date bar and a repeated minute, so kept + dropped is every bar fetched', () => {
    const input = [
      bar('2026-08-12T13:30:00Z'),
      bar('2026-08-12T13:30:00Z'),
      bar('2026-08-13T08:00:00Z'),
      bar('2026-08-12T13:31:00Z'),
    ];
    const { rows, dropped } = toIndexRows('SPX', D1, input, 10);
    expect(rows).toHaveLength(2);
    expect(rows.length + dropped).toBe(input.length);
  });
});

// ── Writes ─────────────────────────────────────────────────

describe('storeCandleRows', () => {
  function etfRows(n) {
    return toEtfRows('SPY', D1, bars(n)).rows;
  }

  it('writes ON CONFLICT DO NOTHING on the real unique key, one statement for a small day', async () => {
    const sql = fakeSql();

    const stored = await storeCandleRows(sql, ETF_TARGET, etfRows(3), {
      dryRun: false,
    });

    expect(stored).toBe(3);
    expect(sql.query).toHaveBeenCalledTimes(1);
    const [text, values] = sql.query.mock.calls[0];
    expect(text).toContain('INSERT INTO etf_candles_1m');
    expect(text).toContain(
      '(ticker, timestamp, open, high, low, close, volume)',
    );
    expect(text).toContain('ON CONFLICT (ticker, timestamp) DO NOTHING');
    expect(text).toContain('RETURNING id');
    expect(values).toHaveLength(3 * 7);
    expect(values.slice(0, 7)).toEqual([
      'SPY',
      '2026-08-12T13:30:00.000Z',
      '637.10',
      '637.50',
      '636.90',
      '637.30',
      1200,
    ]);
    expect(text).toContain('($1, $2, $3, $4, $5, $6, $7), ($8,');
  });

  it('uses the index table key (symbol, date, timestamp) and sends the NULL anchors', async () => {
    const sql = fakeSql({ columns: 11 });
    const { rows } = toIndexRows('NDX', D1, bars(2), 41);

    await storeCandleRows(sql, INDEX_TARGET, rows, { dryRun: false });

    const [text, values] = sql.query.mock.calls[0];
    expect(text).toContain('INSERT INTO index_candles_1m');
    expect(text).toContain('ON CONFLICT (symbol, date, timestamp) DO NOTHING');
    expect(values).toHaveLength(2 * 11);
    // spx_schwab_price and ndx_schwab_price are the last two columns.
    expect(values.slice(9, 11)).toEqual([null, null]);
  });

  it('splits a day into statements of at most 500 rows', async () => {
    const sql = fakeSql();
    const [first] = etfRows(1);
    const start = Date.parse('2026-08-12T08:00:00Z');
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      ...first,
      timestamp: new Date(start + i * 60_000).toISOString(),
    }));

    const stored = await storeCandleRows(sql, ETF_TARGET, rows, {
      dryRun: false,
    });

    expect(WRITE_BATCH).toBe(500);
    expect(stored).toBe(1200);
    expect(sql.query).toHaveBeenCalledTimes(3);
    expect(sql.query.mock.calls.map(([, v]) => v.length / 7)).toEqual([
      500, 500, 200,
    ]);
  });

  it('counts only the rows ON CONFLICT let in: stored reads below kept on a partly filled day', async () => {
    const sql = fakeSql({ conflicts: 2 });
    const stored = await storeCandleRows(sql, ETF_TARGET, etfRows(5), {
      dryRun: false,
    });
    expect(stored).toBe(3);
  });

  it('reads a fullResults-shaped answer too', async () => {
    const sql = {
      query: vi.fn(async () => ({ rows: [{ id: 1 }, { id: 2 }] })),
    };
    const stored = await storeCandleRows(sql, ETF_TARGET, etfRows(2), {
      dryRun: false,
    });
    expect(stored).toBe(2);
  });

  it('writes nothing on a dry run, and nothing for an empty day', async () => {
    const sql = fakeSql();
    expect(
      await storeCandleRows(sql, ETF_TARGET, etfRows(4), { dryRun: true }),
    ).toBe(0);
    expect(await storeCandleRows(sql, ETF_TARGET, [], { dryRun: false })).toBe(
      0,
    );
    expect(sql.query).not.toHaveBeenCalled();
  });

  it('labels a rejected write as a db failure', async () => {
    const sql = {
      query: vi.fn(async () => {
        throw new Error('relation "etf_candles_1m" does not exist');
      }),
    };

    const err = await storeCandleRows(sql, ETF_TARGET, etfRows(2), {
      dryRun: false,
    }).catch((e) => e);

    expect(classifyFailure(err)).toEqual({
      kind: 'db',
      detail: 'relation "etf_candles_1m" does not exist',
    });
  });
});

// ── UW fetch ───────────────────────────────────────────────

describe('fetchUwCandles', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks UW for the ticker, date and the 2500-row cap, with the script User-Agent and key', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: bars(2) }));
    vi.stubGlobal('fetch', fetchMock);
    const waitForSlot = vi.fn(async () => {});

    const outcome = await fetchUwCandles('key', 'SPY', D1, waitForSlot);

    expect(outcome.kind).toBe('ok');
    expect(waitForSlot).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.unusualwhales.com/api/stock/SPY/ohlc/1m?date=2026-08-12&limit=2500',
    );
    expect(UW_CANDLE_LIMIT).toBe(2500);
    expect(init.headers['User-Agent']).toBe(UW_USER_AGENT);
    expect(init.headers.Authorization).toBe('Bearer key');
  });
});

// ── The day workers, through runDays ───────────────────────

/**
 * UW and Schwab answers by URL. `uw` maps a ticker to the bars UW returns for
 * it (or a response object / Error to answer with instead).
 */
function stubFetch({ uw = {} } = {}) {
  const fetchMock = vi.fn(async (url) => {
    const text = String(url);
    const match = /stock\/([A-Z]+)\/ohlc\/1m\?date=([\d-]+)/.exec(text);
    if (!match) throw new Error(`unexpected fetch ${text}`);
    const [, ticker, date] = match;
    const answer = uw[ticker];
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'function') return answer(date);
    if (answer && 'ok' in answer) return answer;
    return jsonResponse({ data: answer ?? bars(3, date) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** UW answers with `n` regular-session bars on whatever date was asked. */
const barsOnDate = (n) => (date) => jsonResponse({ data: bars(n, date) });

async function runWorker(dates, worker) {
  const pending = runDays(
    dates,
    { allowMarketHours: true, secrets: SECRETS },
    worker,
  );
  await vi.advanceTimersByTimeAsync(10_000);
  return pending;
}

describe('processEtfDay', () => {
  beforeEach(() => atTime(TODAY, ['Date', 'setTimeout']));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const ctx = (sql) => ({
    apiKey: 'uw-key-for-tests',
    sql,
    dryRun: false,
    waitForSlot: noWait,
  });

  it('fetches SPY and QQQ for the day, writes both, and counts them', async () => {
    const fetchMock = stubFetch({ uw: { SPY: bars(3), QQQ: bars(4) } });
    const sql = fakeSql();

    const run = await runWorker([D1], (date) => processEtfDay(date, ctx(sql)));

    expect(ETF_TICKERS).toEqual(['SPY', 'QQQ']);
    expect(run.days).toEqual([
      {
        date: D1,
        ok: true,
        value: { fetched: 7, stored: 7, kept: 7, dropped: 0 },
      },
    ]);
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual([
      expect.stringContaining('/stock/SPY/ohlc/1m?date=2026-08-12'),
      expect.stringContaining('/stock/QQQ/ohlc/1m?date=2026-08-12'),
    ]);
    expect(sql.query).toHaveBeenCalledTimes(2);
    expect(sql.query.mock.calls.map(([, v]) => v[0])).toEqual(['SPY', 'QQQ']);
    expect(summarizeRun(run).exitCode).toBe(0);
  });

  it('on a dry run fetches and maps but writes nothing: stored 0, kept the would-be count', async () => {
    stubFetch({ uw: { SPY: bars(3), QQQ: bars(4) } });
    const sql = fakeSql();

    const run = await runWorker([D1], (date) =>
      processEtfDay(date, { ...ctx(sql), dryRun: true }),
    );

    expect(run.days[0].value).toEqual({
      fetched: 7,
      stored: 0,
      kept: 7,
      dropped: 0,
    });
    expect(sql.query).not.toHaveBeenCalled();
  });

  it('reads the 07-22 partial day: live morning rows stay, the rest fill in', async () => {
    stubFetch({ uw: { SPY: bars(10), QQQ: bars(10) } });
    // Four minutes per ticker were already there from the live cron.
    const sql = fakeSql({ conflicts: 4 });

    const run = await runWorker([D1], (date) => processEtfDay(date, ctx(sql)));

    expect(run.days[0].value).toEqual({
      fetched: 20,
      stored: 12,
      kept: 20,
      dropped: 0,
    });
    expect(sql.query.mock.calls[0][0]).toContain('DO NOTHING');
  });

  it('reports a trading day UW has no bars for as an empty day, not a failure', async () => {
    stubFetch({ uw: { SPY: [], QQQ: [] } });
    const sql = fakeSql();

    const run = await runWorker([D1], (date) => processEtfDay(date, ctx(sql)));

    expect(run.days[0]).toMatchObject({ ok: true, value: { fetched: 0 } });
    const summary = summarizeRun(run);
    expect(summary.emptyDays).toEqual([D1]);
    expect(summary.exitCode).toBe(0);
    expect(sql.query).not.toHaveBeenCalled();
  });

  it('fails the day as uw_http_503 when UW keeps answering 503, and still tries QQQ', async () => {
    const down = jsonResponse({}, { ok: false, status: 503 });
    const fetchMock = stubFetch({ uw: { SPY: down, QQQ: bars(3) } });
    const sql = fakeSql();

    const run = await runWorker([D1], (date) => processEtfDay(date, ctx(sql)));

    expect(run.days[0].ok).toBe(false);
    expect(run.days[0].failure.kind).toBe('uw_http_503');
    expect(run.days[0].failure.detail).toContain('1 of 2 tickers failed');
    expect(run.days[0].failure.detail).toContain('first (SPY)');
    // SPY twice (one retry), QQQ once; QQQ's rows still went in.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sql.query).toHaveBeenCalledTimes(1);
    expect(sql.query.mock.calls[0][1][0]).toBe('QQQ');
    expect(summarizeRun(run).exitCode).toBe(1);
  });

  it('fails the day as uw_http_403 for a date outside the plan, never as an empty day', async () => {
    stubFetch({
      uw: {
        SPY: jsonResponse({}, { ok: false, status: 403 }),
        QQQ: jsonResponse({}, { ok: false, status: 403 }),
      },
    });

    const run = await runWorker([D1], (date) =>
      processEtfDay(date, ctx(fakeSql())),
    );

    expect(run.days[0].failure.kind).toBe('uw_http_403');
    expect(summarizeRun(run).emptyDays).toEqual([]);
  });

  it('fails the day as network when the fetch itself throws', async () => {
    const reset = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET' },
    });
    stubFetch({ uw: { SPY: reset, QQQ: reset } });

    const run = await runWorker([D1], (date) =>
      processEtfDay(date, ctx(fakeSql())),
    );

    expect(run.days[0].failure.kind).toBe('network');
  });

  it('fails the day as malformed when UW sends a body that is not JSON', async () => {
    const notJson = {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    };
    stubFetch({ uw: { SPY: notJson, QQQ: bars(2) } });

    const run = await runWorker([D1], (date) =>
      processEtfDay(date, ctx(fakeSql())),
    );

    expect(run.days[0].failure.kind).toBe('malformed');
  });

  it('fails the day as malformed when a bar has no start_time', async () => {
    const broken = [{ open: '1', high: '1', low: '1', close: '1' }];
    stubFetch({ uw: { SPY: broken, QQQ: bars(2) } });

    const run = await runWorker([D1], (date) =>
      processEtfDay(date, ctx(fakeSql())),
    );

    expect(run.days[0].failure.kind).toBe('malformed');
    expect(run.days[0].failure.detail).toContain('no start_time');
  });

  it('fails the day as db when the write rejects, and says which ticker', async () => {
    stubFetch({ uw: { SPY: bars(2), QQQ: bars(2) } });
    const sql = {
      query: vi.fn(async () => {
        throw new Error('permission denied for table etf_candles_1m');
      }),
    };

    const run = await runWorker([D1], (date) => processEtfDay(date, ctx(sql)));

    expect(run.days[0].failure.kind).toBe('db');
    expect(run.days[0].failure.detail).toContain('2 of 2 tickers failed');
    expect(run.days[0].failure.detail).toContain(
      'permission denied for table etf_candles_1m',
    );
    expect(summarizeRun(run).exitCode).toBe(1);
  });

  it('fails the day when UW returns as many bars as its cap: the day may be cut short', async () => {
    stubFetch({ uw: { SPY: bars(UW_CANDLE_LIMIT), QQQ: bars(2) } });
    const sql = fakeSql();

    const run = await runWorker([D1], (date) => processEtfDay(date, ctx(sql)));

    expect(run.days[0].failure.kind).toBe('other');
    expect(run.days[0].failure.detail).toContain('2500 SPY candles');
    expect(run.days[0].failure.detail).toContain('cap');
    // The short ticker still wrote; the capped one wrote nothing.
    expect(sql.query).toHaveBeenCalledTimes(1);
  });

  it('carries on after a failed day: the next day still runs', async () => {
    const fetchMock = vi.fn(async (url) => {
      const date = /date=([\d-]+)/.exec(String(url))[1];
      if (date === D1) return jsonResponse({}, { ok: false, status: 404 });
      return jsonResponse({ data: bars(2, date) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const run = await runWorker([D1, D2], (date) =>
      processEtfDay(date, ctx(fakeSql())),
    );

    expect(run.days.map((d) => d.ok)).toEqual([false, true]);
    expect(run.days[0].failure.kind).toBe('uw_http_404');
  });
});

describe('processIndexDay', () => {
  beforeEach(() => atTime(TODAY, ['Date', 'setTimeout']));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const ctx = (sql, closes = schwabClosesMap()) => ({
    apiKey: 'uw-key-for-tests',
    sql,
    dryRun: false,
    waitForSlot: noWait,
    closes,
  });

  it("turns SPY into SPX and QQQ into NDX at that day's ratio, as index_candles_1m rows", async () => {
    const fetchMock = stubFetch({ uw: { SPY: bars(2), QQQ: bars(3) } });
    const sql = fakeSql({ columns: 11 });

    const run = await runWorker([D1], (date) =>
      processIndexDay(date, ctx(sql)),
    );

    expect(INDEXES.map((i) => [i.symbol, i.etf])).toEqual([
      ['SPX', 'SPY'],
      ['NDX', 'QQQ'],
    ]);
    expect(run.days[0].value).toEqual({
      fetched: 5,
      stored: 5,
      kept: 5,
      dropped: 0,
    });
    // SPX from SPY, NDX from QQQ.
    expect(
      fetchMock.mock.calls.map(([u]) => /stock\/(\w+)\//.exec(u)[1]),
    ).toEqual(['SPY', 'QQQ']);
    const [spxText, spxValues] = sql.query.mock.calls[0];
    const [, ndxValues] = sql.query.mock.calls[1];
    expect(spxText).toContain('INSERT INTO index_candles_1m');
    expect(spxValues[0]).toBe('SPX');
    expect(ndxValues[0]).toBe('NDX');
    // open is the SPY open x (SPX close / SPY close), not x 10.
    const spxRatio = 6401.28 / 637.14;
    const ndxRatio = 23510.5 / 573.2;
    expect(spxValues[3]).toBeCloseTo(637.1 * spxRatio, 8);
    expect(spxValues[3]).not.toBeCloseTo(637.1 * 10, 0);
    expect(ndxValues[3]).toBeCloseTo(637.1 * ndxRatio, 8);
    expect(ndxValues[3]).not.toBeCloseTo(637.1 * 41, 0);
  });

  it("uses each day's own ratio", async () => {
    stubFetch({ uw: { SPY: barsOnDate(1), QQQ: barsOnDate(1) } });
    const sql = fakeSql({ columns: 11 });

    await runWorker([D1, D2], (date) => processIndexDay(date, ctx(sql)));

    // Calls: D1 SPX, D1 NDX, D2 SPX, D2 NDX. The bars are the same, so the
    // open differs only through the ratio.
    const opens = sql.query.mock.calls.map(([, v]) => v[3]);
    expect(opens[0]).toBeCloseTo(637.1 * (6401.28 / 637.14), 8);
    expect(opens[2]).toBeCloseTo(637.1 * (6455.92 / 642.55), 8);
    expect(opens[0]).not.toBeCloseTo(opens[2], 3);
  });

  it('writes NULL for both Schwab price columns on a backfilled row', async () => {
    stubFetch({ uw: { SPY: bars(2), QQQ: bars(2) } });
    const sql = fakeSql({ columns: 11 });

    await runWorker([D1], (date) => processIndexDay(date, ctx(sql)));

    for (const [, values] of sql.query.mock.calls) {
      for (let row = 0; row < values.length / 11; row++) {
        expect(values.slice(row * 11 + 9, row * 11 + 11)).toEqual([null, null]);
      }
    }
  });

  it('on a dry run writes nothing and reports the would-be rows as kept', async () => {
    stubFetch({ uw: { SPY: bars(2), QQQ: bars(2) } });
    const sql = fakeSql({ columns: 11 });

    const run = await runWorker([D1], (date) =>
      processIndexDay(date, { ...ctx(sql), dryRun: true }),
    );

    expect(run.days[0].value).toEqual({
      fetched: 4,
      stored: 0,
      kept: 4,
      dropped: 0,
    });
    expect(sql.query).not.toHaveBeenCalled();
  });

  it('fails the day, by name, when a date has no Schwab close, without asking UW for that symbol', async () => {
    const closes = schwabClosesMap();
    closes.get('$SPX').closes.delete(D2);
    const fetchMock = stubFetch({
      uw: { SPY: barsOnDate(2), QQQ: barsOnDate(2) },
    });
    const sql = fakeSql({ columns: 11 });

    const run = await runWorker([D1, D2], (date) =>
      processIndexDay(date, ctx(sql, closes)),
    );

    expect(run.days[0].ok).toBe(true);
    expect(run.days[1].ok).toBe(false);
    expect(run.days[1].failure.kind).toBe('other');
    expect(run.days[1].failure.detail).toContain('1 of 2 symbols failed');
    expect(run.days[1].failure.detail).toContain(
      `first (SPX): no ratio for SPX on ${D2}: Schwab has no $SPX daily close for ${D2}`,
    );
    // D1: SPY + QQQ. D2: QQQ only; SPY was never fetched for the dead symbol.
    expect(
      fetchMock.mock.calls.map(([u]) => /stock\/(\w+)\//.exec(u)[1]),
    ).toEqual(['SPY', 'QQQ', 'QQQ']);
    // NDX for D2 still landed.
    expect(sql.query).toHaveBeenCalledTimes(3);
    expect(summarizeRun(run).exitCode).toBe(1);
  });

  it('fails every day with the Schwab failure kind when Schwab could not be reached', async () => {
    const down = {
      failure: { kind: 'network', detail: 'fetch failed (ECONNRESET)' },
    };
    const closes = schwabClosesMap({
      $SPX: down,
      SPY: down,
      $NDX: down,
      QQQ: down,
    });
    const fetchMock = stubFetch();

    const run = await runWorker([D1, D2], (date) =>
      processIndexDay(date, ctx(fakeSql({ columns: 11 }), closes)),
    );

    expect(run.days.map((d) => d.failure.kind)).toEqual(['network', 'network']);
    expect(run.days[0].failure.detail).toContain('2 of 2 symbols failed');
    expect(run.days[0].failure.detail).toContain('Schwab $SPX daily history');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(summarizeRun(run).byKind.map((k) => k.kind)).toEqual(['network']);
  });

  it('fails the day as uw_http_500 when UW errors, and as db when the write rejects', async () => {
    stubFetch({
      uw: {
        SPY: jsonResponse({}, { ok: false, status: 500 }),
        QQQ: bars(2),
      },
    });
    const run1 = await runWorker([D1], (date) =>
      processIndexDay(date, ctx(fakeSql({ columns: 11 }))),
    );
    expect(run1.days[0].failure.kind).toBe('uw_http_500');

    vi.unstubAllGlobals();
    stubFetch({ uw: { SPY: bars(2), QQQ: bars(2) } });
    const sql = {
      query: vi.fn(async () => {
        throw new Error('deadlock detected');
      }),
    };
    const run2 = await runWorker([D1], (date) =>
      processIndexDay(date, ctx(sql)),
    );
    expect(run2.days[0].failure.kind).toBe('db');
    expect(run2.days[0].failure.detail).toContain('deadlock detected');
  });

  it('fails the day when UW returns as many bars as its cap', async () => {
    stubFetch({ uw: { SPY: bars(UW_CANDLE_LIMIT), QQQ: bars(2) } });

    const run = await runWorker([D1], (date) =>
      processIndexDay(date, ctx(fakeSql({ columns: 11 }))),
    );

    expect(run.days[0].failure.kind).toBe('other');
    expect(run.days[0].failure.detail).toContain('2500 SPY candles');
  });

  it('counts bars it drops, so kept + dropped is what UW sent', async () => {
    const mixed = [
      ...bars(2),
      bar('2026-08-12T14:00:00Z', { market_time: 'bad' }),
    ];
    stubFetch({ uw: { SPY: mixed, QQQ: bars(1) } });

    const run = await runWorker([D1], (date) =>
      processIndexDay(date, ctx(fakeSql({ columns: 11 }))),
    );

    expect(run.days[0].value).toMatchObject({
      fetched: 4,
      kept: 3,
      dropped: 1,
    });
  });
});

// ── The scripts' own flags, through plain node ─────────────

describe('the candle scripts exit 2 on bad flags, before any network', () => {
  const scripts = [
    path.resolve(__dirname, '../backfill-etf-candles-1m.mjs'),
    path.resolve(__dirname, '../backfill-spx-candles-1m.mjs'),
  ];

  function runCli(script, args) {
    const env = { ...process.env };
    delete env.UW_API_KEY;
    delete env.DATABASE_URL;
    return spawnSync(process.execPath, [script, ...args], {
      env,
      encoding: 'utf8',
    });
  }

  it.each(scripts)('%s needs a range', (script) => {
    const result = runCli(script, []);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--from and --to are required');
  });

  it.each(scripts)('%s refuses half a range', (script) => {
    const result = runCli(script, ['--from', '2026-07-22']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--from and --to go together');
  });

  it.each(scripts)('%s refuses a range with no trading day', (script) => {
    const result = runCli(script, [
      '--from',
      '2026-09-05',
      '--to',
      '2026-09-07',
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no trading days between');
  });

  it.each(scripts)('%s refuses a range that reaches today', (script) => {
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });
    const result = runCli(script, ['--from', today, '--to', today]);
    // Either the to-today rule (ET) or, late in the evening in CT, the older
    // after-today rule: both are a bad flag.
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/not a finished day|is after today/);
  });
});
