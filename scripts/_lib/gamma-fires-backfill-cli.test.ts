// @vitest-environment node

/**
 * The thin CLI, scripts/backfill-gamma-setup-fires.ts: it runs `main()` on
 * import, so each case sets argv and the env, imports it fresh and waits for
 * its `process.exit`. The module boundaries are mocked with `vi.mock` (dotenv,
 * the Neon client and `runGammaBackfill`), so no env file is read and no
 * database is reached.
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

const { config, neon, runGammaBackfill, fakeSql } = vi.hoisted(() => ({
  config: vi.fn(),
  neon: vi.fn(),
  runGammaBackfill: vi.fn(),
  fakeSql: Symbol('sql'),
}));

vi.mock('dotenv', () => ({ config }));
vi.mock('@neondatabase/serverless', () => ({ neon }));
vi.mock('./gamma-fires-backfill.js', () => ({ runGammaBackfill }));

const originalArgv = process.argv;
const originalEnv = {
  unpooled: process.env.DATABASE_URL_UNPOOLED,
  pooled: process.env.DATABASE_URL,
};

let error: MockInstance<typeof console.error>;
let exit: MockInstance<typeof process.exit>;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  config.mockReset();
  neon.mockReset().mockReturnValue(fakeSql);
  runGammaBackfill.mockReset().mockResolvedValue(0);
  process.env.DATABASE_URL = 'postgres://pooled.example/db';
  delete process.env.DATABASE_URL_UNPOOLED;
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  exit = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
});

afterEach(() => {
  process.argv = originalArgv;
  restoreEnv('DATABASE_URL_UNPOOLED', originalEnv.unpooled);
  restoreEnv('DATABASE_URL', originalEnv.pooled);
  vi.restoreAllMocks();
});

/** Run the CLI with these arguments and return the exit code it asked for. */
async function runCli(...args: string[]): Promise<unknown> {
  vi.resetModules();
  process.argv = ['node', 'backfill-gamma-setup-fires.ts', ...args];
  await import('../backfill-gamma-setup-fires.js');
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  return exit.mock.calls[0]?.[0];
}

describe('backfill-gamma-setup-fires CLI', () => {
  it('hands its flags and the DB handle to the backfill and exits with its code', async () => {
    runGammaBackfill.mockResolvedValue(2);

    expect(await runCli('--dry-run', '--from', '2026-04-14')).toBe(2);

    expect(runGammaBackfill).toHaveBeenCalledWith(
      ['--dry-run', '--from', '2026-04-14'],
      fakeSql,
    );
    expect(config).toHaveBeenCalledWith({ path: '.env.local' });
  });

  it('exits 0 when the backfill does', async () => {
    expect(await runCli('--context-only')).toBe(0);
  });

  it('opens the pooled URL when there is no unpooled one', async () => {
    await runCli();

    expect(neon).toHaveBeenCalledWith('postgres://pooled.example/db');
  });

  it('prefers DATABASE_URL_UNPOOLED, as the script always did', async () => {
    process.env.DATABASE_URL_UNPOOLED = 'postgres://direct.example/db';

    await runCli();

    expect(neon).toHaveBeenCalledWith('postgres://direct.example/db');
  });

  it('exits 1 without running when no database URL is set', async () => {
    delete process.env.DATABASE_URL;

    expect(await runCli('--dry-run')).toBe(1);

    expect(String(error.mock.calls[0]?.[0])).toMatch(
      /DATABASE_URL_UNPOOLED not set/,
    );
    expect(runGammaBackfill).not.toHaveBeenCalled();
  });

  it('exits 1 and says why when the backfill throws', async () => {
    runGammaBackfill.mockRejectedValue(new Error('boom'));

    expect(await runCli()).toBe(1);

    expect(String(error.mock.calls[0]?.[0])).toMatch(/boom/);
  });
});
