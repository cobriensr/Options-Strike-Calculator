// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CASH_INDEX_ROOTS as API_CASH_INDEX_ROOTS } from '../../api/_lib/constants.ts';
import { computeRangePos as cronComputeRangePos } from '../../api/_lib/uw-stock-candles.ts';
import {
  CASH_INDEX_ROOTS,
  UW_USER_AGENT,
  chunk,
  computeRangePos,
  fetchDayCandles,
  isMarketHoursCt,
  mergeMonthCounts,
  parseArgs,
  rangePosUpdates,
  redact,
  retryTransientDb,
  runPool,
  selectionWindow,
  summarizeFailures,
  takeReadyChunks,
} from './range-pos-backfill.mjs';

// ── computeRangePos parity with the cron ───────────────────

// Deterministic LCG so a failure reproduces exactly.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomCase(next) {
  const sessionStart = Date.parse('2026-05-08T13:30:00Z');
  const n = Math.floor(next() * 8);
  const candles = [];
  for (let i = 0; i < n; i++) {
    const startMs = sessionStart + Math.floor(next() * 390) * 60_000;
    const low = 90 + next() * 20;
    const high = low + next() * 5 * (next() < 0.1 ? 0 : 1);
    const garble = next();
    candles.push({
      start_time:
        garble < 0.05 ? 'not-a-time' : new Date(startMs).toISOString(),
      open: String(low),
      high: garble > 0.95 ? '' : String(high),
      low: garble > 0.9 && garble <= 0.95 ? 'abc' : String(low),
      close: String(high),
    });
  }
  const triggerMs = sessionStart + Math.floor(next() * 420 - 15) * 60_000;
  const pick = next();
  const trigger =
    pick < 0.4
      ? new Date(triggerMs)
      : pick < 0.95
        ? new Date(triggerMs).toISOString()
        : 'garbage';
  const spot = 85 + next() * 35;
  return { candles, trigger, spot };
}

describe('computeRangePos (port of api/_lib/uw-stock-candles.ts)', () => {
  it('matches the cron on 2,000 generated cases', () => {
    const next = rng(20261028);
    for (let i = 0; i < 2_000; i++) {
      const { candles, trigger, spot } = randomCase(next);
      expect(computeRangePos(candles, trigger, spot), `case ${i}`).toBe(
        cronComputeRangePos(candles, trigger, spot),
      );
    }
  });

  it.each([
    ['no candles', [], '2026-05-08T14:30:00Z', 100],
    [
      'every candle after the trigger',
      [{ start_time: '2026-05-08T14:31:00Z', high: '110', low: '100' }],
      '2026-05-08T14:30:00Z',
      105,
    ],
    [
      'a flat bar',
      [{ start_time: '2026-05-08T14:00:00Z', high: '100', low: '100' }],
      '2026-05-08T14:01:00Z',
      100,
    ],
    [
      'spot above the high (clamps to 1)',
      [{ start_time: '2026-05-08T14:00:00Z', high: '110', low: '100' }],
      '2026-05-08T14:01:00Z',
      115,
    ],
    [
      'a NaN spot',
      [{ start_time: '2026-05-08T14:00:00Z', high: '110', low: '100' }],
      '2026-05-08T14:01:00Z',
      Number.NaN,
    ],
  ])('matches the cron for %s', (_label, candles, trigger, spot) => {
    expect(computeRangePos(candles, trigger, spot)).toBe(
      cronComputeRangePos(candles, trigger, spot),
    );
  });
});

describe('CASH_INDEX_ROOTS', () => {
  it('mirrors api/_lib/constants.ts exactly', () => {
    expect([...CASH_INDEX_ROOTS].sort()).toEqual(
      [...API_CASH_INDEX_ROOTS].sort(),
    );
  });
});

// ── args + selection window ────────────────────────────────

describe('parseArgs', () => {
  it('defaults to a full, writing run that refuses market hours', () => {
    expect(parseArgs([])).toEqual({
      dryRun: false,
      allowMarketHours: false,
      limit: null,
      from: null,
      to: null,
    });
  });

  it('reads --dry-run, --allow-market-hours, --limit, --from and --to', () => {
    expect(
      parseArgs([
        '--dry-run',
        '--allow-market-hours',
        '--limit',
        '50',
        '--from',
        '2026-01-02',
        '--to',
        '2026-05-18',
      ]),
    ).toEqual({
      dryRun: true,
      allowMarketHours: true,
      limit: 50,
      from: '2026-01-02',
      to: '2026-05-18',
    });
  });

  it.each([
    [['--limit', '0'], '--limit'],
    [['--limit', 'abc'], '--limit'],
    [['--limit'], '--limit'],
    [['--from', '2026-13-01'], '--from'],
    [['--to', '05/18/2026'], '--to'],
    [['--from', '2026-05-18', '--to', '2026-05-01'], '--from'],
    [['--force'], 'Unknown argument'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe('selectionWindow', () => {
  afterEach(() => vi.useRealTimers());

  it("stops before today's CT session, whatever --to says", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 15:00 UTC = 10:00 CT on 2026-10-28: today's session is live.
    vi.setSystemTime(new Date('2026-10-28T15:00:00Z'));
    expect(selectionWindow({ from: '2026-10-01', to: '2026-12-31' })).toEqual({
      from: '2026-10-01',
      to: '2026-12-31',
      before: '2026-10-28',
    });
  });

  it('uses the CT date late in the evening, when UTC has rolled over', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 03:00 UTC on the 29th = 22:00 CT on the 28th.
    vi.setSystemTime(new Date('2026-10-29T03:00:00Z'));
    expect(selectionWindow({ from: null, to: null })).toEqual({
      from: null,
      to: null,
      before: '2026-10-28',
    });
  });
});

describe('isMarketHoursCt', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    // 2026-10-28 is a Wednesday, CDT (UTC−5).
    ['08:14 CT Wednesday', '2026-10-28T13:14:00Z', false],
    ['08:15 CT Wednesday', '2026-10-28T13:15:00Z', true],
    ['15:29 CT Wednesday', '2026-10-28T20:29:00Z', true],
    ['15:30 CT Wednesday', '2026-10-28T20:30:00Z', false],
    ['22:00 CT Wednesday', '2026-10-29T03:00:00Z', false],
    ['10:00 CT Saturday', '2026-10-31T15:00:00Z', false],
    // 2026-11-02 is a Monday after DST ends, CST (UTC−6): 14:10 UTC is
    // 08:10 CT (outside), though it would be 09:10 under CDT.
    ['08:10 CST Monday', '2026-11-02T14:10:00Z', false],
    ['08:15 CST Monday', '2026-11-02T14:15:00Z', true],
  ])('%s (%s) → %s', (_label, iso, expected) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
    expect(isMarketHoursCt()).toBe(expected);
  });
});

// ── row mapping + chunking ─────────────────────────────────

describe('rangePosUpdates', () => {
  const candles = [
    { start_time: '2026-05-01T13:30:00Z', high: '1200', low: '1150' },
    { start_time: '2026-05-01T14:00:00Z', high: '1300', low: '1150' },
  ];

  it('maps each fire to its range_pos and keeps the BIGSERIAL id as given', () => {
    const fires = [
      // Only the 13:30 bar is at or before 13:45: (1170-1150)/(1200-1150).
      {
        id: '9007199254740993',
        trigger_time_ct: new Date('2026-05-01T13:45:00Z'),
        spot: 1170,
      },
      // Both bars count: (1170-1150)/(1300-1150).
      { id: '12', trigger_time_ct: '2026-05-01T14:05:00Z', spot: '1170' },
    ];
    const out = rangePosUpdates(fires, candles);
    expect(out.ids).toEqual(['9007199254740993', '12']);
    expect(out.positions[0]).toBeCloseTo(0.4, 10);
    expect(out.positions[1]).toBeCloseTo(20 / 150, 10);
    expect(out.leftNull).toBe(0);
  });

  it('leaves a fire NULL when it has no spot or no candle before its trigger', () => {
    const fires = [
      { id: '1', trigger_time_ct: '2026-05-01T13:45:00Z', spot: null },
      { id: '2', trigger_time_ct: '2026-05-01T13:00:00Z', spot: 1170 },
    ];
    expect(rangePosUpdates(fires, candles)).toEqual({
      ids: [],
      positions: [],
      leftNull: 2,
    });
  });
});

describe('chunk', () => {
  it('splits into slices of at most the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(chunk([], 500)).toEqual([]);
  });

  it('rejects a size below 1', () => {
    expect(() => chunk([1], 0)).toThrow('size');
  });
});

describe('takeReadyChunks', () => {
  const pending = {
    ids: ['1', '2', '3', '4', '5', '6', '7'],
    positions: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
  };

  it('takes only full chunks and holds the partial one back', () => {
    expect(takeReadyChunks(pending, 3, false)).toEqual({
      chunks: [
        { ids: ['1', '2', '3'], positions: [0.1, 0.2, 0.3] },
        { ids: ['4', '5', '6'], positions: [0.4, 0.5, 0.6] },
      ],
      rest: { ids: ['7'], positions: [0.7] },
    });
  });

  it('takes the partial chunk too on the final flush', () => {
    const { chunks, rest } = takeReadyChunks(pending, 3, true);
    expect(chunks.at(-1)).toEqual({ ids: ['7'], positions: [0.7] });
    expect(chunks.flatMap((c) => c.ids)).toEqual(pending.ids);
    expect(rest).toEqual({ ids: [], positions: [] });
  });

  it('keeps every id with its own position', () => {
    const { chunks } = takeReadyChunks(pending, 2, true);
    for (const c of chunks) {
      expect(c.ids.length).toBe(c.positions.length);
      c.ids.forEach((id, k) => {
        expect(c.positions[k]).toBe(Number(id) / 10);
      });
    }
  });

  it('takes nothing when less than a chunk is pending', () => {
    expect(takeReadyChunks(pending, 500, false)).toEqual({
      chunks: [],
      rest: pending,
    });
    expect(takeReadyChunks({ ids: [], positions: [] }, 500, true)).toEqual({
      chunks: [],
      rest: { ids: [], positions: [] },
    });
  });

  it('leaves its input untouched', () => {
    const before = structuredClone(pending);
    takeReadyChunks(pending, 3, true);
    expect(pending).toEqual(before);
  });

  it('rejects ids and positions of different lengths', () => {
    expect(() =>
      takeReadyChunks({ ids: ['1', '2'], positions: [0.1] }, 500, true),
    ).toThrow('2 ids but 1 positions');
  });
});

// ── concurrency pool ───────────────────────────────────────

describe('runPool', () => {
  it('never runs more than the limit at once and returns results in input order', async () => {
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

  it('rejects when a worker throws', async () => {
    await expect(
      runPool([1, 2], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});

// ── UW fetch ───────────────────────────────────────────────

const SESSION_CANDLES = [
  { start_time: '2026-05-01T13:30:00Z', high: '1200', low: '1150' },
];

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

describe('fetchDayCandles', () => {
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
  async function fetchWithFakeTimers() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = fetchDayCandles('uw-key', 'AAPL', '2026-05-01');
    await vi.advanceTimersByTimeAsync(5_000);
    return pending;
  }

  it('returns the candles and sends the key, an explicit User-Agent and a timeout', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: SESSION_CANDLES }));

    await expect(
      fetchDayCandles('uw-key', 'AAPL', '2026-05-01'),
    ).resolves.toEqual({ kind: 'ok', candles: SESSION_CANDLES });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.unusualwhales.com/api/stock/AAPL/ohlc/1m?date=2026-05-01',
    );
    expect(init.headers).toEqual({
      Authorization: 'Bearer uw-key',
      'User-Agent': UW_USER_AGENT,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(UW_USER_AGENT).not.toMatch(/python|urllib/i);
  });

  it.each([
    ['an empty array', { data: [] }],
    ['a null data', { data: null }],
    ['no data key', {}],
  ])('reports %s as an empty day', async (_label, body) => {
    stubFetch(jsonResponse(body));
    await expect(
      fetchDayCandles('uw-key', 'AAPL', '2026-05-01'),
    ).resolves.toEqual({ kind: 'empty' });
  });

  it('does not retry a definite 4xx', async () => {
    const fetchMock = stubFetch(textResponse('{"code":"not_found"}', 404));

    await expect(fetchWithFakeTimers()).resolves.toEqual({
      kind: 'error',
      status: 'http_404',
      detail: '{"code":"not_found"}',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a 503', textResponse('Service Unavailable', 503)],
    ['a 429', textResponse('You have exceeded 3 concurrent requests', 429)],
    ['a network error', new TypeError('fetch failed')],
  ])('retries %s once and then succeeds', async (_label, first) => {
    const fetchMock = stubFetch(first, jsonResponse({ data: SESSION_CANDLES }));

    await expect(fetchWithFakeTimers()).resolves.toEqual({
      kind: 'ok',
      candles: SESSION_CANDLES,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

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
      'a candle with no start_time',
      jsonResponse({ data: [{ high: '1', low: '1' }] }),
      'candle 0 has no start_time',
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

// ── DB retry ───────────────────────────────────────────────

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

  it('gives up with the timeout when every attempt hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fn = vi.fn(() => new Promise(() => {}));

    const pending = retryTransientDb(fn);
    const assertion = expect(pending).rejects.toThrow(
      'db attempt timeout after 30000 ms',
    );
    // Three 30 s attempts plus the 2 s and 4 s backoffs.
    await vi.advanceTimersByTimeAsync(96_000);

    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

// ── report helpers ─────────────────────────────────────────

describe('mergeMonthCounts', () => {
  it('lines up before and after by month and computes what was filled', () => {
    const before = [
      { month: '2026-09', fires: 100, null_all: 80, null_index: 10 },
      { month: '2026-10', fires: 50, null_all: 50, null_index: 5 },
    ];
    const after = [
      { month: '2026-09', fires: 100, null_all: 12, null_index: 10 },
      { month: '2026-10', fires: 50, null_all: 5, null_index: 5 },
    ];
    expect(mergeMonthCounts(before, after)).toEqual([
      {
        month: '2026-09',
        fires: 100,
        nullBefore: 80,
        nullAfter: 12,
        filled: 68,
        nullIndex: 10,
      },
      {
        month: '2026-10',
        fires: 50,
        nullBefore: 50,
        nullAfter: 5,
        filled: 45,
        nullIndex: 5,
      },
    ]);
  });

  it('reads a dry run (no after counts) as nothing filled', () => {
    const before = [{ month: '2026-09', fires: 9, null_all: 9, null_index: 0 }];
    expect(mergeMonthCounts(before, null)).toEqual([
      {
        month: '2026-09',
        fires: 9,
        nullBefore: 9,
        nullAfter: 9,
        filled: 0,
        nullIndex: 0,
      },
    ]);
  });
});

describe('summarizeFailures', () => {
  it('counts failures by status, most common first, with one example each', () => {
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
});

describe('redact', () => {
  it('removes the UW key, the database URL and its password', () => {
    const dbUrl = 'postgresql://owner:s3cr3t@ep-x.neon.tech/neondb';
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
