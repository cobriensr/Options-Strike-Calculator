// @vitest-environment node

/**
 * The thin CLI, scripts/backfill-regime-0dte.ts: it runs on import, so each case
 * sets argv, imports it fresh and waits for its `process.exit`. The backfill is
 * mocked at its module, so no database is reached.
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

const { runRegimeBackfill } = vi.hoisted(() => ({
  runRegimeBackfill: vi.fn(),
}));

vi.mock('./regime-0dte-backfill.js', () => ({ runRegimeBackfill }));

const originalArgv = process.argv;

let error: MockInstance<typeof console.error>;
let exit: MockInstance<typeof process.exit>;

beforeEach(() => {
  runRegimeBackfill.mockReset().mockResolvedValue(0);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  exit = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

/** Run the CLI with these arguments and return the exit code it asked for. */
async function runCli(...args: string[]): Promise<unknown> {
  vi.resetModules();
  process.argv = ['node', 'backfill-regime-0dte.ts', ...args];
  await import('../backfill-regime-0dte.js');
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  return exit.mock.calls[0]?.[0];
}

describe('backfill-regime-0dte CLI', () => {
  it('hands its flags to the backfill and exits with its code', async () => {
    runRegimeBackfill.mockResolvedValue(2);

    expect(await runCli('--from', '2026-09-21', '--to', '2026-09-21')).toBe(2);

    expect(runRegimeBackfill).toHaveBeenCalledWith([
      '--from',
      '2026-09-21',
      '--to',
      '2026-09-21',
    ]);
  });

  it('exits 0 when the backfill does, passing no flags for a plain run', async () => {
    expect(await runCli()).toBe(0);

    expect(runRegimeBackfill).toHaveBeenCalledTimes(1);
    expect(runRegimeBackfill).toHaveBeenCalledWith([]);
  });

  it('exits 1 and says why when the backfill rejects', async () => {
    runRegimeBackfill.mockRejectedValue(new Error('boom'));

    expect(await runCli('--apply')).toBe(1);

    expect(String(error.mock.calls[0]?.[0])).toMatch(/boom/);
  });
});
