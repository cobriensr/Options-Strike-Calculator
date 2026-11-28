/**
 * The backup folder of the SPX/NDX candle repair CLIs
 * (scripts/repair-index-candle-placeholders.mjs and scripts/rebuild-backup.mjs),
 * found through git. Its own module, not a function of index-candle-repair.mjs
 * beside defaultBackupDir: that file, and every pglite test that reaches it,
 * stays free of the git runner (and so of the `spawn` test group in
 * vite.config.ts).
 */

import { git } from './git-run.mjs';
import { defaultBackupDir } from './index-candle-repair.mjs';

/**
 * The main checkout's backup folder (docs/tmp/spx-candle-repair/), found
 * through git from `startDir`, a folder inside this checkout or one of its
 * worktrees (the CLIs pass their own, scripts/). Run from a worktree it still
 * names the main checkout: the backups live there, in a gitignored folder that
 * outlives the worktree.
 *
 * Throws a GitError when git cannot run in `startDir` or it is in no
 * repository, and an Error when the repository's common dir is not a `.git`
 * (see mainCheckoutDir). A CLI calls it before any read or write, so a
 * worktree with no git in reach never gets as far as a backup in the wrong
 * place.
 *
 * @param {string} startDir
 * @returns {string}
 */
export function backupDirFromGit(startDir) {
  const out = git(
    ['-C', startDir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    process.env,
  );
  return defaultBackupDir(out);
}
