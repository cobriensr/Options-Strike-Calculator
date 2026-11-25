// @vitest-environment node

/**
 * The thin CLI, scripts/backfill-snapshot-price-context.ts: it runs `main()`
 * on import, so each case sets argv, imports it fresh and waits for the exit
 * code it sets on `process.exitCode`. The CLI never calls `process.exit`, so
 * stdout is flushed before the process ends, which a pipe on Windows needs.
 * The module boundaries are mocked with `vi.mock` (dotenv, the env-file
 * lookup, `runDryRun`, `runApply` and `runUndo`, the DB client and the
 * build-features cron the plan imports), so no env file is read and no
 * database or history endpoint is reached. The real `parseArgs`, `USAGE`,
 * `dbHost`, `historyOrigin`, the three reports and the three exit codes run.
 * The pure and SQL behaviour is in snapshot-price-context.test.ts and
 * snapshot-price-context-pglite.test.ts.
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

const { config, resolveEnvFile, runDryRun, runApply, runUndo } = vi.hoisted(
  () => ({
    config: vi.fn(),
    resolveEnvFile: vi.fn(),
    runDryRun: vi.fn(),
    runApply: vi.fn(),
    runUndo: vi.fn(),
  }),
);

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
}));
vi.mock('./snapshot-price-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./snapshot-price-context.js')>()),
  runDryRun,
  runApply,
  runUndo,
}));

import type {
  ApplyResult,
  DatePlan,
  DryRunResult,
  UndoResult,
} from './snapshot-price-context.js';

const UNDO_DIR = 'docs/tmp/snapshot-price-context';
const PLAN_FILE = `${UNDO_DIR}/dry-run-x.json`;

const okDate: DatePlan = {
  date: '2026-11-05',
  rows: [
    {
      id: 1,
      date: '2026-11-05',
      entry_time: 'pre-market',
      spx: null,
      spx_open: null,
      spx_high: null,
      spx_low: null,
      prev_close: null,
      overnight_gap: null,
      is_backtest: false,
      flag_reliable: true,
      missing_yesterday: false,
      saved_day_offset: 0,
      saved_minutes_ct: 510,
    },
  ],
  fetch: 'ok',
  fetchDetail: null,
  results: [{ kind: 'skip', id: 1, reason: 'no-slot' }],
  skippedDate: null,
  pickChange: null,
  previousClose: 7560.87,
  settlement: 7560.87,
};

const DRY_RESULT: DryRunResult = {
  since: null,
  until: '2026-11-17',
  dates: [okDate],
  untried: [],
  planFile: PLAN_FILE,
};

const FAILED_RESULT: DryRunResult = {
  ...DRY_RESULT,
  dates: [
    okDate,
    {
      ...okDate,
      date: '2026-11-03',
      fetch: 'failed',
      fetchDetail: 'HTTP 500',
      results: [],
      skippedDate: 'no-history',
      previousClose: null,
      settlement: null,
    },
  ],
};

const APPLY_RESULT: ApplyResult = {
  apply: true,
  file: PLAN_FILE,
  createdAt: '2026-11-18T17:00:00.000Z',
  since: null,
  until: '2026-11-17',
  summary: 'Planned 3 updates.',
  dbHost: 'ep-test-1.neon.tech',
  planned: 3,
  written: 3,
  alreadyAppliedIds: [],
  unwrittenIds: [],
  undoFile: `${UNDO_DIR}/undo-x.json`,
  reportFile: `${UNDO_DIR}/apply-x.json`,
  reportError: null,
  checkError: null,
};

const UNDO_RESULT: UndoResult = {
  apply: true,
  file: 'undo-x.json',
  rows: 4,
  restored: 4,
  changedIds: [],
};

const originalArgv = process.argv;
const originalEnv = { ...process.env };

let log: MockInstance<typeof console.log>;
let error: MockInstance<typeof console.error>;
let exit: MockInstance<typeof process.exit>;

beforeEach(() => {
  config.mockReset();
  resolveEnvFile.mockReset().mockReturnValue('/resolved/.env.local');
  runDryRun.mockReset().mockResolvedValue(DRY_RESULT);
  runApply.mockReset().mockResolvedValue(APPLY_RESULT);
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
  process.argv = ['node', 'backfill-snapshot-price-context.ts', ...args];
  await import('../backfill-snapshot-price-context.js');
  await vi.waitFor(() => expect(process.exitCode).not.toBeUndefined());
  const code = process.exitCode;
  process.exitCode = undefined;
  return code;
}

const printed = (spy: MockInstance<typeof console.log>): string =>
  spy.mock.calls.map((call) => String(call[0])).join('\n');

describe('backfill-snapshot-price-context CLI', () => {
  // Each case imports the CLI afresh. Keep this file to 9 CLI imports or fewer:
  // past 10 fresh imports in one file Node warns about a listener leak.

  it('is a dry run with no arguments: prints the database host and the history origin before it runs, never a credential', async () => {
    expect(await runCli()).toBe(0);

    expect(runDryRun).toHaveBeenCalledTimes(1);
    expect(runDryRun).toHaveBeenCalledWith({
      since: null,
      until: null,
      undoDir: UNDO_DIR,
    });
    expect(runApply).not.toHaveBeenCalled();
    expect(runUndo).not.toHaveBeenCalled();
    expect(resolveEnvFile).toHaveBeenCalledWith(null, '.');
    expect(config).toHaveBeenCalledWith({
      path: '/resolved/.env.local',
      quiet: true,
    });
    const out = printed(log);
    expect(out).toContain('Database host: ep-test-1.neon.tech');
    expect(out).toContain('History origin: app.example.test');
    expect(out).toContain('DRY RUN');
    expect(out).toContain(`Plan file: ${PLAN_FILE}`);
    expect(out).not.toContain('s3cret');
    expect(out).not.toContain('owner');
    // The origin is printed before the first fetch could happen.
    const originLine = log.mock.calls.findIndex((call) =>
      String(call[0]).startsWith('History origin:'),
    );
    expect(log.mock.invocationCallOrder[originLine]).toBeLessThan(
      runDryRun.mock.invocationCallOrder[0] ?? 0,
    );
    expect(error).not.toHaveBeenCalled();
    // process.exit would cut a piped stdout short on Windows.
    expect(exit).not.toHaveBeenCalled();
  });

  it('forwards --since, --until and --env-file, and exits 1 after the whole report when a history fetch failed', async () => {
    runDryRun.mockResolvedValue(FAILED_RESULT);

    expect(
      await runCli(
        '--since',
        '2026-05-01',
        '--until',
        '2026-11-05',
        '--env-file',
        'other/.env.local',
      ),
    ).toBe(1);

    expect(runDryRun).toHaveBeenCalledWith({
      since: '2026-05-01',
      until: '2026-11-05',
      undoDir: UNDO_DIR,
    });
    expect(resolveEnvFile).toHaveBeenCalledWith('other/.env.local', '.');
    const out = printed(log);
    expect(out).toContain('HTTP 500 (1 date): 2026-11-03');
    expect(out).toContain('DRY RUN');
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('applies a plan file with --apply --plan, needing no OWNER_SECRET and printing no history origin, and exits 0 for rows an earlier apply already wrote', async () => {
    delete process.env.OWNER_SECRET;
    delete process.env.APP_URL;
    runApply.mockResolvedValue({
      ...APPLY_RESULT,
      written: 1,
      alreadyAppliedIds: [8, 9],
    });

    expect(await runCli('--apply', '--plan', PLAN_FILE)).toBe(0);

    expect(runApply).toHaveBeenCalledWith({
      file: PLAN_FILE,
      apply: true,
      undoDir: UNDO_DIR,
    });
    expect(runDryRun).not.toHaveBeenCalled();
    const out = printed(log);
    expect(out).toContain('Database host: ep-test-1.neon.tech');
    expect(out).not.toContain('History origin');
    expect(out).toContain(`APPLY of ${PLAN_FILE}`);
    expect(out).toContain(`Undo file: ${APPLY_RESULT.undoFile}`);
    expect(out).toContain(`Apply report: ${APPLY_RESULT.reportFile}`);
    expect(out).toContain('Rows already applied');
    expect(out).not.toContain('s3cret');
  });

  it('exits 1 after printing the unwritten ids when an apply wrote fewer rows than it planned', async () => {
    runApply.mockResolvedValue({
      ...APPLY_RESULT,
      written: 2,
      unwrittenIds: [7],
    });

    expect(await runCli('--apply', '--plan', PLAN_FILE)).toBe(1);

    expect(printed(log)).toMatch(
      /1 planned row was not written: it did not match the plan's before values.*Ids: 7\./,
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('restores from an undo file instead of backfilling, and exits 1 when it restored fewer rows than the file holds', async () => {
    runUndo.mockResolvedValue({ ...UNDO_RESULT, restored: 3, changedIds: [5] });

    expect(await runCli('--undo-file', 'undo-x.json', '--apply')).toBe(1);

    expect(runUndo).toHaveBeenCalledWith({ file: 'undo-x.json', apply: true });
    expect(runDryRun).not.toHaveBeenCalled();
    expect(runApply).not.toHaveBeenCalled();
    const out = printed(log);
    expect(out).toContain('UNDO: old values were restored');
    expect(out).toMatch(/1 row no longer held.*: 5\./);
  });

  it('prints the usage for --help, and exits 0 without loading env or running', async () => {
    expect(await runCli('--help')).toBe(0);

    const out = printed(log);
    expect(out).toContain(
      'Usage: npx tsx scripts/backfill-snapshot-price-context.ts',
    );
    expect(out).toContain('--apply --plan');
    expect(out).not.toContain('Database host');
    expect(resolveEnvFile).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(runDryRun).not.toHaveBeenCalled();
    expect(runApply).not.toHaveBeenCalled();
    expect(runUndo).not.toHaveBeenCalled();
  });

  it.each([
    [['--apply'], /--apply needs --plan <dry-run file> or --undo-file <file>/],
    [
      ['--plan', 'p.json', '--since', '2026-11-05'],
      /--plan contradicts --since and --until/,
    ],
  ])(
    'rejects %j with exit 1 before loading any env or touching the database',
    async (args, message) => {
      expect(await runCli(...args)).toBe(1);

      expect(printed(error)).toMatch(message);
      expect(config).not.toHaveBeenCalled();
      expect(runDryRun).not.toHaveBeenCalled();
      expect(runApply).not.toHaveBeenCalled();
      expect(runUndo).not.toHaveBeenCalled();
    },
  );

  it('exits 1 with the message when the run fails, naming the undo file it wrote', async () => {
    runApply.mockRejectedValue(
      new Error(
        'connection lost. The apply did not complete: 2 of 4 planned rows were written before it failed. The undo file undo-x.json lists every planned row',
      ),
    );

    expect(await runCli('--apply', '--plan', PLAN_FILE)).toBe(1);

    expect(printed(error)).toContain('connection lost');
    expect(printed(error)).toContain('undo-x.json');
    expect(printed(log)).not.toContain('APPLY of');
    expect(exit).not.toHaveBeenCalled();
  });
});
