// @vitest-environment node

/**
 * The thin CLI, scripts/repair-options-volume.ts: it runs `main()` on import,
 * so each case sets argv, imports it fresh and waits for the exit code it sets
 * on `process.exitCode`. The CLI never calls `process.exit`, so stdout is
 * flushed before the process ends, which a pipe on Windows needs. The module
 * boundaries are mocked with `vi.mock` (dotenv, the env-file lookup, `runRepair`
 * and `runUndo`, and the DB client the library imports), so no env file is read
 * and no database is reached. The real `parseArgs`, `USAGE`, the reports and the
 * exit codes run. The pure and SQL behaviour is in
 * options-volume-repair.test.ts and options-volume-repair-pglite.test.ts.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

const { config, resolveEnvFile, runRepair, runUndo } = vi.hoisted(() => ({
  config: vi.fn(),
  resolveEnvFile: vi.fn(),
  runRepair: vi.fn(),
  runUndo: vi.fn(),
}));

vi.mock('dotenv', () => ({ config }));
vi.mock('./anchor-backfill.js', () => ({ resolveEnvFile }));
// The runs are mocked, so nothing here reads the DB. The stub keeps its Sentry
// and Redis clients out of every fresh import.
vi.mock('../../api/_lib/db.js', () => ({
  getDb: vi.fn(),
  withDbRetry: vi.fn(),
}));
vi.mock('./options-volume-repair.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./options-volume-repair.js')>()),
  runRepair,
  runUndo,
}));

import type { RunResult, UndoResult, Values } from './options-volume-repair.js';
import { COLUMNS } from './options-volume-repair.js';

const BACKUP_DIR = 'docs/tmp/options-volume-repair';
const PLAN_FILE = `${BACKUP_DIR}/dry-run-all-x.json`;
const BACKUP_FILE = `${BACKUP_DIR}/backup-all-x.json`;
const SOURCE = 'docs/tmp/opt-volume/reply.json';
// What the library names, after its first query succeeded. The CLI prints it
// as it comes and never derives one from DATABASE_URL itself.
const DATABASE = 'ep-test-1.neon.tech/db';

const NULLS: Values = Object.fromEntries(COLUMNS.map((c) => [c.name, null]));

const DRY_RESULT: RunResult = {
  apply: false,
  plan: {
    source: {
      sha256: 'ab'.repeat(32),
      rows: 2,
      first: '2026-11-10',
      last: '2026-11-11',
    },
    dates: [
      {
        date: '2026-11-11',
        sameDay: { kind: 'row', date: '2026-11-11' },
        previous: { kind: 'row', date: '2026-11-10' },
        before: NULLS,
        after: { ...NULLS, opt_call_volume: '111000' },
        changed: ['opt_call_volume'],
      },
    ],
    outsideSpan: [],
  },
  scope: { date: null, since: null, until: null },
  backupFile: null,
  planFile: PLAN_FILE,
  applied: null,
  database: DATABASE,
};

const UNDO_RESULT: UndoResult = {
  apply: true,
  rows: 4,
  restored: 4,
  changedSince: [],
  database: DATABASE,
};

const originalArgv = process.argv;
const originalEnv = { ...process.env };

let log: MockInstance<typeof console.log>;
let error: MockInstance<typeof console.error>;
let exit: MockInstance<typeof process.exit>;

beforeEach(() => {
  config.mockReset();
  resolveEnvFile.mockReset().mockReturnValue('/resolved/.env.local');
  runRepair.mockReset().mockResolvedValue(DRY_RESULT);
  runUndo.mockReset().mockResolvedValue(UNDO_RESULT);
  process.env.DATABASE_URL = 'postgres://owner:s3cret@ep-test-1.neon.tech/db';
  process.env.UW_API_KEY = 'uw-secret-key';
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  exit = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
});

afterEach(() => {
  // A leftover exit code would end the vitest worker with it.
  process.exitCode = undefined;
  process.argv = originalArgv;
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

/** Run the CLI with these arguments and return the exit code it set. */
async function runCli(...args: string[]): Promise<unknown> {
  vi.resetModules();
  process.exitCode = undefined;
  process.argv = ['node', 'repair-options-volume.ts', ...args];
  await import('../repair-options-volume.js');
  await vi.waitFor(() => expect(process.exitCode).not.toBeUndefined());
  const code = process.exitCode;
  process.exitCode = undefined;
  return code;
}

const printed = (spy: MockInstance<typeof console.log>): string =>
  spy.mock.calls.map((call) => String(call[0])).join('\n');

describe('repair-options-volume CLI', () => {
  // Each case imports the CLI afresh. Keep this file to 9 CLI imports or fewer:
  // past 10 fresh imports in one file Node warns about a listener leak.

  it('is a dry run with only --source: prints the database name and the report, never a credential', async () => {
    expect(await runCli('--source', SOURCE)).toBe(0);

    expect(runRepair).toHaveBeenCalledTimes(1);
    expect(runRepair).toHaveBeenCalledWith({
      source: SOURCE,
      date: null,
      since: null,
      until: null,
      apply: false,
      planFile: null,
      all: false,
      backupDir: BACKUP_DIR,
    });
    expect(runUndo).not.toHaveBeenCalled();
    expect(resolveEnvFile).toHaveBeenCalledWith(null, '.');
    expect(config).toHaveBeenCalledWith({
      path: '/resolved/.env.local',
      quiet: true,
    });
    const out = printed(log);
    // The name the run returned, once, before the report; not the URL's.
    expect(out).toContain(`Database: ${DATABASE}`);
    expect(out.indexOf('Database:')).toBeLessThan(out.indexOf('Source:'));
    expect(out).toContain('Source: 2 rows, 2026-11-10 to 2026-11-11');
    expect(out).toContain(`Plan file: ${PLAN_FILE}`);
    expect(out).toContain('    opt_call_volume: NULL -> 111000');
    expect(out).not.toContain('s3cret');
    expect(out).not.toContain('owner');
    expect(out).not.toContain('uw-secret-key');
    expect(error).not.toHaveBeenCalled();
    // process.exit would cut a piped stdout short on Windows.
    expect(exit).not.toHaveBeenCalled();
  });

  it('forwards --date, --since, --until, --backup-dir and --env-file', async () => {
    expect(
      await runCli(
        '--source',
        SOURCE,
        '--since',
        '2026-11-01',
        '--until',
        '2026-11-30',
        '--backup-dir',
        'out',
        '--env-file',
        'other/.env.local',
      ),
    ).toBe(0);

    expect(runRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        since: '2026-11-01',
        until: '2026-11-30',
        backupDir: 'out',
      }),
    );
    expect(resolveEnvFile).toHaveBeenCalledWith('other/.env.local', '.');
  });

  it('applies the reviewed plan with --apply --plan --all, passing the confirmation on: prints the apply report and the backup file', async () => {
    runRepair.mockResolvedValue({
      ...DRY_RESULT,
      apply: true,
      backupFile: BACKUP_FILE,
      applied: {
        backupFile: BACKUP_FILE,
        planned: 1,
        written: 1,
        changedSinceRead: [],
      },
    });

    expect(
      await runCli('--source', SOURCE, '--apply', '--plan', PLAN_FILE, '--all'),
    ).toBe(0);

    // The dry run above pins the default, `all: false`.
    expect(runRepair).toHaveBeenCalledWith({
      source: SOURCE,
      date: null,
      since: null,
      until: null,
      apply: true,
      planFile: PLAN_FILE,
      all: true,
      backupDir: BACKUP_DIR,
    });
    const out = printed(log);
    expect(out).toContain('Wrote 1 of 1 planned dates.');
    expect(out).toContain(`Backup: ${BACKUP_FILE}`);
    expect(out).not.toContain('s3cret');
  });

  it('exits 1, naming the dates, when an apply wrote fewer dates than it planned', async () => {
    runRepair.mockResolvedValue({
      ...DRY_RESULT,
      apply: true,
      backupFile: BACKUP_FILE,
      applied: {
        backupFile: BACKUP_FILE,
        planned: 1,
        written: 0,
        changedSinceRead: ['2026-11-11'],
      },
    });

    expect(
      await runCli('--source', SOURCE, '--apply', '--plan', PLAN_FILE),
    ).toBe(1);

    expect(printed(log)).toContain(
      'Changed since the read, not written (1): 2026-11-11',
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('restores from a backup instead of repairing, needing no source; exits 1 when it restored fewer dates than the file holds', async () => {
    runUndo.mockResolvedValue({
      ...UNDO_RESULT,
      restored: 3,
      changedSince: ['2026-11-11'],
    });

    expect(await runCli('--undo-file', BACKUP_FILE, '--apply')).toBe(1);

    expect(runUndo).toHaveBeenCalledWith({ file: BACKUP_FILE, apply: true });
    expect(runRepair).not.toHaveBeenCalled();
    const out = printed(log);
    expect(out).toContain('Restored 3 of 4 dates.');
    expect(out).toContain('2026-11-11');
    expect(out).toContain(`Database: ${DATABASE}`);
  });

  it('prints the usage for --help, and exits 0 without loading env or running', async () => {
    expect(await runCli('--help')).toBe(0);

    const out = printed(log);
    expect(out).toContain('Usage: npx tsx scripts/repair-options-volume.ts');
    expect(out).toContain('never reads UW_API_KEY');
    expect(resolveEnvFile).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(runRepair).not.toHaveBeenCalled();
    expect(runUndo).not.toHaveBeenCalled();
  });

  it.each([
    [[], /--source <file> is required/],
    [['--source', SOURCE, '--apply'], /Refusing to apply without --plan/],
    [
      ['--source', SOURCE, '--all', '--plan', PLAN_FILE],
      /--all only confirms --apply --plan/,
    ],
  ])(
    'rejects %j with exit 1 before loading any env or touching the database',
    async (args, message) => {
      expect(await runCli(...args)).toBe(1);

      expect(printed(error)).toMatch(message);
      expect(config).not.toHaveBeenCalled();
      expect(runRepair).not.toHaveBeenCalled();
      expect(runUndo).not.toHaveBeenCalled();
    },
  );

  it('exits 1 with the run’s message, and no report, when the run fails', async () => {
    runRepair.mockRejectedValue(
      new Error(
        'A fresh plan is not the plan in p.json. Nothing was written.\n  2026-11-11: the stored values changed since the dry run',
      ),
    );

    expect(
      await runCli('--source', SOURCE, '--apply', '--plan', PLAN_FILE),
    ).toBe(1);

    expect(printed(error)).toContain('A fresh plan is not the plan in p.json');
    expect(printed(log)).not.toContain('Wrote');
    // No query succeeded, so no database is named from DATABASE_URL: the
    // error message is all there is.
    expect(printed(log)).not.toContain('Database');
    expect(exit).not.toHaveBeenCalled();
  });
});
