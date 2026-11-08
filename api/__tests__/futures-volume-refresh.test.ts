// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks (module boundary — R3) ──────────────────────────

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { mockFetchStored, mockInsertVolumes, mockFetchDaily } = vi.hoisted(
  () => ({
    mockFetchStored: vi.fn(),
    mockInsertVolumes: vi.fn(),
    mockFetchDaily: vi.fn(),
  }),
);

// The store and the daily-candle fetch are mocked at their module boundary.
// The contract names and the cycle are real.
vi.mock('../_lib/futures-front-month.js', () => ({
  fetchStoredFrontMonths: mockFetchStored,
  insertContractVolumes: mockInsertVolumes,
}));

vi.mock('../_lib/futures-daily-candles.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../_lib/futures-daily-candles.js')
  >()),
  fetchDailyContractVolumes: mockFetchDaily,
}));

import { refreshFrontMonthVolumes } from '../_lib/futures-volume-refresh.js';
import logger from '../_lib/logger.js';

// ── Fixtures ──────────────────────────────────────────────

// 06:00 UTC: the current CME trade date is 2026-09-30 (01:00 CDT + 7 h), and
// its session opened at 22:00Z the evening before.
const NOW = '2026-09-30T06:00:00Z';
const KEY = 'test-uw-key';

/** A daily candle row as `fetchDailyContractVolumes` returns it. */
function dailyRow(contract: string, tradeDate: string, volume: number) {
  return { contract, tradeDate, volume };
}

/** The product's front month in the default stored decisions. */
const FRONT: Record<string, string> = {
  ES: 'ESZ6',
  NQ: 'NQZ6',
  CL: 'CLX6',
};

/** The last bar before the current session: Tue 15:59 CDT, trade date 09-29. */
const LAST_BAR = [{ ts: new Date('2026-09-29T20:59:00Z') }];

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  mockFetchStored.mockImplementation(
    async (product: string) => new Map([['2026-09-29', FRONT[product]!]]),
  );
  // Every contract asked for has the last finished session's candle.
  mockFetchDaily.mockImplementation(
    async (_key: string, _product: string, contracts: readonly string[]) =>
      contracts.map((c) => dailyRow(c, '2026-09-29', 1_000)),
  );
  mockInsertVolumes.mockImplementation(
    async (rows: readonly unknown[]) => rows.length,
  );
  mockSql.mockResolvedValue(LAST_BAR);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('refreshFrontMonthVolumes', () => {
  // ── The contracts read ────────────────────────────────

  it('reads daily candles of the incumbent and the next two cycle contracts over the range, and stores them', async () => {
    const result = await refreshFrontMonthVolumes(KEY, 'ES', '1m');

    // The incumbent is the latest decision of the last 30 days; the current
    // trade date is 2026-09-30.
    expect(mockFetchStored).toHaveBeenCalledWith(
      'ES',
      '2026-08-31',
      '2026-09-30',
    );
    expect(mockFetchDaily).toHaveBeenCalledTimes(1);
    expect(mockFetchDaily).toHaveBeenCalledWith(
      KEY,
      'ES',
      ['ESZ6', 'ESH7', 'ESM7'],
      '1m',
    );
    expect(mockInsertVolumes).toHaveBeenCalledWith([
      {
        product: 'ES',
        tradeDate: '2026-09-29',
        contract: 'ESZ6',
        volume: 1000,
      },
      {
        product: 'ES',
        tradeDate: '2026-09-29',
        contract: 'ESH7',
        volume: 1000,
      },
      {
        product: 'ES',
        tradeDate: '2026-09-29',
        contract: 'ESM7',
        volume: 1000,
      },
    ]);
    expect(result).toEqual({
      contracts: ['ESZ6', 'ESH7', 'ESM7'],
      offered: 3,
      inserted: 3,
    });
  });

  it('passes the range through: a seed-style run can ask for 6m', async () => {
    await refreshFrontMonthVolumes(KEY, 'ES', '6m');

    expect(mockFetchDaily).toHaveBeenCalledWith(
      KEY,
      'ES',
      expect.any(Array),
      '6m',
    );
  });

  it("takes the latest stored decision as the incumbent, and the cycle's own months after it (CL is monthly)", async () => {
    mockFetchStored.mockResolvedValue(
      new Map([
        ['2026-09-10', 'CLU6'],
        ['2026-09-28', 'CLV6'],
      ]),
    );

    await refreshFrontMonthVolumes(KEY, 'CL', '1m');

    expect(mockFetchDaily).toHaveBeenCalledWith(
      KEY,
      'CL',
      ['CLV6', 'CLX6', 'CLZ6'],
      '1m',
    );
  });

  it('puts the incumbent first even where it is not a cycle contract (a GC odd month)', async () => {
    mockFetchStored.mockResolvedValue(new Map([['2026-09-28', 'GCK7']]));
    mockFetchDaily.mockResolvedValue([dailyRow('GCK7', '2026-09-29', 5)]);

    await refreshFrontMonthVolumes(KEY, 'GC', '1m');

    expect(mockFetchDaily).toHaveBeenCalledWith(
      KEY,
      'GC',
      ['GCK7', 'GCM7', 'GCQ7'],
      '1m',
    );
  });

  it("with no decision stored in the last 30 days the incumbent is the root's listing-cycle seed", async () => {
    mockFetchStored.mockResolvedValue(new Map());

    await refreshFrontMonthVolumes(KEY, 'ES', '1m');

    // September 2026 has not stopped trading by the month, so ESU6 is first.
    expect(mockFetchDaily).toHaveBeenCalledWith(
      KEY,
      'ES',
      ['ESU6', 'ESZ6', 'ESH7'],
      '1m',
    );
  });

  // ── The rows stored ───────────────────────────────────

  it('stores only trade dates before the current one: the running session’s partial volume is dropped', async () => {
    mockFetchDaily.mockResolvedValue([
      dailyRow('ESZ6', '2026-09-28', 900),
      dailyRow('ESZ6', '2026-09-29', 800),
      dailyRow('ESH7', '2026-09-29', 40),
      dailyRow('ESZ6', '2026-09-30', 120),
    ]);
    // Three rows offered, two already stored (DO NOTHING).
    mockInsertVolumes.mockResolvedValue(1);

    const result = await refreshFrontMonthVolumes(KEY, 'ES', '1m');

    expect(mockInsertVolumes).toHaveBeenCalledWith([
      { product: 'ES', tradeDate: '2026-09-28', contract: 'ESZ6', volume: 900 },
      { product: 'ES', tradeDate: '2026-09-29', contract: 'ESZ6', volume: 800 },
      { product: 'ES', tradeDate: '2026-09-29', contract: 'ESH7', volume: 40 },
    ]);
    expect(result).toMatchObject({ offered: 3, inserted: 1 });
  });

  // ── Faults ────────────────────────────────────────────

  it('fails, naming the root and the incumbent, when no daily candle comes back for the incumbent: an empty body is also what UW returns on a fault', async () => {
    mockFetchDaily.mockResolvedValue([
      dailyRow('ESH7', '2026-09-29', 40),
      dailyRow('ESM7', '2026-09-29', 1),
    ]);

    await expect(refreshFrontMonthVolumes(KEY, 'ES', '1m')).rejects.toThrow(
      /no daily candles for the ES incumbent ESZ6/,
    );
    expect(mockInsertVolumes).not.toHaveBeenCalled();
  });

  it('an empty result for a contract after the incumbent is not a fault: a new month can have no history', async () => {
    mockFetchDaily.mockResolvedValue([dailyRow('ESZ6', '2026-09-29', 1_000)]);

    await expect(
      refreshFrontMonthVolumes(KEY, 'ES', '1m'),
    ).resolves.toMatchObject({ offered: 1 });
  });

  it('fails, naming the root, when the stored incumbent is no outright of it, before any UW call', async () => {
    mockFetchStored.mockResolvedValue(new Map([['2026-09-29', 'NQZ6']]));

    await expect(refreshFrontMonthVolumes(KEY, 'ES', '1m')).rejects.toThrow(
      /NQZ6 is not an outright ES/,
    );
    expect(mockFetchDaily).not.toHaveBeenCalled();
  });

  it('lets a failed stored-decision read through, with no UW call and nothing stored', async () => {
    mockFetchStored.mockRejectedValue(new Error('connection terminated'));

    await expect(refreshFrontMonthVolumes(KEY, 'ES', '1m')).rejects.toThrow(
      'connection terminated',
    );
    expect(mockFetchDaily).not.toHaveBeenCalled();
    expect(mockInsertVolumes).not.toHaveBeenCalled();
  });

  it.each([
    ['a UW error', 'UW API 502: bad gateway'],
    [
      'a malformed daily candle',
      'fetchDailyContractVolumes: UW daily candles for ES contract ESZ6: row 0 is malformed (v: Invalid input)',
    ],
  ])('lets %s through, with nothing stored', async (_name, message) => {
    mockFetchDaily.mockRejectedValue(new Error(message));

    await expect(refreshFrontMonthVolumes(KEY, 'ES', '1m')).rejects.toThrow(
      message,
    );
    expect(mockInsertVolumes).not.toHaveBeenCalled();
  });

  it('lets a rejected volume insert through', async () => {
    mockInsertVolumes.mockRejectedValue(new Error('connection terminated'));

    await expect(refreshFrontMonthVolumes(KEY, 'ES', '1m')).rejects.toThrow(
      'connection terminated',
    );
  });
});

// ── Freshness: UW has filed the last session ──────────────

describe('refreshFrontMonthVolumes freshness check', () => {
  it('reads the root’s latest bar before the current session open, by one query on (symbol, ts)', async () => {
    await refreshFrontMonthVolumes(KEY, 'ES', '1m');

    expect(mockSql).toHaveBeenCalledTimes(1);
    const strings = mockSql.mock.calls[0]![0] as readonly string[];
    const text = strings.join('?');
    expect(text).toContain('FROM futures_bars');
    expect(text).toContain('symbol = ');
    // Strictly before: a bar at the open minute is the current session's.
    expect(text).toContain('ts < ');
    expect(text).toContain('ORDER BY ts DESC');
    expect(text).toContain('LIMIT 1');
    // The summer open of 2026-09-30: 17:00 CDT the evening before.
    expect(mockSql.mock.calls[0]!.slice(1)).toEqual([
      'ES',
      '2026-09-29T22:00:00.000Z',
    ]);
  });

  it('bounds the query at the winter open too: 23:00Z, 17:00 CST', async () => {
    vi.setSystemTime(new Date('2026-12-01T06:00:00Z'));
    mockFetchStored.mockResolvedValue(new Map([['2026-11-30', 'ESZ6']]));
    mockFetchDaily.mockResolvedValue([dailyRow('ESZ6', '2026-11-30', 1_000)]);
    // Mon 15:59 CST: trade date 2026-11-30.
    mockSql.mockResolvedValue([{ ts: new Date('2026-11-30T21:59:00Z') }]);

    await refreshFrontMonthVolumes(KEY, 'ES', '1m');

    expect(mockSql.mock.calls[0]!.slice(1)).toEqual([
      'ES',
      '2026-11-30T23:00:00.000Z',
    ]);
  });

  it('passes when the incumbent’s newest candle is the last session’s', async () => {
    mockFetchDaily.mockResolvedValue([
      dailyRow('ESZ6', '2026-09-28', 900),
      dailyRow('ESZ6', '2026-09-29', 800),
    ]);

    await expect(
      refreshFrontMonthVolumes(KEY, 'ES', '1m'),
    ).resolves.toMatchObject({ offered: 2 });
  });

  it('fails by name, with both dates and no row stored, when the incumbent’s newest candle is older than the last session: UW has not filed it yet', async () => {
    mockFetchDaily.mockResolvedValue([
      dailyRow('ESZ6', '2026-09-27', 900),
      dailyRow('ESZ6', '2026-09-28', 800),
      // The challenger's candle is fresh; the incumbent's is what counts.
      dailyRow('ESH7', '2026-09-29', 40),
    ]);

    const failure = refreshFrontMonthVolumes(KEY, 'ES', '1m');

    await expect(failure).rejects.toThrow(/stale daily candles for ES:/);
    await expect(failure).rejects.toThrow(/ESZ6.*2026-09-28/);
    await expect(failure).rejects.toThrow(/last session.*2026-09-29/);
    expect(mockInsertVolumes).not.toHaveBeenCalled();
  });

  it('fails when the incumbent has no candle before the current trade date, only the running session’s', async () => {
    mockFetchDaily.mockResolvedValue([dailyRow('ESZ6', '2026-09-30', 120)]);

    await expect(refreshFrontMonthVolumes(KEY, 'ES', '1m')).rejects.toThrow(
      /stale daily candles.*ESZ6.*missing.*2026-09-29/,
    );
    expect(mockInsertVolumes).not.toHaveBeenCalled();
  });

  it('passes across a weekend: Monday’s last session is Friday, and Friday’s candle is the newest there is', async () => {
    // Monday 2026-10-05 06:00Z: the session opened Sunday 17:00 CDT.
    vi.setSystemTime(new Date('2026-10-05T06:00:00Z'));
    mockFetchStored.mockResolvedValue(new Map([['2026-10-02', 'ESZ6']]));
    mockFetchDaily.mockResolvedValue([
      dailyRow('ESZ6', '2026-10-01', 900),
      dailyRow('ESZ6', '2026-10-02', 800),
    ]);
    // Fri 15:59 CDT: trade date 2026-10-02.
    mockSql.mockResolvedValue([{ ts: new Date('2026-10-02T20:59:00Z') }]);

    await expect(
      refreshFrontMonthVolumes(KEY, 'ES', '1m'),
    ).resolves.toMatchObject({ offered: 2 });
    expect(mockSql.mock.calls[0]!.slice(1)).toEqual([
      'ES',
      '2026-10-04T22:00:00.000Z',
    ]);
  });

  it('dates a bar by its CME trade date, not the calendar: an evening bar after the 17:00 CT open belongs to the next date', async () => {
    // Mon 18:30 CDT is the open of Tuesday 2026-09-29's session, and the
    // last bar there is (the root went quiet after it).
    mockSql.mockResolvedValue([{ ts: new Date('2026-09-28T23:30:00Z') }]);
    mockFetchDaily.mockResolvedValue([dailyRow('ESZ6', '2026-09-28', 900)]);

    await expect(refreshFrontMonthVolumes(KEY, 'ES', '1m')).rejects.toThrow(
      /stale daily candles.*2026-09-28.*2026-09-29/,
    );
  });

  it('a candle that stops on Thursday fails across that same weekend', async () => {
    vi.setSystemTime(new Date('2026-10-05T06:00:00Z'));
    mockFetchStored.mockResolvedValue(new Map([['2026-10-02', 'ESZ6']]));
    mockFetchDaily.mockResolvedValue([dailyRow('ESZ6', '2026-10-01', 900)]);
    mockSql.mockResolvedValue([{ ts: new Date('2026-10-02T20:59:00Z') }]);

    await expect(refreshFrontMonthVolumes(KEY, 'ES', '1m')).rejects.toThrow(
      /stale daily candles.*2026-10-01.*2026-10-02/,
    );
  });

  it('skips the check and logs why when the root has no bars before the current trade date', async () => {
    mockSql.mockResolvedValue([]);
    // Stale on its face, but there is no session to measure it against.
    mockFetchDaily.mockResolvedValue([dailyRow('ESZ6', '2026-09-20', 900)]);

    await expect(
      refreshFrontMonthVolumes(KEY, 'ES', '1m'),
    ).resolves.toMatchObject({ offered: 1 });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ root: 'ES', tradeDate: '2026-09-30' }),
      expect.stringContaining('freshness check skipped'),
    );
  });

  it('lets a failed bars query through, with nothing stored', async () => {
    mockSql.mockRejectedValue(new Error('db attempt timeout'));

    await expect(refreshFrontMonthVolumes(KEY, 'ES', '1m')).rejects.toThrow(
      'db attempt timeout',
    );
    expect(mockInsertVolumes).not.toHaveBeenCalled();
  });

  it('does not query the bars when the incumbent has no candle at all: that fault is named first', async () => {
    mockFetchDaily.mockResolvedValue([dailyRow('ESH7', '2026-09-29', 40)]);

    await expect(refreshFrontMonthVolumes(KEY, 'ES', '1m')).rejects.toThrow(
      /no daily candles/,
    );
    expect(mockSql).not.toHaveBeenCalled();
  });
});
