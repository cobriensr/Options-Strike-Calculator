// @vitest-environment node

/**
 * The thin CLI, scripts/repair-stale-opening-range.ts: it runs `main()` on
 * import, so each case sets argv, imports it fresh and waits for the exit code
 * it sets on `process.exitCode`. The CLI never calls `process.exit`, so stdout
 * is flushed before the process ends, which a pipe on Windows needs. The module
 * boundaries are mocked with `vi.mock` (dotenv, the env-file lookup, `runRepair`
 * and `runUndo`, the DB client and the build-features cron the plan imports),
 * so no env file is read and no database or history endpoint is reached. The
 * real `parseArgs`, `USAGE`, `dbHost`, `historyOrigin`, the reports and the exit
 * codes run. The pure and SQL behaviour is in stale-opening-range.test.ts and
 * stale-opening-range-pglite.test.ts.
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
// The runs are mocked, so nothing here reads the DB or the cron. The stubs
// keep both, with their Sentry and Redis clients, out of every fresh import.
vi.mock('../../api/_lib/db.js', () => ({
  getDb: vi.fn(),
  withDbRetry: vi.fn(),
}));
vi.mock('../../api/cron/build-features.js', () => ({
  pickFeatureSnapshot: vi.fn(),
  SNAPSHOT_TRUST_COLUMNS_SQL: 'is_backtest',
}));
vi.mock('./stale-opening-range.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./stale-opening-range.js')>()),
  runRepair,
  runUndo,
}));

import type {
  ApplyResult,
  DatePlan,
  RunResult,
  UndoResult,
} from './stale-opening-range.js';

const BACKUP_DIR = 'docs/tmp/stale-opening-range';
const BACKUP_FILE = `${BACKUP_DIR}/backup-2026-11-16-x.json`;

const repairedDate: DatePlan = {
  date: '2026-11-16',
  source: 'candles',
  rows: [
    {
      kind: 'repair',
      row: {
        id: 41,
        date: '2026-11-16',
        entryTime: '9:00 AM CT',
        slotCT: 540,
      },
      before: {
        high: '7170.52',
        low: '7130.33',
        consumed: '0.5000',
        signal: 'MODERATE',
      },
      after: {
        high: '7203.00',
        low: '7175.00',
        consumed: '0.4422',
        signal: 'MODERATE',
      },
      evidence: {
        source: 'candles',
        bars: [],
        spx: 7195,
        median: 0.88,
        asOf: { high: 7203, low: 7175 },
        band: { high: [7203, 7203], low: [7175, 7175] },
      },
    },
  ],
  feature: { kind: 'none' },
  previousClose: { expected: 7150, off: [] },
};

const PLAN_FILE = `${BACKUP_DIR}/dry-run-2026-11-16-x.json`;

const DRY_RESULT: RunResult = {
  apply: false,
  dates: [repairedDate],
  backupFile: null,
  planFile: PLAN_FILE,
  applied: null,
};

const APPLIED: ApplyResult = {
  backupFile: BACKUP_FILE,
  planned: 1,
  written: 1,
  changedSinceRead: [],
  featuresPlanned: 0,
  featuresWritten: 0,
};

const UNDO_RESULT: UndoResult = {
  apply: true,
  rows: 4,
  restored: 4,
  changedSince: [],
  features: 1,
  featuresRestored: 1,
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
  process.env.OWNER_SECRET = 's3cret-owner-value';
  process.env.APP_URL = 'https://app.example.test/';
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
  process.argv = ['node', 'repair-stale-opening-range.ts', ...args];
  await import('../repair-stale-opening-range.js');
  await vi.waitFor(() => expect(process.exitCode).not.toBeUndefined());
  const code = process.exitCode;
  process.exitCode = undefined;
  return code;
}

const printed = (spy: MockInstance<typeof console.log>): string =>
  spy.mock.calls.map((call) => String(call[0])).join('\n');

describe('repair-stale-opening-range CLI', () => {
  // Each case imports the CLI afresh. Keep this file to 9 CLI imports or fewer:
  // past 10 fresh imports in one file Node warns about a listener leak.

  it('is a dry run with no arguments: needs no APP_URL or OWNER_SECRET of its own, prints the database host and the plan file, never a credential', async () => {
    // Only a run that plans a date with candles reads the cookie settings, and
    // that is the library's check, not the CLI's.
    delete process.env.OWNER_SECRET;
    delete process.env.APP_URL;

    expect(await runCli()).toBe(0);

    expect(runRepair).toHaveBeenCalledTimes(1);
    expect(runRepair).toHaveBeenCalledWith({
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
    expect(out).toContain('Database host: ep-test-1.neon.tech');
    expect(out).toContain('DRY RUN');
    expect(out).toContain(`Plan file: ${PLAN_FILE}`);
    expect(out).toContain('id 41  2026-11-16 9:00 AM CT');
    expect(out).not.toContain('s3cret');
    expect(out).not.toContain('owner');
    expect(error).not.toHaveBeenCalled();
    // process.exit would cut a piped stdout short on Windows.
    expect(exit).not.toHaveBeenCalled();
  });

  it('forwards --since, --until and --env-file, and exits 1 after the whole report when a date’s history failed', async () => {
    runRepair.mockResolvedValue({
      ...DRY_RESULT,
      dates: [
        repairedDate,
        {
          date: '2026-11-17',
          source: 'skipped',
          skipped: 'history-failed',
          detail: 'HTTP 502 (schwab_fetch_failed)',
          rows: [],
          feature: { kind: 'none' },
          previousClose: null,
        },
      ],
    });

    expect(
      await runCli(
        '--since',
        '2026-11-01',
        '--until',
        '2026-11-30',
        '--env-file',
        'other/.env.local',
      ),
    ).toBe(1);

    expect(runRepair).toHaveBeenCalledWith(
      expect.objectContaining({ since: '2026-11-01', until: '2026-11-30' }),
    );
    expect(resolveEnvFile).toHaveBeenCalledWith('other/.env.local', '.');
    const out = printed(log);
    expect(out).toContain('Date skipped: 2026-11-17');
    expect(out).toContain('HTTP 502 (schwab_fetch_failed)');
    expect(error).not.toHaveBeenCalled();
  });

  it('applies the reviewed plan with --apply --plan --all, passing the confirmation on: prints the apply report and the backup file', async () => {
    runRepair.mockResolvedValue({
      apply: true,
      dates: [repairedDate],
      backupFile: BACKUP_FILE,
      planFile: PLAN_FILE,
      applied: APPLIED,
    });

    expect(await runCli('--apply', '--plan', PLAN_FILE, '--all')).toBe(0);

    // The no-argument dry run above pins the default, `all: false`.
    expect(runRepair).toHaveBeenCalledWith({
      date: null,
      since: null,
      until: null,
      apply: true,
      planFile: PLAN_FILE,
      all: true,
      backupDir: BACKUP_DIR,
    });
    const out = printed(log);
    expect(out).toContain('APPLY');
    expect(out).toContain('APPLIED: 1 of 1 planned rows written');
    expect(out).toContain(`Backup: ${BACKUP_FILE}`);
    expect(out).not.toContain('s3cret');
  });

  it('exits 1, naming the ids, when an apply wrote fewer rows than it planned', async () => {
    runRepair.mockResolvedValue({
      apply: true,
      dates: [repairedDate],
      backupFile: BACKUP_FILE,
      planFile: PLAN_FILE,
      applied: { ...APPLIED, written: 0, changedSinceRead: [41] },
    });

    expect(await runCli('--apply', '--plan', PLAN_FILE)).toBe(1);

    expect(printed(log)).toMatch(
      /Rows that changed since the read, so not written: 41/,
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('restores from a backup instead of repairing, needing no OWNER_SECRET and printing no history origin; exits 1 when it restored fewer rows than the file holds', async () => {
    delete process.env.OWNER_SECRET;
    delete process.env.APP_URL;
    runUndo.mockResolvedValue({
      ...UNDO_RESULT,
      restored: 3,
      changedSince: [5],
    });

    expect(await runCli('--undo-file', BACKUP_FILE, '--apply')).toBe(1);

    expect(runUndo).toHaveBeenCalledWith({ file: BACKUP_FILE, apply: true });
    expect(runRepair).not.toHaveBeenCalled();
    const out = printed(log);
    expect(out).toContain('UNDONE: 3 of 4 rows restored');
    expect(out).toContain('5');
    expect(out).not.toContain('History origin');
  });

  it('prints the usage for --help, and exits 0 without loading env or running', async () => {
    expect(await runCli('--help')).toBe(0);

    const out = printed(log);
    expect(out).toContain(
      'Usage: npx tsx scripts/repair-stale-opening-range.ts',
    );
    expect(out).toMatch(/NULL\s+median_hl_pct/);
    expect(out).not.toContain('Database host');
    expect(resolveEnvFile).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(runRepair).not.toHaveBeenCalled();
    expect(runUndo).not.toHaveBeenCalled();
  });

  it.each([
    [['--apply'], /Refusing to apply without --plan/],
    [['--apply', '--date', '2026-11-16'], /Refusing to apply without --plan/],
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
        'A fresh plan is not the plan in p.json. Nothing was written.\n  row 41: the new values differ',
      ),
    );

    expect(await runCli('--apply', '--plan', PLAN_FILE)).toBe(1);

    expect(printed(error)).toContain('A fresh plan is not the plan in p.json');
    expect(printed(log)).not.toContain('APPLIED');
    expect(exit).not.toHaveBeenCalled();
  });
});
