// @vitest-environment node

/**
 * The thin CLI, scripts/backfill-snapshot-event-flags.ts: it runs `main()` on
 * import, so each case sets argv, imports it fresh and waits for its
 * `process.exit`. The module boundaries are mocked with `vi.mock` (dotenv, the
 * env-file lookup and `runBackfill`), so no env file is read and no database,
 * FRED or Finnhub is reached. The real `parseArgs`, `dbHost`, `USAGE` and
 * `formatReport` run.
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
// `runBackfill` is mocked, so nothing here fetches. The stub keeps the real
// module, with its Sentry and Redis clients, out of every fresh import.
vi.mock('../../api/_lib/market-events.js', () => ({
  fetchMarketEvents: vi.fn(),
  eventNamesForSnapshot: vi.fn(),
}));
vi.mock('./snapshot-event-flag-backfill.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('./snapshot-event-flag-backfill.js')
  >()),
  runBackfill,
}));

import { buildPlan } from './snapshot-event-flag-backfill.js';

const CLEAN_RESULT = {
  plan: buildPlan({
    snapshots: [],
    features: [],
    namesByDate: new Map(),
    keepEarnings: false,
  }),
  months: [],
  apply: false,
  keepEarnings: false,
  undoFile: null,
  outcome: null,
};

const originalArgv = process.argv;
const originalDatabaseUrl = process.env.DATABASE_URL;

let log: MockInstance<typeof console.log>;
let error: MockInstance<typeof console.error>;
let exit: MockInstance<typeof process.exit>;

beforeEach(() => {
  config.mockReset();
  resolveEnvFile.mockReset().mockReturnValue('/resolved/.env.local');
  runBackfill.mockReset().mockResolvedValue(CLEAN_RESULT);
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
  process.argv = ['node', 'backfill-snapshot-event-flags.ts', ...args];
  await import('../backfill-snapshot-event-flags.js');
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  return exit.mock.calls[0]?.[0];
}

const printed = (spy: MockInstance<typeof console.log>): string =>
  spy.mock.calls.map((call) => String(call[0])).join('\n');

const UNDO_DIR = 'docs/tmp/snapshot-event-flags';

describe('backfill-snapshot-event-flags CLI', () => {
  // Each case imports the CLI afresh, and every fresh import adds a process
  // 'beforeExit' listener (the logger). Past 10 imports in one file Node warns
  // about a leak, so related checks share a case.

  it('is a dry run when no flag is given, and prints the host and report, never the credentials', async () => {
    expect(await runCli()).toBe(0);

    expect(runBackfill).toHaveBeenCalledTimes(1);
    expect(runBackfill).toHaveBeenCalledWith({
      apply: false,
      keepEarnings: false,
      undoDir: UNDO_DIR,
    });
    const out = printed(log);
    expect(out).toContain('Database host: ep-test-1.neon.tech');
    expect(out).toContain('Snapshot event-flag backfill: DRY RUN');
    expect(out).not.toContain('s3cret');
    expect(out).not.toContain('owner');
  });

  it('is a dry run with --dry-run', async () => {
    expect(await runCli('--dry-run')).toBe(0);

    expect(runBackfill).toHaveBeenCalledWith(
      expect.objectContaining({ apply: false }),
    );
  });

  it('forwards --apply and --keep-earnings, and loads the env file --env-file names', async () => {
    expect(
      await runCli(
        '--apply',
        '--keep-earnings',
        '--env-file',
        'other/.env.local',
      ),
    ).toBe(0);

    expect(runBackfill).toHaveBeenCalledTimes(1);
    expect(runBackfill).toHaveBeenCalledWith({
      apply: true,
      keepEarnings: true,
      undoDir: UNDO_DIR,
    });
    expect(resolveEnvFile).toHaveBeenCalledWith('other/.env.local', '.');
    expect(config).toHaveBeenCalledWith({
      path: '/resolved/.env.local',
      quiet: true,
    });
  });

  it('prints the usage for --help and exits 0 without loading env or running', async () => {
    expect(await runCli('--apply', '--help')).toBe(0);

    const out = printed(log);
    expect(out).toContain(
      'Usage: npx tsx scripts/backfill-snapshot-event-flags.ts',
    );
    expect(out).toContain('--keep-earnings');
    expect(out).not.toContain('Database host');
    expect(resolveEnvFile).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(runBackfill).not.toHaveBeenCalled();
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

  it('exits 1 and says why when the backfill refuses', async () => {
    runBackfill.mockRejectedValue(
      new Error('Refusing to run. FINNHUB_API_KEY is not set: ...'),
    );

    expect(await runCli('--apply')).toBe(1);

    expect(printed(error)).toMatch(/FINNHUB_API_KEY is not set/);
  });
});
