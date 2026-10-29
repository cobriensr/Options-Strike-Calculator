// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (module boundary — R3) ──────────────────────────

const { mockUwFetch, mockWithRetry } = vi.hoisted(() => ({
  mockUwFetch: vi.fn(),
  mockWithRetry: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  withRetry: mockWithRetry,
}));

import {
  FUTURES_ROOTS,
  fetchFuturesContracts,
  frontMonthCandidates,
  replayFrontMonth,
} from '../_lib/futures-contracts.js';

// ── Fixtures ──────────────────────────────────────────────

/** Live `/futures/contracts` shape (probed 2026-09-30), trimmed. */
const CONTRACTS = [
  { name: 'ESZ6', product: 'ES', is_spread: false, volume: 3_267_170 },
  // Micro: `q=ES` substring-matches it, so selection must use EQUALITY.
  { name: 'MESZ6', product: 'MES', is_spread: false, volume: 2_363_415 },
  { name: 'ESH7', product: 'ES', is_spread: false, volume: 1_562 },
  { name: 'ESZ7', product: 'ES', is_spread: false, volume: 5 },
  { name: 'ESZ6-ESH7', product: 'ES', is_spread: true, volume: 9_999_999 },
  { name: 'NQZ6', product: 'NQ', is_spread: false, volume: 1_270_100 },
  { name: 'NQH7', product: 'NQ', is_spread: false, volume: 1_789 },
];

describe('FUTURES_ROOTS', () => {
  it('lists the six UW-covered roots the uw-stream handler writes (no DX or VX)', () => {
    expect(FUTURES_ROOTS).toEqual(['ES', 'NQ', 'RTY', 'CL', 'GC', 'ZN']);
  });
});

describe('frontMonthCandidates', () => {
  it.each<[string, unknown[], string, string[]]>([
    [
      'top 2 by volume, exact product, spreads excluded',
      CONTRACTS,
      'ES',
      ['ESZ6', 'ESH7'],
    ],
    ['another root from the same list', CONTRACTS, 'NQ', ['NQZ6', 'NQH7']],
    [
      'a micro product never matches its full-size root',
      [{ name: 'MESZ6', product: 'MES', is_spread: false, volume: 9 }],
      'ES',
      [],
    ],
    [
      'a spread never wins, however large its volume',
      [
        { name: 'ESZ6-ESH7', product: 'ES', is_spread: true, volume: 1e9 },
        { name: 'ESZ6', product: 'ES', is_spread: false, volume: 1 },
      ],
      'ES',
      ['ESZ6'],
    ],
    [
      'a missing is_spread counts as not a spread',
      [{ name: 'ESZ6', product: 'ES', volume: 10 }],
      'ES',
      ['ESZ6'],
    ],
    [
      'equal volumes tie to the larger symbol (codepoint order)',
      [
        { name: 'ESH7', product: 'ES', volume: 50 },
        { name: 'ESZ6', product: 'ES', volume: 50 },
        { name: 'ESM7', product: 'ES', volume: 50 },
      ],
      'ES',
      ['ESZ6', 'ESM7'],
    ],
    [
      'a non-numeric volume ranks as 0',
      [
        { name: 'ESZ6', product: 'ES', volume: '3000000' },
        { name: 'ESH7', product: 'ES', volume: 1 },
      ],
      'ES',
      ['ESH7', 'ESZ6'],
    ],
    [
      'rows without a usable name, and non-objects, are skipped',
      [
        null,
        'ESZ6',
        42,
        { product: 'ES', volume: 100 },
        { name: '', product: 'ES', volume: 100 },
        { name: 7, product: 'ES', volume: 100 },
        { name: 'ESZ6', product: 'ES', volume: 1 },
      ],
      'ES',
      ['ESZ6'],
    ],
    [
      'fewer than two candidates returns what there is',
      [{ name: 'GCZ6', product: 'GC', volume: 5 }],
      'GC',
      ['GCZ6'],
    ],
    ['no contract for the root returns []', CONTRACTS, 'ZN', []],
    ['an empty list returns []', [], 'ES', []],
  ])('%s', (_label, contracts, root, expected) => {
    expect(frontMonthCandidates(contracts, root)).toEqual(expected);
  });

  it('does not reorder or mutate the input list', () => {
    const input = CONTRACTS.map((c) => ({ ...c }));
    const snapshot = JSON.stringify(input);
    frontMonthCandidates(input, 'ES');
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('replayFrontMonth', () => {
  /** A per-contract minute row; `tag` shows which row the replay kept. */
  const row = (ts: string, volume: number, tag = '') => ({ ts, volume, tag });

  it('per minute, emits the row of the contract leading the cumulative UTC-day volume', () => {
    const out = replayFrontMonth(
      new Map([
        [
          'ESU6',
          [
            row('2026-09-14T13:00:00.000Z', 100, 'U1'),
            row('2026-09-14T13:01:00.000Z', 10, 'U2'),
          ],
        ],
        [
          'ESZ6',
          [
            row('2026-09-14T13:00:00.000Z', 40, 'Z1'),
            row('2026-09-14T13:01:00.000Z', 80, 'Z2'),
          ],
        ],
      ]),
    );
    // 13:00 ESU6 100 vs 40. 13:01 ESZ6 overtakes on the tally (120 vs 110).
    expect(out).toEqual([
      { contract: 'ESU6', row: row('2026-09-14T13:00:00.000Z', 100, 'U1') },
      { contract: 'ESZ6', row: row('2026-09-14T13:01:00.000Z', 80, 'Z2') },
    ]);
  });

  it('resets the tally at 00:00 UTC, ties to the larger symbol, and leaves a minute empty when the leader has no row', () => {
    const out = replayFrontMonth(
      new Map([
        [
          'ESZ6',
          [
            row('2026-09-28T23:55:00.000Z', 10),
            row('2026-09-29T00:00:00.000Z', 20),
            row('2026-09-29T00:02:00.000Z', 5),
          ],
        ],
        [
          'ESH7',
          [
            row('2026-09-28T23:55:00.000Z', 1_000),
            row('2026-09-29T00:00:00.000Z', 20),
            row('2026-09-29T00:01:00.000Z', 100),
          ],
        ],
      ]),
    );
    expect(out.map((e) => [e.row.ts, e.contract])).toEqual([
      ['2026-09-28T23:55:00.000Z', 'ESH7'],
      // New UTC day: 20 vs 20 → 'ESZ6' > 'ESH7'.
      ['2026-09-29T00:00:00.000Z', 'ESZ6'],
      ['2026-09-29T00:01:00.000Z', 'ESH7'],
      // 00:02 ESH7 still leads (120 vs 25) but has no row → no entry.
    ]);
  });

  it('returns [] for no contracts or no rows', () => {
    expect(replayFrontMonth(new Map())).toEqual([]);
    expect(replayFrontMonth(new Map([['ESZ6', []]]))).toEqual([]);
  });
});

describe('fetchFuturesContracts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWithRetry.mockImplementation((fn: () => unknown) => fn());
  });

  it('fetches the 5-session contract list once, through withRetry, with the caller key', async () => {
    mockUwFetch.mockResolvedValueOnce(CONTRACTS);

    await expect(fetchFuturesContracts('uw-key')).resolves.toEqual(CONTRACTS);

    expect(mockWithRetry).toHaveBeenCalledTimes(1);
    expect(mockUwFetch).toHaveBeenCalledTimes(1);
    expect(mockUwFetch).toHaveBeenCalledWith(
      'uw-key',
      '/futures/contracts?days=5',
    );
  });

  it('throws on a non-array payload instead of selecting from it', async () => {
    mockUwFetch.mockResolvedValueOnce({ unexpected: 'shape' });

    await expect(fetchFuturesContracts('uw-key')).rejects.toThrow(
      'UW /futures/contracts returned a non-array payload',
    );
  });

  it('propagates an upstream error unchanged', async () => {
    mockUwFetch.mockRejectedValueOnce(new Error('UW API 500: upstream down'));

    await expect(fetchFuturesContracts('uw-key')).rejects.toThrow(
      'UW API 500: upstream down',
    );
  });
});
