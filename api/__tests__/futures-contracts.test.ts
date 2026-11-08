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
  canonicalContract,
  cmeTradeDate,
  compareExpiry,
  decideFrontMonth,
  fetchFuturesContracts,
  frontMonthCandidates,
  nullSeedContract,
  parseContract,
  pickScheduledFront,
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

describe('listing cycle constants', () => {
  it('pins the month codes and each root’s listing cycle', () => {
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
    ['a one-digit zero', 'ESH0', 'ESH0'],
    // Window at ref 2026: 2025 (ref - 1) to 2034 (ref + 8).
    ['the lower edge, ref - 1', 'ESZ25', 'ESZ5'],
    ['the upper edge, ref + 8', 'ESZ34', 'ESZ4'],
  ])('%s', (_label, sym, expected) => {
    expect(canonicalContract('ES', sym, REF)).toBe(expected);
  });

  it.each([
    ['one year below the window, ref - 2', 'ESZ24'],
    ['one year above the window, ref + 9', 'ESZ35'],
    ['a decade out, the CL case (2036)', 'ESZ36'],
    ['a leading-zero year long past', 'ESH07'],
    ['the year 2000', 'ESZ00'],
  ])('is null for a two-digit year outside the window: %s', (_label, sym) => {
    // parseContract still reads it, as its own year.
    expect(parseContract('ES', sym, REF)).not.toBeNull();
    expect(canonicalContract('ES', sym, REF)).toBeNull();
  });

  it('judges the window against the reference year it is given', () => {
    // 2036 is ref + 8 at ref 2028.
    expect(canonicalContract('CL', 'CLZ36', '2028-01-01T00:00:00.000Z')).toBe(
      'CLZ6',
    );
    expect(
      canonicalContract('CL', 'CLZ36', '2027-12-31T23:59:59.999Z'),
    ).toBeNull();
    // 2025 is ref - 1 at ref 2026, but ref - 2 at ref 2027.
    expect(canonicalContract('CL', 'CLZ25', '2026-01-01T00:00:00.000Z')).toBe(
      'CLZ5',
    );
    expect(
      canonicalContract('CL', 'CLZ25', '2027-01-01T00:00:00.000Z'),
    ).toBeNull();
  });

  it('keeps the root, for every root', () => {
    for (const root of FUTURES_ROOTS) {
      expect(canonicalContract(root, `${root}Z26`, REF)).toBe(`${root}Z6`);
    }
  });

  it('is null where parseContract is null', () => {
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

  it('is the one-digit spelling inside the window and null outside it, for every month code and two-digit year', () => {
    for (const code of MONTH_CODES) {
      for (let yy = 0; yy < 100; yy++) {
        const sym = `ES${code}${String(yy).padStart(2, '0')}`;
        const parsed = parseContract('ES', sym, REF);
        expect(parsed?.year).toBe(2000 + yy);
        // Window at ref 2026: 2025 to 2034.
        const inWindow = 2000 + yy >= 2025 && 2000 + yy <= 2034;
        expect(canonicalContract('ES', sym, REF)).toBe(
          inWindow ? `ES${code}${yy % 10}` : null,
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

// ── The per-session rule ──────────────────────────────────

interface TradeDateCase {
  name: string;
  ts: string;
  tradeDate: string;
}

interface DecideCase {
  name: string;
  root: FuturesRoot;
  tradeDate: string;
  incumbent: string | null;
  volumes: Record<string, number>;
  /** The decision; absent in a `throws` case. */
  front?: string;
  /** A pattern for the message of the error the call must raise. */
  throws?: string;
}

interface PickCase {
  name: string;
  schedule: Record<string, string>;
  rows: Array<{ key: string; ts: string; volume: number }>;
  /** The bars; absent in a `throws` case. */
  picked?: Array<{ ts: string; contract: string; key: string; volume: number }>;
  /** A pattern for the message of the error the call must raise. */
  throws?: string;
}

/** A fixture row tagged with the key it came from, as the format text says. */
interface KeyedMinute extends ContractMinute {
  key: string;
}

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/futures-roll-cases.json', import.meta.url),
    'utf8',
  ),
) as {
  format: string;
  cmeTradeDate: TradeDateCase[];
  decideFrontMonth: DecideCase[];
  pickScheduledFront: PickCase[];
};

/** One list of rows per key, keys in order of first appearance. */
function byKey(rows: PickCase['rows']): Map<string, KeyedMinute[]> {
  const out = new Map<string, KeyedMinute[]>();
  for (const { key, ts, volume } of rows) {
    const list = out.get(key) ?? [];
    list.push({ ts, volume, key });
    out.set(key, list);
  }
  return out;
}

function pick(c: Pick<PickCase, 'schedule' | 'rows'>) {
  return pickScheduledFront(
    byKey(c.rows),
    (tradeDate) => c.schedule[tradeDate],
  );
}

describe('the shared fixture', () => {
  it('has uniquely named cases in each list', () => {
    for (const list of [
      fixture.cmeTradeDate,
      fixture.decideFrontMonth,
      fixture.pickScheduledFront,
    ]) {
      const names = list.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('covers both sides of every session open it pins', () => {
    expect(fixture.cmeTradeDate.length).toBeGreaterThanOrEqual(25);
    expect(fixture.decideFrontMonth.length).toBeGreaterThanOrEqual(35);
    expect(fixture.pickScheduledFront.length).toBeGreaterThanOrEqual(10);
  });

  it('gives each decide and pick case an answer or a `throws`, never both and never neither', () => {
    for (const c of fixture.decideFrontMonth) {
      expect([c.name, (c.front != null) !== (c.throws != null)]).toEqual([
        c.name,
        true,
      ]);
    }
    for (const c of fixture.pickScheduledFront) {
      expect([c.name, (c.picked != null) !== (c.throws != null)]).toEqual([
        c.name,
        true,
      ]);
    }
  });

  it('has `throws` cases for both functions, and each pattern compiles', () => {
    const throwing = [
      ...fixture.decideFrontMonth,
      ...fixture.pickScheduledFront,
    ].filter((c) => c.throws != null);
    expect(fixture.decideFrontMonth.some((c) => c.throws != null)).toBe(true);
    expect(fixture.pickScheduledFront.some((c) => c.throws != null)).toBe(true);
    for (const c of throwing) expect(() => new RegExp(c.throws!)).not.toThrow();
  });
});

describe('cmeTradeDate', () => {
  it.each(fixture.cmeTradeDate.map((c) => [c.name, c] as const))(
    '%s',
    (_name, c) => {
      expect(cmeTradeDate(c.ts)).toBe(c.tradeDate);
    },
  );

  /**
   * The rule read another way: the Chicago wall date, one day later from
   * 17:00 on. The two readings can only differ if a clock change falls in
   * the seven hours before a Chicago midnight, and the changes are at 02:00.
   */
  function wallClockReading(ms: number): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    }).formatToParts(ms);
    const part = (type: string) =>
      Number.parseInt(parts.find((p) => p.type === type)?.value ?? '', 10);
    const day = Date.UTC(
      part('year'),
      part('month') - 1,
      part('day') + (part('hour') >= 17 ? 1 : 0),
    );
    return new Date(day).toISOString().slice(0, 10);
  }

  it.each([
    ['2026-10-28T00:00:00.000Z', '2026-11-05T00:00:00.000Z'],
    ['2027-03-11T00:00:00.000Z', '2027-03-18T00:00:00.000Z'],
  ])(
    'agrees with the wall-clock reading every 15 minutes from %s to %s, across the clock change',
    (from, to) => {
      const bad: string[] = [];
      for (let ms = Date.parse(from); ms < Date.parse(to); ms += 900_000) {
        const ts = new Date(ms).toISOString();
        if (cmeTradeDate(ts) !== wallClockReading(ms)) bad.push(ts);
      }
      expect(bad).toEqual([]);
    },
  );

  it('throws, naming the input, on a timestamp that does not parse', () => {
    expect(() => cmeTradeDate('not a time')).toThrow(/not a time/);
    expect(() => cmeTradeDate('')).toThrow(/timestamp/);
  });
});

describe('decideFrontMonth', () => {
  it.each(fixture.decideFrontMonth.map((c) => [c.name, c] as const))(
    '%s',
    (_name, c) => {
      const decide = () =>
        decideFrontMonth(
          c.incumbent,
          new Map(Object.entries(c.volumes)),
          c.root,
          c.tradeDate,
        );
      if (c.throws != null) expect(decide).toThrow(new RegExp(c.throws));
      else expect(decide()).toBe(c.front);
    },
  );

  it.each([
    ['ESH7', 'ESM7', 'ESZ6'],
    ['ESZ6', 'ESM7', 'ESH7'],
    ['ESM7', 'ESZ6', 'ESH7'],
  ])(
    'a tie does not depend on the order the volumes are listed in (%s, %s, %s)',
    (...order) => {
      const volumes = new Map(order.map((key) => [key, 5]));
      expect(decideFrontMonth(null, volumes, 'ES', '2026-12-08')).toBe('ESZ6');
      expect(decideFrontMonth('ESZ6', volumes, 'ES', '2026-12-08')).toBe(
        'ESZ6',
      );
      // Two later months tie and both beat the incumbent's 1.
      volumes.set('ESZ6', 1);
      expect(decideFrontMonth('ESZ6', volumes, 'ES', '2026-12-08')).toBe(
        'ESH7',
      );
    },
  );

  it('does not change the map it is given', () => {
    const volumes = new Map([
      ['ESZ26', 3],
      ['ESZ6', 4],
      ['ESZ6-ESH7', 9],
    ]);
    decideFrontMonth('ESZ6', volumes, 'ES', '2026-12-08');
    expect([...volumes]).toEqual([
      ['ESZ26', 3],
      ['ESZ6', 4],
      ['ESZ6-ESH7', 9],
    ]);
  });

  it('throws on a trade date that does not parse', () => {
    expect(() =>
      decideFrontMonth('ESZ6', new Map(), 'ES', 'not a date'),
    ).toThrow(/reference time/);
  });
});

describe('pickScheduledFront', () => {
  it.each(fixture.pickScheduledFront.map((c) => [c.name, c] as const))(
    '%s',
    (_name, c) => {
      if (c.throws != null) {
        expect(() => pick(c)).toThrow(new RegExp(c.throws));
        return;
      }
      expect(
        pick(c).map((e) => ({
          ts: e.row.ts,
          contract: e.contract,
          key: e.row.key,
          volume: e.row.volume,
        })),
      ).toEqual(c.picked);
    },
  );

  it('returns the caller’s row objects themselves', () => {
    const rows = byKey([
      { key: 'ESZ6', ts: '2026-11-05T15:00:00.000Z', volume: 1 },
    ]);
    const [only] = pickScheduledFront(rows, () => 'ESZ6');
    expect(only?.row).toBe(rows.get('ESZ6')?.[0]);
  });

  it.each(FUTURES_ROOTS)(
    'finds the root of the scheduled contract itself, so a bare contract list works for %s',
    (root) => {
      const c = {
        schedule: { '2026-12-08': `${root}Z6` },
        rows: [
          { key: `${root}Z26`, ts: '2026-12-08T10:00:00.000Z', volume: 5 },
          { key: `${root}Z6`, ts: '2026-12-08T10:00:00.000Z', volume: 2 },
          { key: `${root}H7`, ts: '2026-12-08T10:00:00.000Z', volume: 9 },
        ],
      };
      expect(pick(c).map((e) => [e.contract, e.row.key])).toEqual([
        [`${root}Z6`, `${root}Z26`],
      ]);
    },
  );

  it('throws on a row whose ts does not parse', () => {
    expect(() =>
      pick({
        schedule: {},
        rows: [{ key: 'ESZ6', ts: 'noon', volume: 2 }],
      }),
    ).toThrow(/noon/);
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
