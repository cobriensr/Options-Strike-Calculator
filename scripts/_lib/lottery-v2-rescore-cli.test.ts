// @vitest-environment node

/**
 * The thin CLI, scripts/rescore-lottery-v2-after-flow-backfill.ts: it runs
 * `main()` on import, so each case sets argv, imports it fresh and waits for
 * its `process.exit`. The module boundaries are mocked with `vi.mock` (dotenv,
 * the env-file lookup, the weights loader and `runRescore`), so no env file is
 * read and no database or weights store is reached. The real `parseArgs`,
 * `USAGE`, `dbHost` and `formatReport` run. The pure and SQL behaviour is in
 * lottery-v2-rescore.test.ts and lottery-v2-rescore-pglite.test.ts.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import { warmCliImport } from './cli-warm-import.js';

const { config, resolveEnvFile, runRescore } = vi.hoisted(() => ({
  config: vi.fn(),
  resolveEnvFile: vi.fn(),
  runRescore: vi.fn(),
}));

vi.mock('dotenv', () => ({ config }));
vi.mock('./anchor-backfill.js', () => ({ resolveEnvFile }));
// `runRescore` is mocked, so nothing here loads weights. The stub keeps the
// loader, with its logger and Sentry client, out of every fresh import.
vi.mock('../../api/_lib/lottery-weights-loader.js', () => ({
  loadLotteryWeights: vi.fn(),
}));
vi.mock('./lottery-v2-rescore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lottery-v2-rescore.js')>()),
  runRescore,
}));

import type { RescoreResult } from './lottery-v2-rescore.js';

const PLAN: RescoreResult['plan'] = {
  examined: 51_300,
  toScore: 968,
  stayNull: 50_332,
  unscorable: 0,
  byDate: new Map([['2026-11-13', 968]]),
  byPreviousVersion: new Map([[null, 968]]),
};

const DRY_RESULT: RescoreResult = {
  apply: false,
  since: '2026-10-29',
  version: 'seed-2026-06-17',
  before: { nullScoreWithFlow: 51_300, nullScoreNoFlow: 23, scored: 45_512 },
  after: { nullScoreWithFlow: 50_332, nullScoreNoFlow: 23, scored: 46_480 },
  plan: PLAN,
  written: 0,
  undoFile: null,
};

const APPLY_RESULT: RescoreResult = {
  ...DRY_RESULT,
  apply: true,
  written: 968,
  undoFile: 'docs/tmp/lottery-v2-rescore/undo-x.json',
};

const UNDO_DIR = 'docs/tmp/lottery-v2-rescore';

const originalArgv = process.argv;
const originalDatabaseUrl = process.env.DATABASE_URL;

let log: MockInstance<typeof console.log>;
let error: MockInstance<typeof console.error>;
let exit: MockInstance<typeof process.exit>;

// The first import of the CLI transforms its module graph (15 to 19 s under
// load); pay that here, under this hook's timeout, not in the first test's 15 s.
beforeAll(
  () =>
    warmCliImport(() => import('../rescore-lottery-v2-after-flow-backfill.js')),
  120_000,
);

beforeEach(() => {
  config.mockReset();
  resolveEnvFile.mockReset().mockReturnValue('/resolved/.env.local');
  runRescore.mockReset().mockResolvedValue(DRY_RESULT);
  process.env.DATABASE_URL = 'postgres://owner:s3cret@ep-test-1.neon.tech/db';
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  exit = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
});

afterEach(() => {
  process.argv = originalArgv;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  vi.restoreAllMocks();
});

/** Run the CLI with these arguments and return the exit code it asked for. */
async function runCli(...args: string[]): Promise<unknown> {
  vi.resetModules();
  process.argv = ['node', 'rescore-lottery-v2-after-flow-backfill.ts', ...args];
  await import('../rescore-lottery-v2-after-flow-backfill.js');
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  return exit.mock.calls[0]?.[0];
}

const printed = (spy: MockInstance<typeof console.log>): string =>
  spy.mock.calls.map((call) => String(call[0])).join('\n');

describe('rescore-lottery-v2-after-flow-backfill CLI', () => {
  // Each case imports the CLI afresh. Keep this file to 9 CLI imports or fewer:
  // past 10 fresh imports in one file Node warns about a listener leak.

  it('is a dry run when only --since is given, and prints the host and report, never the credentials', async () => {
    expect(await runCli('--since', '2026-10-29')).toBe(0);

    expect(runRescore).toHaveBeenCalledTimes(1);
    expect(runRescore).toHaveBeenCalledWith({
      apply: false,
      since: '2026-10-29',
      undoDir: UNDO_DIR,
    });
    // The env file is looked up from the working directory and loaded quietly.
    expect(resolveEnvFile).toHaveBeenCalledWith(null, '.');
    expect(config).toHaveBeenCalledWith({
      path: '/resolved/.env.local',
      quiet: true,
    });
    const out = printed(log);
    expect(out).toContain('Database host: ep-test-1.neon.tech');
    expect(out).toContain('DRY RUN: nothing was written');
    expect(out).not.toContain('s3cret');
    expect(out).not.toContain('owner');
    expect(error).not.toHaveBeenCalled();
  });

  it('forwards --apply, loads the env file --env-file names, and prints the rows written and the undo file', async () => {
    runRescore.mockResolvedValue(APPLY_RESULT);

    expect(
      await runCli(
        '--since',
        '2026-10-29',
        '--apply',
        '--env-file',
        'other/.env.local',
      ),
    ).toBe(0);

    expect(runRescore).toHaveBeenCalledTimes(1);
    expect(runRescore).toHaveBeenCalledWith({
      apply: true,
      since: '2026-10-29',
      undoDir: UNDO_DIR,
    });
    expect(resolveEnvFile).toHaveBeenCalledWith('other/.env.local', '.');
    expect(config).toHaveBeenCalledWith({
      path: '/resolved/.env.local',
      quiet: true,
    });
    const out = printed(log);
    expect(out).toContain('APPLY: scores were written.');
    expect(out).toContain('Rows written: 968');
    expect(out).toContain(`Undo file: ${APPLY_RESULT.undoFile}`);
    expect(error).not.toHaveBeenCalled();
  });

  it('prints the usage for --help without a date, and exits 0 without loading env or running', async () => {
    expect(await runCli('--help')).toBe(0);

    const out = printed(log);
    expect(out).toContain(
      'Usage: npx tsx scripts/rescore-lottery-v2-after-flow-backfill.ts',
    );
    // The help names the floor the run enforces.
    expect(out).toContain('not before');
    expect(out).toContain('2026-09-08');
    expect(out).not.toContain('Database host');
    expect(resolveEnvFile).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(runRescore).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    [
      ['--since', '2026-09-07'],
      /--since 2026-09-07 is before 2026-09-08, the first day the seed weights were live/,
    ],
    [
      ['--since', '2026-10-29', '--apply', '--dry-run'],
      /--apply and --dry-run contradict/,
    ],
    [['--apply'], /--since YYYY-MM-DD is required/],
  ])(
    'rejects %j with exit 1 before loading any env or touching the database',
    async (args, message) => {
      expect(await runCli(...args)).toBe(1);

      expect(printed(error)).toMatch(message);
      expect(printed(log)).not.toContain('Database host');
      expect(resolveEnvFile).not.toHaveBeenCalled();
      expect(config).not.toHaveBeenCalled();
      expect(runRescore).not.toHaveBeenCalled();
    },
  );

  it('exits 1 without running when the env file cannot be found', async () => {
    resolveEnvFile.mockImplementation(() => {
      throw new Error('--env-file nope not found');
    });

    expect(await runCli('--since', '2026-10-29', '--apply')).toBe(1);

    expect(printed(error)).toMatch(/--env-file nope not found/);
    expect(config).not.toHaveBeenCalled();
    expect(runRescore).not.toHaveBeenCalled();
  });

  it('exits 1 and prints the failure in full, with no report, when the run fails', async () => {
    runRescore.mockRejectedValue(
      new Error(
        'the weights store could not be read (transient: connection lost), so the active version is not known. Nothing was read or written.',
      ),
    );

    expect(await runCli('--since', '2026-10-29', '--apply')).toBe(1);

    expect(printed(error)).toContain(
      'the weights store could not be read (transient: connection lost)',
    );
    // A failed run prints no report, so it cannot read as a finished one.
    expect(printed(log)).not.toContain('APPLY:');
    expect(printed(log)).not.toContain('DRY RUN');
  });
});
