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

/**
 * Neon-shaped tagged template over pglite, enough for the migrations'
 * `sql\`...\`` calls. Lazy (runs on await), so a `statements` array is
 * applied strictly in order.
 */
function taggedSql(pg: PGlite) {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, part, i) => `${acc}$${i}${part}`);
    return {
      then<T>(
        onFulfilled: (rows: unknown[]) => T,
        onRejected?: (err: unknown) => T,
      ) {
        return pg
          .query(text, values)
          .then((r) => r.rows)
          .then(onFulfilled, onRejected);
      },
    };
  };
}

/** Apply migration `id` (its `statements` in order, or its `run`). */
export async function applyMigration(pg: PGlite, id: number): Promise<void> {
  const migration = MIGRATIONS.find((m) => m.id === id);
  if (!migration) throw new Error(`migration #${id} not found`);
  const sql = taggedSql(pg) as unknown as Sql;
  if (migration.statements) {
    for (const statement of migration.statements(sql)) await statement;
  } else if (migration.run) {
    await migration.run(sql);
  }
}
