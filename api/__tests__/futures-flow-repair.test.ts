// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks (module boundary — R3) ──────────────────────────

const { mockSql, mockUwFetch, mockWithRetry } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockUwFetch: vi.fn(),
  mockWithRetry: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: () => mockSql,
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  withRetry: mockWithRetry,
}));

import {
  FLOW_VOLUME_TOLERANCE,
  fetchContractFlow,
  fetchNullFlowBars,
  groupFlowRanges,
  matchFlowToBars,
  writeFlowMinutes,
  type FlowMinute,
  type PageBudget,
} from '../_lib/futures-flow-repair.js';

// ── Fixtures ──────────────────────────────────────────────

const START = Date.parse('2026-10-28T14:00:00Z');
const END = Date.parse('2026-10-28T14:03:00Z');

/** A regular REST /trades row (probe 0a shape). */
function print(
  id: number,
  at: string,
  size: number,
  // `string`: a test sends a side UW doesn't document.
  side: string | null,
  extra: Record<string, unknown> = {},
) {
  return {
    crossed: false,
    executed_at: at,
    is_block: false,
    is_spread: false,
    nbbo_ask: '7765.750000000',
    nbbo_bid: '7765.500000000',
    price: '7765.750000000',
    side,
    size,
    strategy: null,
    trade_id: id,
    ...extra,
  };
}

function budget(pagesLeft = 100): PageBudget {
  return { pagesLeft, deadlineMs: Number.POSITIVE_INFINITY };
}

/** The `older_than` cursor of UW call `idx`. */
function cursorOf(idx: number): string | null {
  const path = mockUwFetch.mock.calls[idx]![1] as string;
  return new URL(`https://uw.test${path}`).searchParams.get('older_than');
}

function flow(
  ts: string,
  volume: number,
  buyVolume = 0,
  sellVolume = 0,
  buyPrints = 0,
  sellPrints = 0,
): FlowMinute {
  return { ts, volume, buyVolume, sellVolume, buyPrints, sellPrints };
}

function sqlText(idx: number): string {
  return (mockSql.mock.calls[idx]![0] as readonly string[]).join('?');
}

beforeEach(() => {
  vi.resetAllMocks();
  mockWithRetry.mockImplementation((fn: () => unknown) => fn());
});

// ── fetchContractFlow ─────────────────────────────────────

describe('fetchContractFlow', () => {
  it('pages newest-first with a +1 µs cursor, dedups the boundary, drops spreads and blocks, and splits volume by aggressor side per minute', async () => {
    mockUwFetch
      .mockResolvedValueOnce([
        // A block row: qty, no size/side. Never counted.
        {
          is_block: true,
          is_spread: false,
          trade_id: 11,
          executed_at: '2026-10-28T14:02:40Z',
          qty: '50',
          size: null,
          side: null,
        },
        print(10, '2026-10-28T14:02:30.000100Z', 3, 'buy'),
        print(9, '2026-10-28T14:02:10.000000Z', 2, 'sell'),
        print(8, '2026-10-28T14:01:59.500000Z', 4, 'none'),
        print(7, '2026-10-28T14:01:00.000005Z', 1, 'buy', { is_spread: true }),
        print(6, '2026-10-28T14:01:00.000005Z', 5, 'sell'),
      ])
      .mockResolvedValueOnce([
        // Re-returned by the inclusive cursor: a duplicate.
        print(6, '2026-10-28T14:01:00.000005Z', 5, 'sell'),
        print(5, '2026-10-28T14:00:30.000000Z', 2, 'buy'),
        // Before the range start: ends the paging, never counted.
        print(4, '2026-10-28T13:59:59.900000Z', 100, 'buy'),
      ]);
    const b = budget(10);

    const out = await fetchContractFlow('uw-key', 'ESZ6', START, END, b);

    expect(out.stop).toBe('complete');
    expect(out.coveredFromMs).toBe(START);
    expect(out.pages).toBe(2);
    expect(out.malformed).toBe(0);
    expect(b.pagesLeft).toBe(8);
    expect([...out.minutes.values()]).toEqual([
      flow('2026-10-28T14:02:00.000Z', 5, 3, 2, 1, 1),
      flow('2026-10-28T14:01:00.000Z', 9, 0, 5, 0, 1),
      flow('2026-10-28T14:00:00.000Z', 2, 2, 0, 1, 0),
    ]);

    const path = mockUwFetch.mock.calls[0]![1] as string;
    expect(path.startsWith('/futures/ESZ6/trades?')).toBe(true);
    const params = new URL(`https://uw.test${path}`).searchParams;
    expect(params.get('limit')).toBe('500');
    expect(params.get('skip_blocks')).toBe('true');
    expect(cursorOf(0)).toBe('2026-10-28T14:03:00.000000Z');
    expect(cursorOf(1)).toBe('2026-10-28T14:01:00.000006Z');
    expect(mockUwFetch.mock.calls.every((c) => c[0] === 'uw-key')).toBe(true);
    expect(mockWithRetry).toHaveBeenCalledTimes(2);
  });

  it('an empty page is the edge of UW history: stops "exhausted" and covers only the minutes after the oldest print', async () => {
    mockUwFetch
      .mockResolvedValueOnce([
        print(3, '2026-10-28T14:02:30.000000Z', 1, 'buy'),
        print(2, '2026-10-28T14:01:20.000000Z', 1, 'sell'),
      ])
      .mockResolvedValueOnce([]);

    const out = await fetchContractFlow('k', 'ESU6', START, END, budget());

    expect(out.stop).toBe('exhausted');
    // 14:01 may hold older prints UW no longer has: not covered.
    expect(out.coveredFromMs).toBe(Date.parse('2026-10-28T14:02:00Z'));
    expect([...out.minutes.keys()]).toEqual(['2026-10-28T14:02:00.000Z']);
    expect(out.pages).toBe(2);
  });

  it('an empty first page covers nothing', async () => {
    mockUwFetch.mockResolvedValueOnce([]);

    const out = await fetchContractFlow('k', 'ESU6', START, END, budget());

    expect(out).toMatchObject({
      stop: 'exhausted',
      coveredFromMs: END,
      pages: 1,
    });
    expect(out.minutes.size).toBe(0);
  });

  it('stops "budget" when the shared page budget runs out, covering only what it fetched', async () => {
    mockUwFetch.mockResolvedValueOnce([
      print(3, '2026-10-28T14:02:30.000000Z', 1, 'buy'),
      print(2, '2026-10-28T14:01:20.000000Z', 1, 'sell'),
    ]);
    const b = budget(1);

    const out = await fetchContractFlow('k', 'ESZ6', START, END, b);

    expect(out).toMatchObject({
      stop: 'budget',
      pages: 1,
      coveredFromMs: Date.parse('2026-10-28T14:02:00Z'),
    });
    expect([...out.minutes.keys()]).toEqual(['2026-10-28T14:02:00.000Z']);
    expect(b.pagesLeft).toBe(0);
    expect(mockUwFetch).toHaveBeenCalledTimes(1);
  });

  it('a passed deadline stops before any request', async () => {
    const out = await fetchContractFlow('k', 'ESZ6', START, END, {
      pagesLeft: 10,
      deadlineMs: Date.now() - 1,
    });

    expect(out).toMatchObject({ stop: 'budget', pages: 0, coveredFromMs: END });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('an upstream 5xx propagates (after withRetry) instead of reading as an empty page', async () => {
    mockUwFetch.mockRejectedValueOnce(new Error('UW API 503: unavailable'));

    await expect(
      fetchContractFlow('k', 'ESZ6', START, END, budget()),
    ).rejects.toThrow('UW API 503: unavailable');
    expect(mockWithRetry).toHaveBeenCalledTimes(1);
  });

  it('a non-array page throws', async () => {
    mockUwFetch.mockResolvedValueOnce({ unexpected: 'shape' });

    await expect(
      fetchContractFlow('k', 'ESZ6', START, END, budget()),
    ).rejects.toThrow(/ESZ6: non-array trades page/);
  });

  it('a page of only malformed prints throws', async () => {
    mockUwFetch.mockResolvedValueOnce([
      { executed_at: '2026-10-28T14:02:00Z', size: 1 }, // no trade_id
      print(2, '2026-10-28T14:01:00Z', 1, 'buy', { is_spread: 'no' }),
    ]);

    await expect(
      fetchContractFlow('k', 'ESZ6', START, END, budget()),
    ).rejects.toThrow(/ESZ6: all 2 prints on a trades page are malformed/);
  });

  it('skips a malformed print and withholds its minute (counted), keeping the others', async () => {
    mockUwFetch
      .mockResolvedValueOnce([
        print(4, '2026-10-28T14:02:30Z', 2, 'buy'),
        print(3, '2026-10-28T14:02:10Z', 7, 'up'), // unknown side
        print(2, '2026-10-28T14:01:10Z', 1, 'sell'),
      ])
      .mockResolvedValueOnce([print(1, '2026-10-28T13:59:00Z', 1, 'buy')]);

    const out = await fetchContractFlow('k', 'ESZ6', START, END, budget());

    expect(out.malformed).toBe(1);
    expect([...out.minutes.keys()]).toEqual(['2026-10-28T14:01:00.000Z']);
  });

  it('a print with no usable executed_at throws: its minute cannot be placed', async () => {
    mockUwFetch.mockResolvedValueOnce([
      print(2, '2026-10-28T14:02:30Z', 1, 'buy'),
      print(1, 'garbage', 1, 'buy'),
    ]);

    await expect(
      fetchContractFlow('k', 'ESZ6', START, END, budget()),
    ).rejects.toThrow(/ESZ6: print 1 has no usable executed_at/);
  });

  it('a page of only already-seen prints moves the cursor strictly older and withholds that minute', async () => {
    const atT = '2026-10-28T14:01:30.000000Z';
    mockUwFetch
      .mockResolvedValueOnce([print(2, atT, 1, 'buy'), print(1, atT, 1, 'buy')])
      .mockResolvedValueOnce([print(2, atT, 1, 'buy'), print(1, atT, 1, 'buy')])
      .mockResolvedValueOnce([
        print(0, '2026-10-28T14:00:10.000000Z', 4, 'sell'),
        print(999, '2026-10-28T13:59:00.000000Z', 1, 'buy'),
      ]);

    const out = await fetchContractFlow('k', 'ESZ6', START, END, budget());

    expect(cursorOf(1)).toBe('2026-10-28T14:01:30.000001Z');
    expect(cursorOf(2)).toBe('2026-10-28T14:01:30.000000Z');
    expect(out.stop).toBe('complete');
    expect([...out.minutes.values()]).toEqual([
      flow('2026-10-28T14:00:00.000Z', 4, 0, 4, 0, 1),
    ]);
  });
});

// ── matchFlowToBars ───────────────────────────────────────

describe('matchFlowToBars', () => {
  const A = '2026-10-28T14:00:00.000Z';
  const B = '2026-10-28T14:01:00.000Z';
  const C = '2026-10-28T14:02:00.000Z';
  const D = '2026-10-28T14:03:00.000Z';
  const E = '2026-10-28T14:04:00.000Z';

  it('is 2%', () => {
    expect(FLOW_VOLUME_TOLERANCE).toBe(0.02);
  });

  it('writes a minute only when REST volume is within 2% of the bar and buy + sell fits the bar', () => {
    const out = matchFlowToBars(
      [
        { ts: A, volume: 100 },
        { ts: B, volume: 100 },
        { ts: C, volume: 100 },
        { ts: D, volume: 0 },
        { ts: E, volume: 50 },
      ],
      new Map([
        [A, flow(A, 102, 60, 40, 6, 4)], // +2%, buy+sell = 100: written
        [B, flow(B, 103, 50, 50, 5, 5)], // +3%: skipped
        [C, flow(C, 102, 60, 42, 6, 4)], // +2% but buy+sell 102 > 100: skipped
      ]),
    );

    expect(out.updates).toEqual([
      flow(A, 102, 60, 40, 6, 4),
      // A zero-volume bar with no REST prints is a known zero.
      flow(D, 0),
    ]);
    // E: a 50-lot bar with no REST prints.
    expect(out.skippedTolerance).toBe(3);
  });

  it('accepts REST volume below the bar within 2%', () => {
    const out = matchFlowToBars(
      [{ ts: A, volume: 1000 }],
      new Map([[A, flow(A, 980, 500, 400, 50, 40)]]),
    );
    expect(out.updates).toHaveLength(1);
    expect(out.skippedTolerance).toBe(0);
  });
});

// ── writeFlowMinutes ──────────────────────────────────────

describe('writeFlowMinutes', () => {
  const minute = (i: number) =>
    flow(new Date(START + i * 60_000).toISOString(), 10, 6, 4, 3, 2);

  it('one batched conditional UPDATE: only rows whose buy_volume is still NULL', async () => {
    mockSql.mockResolvedValueOnce([{ ts: 'a' }, { ts: 'b' }]);

    const n = await writeFlowMinutes('ES', [minute(0), minute(1), minute(2)]);

    expect(n).toBe(2); // RETURNING: rows actually updated
    expect(mockSql).toHaveBeenCalledTimes(1);
    const text = sqlText(0);
    expect(text).toContain('UPDATE futures_bars AS b');
    expect(text).toContain('FROM unnest(');
    expect(text).toContain('b.symbol =');
    expect(text).toContain('b.ts = t.ts');
    expect(text).toContain('AND b.buy_volume IS NULL');
    expect(text).toContain('RETURNING');
    // Never writes volume or OHLC.
    expect(text).not.toMatch(/SET[^]*\bvolume\s*=\s*t\.volume/);
    const values = mockSql.mock.calls[0]!.slice(1);
    expect(values).toContain('ES');
    expect(values).toContainEqual([minute(0).ts, minute(1).ts, minute(2).ts]);
    expect(values).toContainEqual([6, 6, 6]);
    expect(values).toContainEqual([4, 4, 4]);
  });

  it('chunks into 500-row UPDATEs', async () => {
    mockSql
      .mockResolvedValueOnce(Array.from({ length: 500 }, () => ({})))
      .mockResolvedValueOnce(Array.from({ length: 100 }, () => ({})));

    const n = await writeFlowMinutes(
      'NQ',
      Array.from({ length: 600 }, (_, i) => minute(i)),
    );

    expect(n).toBe(600);
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect((mockSql.mock.calls[0]![2] as unknown[]).length).toBe(500);
    expect((mockSql.mock.calls[1]![2] as unknown[]).length).toBe(100);
  });

  it('nothing to write → no query', async () => {
    await expect(writeFlowMinutes('ES', [])).resolves.toBe(0);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('a rejected UPDATE propagates', async () => {
    mockSql.mockRejectedValueOnce(
      new Error('value out of range for type integer'),
    );

    await expect(writeFlowMinutes('ES', [minute(0)])).rejects.toThrow(
      'value out of range for type integer',
    );
  });
});

// ── fetchNullFlowBars / groupFlowRanges ───────────────────

describe('fetchNullFlowBars', () => {
  it('selects NULL-flow bars with a range-start flag and keeps only Globex-open minutes', async () => {
    mockSql.mockResolvedValueOnce([
      {
        symbol: 'ES',
        ts: new Date('2026-10-28T14:00:00Z'),
        volume: 120,
        starts_range: true,
      },
      // 16:30 CDT on a Wednesday: the daily halt.
      {
        symbol: 'ES',
        ts: new Date('2026-10-28T21:30:00Z'),
        volume: 1,
        starts_range: false,
      },
      {
        symbol: 'NQ',
        ts: new Date('2026-10-28T14:01:00Z'),
        volume: '45',
        starts_range: false,
      },
    ]);

    const rows = await fetchNullFlowBars(
      ['ES', 'NQ'],
      '2026-10-26T00:00:00.000Z',
      '2026-10-29T00:00:00.000Z',
    );

    expect(rows).toEqual([
      {
        symbol: 'ES',
        ts: '2026-10-28T14:00:00.000Z',
        volume: 120,
        startsRange: true,
      },
      {
        symbol: 'NQ',
        ts: '2026-10-28T14:01:00.000Z',
        volume: 45,
        startsRange: false,
      },
    ]);
    const text = sqlText(0);
    expect(text).toContain('FROM futures_bars');
    expect(text).toContain('buy_volume IS NULL');
    expect(text).toContain('LAG(buy_volume IS NULL)');
    const values = mockSql.mock.calls[0]!.slice(1);
    expect(values).toContainEqual(['ES', 'NQ']);
    expect(values).toContain('2026-10-26T00:00:00.000Z');
    expect(values).toContain('2026-10-29T00:00:00.000Z');
  });
});

describe('groupFlowRanges', () => {
  it('starts a new range at each range-start flag and at each symbol change', () => {
    const row = (symbol: string, ts: string, startsRange: boolean) => ({
      symbol,
      ts,
      volume: 10,
      startsRange,
    });

    const ranges = groupFlowRanges([
      row('ES', '2026-10-28T14:00:00.000Z', true),
      row('ES', '2026-10-28T14:01:00.000Z', false),
      row('ES', '2026-10-28T14:05:00.000Z', true),
      row('NQ', '2026-10-28T14:06:00.000Z', false),
    ]);

    expect(ranges).toEqual([
      {
        symbol: 'ES',
        bars: [
          { ts: '2026-10-28T14:00:00.000Z', volume: 10 },
          { ts: '2026-10-28T14:01:00.000Z', volume: 10 },
        ],
      },
      { symbol: 'ES', bars: [{ ts: '2026-10-28T14:05:00.000Z', volume: 10 }] },
      { symbol: 'NQ', bars: [{ ts: '2026-10-28T14:06:00.000Z', volume: 10 }] },
    ]);
  });
});
