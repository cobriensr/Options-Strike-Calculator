# Worktree auto-prune (2026-10-27)

## Goal

Remove a `.worktrees/` worktree automatically once its work is in `main`. Finished worktrees, each about 45k files with its own `node_modules`, stop piling up inside the VS Code workspace.

## Background

On 2026-10-27, `.worktrees/` held 35 worktrees: 1.56M files, 26 GB. VS Code logged the extension host as unresponsive 914 times this month. Its profiler blamed Auto Import, Todo Tree and Import Cost, which scan every TypeScript file in the open folder, including all of the worktrees. The Claude Code extension shares that extension host, so its panel froze.

Sessions create worktrees with `git worktree add .worktrees/<name> -b <branch> origin/main`. They then cherry-pick the finished commits onto `main` and never remove the worktree.

## Phases

1. **Prune script, tests and npm script.** A single commit.
2. **SessionStart hook in `.claude/settings.json`.** This file is untracked and gitignored. The hook runs the script in the background and appends its output to `.claude/worktree-prune.log`.

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
8. **Idle at least `MIN_IDLE_HOURS` (24).** Idle time is measured from the newest mtime of the worktree's admin `index` and `logs/HEAD`. If neither file exists, the idle time is unknown and the worktree is kept. This protects two cases:
   - a freshly created worktree an agent is about to use, which has no commits and is clean;
   - a worktree between phases just after a cherry-pick, which is merged and clean.
9. **Clean.** `git --no-optional-locks status --porcelain --untracked-files=normal --ignore-submodules=none` prints nothing. The `--no-optional-locks` flag stops the check from refreshing the index, which would reset the idle clock. The explicit modes override any config that would hide changes.
10. **No scratch files.** `git ls-files --others --ignored --exclude-standard -- docs/tmp` prints nothing. `docs/tmp/` is gitignored, so `git status` is blind to it, but sessions put scratch reports there and `git worktree remove` would delete them. Generated files there also keep a worktree, such as `__pycache__/` or the `outputs/*.csv` files that `.gitignore` lists. That errs on the safe side, and the reason printed names them. Clear `docs/tmp/` to let the worktree prune.
11. **HEAD unchanged.** HEAD, read again after the other checks, still matches the HEAD the checks ran on. This catches a commit made during the run, including on a detached HEAD.

When every check passes, the script runs these steps:

1. `git worktree remove <path>` without `--force`. git runs its own check first, but that check honours `status.showUntrackedFiles`: when it is set to `no`, git deletes untracked files. The real guard is rule 9's explicit `--untracked-files=normal` status.
2. `git branch -D <branch>`, if the worktree was on a branch and the branch still points at the HEAD that passed the checks. If it moved, the branch is kept. Rules 6 and 7 already showed it is merged. The script prints the old SHA so the branch can be recovered.
3. `git worktree prune`, once at the end of the run.

A worktree that another run already removed counts as removed, not as a failure, and its branch is left to the run that removed it. That covers two sessions starting at the same moment. A removal that stops partway is an error: git deletes the `.git` file and admin entry, then stops at a file it cannot delete, such as a locked file on Windows. The leftover directory is no longer a worktree, so no later run would list it. The branch is kept.

## Interface

```text
node scripts/prune-merged-worktrees.mjs [--dry-run] [--min-idle-hours N]
npm run worktrees:prune -- [--dry-run] [--min-idle-hours N]
```

The script prints one line per worktree: either `removed`, or `kept` with the reason. A dry run prints `would remove` instead of `removed`. It exits with 1 only if a git command failed, a missing local `main` included, and with 2 on bad arguments.

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

## Data dependencies

Git only. No tables, env vars or external APIs.

## Thresholds / constants

- `MIN_IDLE_HOURS = 24`. This is the default picked on 2026-10-27. It is longer than a typical gap between phases and shorter than the 2–3 days over which worktrees piled up before this.
- The base ref is the local `main`. A cherry-pick that has not been pushed yet still counts as merged.
- The scratch folder checked by rule 10 is `docs/tmp`. That rule was added on 2026-10-27 during code review.

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
