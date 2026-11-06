// @vitest-environment node

/**
 * The thin CLI, scripts/backfill-economic-event-labels.ts: it runs `main()` on
 * import, so each case sets argv, imports it fresh and waits for its
 * `process.exit`. The module boundaries are mocked with `vi.mock` (dotenv, the
 * env-file lookup and `runBackfill`), so no env file is read and no database
 * is reached. The real `parseArgs`, `dbHost` and `formatReport` run.
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

const { config, resolveEnvFile, runBackfill } = vi.hoisted(() => ({
  config: vi.fn(),
  resolveEnvFile: vi.fn(),
  runBackfill: vi.fn(),
}));

vi.mock('dotenv', () => ({ config }));
vi.mock('./anchor-backfill.js', () => ({ resolveEnvFile }));
vi.mock('./econ-label-backfill.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./econ-label-backfill.js')>()),
  runBackfill,
}));

import { buildPlan, type BackfillPlan } from './econ-label-backfill.js';

const CLEAN_PLAN: BackfillPlan = {
  ...buildPlan([], []),
  snapshotsMissed: { total: 0, matched: 0 },
  snapshotsWrong: { total: 0, matched: 0 },
  featuresEventDayMissed: { total: 0, matched: 0 },
  featuresEventDayWrong: { total: 0, matched: 0 },
  fires: { total: 0, matched: 0 },
};

const originalArgv = process.argv;
const originalDatabaseUrl = process.env.DATABASE_URL;

let log: MockInstance<typeof console.log>;
let error: MockInstance<typeof console.error>;
let exit: MockInstance<typeof process.exit>;

beforeEach(() => {
  config.mockReset();
  resolveEnvFile.mockReset().mockReturnValue('/resolved/.env.local');
  runBackfill.mockReset().mockResolvedValue({
    plan: CLEAN_PLAN,
    apply: false,
    written: null,
  });
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
  process.argv = ['node', 'backfill-economic-event-labels.ts', ...args];
  await import('../backfill-economic-event-labels.js');
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  return exit.mock.calls[0]?.[0];
}

const printed = (spy: MockInstance<typeof console.log>): string =>
  spy.mock.calls.map((call) => String(call[0])).join('\n');

describe('backfill-economic-event-labels CLI', () => {
  it('is a dry run when no flag is given', async () => {
    expect(await runCli()).toBe(0);

    expect(runBackfill).toHaveBeenCalledTimes(1);
    expect(runBackfill).toHaveBeenCalledWith({ apply: false });
  });

  it('is a dry run with --dry-run', async () => {
    expect(await runCli('--dry-run')).toBe(0);

    expect(runBackfill).toHaveBeenCalledWith({ apply: false });
  });

  it('forwards --apply', async () => {
    expect(await runCli('--apply')).toBe(0);

    expect(runBackfill).toHaveBeenCalledTimes(1);
    expect(runBackfill).toHaveBeenCalledWith({ apply: true });
  });

  it('loads the env file it resolves, and forwards --env-file to the lookup', async () => {
    await runCli('--env-file', 'other/.env.local');

    expect(resolveEnvFile).toHaveBeenCalledWith('other/.env.local', '.');
    expect(config).toHaveBeenCalledWith({
      path: '/resolved/.env.local',
      quiet: true,
    });
  });

  it('prints the database host and the report, never the credentials', async () => {
    await runCli();

    const out = printed(log);
    expect(out).toContain('Database host: ep-test-1.neon.tech');
    expect(out).toContain('Economic event label backfill: DRY RUN');
    expect(out).not.toContain('s3cret');
    expect(out).not.toContain('owner');
  });

  it.each([
    [['--bogus'], /unknown argument --bogus/],
    [['--apply', '--dry-run'], /--apply and --dry-run contradict/],
    [['--env-file'], /--env-file needs a value/],
  ])(
    'rejects %j before loading any env or touching the database',
    async (args, message) => {
      expect(await runCli(...args)).toBe(1);

      expect(printed(error)).toMatch(message);
      expect(config).not.toHaveBeenCalled();
      expect(runBackfill).not.toHaveBeenCalled();
    },
  );

  it('exits 1 without running when the env file cannot be found', async () => {
    resolveEnvFile.mockImplementation(() => {
      throw new Error('--env-file nope not found');
    });

    expect(await runCli('--apply')).toBe(1);

    expect(printed(error)).toMatch(/--env-file nope not found/);
    expect(runBackfill).not.toHaveBeenCalled();
  });

  it('exits 1 and says why when the backfill fails', async () => {
    runBackfill.mockRejectedValue(
      new Error(
        'economic_events read returned 0 rows; refusing to touch training_features',
      ),
    );

    expect(await runCli('--apply')).toBe(1);

    expect(printed(error)).toMatch(/refusing to touch training_features/);
  });
});
