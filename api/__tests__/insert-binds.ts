/**
 * Test helper: extract INSERT binds keyed by column name.
 *
 * The neon tagged-template driver records each `sql` call as
 * `[stringsArray, ...bindValues]` in the vitest mock. Asserting on
 * specific binds by index (e.g. `insertCall.at(-9)`) is brittle —
 * adding a column to the INSERT shifts every assertion downstream,
 * requiring the offset-shift dance you'll see in this directory's
 * git history.
 *
 * Instead, parse the column list once from the SQL literal and return
 * a `Map<columnName, bindValue>`. Callers express intent — "the
 * `mkt_tide_diff` bind should be 6000" — and a future column-add
 * doesn't break a single assertion.
 *
 * Contract: assumes the INSERT statement lists columns in the same
 * order as the `${...}` interpolations in VALUES (which is how every
 * `INSERT` in this repo is written). Multi-statement template
 * fragments are not supported.
 */

type Mock = { mock: { calls: unknown[][] } };

/**
 * Find the most recent call to `mockSql` that began with `INSERT INTO
 * <table>` and return a map of bound parameter values keyed by the
 * column name from the SQL literal.
 *
 * Throws if no matching call was recorded — that's almost always a
 * test-setup bug (e.g. the mock sequence ran out before the INSERT
 * fired, or the SQL was reordered to UPSERT a different table). A
 * loud failure here beats silent `undefined` reads downstream.
 */
export function extractInsertBinds(
  mockSql: Mock,
  table: string,
): Map<string, unknown> {
  const all = extractAllInsertBinds(mockSql, table);
  const last = all.at(-1);
  if (!last) {
    throw new Error(
      `extractInsertBinds: no INSERT INTO ${table} call recorded on mockSql`,
    );
  }
  return last;
}

/**
 * Like `extractInsertBinds` but returns one Map per matching INSERT
 * call in chronological order. Use when a single cron run produces
 * multiple INSERTs (e.g. the adj-cofire test, which fires twice and
 * asserts both rows carry the cofire flag).
 */
export function extractAllInsertBinds(
  mockSql: Mock,
  table: string,
): Map<string, unknown>[] {
  const calls = mockSql.mock.calls.filter((c) => {
    const strings = c[0] as readonly string[] | undefined;
    return Boolean(strings?.[0]?.includes(`INSERT INTO ${table}`));
  });
  return calls.map((call) => parseBinds(call, table));
}

function parseBinds(
  call: unknown[],
  table: string,
): Map<string, unknown> {
  const strings = call[0] as readonly string[];
  const head = strings[0] ?? '';
  // Capture the column list between `INSERT INTO <table> (` and the
  // close paren that precedes VALUES. The column list is always
  // contained entirely within the first literal fragment because no
  // `${...}` interpolation lands inside it in this codebase.
  const match = head.match(
    new RegExp(
      `INSERT INTO ${table}\\s*\\(([\\s\\S]+?)\\)\\s*VALUES`,
      '',
    ),
  );
  if (!match) {
    throw new Error(
      `extractInsertBinds: could not parse column list from ` +
        `${JSON.stringify(head.slice(0, 200))}`,
    );
  }
  const cols = match[1]!
    .split(/[,\s]+/)
    .map((c) => c.trim())
    .filter(Boolean);

  // call[0] is the strings array; binds are call[1]..call[N] in the
  // same order columns appear in the SQL.
  const binds = new Map<string, unknown>();
  for (let i = 0; i < cols.length; i += 1) {
    const value = call[i + 1];
    binds.set(cols[i]!, value);
  }
  return binds;
}

/**
 * The 8 GexBot context columns added by migrations #180
 * (silent_boom_alerts) and #181 (lottery_finder_fires). Pinned here so
 * both detect-cron tests can `expectAllGexBindsNull(binds)` without
 * duplicating the column list.
 */
export const GEX_BIND_COLUMNS: readonly string[] = [
  'gex_one_cvroflow',
  'gex_net_put_dex',
  'gex_one_dexoflow',
  'gex_one_gexoflow',
  'gex_zcvr',
  'gex_zero_gamma',
  'gex_spot',
  'gex_captured_at',
];

/**
 * Assert that every gex_* bind in an extracted bind map is null.
 * Used by the "lookup throws", "ticker out of universe", and "default
 * mock returns null" tests in both detect-silent-boom and
 * detect-lottery-fires.
 *
 * Throws on the first non-null bind — the column name in the message
 * tells you exactly which one regressed.
 */
export function expectAllGexBindsNull(binds: Map<string, unknown>): void {
  for (const col of GEX_BIND_COLUMNS) {
    const value = binds.get(col);
    if (value !== null) {
      throw new Error(
        `expectAllGexBindsNull: ${col} should be null, got ${JSON.stringify(value)}`,
      );
    }
  }
}
