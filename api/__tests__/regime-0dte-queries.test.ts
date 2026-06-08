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
const ROWS = [
  { strike: 7400, call_gamma_oi: 1, put_gamma_oi: -3, price: 7400 },
  { strike: 7410, call_gamma_oi: 2, put_gamma_oi: -1, price: 7400 },
];

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
    return { __text: text, then: (res: (r: unknown) => void) => res(ROWS) };
  };
  sql.unsafe = (s: string) => ({ __text: s });
  return sql;
}

vi.mock('../_lib/db.js', () => ({ getDb: () => makeSql() }));
vi.mock('../_lib/api-helpers.js', () => ({
  withRetry: (fn: () => unknown) => fn(),
}));

import { getGexStrikes } from '../_lib/regime-0dte-queries';

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
