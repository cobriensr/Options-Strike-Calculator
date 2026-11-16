# Worktree auto-prune (2026-10-27)

## Goal

Remove a `.worktrees/` worktree automatically once its work is in `main`. Finished worktrees, each about 45k files with its own `node_modules`, stop piling up inside the VS Code workspace.

## Background

On 2026-10-27, `.worktrees/` held 35 worktrees: 1.56M files, 26 GB. VS Code logged the extension host as unresponsive 914 times this month. Its profiler blamed Auto Import, Todo Tree and Import Cost, which scan every TypeScript file in the open folder, including all of the worktrees. The Claude Code extension shares that extension host, so its panel froze.

Sessions create worktrees with `git worktree add .worktrees/<name> -b <branch> origin/main`. They then cherry-pick the finished commits onto `main` and never remove the worktree.

## Phases

1. **Prune script, tests and npm script.** A single commit.
2. **SessionStart hook in `.claude/settings.json`.** This file is untracked and gitignored. The hook runs the script in the background and appends its output to `.claude/worktree-prune.log`.
3. **Copy the `.superpowers/` ledger out before removing (2026-11-16).** Since 2026-11-15 a hook keeps the main folder's `main` current, so the prune really removes worktrees, and `git worktree remove` deleted each finished session's gitignored ledger with them (3 of 26 held one that day: 74, 190 and 22 files). The owner chose "copy out, then remove" over keeping such a worktree or deleting the ledger. See rules 8 and 13 and removal step 1.

## Removal rule

The rule checks and removes only linked worktrees under `<repo>/.worktrees/`. Worktrees anywhere else are never checked or removed, including Claude Code's own `.claude/worktrees/`. One exception: the `git worktree prune` at the end of a real run clears the admin entry of every unlocked worktree whose directory is already gone, wherever it was.

A worktree is removed only when every check below passes. The checks run in this order, and the first one that fails is the reason printed.

1. **Not locked.** A worktree locked with `git worktree lock` is kept.
2. **Still there.** A worktree git lists as prunable (its directory is already deleted) counts as removed, and the end-of-run prune clears its entry. Its branch is kept.
3. **Not in use here.** A worktree that contains the current directory is kept. Without this, the SessionStart hook would remove the worktree a session has just opened in, because opening one does not reset the idle clock.
4. **Not on main.** A worktree with `main` checked out is kept, so `main` is never deleted.
5. **Has a commit.** A worktree on an unborn (orphan) branch is kept: "no commits yet". git lists its HEAD as forty zeros.
6. **Merged.** `git cherry main <HEAD>` prints no `+` line, meaning every commit is already in `main` by patch id. This covers both fast-forward merges and cherry-picks. A squash merge looks unmerged and is kept, which errs on the safe side.
7. **No unmerged merge commit.** `git cherry` skips merge commits, and a merge commit can carry changes of its own (a conflict resolution, or an edit made during the merge). So `git rev-list --merges --max-count=1 <HEAD> ^main` must print nothing. A branch that merged `main` into itself is kept too, on the safe side like a squash merge, so "merge commit not in main" on such a worktree is expected.
8. **Idle at least `MIN_IDLE_HOURS` (24).** Idle time is measured from the newest mtime of the worktree's admin `index` and `logs/HEAD`, and of any file in its gitignored `.superpowers/` ledger (added 2026-11-16: a controller writes the ledger for days without a git command). If neither admin file exists, the idle time is unknown and the worktree is kept; a ledger cannot make up for that. This protects three cases:
   - a freshly created worktree an agent is about to use, which has no commits and is clean;
   - a worktree between phases just after a cherry-pick, which is merged and clean;
   - a worktree whose controller is still writing briefs and reviews into `.superpowers/`.

   The ledger is read with `lstat` and never through a link: a link's target is not the worktree's own file. `checkSettled` does this, so `scripts/_lib/session-status.mjs` gets the same answer.
9. **Clean.** `git --no-optional-locks status --porcelain --untracked-files=normal --ignore-submodules=none` prints nothing. The `--no-optional-locks` flag stops the check from refreshing the index, which would reset the idle clock. The explicit modes override any config that would hide changes.
10. **No operation in progress.** None of `rebase-merge`, `rebase-apply`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `sequencer` and `BISECT_LOG` exists in the worktree's admin dir (`git rev-parse --absolute-git-dir`). A `rebase -i` stopped at `break` leaves a clean tree and a HEAD at the commit it rebases onto, which rule 6 reads as merged, while the commits still to replay exist only in `rebase-merge/git-rebase-todo`. Removing the worktree would lose that state. `sequencer/` is the queue of a cherry-pick or revert of several commits: git leaves it alone, with a clean tree and no `CHERRY_PICK_HEAD` or `REVERT_HEAD`, when the sequence stops on a pick or revert that changes nothing, or when a commit is made in the middle of it. Added 2026-11-04 during the review of `scripts/session-status.mjs`, which asks the same questions through the exported `checkInUse` (rules 3 and 4) and `checkSettled` (rules 8, 9, 10 and 11), and through `pruneName` for the `.worktrees/` scope above, so "safe to remove" has one definition. `REVERT_HEAD` and `sequencer` were added in the follow-up round (7c-2); the first version missed them.
11. **No scratch files.** `git ls-files --others --ignored --exclude-standard -- docs/tmp` prints nothing. `docs/tmp/` is gitignored, so `git status` is blind to it, but sessions put scratch reports there and `git worktree remove` would delete them. Generated files there also keep a worktree, such as `__pycache__/` or the `outputs/*.csv` files that `.gitignore` lists. That errs on the safe side, and the reason printed names them. Clear `docs/tmp/` to let the worktree prune.
12. **HEAD unchanged.** HEAD, read again after the other checks, still matches the HEAD the checks ran on. This catches a commit made during the run, including on a detached HEAD.
13. **No link in the ledger.** A symlink, a junction or any other file that is not a plain file or folder anywhere inside `.superpowers/` keeps the worktree: `ledger holds a link or special file: .superpowers/<path>`. Nothing is copied through it, and the link is never read through. This is a decision, not a failure, so it is not counted as an error. A `.superpowers/` that holds no file (none, or only empty folders) has nothing to lose and is ignored here and below. Added 2026-11-16. Only prune asks this rule, not `checkSettled`, so `scripts/_lib/session-status.mjs` can still call such a worktree a cleanup candidate.

When every check passes, the script runs these steps:

1. **Copy the ledger out** (added 2026-11-16, owner decision "copy out, then remove"). `git worktree remove` deletes ignored files, and `.superpowers/` (gitignored) is where a subagent-driven session keeps its briefs, reviews and rulings, so a finished session's work log would be lost. If `.superpowers/` holds at least one file, its contents go to `<repo root>/docs/tmp/worktree-ledgers/<worktree name>/` in the main checkout (no extra level: `<name>/brief.md`, not `<name>/.superpowers/brief.md`; a name with a `/` becomes `__`, so one copy never lands inside another). The controller copied three finished sessions' ledgers by hand on 2026-11-16 (classifier-replacement, nightly-phase2, panel-date-rollover) into this same layout, so a later run finds them identical and skips the copy.
   - **Copy, verify, then rename.** The files are copied into a temporary sibling folder (`.<name>.copying-<pid>-<time>`) with the mtime of their source, every file is read back and compared byte for byte, and only then is the folder renamed to its final name. A half copy never sits under the final name. The worktree is removed only after this.
   - **Never overwrite.** If the final name is taken by a folder that holds exactly the same files with the same bytes, nothing is copied and the run goes on. If it is taken by anything else (a different copy, a file, a link, a folder with a link in it), the copy goes to `<name>-<UTC timestamp>` (`20261116T215301Z`) and the old one is not touched. Nothing is merged into or replaced. The name is checked once more right before the rename, since a rename replaces an empty folder on POSIX.
   - **Never follow a link.** The ledger and any existing copy are walked with `lstat`; rule 13 keeps a worktree with a link in its ledger.
   - **Fail closed.** Any error while copying or checking (a file that cannot be read, a copy that does not match, a rename that fails) keeps the worktree and is recorded in the run's errors like any other failure (`<name>: ledger copy failed: <error>`). The temporary folder is deleted with non-recursive calls (links unlinked, never entered); one that cannot be deleted is named in the reason (`partial copy left at <path>`).
   - **Re-check right before the removal.** The ledger is read again once the copy is in place. If any file was added, removed, resized or written again, or a link appeared, the worktree is kept (`ledger changed after the copy: .superpowers/<path>`). The copy stays where it is, and the next run, once the new write is 24 hours old, copies the ledger as it is then to a timestamped folder. A write between this re-check and `git worktree remove` is not caught: the window is a few milliseconds.
   - **Dry run.** `--dry-run` reads the ledger and what is already in the copies folder, and writes nothing, not even the folder. It says what it would copy and where.
2. `git worktree remove <path>` without `--force`. git runs its own check first, but that check honours `status.showUntrackedFiles`: when it is set to `no`, git deletes untracked files. The real guard is rule 9's explicit `--untracked-files=normal` status.
3. Clear what git left behind, if the folder still exists. On Windows `git worktree remove` exits 0 and prints nothing, but leaves an ignored `node_modules` junction and its folder (git 2.55.0.windows.5). git has already dropped the worktree, so without this step the run would report "removed", no later run would list the folder, and the name could not be reused. Only links are deleted, and never followed: a junction's target is the main checkout's `node_modules`. The calls are non-recursive (`lstat` to tell a link from anything else, `unlink` on the link itself, `rmdir` on the folder once it is empty); nothing may walk through a link. If anything but a link is left, or a delete fails, the folder is kept and the result line says so, as an error, instead of a clean removal; the branch is kept.
4. `git branch -D <branch>`, if the worktree was on a branch and the branch still points at the HEAD that passed the checks. If it moved, the branch is kept. Rules 6 and 7 already showed it is merged. The script prints the old SHA so the branch can be recovered.
5. `git worktree prune`, once at the end of the run.

A worktree that another run already removed counts as removed, not as a failure, and its branch is left to the run that removed it. That covers two sessions starting at the same moment. A removal that stops partway is an error: git deletes the `.git` file and admin entry, then stops at a file it cannot delete, such as a locked file on Windows. The leftover directory is no longer a worktree, so no later run would list it. The branch is kept.

## Interface

```text
node scripts/prune-merged-worktrees.mjs [--dry-run] [--min-idle-hours N]
npm run worktrees:prune -- [--dry-run] [--min-idle-hours N]
```

The script prints one line per worktree: either `removed`, or `kept` with the reason. A dry run prints `would remove` instead of `removed`. It exits with 1 only if a git command, a ledger copy or a clean-up failed, a missing local `main` included, and with 2 on bad arguments.

A worktree whose `.superpowers/` held a file gets `; ledger: <what happened>` at the end of its line, inside the parentheses of a removal. A worktree without one prints exactly as before.

```text
removed a (branch fix/a deleted, was <sha>; ledger: 74 files copied to <repo>/docs/tmp/worktree-ledgers/a)
removed a (branch fix/a deleted, was <sha>; ledger: identical copy of 74 files already at <repo>/docs/tmp/worktree-ledgers/a)
would remove a (merged, clean, idle 48.0h; would delete branch fix/a at <sha>; ledger: would copy 74 files to <repo>/docs/tmp/worktree-ledgers/a-20261116T215301Z)
kept a: ledger holds a link or special file: .superpowers/shared
kept a: ledger copy failed: <error>; partial copy left at <path> (<error>)
kept a: ledger changed after the copy: .superpowers/brief.md; ledger: 3 files copied to <dest>
kept a: git worktree remove failed: <reason>; ledger: 3 files copied to <dest>
```

`--min-idle-hours` lets the owner prune a worktree that has only just finished: use `--min-idle-hours 0`.

## Files

- Phase 1:
  - `scripts/_lib/prune-worktrees.mjs`
  - `scripts/_lib/prune-worktrees.test.mjs` (real git against temp repos)
  - `scripts/_lib/prune-worktrees.races.test.mjs` (races and git failures, with `spawnSync` mocked at the `node:child_process` boundary)
  - `scripts/_lib/prune-worktrees.fixtures.mjs` (temp-repo helpers shared by both test files)
  - `scripts/prune-merged-worktrees.mjs`
  - `package.json`
- Phase 2: `.claude/settings.json`
- Phase 3: `scripts/_lib/prune-worktrees.mjs`, `scripts/_lib/prune-worktrees.ledger.test.mjs` (real git, with `copyFileSync`, `renameSync` and `unlinkSync` wrapped at the `node:fs` boundary for the failure and race cases), `scripts/_lib/prune-worktrees.fixtures.mjs` (`.superpowers/` gitignored in the scratch repo, `writeFiles`)

## Data dependencies

Git only. No tables, env vars or external APIs.

## Thresholds / constants

- `MIN_IDLE_HOURS = 24`. This is the default picked on 2026-10-27. It is longer than a typical gap between phases and shorter than the 2–3 days over which worktrees piled up before this.
- The base ref is the local `main`. A cherry-pick that has not been pushed yet still counts as merged.
- The scratch folder checked by rule 11 is `docs/tmp`. That rule was added on 2026-10-27 during code review.
- The ledger folder is `.superpowers` and the copies go to `docs/tmp/worktree-ledgers/<name>/` in the main checkout (2026-11-16): the layout the controller used for the hand copies, inside the folder that is gitignored already. A different copy's replacement name is `<name>-<UTC timestamp>`, `YYYYMMDDTHHMMSSZ`.

## Open questions

- **Remove clean but unmerged worktrees after N days, keeping the branch?** Default: no, manual only. The one-time cleanup below did this for six worktrees that were 25 days old.
- **Also run the prune after `git push`?** Default: no, SessionStart only.

## One-time cleanup (2026-10-27)

Done by hand before the automation shipped.

- **Removed, branch deleted (13).** Each was merged or had no unique commits, was clean, and had been idle for 40 h or more.
  - `2026-10-02-`: cronck, e5, f0, flowregime, integ, uw-rest
  - `2026-10-23-`: duckdb, rtcheckin, uw-ws
  - `2026-10-24-`: duckdb, rtcheckin
  - `2026-10-25-`: gexoverflow, rollupchunk (both detached HEAD)
- **Removed, branch kept (6).** Each had unmerged commits, was clean, and had been idle for 25 days: `2026-10-02-` a3, analogs, docs, enrich, f4b and vx.
- **Kept:**
  - 2026-10-02-ci and gammapaper have uncommitted changes.
  - 2026-10-26-review and every rr-* worktree are part of the active review-remediation work.
