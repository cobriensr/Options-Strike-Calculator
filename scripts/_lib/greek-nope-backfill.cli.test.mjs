// @vitest-environment node

/**
 * The three backfill scripts run end to end as child processes, with the
 * network replaced by greek-nope-backfill-stub.mjs (UW answers a canned day;
 * the database answers like Postgres, or refuses with a missing-table error)
 * (spec P0.9, docs/superpowers/specs/live-data-integrity-2026-11-06.md). The
 * exit code and the number of statements cannot be seen any other way: the
 * scripts run on import.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const SCRIPTS = [
  {
    file: 'backfill-greek-flow-etf.mjs',
    writer: 'backfill-greek-flow-etf',
    args: ['2026-03-24'],
    cols: 14,
    // Three ticks of 14 columns, then the writer; one statement per ticker.
    params: 43,
    statements: 2,
    failedWrite: 'Upsert error (SPY 2026-03-24): relation "revisions"',
    totals: {
      ok: ['Inserted: 6', 'Store failures (ticks): 0'],
      updated: ['Updated:  6', 'Store failures (ticks): 0'],
      unchanged: ['Unchanged: 6', 'Store failures (ticks): 0'],
      error: ['Inserted: 0', 'Store failures (ticks): 6'],
    },
  },
  {
    file: 'backfill-greek-flow-etf-0dte.mjs',
    writer: 'backfill-greek-flow-etf-0dte',
    args: ['2026-03-24'],
    cols: 14,
    params: 43,
    statements: 2,
    failedWrite:
      'Upsert error (SPY 2026-03-24 expiry 2026-03-24): relation "revisions"',
    totals: {
      ok: ['Inserted:                    6', 'Failed:                      0'],
      updated: [
        'Updated:                     6',
        'Failed:                      0',
      ],
      unchanged: [
        'Unchanged:                   6',
        'Failed:                      0',
      ],
      error: [
        'Inserted:                    0',
        'Failed:                      6',
      ],
    },
  },
  {
    file: 'backfill-nope.mjs',
    writer: 'backfill-nope',
    args: ['1'],
    cols: 11,
    // Three valid rows of 11 columns, then the writer; the fourth row (stock_vol
    // 0) is skipped. One statement for the one day.
    params: 34,
    statements: 1,
    failedWrite: 'Insert error: relation "revisions"',
    totals: {
      ok: [
        'Inserted: 3',
        'Skipped (bad stock_vol): 1',
        'Store failures (rows): 0',
      ],
      updated: ['Updated: 3', 'Store failures (rows): 0'],
      unchanged: ['Unchanged: 3', 'Store failures (rows): 0'],
      error: ['Inserted: 0', 'Store failures (rows): 3'],
    },
  },
];

function run({ file, args, cols }, sqlMode) {
  const clean = { ...process.env };
  delete clean.SENTRY_DSN;
  return spawnSync(
    process.execPath,
    [
      '--import',
      // A file URL: on Windows node rejects a bare absolute path here.
      pathToFileURL(
        path.resolve(
          process.cwd(),
          'scripts/_lib/greek-nope-backfill-stub.mjs',
        ),
      ).href,
      path.resolve(process.cwd(), 'scripts', file),
      ...args,
    ],
    {
      env: {
        ...clean,
        UW_API_KEY: 'uw-key-for-tests',
        DATABASE_URL: 'postgresql://user:pass@db.invalid/db',
        STUB_SQL: sqlMode,
        STUB_COLS: String(cols),
      },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
}
const statements = (result) =>
  result.stderr.split('\n').filter((line) => line.startsWith('sql '));

describe('the backfill scripts, run end to end', () => {
  it.each(SCRIPTS)(
    '$file writes each day as one logged statement under its own name and exits 0',
    (script) => {
      const result = run(script, 'ok');

      expect(result.status, result.stderr).toBe(0);
      expect(statements(result)).toEqual(
        Array.from(
          { length: script.statements },
          () => `sql ${script.params} ${script.writer}`,
        ),
      );
      for (const line of script.totals.ok)
        expect(result.stdout).toContain(line);
    },
  );

  it.each(SCRIPTS)('$file reports rows UW restated as updated', (script) => {
    const result = run(script, 'updated');

    expect(result.status, result.stderr).toBe(0);
    for (const line of script.totals.updated) {
      expect(result.stdout).toContain(line);
    }
  });

  it.each(SCRIPTS)(
    '$file reports rows the guard skipped as unchanged and still exits 0',
    (script) => {
      const result = run(script, 'unchanged');

      expect(result.status, result.stderr).toBe(0);
      for (const line of script.totals.unchanged) {
        expect(result.stdout).toContain(line);
      }
    },
  );

  it.each(SCRIPTS)(
    '$file exits 1 and says so when the write fails (R4), not 0 with "Inserted: 0"',
    (script) => {
      const result = run(script, 'error');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(script.failedWrite);
      for (const line of script.totals.error) {
        expect(result.stdout).toContain(line);
      }
      // A failed day made one attempt, not one per tick.
      expect(statements(result)).toHaveLength(script.statements);
    },
  );

  it('the stub throws on any host but Unusual Whales and the test database (no real network from a child process)', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(
          path.resolve(
            process.cwd(),
            'scripts/_lib/greek-nope-backfill-stub.mjs',
          ),
        ).href,
        '-e',
        "fetch('https://example.com/x').catch((e) => { console.error(e.message); process.exit(3); })",
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('unexpected host example.com');
  });
});
