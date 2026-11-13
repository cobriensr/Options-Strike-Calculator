// @vitest-environment node

/**
 * Guard: no plain `SET` statement in api/ SQL, and no `SET LOCAL` outside a
 * transaction batch.
 *
 * getDb() is the @neondatabase/serverless HTTP driver. Every tagged-template
 * query is its own POST, so it is its own session: a `SET statement_timeout`
 * runs on one connection and the next query lands on another. A production
 * probe ran `SET statement_timeout = '1234ms'` then `SHOW statement_timeout`
 * and read 0 both times. The SET lines in build-features and curate-lessons
 * never took effect for that reason, and were deleted.
 *
 * `SET LOCAL` is the right form, because it lives for one transaction and
 * `sql.transaction([...])` sends the whole batch in one request (the
 * migrations' `SET LOCAL lock_timeout` lines rely on it). Alone it is the same
 * silent no-op: Postgres answers a `SET LOCAL` outside a transaction with a
 * WARNING and does nothing. So the guard allows `SET LOCAL` only as an element
 * of an array literal, which covers `sql.transaction([...])` and the
 * migrations' `statements: (sql) => [...]` arrays that db.ts hands to
 * `sql.transaction` later. It takes the array literal as the batch and does
 * not follow it to the call. A plain `SET` inside a batch would also apply for
 * the rest of that batch, since the batch is one connection, but the guard
 * flags it anyway because its scope is unclear.
 *
 * What it scans: every non-test .ts file under api/, parsed with the
 * TypeScript compiler so comments and prose never match. It flags a tagged
 * template (any tag) or the first argument of a `.query(` / `.unsafe(` call
 * when that literal begins with SET, or with SET LOCAL when the statement is
 * not an array element. It does not see a statement built in a variable and
 * passed in later, a statement that opens with an SQL comment, or
 * `set_config(..., false)`.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

interface SessionSet {
  line: number;
  text: string;
}

// `SET` as a whole word, not followed by LOCAL. Case-insensitive because
// Postgres is. `\b` stops `SETTLE` and `SETUP` matching.
const SESSION_SET = /^\s*SET\b(?!\s+LOCAL\b)/i;
const SET_LOCAL = /^\s*SET\s+LOCAL\b/i;

/**
 * Whether `statement` (a tagged template or a `.query(` call) is an element of
 * an array literal, looking through parentheses. Needs a tree built with
 * parent nodes.
 */
function isArrayElement(statement: ts.Node): boolean {
  let parent = statement.parent;
  while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return ts.isArrayLiteralExpression(parent);
}

function findSessionSets(source: string): SessionSet[] {
  // `setParentNodes` is what lets `isArrayElement` walk up from a statement.
  const file = ts.createSourceFile(
    'scanned.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const found: SessionSet[] = [];

  // `literal` is the opening piece of a template or the whole of a string, and
  // `statement` the tagged template or call that holds it.
  const check = (
    literal: ts.StringLiteralLike | ts.TemplateHead,
    statement: ts.Node,
  ) => {
    const outsideBatch =
      SET_LOCAL.test(literal.text) && !isArrayElement(statement);
    if (!SESSION_SET.test(literal.text) && !outsideBatch) return;
    // Skip the opening quote and any leading whitespace to land on the SET.
    const lead = literal.text.length - literal.text.trimStart().length;
    const at = literal.getStart(file) + 1 + lead;
    found.push({
      line: file.getLineAndCharacterOfPosition(at).line + 1,
      text: literal.text.trim().split('\n')[0]!.slice(0, 80),
    });
  };

  const visit = (node: ts.Node) => {
    if (ts.isTaggedTemplateExpression(node)) {
      check(
        ts.isNoSubstitutionTemplateLiteral(node.template)
          ? node.template
          : node.template.head,
        node,
      );
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'query' ||
        node.expression.name.text === 'unsafe')
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) check(arg, node);
      else if (arg && ts.isTemplateExpression(arg)) check(arg.head, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Every non-test .ts file under api/, as a forward-slash path from api/. */
function apiSourceFiles(apiDir: string): string[] {
  return readdirSync(apiDir, { recursive: true, encoding: 'utf8' })
    .map((p) => p.replaceAll('\\', '/'))
    .filter(
      (p) =>
        p.endsWith('.ts') &&
        !p.endsWith('.test.ts') &&
        !p.split('/').includes('__tests__'),
    );
}

describe('findSessionSets', () => {
  it.each([
    ['a tagged template', "sql`SET statement_timeout = '30000'`"],
    [
      'a tagged template that opens its own line',
      'sql`\n    SET search_path TO x`',
    ],
    ['a template with a substitution', 'sql`SET statement_timeout = ${ms}`'],
    ['lower case', "sql`set statement_timeout = '30000'`"],
    [
      'inside withDbRetry',
      "withDbRetry(() => sql`SET statement_timeout = '1'`, 2)",
    ],
    ['a differently named tag', 'tx`SET statement_timeout = 0`'],
    [
      'SET SESSION',
      'sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`',
    ],
    ['sql.query with single quotes', "sql.query('SET statement_timeout = 0')"],
    ['sql.query with double quotes', 'sql.query("SET statement_timeout = 0")'],
    ['sql.query with a template', 'sql.query(`SET statement_timeout = 0`)'],
    ['sql.unsafe', "sql.unsafe('SET statement_timeout = 0')"],
    [
      'a plain SET inside a transaction batch',
      "sql.transaction([sql`SET statement_timeout = '5s'`, sql`SELECT 1`])",
    ],
    // Postgres answers a SET LOCAL outside a transaction with a WARNING and
    // does nothing: the same silent no-op as a plain SET.
    ['a bare SET LOCAL', "await sql`SET LOCAL lock_timeout = '5s'`"],
    [
      'a bare SET LOCAL in sql.query',
      "await sql.query('SET LOCAL lock_timeout = 0')",
    ],
    [
      'a SET LOCAL that is a call argument, not an array element',
      "withDbRetry(() => sql`SET LOCAL lock_timeout = '5s'`, 2)",
    ],
    [
      'a SET LOCAL whose array element is a wrapped call',
      "sql.transaction([withDbRetry(() => sql`SET LOCAL lock_timeout = '5s'`)])",
    ],
  ])('flags %s', (_name, source) => {
    expect(findSessionSets(source)).toHaveLength(1);
  });

  it.each([
    // SET LOCAL lives for one transaction, so each is an element of an array
    // literal: the batch `sql.transaction([...])` sends in one request.
    [
      'SET LOCAL',
      "sql.transaction([sql`SET LOCAL lock_timeout = '5s'`, sql`SELECT 1`])",
    ],
    [
      'lower case set local',
      "sql.transaction([sql`set local lock_timeout = '5s'`])",
    ],
    [
      'SET LOCAL after a line break',
      'sql.transaction([sql`SET\n  LOCAL lock_timeout = 0`])',
    ],
    [
      'SET LOCAL in sql.query',
      "sql.transaction([sql.query('SET LOCAL lock_timeout = 0')])",
    ],
    [
      "SET LOCAL in a migration's statements array",
      "const m = { statements: (sql) => [sql`SET LOCAL lock_timeout = '5s'`, sql`CREATE INDEX i ON t (a)`] }",
    ],
    [
      'SET LOCAL in a parenthesized array element',
      "sql.transaction([(sql`SET LOCAL lock_timeout = '5s'`)])",
    ],
    ['the SET clause of an UPDATE', 'sql`UPDATE t SET a = 1 WHERE b = 2`'],
    ['an UPDATE whose SET opens a line', 'sql`\n  UPDATE t\n  SET a = 1`'],
    [
      'the SET clause of an upsert',
      'sql`INSERT INTO t (a) VALUES (1)\n ON CONFLICT (a) DO UPDATE SET a = 2`',
    ],
    ['SET as part of a longer word', 'sql`SETTLE x`'],
    ['prose in a plain string', 'const hint = "set threshold at X"'],
    ['a plain string that is not a query call', "log('SET statement_timeout')"],
    [
      'a comment that quotes the statement',
      '// was sql`SET statement_timeout = 0`\n/* sql.query("SET x") */',
    ],
    [
      'a backticked word before prose that starts with set',
      '// the `ranked` set (no LIMIT) is read whole',
    ],
  ])('ignores %s', (_name, source) => {
    expect(findSessionSets(source)).toEqual([]);
  });

  it('reports the line of the SET and the statement text', () => {
    const source =
      "const a = 1;\nconst b = 2;\nawait sql`SET statement_timeout = '5'`;";
    expect(findSessionSets(source)).toEqual([
      { line: 3, text: "SET statement_timeout = '5'" },
    ]);
  });

  it('reports the SET line when the template opens a line earlier', () => {
    const source = 'x;\nawait sql`\n  SET statement_timeout = 0`;';
    expect(findSessionSets(source)).toEqual([
      { line: 3, text: 'SET statement_timeout = 0' },
    ]);
  });

  it('finds every SET in a file, each on its own line', () => {
    const source =
      "sql`SET a = 1`;\nsql.transaction([sql`SET LOCAL b = 2`]);\nsql.query('SET c = 3');";
    expect(findSessionSets(source).map((s) => s.line)).toEqual([1, 3]);
  });

  it('reports a bare SET LOCAL with its line and statement text', () => {
    const source =
      "sql.transaction([sql`SET LOCAL a = 1`]);\nawait sql`SET LOCAL lock_timeout = '5s'`;";
    expect(findSessionSets(source)).toEqual([
      { line: 2, text: "SET LOCAL lock_timeout = '5s'" },
    ]);
  });
});

describe('api/ session SET guard', () => {
  const apiDir = resolve(process.cwd(), 'api');
  const files = apiSourceFiles(apiDir);

  it('scans the api tree, not an empty or wrong directory', () => {
    expect(files.length).toBeGreaterThan(100);
    // The two handlers the guard exists for, and the file that holds the
    // `SET LOCAL` lines it must let through.
    expect(files).toContain('cron/build-features.ts');
    expect(files).toContain('cron/curate-lessons.ts');
    expect(files).toContain('_lib/db-migrations.ts');
    expect(files.some((f) => f.includes('__tests__'))).toBe(false);
  });

  it('lets the migrations’ SET LOCAL lines through', () => {
    const migrations = readFileSync(
      resolve(apiDir, '_lib/db-migrations.ts'),
      'utf8',
    );
    expect(migrations).toContain('SET LOCAL lock_timeout');
    expect(findSessionSets(migrations)).toEqual([]);
  });

  it('has no plain SET, and no SET LOCAL outside a batch, in any api/ source file', () => {
    const offenders = files.flatMap((file) =>
      findSessionSets(readFileSync(resolve(apiDir, file), 'utf8')).map(
        ({ line, text }) => `api/${file}:${line}: ${text}`,
      ),
    );
    expect(
      offenders,
      'The Neon HTTP driver runs each query in its own session, so a plain ' +
        'SET never reaches the next query, and a SET LOCAL outside a ' +
        'transaction does nothing. Delete it, or put a SET LOCAL in the ' +
        'array of sql.transaction([...]).',
    ).toEqual([]);
  });
});
