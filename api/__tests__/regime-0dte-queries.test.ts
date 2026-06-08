import { describe, it, expect, vi, beforeEach } from 'vitest';

// A RECORDING `sql` mock (not the repo's plain `vi.fn()` result-mock used in
// lessons.test.ts / backup-tables.test.ts). Those tests assert on returned ROWS
// or on call arguments; this test asserts on the EMITTED SQL TEXT — specifically
// that every anchor-selecting min/max(timestamp) query still carries the sargable
// CT-day bound. The plain `vi.fn()` idiom can't reconstruct the assembled SQL
// (and silently swallows nested `sql\`\`` fragments like `gexCtDayFilter`), so we
// keep a recording tag: it expands nested fragments (sql.unsafe + inner sql``)
// into their text and renders value interpolations as `$p` placeholders.
const captured: string[] = [];
const GEX_ROWS = [
  { strike: 7400, call_gamma_oi: 1, put_gamma_oi: -3, price: 7400 },
  { strike: 7410, call_gamma_oi: 2, put_gamma_oi: -1, price: 7400 },
];

// The rows the recording `sql` mock resolves to. Defaults to the GEX fixture so
// the existing getGexStrikes suite is unchanged; getPutIvSeries / getCandles30
// tests swap this for their own fixtures (or [] for the empty-rows path).
let nextRows: unknown[] = GEX_ROWS;

function expand(v: unknown): string {
  if (v && typeof v === 'object' && '__text' in v)
    return (v as { __text: string }).__text;
  return '$p';
}
function makeSql() {
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? '';
    for (let i = 0; i < values.length; i++)
      text += expand(values[i]) + (strings[i + 1] ?? '');
    captured.push(text);
    return { __text: text, then: (res: (r: unknown) => void) => res(nextRows) };
  };
  sql.unsafe = (s: string) => ({ __text: s });
  return sql;
}

vi.mock('../_lib/db.js', () => ({ getDb: () => makeSql() }));
vi.mock('../_lib/api-helpers.js', () => ({
  withRetry: (fn: () => unknown) => fn(),
}));

import {
  getGexStrikes,
  getPutIvSeries,
  getCandles30,
} from '../_lib/regime-0dte-queries';

// The sargable CT-day bound that must wrap every anchor selection. We check the
// SHAPE of the range, not the old `date(timestamp AT TIME ZONE …)` guard text:
//   tscol >= ((X::date)::timestamp AT TIME ZONE 'America/Chicago')   ← lower
//   tscol <  (((X::date) + 1)::timestamp AT TIME ZONE 'America/Chicago') ← upper
const CT_TZ = "AT TIME ZONE 'America/Chicago'";
// Lower bound: a `>= ( … AT TIME ZONE 'America/Chicago')` term.
const LOWER = />=\s*\(\(.*AT TIME ZONE 'America\/Chicago'/s;
// Upper bound: the `< ((( … + 1) … AT TIME ZONE 'America/Chicago')` term.
const UPPER = /<\s*\(\(\(.*\+\s*1\).*AT TIME ZONE 'America\/Chicago'/s;

// A captured query "selects an anchor timestamp" iff it computes min/max(timestamp).
const selectsAnchor = (t: string) => /(min|max)\(\s*timestamp\s*\)/i.test(t);

function expectEveryAnchorQueryIsGuarded(queries: string[]) {
  const anchorQueries = queries.filter(selectsAnchor);
  // Non-vacuous: at least one min/max(timestamp) selection must have been emitted,
  // else `.every` would pass trivially on an empty set.
  expect(anchorQueries.length).toBeGreaterThan(0);
  // Per-anchor guard: EVERY min/max(timestamp) selection must carry BOTH CT-day
  // bounds. `.every` (not `.some`) — dropping the bound from a SINGLE anchor's
  // selection must fail this test.
  for (const q of anchorQueries) {
    expect(q).toContain(CT_TZ);
    expect(q).toMatch(LOWER);
    expect(q).toMatch(UPPER);
  }
  expect(anchorQueries.every((q) => LOWER.test(q) && UPPER.test(q))).toBe(true);
}

describe('getGexStrikes — CT-day bound (stray mis-dated row exclusion)', () => {
  beforeEach(() => {
    captured.length = 0;
    nextRows = GEX_ROWS;
  });

  for (const anchor of ['open', 'midday', 'latest'] as const) {
    it(`${anchor} anchor bounds EVERY min/max(timestamp) selection to the CT day`, async () => {
      await getGexStrikes('2026-06-05', anchor);
      // Every anchor's selection must carry the sargable CT-day range, else
      // min/max(timestamp) could pick a prior-evening row mis-stamped into this
      // day's `date`. Asserts over ALL anchor-selecting queries, so the bound
      // can't be dropped from any single arm (min, max, or midday fallback).
      expectEveryAnchorQueryIsGuarded(captured);
    });
  }

  it('netGex = call_gamma_oi + put_gamma_oi (put is signed-negative)', async () => {
    const { strikes, spot } = await getGexStrikes('2026-06-05', 'open');
    expect(strikes[0]).toEqual({ strike: 7400, netGex: 1 + -3 }); // -2, not call-put
    expect(strikes[1]).toEqual({ strike: 7410, netGex: 2 + -1 }); // 1
    expect(spot).toBe(7400);
  });
});

describe('getPutIvSeries — minute mapping + broken-IV filter', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it('maps rows to { ctMin, iv } with Number coercion', async () => {
    // Neon returns NUMERIC as strings — assert they are coerced to numbers.
    nextRows = [
      { ct_min: '510', iv_mid: '0.18' },
      { ct_min: 540, iv_mid: 0.22 },
    ];
    const out = await getPutIvSeries('2026-06-05');
    expect(out).toEqual([
      { ctMin: 510, iv: 0.18 },
      { ctMin: 540, iv: 0.22 },
    ]);
  });

  it('filters out IV at and below the lower bound (iv <= 0)', async () => {
    // iv > 0 is exclusive: 0 and negatives are dropped; a hair above 0 is kept.
    nextRows = [
      { ct_min: 510, iv_mid: 0 }, // dropped (boundary: not > 0)
      { ct_min: 520, iv_mid: -0.5 }, // dropped (negative)
      { ct_min: 530, iv_mid: 0.0001 }, // kept (just above 0)
    ];
    const out = await getPutIvSeries('2026-06-05');
    expect(out).toEqual([{ ctMin: 530, iv: 0.0001 }]);
  });

  it('filters out IV at and above the upper bound (iv >= 3)', async () => {
    // iv < 3 is exclusive: exactly 3 and above are dropped; just under 3 kept.
    nextRows = [
      { ct_min: 510, iv_mid: 3 }, // dropped (boundary: not < 3)
      { ct_min: 520, iv_mid: 4.5 }, // dropped (above)
      { ct_min: 530, iv_mid: 2.9999 }, // kept (just below 3)
    ];
    const out = await getPutIvSeries('2026-06-05');
    expect(out).toEqual([{ ctMin: 530, iv: 2.9999 }]);
  });

  it('coalesces null iv_mid to 0, which the filter then drops', async () => {
    // Number(r.iv_mid ?? 0) → 0, and 0 is not > 0, so the point is excluded.
    nextRows = [{ ct_min: 510, iv_mid: null }];
    const out = await getPutIvSeries('2026-06-05');
    expect(out).toEqual([]);
  });

  it('returns [] for empty rows', async () => {
    nextRows = [];
    const out = await getPutIvSeries('2026-06-05');
    expect(out).toEqual([]);
  });
});

describe('getCandles30 — bucket mapping + null coalescing', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it('maps { ct_min, bopen, bclose } -> { ctMin, open, close } with coercion', async () => {
    nextRows = [
      { ct_min: '510', bopen: '7400.5', bclose: '7405.25' },
      { ct_min: 540, bopen: 7405.25, bclose: 7398 },
    ];
    const out = await getCandles30('2026-06-05');
    expect(out).toEqual([
      { ctMin: 510, open: 7400.5, close: 7405.25 },
      { ctMin: 540, open: 7405.25, close: 7398 },
    ]);
  });

  it('coalesces null bopen / bclose to 0', async () => {
    nextRows = [
      { ct_min: 510, bopen: null, bclose: 7405 },
      { ct_min: 540, bopen: 7405, bclose: null },
      { ct_min: 570, bopen: null, bclose: null },
    ];
    const out = await getCandles30('2026-06-05');
    expect(out).toEqual([
      { ctMin: 510, open: 0, close: 7405 },
      { ctMin: 540, open: 7405, close: 0 },
      { ctMin: 570, open: 0, close: 0 },
    ]);
  });

  it('returns [] for empty rows', async () => {
    nextRows = [];
    const out = await getCandles30('2026-06-05');
    expect(out).toEqual([]);
  });
});
