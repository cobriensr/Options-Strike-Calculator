// @vitest-environment node

/**
 * The thin CLI, scripts/backfill-market-internals.ts: it runs `main()` on
 * import, so each case sets argv, imports it fresh and waits for its
 * `process.exit`. The module boundaries are mocked with `vi.mock` (dotenv, the
 * env-file lookup, the Schwab token module, Upstash and `runBackfill`), so no
 * env file is read and neither Neon, Upstash nor Schwab is reached. The real
 * `parseArgs`, `resolveSessions` and `formatReport` run.
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

const {
  config,
  resolveEnvFile,
  runBackfill,
  schwabCronsBusyRefusal,
  readSchwabEnv,
  getSchwabAccessToken,
  RedisCtor,
} = vi.hoisted(() => ({
  config: vi.fn(),
  resolveEnvFile: vi.fn(),
  runBackfill: vi.fn(),
  schwabCronsBusyRefusal: vi.fn(),
  readSchwabEnv: vi.fn(),
  getSchwabAccessToken: vi.fn(),
  RedisCtor: vi.fn(),
}));

vi.mock('dotenv', () => ({ config }));
vi.mock('@upstash/redis', () => ({ Redis: RedisCtor }));
vi.mock('./anchor-backfill.js', () => ({ resolveEnvFile }));
vi.mock('./schwab-local.mjs', () => ({
  schwabCronsBusyRefusal,
  readSchwabEnv,
  getSchwabAccessToken,
}));
vi.mock('./market-internals-backfill.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./market-internals-backfill.js')>()),
  runBackfill,
}));

const originalArgv = process.argv;
const originalDatabaseUrl = process.env.DATABASE_URL;

let log: MockInstance<typeof console.log>;
let error: MockInstance<typeof console.error>;
let exit: MockInstance<typeof process.exit>;

const CLEAN_REPORT = {
  apply: false,
  sessions: ['2026-11-05', '2026-11-06'],
  days: [
    {
      date: '2026-11-05',
      inserted: 1,
      updated: 2,
      unchanged: 3,
      rejectedZero: 0,
      problems: [],
    },
    {
      date: '2026-11-06',
      inserted: 0,
      updated: 0,
      unchanged: 6,
      rejectedZero: 0,
      problems: [],
    },
  ],
  failures: [],
};

beforeEach(() => {
  config.mockReset();
  resolveEnvFile.mockReset().mockReturnValue('/resolved/.env.local');
  runBackfill.mockReset().mockResolvedValue(CLEAN_REPORT);
  schwabCronsBusyRefusal.mockReset().mockReturnValue(null);
  readSchwabEnv.mockReset().mockReturnValue({
    problem: null,
    redisUrl: 'https://redis.example',
    redisToken: 'redis-token',
    clientId: 'client-id',
    clientSecret: 'client-secret',
  });
  getSchwabAccessToken.mockReset().mockResolvedValue('access-token');
  RedisCtor.mockReset();
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
  process.argv = ['node', 'backfill-market-internals.ts', ...args];
  await import('../backfill-market-internals.js');
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  return exit.mock.calls[0]?.[0];
}

describe('backfill-market-internals CLI', () => {
  it('is a dry run by default: no --apply reaches runBackfill, the report is printed, exit 0', async () => {
    const code = await runCli();

    expect(code).toBe(0);
    expect(runBackfill).toHaveBeenCalledTimes(1);
    const opts = runBackfill.mock.calls[0]![0] as {
      apply: boolean;
      sessions: string[];
    };
    expect(opts.apply).toBe(false);
    // The cron's own window: five sessions.
    expect(opts.sessions).toHaveLength(5);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Database host: ep-test-1.neon.tech');
    expect(printed).toContain('DRY RUN: nothing was written');
    // The credentials in DATABASE_URL are never printed.
    expect(printed).not.toContain('s3cret');
  });

  it('--apply is passed through', async () => {
    await runCli('--apply');
    expect((runBackfill.mock.calls[0]![0] as { apply: boolean }).apply).toBe(
      true,
    );
  });

  it('--from and --to set the window (trading days only)', async () => {
    await runCli('--from', '2026-10-26', '--to', '2026-10-30');
    expect(
      (runBackfill.mock.calls[0]![0] as { sessions: string[] }).sessions,
    ).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
    ]);
  });

  it('gives runBackfill a token source that asks Schwab with the Redis client and the app credentials', async () => {
    await runCli();

    const { getToken } = runBackfill.mock.calls[0]![0] as {
      getToken: () => Promise<string>;
    };
    await expect(getToken()).resolves.toBe('access-token');
    expect(RedisCtor).toHaveBeenCalledWith({
      url: 'https://redis.example',
      token: 'redis-token',
    });
    expect(getSchwabAccessToken).toHaveBeenCalledWith(
      RedisCtor.mock.instances[0],
      { clientId: 'client-id', clientSecret: 'client-secret' },
    );
  });

  it('refuses to start inside the Schwab crons window: exit 2, nothing else touched', async () => {
    schwabCronsBusyRefusal.mockReturnValue('Refusing to run on a weekday');

    const code = await runCli();

    expect(code).toBe(2);
    expect(error).toHaveBeenCalledWith('Refusing to run on a weekday');
    expect(runBackfill).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(RedisCtor).not.toHaveBeenCalled();
  });

  it('--allow-market-hours lets a market holiday through without asking the guard', async () => {
    schwabCronsBusyRefusal.mockReturnValue('Refusing to run on a weekday');

    const code = await runCli('--allow-market-hours');

    expect(code).toBe(0);
    expect(schwabCronsBusyRefusal).not.toHaveBeenCalled();
    expect(runBackfill).toHaveBeenCalledTimes(1);
  });

  it('exit 1 when a symbol failed, with the failure printed by name', async () => {
    runBackfill.mockResolvedValue({
      ...CLEAN_REPORT,
      failures: [
        { symbol: '$VOLD', failure: 'schwab_error', error: 'Schwab 403' },
      ],
    });

    const code = await runCli();

    expect(code).toBe(1);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('$VOLD schwab_error: Schwab 403');
  });

  it('exit 1 when DATABASE_URL is missing', async () => {
    delete process.env.DATABASE_URL;

    const code = await runCli();

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith('Missing DATABASE_URL');
    expect(runBackfill).not.toHaveBeenCalled();
  });

  it('exit 1 with the problem line when the Schwab or Redis settings are missing', async () => {
    readSchwabEnv.mockReturnValue({
      problem: 'Missing SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET',
      redisUrl: 'https://redis.example',
      redisToken: 'redis-token',
      clientId: undefined,
      clientSecret: undefined,
    });

    const code = await runCli();

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(
      'Missing SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET',
    );
    expect(runBackfill).not.toHaveBeenCalled();
  });

  it('exit 1 with the reason on a bad argument', async () => {
    const code = await runCli('--wat');

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith('unknown argument --wat');
    expect(runBackfill).not.toHaveBeenCalled();
  });

  it('exit 1 when runBackfill itself throws', async () => {
    runBackfill.mockRejectedValue(new Error('boom'));

    const code = await runCli();

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith('boom');
  });
});
