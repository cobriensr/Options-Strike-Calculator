// @vitest-environment node

import { readFileSync } from 'node:fs';
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
  CONTRACT_CYCLE,
  FUTURES_ROOTS,
  MONTH_CODES,
  ROLL_GUARD_CLOSES,
  SEED_LOOKBACK_DAYS,
  canonicalContract,
  compareExpiry,
  fetchFuturesContracts,
  frontMonthCandidates,
  nullSeedContract,
  parseContract,
  replayFrontMonth,
  replayRollForward,
} from '../_lib/futures-contracts.js';
import type { ContractMinute, FuturesRoot } from '../_lib/futures-contracts.js';

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

describe('roll-forward constants', () => {
  it('pins the guard length, the seed lookback and the listing cycle', () => {
    expect(ROLL_GUARD_CLOSES).toBe(120);
    expect(SEED_LOOKBACK_DAYS).toBe(7);
    expect(MONTH_CODES).toBe('FGHJKMNQUVXZ');
    expect(CONTRACT_CYCLE).toEqual({
      ES: 'HMUZ',
      NQ: 'HMUZ',
      RTY: 'HMUZ',
      ZN: 'HMUZ',
      CL: 'FGHJKMNQUVXZ',
      GC: 'GJMQVZ',
    });
  });
});

describe('parseContract', () => {
  const REF = '2026-06-15T12:00:00.000Z';

  it.each([
    ['F', 1],
    ['G', 2],
    ['H', 3],
    ['J', 4],
    ['K', 5],
    ['M', 6],
    ['N', 7],
    ['Q', 8],
    ['U', 9],
    ['V', 10],
    ['X', 11],
    ['Z', 12],
  ])(
    'month code %s is month %i, in the one- and two-digit year forms',
    (code, month) => {
      expect(parseContract('ES', `ES${code}6`, REF)).toEqual({
        month,
        year: 2026,
      });
      expect(parseContract('ES', `ES${code}27`, REF)).toEqual({
        month,
        year: 2027,
      });
    },
  );

  it.each(FUTURES_ROOTS)('accepts its own root prefix: %s', (root) => {
    expect(parseContract(root, `${root}Z6`, REF)).toEqual({
      month: 12,
      year: 2026,
    });
  });

  it('reads a two-digit year as 20YY, whatever the reference year', () => {
    expect(parseContract('ES', 'ESH07', REF)).toEqual({ month: 3, year: 2007 });
    expect(parseContract('ES', 'ESZ00', REF)).toEqual({
      month: 12,
      year: 2000,
    });
    expect(parseContract('ES', 'ESZ26', '2031-01-01T00:00:00.000Z')).toEqual({
      month: 12,
      year: 2026,
    });
  });

  // Window [ref - 1, ref + 8]: the one year in it that ends in the digit.
  it.each<[string, string, Array<[number, number]>]>([
    [
      'ref 2026: 2025 (ref - 1) to 2034 (ref + 8)',
      '2026-06-15T12:00:00.000Z',
      [
        [0, 2030],
        [1, 2031],
        [2, 2032],
        [3, 2033],
        [4, 2034],
        [5, 2025],
        [6, 2026],
        [7, 2027],
        [8, 2028],
        [9, 2029],
      ],
    ],
    [
      'ref 2029: 2028 to 2037, across the decade',
      '2029-12-20T00:00:00.000Z',
      [
        [0, 2030],
        [1, 2031],
        [2, 2032],
        [3, 2033],
        [4, 2034],
        [5, 2035],
        [6, 2036],
        [7, 2037],
        [8, 2028],
        [9, 2029],
      ],
    ],
  ])('one-digit years resolve inside the window: %s', (_label, ref, table) => {
    for (const [digit, year] of table) {
      expect(parseContract('ES', `ESZ${digit}`, ref)).toEqual({
        month: 12,
        year,
      });
    }
  });

  it('takes the reference year in UTC, at the year boundary', () => {
    // 2025-12-31 23:59 UTC is still 2025 (window 2024-2033), even though it
    // is 2026 in zones east of UTC.
    expect(parseContract('ES', 'ESZ4', '2025-12-31T23:59:59.999Z')).toEqual({
      month: 12,
      year: 2024,
    });
    expect(parseContract('ES', 'ESZ4', '2026-01-01T00:00:00.000Z')).toEqual({
      month: 12,
      year: 2034,
    });
    expect(parseContract('ES', 'ESZ4', '2026-01-01T03:00:00+05:00')).toEqual({
      month: 12,
      year: 2024,
    });
  });

  it.each([
    ['a trailing newline', 'ESZ6\n'],
    ['a trailing CRLF', 'ESZ6\r\n'],
    ['a trailing space', 'ESZ6 '],
    ['a leading space', ' ESZ6'],
    ['a lowercase root', 'esz6'],
    ['a lowercase month code', 'ESz6'],
    ['a spread', 'ESZ6-ESH7'],
    ['another root', 'NQZ6'],
    ['the micro of the root', 'MESZ6'],
    ['a four-digit year', 'ESZ2026'],
    ['a three-digit year', 'ESZ026'],
    ['no year', 'ESZ'],
    ['no month code', 'ES6'],
    ['the bare root', 'ES'],
    ['the empty string', ''],
    ['a non-ASCII digit (Arabic-Indic six)', 'ESZ٦'],
    ['a fullwidth digit', 'ESZ６'],
  ])('rejects %s', (_label, sym) => {
    expect(parseContract('ES', sym, REF)).toBeNull();
  });

  it('rejects every letter that is not a CME month code', () => {
    for (const letter of 'ABCDEILOPRSTWY') {
      expect(parseContract('ES', `ES${letter}6`, REF)).toBeNull();
    }
  });

  it('rejects every other root, for every root', () => {
    for (const root of FUTURES_ROOTS) {
      for (const other of FUTURES_ROOTS) {
        if (other === root) continue;
        expect(parseContract(root, `${other}Z6`, REF)).toBeNull();
      }
    }
  });

  it('throws on an unparseable reference time, even for a symbol it would reject', () => {
    expect(() => parseContract('ES', 'ESZ6', 'not a time')).toThrow(
      /reference time/,
    );
    expect(() => parseContract('ES', 'nope', 'not a time')).toThrow(
      /reference time/,
    );
  });
});

describe('canonicalContract', () => {
  const REF = '2026-06-15T12:00:00.000Z';

  it.each([
    ['a one-digit year is already canonical', 'ESZ6', 'ESZ6'],
    ['a two-digit year folds to its last digit', 'ESZ26', 'ESZ6'],
    ['a next-year two-digit spelling', 'ESH27', 'ESH7'],
    ['a decade rollover spelling', 'ESH30', 'ESH0'],
    ['a leading-zero year', 'ESH07', 'ESH7'],
    ['a one-digit zero', 'ESH0', 'ESH0'],
  ])('%s', (_label, sym, expected) => {
    expect(canonicalContract('ES', sym, REF)).toBe(expected);
  });

  it('keeps the root, for every root', () => {
    for (const root of FUTURES_ROOTS) {
      expect(canonicalContract(root, `${root}Z26`, REF)).toBe(`${root}Z6`);
    }
  });

  it('is null exactly where parseContract is null', () => {
    for (const sym of [
      'ESZ6\n',
      'ESZ6-ESH7',
      'NQZ6',
      'esz6',
      'ESZ2026',
      'ES',
      '',
      'ESA6',
    ]) {
      expect(parseContract('ES', sym, REF)).toBeNull();
      expect(canonicalContract('ES', sym, REF)).toBeNull();
    }
  });

  it('is the one-digit spelling of the parsed year, for every month code and two-digit year', () => {
    for (const code of MONTH_CODES) {
      for (let yy = 0; yy < 100; yy++) {
        const sym = `ES${code}${String(yy).padStart(2, '0')}`;
        const parsed = parseContract('ES', sym, REF);
        expect(parsed).not.toBeNull();
        expect(canonicalContract('ES', sym, REF)).toBe(
          `ES${code}${(parsed?.year ?? 0) % 10}`,
        );
      }
    }
  });

  it('throws on an unparseable reference time, like parseContract', () => {
    expect(() => canonicalContract('ES', 'ESZ6', 'not a time')).toThrow(
      /reference time/,
    );
  });
});

describe('compareExpiry', () => {
  it.each<[string, [number, number], [number, number], number]>([
    ['a later year wins over a later month', [12, 2026], [1, 2027], -1],
    ['an earlier year wins over a later month', [1, 2027], [12, 2026], 1],
    ['the same year orders by month', [3, 2027], [9, 2027], -1],
    ['the same year, later month', [9, 2027], [3, 2027], 1],
    ['the same month and year is 0', [6, 2027], [6, 2027], 0],
    ['a decade apart', [12, 2029], [3, 2030], -1],
  ])('%s', (_label, [aMonth, aYear], [bMonth, bYear], sign) => {
    expect(
      Math.sign(
        compareExpiry(
          { month: aMonth, year: aYear },
          { month: bMonth, year: bYear },
        ),
      ),
    ).toBe(sign);
  });
});

describe('nullSeedContract', () => {
  it.each<[FuturesRoot, string, string]>([
    // ES: Mar/Jun/Sep/Dec, last trade in the contract month.
    ['ES', '2026-01-01T00:00:00.000Z', 'ESH6'],
    ['ES', '2026-03-01T00:00:00.000Z', 'ESH6'],
    ['ES', '2026-03-31T23:59:59.999Z', 'ESH6'],
    ['ES', '2026-04-01T00:00:00.000Z', 'ESM6'],
    ['ES', '2026-06-30T23:59:59.999Z', 'ESM6'],
    ['ES', '2026-07-01T00:00:00.000Z', 'ESU6'],
    ['ES', '2026-09-30T23:59:59.999Z', 'ESU6'],
    ['ES', '2026-10-01T00:00:00.000Z', 'ESZ6'],
    ['ES', '2026-11-07T00:00:00.000Z', 'ESZ6'],
    ['ES', '2026-12-01T00:00:00.000Z', 'ESZ6'],
    // Expired on 12-18, still the seed: the rule moves on late, never early.
    ['ES', '2026-12-20T00:00:00.000Z', 'ESZ6'],
    ['ES', '2026-12-31T23:59:59.999Z', 'ESZ6'],
    ['ES', '2027-01-01T00:00:00.000Z', 'ESH7'],
    ['ES', '2029-12-20T00:00:00.000Z', 'ESZ9'],
    ['ES', '2030-01-01T00:00:00.000Z', 'ESH0'],
    // NQ, RTY and ZN share the quarterly cycle.
    ['NQ', '2026-09-30T23:59:59.999Z', 'NQU6'],
    ['NQ', '2026-10-01T00:00:00.000Z', 'NQZ6'],
    ['NQ', '2026-11-07T00:00:00.000Z', 'NQZ6'],
    ['NQ', '2029-12-20T00:00:00.000Z', 'NQZ9'],
    ['RTY', '2026-06-30T23:59:59.999Z', 'RTYM6'],
    ['RTY', '2026-07-01T00:00:00.000Z', 'RTYU6'],
    ['RTY', '2026-12-31T23:59:59.999Z', 'RTYZ6'],
    ['RTY', '2027-01-01T00:00:00.000Z', 'RTYH7'],
    ['ZN', '2026-03-31T23:59:59.999Z', 'ZNH6'],
    ['ZN', '2026-04-01T00:00:00.000Z', 'ZNM6'],
    // CL: every month, and it stops trading in the month before.
    ['CL', '2026-01-01T00:00:00.000Z', 'CLG6'],
    ['CL', '2026-01-31T23:59:59.999Z', 'CLG6'],
    ['CL', '2026-02-01T00:00:00.000Z', 'CLH6'],
    ['CL', '2026-10-31T23:59:59.999Z', 'CLX6'],
    ['CL', '2026-11-01T00:00:00.000Z', 'CLZ6'],
    ['CL', '2026-11-07T00:00:00.000Z', 'CLZ6'],
    ['CL', '2026-11-30T23:59:59.999Z', 'CLZ6'],
    ['CL', '2026-12-01T00:00:00.000Z', 'CLF7'],
    ['CL', '2026-12-31T23:59:59.999Z', 'CLF7'],
    ['CL', '2027-01-01T00:00:00.000Z', 'CLG7'],
    ['CL', '2029-12-20T00:00:00.000Z', 'CLF0'],
    // GC: Feb/Apr/Jun/Aug/Oct/Dec.
    ['GC', '2026-01-01T00:00:00.000Z', 'GCG6'],
    ['GC', '2026-02-28T23:59:59.999Z', 'GCG6'],
    ['GC', '2026-03-01T00:00:00.000Z', 'GCJ6'],
    ['GC', '2026-10-31T23:59:59.999Z', 'GCV6'],
    ['GC', '2026-11-01T00:00:00.000Z', 'GCZ6'],
    ['GC', '2026-11-07T00:00:00.000Z', 'GCZ6'],
    ['GC', '2026-12-31T23:59:59.999Z', 'GCZ6'],
    ['GC', '2027-01-01T00:00:00.000Z', 'GCG7'],
    ['GC', '2029-12-20T00:00:00.000Z', 'GCZ9'],
    ['GC', '2030-01-01T00:00:00.000Z', 'GCG0'],
  ])('%s at %s seeds %s', (root, ref, expected) => {
    expect(nullSeedContract(root, ref)).toBe(expected);
  });

  it('always yields a symbol parseContract reads back, and never moves backward month to month', () => {
    for (const root of FUTURES_ROOTS) {
      let previous = { month: 0, year: 0 };
      for (let year = 2026; year <= 2031; year++) {
        for (let month = 1; month <= 12; month++) {
          const ref = new Date(Date.UTC(year, month - 1, 15)).toISOString();
          const parsed = parseContract(root, nullSeedContract(root, ref), ref);
          expect(parsed).not.toBeNull();
          if (parsed == null) continue;
          expect(compareExpiry(parsed, previous)).toBeGreaterThanOrEqual(0);
          previous = parsed;
        }
      }
    }
  });

  it('throws on an unparseable reference time', () => {
    expect(() => nullSeedContract('ES', 'not a time')).toThrow(
      /reference time/,
    );
  });
});

// ── replayRollForward ─────────────────────────────────────

interface RollCase {
  name: string;
  root: FuturesRoot;
  seed: string | null;
  segments: Array<{
    from: string;
    minutes: number;
    volumes: Record<string, number>;
  }>;
  takeovers: Array<{ ts: string; contract: string }>;
  front: string | null;
  skipped: string[];
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/futures-roll-cases.json', import.meta.url),
    'utf8',
  ),
) as { format: string; N: number; cases: RollCase[] };

/** The expansion the fixture's `format` string describes. */
function expandSegments(
  segments: RollCase['segments'],
): Map<string, ContractMinute[]> {
  const byContract = new Map<string, ContractMinute[]>();
  for (const { from, minutes, volumes } of segments) {
    const start = Date.parse(from);
    for (let i = 0; i < minutes; i++) {
      const ts = new Date(start + i * MINUTE_MS).toISOString();
      for (const [contract, volume] of Object.entries(volumes)) {
        const rows = byContract.get(contract) ?? [];
        rows.push({ ts, volume });
        byContract.set(contract, rows);
      }
    }
  }
  return byContract;
}

function runCase(name: string) {
  const c = fixture.cases.find((x) => x.name.startsWith(name));
  if (c == null) throw new Error(`no fixture case starts with ${name}`);
  return replayRollForward(expandSegments(c.segments), {
    root: c.root,
    seed: c.seed,
  });
}

describe('replayRollForward: the shared fixture', () => {
  it('was written for the guard length the module uses', () => {
    expect(fixture.N).toBe(ROLL_GUARD_CLOSES);
  });

  it('has one uniquely named case for each behavior it pins', () => {
    const names = fixture.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(15);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const result = replayRollForward(expandSegments(c.segments), {
      root: c.root,
      seed: c.seed,
    });
    expect(result.takeovers).toEqual(c.takeovers);
    expect(result.front).toBe(c.front);
    expect(result.skipped).toEqual(c.skipped);
  });
});

describe('replayRollForward: emitted rows', () => {
  it('emits the old front up to the takeover minute and the new front from it', () => {
    const { rows, takeovers } = runCase('roll-day crossover');
    expect(takeovers).toHaveLength(1);
    const at = (iso: string) => rows.find((e) => e.row.ts === iso)?.contract;
    expect(at('2026-12-08T13:59:00.000Z')).toBe('ESZ6');
    expect(at('2026-12-08T14:00:00.000Z')).toBe('ESH7');
    expect(rows).toHaveLength(960);
  });

  it('puts the first row after a quiet gap on the contract that matured inside it', () => {
    const { rows, takeovers } = runCase('maturity inside a quiet gap');
    expect(takeovers).toEqual([
      { ts: '2026-12-08T04:00:00.000Z', contract: 'ESH7' },
    ]);
    const firstAfterGap = rows.find(
      (e) => e.row.ts >= '2026-12-08T07:00:00.000Z',
    );
    expect(firstAfterGap?.contract).toBe('ESH7');
  });

  it('returns the input row objects themselves', () => {
    const z = { ts: '2026-12-08T10:00:00.000Z', volume: 5 };
    const { rows } = replayRollForward(new Map([['ESZ6', [z]]]), {
      root: 'ES',
      seed: 'ESZ6',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.row).toBe(z);
  });

  it('leaves out a minute where the front has no row, never filling it from another month', () => {
    const { rows } = replayRollForward(
      new Map([
        [
          'ESZ6',
          [
            { ts: '2026-12-08T10:00:00.000Z', volume: 5 },
            { ts: '2026-12-08T10:02:00.000Z', volume: 5 },
          ],
        ],
        ['ESH7', [{ ts: '2026-12-08T10:01:00.000Z', volume: 1 }]],
      ]),
      { root: 'ES', seed: 'ESZ6' },
    );
    expect(rows.map((e) => [e.row.ts, e.contract])).toEqual([
      ['2026-12-08T10:00:00.000Z', 'ESZ6'],
      ['2026-12-08T10:02:00.000Z', 'ESZ6'],
    ]);
  });
});

describe('replayRollForward: guards and edges', () => {
  it('has no takeover when the seed already leads all day, on two days', () => {
    const byContract = expandSegments([
      {
        from: '2026-12-10T00:00:00.000Z',
        minutes: 2880,
        volumes: { ESH7: 10, ESM7: 4, ESZ6: 2 },
      },
    ]);
    const result = replayRollForward(byContract, { root: 'ES', seed: 'ESH7' });
    expect(result.takeovers).toEqual([]);
    expect(result.front).toBe('ESH7');
    expect(result.rows).toHaveLength(2880);
  });

  it('never moves backward: an earlier expiry with the biggest tally on every day never takes over', () => {
    const byContract = expandSegments([
      {
        from: '2026-09-14T00:00:00.000Z',
        minutes: 2880,
        volumes: { ESU6: 100, ESZ6: 1 },
      },
    ]);
    const result = replayRollForward(byContract, { root: 'ES', seed: 'ESZ6' });
    expect(result.takeovers).toEqual([]);
    expect(result.front).toBe('ESZ6');
  });

  it('applies the seed it was given even when the seed has no rows', () => {
    const result = replayRollForward(
      expandSegments([
        {
          from: '2026-12-10T00:00:00.000Z',
          minutes: 10,
          volumes: { ESH7: 1 },
        },
      ]),
      { root: 'ES', seed: 'ESM7' },
    );
    expect(result.front).toBe('ESM7');
    expect(result.rows).toEqual([]);
    expect(result.takeovers).toEqual([]);
  });

  it.each([
    ['another root', 'NQZ6'],
    ['a trailing newline', 'ESZ6\n'],
    ['a four-digit year', 'ESZ2026'],
    ['a lowercase symbol', 'esz6'],
    ['a spread', 'ESZ6-ESH7'],
    ['the empty string', ''],
  ])('throws, naming it, when the seed is %s', (_label, seed) => {
    const rows = expandSegments([
      { from: '2026-12-10T00:00:00.000Z', minutes: 5, volumes: { ESZ6: 1 } },
    ]);
    const message = `seed ${JSON.stringify(seed)} is not an outright ES contract`;
    expect(() => replayRollForward(rows, { root: 'ES', seed })).toThrow(
      message,
    );
    // Also with nothing to replay: the seed is checked first.
    expect(() => replayRollForward(new Map(), { root: 'ES', seed })).toThrow(
      message,
    );
  });

  it('returns the seed, or null when there is none, and nothing else for no rows', () => {
    expect(replayRollForward(new Map(), { root: 'ES', seed: 'ESH7' })).toEqual({
      rows: [],
      takeovers: [],
      front: 'ESH7',
      skipped: [],
    });
    expect(replayRollForward(new Map(), { root: 'ES', seed: null })).toEqual({
      rows: [],
      takeovers: [],
      front: null,
      skipped: [],
    });
    // The seed is returned under its canonical name.
    expect(replayRollForward(new Map(), { root: 'ES', seed: 'ESZ26' })).toEqual(
      { rows: [], takeovers: [], front: 'ESZ6', skipped: [] },
    );
    expect(
      replayRollForward(new Map([['ESZ6', []]]), { root: 'ES', seed: null })
        .front,
    ).toBeNull();
  });

  it('lists skipped keys even when nothing else is replayed, sorted', () => {
    const result = replayRollForward(
      new Map([
        ['NQZ6', [{ ts: '2026-12-10T00:00:00.000Z', volume: 1 }]],
        ['ESZ6-ESH7', []],
      ]),
      { root: 'ES', seed: 'ESZ6' },
    );
    expect(result.skipped).toEqual(['ESZ6-ESH7', 'NQZ6']);
    expect(result.rows).toEqual([]);
    expect(result.front).toBe('ESZ6');
  });

  it('emits a front fed under its two-digit name as its canonical contract, with the caller row', () => {
    const z26 = { ts: '2026-12-10T00:00:00.000Z', volume: 5 };
    const { rows, front } = replayRollForward(new Map([['ESZ26', [z26]]]), {
      root: 'ES',
      seed: 'ESZ6',
    });
    expect(front).toBe('ESZ6');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contract).toBe('ESZ6');
    expect(rows[0]?.row).toBe(z26);
  });

  it.each([
    ['inserted one-digit first', ['ESZ6', 'ESZ26']],
    ['inserted two-digit first', ['ESZ26', 'ESZ6']],
  ])(
    'when two spellings print the same minute, emits the larger volume (%s), and a tie goes to the codepoint-smaller key',
    (_label, order) => {
      const ts = '2026-12-10T00:00:00.000Z';
      const emitted = (small: number, large: number) => {
        const rows = new Map(
          order.map((key) => [
            key,
            [{ key, ts, volume: key === 'ESZ6' ? small : large }],
          ]),
        );
        return replayRollForward(rows, { root: 'ES', seed: 'ESZ6' }).rows.map(
          (e) => e.row.key,
        );
      };
      // ESZ6 carries 2, ESZ26 carries 9: the two-digit spelling wins.
      expect(emitted(2, 9)).toEqual(['ESZ26']);
      // And the other way round.
      expect(emitted(9, 2)).toEqual(['ESZ6']);
      // Equal volumes: 'ESZ26' < 'ESZ6' by code point.
      expect(emitted(4, 4)).toEqual(['ESZ26']);
    },
  );

  it('throws, naming the contract, on a row whose ts does not parse', () => {
    expect(() =>
      replayRollForward(new Map([['ESZ6', [{ ts: 'noon', volume: 1 }]]]), {
        root: 'ES',
        seed: 'ESZ6',
      }),
    ).toThrow(/ESZ6 row has an unparseable ts "noon"/);
  });
});

/** Linear congruential generator: arithmetic only, exact below 2^53. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

/**
 * 50 hours of three contracts whose rates and presence change by regime.
 * Each print is spelled with a one-digit year, a two-digit year, or both in
 * the same minute (two keys for one contract, each with its own volume).
 */
function randomRolls(seed: number): Map<string, ContractMinute[]> {
  const rand = lcg(seed);
  const contracts = ['ESZ6', 'ESH7', 'ESM7'];
  const twoDigit = (name: string) => `${name.slice(0, 3)}2${name.slice(3)}`;
  const keys = [...contracts, ...contracts.map(twoDigit)];
  const rates = [0, 1, 3, 10];
  const presences = [0.02, 0.3, 1];
  const start = Date.parse('2026-12-08T10:00:00.000Z');
  const byContract = new Map<string, ContractMinute[]>(
    keys.map((k) => [k, []]),
  );
  let regimeEnd = 0;
  let rate: number[] = [];
  let presence: number[] = [];
  for (let i = 0; i < 3000; i++) {
    if (i >= regimeEnd) {
      regimeEnd = i + 150 + Math.floor(rand() * 600);
      rate = contracts.map(() => rates[Math.floor(rand() * rates.length)] ?? 0);
      presence = contracts.map(
        () => presences[Math.floor(rand() * presences.length)] ?? 0,
      );
    }
    const ts = new Date(start + i * MINUTE_MS).toISOString();
    contracts.forEach((name, j) => {
      if (rand() >= (presence[j] ?? 0)) return;
      const spelling = rand();
      const spelled =
        spelling < 0.25
          ? [twoDigit(name)]
          : spelling < 0.4
            ? [name, twoDigit(name)]
            : [name];
      for (const key of spelled) {
        const volume = Math.floor(rand() * 2 * (rate[j] ?? 0));
        byContract.get(key)?.push({ ts, volume });
      }
    });
  }
  return byContract;
}

/**
 * The rule read one wall-clock minute at a time: count consecutive leading
 * closes (quiet minutes included), switch the front for the minute after the
 * Nth, clear the tally and the count at 00:00 UTC. No gap arithmetic, so it
 * is an independent check of the module's row-to-row jumps. Two-digit
 * spellings fold to the one-digit name here by slicing (ES keys only).
 */
function referenceRoll(
  root: FuturesRoot,
  seed: string,
  byContract: ReadonlyMap<string, readonly ContractMinute[]>,
) {
  const rowsAt = new Map<number, Map<string, ContractMinute>>();
  for (const [contract, rows] of byContract) {
    for (const row of rows) {
      const at = rowsAt.get(Date.parse(row.ts)) ?? new Map();
      at.set(contract, row);
      rowsAt.set(Date.parse(row.ts), at);
    }
  }
  const canon = (key: string) => key.slice(0, 3) + key.slice(-1);
  const times = [...rowsAt.keys()];
  const first = Math.min(...times);
  const last = Math.max(...times);
  const refIso = new Date(first).toISOString();
  const expiry = (sym: string) => {
    const parsed = parseContract(root, sym, refIso);
    if (parsed == null) throw new Error(`bad key ${sym}`);
    return parsed;
  };
  const later = [...new Set([...byContract.keys()].map(canon))].sort(
    (a, b) => compareExpiry(expiry(a), expiry(b)) || (a < b ? -1 : 1),
  );

  let front = canon(seed);
  let streak: string | null = null;
  let closes = 0;
  const tally = new Map<string, number>();
  const rows: Array<{ contract: string; ts: string; volume: number }> = [];
  const takeovers: Array<{ ts: string; contract: string }> = [];
  for (let ms = first; ms <= last; ms += MINUTE_MS) {
    if (ms % DAY_MS === 0) {
      tally.clear();
      streak = null;
      closes = 0;
    }
    const at = rowsAt.get(ms);
    if (at != null) {
      // The front's spellings at this minute: the larger volume is emitted,
      // a tie goes to the smaller key.
      const frontRow = [...at]
        .filter(([key]) => canon(key) === front)
        .sort(
          ([ka, a], [kb, b]) =>
            b.volume - a.volume || (ka < kb ? -1 : ka > kb ? 1 : 0),
        )[0]?.[1];
      if (frontRow != null) {
        rows.push({
          contract: front,
          ts: frontRow.ts,
          volume: frontRow.volume,
        });
      }
      for (const [key, row] of at) {
        tally.set(canon(key), (tally.get(canon(key)) ?? 0) + row.volume);
      }
    }
    let challenger: string | null = null;
    for (const c of later) {
      if (compareExpiry(expiry(c), expiry(front)) <= 0) continue;
      if (
        challenger == null ||
        (tally.get(c) ?? 0) > (tally.get(challenger) ?? 0)
      ) {
        challenger = c;
      }
    }
    if (
      challenger != null &&
      (tally.get(challenger) ?? 0) > (tally.get(front) ?? 0)
    ) {
      closes = challenger === streak ? closes + 1 : 1;
      streak = challenger;
    } else {
      streak = null;
      closes = 0;
    }
    if (streak != null && closes === ROLL_GUARD_CLOSES) {
      takeovers.push({
        ts: new Date(ms + MINUTE_MS).toISOString(),
        contract: streak,
      });
      front = streak;
      streak = null;
      closes = 0;
    }
  }
  return { rows, takeovers, front };
}

describe('replayRollForward: against a minute-by-minute reading', () => {
  it('agrees on rows, takeovers and front for 300 random three-contract sessions, with two spellings per contract', () => {
    let withTakeover = 0;
    let takeoverCount = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const byContract = randomRolls(seed);
      const actual = replayRollForward(byContract, {
        root: 'ES',
        seed: 'ESZ6',
      });
      const expected = referenceRoll('ES', 'ESZ6', byContract);
      expect(actual.takeovers, `seed ${seed}`).toEqual(expected.takeovers);
      expect(actual.front, `seed ${seed}`).toBe(expected.front);
      expect(
        actual.rows.map((e) => ({
          contract: e.contract,
          ts: e.row.ts,
          volume: e.row.volume,
        })),
        `seed ${seed}`,
      ).toEqual(expected.rows);
      if (actual.takeovers.length > 0) withTakeover++;
      takeoverCount += actual.takeovers.length;
    }
    // A comparison that never sees a roll proves nothing. (The generator is
    // deterministic: 298 sessions roll, 418 takeovers in all.)
    expect(withTakeover).toBeGreaterThanOrEqual(200);
    expect(takeoverCount).toBeGreaterThanOrEqual(300);
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
