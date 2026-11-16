// @vitest-environment node

/**
 * The thin CLI, scripts/backfill-ticker-flow-at-fire.ts: it runs `main()` on
 * import, so each case sets argv, imports it fresh and waits for its
 * `process.exit`. The module boundaries are mocked with `vi.mock` (dotenv, the
 * env-file lookup, `getDb` and `runBackfill`), so no env file is read and no
 * database is reached. The real `parseArgs`, `USAGE`, `dbHost` and
 * `formatSummary` run. The SQL behaviour is in
 * ticker-flow-backfill-pglite.test.ts.
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
vi.mock('../../api/_lib/db.js', () => ({ getDb: vi.fn(() => 'sql') }));
vi.mock('./ticker-flow-backfill.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ticker-flow-backfill.js')>()),
  runBackfill,
}));

const SUMMARY = {
  groups: 3,
  emptyGroups: 1,
  lotteryUpdated: 40,
  silentUpdated: 2,
  leftNullEmptySeries: 5,
  leftNullPreSeries: 1,
};

const originalArgv = process.argv;
const originalDatabaseUrl = process.env.DATABASE_URL;

let log: MockInstance<typeof console.log>;
let error: MockInstance<typeof console.error>;
let exit: MockInstance<typeof process.exit>;

beforeEach(() => {
  config.mockReset();
  resolveEnvFile.mockReset().mockReturnValue('/resolved/.env.local');
  runBackfill.mockReset().mockResolvedValue(SUMMARY);
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
  process.argv = ['node', 'backfill-ticker-flow-at-fire.ts', ...args];
  await import('../backfill-ticker-flow-at-fire.js');
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  return exit.mock.calls[0]?.[0];
}

const printed = (spy: MockInstance<typeof console.log>): string =>
  spy.mock.calls.map((call) => String(call[0])).join('\n');

describe('backfill-ticker-flow-at-fire CLI', () => {
  it('runs the backfill with the options it was given, prints the host and the summary, never the credentials', async () => {
    expect(
      await runCli('--date', '2026-11-13', '--table', 'lottery', '--dry-run'),
    ).toBe(0);

    expect(runBackfill).toHaveBeenCalledTimes(1);
    expect(runBackfill.mock.calls[0]?.[0]).toBe('sql');
    expect(runBackfill.mock.calls[0]?.[1]).toMatchObject({
      table: 'lottery',
      date: '2026-11-13',
      ticker: null,
      limit: 0,
      dryRun: true,
    });
    expect(resolveEnvFile).toHaveBeenCalledWith(null, '.');
    expect(config).toHaveBeenCalledWith({
      path: '/resolved/.env.local',
      quiet: true,
    });
    const out = printed(log);
    expect(out).toContain('Database host: ep-test-1.neon.tech');
    expect(out).toContain('Lottery rows updated:    40 (dry-run)');
    expect(out).not.toContain('s3cret');
    expect(error).not.toHaveBeenCalled();
  });

  it('prints one progress line per group', async () => {
    runBackfill.mockImplementation(
      async (
        _sql: unknown,
        _opts: unknown,
        onGroup: (g: unknown, i: number, n: number) => void,
      ) => {
        onGroup({ ticker: 'META', date: '2026-11-13', nRows: 4 }, 0, 2);
        return SUMMARY;
      },
    );

    expect(await runCli()).toBe(0);

    expect(printed(log)).toContain(
      '[1/2] META 2026-11-13 (4 rows across both tables)',
    );
  });

  it('prints the usage for --help, and exits 0 without loading env or running', async () => {
    expect(await runCli('--help')).toBe(0);

    expect(printed(log)).toContain(
      'Usage: npx tsx scripts/backfill-ticker-flow-at-fire.ts',
    );
    expect(resolveEnvFile).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(runBackfill).not.toHaveBeenCalled();
  });

  it('rejects a bad argument with exit 1 before loading any env or touching the database', async () => {
    expect(await runCli('--table', 'nope')).toBe(1);

    expect(printed(error)).toContain('--table must be one of');
    expect(config).not.toHaveBeenCalled();
    expect(runBackfill).not.toHaveBeenCalled();
  });

  it('exits 1 with the database error when the backfill fails', async () => {
    runBackfill.mockRejectedValue(new Error('connection lost'));

    expect(await runCli()).toBe(1);

    expect(printed(error)).toContain('connection lost');
  });
});
