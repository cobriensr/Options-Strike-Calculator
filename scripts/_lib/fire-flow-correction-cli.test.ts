// @vitest-environment node

/**
 * The thin CLI, scripts/correct-doubled-fire-flow.ts: it runs `main()` on
 * import, so each case sets argv, imports it fresh and waits for its
 * `process.exit`. The module boundaries are mocked with `vi.mock` (dotenv, the
 * env-file lookup, the weights loader, `runCorrection` and `runUndo`), so no
 * env file is read and no database or weights store is reached. The real
 * `parseArgs`, `USAGE`, `dbHost`, `formatReport` and `formatUndoReport` run.
 * The pure and SQL behaviour is in fire-flow-correction.test.ts and
 * fire-flow-correction-pglite.test.ts.
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

const { config, resolveEnvFile, runCorrection, runUndo } = vi.hoisted(() => ({
  config: vi.fn(),
  resolveEnvFile: vi.fn(),
  runCorrection: vi.fn(),
  runUndo: vi.fn(),
}));

vi.mock('dotenv', () => ({ config }));
vi.mock('./anchor-backfill.js', () => ({ resolveEnvFile }));
// The run is mocked, so nothing here loads weights. The stub keeps the loader,
// with its logger and Sentry client, out of every fresh import.
vi.mock('../../api/_lib/lottery-weights-loader.js', () => ({
  loadLotteryWeights: vi.fn(),
}));
vi.mock('./fire-flow-correction.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fire-flow-correction.js')>()),
  runCorrection,
  runUndo,
}));

import type { CorrectionResult, UndoResult } from './fire-flow-correction.js';

const DRY_RESULT: CorrectionResult = {
  apply: false,
  since: '2026-10-29',
  version: 'seed-2026-06-17',
  nullFlow: { lottery: 12, silentboom: 1 },
  plan: {
    scanned: { lottery: 100, silentboom: 10 },
    counts: {
      lottery: { correct: 70, doubled: 25, other: 5 },
      silentboom: { correct: 4, doubled: 5, other: 1 },
    },
    byDate: new Map([['2026-10-29', { correct: 74, doubled: 30, other: 6 }]]),
    otherReasons: new Map(),
    otherRows: [],
    toWrite: { lottery: 25, silentboom: 5 },
    score: new Map(),
    toUnaligned: [],
    toAligned: [],
  },
  written: { lottery: 0, silentboom: 0 },
  undoFile: null,
};

const APPLY_RESULT: CorrectionResult = {
  ...DRY_RESULT,
  apply: true,
  written: { lottery: 25, silentboom: 5 },
  undoFile: 'docs/tmp/fire-flow-correction/undo-x.json',
};

const UNDO_RESULT: UndoResult = {
  apply: true,
  file: 'undo-x.json',
  rows: { lottery: 25, silentboom: 5 },
  restored: { lottery: 25, silentboom: 5 },
};

const UNDO_DIR = 'docs/tmp/fire-flow-correction';

const originalArgv = process.argv;
const originalDatabaseUrl = process.env.DATABASE_URL;

let log: MockInstance<typeof console.log>;
let error: MockInstance<typeof console.error>;
let exit: MockInstance<typeof process.exit>;

beforeEach(() => {
  config.mockReset();
  resolveEnvFile.mockReset().mockReturnValue('/resolved/.env.local');
  runCorrection.mockReset().mockResolvedValue(DRY_RESULT);
  runUndo.mockReset().mockResolvedValue(UNDO_RESULT);
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
  process.argv = ['node', 'correct-doubled-fire-flow.ts', ...args];
  await import('../correct-doubled-fire-flow.js');
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  return exit.mock.calls[0]?.[0];
}

const printed = (spy: MockInstance<typeof console.log>): string =>
  spy.mock.calls.map((call) => String(call[0])).join('\n');

describe('correct-doubled-fire-flow CLI', () => {
  // Each case imports the CLI afresh. Keep this file to 9 CLI imports or fewer:
  // past 10 fresh imports in one file Node warns about a listener leak.

  it('is a dry run when only --since is given, and prints the host and report, never the credentials', async () => {
    expect(await runCli('--since', '2026-10-29')).toBe(0);

    expect(runCorrection).toHaveBeenCalledTimes(1);
    expect(runCorrection).toHaveBeenCalledWith({
      apply: false,
      since: '2026-10-29',
      undoDir: UNDO_DIR,
      listLimit: 200,
    });
    expect(runUndo).not.toHaveBeenCalled();
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

  it('forwards --apply, --list-limit and --env-file, and prints the rows written and the undo file', async () => {
    runCorrection.mockResolvedValue(APPLY_RESULT);

    expect(
      await runCli(
        '--since',
        '2026-10-29',
        '--apply',
        '--list-limit',
        '5',
        '--env-file',
        'other/.env.local',
      ),
    ).toBe(0);

    expect(runCorrection).toHaveBeenCalledWith({
      apply: true,
      since: '2026-10-29',
      undoDir: UNDO_DIR,
      listLimit: 5,
    });
    expect(resolveEnvFile).toHaveBeenCalledWith('other/.env.local', '.');
    const out = printed(log);
    expect(out).toContain('APPLY: corrected values were written.');
    expect(out).toContain('Rows written: lottery 25, silent boom 5');
    expect(out).toContain(`Undo file: ${APPLY_RESULT.undoFile}`);
  });

  it('restores from an undo file instead of correcting, and needs no --since', async () => {
    expect(await runCli('--undo-file', 'undo-x.json', '--apply')).toBe(0);

    expect(runUndo).toHaveBeenCalledWith({ file: 'undo-x.json', apply: true });
    expect(runCorrection).not.toHaveBeenCalled();
    expect(printed(log)).toContain('UNDO: old values were restored');
  });

  it('prints the usage for --help, and exits 0 without loading env or running', async () => {
    expect(await runCli('--help')).toBe(0);

    const out = printed(log);
    expect(out).toContain(
      'Usage: npx tsx scripts/correct-doubled-fire-flow.ts',
    );
    expect(out).toContain('2026-05-04');
    expect(out).not.toContain('Database host');
    expect(resolveEnvFile).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(runCorrection).not.toHaveBeenCalled();
    expect(runUndo).not.toHaveBeenCalled();
  });

  it.each([
    [
      ['--since', '2026-05-03'],
      /--since 2026-05-03 is before 2026-05-04, the first day the WS flow table has rows/,
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
      expect(config).not.toHaveBeenCalled();
      expect(runCorrection).not.toHaveBeenCalled();
    },
  );

  it('exits 1 with the message when the run fails, naming the undo file it wrote', async () => {
    runCorrection.mockRejectedValue(
      new Error(
        'connection lost. The apply did not complete. The undo file undo-x.json was written before it',
      ),
    );

    expect(await runCli('--since', '2026-10-29', '--apply')).toBe(1);

    expect(printed(error)).toContain('connection lost');
    expect(printed(error)).toContain('undo-x.json');
    expect(printed(log)).not.toContain('APPLY');
  });
});
