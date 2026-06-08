import { describe, it, expect, vi, beforeEach } from 'vitest';

// Record every assembled SQL template so we can assert the CT-date guard is
// present. The recording `sql` tag expands nested fragments (sql.unsafe + inner
// sql``) into their text and renders value interpolations as `$p` placeholders.
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

const GUARD = "date(timestamp AT TIME ZONE 'America/Chicago')";

describe('getGexStrikes — CT-date guard (stray mis-dated row exclusion)', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  for (const anchor of ['open', 'midday', 'latest'] as const) {
    it(`${anchor} anchor restricts to rows whose actual CT date == the day`, async () => {
      await getGexStrikes('2026-06-05', anchor);
      // Every anchor's selection must carry the guard, else min/max(timestamp)
      // could pick a prior-evening row mis-stamped into this day's `date`.
      expect(captured.some((t) => t.includes(GUARD))).toBe(true);
    });
  }

  it('netGex = call_gamma_oi + put_gamma_oi (put is signed-negative)', async () => {
    const { strikes, spot } = await getGexStrikes('2026-06-05', 'open');
    expect(strikes[0]).toEqual({ strike: 7400, netGex: 1 + -3 }); // -2, not call-put
    expect(strikes[1]).toEqual({ strike: 7410, netGex: 2 + -1 }); // 1
    expect(spot).toBe(7400);
  });
});
