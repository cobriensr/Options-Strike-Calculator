import { expect, vi } from 'vitest';

/**
 * Import a script that runs `main()` as it loads, once, ahead of the tests that
 * import it fresh. For a CLI test's `beforeAll`.
 *
 * Why: the first import of such a script transforms its whole module graph
 * (15 to 19 s on a loaded machine, 1.2 to 1.8 s on an idle one), and a test's
 * body has 15 s. The transform cache outlives `vi.resetModules()`, so once one
 * import has paid, each later fresh import takes about 15 ms. Paying in a hook
 * puts the cost under the hook's own timeout instead of the first test's.
 *
 * The script runs for real here, so `process.exit` and the console are stubbed
 * and `--help` is its only argument: it exits at once on that, or on the bad
 * argument it takes `--help` for, before it reads an env file or touches a
 * database. `importCli` is `() => import('../the-script.js')`.
 */
export async function warmCliImport(
  importCli: () => Promise<unknown>,
): Promise<void> {
  const argv = process.argv;
  const exit = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    process.argv = ['node', 'cli.ts', '--help'];
    await importCli();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled(), 30_000);
  } finally {
    process.argv = argv;
    exit.mockRestore();
    log.mockRestore();
    error.mockRestore();
  }
}
