// @vitest-environment node

/**
 * scripts/backfill-lottery-score.ts refuses to run: it fills every NULL score
 * with the V1 scorer and leaves `score_version` alone, so under the weights
 * store it would write a V1 score under a store version's tag. It runs on
 * import, so each case sets argv, imports it fresh and waits for its
 * `process.exit`. `process.exit` is made to throw, because the real one stops
 * the process and the module must stop at the same place. The module boundaries
 * (dotenv, the Neon client) are mocked with `vi.mock`, so the test can see that
 * neither was touched: no env file is read and no database is reached.
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

const { config, neon } = vi.hoisted(() => ({
  config: vi.fn(),
  neon: vi.fn(),
}));

vi.mock('dotenv', () => ({ config }));
vi.mock('@neondatabase/serverless', () => ({ neon }));

class ExitCalled extends Error {
  constructor(readonly code: unknown) {
    super(`process.exit(${String(code)})`);
  }
}

const DATABASE_URL = 'postgres://owner:s3cret@ep-test-1.neon.tech/db';
const originalArgv = process.argv;
const originalDatabaseUrl = process.env.DATABASE_URL;

let error: MockInstance<typeof console.error>;
let exit: MockInstance<typeof process.exit>;

beforeEach(() => {
  config.mockReset();
  neon.mockReset();
  process.env.DATABASE_URL = DATABASE_URL;
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  exit = vi.spyOn(process, 'exit').mockImplementation(((code?: unknown) => {
    throw new ExitCalled(code);
  }) as never);
});

afterEach(() => {
  process.argv = originalArgv;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  vi.restoreAllMocks();
});

/** Import the script as `npx tsx scripts/backfill-lottery-score.ts <args>` would run it. */
async function runScript(...args: string[]): Promise<unknown> {
  vi.resetModules();
  process.argv = ['node', 'backfill-lottery-score.ts', ...args];
  return import('../backfill-lottery-score.js');
}

describe('backfill-lottery-score CLI', () => {
  it.each([[[]], [['--dry-run']]])(
    'refuses with exit code 1 (args: %j)',
    async (args: string[]) => {
      await expect(runScript(...args)).rejects.toMatchObject({ code: 1 });

      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    },
  );

  it('says why and names its replacement', async () => {
    await expect(runScript()).rejects.toBeInstanceOf(ExitCalled);

    expect(error).toHaveBeenCalledTimes(1);
    const message = String(error.mock.calls[0]?.[0]);
    expect(message).toContain('predates the versioned lottery weights store');
    expect(message).toContain('scripts/backfill_lottery_scores.py');
  });

  it('refuses before it reads the env file or opens a database client', async () => {
    await expect(runScript()).rejects.toBeInstanceOf(ExitCalled);

    expect(config).not.toHaveBeenCalled();
    expect(neon).not.toHaveBeenCalled();
    // And it does not echo the connection string it was given.
    const printed = error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).not.toContain('s3cret');
    expect(printed).not.toContain('ep-test-1');
  });

  it('refuses with no database url set as well', async () => {
    delete process.env.DATABASE_URL;

    await expect(runScript()).rejects.toMatchObject({ code: 1 });

    // The refusal, not "Missing DATABASE_URL": it comes first.
    expect(String(error.mock.calls[0]?.[0])).toContain('refused');
  });
});
