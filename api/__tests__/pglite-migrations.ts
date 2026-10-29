/**
 * Test helper: build tables in pglite from the REAL migration entries in
 * api/_lib/db-migrations.ts, so a real-SQL test runs against the
 * production schema instead of a hand-copied CREATE TABLE.
 *
 * Only for migrations that stand alone (a CREATE TABLE and its indexes);
 * one that alters many tables needs all of them to exist first.
 */

import type { PGlite } from '@electric-sql/pglite';

import { MIGRATIONS } from '../_lib/db-migrations.js';

type Sql = Parameters<NonNullable<(typeof MIGRATIONS)[number]['run']>>[0];

/** One lazy query: runs on await, and exposes its text for `transaction`. */
export interface PgliteQuery extends PromiseLike<unknown[]> {
  readonly text: string;
  readonly params: unknown[];
}

/**
 * Neon-shaped client over pglite: the tagged template (lazy, so a
 * `statements` array is applied strictly in order) plus
 * `transaction([...])`, which runs the queries in order inside one pglite
 * transaction and resolves to one row array per query, as the neon HTTP
 * driver does. Hand it to code under test through a `vi.mock` of `getDb`.
 */
export function neonOverPglite(pg: PGlite) {
  const tag = (
    strings: TemplateStringsArray,
    ...params: unknown[]
  ): PgliteQuery => {
    const text = strings.reduce((acc, part, i) => `${acc}$${i}${part}`);
    return {
      text,
      params,
      then: (onFulfilled, onRejected) =>
        pg
          .query(text, params)
          .then((r) => r.rows)
          .then(onFulfilled, onRejected),
    };
  };
  return Object.assign(tag, {
    transaction: (queries: PgliteQuery[]) =>
      pg.transaction(async (tx) => {
        const results: unknown[][] = [];
        for (const q of queries) {
          results.push((await tx.query(q.text, q.params)).rows);
        }
        return results;
      }),
  });
}

/** Apply migration `id` (its `statements` in order, or its `run`). */
export async function applyMigration(pg: PGlite, id: number): Promise<void> {
  const migration = MIGRATIONS.find((m) => m.id === id);
  if (!migration) throw new Error(`migration #${id} not found`);
  const sql = neonOverPglite(pg) as unknown as Sql;
  if (migration.statements) {
    for (const statement of migration.statements(sql)) await statement;
  } else if (migration.run) {
    await migration.run(sql);
  }
}
