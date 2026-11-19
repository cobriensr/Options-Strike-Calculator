// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CASH_INDEX_ROOTS as API_CASH_INDEX_ROOTS } from '../../api/_lib/constants.ts';
import { computeRangePos as cronComputeRangePos } from '../../api/_lib/uw-stock-candles.ts';
import {
  CASH_INDEX_ROOTS,
  SPLIT_GUARD_RATIO,
  UW_USER_AGENT,
  chunk,
  computeRangePos,
  fetchDayCandles,
  isMarketHoursCt,
  isSplitMismatch,
  mergeMonthCounts,
  parseArgs,
  preTriggerRange,
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

// ── split guard ────────────────────────────────────────────

// UW answers 1-min candles newest first and adjusts them for later splits;
// high, low and close come as strings or numbers. Real fire 647842, CRWD,
// 2026-05-19 13:30:54Z: the stored spot (620.49) is the pre-4-for-1 price.
const CRWD_TRIGGER = '2026-05-19T13:30:54Z';
const CRWD_CANDLES = [
  { start_time: '2026-05-19T13:31:00Z', high: '700', low: '600' }, // after the trigger
  { start_time: '2026-05-19T13:30:00Z', high: '155.88', low: 154.2 },
  { start_time: '2026-05-19T13:29:00Z', high: 154.9, low: '153.25' },
];
// Fire 844453, SOXS, 2026-07-10 18:35:37Z: stored spot 4.0701 is the
// pre-1-for-10 reverse-split price.
const SOXS_TRIGGER = '2026-07-10T18:35:37Z';
const SOXS_CANDLES = [
  { start_time: '2026-07-10T18:35:00Z', high: '43.9', low: '41.5' },
  { start_time: '2026-07-10T18:34:00Z', high: 42.1, low: '39.8' },
];
const PLAIN_TRIGGER = '2026-05-08T14:30:00Z';
const PLAIN_CANDLES = [
  { start_time: '2026-05-08T14:00:00Z', high: '100', low: '90' },
];

describe('preTriggerRange', () => {
  it('spans the candles at or before the trigger, strings and numbers alike', () => {
    expect(preTriggerRange(CRWD_CANDLES, CRWD_TRIGGER)).toEqual({
      low: 153.25,
      high: 155.88,
    });
  });

  it('ignores a later candle and one with an unparseable start_time', () => {
    const candles = [
      ...PLAIN_CANDLES,
      { start_time: '2026-05-08T14:31:00Z', high: '500', low: '1' },
      { start_time: 'not-a-time', high: '600', low: '2' },
    ];
    expect(preTriggerRange(candles, PLAIN_TRIGGER)).toEqual({
      low: 90,
      high: 100,
    });
  });

  it('accepts a Date trigger, like computeRangePos', () => {
    expect(preTriggerRange(PLAIN_CANDLES, new Date(PLAIN_TRIGGER))).toEqual({
      low: 90,
      high: 100,
    });
  });

  it('gives the same range for newest-first and oldest-first candles', () => {
    expect(preTriggerRange([...CRWD_CANDLES].reverse(), CRWD_TRIGGER)).toEqual(
      preTriggerRange(CRWD_CANDLES, CRWD_TRIGGER),
    );
  });

  it('reports a flat bar as a finite range', () => {
    const flat = [{ start_time: '2026-05-08T14:00:00Z', high: 5, low: 5 }];
    expect(preTriggerRange(flat, PLAIN_TRIGGER)).toEqual({ low: 5, high: 5 });
  });

  it.each([
    ['no candles', [], PLAIN_TRIGGER],
    [
      'every candle after the trigger',
      [{ start_time: '2026-05-08T14:31:00Z', high: '110', low: '100' }],
      PLAIN_TRIGGER,
    ],
    [
      'an unparseable high and low',
      [{ start_time: '2026-05-08T14:00:00Z', high: 'abc', low: '' }],
      PLAIN_TRIGGER,
    ],
    ['an unparseable trigger', PLAIN_CANDLES, 'garbage'],
  ])('returns null for %s', (_label, candles, trigger) => {
    expect(preTriggerRange(candles, trigger)).toBeNull();
  });

  it('applies the same parsing and skip rules as computeRangePos', () => {
    const next = rng(20261119);
    for (let i = 0; i < 2_000; i++) {
      const { candles, trigger, spot } = randomCase(next);
      const range = preTriggerRange(candles, trigger);
      const usable = range != null && range.high > range.low;
      const expected = usable
        ? Math.max(
            0,
            Math.min(1, (spot - range.low) / (range.high - range.low)),
          )
        : null;
      expect(computeRangePos(candles, trigger, spot), `case ${i}`).toBe(
        expected,
      );
    }
  });
});

describe('isSplitMismatch', () => {
  it('uses a 20% band', () => {
    expect(SPLIT_GUARD_RATIO).toBe(1.2);
  });

  it('flags a CRWD-like spot 4x the adjusted candles', () => {
    expect(isSplitMismatch(CRWD_CANDLES, CRWD_TRIGGER, 620.49)).toBe(true);
  });

  it('flags a SOXS-like spot a tenth of the adjusted candles', () => {
    expect(isSplitMismatch(SOXS_CANDLES, SOXS_TRIGGER, 4.0701)).toBe(true);
  });

  it.each([
    ['inside the range', 95],
    ['0.5% above the high', 100 * 1.005],
    ['0.5% below the low', 90 * 0.995],
    ['exactly at high x 1.2', 100 * SPLIT_GUARD_RATIO],
    ['exactly at low / 1.2', 90 / SPLIT_GUARD_RATIO],
  ])('passes a spot %s', (_label, spot) => {
    expect(isSplitMismatch(PLAIN_CANDLES, PLAIN_TRIGGER, spot)).toBe(false);
  });

  it.each([
    ['just above high x 1.2', 100 * SPLIT_GUARD_RATIO + 0.01],
    ['just below low / 1.2', 90 / SPLIT_GUARD_RATIO - 0.01],
    // The smallest common split, 3-for-2: any split must fail the guard.
    ['1.5x the high (a 3-for-2 split)', 100 * 1.5],
    ['low / 1.5 (a 2-for-3 reverse split)', 90 / 1.5],
  ])('flags a spot %s', (_label, spot) => {
    expect(isSplitMismatch(PLAIN_CANDLES, PLAIN_TRIGGER, spot)).toBe(true);
  });

  it('is not rescued by a later candle whose range holds the spot', () => {
    // CRWD_CANDLES carries a 13:31 candle spanning 600-700, after the
    // 13:30:54 trigger; the stored spot 620.49 sits inside it.
    expect(isSplitMismatch(CRWD_CANDLES, CRWD_TRIGGER, 620.49)).toBe(true);
    // The same candle before the trigger would rescue it.
    expect(isSplitMismatch(CRWD_CANDLES, '2026-05-19T13:32:00Z', 620.49)).toBe(
      false,
    );
  });

  it('gives the same answer for newest-first and oldest-first candles', () => {
    const oldestFirst = [...CRWD_CANDLES].reverse();
    expect(isSplitMismatch(oldestFirst, CRWD_TRIGGER, 620.49)).toBe(true);
    expect(isSplitMismatch(oldestFirst, CRWD_TRIGGER, 154)).toBe(false);
    expect(isSplitMismatch(CRWD_CANDLES, CRWD_TRIGGER, 154)).toBe(false);
  });

  it.each([
    ['no candles', [], PLAIN_TRIGGER, 500],
    [
      'no candle before the trigger',
      [{ start_time: '2026-05-08T14:31:00Z', high: '110', low: '100' }],
      PLAIN_TRIGGER,
      500,
    ],
    [
      'no finite range',
      [{ start_time: '2026-05-08T14:00:00Z', high: 'abc', low: 'abc' }],
      PLAIN_TRIGGER,
      500,
    ],
    ['an unparseable trigger', PLAIN_CANDLES, 'garbage', 500],
    ['a NaN spot', PLAIN_CANDLES, PLAIN_TRIGGER, Number.NaN],
    [
      'an infinite spot',
      PLAIN_CANDLES,
      PLAIN_TRIGGER,
      Number.POSITIVE_INFINITY,
    ],
  ])('is false for %s', (_label, candles, trigger, spot) => {
    expect(isSplitMismatch(candles, trigger, spot)).toBe(false);
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
    expect(out.splitMismatch).toBe(0);
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
      splitMismatch: 0,
    });
  });

  it('leaves a split-mismatched fire NULL and counts it apart from leftNull', () => {
    // The stored spot is pre-split (620.49); UW's candles are 4-for-1
    // adjusted. computeRangePos alone would clamp it to 1.
    const fires = [
      { id: '647842', trigger_time_ct: CRWD_TRIGGER, spot: 620.49 },
    ];
    expect(computeRangePos(CRWD_CANDLES, CRWD_TRIGGER, 620.49)).toBe(1);
    expect(rangePosUpdates(fires, CRWD_CANDLES)).toEqual({
      ids: [],
      positions: [],
      leftNull: 0,
      splitMismatch: 1,
    });
  });

  it('counts a split-mismatched fire on a flat range as a mismatch, not leftNull', () => {
    const flat = [{ start_time: '2026-05-08T14:00:00Z', high: 5, low: 5 }];
    const fires = [{ id: '1', trigger_time_ct: PLAIN_TRIGGER, spot: 50 }];
    expect(rangePosUpdates(fires, flat)).toMatchObject({
      leftNull: 0,
      splitMismatch: 1,
    });
  });

  it.each([
    ['0.5% above the high stays clamped to 1', 100 * 1.005, 1],
    ['0.5% below the low stays clamped to 0', 90 * 0.995, 0],
  ])('still writes a spot %s', (_label, spot, expected) => {
    const fires = [{ id: '7', trigger_time_ct: PLAIN_TRIGGER, spot }];
    expect(rangePosUpdates(fires, PLAIN_CANDLES)).toEqual({
      ids: ['7'],
      positions: [expected],
      leftNull: 0,
      splitMismatch: 0,
    });
  });

  it('tallies written, leftNull and splitMismatch fires from one ticker-day', () => {
    const fires = [
      { id: '1', trigger_time_ct: CRWD_TRIGGER, spot: 620.49 },
      { id: '2', trigger_time_ct: CRWD_TRIGGER, spot: 154.9 },
      { id: '3', trigger_time_ct: CRWD_TRIGGER, spot: null },
      { id: '4', trigger_time_ct: '2026-05-19T13:00:00Z', spot: 154.9 },
      { id: '5', trigger_time_ct: CRWD_TRIGGER, spot: 38 },
    ];
    const out = rangePosUpdates(fires, CRWD_CANDLES);
    expect(out.ids).toEqual(['2']);
    expect(out.positions[0]).toBeCloseTo((154.9 - 153.25) / (155.88 - 153.25));
    expect(out.leftNull).toBe(2);
    expect(out.splitMismatch).toBe(2);
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
