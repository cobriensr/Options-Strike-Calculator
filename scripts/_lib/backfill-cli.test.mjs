// @vitest-environment node

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  UW_REQUESTS_PER_MINUTE,
  chunk,
  classifyFailure,
  createRequestThrottle,
  isMarketHoursCt,
  marketHoursRefusal,
  parseArgs,
  parseRangeArgs,
  redact,
  retryTransientDb,
  runDays,
  runPool,
  runTickerDays,
  selectDates,
  summarizeByDay,
  summarizeFailures,
  summarizeRun,
  tradingDaysInRange,
} from './backfill-cli.mjs';
import * as netPrem from './net-prem-ticks-backfill.mjs';
import * as rangePos from './range-pos-backfill.mjs';

// 2026-10-29 is a Thursday, CDT (UTC−5). 22:00 UTC = 17:00 CT, after the
// close, so the market-hours guard is quiet unless a test moves the clock.
const AFTER_CLOSE = '2026-10-29T22:00:00Z';
// 17:00 UTC = 12:00 CT, mid-session.
const MID_SESSION = '2026-10-29T17:00:00Z';
// 13:14:20 UTC = 08:14:20 CT, 40 s before the guard window opens.
const JUST_BEFORE_OPEN = '2026-10-29T13:14:20Z';
const GUARD_MESSAGE = '08:15–15:30 CT';

function atTime(iso) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

// ── the old modules re-export what moved ───────────────────

describe('re-exports', () => {
  it.each([
    ['range-pos parseArgs', rangePos.parseArgs, parseArgs],
    ['range-pos isMarketHoursCt', rangePos.isMarketHoursCt, isMarketHoursCt],
    ['range-pos chunk', rangePos.chunk, chunk],
    ['range-pos runPool', rangePos.runPool, runPool],
    ['range-pos retryTransientDb', rangePos.retryTransientDb, retryTransientDb],
    [
      'range-pos summarizeFailures',
      rangePos.summarizeFailures,
      summarizeFailures,
    ],
    ['range-pos redact', rangePos.redact, redact],
    // net-prem's parseArgs is the stricter range parser.
    ['net-prem parseArgs', netPrem.parseArgs, parseRangeArgs],
    [
      'net-prem marketHoursRefusal',
      netPrem.marketHoursRefusal,
      marketHoursRefusal,
    ],
    [
      'net-prem tradingDaysInRange',
      netPrem.tradingDaysInRange,
      tradingDaysInRange,
    ],
    ['net-prem selectDates', netPrem.selectDates, selectDates],
    [
      'net-prem createRequestThrottle',
      netPrem.createRequestThrottle,
      createRequestThrottle,
    ],
    ['net-prem runTickerDays', netPrem.runTickerDays, runTickerDays],
    ['net-prem summarizeByDay', netPrem.summarizeByDay, summarizeByDay],
    [
      'net-prem UW_REQUESTS_PER_MINUTE',
      netPrem.UW_REQUESTS_PER_MINUTE,
      UW_REQUESTS_PER_MINUTE,
    ],
  ])('%s is the shared one', (_label, reExported, shared) => {
    expect(reExported).toBe(shared);
  });
});

// ── flags ──────────────────────────────────────────────────

describe('parseArgs', () => {
  it('defaults to a full, writing run with no range', () => {
    expect(parseArgs([])).toEqual({
      dryRun: false,
      allowMarketHours: false,
      limit: null,
      from: null,
      to: null,
    });
  });

  it('reads every flag', () => {
    expect(
      parseArgs([
        '--dry-run',
        '--allow-market-hours',
        '--limit',
        '50',
        '--from',
        '2026-07-22',
        '--to',
        '2026-09-04',
      ]),
    ).toEqual({
      dryRun: true,
      allowMarketHours: true,
      limit: 50,
      from: '2026-07-22',
      to: '2026-09-04',
    });
  });

  it('lets --from and --to come alone (the range-pos backfill)', () => {
    expect(parseArgs(['--from', '2026-07-22'])).toMatchObject({
      from: '2026-07-22',
      to: null,
    });
    expect(parseArgs(['--to', '2026-09-04'])).toMatchObject({
      from: null,
      to: '2026-09-04',
    });
  });

  it.each([
    [['--limit', '0'], '--limit'],
    [['--limit', 'abc'], '--limit'],
    [['--limit'], '--limit'],
    [['--from', '2026-13-01'], '--from'],
    [['--to', '05/18/2026'], '--to'],
    [
      ['--from', '2026-09-04', '--to', '2026-07-22'],
      '--from 2026-09-04 is after',
    ],
    [['--force'], 'Unknown argument: --force'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe('parseRangeArgs', () => {
  afterEach(() => vi.useRealTimers());

  it('accepts neither flag (the script keeps its own lookback) or both', () => {
    atTime(AFTER_CLOSE);
    expect(parseRangeArgs([])).toMatchObject({ from: null, to: null });
    expect(
      parseRangeArgs(['--from', '2026-07-22', '--to', '2026-09-04']),
    ).toMatchObject({ from: '2026-07-22', to: '2026-09-04' });
  });

  it('accepts --to today', () => {
    atTime(AFTER_CLOSE);
    expect(
      parseRangeArgs(['--from', '2026-10-29', '--to', '2026-10-29']).to,
    ).toBe('2026-10-29');
  });

  it.each([
    [['--from', '2026-07-22'], '--from and --to go together'],
    [['--to', '2026-09-04'], '--from and --to go together'],
    [
      ['--from', '2026-10-28', '--to', '2026-10-30'],
      '--to 2026-10-30 is after today (2026-10-29 CT)',
    ],
    // The base parser's own rules still apply.
    [
      ['--from', '2026-09-04', '--to', '2026-07-22'],
      '--from 2026-09-04 is after',
    ],
    [['--days', '30'], 'Unknown argument: --days'],
  ])('rejects %j', (argv, message) => {
    atTime(AFTER_CLOSE);
    expect(() => parseRangeArgs(argv)).toThrow(message);
  });

  it('reads today in CT, not UTC, late in the evening', () => {
    // 03:00 UTC on the 30th is 22:00 CT on the 29th: the 30th is tomorrow.
    atTime('2026-10-30T03:00:00Z');
    expect(() =>
      parseRangeArgs(['--from', '2026-10-29', '--to', '2026-10-30']),
    ).toThrow('after today (2026-10-29 CT)');
  });
});

// ── market-hours guard ─────────────────────────────────────

describe('isMarketHoursCt and marketHoursRefusal', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    // 2026-10-29 is a Thursday, CDT (UTC−5).
    ['08:14 CT Thursday', '2026-10-29T13:14:00Z', false],
    ['08:15 CT Thursday', '2026-10-29T13:15:00Z', true],
    ['12:00 CT Thursday', MID_SESSION, true],
    ['15:29 CT Thursday', '2026-10-29T20:29:00Z', true],
    ['15:30 CT Thursday', '2026-10-29T20:30:00Z', false],
    ['10:00 CT Saturday', '2026-10-31T15:00:00Z', false],
    ['10:00 CT Sunday', '2026-11-01T16:00:00Z', false],
    // 2026-11-02 is a Monday after DST ends, CST (UTC−6).
    ['08:10 CST Monday', '2026-11-02T14:10:00Z', false],
    ['08:15 CST Monday', '2026-11-02T14:15:00Z', true],
  ])('%s (%s) → in the window: %s', (_label, iso, inWindow) => {
    atTime(iso);
    expect(isMarketHoursCt()).toBe(inWindow);
    const refusal = marketHoursRefusal({ allowMarketHours: false });
    if (inWindow) {
      expect(refusal).toContain(GUARD_MESSAGE);
      expect(refusal).toContain('--allow-market-hours');
    } else {
      expect(refusal).toBeNull();
    }
  });

  it('lets --allow-market-hours through inside the window', () => {
    atTime(MID_SESSION);
    expect(marketHoursRefusal({ allowMarketHours: true })).toBeNull();
  });
});

// ── dates ──────────────────────────────────────────────────

describe('tradingDaysInRange and selectDates', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ['a single day', '2026-07-23', '2026-07-23', ['2026-07-23']],
    [
      'a weekend between',
      '2026-07-24',
      '2026-07-27',
      ['2026-07-24', '2026-07-27'],
    ],
    ['only a weekend', '2026-07-25', '2026-07-26', []],
    ['Labor Day alone', '2026-09-07', '2026-09-07', []],
    [
      'Independence Day observed (Fri 07-03)',
      '2026-07-02',
      '2026-07-06',
      ['2026-07-02', '2026-07-06'],
    ],
  ])('%s: %s → %s', (_label, from, to, expected) => {
    expect(tradingDaysInRange(from, to)).toEqual(expected);
  });

  it('gives the 33 trading days of the summer gap, 07-22 → 09-04', () => {
    const days = tradingDaysInRange('2026-07-22', '2026-09-04');
    expect(days).toHaveLength(33);
    expect(days[0]).toBe('2026-07-22');
    expect(days.at(-1)).toBe('2026-09-04');
  });

  it('maps a range to its trading days', () => {
    expect(selectDates({ from: '2026-09-03', to: '2026-09-08' }, 90)).toEqual({
      mode: 'range',
      dates: ['2026-09-03', '2026-09-04', '2026-09-08'],
    });
  });

  it('rejects a range with no trading day in it', () => {
    expect(() =>
      selectDates({ from: '2026-09-05', to: '2026-09-07' }, 90),
    ).toThrow('no trading days between --from 2026-09-05 and --to 2026-09-07');
  });

  it('keeps the lookback without a range: DAYS weekdays ending today', () => {
    atTime(AFTER_CLOSE);
    expect(selectDates({ from: null, to: null }, 3)).toEqual({
      mode: 'lookback',
      dates: ['2026-10-27', '2026-10-28', '2026-10-29'],
    });
  });

  it.each([Number.NaN, 0, 2.5])('rejects DAYS=%s', (days) => {
    expect(() => selectDates({ from: null, to: null }, days)).toThrow('DAYS');
  });
});

// ── chunking, pool, throttle ───────────────────────────────

describe('chunk and runPool', () => {
  it('chunk splits into slices of at most the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 500)).toEqual([]);
  });

  it('chunk rejects a size below 1', () => {
    expect(() => chunk([1], 0)).toThrow('size');
  });

  it('runPool never runs more than the limit at once and keeps input order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await runPool([5, 1, 4, 2, 3, 0, 6], 3, async (ms) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return ms * 10;
    });
    expect(maxInFlight).toBe(3);
    expect(results).toEqual([50, 10, 40, 20, 30, 0, 60]);
  });

  it('runPool rejects when a worker throws', async () => {
    await expect(
      runPool([1, 2], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});

describe('createRequestThrottle', () => {
  afterEach(() => vi.useRealTimers());

  it('spaces starts 200 ms apart at 300 a minute', async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const wait = createRequestThrottle(UW_REQUESTS_PER_MINUTE);
    const starts = [];
    const all = Promise.all(
      Array.from({ length: 4 }, async () => {
        await wait();
        starts.push(Date.now() - t0);
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await all;
    expect(starts).toEqual([0, 200, 400, 600]);
  });

  it('pins the spec ceiling of 300 UW requests a minute', () => {
    expect(UW_REQUESTS_PER_MINUTE).toBe(300);
  });

  it.each([0, -5, 1.5, Number.NaN])('rejects a rate of %s', (rate) => {
    expect(() => createRequestThrottle(rate)).toThrow('perMinute');
  });
});

// ── Neon retry ─────────────────────────────────────────────

describe('retryTransientDb', () => {
  afterEach(() => vi.useRealTimers());

  it('retries a transient Neon error and returns the next result', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce([{ n: 1 }]);

    const pending = retryTransientDb(fn);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual([{ n: 1 }]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rethrows a genuine error at once', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new Error('column "nope" does not exist'));

    await expect(retryTransientDb(fn)).rejects.toThrow('does not exist');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after two retries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    const pending = retryTransientDb(fn);
    const assertion = expect(pending).rejects.toThrow('ECONNRESET');
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('abandons a query that hangs past its 30 s deadline and retries it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fn = vi
      .fn()
      .mockReturnValueOnce(new Promise(() => {})) // a row-lock wait that never ends
      .mockResolvedValueOnce([{ n: 5 }]);

    const pending = retryTransientDb(fn);
    // 30 s deadline, then the 2 s backoff, then the second attempt.
    await vi.advanceTimersByTimeAsync(32_000);

    await expect(pending).resolves.toEqual([{ n: 5 }]);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ── guarded ticker-day loop ────────────────────────────────

describe('runTickerDays', () => {
  afterEach(() => vi.useRealTimers());

  const pairs = Array.from({ length: 10 }, (_, i) => ({
    ticker: `T${i}`,
    date: '2026-07-23',
  }));

  /** processPair that takes 20 s of (fake) wall clock per ticker-day. */
  function slowPairs() {
    const seen = [];
    const processPair = async (pair) => {
      seen.push(pair.ticker);
      vi.setSystemTime(Date.now() + 20_000);
    };
    return { seen, processPair };
  }

  it('stops taking ticker-days once the 08:15 CT window opens', async () => {
    atTime(JUST_BEFORE_OPEN);
    const { seen, processPair } = slowPairs();

    const stoppedBy = await runTickerDays(
      pairs,
      { concurrency: 1, allowMarketHours: false },
      processPair,
    );

    // 08:14:20 and 08:14:40 run; at 08:15:00 the guard refuses.
    expect(seen).toEqual(['T0', 'T1']);
    expect(stoppedBy).toContain(GUARD_MESSAGE);
  });

  it('runs every pair after the close, or anywhere with --allow-market-hours', async () => {
    for (const [iso, allowMarketHours] of [
      [AFTER_CLOSE, false],
      [JUST_BEFORE_OPEN, true],
    ]) {
      atTime(iso);
      const { seen, processPair } = slowPairs();
      await expect(
        runTickerDays(pairs, { concurrency: 3, allowMarketHours }, processPair),
      ).resolves.toBeNull();
      expect(seen).toHaveLength(10);
    }
  });

  it('rejects when a ticker-day fails (net-prem aborts on it)', async () => {
    atTime(AFTER_CLOSE);
    await expect(
      runTickerDays(
        pairs,
        { concurrency: 2, allowMarketHours: false },
        async () => {
          throw new Error('column "x" does not exist');
        },
      ),
    ).rejects.toThrow('column "x" does not exist');
  });
});

// ── report helpers ─────────────────────────────────────────

describe('summarizeFailures and summarizeByDay', () => {
  it('summarizeFailures counts by status, most common first, one example each', () => {
    const failures = [
      { ticker: 'AAPL', date: '2026-05-01', status: 'http_404', detail: 'a' },
      { ticker: 'TSLA', date: '2026-05-02', status: 'http_503', detail: 'b' },
      { ticker: 'NVDA', date: '2026-05-03', status: 'http_503', detail: 'c' },
    ];
    expect(summarizeFailures(failures)).toEqual([
      {
        status: 'http_503',
        count: 2,
        example: { ticker: 'TSLA', date: '2026-05-02', detail: 'b' },
      },
      {
        status: 'http_404',
        count: 1,
        example: { ticker: 'AAPL', date: '2026-05-01', detail: 'a' },
      },
    ]);
  });

  it('summarizeByDay totals each date, ascending, and counts ok, empty and failed', () => {
    const results = [
      { date: '2026-07-23', kind: 'ok', fetched: 405, kept: 390, stored: 390 },
      { date: '2026-07-22', kind: 'ok', fetched: 405, kept: 390, stored: 80 },
      { date: '2026-07-23', kind: 'empty', fetched: 0, kept: 0, stored: 0 },
      { date: '2026-07-23', kind: 'error', fetched: 0, kept: 0, stored: 0 },
    ];
    expect(summarizeByDay(results)).toEqual([
      {
        date: '2026-07-22',
        tickers: 1,
        ok: 1,
        empty: 0,
        failed: 0,
        fetched: 405,
        kept: 390,
        stored: 80,
      },
      {
        date: '2026-07-23',
        tickers: 3,
        ok: 1,
        empty: 1,
        failed: 1,
        fetched: 405,
        kept: 390,
        stored: 390,
      },
    ]);
    expect(summarizeByDay([])).toEqual([]);
  });
});

describe('redact', () => {
  const dbUrl = 'postgresql://owner:s3cr3t@ep-x.neon.tech/neondb';

  it('removes the UW key, the database URL and its password', () => {
    const text = `key=uw-123 url=${dbUrl} pw=s3cr3t`;
    expect(redact(text, { uwKey: 'uw-123', databaseUrl: dbUrl })).toBe(
      'key=[redacted] url=[redacted] pw=[redacted]',
    );
  });

  it('leaves text alone when there is nothing to hide', () => {
    expect(redact('plain', { uwKey: undefined, databaseUrl: undefined })).toBe(
      'plain',
    );
  });
});

// ── classifyFailure ────────────────────────────────────────

describe('classifyFailure', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ['a UW 503', 'http_503', 'uw_http_503'],
    ['a UW 429', 'http_429', 'uw_http_429'],
    ['a UW 404', 'http_404', 'uw_http_404'],
    ['a UW 403 outside the plan window', 'http_403', 'uw_http_403'],
    ['a UW network error', 'network', 'network'],
    ['a UW timeout', 'timeout', 'timeout'],
    ['a UW malformed body', 'malformed', 'malformed'],
  ])('reads %s outcome as kind %s', (_label, status, kind) => {
    expect(classifyFailure({ kind: 'error', status, detail: 'why' })).toEqual({
      kind,
      detail: 'why',
    });
  });

  it('reads an outcome with a status it does not know as other, keeping the status', () => {
    expect(
      classifyFailure({ kind: 'error', status: 'teapot', detail: 'short' }),
    ).toEqual({ kind: 'other', detail: 'teapot: short' });
    expect(classifyFailure({ kind: 'error', status: 'teapot' })).toEqual({
      kind: 'other',
      detail: 'teapot',
    });
  });

  it.each([
    [
      'a fetch that failed',
      new TypeError('fetch failed'),
      { kind: 'network', detail: 'fetch failed' },
    ],
    [
      'a socket reset, with its cause code',
      new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }),
      { kind: 'network', detail: 'fetch failed (ECONNRESET)' },
    ],
    [
      'a request timeout',
      new DOMException('The operation timed out', 'TimeoutError'),
      { kind: 'timeout', detail: 'The operation timed out' },
    ],
    [
      'an aborted request',
      new DOMException('This operation was aborted', 'AbortError'),
      { kind: 'timeout', detail: 'This operation was aborted' },
    ],
    [
      'a body that is not JSON',
      new SyntaxError('Unexpected token < in JSON at position 0'),
      { kind: 'malformed', detail: 'Unexpected token < in JSON at position 0' },
    ],
    ['an ordinary error', new Error('boom'), { kind: 'other', detail: 'boom' }],
    [
      'a thrown string',
      'just a string',
      { kind: 'other', detail: 'just a string' },
    ],
  ])('reads %s as %j', (_label, thrown, expected) => {
    expect(classifyFailure(thrown)).toEqual(expected);
  });

  it('reads an error out of retryTransientDb as db, not by its message', async () => {
    const err = await retryTransientDb(async () => {
      throw new Error('duplicate key value violates unique constraint "x"');
    }).catch((e) => e);

    expect(classifyFailure(err)).toEqual({
      kind: 'db',
      detail: 'duplicate key value violates unique constraint "x"',
    });
  });

  it('reads a db timeout as db, not timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const settled = retryTransientDb(() => new Promise(() => {})).catch(
      (e) => e,
    );
    // Three 30 s attempts plus the 2 s and 4 s backoffs.
    await vi.advanceTimersByTimeAsync(96_000);

    expect(classifyFailure(await settled)).toEqual({
      kind: 'db',
      detail: 'db attempt timeout after 30000 ms',
    });
  });

  it('keeps db when a worker wraps the error as a cause', async () => {
    const dbErr = await retryTransientDb(async () => {
      throw new Error('relation "nope" does not exist');
    }).catch((e) => e);
    const wrapped = new Error('2026-07-23 failed', { cause: dbErr });

    expect(classifyFailure(wrapped).kind).toBe('db');
  });

  it('does not call an untagged error db, whatever its message says', () => {
    expect(classifyFailure(new Error('connection terminated')).kind).toBe(
      'other',
    );
  });
});

// ── runDays ────────────────────────────────────────────────

describe('runDays', () => {
  afterEach(() => vi.useRealTimers());

  const secrets = {
    uwKey: 'uw-secret-key',
    databaseUrl: 'postgresql://owner:s3cr3t@ep-x.neon.tech/neondb',
  };
  const DATES = ['2026-07-22', '2026-07-23', '2026-07-24'];
  const after = { allowMarketHours: false, secrets };

  it('runs the days in order, one at a time, and keeps each worker result', async () => {
    atTime(AFTER_CLOSE);
    let inFlight = 0;
    let maxInFlight = 0;
    const order = [];

    const run = await runDays(DATES, after, async (date) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      order.push(date);
      inFlight--;
      return { stored: order.length };
    });

    expect(order).toEqual(DATES);
    expect(maxInFlight).toBe(1);
    expect(run).toEqual({
      days: [
        { date: '2026-07-22', ok: true, value: { stored: 1 } },
        { date: '2026-07-23', ok: true, value: { stored: 2 } },
        { date: '2026-07-24', ok: true, value: { stored: 3 } },
      ],
      stoppedBy: null,
      notRun: [],
    });
  });

  it('treats a UW ok or empty outcome as a day that ran', async () => {
    atTime(AFTER_CLOSE);
    const outcomes = [{ kind: 'ok', rows: [1] }, { kind: 'empty' }];
    const run = await runDays(DATES.slice(0, 2), after, async (date) =>
      date === DATES[0] ? outcomes[0] : outcomes[1],
    );
    expect(run.days.map((d) => d.ok)).toEqual([true, true]);
    expect(run.days.map((d) => d.value)).toEqual(outcomes);
  });

  it('counts a DB rejection against its day, as db, and moves on', async () => {
    atTime(AFTER_CLOSE);
    const seen = [];

    const run = await runDays(DATES, after, async (date) => {
      seen.push(date);
      if (date === '2026-07-23') {
        await retryTransientDb(async () => {
          throw new Error('duplicate key value violates unique constraint "x"');
        });
      }
      return 'done';
    });

    expect(seen).toEqual(DATES);
    expect(run.days).toEqual([
      { date: '2026-07-22', ok: true, value: 'done' },
      {
        date: '2026-07-23',
        ok: false,
        failure: {
          kind: 'db',
          detail: 'duplicate key value violates unique constraint "x"',
        },
      },
      { date: '2026-07-24', ok: true, value: 'done' },
    ]);
    expect(run.stoppedBy).toBeNull();
  });

  it('names each kind of failure and keeps going after every one', async () => {
    atTime(AFTER_CLOSE);
    const dates = [
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
      '2026-07-31',
    ];
    const failures = new Map([
      // A returned UW error outcome, as fetchUwDayRows gives it.
      ['2026-07-22', async () => ({ kind: 'error', status: 'http_503' })],
      ['2026-07-23', async () => ({ kind: 'error', status: 'http_403' })],
      ['2026-07-24', async () => ({ kind: 'error', status: 'network' })],
      ['2026-07-27', async () => ({ kind: 'error', status: 'timeout' })],
      ['2026-07-28', async () => ({ kind: 'error', status: 'malformed' })],
      // Rejections.
      [
        '2026-07-29',
        async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      ],
      [
        '2026-07-30',
        async () => {
          await retryTransientDb(async () => {
            throw new Error('relation "t" does not exist');
          });
        },
      ],
    ]);
    const seen = [];

    const run = await runDays(dates, after, async (date) => {
      seen.push(date);
      const fail = failures.get(date);
      return fail ? fail() : 'ok';
    });

    expect(seen).toEqual(dates);
    expect(run.days.map((d) => (d.ok ? 'ok' : d.failure.kind))).toEqual([
      'uw_http_503',
      'uw_http_403',
      'network',
      'timeout',
      'malformed',
      'malformed',
      'db',
      'ok',
    ]);
  });

  it('files an unrecognised rejection under other', async () => {
    atTime(AFTER_CLOSE);
    const run = await runDays(['2026-07-22'], after, async () => {
      throw new Error('boom');
    });
    expect(run.days).toEqual([
      {
        date: '2026-07-22',
        ok: false,
        failure: { kind: 'other', detail: 'boom' },
      },
    ]);
  });

  it('redacts the UW key, the database URL and its password from a failure detail', async () => {
    atTime(AFTER_CLOSE);
    const run = await runDays(DATES.slice(0, 2), after, async (date) => {
      if (date === DATES[0]) {
        throw new Error(
          `insert failed on ${secrets.databaseUrl} (password s3cr3t)`,
        );
      }
      return {
        kind: 'error',
        status: 'http_401',
        detail: `bad key ${secrets.uwKey}`,
      };
    });

    expect(run.days.map((d) => d.failure.detail)).toEqual([
      'insert failed on [redacted] (password [redacted])',
      'bad key [redacted]',
    ]);
  });

  it('stops taking days once the 08:15 CT window opens, and says which are left', async () => {
    // 08:14:20 CT. Each day takes 20 s of (fake) wall clock.
    atTime(JUST_BEFORE_OPEN);
    const dates = [
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-27',
      '2026-07-28',
    ];
    const seen = [];

    const run = await runDays(dates, after, async (date) => {
      seen.push(date);
      vi.setSystemTime(Date.now() + 20_000);
      return date;
    });

    // 08:14:20 and 08:14:40 run; at 08:15:00 the guard refuses.
    expect(seen).toEqual(['2026-07-22', '2026-07-23']);
    expect(run.days.map((d) => d.date)).toEqual(['2026-07-22', '2026-07-23']);
    expect(run.stoppedBy).toContain(GUARD_MESSAGE);
    expect(run.notRun).toEqual(['2026-07-24', '2026-07-27', '2026-07-28']);
  });

  it('checks the guard before the first day too', async () => {
    atTime(MID_SESSION);
    const worker = vi.fn(async () => 'never');

    const run = await runDays(DATES, after, worker);

    expect(worker).not.toHaveBeenCalled();
    expect(run).toEqual({
      days: [],
      stoppedBy: expect.stringContaining(GUARD_MESSAGE),
      notRun: DATES,
    });
  });

  it('runs straight through with --allow-market-hours', async () => {
    atTime(MID_SESSION);
    const run = await runDays(
      DATES,
      { allowMarketHours: true, secrets },
      async (date) => date,
    );
    expect(run.days).toHaveLength(3);
    expect(run.stoppedBy).toBeNull();
    expect(run.notRun).toEqual([]);
  });

  it('refuses to run without the secrets it must redact with', async () => {
    atTime(AFTER_CLOSE);
    const worker = vi.fn(async () => 'x');
    await expect(
      runDays(DATES, { allowMarketHours: false }, worker),
    ).rejects.toThrow('secrets');
    expect(worker).not.toHaveBeenCalled();
  });
});

// ── summarizeRun ───────────────────────────────────────────

describe('summarizeRun', () => {
  afterEach(() => vi.useRealTimers());

  const ok = (date) => ({ date, ok: true, value: null });
  const bad = (date, kind, detail = `${kind} detail`) => ({
    date,
    ok: false,
    failure: { kind, detail },
  });

  it('exits 0 when every day ran and none failed', () => {
    const summary = summarizeRun({
      days: [ok('2026-07-22'), ok('2026-07-23')],
      stoppedBy: null,
      notRun: [],
    });
    expect(summary).toEqual({
      attempted: 2,
      succeeded: 2,
      failedDays: [],
      byKind: [],
      stoppedBy: null,
      notRun: [],
      exitCode: 0,
    });
  });

  it('counts failures by day and by kind, most common kind first', () => {
    const summary = summarizeRun({
      days: [
        bad('2026-07-22', 'uw_http_503', 'down'),
        ok('2026-07-23'),
        bad('2026-07-24', 'db', 'lost'),
        bad('2026-07-27', 'uw_http_503', 'down again'),
        bad('2026-07-28', 'network', 'reset'),
        bad('2026-07-29', 'db', 'gone'),
        bad('2026-07-30', 'db', 'third'),
      ],
      stoppedBy: null,
      notRun: [],
    });

    expect(summary.attempted).toBe(7);
    expect(summary.succeeded).toBe(1);
    expect(summary.failedDays).toEqual([
      { date: '2026-07-22', kind: 'uw_http_503', detail: 'down' },
      { date: '2026-07-24', kind: 'db', detail: 'lost' },
      { date: '2026-07-27', kind: 'uw_http_503', detail: 'down again' },
      { date: '2026-07-28', kind: 'network', detail: 'reset' },
      { date: '2026-07-29', kind: 'db', detail: 'gone' },
      { date: '2026-07-30', kind: 'db', detail: 'third' },
    ]);
    expect(summary.byKind).toEqual([
      {
        kind: 'db',
        count: 3,
        dates: ['2026-07-24', '2026-07-29', '2026-07-30'],
        example: { date: '2026-07-24', detail: 'lost' },
      },
      {
        kind: 'uw_http_503',
        count: 2,
        dates: ['2026-07-22', '2026-07-27'],
        example: { date: '2026-07-22', detail: 'down' },
      },
      {
        kind: 'network',
        count: 1,
        dates: ['2026-07-28'],
        example: { date: '2026-07-28', detail: 'reset' },
      },
    ]);
    expect(summary.exitCode).toBe(1);
  });

  it('breaks a tie between kinds by name', () => {
    const summary = summarizeRun({
      days: [bad('2026-07-22', 'timeout'), bad('2026-07-23', 'network')],
      stoppedBy: null,
      notRun: [],
    });
    expect(summary.byKind.map((k) => k.kind)).toEqual(['network', 'timeout']);
  });

  it('exits 1 for a run the market-hours guard stopped, though no day failed', () => {
    const summary = summarizeRun({
      days: [ok('2026-07-22')],
      stoppedBy: `Refusing to run ${GUARD_MESSAGE} on a weekday`,
      notRun: ['2026-07-23', '2026-07-24'],
    });
    expect(summary.failedDays).toEqual([]);
    expect(summary.stoppedBy).toContain(GUARD_MESSAGE);
    expect(summary.notRun).toEqual(['2026-07-23', '2026-07-24']);
    expect(summary.exitCode).toBe(1);
  });

  it('gives the exit code of a real run: 0 clean, 1 with a failed day, 1 when stopped', async () => {
    atTime(AFTER_CLOSE);
    const secrets = { uwKey: 'k-12345', databaseUrl: undefined };
    const opts = { allowMarketHours: false, secrets };
    const dates = ['2026-07-22', '2026-07-23'];

    const clean = await runDays(dates, opts, async () => 'ok');
    expect(summarizeRun(clean).exitCode).toBe(0);

    const failed = await runDays(dates, opts, async (date) => {
      if (date === dates[1]) throw new Error('boom');
      return 'ok';
    });
    expect(summarizeRun(failed).exitCode).toBe(1);

    atTime(MID_SESSION);
    const stopped = await runDays(dates, opts, async () => 'ok');
    expect(summarizeRun(stopped).exitCode).toBe(1);
  });
});

// ── the scripts under plain node ───────────────────────────

// Each test spawns node: Windows process spawn under full-suite
// multi-session load took 16.7 s (2026-10-29), past the 15 s testTimeout.
const CLI_TIMEOUT = 60_000;

describe('backfill-range-pos CLI', { timeout: CLI_TIMEOUT }, () => {
  // vitest runs from the repo root (same convention as check-coverage-floor).
  const cli = path.resolve(process.cwd(), 'scripts', 'backfill-range-pos.mjs');

  it('loads the shared module and its .ts calendar under plain node, and names a bad flag', () => {
    const env = { ...process.env };
    delete env.UW_API_KEY;
    delete env.DATABASE_URL;
    // Exits at argument parsing, before the guard and the env checks, so no
    // UW or DB call can start.
    const result = spawnSync(process.execPath, [cli, '--bogus'], {
      env,
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown argument: --bogus');
  });
});
