// @vitest-environment node

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NET_FLOW_SOURCE,
  UW_REQUESTS_PER_MINUTE,
  UW_USER_AGENT,
  createRequestThrottle,
  fetchNetPremTicks,
  marketHoursRefusal,
  parseArgs,
  planPairs,
  runTickerDays,
  selectDates,
  storeBatch,
  summarizeByDay,
  tradingDaysInRange,
} from './net-prem-ticks-backfill.mjs';

// 2026-10-29 is a Thursday, CDT (UTC−5). 22:00 UTC = 17:00 CT, after the
// close, so the market-hours guard is quiet unless a test moves the clock.
const AFTER_CLOSE = '2026-10-29T22:00:00Z';

function atTime(iso) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

// ── args ───────────────────────────────────────────────────

describe('parseArgs', () => {
  afterEach(() => vi.useRealTimers());

  it('defaults to the DAYS lookback: a full, writing run that refuses market hours', () => {
    atTime(AFTER_CLOSE);
    expect(parseArgs([])).toEqual({
      dryRun: false,
      allowMarketHours: false,
      limit: null,
      from: null,
      to: null,
    });
  });

  it('reads a date range and the range-pos guards', () => {
    atTime(AFTER_CLOSE);
    expect(
      parseArgs([
        '--from',
        '2026-07-22',
        '--to',
        '2026-09-04',
        '--dry-run',
        '--limit',
        '86',
        '--allow-market-hours',
      ]),
    ).toEqual({
      dryRun: true,
      allowMarketHours: true,
      limit: 86,
      from: '2026-07-22',
      to: '2026-09-04',
    });
  });

  it('accepts --to today', () => {
    atTime(AFTER_CLOSE);
    expect(parseArgs(['--from', '2026-10-29', '--to', '2026-10-29']).to).toBe(
      '2026-10-29',
    );
  });

  it.each([
    [['--from', '2026-07-22'], '--from and --to go together'],
    [['--to', '2026-09-04'], '--from and --to go together'],
    [
      ['--from', '2026-10-28', '--to', '2026-10-30'],
      '--to 2026-10-30 is after today (2026-10-29 CT)',
    ],
    [['--from', '2026-09-04', '--to', '2026-07-22'], '--from'],
    [['--from', '2026-07-32', '--to', '2026-09-04'], '--from'],
    [['--limit', '0'], '--limit'],
    [['--days', '30'], 'Unknown argument'],
  ])('rejects %j', (argv, message) => {
    atTime(AFTER_CLOSE);
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it('reads today in CT, not UTC, late in the evening', () => {
    // 03:00 UTC on the 30th is 22:00 CT on the 29th: the 30th is tomorrow.
    atTime('2026-10-30T03:00:00Z');
    expect(() =>
      parseArgs(['--from', '2026-10-29', '--to', '2026-10-30']),
    ).toThrow('after today (2026-10-29 CT)');
  });
});

// ── market-hours guard ─────────────────────────────────────

describe('marketHoursRefusal', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    // 2026-10-29 is a Thursday, CDT (UTC−5).
    ['08:14 CT Thursday', '2026-10-29T13:14:00Z', false],
    ['08:15 CT Thursday', '2026-10-29T13:15:00Z', true],
    ['12:00 CT Thursday', '2026-10-29T17:00:00Z', true],
    ['15:29 CT Thursday', '2026-10-29T20:29:00Z', true],
    ['15:30 CT Thursday', '2026-10-29T20:30:00Z', false],
    ['10:00 CT Saturday', '2026-10-31T15:00:00Z', false],
    // 2026-11-02 is a Monday after DST ends, CST (UTC−6).
    ['08:10 CST Monday', '2026-11-02T14:10:00Z', false],
    ['08:15 CST Monday', '2026-11-02T14:15:00Z', true],
  ])('%s (%s) → refused: %s', (_label, iso, refused) => {
    atTime(iso);
    const message = marketHoursRefusal({ allowMarketHours: false });
    if (refused) {
      expect(message).toContain('08:15–15:30 CT');
      expect(message).toContain('--allow-market-hours');
    } else {
      expect(message).toBeNull();
    }
  });

  it('lets --allow-market-hours start inside the window', () => {
    atTime('2026-10-29T17:00:00Z');
    expect(marketHoursRefusal({ allowMarketHours: true })).toBeNull();
  });
});

// ── dates ──────────────────────────────────────────────────

describe('tradingDaysInRange', () => {
  it.each([
    ['a single day', '2026-07-23', '2026-07-23', ['2026-07-23']],
    [
      'Wed→Fri',
      '2026-07-22',
      '2026-07-24',
      ['2026-07-22', '2026-07-23', '2026-07-24'],
    ],
    ['a weekend', '2026-07-24', '2026-07-27', ['2026-07-24', '2026-07-27']],
    ['only a weekend', '2026-07-25', '2026-07-26', []],
    [
      'Labor Day and its weekend',
      '2026-09-04',
      '2026-09-08',
      ['2026-09-04', '2026-09-08'],
    ],
    ['Labor Day alone', '2026-09-07', '2026-09-07', []],
    [
      'Independence Day observed (Fri 07-03)',
      '2026-07-02',
      '2026-07-06',
      ['2026-07-02', '2026-07-06'],
    ],
    [
      'the DST start weekend',
      '2026-03-06',
      '2026-03-09',
      ['2026-03-06', '2026-03-09'],
    ],
    [
      'the DST end weekend',
      '2026-10-30',
      '2026-11-02',
      ['2026-10-30', '2026-11-02'],
    ],
    [
      'a month boundary',
      '2026-07-31',
      '2026-08-03',
      ['2026-07-31', '2026-08-03'],
    ],
  ])('%s: %s → %s', (_label, from, to, expected) => {
    expect(tradingDaysInRange(from, to)).toEqual(expected);
  });

  it('gives the 33 trading days of the summer gap, 07-22 → 09-04', () => {
    const days = tradingDaysInRange('2026-07-22', '2026-09-04');
    expect(days).toHaveLength(33);
    expect(days[0]).toBe('2026-07-22');
    expect(days.at(-1)).toBe('2026-09-04');
    expect(days.filter((d) => d.startsWith('2026-08'))).toHaveLength(21);
  });
});

describe('selectDates', () => {
  afterEach(() => vi.useRealTimers());

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

  it('keeps the original lookback without a range: DAYS weekdays ending today', () => {
    atTime(AFTER_CLOSE);
    const { mode, dates } = selectDates({ from: null, to: null }, 5);
    expect(mode).toBe('lookback');
    expect(dates).toEqual([
      '2026-10-23',
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
    ]);
  });

  it.each([Number.NaN, 0, 2.5])('rejects DAYS=%s', (days) => {
    expect(() => selectDates({ from: null, to: null }, days)).toThrow('DAYS');
  });
});

// ── plan ───────────────────────────────────────────────────

describe('planPairs', () => {
  const dates = ['2026-07-22', '2026-07-23', '2026-07-24'];
  const tickers = ['SPY', 'TSLA'];
  // Live data runs to late October, after every gap date.
  const maxDateByTicker = new Map([
    ['SPY', '2026-10-28'],
    ['TSLA', '2026-07-23'],
  ]);

  it('fetches every pair of a range, date by date, whatever is already stored', () => {
    expect(
      planPairs({
        mode: 'range',
        dates,
        tickers,
        maxDateByTicker,
        bypassResume: false,
        limit: null,
      }),
    ).toEqual({
      pairs: [
        { ticker: 'SPY', date: '2026-07-22' },
        { ticker: 'TSLA', date: '2026-07-22' },
        { ticker: 'SPY', date: '2026-07-23' },
        { ticker: 'TSLA', date: '2026-07-23' },
        { ticker: 'SPY', date: '2026-07-24' },
        { ticker: 'TSLA', date: '2026-07-24' },
      ],
      planned: 6,
      skipped: 0,
    });
  });

  it('keeps the lookback resume rule: skip dates before the newest stored date', () => {
    const plan = planPairs({
      mode: 'lookback',
      dates,
      tickers: ['SPY', 'TSLA', 'NVDA'],
      maxDateByTicker,
      bypassResume: false,
      limit: null,
    });
    expect(plan.pairs).toEqual([
      // TSLA's newest date is refetched in case it was partial.
      { ticker: 'NVDA', date: '2026-07-22' },
      { ticker: 'TSLA', date: '2026-07-23' },
      { ticker: 'NVDA', date: '2026-07-23' },
      { ticker: 'TSLA', date: '2026-07-24' },
      { ticker: 'NVDA', date: '2026-07-24' },
    ]);
    expect(plan.skipped).toBe(4);
  });

  it('fetches everything in a lookback with BYPASS_RESUME', () => {
    const plan = planPairs({
      mode: 'lookback',
      dates,
      tickers,
      maxDateByTicker,
      bypassResume: true,
      limit: null,
    });
    expect(plan.planned).toBe(6);
    expect(plan.skipped).toBe(0);
  });

  it('applies --limit after planning, so the projection can scale to the whole plan', () => {
    const plan = planPairs({
      mode: 'range',
      dates,
      tickers,
      maxDateByTicker,
      bypassResume: false,
      limit: 3,
    });
    expect(plan.pairs).toEqual([
      { ticker: 'SPY', date: '2026-07-22' },
      { ticker: 'TSLA', date: '2026-07-22' },
      { ticker: 'SPY', date: '2026-07-23' },
    ]);
    expect(plan.planned).toBe(6);
  });
});

// ── throttle ───────────────────────────────────────────────

describe('createRequestThrottle', () => {
  afterEach(() => vi.useRealTimers());

  const T0 = Date.parse('2026-10-29T22:00:00Z');

  /** Run `count` waits across `lanes` concurrent lanes; return start times. */
  async function startTimes(wait, count, lanes, advanceMs) {
    const starts = [];
    let next = 0;
    const lane = async () => {
      while (next < count) {
        next++;
        await wait();
        starts.push(Date.now());
      }
    };
    const all = Promise.all(Array.from({ length: lanes }, lane));
    await vi.advanceTimersByTimeAsync(advanceMs);
    await all;
    return starts.map((t) => t - T0);
  }

  it('spaces starts 200 ms apart at 300 a minute', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const wait = createRequestThrottle(300);
    expect(await startTimes(wait, 5, 3, 1_000)).toEqual([
      0, 200, 400, 600, 800,
    ]);
  });

  it('never lets a 60 s window hold more than the limit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const wait = createRequestThrottle(UW_REQUESTS_PER_MINUTE);
    const starts = await startTimes(wait, 900, 3, 200_000);
    expect(starts).toHaveLength(900);
    let worst = 0;
    for (let i = 0, j = 0; i < starts.length; i++) {
      while (starts[i] - starts[j] >= 60_000) j++;
      worst = Math.max(worst, i - j + 1);
    }
    expect(worst).toBe(UW_REQUESTS_PER_MINUTE);
  });

  it('starts at once after an idle spell instead of bursting to catch up', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const wait = createRequestThrottle(300);
    await wait();
    await vi.advanceTimersByTimeAsync(10_000);
    const later = await startTimes(wait, 2, 2, 1_000);
    expect(later).toEqual([10_000, 10_200]);
  });

  it('pins the spec ceiling of 300 UW requests a minute', () => {
    expect(UW_REQUESTS_PER_MINUTE).toBe(300);
  });

  it.each([0, -5, 1.5, Number.NaN])('rejects a rate of %s', (rate) => {
    expect(() => createRequestThrottle(rate)).toThrow('perMinute');
  });
});

// ── UW fetch ───────────────────────────────────────────────

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(text, status) {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError('not JSON');
    },
    text: async () => text,
  };
}

const TICKS = [
  {
    tape_time: '2026-07-23T13:30:00Z',
    net_call_premium: '12500.00',
    net_put_premium: '-3000.00',
  },
  {
    tape_time: '2026-07-23T13:31:00Z',
    net_call_premium: '400.00',
    net_put_premium: '0',
  },
];

describe('fetchNetPremTicks', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function stubFetch(...responses) {
    const fetchMock = vi.fn();
    for (const r of responses) {
      if (r instanceof Error) fetchMock.mockRejectedValueOnce(r);
      else fetchMock.mockResolvedValueOnce(r);
    }
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  // Runs with timers faked so the one-retry backoff elapses at once.
  async function fetchWithFakeTimers(waitForSlot = vi.fn(async () => {})) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = fetchNetPremTicks(
      'uw-key',
      'SPY',
      '2026-07-23',
      waitForSlot,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    return pending;
  }

  it('returns the ticks and sends the key, an explicit User-Agent and a timeout', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: TICKS }));
    const waitForSlot = vi.fn(async () => {});

    await expect(
      fetchNetPremTicks('uw-key', 'SPY', '2026-07-23', waitForSlot),
    ).resolves.toEqual({ kind: 'ok', rows: TICKS });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.unusualwhales.com/api/stock/SPY/net-prem-ticks?date=2026-07-23',
    );
    expect(init.headers).toEqual({
      Authorization: 'Bearer uw-key',
      'User-Agent': UW_USER_AGENT,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(UW_USER_AGENT).not.toMatch(/python|urllib/i);
    expect(waitForSlot).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an empty array', { data: [] }],
    ['a null data', { data: null }],
    ['no data key', {}],
  ])('reports %s as an empty day', async (_label, body) => {
    stubFetch(jsonResponse(body));
    await expect(fetchWithFakeTimers()).resolves.toEqual({ kind: 'empty' });
  });

  it('reports a 403 outside the plan window as a failure, not an empty day', async () => {
    const body = '{"code":"historic_data_access_missing"}';
    const fetchMock = stubFetch(textResponse(body, 403));

    await expect(fetchWithFakeTimers()).resolves.toEqual({
      kind: 'error',
      status: 'http_403',
      detail: body,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a 503', textResponse('Service Unavailable', 503)],
    ['a 429', textResponse('You have exceeded 3 concurrent requests', 429)],
    ['a network error', new TypeError('fetch failed')],
  ])(
    'retries %s once, through the throttle, then succeeds',
    async (_label, first) => {
      const fetchMock = stubFetch(first, jsonResponse({ data: TICKS }));
      const waitForSlot = vi.fn(async () => {});

      await expect(fetchWithFakeTimers(waitForSlot)).resolves.toEqual({
        kind: 'ok',
        rows: TICKS,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(waitForSlot).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    [
      'a 503',
      textResponse('down', 503),
      { kind: 'error', status: 'http_503', detail: 'down' },
    ],
    [
      'a network error',
      new TypeError('fetch failed'),
      { kind: 'error', status: 'network', detail: 'fetch failed' },
    ],
    [
      'a timeout',
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ),
      {
        kind: 'error',
        status: 'timeout',
        detail: 'The operation was aborted due to timeout',
      },
    ],
  ])('gives up after one retry on %s', async (_label, failure, outcome) => {
    const fetchMock = stubFetch(failure, failure);

    await expect(fetchWithFakeTimers()).resolves.toEqual(outcome);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'data that is not an array',
      jsonResponse({ data: 'x' }),
      'data is string, not an array',
    ],
    [
      'a tick with no tape_time',
      jsonResponse({ data: [{ net_call_premium: '1' }] }),
      'tick 0 has no tape_time',
    ],
    [
      'a body that is not JSON',
      {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      },
      'Unexpected token < in JSON at position 0',
    ],
  ])(
    'reports %s as malformed without retrying',
    async (_label, response, detail) => {
      const fetchMock = stubFetch(response);

      await expect(fetchWithFakeTimers()).resolves.toEqual({
        kind: 'error',
        status: 'malformed',
        detail,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
});

// ── report ─────────────────────────────────────────────────

describe('summarizeByDay', () => {
  it('totals each date, ascending, and counts ok, empty and failed ticker-days', () => {
    const results = [
      { date: '2026-07-23', kind: 'ok', fetched: 405, kept: 390, stored: 390 },
      { date: '2026-07-22', kind: 'ok', fetched: 405, kept: 390, stored: 80 },
      { date: '2026-07-23', kind: 'empty', fetched: 0, kept: 0, stored: 0 },
      { date: '2026-07-23', kind: 'error', fetched: 0, kept: 0, stored: 0 },
      { date: '2026-07-23', kind: 'ok', fetched: 10, kept: 4, stored: 4 },
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
        tickers: 4,
        ok: 2,
        empty: 1,
        failed: 1,
        fetched: 415,
        kept: 394,
        stored: 394,
      },
    ]);
  });

  it('is empty for no results', () => {
    expect(summarizeByDay([])).toEqual([]);
  });
});

// ── Neon write ─────────────────────────────────────────────

function tickRow(i) {
  return {
    ticker: 'SPY',
    ts: `2026-07-23T13:${String(30 + i).padStart(2, '0')}:00Z`,
    netCallPrem: 100 + i,
    netCallVol: 10,
    netPutPrem: -50,
    netPutVol: 5,
    callVolume: 20,
    callVolumeAsk: 12,
    callVolumeBid: 8,
    putVolume: 9,
    putVolumeAsk: 4,
    putVolumeBid: 5,
  };
}

describe('storeBatch', () => {
  afterEach(() => vi.useRealTimers());

  /** A Neon client whose sql.query answers one RETURNING row per input row. */
  function fakeSql() {
    return {
      query: vi.fn(async (_text, values) =>
        Array.from({ length: values.length / 13 }, (_, i) => ({ id: i })),
      ),
    };
  }

  it('inserts batchSize rows per statement, all 13 columns, tagged rest', async () => {
    const sql = fakeSql();
    const rows = [0, 1, 2, 3, 4].map(tickRow);

    await expect(
      storeBatch(sql, rows, { batchSize: 2, dryRun: false }),
    ).resolves.toBe(5);

    expect(sql.query).toHaveBeenCalledTimes(3);
    const [firstText, firstValues] = sql.query.mock.calls[0];
    expect(firstValues).toHaveLength(26);
    expect(firstText).toContain('($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)');
    expect(firstText).toContain('($14,');
    expect(firstText).toContain('ON CONFLICT (ticker, ts, source) DO NOTHING');
    expect(firstValues.slice(0, 13)).toEqual([
      'SPY',
      '2026-07-23T13:30:00Z',
      100,
      10,
      -50,
      5,
      20,
      12,
      8,
      9,
      4,
      5,
      NET_FLOW_SOURCE,
    ]);
    expect(NET_FLOW_SOURCE).toBe('rest');
    expect(sql.query.mock.calls[2][1]).toHaveLength(13);
  });

  it('counts only the rows Neon reports as new (ON CONFLICT skips the rest)', async () => {
    const sql = { query: vi.fn(async () => ({ rows: [{ id: 7 }] })) };
    await expect(
      storeBatch(sql, [tickRow(0), tickRow(1)], {
        batchSize: 500,
        dryRun: false,
      }),
    ).resolves.toBe(1);
  });

  it('rejects with the error on a genuine SQL failure, without retrying', async () => {
    const sql = {
      query: vi.fn(async () => {
        throw new Error(
          'column "net_call_prem" is of type numeric but expression is of type text',
        );
      }),
    };
    await expect(
      storeBatch(sql, [tickRow(0)], { batchSize: 500, dryRun: false }),
    ).rejects.toThrow('column "net_call_prem" is of type numeric');
    expect(sql.query).toHaveBeenCalledTimes(1);
  });

  it('retries a transient Neon error and stores the batch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const sql = {
      query: vi
        .fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce([{ id: 1 }]),
    };
    const pending = storeBatch(sql, [tickRow(0)], {
      batchSize: 500,
      dryRun: false,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBe(1);
    expect(sql.query).toHaveBeenCalledTimes(2);
  });

  it('writes nothing on a dry run and reports what it would write', async () => {
    const sql = fakeSql();
    await expect(
      storeBatch(sql, [tickRow(0), tickRow(1)], {
        batchSize: 500,
        dryRun: true,
      }),
    ).resolves.toBe(2);
    expect(sql.query).not.toHaveBeenCalled();
  });
});

// ── guarded run loop ───────────────────────────────────────

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
    // 13:14:20 UTC on Thursday 2026-10-29 is 08:14:20 CDT.
    atTime('2026-10-29T13:14:20Z');
    const { seen, processPair } = slowPairs();

    const stoppedBy = await runTickerDays(
      pairs,
      { concurrency: 1, allowMarketHours: false },
      processPair,
    );

    // 08:14:20 and 08:14:40 run; at 08:15:00 the guard refuses.
    expect(seen).toEqual(['T0', 'T1']);
    expect(stoppedBy).toContain('08:15–15:30 CT');
  });

  it('runs straight through with --allow-market-hours', async () => {
    atTime('2026-10-29T13:14:20Z');
    const { seen, processPair } = slowPairs();

    await expect(
      runTickerDays(
        pairs,
        { concurrency: 3, allowMarketHours: true },
        processPair,
      ),
    ).resolves.toBeNull();
    expect(seen).toHaveLength(10);
  });

  it('runs every pair after the close', async () => {
    atTime(AFTER_CLOSE);
    const { seen, processPair } = slowPairs();
    await expect(
      runTickerDays(
        pairs,
        { concurrency: 3, allowMarketHours: false },
        processPair,
      ),
    ).resolves.toBeNull();
    expect(seen).toHaveLength(10);
  });

  it('rejects when a ticker-day fails', async () => {
    atTime(AFTER_CLOSE);
    await expect(
      runTickerDays(
        pairs,
        { concurrency: 2, allowMarketHours: false },
        async () => {
          throw new Error('db attempt timeout after 30000 ms');
        },
      ),
    ).rejects.toThrow('db attempt timeout');
  });
});

// ── the script under plain node ────────────────────────────

// Each test spawns node: Windows process spawn under full-suite
// multi-session load took 16.7 s (2026-10-29), past the 15 s testTimeout.
const CLI_TIMEOUT = 60_000;

describe('backfill-net-prem-ticks CLI', { timeout: CLI_TIMEOUT }, () => {
  // vitest runs from the repo root (same convention as check-coverage-floor).
  const cli = path.resolve(
    process.cwd(),
    'scripts',
    'backfill-net-prem-ticks.mjs',
  );

  function runCli(args) {
    const env = { ...process.env };
    delete env.UW_API_KEY;
    delete env.DATABASE_URL;
    return spawnSync(process.execPath, [cli, ...args], {
      env,
      encoding: 'utf8',
    });
  }

  it('loads its .ts calendar under plain node and refuses a range with no trading day', () => {
    // 09-05/06 is a weekend and 09-07 Labor Day. This exits before the
    // market-hours guard and the env checks, so no UW or DB call can start.
    const result = runCli(['--from', '2026-09-05', '--to', '2026-09-07']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'no trading days between --from 2026-09-05 and --to 2026-09-07',
    );
  });

  it('exits 2 naming the flag for half a range', () => {
    const result = runCli(['--from', '2026-07-22']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--from and --to go together');
  });
});
