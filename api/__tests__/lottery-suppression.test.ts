import { describe, it, expect } from 'vitest';
import {
  neon,
  SqlTemplate,
  type NeonQueryFunction,
} from '@neondatabase/serverless';
import {
  keptSuppressionSql,
  SYMBOL_ALIAS_WHITELIST,
} from '../_lib/lottery-suppression.js';

// A real neon query function. No connection is ever opened — every test only
// BUILDS the tagged-template query and inspects the parameterized form via
// `SqlTemplate.toParameterizedQuery`, exactly the path the driver takes before
// it would send the query over HTTP.
const db: NeonQueryFunction<false, false> = neon(
  'postgresql://u:p@localhost/db',
);

/**
 * Build a fragment, embed it in a representative outer query (so the
 * fragment's params are renumbered against the shared params array exactly as
 * production does), and return the flattened { query, params }.
 */
function buildEmbedded(
  symbolAlias: string,
  showAll: boolean | undefined,
  keptTickers: string[],
): { query: string; params: unknown[] } {
  const frag = keptSuppressionSql(db, symbolAlias, showAll, keptTickers);
  const outer = db`SELECT * FROM filtered f WHERE rn = 1 AND ${frag} ORDER BY id`;
  const qd = outer.queryData;
  if (!(qd instanceof SqlTemplate)) {
    throw new Error('expected a SqlTemplate queryData');
  }
  return qd.toParameterizedQuery();
}

describe('keptSuppressionSql', () => {
  describe('whitelisted aliases produce the canonical predicate', () => {
    for (const alias of SYMBOL_ALIAS_WHITELIST) {
      it(`splices "${alias}" as a raw identifier on underlying_symbol`, () => {
        const { query } = buildEmbedded(alias, false, ['AAPL']);
        // Quintile term is hardcoded to the invariant `s` stats alias.
        expect(query).toContain('s.inversion_quintile IS NULL');
        expect(query).toContain('s.inversion_quintile > 2');
        // Symbol term uses the passed alias, spliced raw (no $-placeholder).
        expect(query).toContain(`${alias}.underlying_symbol = ANY(`);
        // The alias is NOT bound as a param (would appear as a literal value).
        expect(query).not.toContain(`'${alias}'`);
      });
    }
  });

  it('binds showAll and keptTickers as params, never inlining them', () => {
    const { query, params } = buildEmbedded('f', false, ['AAPL', 'TSLA']);

    // showAll → $1, keptTickers → $2 (renumbered after the outer query has
    // no prior params; these are the only two binds).
    expect(query).toContain('$1::boolean');
    expect(query).toContain('= ANY($2::text[])');

    // The kept tickers are an array param, NOT inlined into the SQL text.
    expect(query).not.toContain('AAPL');
    expect(query).not.toContain('TSLA');

    expect(params).toEqual([false, ['AAPL', 'TSLA']]);
  });

  it('coalesces undefined showAll to false (bound, not inlined)', () => {
    const { query, params } = buildEmbedded('f', undefined, ['AAPL']);
    expect(query).toContain('$1::boolean');
    expect(params[0]).toBe(false);
  });

  it('passes through showAll=true as a bound param', () => {
    const { params } = buildEmbedded('ranked', true, ['AAPL']);
    expect(params[0]).toBe(true);
  });

  it('binds the empty kept-set to a match-nothing array param', () => {
    const { query, params } = buildEmbedded('cd', false, []);
    // Still parameterized as an array — ANY([]) matches nothing, so term 4
    // contributes no extra keeps (identical to pre-helper behavior).
    expect(query).toContain('= ANY($2::text[])');
    expect(params).toEqual([false, []]);
  });

  it('produces the full canonical predicate text for alias f', () => {
    const frag = keptSuppressionSql(db, 'f', false, ['AAPL']);
    const qd = frag.queryData;
    if (!(qd instanceof SqlTemplate)) {
      throw new Error('expected a SqlTemplate queryData');
    }
    const { query } = qd.toParameterizedQuery();
    expect(query).toBe(
      '($1::boolean OR s.inversion_quintile IS NULL OR s.inversion_quintile > 2 OR f.underlying_symbol = ANY($2::text[]))',
    );
  });

  describe('alias whitelist enforcement', () => {
    for (const bad of [
      's', // the stats alias — its symbol column is `ticker`, not underlying_symbol
      'x',
      'f; DROP TABLE lottery_finder_fires; --',
      'f OR 1=1',
      '',
      'F', // case-sensitive: uppercase is not whitelisted
    ]) {
      it(`rejects invalid alias ${JSON.stringify(bad)}`, () => {
        expect(() => keptSuppressionSql(db, bad, false, ['AAPL'])).toThrow(
          /invalid symbol alias/,
        );
      });
    }
  });

  it('whitelist matches the four documented call-site aliases (minus s)', () => {
    expect([...SYMBOL_ALIAS_WHITELIST].sort()).toEqual(['cd', 'f', 'ranked']);
  });
});
