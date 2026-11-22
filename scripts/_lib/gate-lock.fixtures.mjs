/**
 * What the tests that run a holder of the gate lock in a child process share:
 * gate-lock.test.mjs (the holder that is killed hard) and
 * review-gate.cli.test.mjs (a holder for the CLI to queue behind). Not itself
 * a test file; vitest only collects *.test.mjs.
 */

/**
 * What a holder child runs: take the lock, say so, and stay alive holding it.
 * It is given the lock name URI-encoded (see holderArgv).
 */
export const HOLDER_SCRIPT = `
const [, encodedPipe, worktree, moduleUrl] = process.argv;
const pipeName = decodeURIComponent(encodedPipe);
const { acquireGateLock } = await import(moduleUrl);
await acquireGateLock({ pipeName, holder: { worktree }, onWait: () => {} });
console.log('held');
`;

/**
 * The arguments for `node` that run HOLDER_SCRIPT as an ES module, for the lock
 * `pipeName`, as `worktree`, with the lock library at `moduleUrl`.
 *
 * The lock name goes in URI-encoded, and the script decodes it. On Linux the
 * name is an abstract socket and starts with NUL, and spawn refuses a NUL in
 * any argument ("must be a string without null bytes"); an environment
 * variable cannot carry one either. The lock name is the fourth element of
 * the array returned.
 *
 * @param {string} pipeName
 * @param {string} worktree
 * @param {string} moduleUrl
 * @returns {string[]}
 */
export function holderArgv(pipeName, worktree, moduleUrl) {
  return [
    '--input-type=module',
    '-e',
    HOLDER_SCRIPT,
    encodeURIComponent(pipeName),
    worktree,
    moduleUrl,
  ];
}
