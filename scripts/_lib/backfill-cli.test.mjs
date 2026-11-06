// @vitest-environment node

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DayFailure,
  EXIT_BAD_ARGS,
  EXIT_FAILED,
  EXIT_GUARD_STOP,
  EXIT_OK,
  UW_REQUESTS_PER_MINUTE,
  WRITE_BATCH,
  chunk,
  classifyFailure,
  createRequestThrottle,
  formatRunSummary,
  isMarketHoursCt,
  marketHoursRefusal,
  parseArgs,
  parseRangeArgs,
  planRangeDays,
  redact,
  retryTransientDb,
  runDayItems,
  runDays,
  runPool,
  runTickerDays,
  selectDates,
  storeRows,
  summarizeByDay,
  summarizeFailures,
  summarizeItemRun,
  summarizeRun,
  tradingDaysInRange,
} from './backfill-cli.mjs';
import * as netPrem from './net-prem-ticks-backfill.mjs';
import * as rangePos from './range-pos-backfill.mjs';
import { fetchUwDayRows } from './uw-day-fetch.mjs';

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

  it('words a bad --limit generically: what it counts is the script’s own', () => {
    expect(() => parseArgs(['--limit', 'abc'])).toThrow(
      '--limit needs a whole number, got abc',
    );
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

  it('follows a cause chain to 5 causes deep and no further', async () => {
    const dbErr = await retryTransientDb(async () => {
      throw new Error('relation "nope" does not exist');
    }).catch((e) => e);
    // The error itself, then `links` wrappers each holding the last as cause.
    const wrap = (inner, links) => {
      let err = inner;
      for (let i = 0; i < links; i++) {
        err = new Error(`wrapped ${i}`, { cause: err });
      }
      return err;
    };

    expect(classifyFailure(wrap(dbErr, 0)).kind).toBe('db');
    expect(classifyFailure(wrap(dbErr, 5)).kind).toBe('db');
    expect(classifyFailure(wrap(dbErr, 6)).kind).toBe('other');
  });

  it('trusts the kind of a DayFailure as given, and reads a plain Error as other', () => {
    const message = '1 of 3 tickers failed; first (QQQ): down';

    expect(classifyFailure(new DayFailure('uw_http_503', message))).toEqual({
      kind: 'uw_http_503',
      detail: message,
    });
    expect(classifyFailure(new Error(message)).kind).toBe('other');
  });

  it.each([
    'uw_http_503',
    'uw_http_403',
    'network',
    'timeout',
    'malformed',
    'db',
    'other',
  ])('lets a DayFailure carry the kind %s', (kind) => {
    expect(new DayFailure(kind, 'why').kind).toBe(kind);
  });

  it.each([
    ['an unknown word', 'banana'],
    ['undefined', undefined],
    ['null', null],
    ['a number', 503],
    ['a kind with a newline', 'db\nother'],
    ['a kind with a trailing newline', 'db\n'],
    ['a kind in the wrong case', 'DB'],
    ['uw_http_ without a status', 'uw_http_'],
    ['uw_http_ with a non-numeric status', 'uw_http_5xx'],
  ])('rejects %s as a DayFailure kind, naming it', (_label, kind) => {
    let thrown;
    try {
      new DayFailure(kind, 'why');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown.message).toContain('DayFailure kind');
    expect(thrown.message).toContain(JSON.stringify(String(kind)));
    // The bad kind is quoted, so a newline in it can't break the message.
    expect(thrown.message).not.toMatch(/[\r\n]/);
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
      return { fetched: order.length * 10, stored: order.length };
    });

    expect(order).toEqual(DATES);
    expect(maxInFlight).toBe(1);
    expect(run).toEqual({
      days: [
        { date: '2026-07-22', ok: true, value: { fetched: 10, stored: 1 } },
        { date: '2026-07-23', ok: true, value: { fetched: 20, stored: 2 } },
        { date: '2026-07-24', ok: true, value: { fetched: 30, stored: 3 } },
      ],
      stoppedBy: null,
      notRun: [],
    });
  });

  it('keeps extra count fields a worker returns beside fetched and stored', async () => {
    atTime(AFTER_CLOSE);
    const value = { fetched: 405, stored: 390, duplicates: 15 };
    const run = await runDays(['2026-07-22'], after, async () => value);
    expect(run.days).toEqual([{ date: '2026-07-22', ok: true, value }]);
  });

  it.each([
    ['nothing', undefined, 'undefined'],
    ['null', null, 'null'],
    ['a string', 'done', 'string'],
    ['an array of rows', [{ start_time: 'x' }], 'an array'],
    [
      'a UW ok outcome (rows, not counts)',
      { kind: 'ok', rows: [1] },
      'keys kind, rows; fetched is undefined, stored is undefined',
    ],
    [
      'an empty UW outcome',
      { kind: 'empty' },
      'keys kind; fetched is undefined, stored is undefined',
    ],
    [
      'an object with no keys',
      {},
      'keys (none); fetched is undefined, stored is undefined',
    ],
    [
      'no stored count',
      { fetched: 5 },
      'keys fetched; fetched is 5, stored is undefined',
    ],
    [
      'a count that is a string',
      { fetched: '5', stored: 5 },
      'keys fetched, stored; fetched is string, stored is 5',
    ],
    [
      'a negative count',
      { fetched: 5, stored: -1 },
      'keys fetched, stored; fetched is 5, stored is -1',
    ],
    [
      'a fractional count',
      { fetched: 1.5, stored: 0 },
      'keys fetched, stored; fetched is 1.5, stored is 0',
    ],
  ])(
    'fails the day as other when the worker returns %s, not counts',
    async (_label, returned, described) => {
      atTime(AFTER_CLOSE);
      const run = await runDays(['2026-07-22'], after, async () => returned);
      expect(run.days).toEqual([
        {
          date: '2026-07-22',
          ok: false,
          failure: {
            kind: 'other',
            detail: `worker value must be { fetched, stored } as whole numbers ≥ 0, got ${described}`,
          },
        },
      ]);
    },
  );

  it('names the keys of a wrong worker value, never its values', async () => {
    atTime(AFTER_CLOSE);
    const run = await runDays(['2026-07-22'], after, async () => ({
      apiKey: 'sekret-value',
      rows: ['row-with-sekret'],
      fetched: 'sekret-count',
    }));

    const detail = run.days[0].failure.detail;
    expect(detail).toContain('got keys apiKey, rows, fetched;');
    expect(detail).toContain('fetched is string');
    expect(detail).not.toContain('sekret');
  });

  it('marks a key list cut at 10 with ", ..." and leaves a list of exactly 10 alone', async () => {
    atTime(AFTER_CLOSE);
    const withKeys = (count) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`k${i + 1}`, i]),
      );

    const cut = await runDays(['2026-07-22'], after, async () => withKeys(14));
    const exact = await runDays(['2026-07-22'], after, async () =>
      withKeys(10),
    );

    expect(cut.days[0].failure.detail).toContain(
      'got keys k1, k2, k3, k4, k5, k6, k7, k8, k9, k10, ...; fetched is',
    );
    expect(cut.days[0].failure.detail).not.toContain('k11');
    expect(exact.days[0].failure.detail).toContain(
      'got keys k1, k2, k3, k4, k5, k6, k7, k8, k9, k10; fetched is',
    );
    expect(exact.days[0].failure.detail).not.toContain('...');
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
      return { fetched: 1, stored: 1 };
    });

    expect(seen).toEqual(DATES);
    expect(run.days).toEqual([
      { date: '2026-07-22', ok: true, value: { fetched: 1, stored: 1 } },
      {
        date: '2026-07-23',
        ok: false,
        failure: {
          kind: 'db',
          detail: 'duplicate key value violates unique constraint "x"',
        },
      },
      { date: '2026-07-24', ok: true, value: { fetched: 1, stored: 1 } },
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
      return fail ? fail() : { fetched: 1, stored: 1 };
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

  it('stops taking new days once the 08:15 CT window opens, lets the day in flight finish, and says which are left', async () => {
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
      return { fetched: 1, stored: 1 };
    });

    // 08:14:20 and 08:14:40 run, the second finishing at 08:15:00 inside the
    // window; then the guard refuses the next day.
    expect(seen).toEqual(['2026-07-22', '2026-07-23']);
    expect(run.days.map((d) => d.date)).toEqual(['2026-07-22', '2026-07-23']);
    expect(run.days.every((d) => d.ok)).toBe(true);
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
      async () => ({ fetched: 1, stored: 1 }),
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

// ── runDayItems ────────────────────────────────────────────

describe('runDayItems', () => {
  afterEach(() => vi.useRealTimers());

  const secrets = {
    uwKey: 'uw-secret-key',
    databaseUrl: 'postgresql://owner:s3cr3t@ep-x.neon.tech/neondb',
  };
  const ITEMS = ['A', 'B', 'C'];
  const counts = { fetched: 10, stored: 8 };

  it('tries all three tickers when the second returns a 503, and fails the day as uw_http_503', async () => {
    atTime(AFTER_CLOSE);
    const tried = [];

    const run = await runDays(
      ['2026-07-22'],
      { allowMarketHours: false, secrets },
      () =>
        runDayItems(
          ['SPY', 'QQQ', 'IWM'],
          async (ticker) => {
            tried.push(ticker);
            if (ticker === 'QQQ') {
              return { kind: 'error', status: 'http_503', detail: 'down' };
            }
            return counts;
          },
          { label: 'tickers' },
        ),
    );

    expect(tried).toEqual(['SPY', 'QQQ', 'IWM']);
    expect(run.days).toEqual([
      {
        date: '2026-07-22',
        ok: false,
        failure: {
          kind: 'uw_http_503',
          detail: '1 of 3 tickers failed; first (QQQ): down',
        },
      },
    ]);
    expect(summarizeRun(run).exitCode).toBe(EXIT_FAILED);
  });

  it.each([
    [
      'an http_503 outcome',
      async () => ({ kind: 'error', status: 'http_503', detail: 'down' }),
      'uw_http_503',
      'down',
    ],
    [
      'an http_403 outcome',
      async () => ({ kind: 'error', status: 'http_403', detail: 'no plan' }),
      'uw_http_403',
      'no plan',
    ],
    [
      'a network outcome',
      async () => ({ kind: 'error', status: 'network', detail: 'reset' }),
      'network',
      'reset',
    ],
    [
      'a thrown TimeoutError',
      async () => {
        throw new DOMException('The operation timed out', 'TimeoutError');
      },
      'timeout',
      'The operation timed out',
    ],
    [
      'a thrown fetch failure',
      async () => {
        throw new TypeError('fetch failed');
      },
      'network',
      'fetch failed',
    ],
    [
      'a thrown SyntaxError',
      async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
      'malformed',
      'Unexpected end of JSON input',
    ],
    [
      'a db error thrown through retryTransientDb',
      async () => {
        await retryTransientDb(async () => {
          throw new Error('relation "t" does not exist');
        });
      },
      'db',
      'relation "t" does not exist',
    ],
    [
      'an ordinary error',
      async () => {
        throw new Error('boom');
      },
      'other',
      'boom',
    ],
    [
      'a raw UW ok outcome instead of counts',
      async () => ({ kind: 'ok', rows: [1] }),
      'other',
      'worker value must be { fetched, stored } as whole numbers ≥ 0, got keys kind, rows;',
    ],
  ])(
    'keeps the kind of %s, and still tries every item',
    async (_label, failing, kind, detail) => {
      const tried = [];

      const err = await runDayItems(ITEMS, async (item, index) => {
        tried.push(item);
        return index === 1 ? failing() : counts;
      }).catch((e) => e);

      expect(tried).toEqual(ITEMS);
      expect(err).toBeInstanceOf(DayFailure);
      expect(err.kind).toBe(kind);
      expect(err.message).toContain('1 of 3 items failed; first (B): ');
      expect(err.message).toContain(detail);
    },
  );

  it('sums the counts of a day whose items all succeed, extra numeric fields too', async () => {
    const totals = await runDayItems(ITEMS, async (item) => ({
      fetched: 10,
      stored: 8,
      skipped: item === 'B' ? 1 : 0,
      note: 'not a count',
    }));

    expect(totals).toEqual({ fetched: 30, stored: 24, skipped: 1 });
  });

  it('gives zero counts for a day with no items', async () => {
    const perItem = vi.fn();
    await expect(runDayItems([], perItem)).resolves.toEqual({
      fetched: 0,
      stored: 0,
    });
    expect(perItem).not.toHaveBeenCalled();
  });

  it('with concurrency above 1 still tries every item, and never more than that at once', async () => {
    const items = ['A', 'B', 'C', 'D', 'E', 'F'];
    const tried = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const err = await runDayItems(
      items,
      async (item) => {
        tried.push(item);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 3));
        inFlight--;
        // B fails at once; the rest are still to be tried.
        if (item === 'B') throw new Error('boom');
        return counts;
      },
      { concurrency: 3 },
    ).catch((e) => e);

    expect(tried.toSorted()).toEqual(items);
    expect(maxInFlight).toBe(3);
    expect(err.message).toContain('1 of 6 items failed; first (B): boom');
  });

  it('names the first failure in item order, not in completion order', async () => {
    const err = await runDayItems(
      ['A', 'B'],
      async (item) => {
        if (item === 'A') {
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error('slow a');
        }
        await retryTransientDb(async () => {
          throw new Error('fast b');
        });
      },
      { concurrency: 2 },
    ).catch((e) => e);

    expect(err.kind).toBe('other');
    expect(err.message).toBe('2 of 2 items failed; first (A): slow a');
  });

  it('names a numeric item by itself and any other item by its position', async () => {
    const byNumber = await runDayItems([4500, 4550], async (strike) => {
      if (strike === 4550) throw new Error('boom');
      return counts;
    }).catch((e) => e);
    expect(byNumber.message).toBe('1 of 2 items failed; first (4550): boom');

    const byPosition = await runDayItems(
      [{ ticker: 'SPY' }, { ticker: 'QQQ' }],
      async (_item, index) => {
        if (index === 1) throw new Error('boom');
        return counts;
      },
    ).catch((e) => e);
    expect(byPosition.message).toBe('1 of 2 items failed; first (#1): boom');
  });

  it('redacts the secrets from the failure when it runs under runDays', async () => {
    atTime(AFTER_CLOSE);
    const run = await runDays(
      ['2026-07-22'],
      { allowMarketHours: false, secrets },
      () =>
        runDayItems(['A'], async () => ({
          kind: 'error',
          status: 'http_401',
          detail: `bad key ${secrets.uwKey}`,
        })),
    );

    expect(run.days[0].failure).toEqual({
      kind: 'uw_http_401',
      detail: '1 of 1 items failed; first (A): bad key [redacted]',
    });
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects a concurrency of %s without trying anything',
    async (concurrency) => {
      const perItem = vi.fn(async () => counts);
      await expect(
        runDayItems(ITEMS, perItem, { concurrency }),
      ).rejects.toThrow('concurrency');
      expect(perItem).not.toHaveBeenCalled();
    },
  );
});

// ── runDays over the real UW fetch ─────────────────────────

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(text, status) {
  return { ok: false, status, json: async () => ({}), text: async () => text };
}

describe('runDays over the real fetchUwDayRows', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reads each failure the real producer gives as its own kind, and exits 1', async () => {
    // Date for the guard, timers for fetchUwDayRows's 1 s retry backoff.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(AFTER_CLOSE));
    const timedOut = () =>
      new DOMException('The operation timed out', 'TimeoutError');
    // One row per day. `fetches` are that day's fetch results in call order:
    // a 5xx, a 429, a network error or a timeout is tried twice.
    const cases = [
      {
        date: '2026-07-22',
        label: '503 twice',
        fetches: [
          textResponse('Service Unavailable', 503),
          textResponse('Service Unavailable', 503),
        ],
        kind: 'uw_http_503',
      },
      {
        date: '2026-07-23',
        label: 'a 403 outside the plan window',
        fetches: [textResponse('{"code":"historic_data_access_missing"}', 403)],
        kind: 'uw_http_403',
      },
      {
        date: '2026-07-24',
        label: 'fetch rejecting with TypeError fetch failed',
        fetches: [new TypeError('fetch failed'), new TypeError('fetch failed')],
        kind: 'network',
      },
      {
        date: '2026-07-27',
        label: 'a TimeoutError',
        fetches: [timedOut(), timedOut()],
        kind: 'timeout',
      },
      {
        date: '2026-07-28',
        label: 'a 200 whose body is not JSON',
        fetches: [
          {
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('Unexpected token < in JSON at position 0');
            },
          },
        ],
        kind: 'malformed',
      },
      {
        date: '2026-07-29',
        label: 'a 200 with a non-array data',
        fetches: [jsonResponse({ data: 'x' })],
        kind: 'malformed',
      },
    ];
    const fetchMock = vi.fn();
    for (const { fetches } of cases) {
      for (const result of fetches) {
        if (result instanceof Error) fetchMock.mockRejectedValueOnce(result);
        else fetchMock.mockResolvedValueOnce(result);
      }
    }
    vi.stubGlobal('fetch', fetchMock);
    const secrets = { uwKey: 'uw-key', databaseUrl: undefined };

    const pending = runDays(
      cases.map((c) => c.date),
      { allowMarketHours: false, secrets },
      async (date) => {
        const outcome = await fetchUwDayRows(
          `https://api.unusualwhales.com/api/stock/SPY/ohlc/1m?date=${date}`,
          secrets.uwKey,
          { rowField: 'start_time', rowLabel: 'candle', userAgent: 'test' },
        );
        if (outcome.kind === 'error') return outcome;
        return {
          fetched: outcome.kind === 'ok' ? outcome.rows.length : 0,
          stored: 0,
        };
      },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const run = await pending;

    expect(run.days.map((d) => d.date)).toEqual(cases.map((c) => c.date));
    cases.forEach((c, i) => {
      const day = run.days[i];
      expect(day.ok, c.label).toBe(false);
      expect(day.failure.kind, c.label).toBe(c.kind);
    });
    expect(fetchMock).toHaveBeenCalledTimes(9);
    expect(summarizeRun(run).exitCode).toBe(EXIT_FAILED);
  });
});

// ── summarizeRun ───────────────────────────────────────────

/** A hand-built failed day, as runDays gives one. */
const bad = (date, kind, detail = `${kind} detail`) => ({
  date,
  ok: false,
  failure: { kind, detail },
});

describe('summarizeRun', () => {
  afterEach(() => vi.useRealTimers());

  const ok = (date, fetched = 5, stored = fetched) => ({
    date,
    ok: true,
    value: { fetched, stored },
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
      okDays: [
        { date: '2026-07-22', value: { fetched: 5, stored: 5 } },
        { date: '2026-07-23', value: { fetched: 5, stored: 5 } },
      ],
      emptyDays: [],
      failedDays: [],
      byKind: [],
      stoppedBy: null,
      notRun: [],
      exitCode: EXIT_OK,
    });
  });

  it('pins the exit codes the scripts share', () => {
    expect([EXIT_OK, EXIT_FAILED, EXIT_BAD_ARGS, EXIT_GUARD_STOP]).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it('lists the done days that fetched nothing, and still exits 0', () => {
    const summary = summarizeRun({
      days: [
        ok('2026-07-22', 405, 390),
        ok('2026-07-23', 0, 0),
        bad('2026-07-24', 'db'),
        ok('2026-07-27', 0, 0),
        // Fetched rows but stored none (all already there): not empty.
        ok('2026-07-28', 12, 0),
      ],
      stoppedBy: null,
      notRun: [],
    });

    expect(summary.emptyDays).toEqual(['2026-07-23', '2026-07-27']);
    expect(summary.succeeded).toBe(4);
    // A failed day is a failure, not an empty day.
    expect(summary.emptyDays).not.toContain('2026-07-24');

    const onlyEmpty = summarizeRun({
      days: [ok('2026-07-23', 0, 0)],
      stoppedBy: null,
      notRun: [],
    });
    expect(onlyEmpty.emptyDays).toEqual(['2026-07-23']);
    expect(onlyEmpty.exitCode).toBe(EXIT_OK);
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
    expect(summary.exitCode).toBe(EXIT_FAILED);
  });

  it('breaks a tie between kinds by name', () => {
    const summary = summarizeRun({
      days: [bad('2026-07-22', 'timeout'), bad('2026-07-23', 'network')],
      stoppedBy: null,
      notRun: [],
    });
    expect(summary.byKind.map((k) => k.kind)).toEqual(['network', 'timeout']);
  });

  it('exits 3 for a run the market-hours guard stopped, when no day failed', () => {
    const summary = summarizeRun({
      days: [ok('2026-07-22')],
      stoppedBy: `Refusing to run ${GUARD_MESSAGE} on a weekday`,
      notRun: ['2026-07-23', '2026-07-24'],
    });
    expect(summary.failedDays).toEqual([]);
    expect(summary.stoppedBy).toContain(GUARD_MESSAGE);
    expect(summary.notRun).toEqual(['2026-07-23', '2026-07-24']);
    expect(summary.exitCode).toBe(EXIT_GUARD_STOP);
  });

  it('exits 1, not 3, when a day failed and the guard also stopped the run', () => {
    const summary = summarizeRun({
      days: [ok('2026-07-22'), bad('2026-07-23', 'db')],
      stoppedBy: `Refusing to run ${GUARD_MESSAGE} on a weekday`,
      notRun: ['2026-07-24'],
    });
    expect(summary.exitCode).toBe(EXIT_FAILED);
  });

  it('exits 3 when the guard stopped a run before its first day', () => {
    const summary = summarizeRun({
      days: [],
      stoppedBy: `Refusing to run ${GUARD_MESSAGE} on a weekday`,
      notRun: ['2026-07-22'],
    });
    expect(summary.attempted).toBe(0);
    expect(summary.exitCode).toBe(EXIT_GUARD_STOP);
  });

  it('gives the exit code of a real run: 0 clean, 1 with a failed day, 3 when stopped, 1 for both', async () => {
    atTime(AFTER_CLOSE);
    const secrets = { uwKey: 'k-12345', databaseUrl: undefined };
    const opts = { allowMarketHours: false, secrets };
    const dates = ['2026-07-22', '2026-07-23'];
    const counts = { fetched: 5, stored: 5 };

    const clean = await runDays(dates, opts, async () => counts);
    expect(summarizeRun(clean).exitCode).toBe(EXIT_OK);

    const failed = await runDays(dates, opts, async (date) => {
      if (date === dates[1]) throw new Error('boom');
      return counts;
    });
    expect(summarizeRun(failed).exitCode).toBe(EXIT_FAILED);

    atTime(MID_SESSION);
    const stopped = await runDays(dates, opts, async () => counts);
    expect(summarizeRun(stopped).exitCode).toBe(EXIT_GUARD_STOP);

    // 08:14:20 CT: the first day fails and runs past 08:15, so the second
    // day is refused. A failure wins over the stop.
    atTime(JUST_BEFORE_OPEN);
    const both = await runDays(dates, opts, async () => {
      vi.setSystemTime(Date.now() + 60_000);
      throw new Error('boom');
    });
    expect(both.stoppedBy).toContain(GUARD_MESSAGE);
    expect(summarizeRun(both).exitCode).toBe(EXIT_FAILED);
  });
});

// ── formatRunSummary ───────────────────────────────────────

describe('formatRunSummary', () => {
  const ok = (date, value) => ({ date, ok: true, value });

  it('prints each day, the failures by kind, the empty days, the guard stop and the days not run', () => {
    const summary = summarizeRun({
      days: [
        ok('2026-07-22', { fetched: 405, stored: 390 }),
        ok('2026-07-23', { fetched: 0, stored: 0 }),
        bad('2026-07-24', 'db', 'lost'),
        bad('2026-07-27', 'network', 'reset'),
        ok('2026-07-28', { fetched: 10, stored: 4, skipped: 6 }),
        bad('2026-07-29', 'db', 'gone'),
      ],
      stoppedBy: `Refusing to run ${GUARD_MESSAGE} on a weekday`,
      notRun: ['2026-07-30', '2026-07-31'],
    });

    expect(formatRunSummary(summary)).toEqual([
      'days: 6 run, 3 done, 3 failed',
      '  2026-07-22  fetched 405  stored 390',
      '  2026-07-23  fetched 0  stored 0',
      '  2026-07-28  fetched 10  stored 4  skipped 6',
      '  total       fetched 415  stored 394',
      'failures by kind:',
      '  db: 2 days (2026-07-24, 2026-07-29); first: 2026-07-24: lost',
      '  network: 1 day (2026-07-27); first: 2026-07-27: reset',
      'empty days (UW had no rows): 2026-07-23',
      `stopped: Refusing to run ${GUARD_MESSAGE} on a weekday`,
      'not run (2): 2026-07-30, 2026-07-31',
    ]);
  });

  it('collapses whitespace in a failure detail and an extra field, so a newline cannot break a line', () => {
    const summary = summarizeRun({
      days: [
        ok('2026-07-22', {
          fetched: 5,
          stored: 5,
          note: 'two\nlines\tand   gaps',
        }),
        bad(
          '2026-07-23',
          'other',
          'first line\nsecond line\r\n   third\tfourth ',
        ),
      ],
      stoppedBy: null,
      notRun: [],
    });

    const lines = formatRunSummary(summary);

    expect(lines).toContain(
      '  2026-07-22  fetched 5  stored 5  note two lines and gaps',
    );
    expect(lines).toContain(
      '  other: 1 day (2026-07-23); first: 2026-07-23: first line second line third fourth',
    );
    expect(lines.every((line) => !/[\r\n\t]/.test(line))).toBe(true);
  });

  it('prints only the day lines and the total for a clean run', () => {
    const summary = summarizeRun({
      days: [
        ok('2026-07-22', { fetched: 5, stored: 5 }),
        ok('2026-07-23', { fetched: 7, stored: 6 }),
      ],
      stoppedBy: null,
      notRun: [],
    });

    expect(formatRunSummary(summary)).toEqual([
      'days: 2 run, 2 done, 0 failed',
      '  2026-07-22  fetched 5  stored 5',
      '  2026-07-23  fetched 7  stored 6',
      '  total       fetched 12  stored 11',
    ]);
  });

  it('prints just the stop for a run the guard refused before any day', () => {
    const summary = summarizeRun({
      days: [],
      stoppedBy: 'refused',
      notRun: ['2026-07-22'],
    });
    expect(formatRunSummary(summary)).toEqual([
      'days: 0 run, 0 done, 0 failed',
      'stopped: refused',
      'not run (1): 2026-07-22',
    ]);
  });
});

// ── planRangeDays ──────────────────────────────────────────

describe('planRangeDays', () => {
  // 03:00 ET on 2026-11-06: the finished days end on the 5th.
  const NOW = '2026-11-06T08:00:00Z';
  const WHY = 'this backfill has no default window';

  afterEach(() => vi.useRealTimers());

  it('plans the trading days of the range, holidays skipped, and reads the flags', () => {
    atTime(NOW);
    // 2026-09-07 is Labor Day.
    const { args, dates } = planRangeDays(
      [
        '--from',
        '2026-09-03',
        '--to',
        '2026-09-08',
        '--dry-run',
        '--allow-market-hours',
      ],
      WHY,
    );
    expect(dates).toEqual(['2026-09-03', '2026-09-04', '2026-09-08']);
    expect(args).toMatchObject({ dryRun: true, allowMarketHours: true });
  });

  it('keeps the first N trading days of the range for --limit, in order', () => {
    atTime(NOW);
    const { dates } = planRangeDays(
      ['--from', '2026-07-22', '--to', '2026-09-04', '--limit', '3'],
      WHY,
    );
    expect(dates).toEqual(['2026-07-22', '2026-07-23', '2026-07-24']);
  });

  it.each([
    [[], '--from and --to are required: this backfill has no default window'],
    [['--dry-run'], '--from and --to are required'],
    [['--from', '2026-08-12'], '--from and --to go together'],
    [['--to', '2026-08-12'], '--from and --to go together'],
    [['--from', '2026-08-13', '--to', '2026-08-12'], 'is after --to'],
    [['5'], 'Unknown argument'],
    [['--from', '2026-08-12', '--to', '2026-08-12', '--limit', '0'], '--limit'],
    [
      ['--from', '2026-09-05', '--to', '2026-09-07'],
      'no trading days between --from 2026-09-05 and --to 2026-09-07',
    ],
  ])('rejects %j', (argv, message) => {
    atTime(NOW);
    expect(() => planRangeDays(argv, WHY)).toThrow(message);
  });

  it('refuses a range that reaches today: the live crons own the unfinished day', () => {
    atTime(NOW);
    expect(() =>
      planRangeDays(['--from', '2026-11-05', '--to', '2026-11-06'], WHY),
    ).toThrow('--to 2026-11-06 is not a finished day (today is 2026-11-06 ET)');
    expect(
      planRangeDays(['--from', '2026-11-05', '--to', '2026-11-05'], WHY).dates,
    ).toEqual(['2026-11-05']);
  });

  it('late in the evening CT, already the next day in ET, the day that just ended is finished and the new one is not', () => {
    // 23:30 CT on the 5th is 00:30 ET on the 6th.
    atTime('2026-11-06T05:30:00Z');
    expect(
      planRangeDays(['--from', '2026-11-05', '--to', '2026-11-05'], WHY).dates,
    ).toEqual(['2026-11-05']);
    expect(() =>
      planRangeDays(['--from', '2026-11-05', '--to', '2026-11-06'], WHY),
    ).toThrow(/is after today|not a finished day/);
  });
});

// ── storeRows ──────────────────────────────────────────────

describe('storeRows', () => {
  const TARGET = {
    table: 'demo_rows',
    columns: ['day', 'label', 'amount'],
    conflictTarget: '(day, label)',
  };
  const row = (n) => ({ day: '2026-08-12', label: `L${n}`, amount: n });

  /** A sql handle answering like RETURNING id: one row per row inserted. */
  function fakeSql({ conflicts = 0 } = {}) {
    return {
      query: vi.fn(async (_text, values) =>
        Array.from(
          { length: Math.max(0, values.length / 3 - conflicts) },
          (_, i) => ({ id: i }),
        ),
      ),
    };
  }

  afterEach(() => vi.useRealTimers());

  it('writes one multi-row INSERT ... ON CONFLICT DO NOTHING on the target key, every value a parameter', async () => {
    const sql = fakeSql();

    const stored = await storeRows(sql, TARGET, [row(1), row(2)], {
      dryRun: false,
    });

    expect(stored).toBe(2);
    expect(sql.query).toHaveBeenCalledTimes(1);
    const [text, values] = sql.query.mock.calls[0];
    expect(text).toBe(
      'INSERT INTO demo_rows (day, label, amount) VALUES ' +
        '($1, $2, $3), ($4, $5, $6) ' +
        'ON CONFLICT (day, label) DO NOTHING RETURNING id',
    );
    expect(values).toEqual(['2026-08-12', 'L1', 1, '2026-08-12', 'L2', 2]);
  });

  it('sends a missing field as NULL', async () => {
    const sql = fakeSql();
    await storeRows(sql, TARGET, [{ day: '2026-08-12', label: 'L1' }], {
      dryRun: false,
    });
    expect(sql.query.mock.calls[0][1]).toEqual(['2026-08-12', 'L1', null]);
  });

  it('splits the rows into statements of at most 500', async () => {
    const sql = fakeSql();
    const rows = Array.from({ length: 1200 }, (_, i) => row(i));

    const stored = await storeRows(sql, TARGET, rows, { dryRun: false });

    expect(WRITE_BATCH).toBe(500);
    expect(stored).toBe(1200);
    expect(sql.query.mock.calls.map(([, v]) => v.length / 3)).toEqual([
      500, 500, 200,
    ]);
  });

  it('counts only the rows ON CONFLICT let in', async () => {
    const sql = fakeSql({ conflicts: 2 });
    expect(
      await storeRows(sql, TARGET, [row(1), row(2), row(3), row(4), row(5)], {
        dryRun: false,
      }),
    ).toBe(3);
  });

  it('reads a fullResults-shaped answer too', async () => {
    const sql = {
      query: vi.fn(async () => ({ rows: [{ id: 1 }, { id: 2 }] })),
    };
    expect(
      await storeRows(sql, TARGET, [row(1), row(2)], { dryRun: false }),
    ).toBe(2);
  });

  it('writes nothing on a dry run, and nothing for no rows', async () => {
    const sql = fakeSql();
    expect(await storeRows(sql, TARGET, [row(1)], { dryRun: true })).toBe(0);
    expect(await storeRows(sql, TARGET, [], { dryRun: false })).toBe(0);
    expect(sql.query).not.toHaveBeenCalled();
  });

  it('labels a rejected write as a db failure, and keeps the error message', async () => {
    const sql = {
      query: vi.fn(async () => {
        throw new Error('relation "demo_rows" does not exist');
      }),
    };

    const err = await storeRows(sql, TARGET, [row(1)], { dryRun: false }).catch(
      (e) => e,
    );

    expect(classifyFailure(err)).toEqual({
      kind: 'db',
      detail: 'relation "demo_rows" does not exist',
    });
  });

  it('retries a transient Neon error, then stores the rows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce([{ id: 1 }]);

    const pending = storeRows({ query }, TARGET, [row(1)], { dryRun: false });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toBe(1);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('stops at the first chunk that fails: no later chunk is written', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ id: 1 }])
      .mockRejectedValueOnce(new Error('disk full'));
    const rows = Array.from({ length: 1200 }, (_, i) => row(i));

    await expect(
      storeRows({ query }, TARGET, rows, { dryRun: false }),
    ).rejects.toThrow('disk full');
    expect(query).toHaveBeenCalledTimes(2);
  });
});

// ── summarizeItemRun ───────────────────────────────────────

describe('summarizeItemRun', () => {
  const day = (date, value) => ({ date, ok: true, value });
  const counts = (fetched, emptyItems) => ({
    fetched,
    stored: fetched,
    emptyItems,
  });

  it('adds nothing to the shared summary when no day is partly empty', () => {
    const run = {
      days: [day('2026-08-12', counts(7, 0))],
      stoppedBy: null,
      notRun: [],
    };

    const { lines, exitCode } = summarizeItemRun(run, 2, 'tickers', 'bars');

    expect(lines).toEqual(formatRunSummary(summarizeRun(run)));
    expect(exitCode).toBe(EXIT_OK);
  });

  it('names the days where some, not all, of the items had no rows, once each, and still exits 0', () => {
    const run = {
      days: [
        day('2026-08-12', counts(4, 1)),
        day('2026-08-13', counts(9, 0)),
        day('2026-08-14', counts(3, 2)),
      ],
      stoppedBy: null,
      notRun: [],
    };

    const { lines, exitCode } = summarizeItemRun(run, 3, 'sources', 'rows');

    expect(lines.at(-1)).toBe(
      'partly empty days (UW had no rows for some of the 3 sources; ' +
        'a hole to look at, not a failure): ' +
        '2026-08-12 (1 empty), 2026-08-14 (2 empty)',
    );
    expect(exitCode).toBe(EXIT_OK);
  });

  it('uses the row noun it is given', () => {
    const run = {
      days: [day('2026-08-12', counts(4, 1))],
      stoppedBy: null,
      notRun: [],
    };
    expect(summarizeItemRun(run, 2, 'tickers', 'bars').lines.at(-1)).toContain(
      'UW had no bars for some of the 2 tickers',
    );
  });

  it('leaves a wholly empty day to the shared empty-days line, and a failed day out', () => {
    const run = {
      days: [
        day('2026-08-12', counts(0, 2)),
        bad('2026-08-13', 'uw_http_503', 'down'),
      ],
      stoppedBy: null,
      notRun: [],
    };

    const { lines, exitCode } = summarizeItemRun(run, 2, 'tickers', 'rows');

    expect(lines).toContain('empty days (UW had no rows): 2026-08-12');
    expect(lines.join('\n')).not.toContain('partly empty');
    expect(exitCode).toBe(EXIT_FAILED);
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
    // A minimal env: PATH, and the SystemRoot node needs on Windows. No real
    // UW key or database URL reaches the script whatever order it checks in.
    const env = {};
    for (const name of ['PATH', 'SystemRoot']) {
      if (process.env[name] != null) env[name] = process.env[name];
    }
    // Exits at argument parsing, before the guard and the env checks.
    const result = spawnSync(process.execPath, [cli, '--bogus'], {
      env,
      encoding: 'utf8',
    });

    expect(result.status).toBe(EXIT_BAD_ARGS);
    expect(result.stderr).toContain('Unknown argument: --bogus');
  });
});
