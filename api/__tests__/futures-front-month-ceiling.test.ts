// @vitest-environment node

/**
 * `ceilingContract` (api/_lib/futures-front-month.ts): the rule that a
 * date's decision is never later than the earliest decision stored after
 * it. `ensureFrontMonth` and the history seed
 * (scripts/_lib/futures-front-month-backfill.ts) both apply it through this
 * one function; the store's own clamp, warning included, is covered through
 * `ensureFrontMonth` in futures-front-month-pglite.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { ceilingContract } from '../_lib/futures-front-month.js';

describe('ceilingContract', () => {
  it.each([
    // No later decision: nothing to cap at.
    ['ES', '2026-07-24', 'ESZ6', null, 'ESZ6', false],
    // Earlier than the ceiling, or the same contract: left alone.
    ['ES', '2026-07-24', 'ESU6', 'ESZ6', 'ESU6', false],
    ['ES', '2026-07-24', 'ESZ6', 'ESZ6', 'ESZ6', false],
    // Later than the ceiling: lowered to it.
    ['ES', '2026-07-24', 'ESH7', 'ESZ6', 'ESZ6', true],
    ['CL', '2026-09-10', 'CLZ6', 'CLV6', 'CLV6', true],
    // A two-digit ceiling is returned in the one canonical name, and
    // compared as its year: ESZ26 is ESZ6.
    ['ES', '2026-07-24', 'ESH7', 'ESZ26', 'ESZ6', true],
    ['ES', '2026-07-24', 'ESU6', 'ESZ26', 'ESU6', false],
    // One-digit years wrap each decade: ESH0 (2030) is later than ESZ9.
    ['ES', '2029-12-18', 'ESH0', 'ESZ9', 'ESZ9', true],
    ['ES', '2029-12-18', 'ESZ9', 'ESH0', 'ESZ9', false],
  ] as const)(
    '%s %s: wanted %s under ceiling %s gives %s (clamped %s)',
    (product, tradeDate, wanted, ceiling, contract, clamped) => {
      expect(ceilingContract(product, tradeDate, wanted, ceiling)).toEqual({
        contract,
        clamped,
      });
    },
  );

  it.each([
    ['another root', 'NQZ6'],
    ['a spread', 'ESZ6-ESH7'],
    ['a two-digit year outside the window', 'ESZ36'],
    ['an empty name', ''],
  ])(
    'throws, naming the product and date, on a ceiling that is %s',
    (_label, ceiling) => {
      expect(() =>
        ceilingContract('ES', '2026-07-24', 'ESU6', ceiling),
      ).toThrow(
        /ES front month for 2026-07-24: the next stored decision, .* is not an outright ES contract/,
      );
    },
  );
});
