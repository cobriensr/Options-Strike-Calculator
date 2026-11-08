// @vitest-environment node

/**
 * The shared daily-candle fetch for the front-month seed and the gap cron
 * (`api/_lib/futures-daily-candles.ts`): which contracts a root lists in a
 * span of months, and each one's per-session volume from UW's
 * `GET /futures/{contract}/candles?interval=1d`.
 *
 * `uwFetch` is the only seam (mocked at its module, the real `withRetry` and
 * `mapWithConcurrency` around it), so the retry, the fan-out limit and the
 * parse run for real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUwFetch } = vi.hoisted(() => ({ mockUwFetch: vi.fn() }));

vi.mock('../_lib/uw-fetch.js', async () => {
  const actual = await vi.importActual<typeof import('../_lib/uw-fetch.js')>(
    '../_lib/uw-fetch.js',
  );
  return { ...actual, uwFetch: mockUwFetch };
});

import {
  CONTRACT_CYCLE,
  FUTURES_ROOTS,
  MONTH_CODES,
  canonicalContract,
  compareExpiry,
  parseContract,
} from '../_lib/futures-contracts.js';
import {
  cycleContracts,
  fetchDailyContractVolumes,
} from '../_lib/futures-daily-candles.js';
import { UW_CONCURRENCY_CAP } from '../_lib/uw-concurrency.js';

// ── cycleContracts ────────────────────────────────────────

describe('cycleContracts', () => {
  it.each([
    // The contract month is what is compared: ESH7 is March 2027.
    ['ES', '2026-07', '2027-03', ['ESU6', 'ESZ6', 'ESH7']],
    ['ES', '2026-07', '2027-02', ['ESU6', 'ESZ6']],
    ['ES', '2026-09', '2026-09', ['ESU6']],
    ['ES', '2026-12', '2027-03', ['ESZ6', 'ESH7']],
    ['ES', '2026-10', '2026-11', []],
    // CL lists every month.
    ['CL', '2026-11', '2027-02', ['CLX6', 'CLZ6', 'CLF7', 'CLG7']],
    // GC: the even months only, over a year end.
    ['GC', '2026-09', '2027-04', ['GCV6', 'GCZ6', 'GCG7', 'GCJ7']],
    ['NQ', '2026-12', '2027-06', ['NQZ6', 'NQH7', 'NQM7']],
    ['RTY', '2026-03', '2026-03', ['RTYH6']],
    ['ZN', '2027-09', '2027-12', ['ZNU7', 'ZNZ7']],
    // The year digit wraps each decade.
    ['ES', '2029-09', '2030-06', ['ESU9', 'ESZ9', 'ESH0', 'ESM0']],
  ] as const)(
    '%s from %s to %s lists %j, bounds included',
    (root, from, to, expected) => {
      expect(cycleContracts(root, from, to)).toEqual(expected);
    },
  );

  it.each(FUTURES_ROOTS)(
    '%s: every name parses back to the contract month it was made for, in expiry order, and is its own canonical name',
    (root) => {
      const names = cycleContracts(root, '2026-01', '2027-12');
      // The one-digit window [ref - 1, ref + 8] holds both years.
      const ref = '2027-06-15';

      const expected = [2026, 2027].flatMap((year) =>
        [...CONTRACT_CYCLE[root]].map((code) => ({
          year,
          month: MONTH_CODES.indexOf(code) + 1,
        })),
      );
      const parsed = names.map((name) => parseContract(root, name, ref));
      expect(parsed).toEqual(expected);
      for (const name of names) {
        expect(canonicalContract(root, name, ref)).toBe(name);
      }
      for (let i = 1; i < parsed.length; i++) {
        expect(compareExpiry(parsed[i - 1]!, parsed[i]!)).toBeLessThan(0);
      }
    },
  );

  // Two included months exactly 120 apart would share a name (ESM6 of 2026
  // and of 2036), so a span is refused from 120 months between its ends.
  it.each([
    ['2026-01', '2035-12', 40],
    // Eleven calendar years, but no two included months 120 apart.
    ['2026-06', '2036-05', 40],
  ] as const)(
    'names %s to %s, ten years, without two contracts sharing a name',
    (from, to, expected) => {
      const names = cycleContracts('ES', from, to);

      expect(names).toHaveLength(expected);
      expect(new Set(names).size).toBe(expected);
    },
  );

  it.each([
    // The first month of an eleventh year.
    ['2026-01', '2036-01'],
    // Exactly 120 months apart: ESM6 twice.
    ['2026-06', '2036-06'],
  ])('refuses %s to %s, naming the function, the root and both', (from, to) => {
    expect(() => cycleContracts('ES', from, to)).toThrow(
      new RegExp(`cycleContracts.*ES.*${from}.*${to}`),
    );
  });

  it.each([
    '2026-7',
    '2026-13',
    '2026-00',
    '26-07',
    '202607',
    '2026-07-01',
    '',
    'July',
  ])(
    'rejects the malformed month %j in either position, naming the function and the value',
    (bad) => {
      const quoted = JSON.stringify(bad).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(() => cycleContracts('ES', bad, '2027-03')).toThrow(
        new RegExp(`cycleContracts.*${quoted}`),
      );
      expect(() => cycleContracts('ES', '2026-07', bad)).toThrow(
        new RegExp(`cycleContracts.*${quoted}`),
      );
    },
  );

  it('rejects a from month after the to month, naming both', () => {
    expect(() => cycleContracts('ES', '2027-01', '2026-12')).toThrow(
      /cycleContracts.*ES.*2027-01.*2026-12/,
    );
  });
});

// ── fetchDailyContractVolumes ─────────────────────────────

const KEY = 'test-uw-key';
const pathOf = (contract: string, range = '6m') =>
  `/futures/${contract}/candles?interval=1d&range=${range}`;

/** One 1d candle as UW serves it (probed 2026-11-06): strings and `v`. */
function candle(date: string, v: unknown, extra: Record<string, unknown> = {}) {
  return {
    date,
    start: `${date}T00:00:00Z`,
    end: `${date}T23:00:00Z`,
    o: '7000.25',
    h: '7010.00',
    l: '6990.50',
    c: '7005.75',
    v,
    vol: v,
    tv: v,
    ...extra,
  };
}

describe('fetchDailyContractVolumes', () => {
  beforeEach(() => {
    mockUwFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks UW once per contract for its daily candles over the range, with the key and no extractor', async () => {
    mockUwFetch.mockResolvedValue([]);

    await fetchDailyContractVolumes(KEY, 'ES', ['ESU6', 'ESZ6'], '6m');

    expect(mockUwFetch).toHaveBeenCalledTimes(2);
    expect(mockUwFetch).toHaveBeenCalledWith(KEY, pathOf('ESU6'));
    expect(mockUwFetch).toHaveBeenCalledWith(KEY, pathOf('ESZ6'));
  });

  it('takes the range as given: it is a parameter, and is URL-encoded', async () => {
    mockUwFetch.mockResolvedValue([]);

    await fetchDailyContractVolumes(KEY, 'ES', ['ESZ6'], '1w');
    await fetchDailyContractVolumes(KEY, 'ES', ['ESZ6'], '6m&x=1');

    expect(mockUwFetch).toHaveBeenNthCalledWith(1, KEY, pathOf('ESZ6', '1w'));
    expect(mockUwFetch).toHaveBeenNthCalledWith(
      2,
      KEY,
      pathOf('ESZ6', '6m%26x%3D1'),
    );
  });

  it('returns the canonical contract, the trade date and the volume; extra keys are ignored and a zero is kept', async () => {
    mockUwFetch.mockResolvedValueOnce([
      candle('2026-11-03', 1_234_567),
      candle('2026-11-04', 0),
    ]);

    await expect(
      fetchDailyContractVolumes(KEY, 'ES', ['ESZ6'], '6m'),
    ).resolves.toEqual([
      { contract: 'ESZ6', tradeDate: '2026-11-03', volume: 1_234_567 },
      { contract: 'ESZ6', tradeDate: '2026-11-04', volume: 0 },
    ]);
  });

  it('orders the rows by contract in the order given, then by trade date ascending, whichever call answers first or in whatever order UW lists the days', async () => {
    const answers = new Map<string, (rows: unknown[]) => void>();
    mockUwFetch.mockImplementation(
      (_key: string, path: string) =>
        new Promise((resolve) => answers.set(path, resolve)),
    );

    const outcome = fetchDailyContractVolumes(
      KEY,
      'ES',
      ['ESU6', 'ESZ6', 'ESH7'],
      '6m',
    );
    await vi.waitFor(() => expect(answers.size).toBe(3));
    // Answered in the reverse order, each newest day first.
    answers.get(pathOf('ESH7'))!([candle('2026-11-04', 7)]);
    answers.get(pathOf('ESZ6'))!([
      candle('2026-11-04', 5),
      candle('2026-11-03', 4),
      candle('2026-11-02', 3),
    ]);
    answers.get(pathOf('ESU6'))!([
      candle('2026-09-01', 2),
      candle('2026-08-31', 1),
    ]);

    await expect(outcome).resolves.toEqual([
      { contract: 'ESU6', tradeDate: '2026-08-31', volume: 1 },
      { contract: 'ESU6', tradeDate: '2026-09-01', volume: 2 },
      { contract: 'ESZ6', tradeDate: '2026-11-02', volume: 3 },
      { contract: 'ESZ6', tradeDate: '2026-11-03', volume: 4 },
      { contract: 'ESZ6', tradeDate: '2026-11-04', volume: 5 },
      { contract: 'ESH7', tradeDate: '2026-11-04', volume: 7 },
    ]);
  });

  it('treats a contract with no history as no rows, not an error, and still returns the others', async () => {
    mockUwFetch
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([candle('2026-11-04', 9)]);

    await expect(
      fetchDailyContractVolumes(KEY, 'ES', ['ESH8', 'ESZ6'], '6m'),
    ).resolves.toEqual([
      { contract: 'ESZ6', tradeDate: '2026-11-04', volume: 9 },
    ]);
  });

  it('does nothing, with no call, for no contracts', async () => {
    await expect(
      fetchDailyContractVolumes(KEY, 'ES', [], '6m'),
    ).resolves.toEqual([]);

    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('keeps at most UW_CONCURRENCY_CAP calls in flight, and uses all of them', async () => {
    let inFlight = 0;
    let peak = 0;
    mockUwFetch.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return [];
    });
    const contracts = cycleContracts('CL', '2026-11', '2027-06');
    expect(contracts).toHaveLength(8);

    await fetchDailyContractVolumes(KEY, 'CL', contracts, '6m');

    expect(mockUwFetch).toHaveBeenCalledTimes(8);
    expect(peak).toBe(UW_CONCURRENCY_CAP);
  });

  describe('when UW fails', () => {
    it('retries a transient failure once and still answers', async () => {
      vi.useFakeTimers();
      mockUwFetch
        .mockRejectedValueOnce(
          new Error('UW API 429: You have exceeded 3 concurrent requests'),
        )
        .mockResolvedValueOnce([candle('2026-11-04', 9)]);

      const outcome = fetchDailyContractVolumes(KEY, 'ES', ['ESZ6'], '6m');
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(outcome).resolves.toEqual([
        { contract: 'ESZ6', tradeDate: '2026-11-04', volume: 9 },
      ]);
      expect(mockUwFetch).toHaveBeenCalledTimes(2);
    });

    it('gives up after the retries on a transient error that never clears: the last error reaches the caller', async () => {
      vi.useFakeTimers();
      mockUwFetch.mockRejectedValue(new Error('UW API 503: unavailable'));

      const outcome = fetchDailyContractVolumes(KEY, 'ES', ['ESZ6'], '6m').then(
        () => null,
        (err: unknown) => err,
      );
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await outcome).toMatchObject({
        message: 'UW API 503: unavailable',
      });
      expect(mockUwFetch).toHaveBeenCalledTimes(3);
    });

    it('rejects with an error that is not retryable as it is, after one call, and returns no rows for the other contracts', async () => {
      mockUwFetch
        .mockResolvedValueOnce([candle('2026-11-04', 9)])
        .mockRejectedValueOnce(new Error('UW API 403: route_not_permitted'));

      await expect(
        fetchDailyContractVolumes(KEY, 'ES', ['ESU6', 'ESZ6'], '6m'),
      ).rejects.toThrow('UW API 403: route_not_permitted');

      expect(mockUwFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('when the payload is not what UW documents', () => {
    it.each([
      ['an object', { message: 'nope' }],
      ['a string', 'oops'],
      ['a number', 42],
      ['null', null],
    ])(
      'throws, naming the root and the contract, on %s instead of an array',
      async (_what, payload) => {
        mockUwFetch.mockResolvedValueOnce(payload);

        await expect(
          fetchDailyContractVolumes(KEY, 'ES', ['ESZ6'], '6m'),
        ).rejects.toThrow(/fetchDailyContractVolumes.*ES.*ESZ6.*array/);
      },
    );

    it.each([
      ['a missing date', { v: 5 }, 'date'],
      ['a date that is not a date', candle('tomorrow', 5), 'date'],
      ['a date with a time', candle('2026-11-04T00:00:00Z', 5), 'date'],
      ['a date that is not on the calendar', candle('2026-02-30', 5), 'date'],
      ['a missing volume', { date: '2026-11-04' }, 'v'],
      ['a negative volume', candle('2026-11-04', -1), 'v'],
      ['a fractional volume', candle('2026-11-04', 1.5), 'v'],
      ['a volume beyond 2^53', candle('2026-11-04', 2 ** 53), 'v'],
      ['a volume sent as a string', candle('2026-11-04', '12'), 'v'],
      ['a null volume', candle('2026-11-04', null), 'v'],
      // No field to name: the row itself is the wrong type.
      ['a row that is null', null, 'row'],
      ['a row that is a string', 'x', 'row'],
    ])(
      'throws, naming the root, the contract, the row and the field, on %s',
      async (_what, bad, field) => {
        mockUwFetch.mockResolvedValueOnce([candle('2026-11-03', 5), bad]);

        const err = await fetchDailyContractVolumes(
          KEY,
          'ES',
          ['ESZ6'],
          '6m',
        ).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(
          /fetchDailyContractVolumes.*ES.*ESZ6.*row 1/,
        );
        expect((err as Error).message).toContain(
          `row 1 is malformed (${field}: `,
        );
      },
    );

    it('names the contract whose payload is bad, not the first one', async () => {
      mockUwFetch
        .mockResolvedValueOnce([candle('2026-11-04', 5)])
        .mockResolvedValueOnce([candle('2026-11-04', 'x')]);

      const err = await fetchDailyContractVolumes(
        KEY,
        'ES',
        ['ESU6', 'ESZ6'],
        '6m',
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/ESZ6/);
      expect((err as Error).message).not.toMatch(/ESU6/);
    });

    it('throws, naming the contract and the date, when one trade date comes twice', async () => {
      mockUwFetch.mockResolvedValueOnce([
        candle('2026-11-03', 5),
        candle('2026-11-04', 6),
        candle('2026-11-03', 7),
      ]);

      await expect(
        fetchDailyContractVolumes(KEY, 'ES', ['ESZ6'], '6m'),
      ).rejects.toThrow(/fetchDailyContractVolumes.*ES.*ESZ6.*2026-11-03/);
    });
  });

  describe('contracts that are not canonical outrights of the root', () => {
    it.each([
      ['a two-digit spelling', 'ESZ26'],
      ['a spread', 'ESZ6-ESH7'],
      ['a contract of another root', 'NQZ6'],
      ['a micro', 'MESZ6'],
      ['a bare root', 'ES'],
      ['lowercase', 'esz6'],
      ['a two-digit year outside the window', 'ESZ36'],
      ['an empty name', ''],
    ])(
      'throws on %s, naming it and the root, before any call',
      async (_what, contract) => {
        await expect(
          fetchDailyContractVolumes(KEY, 'ES', ['ESU6', contract], '6m'),
        ).rejects.toThrow(
          new RegExp(
            `fetchDailyContractVolumes.*canonical ES.*${JSON.stringify(contract)}`,
          ),
        );

        expect(mockUwFetch).not.toHaveBeenCalled();
      },
    );
  });

  it('throws before any call, naming the first contract that is listed twice and the root', async () => {
    // ESU6 repeats at the third place, ESZ6 at the fourth.
    const err = await fetchDailyContractVolumes(
      KEY,
      'ES',
      ['ESU6', 'ESZ6', 'ESU6', 'ESZ6'],
      '6m',
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /fetchDailyContractVolumes.*ES.*ESU6.*more than once/,
    );
    expect((err as Error).message).not.toMatch(/ESZ6/);
    expect(mockUwFetch).not.toHaveBeenCalled();
  });
});
