# Commit gate (2026-10-28)

## Goal

Claude can't commit content that the last passing `npm run review` didn't see. This turns the "review before every commit" rule (the `commit` skill, the run-review feedback memory) from prose into a check. It's a side stream of `skill-cleanup-2026-10-28.md`: that spec's audit found rules that don't change behavior, and this is the first one moved into enforcement.

## Status

- **Step 1: shipped** 2026-10-29 as `d45eaf6d`, pushed from `.worktrees/commit-gate` straight to `origin/main`.
  - Local `main` had diverged, with another session's unpushed commits, so it wasn't cherry-picked there.
  - `npm run review` passed on that commit, and the gate sealed its first marker.
  - The 2026-10-28 review runs failed only on prune-worktrees fixture timeouts under load from other sessions. `b2a57b7c` (another session) fixed those upstream with a shared 600s `FIXTURE_TIMEOUT`, so this stream's own timeout commit was dropped.
- **Step 2: shipped** 2026-10-29 during market hours (owner's call). `core.hooksPath` is set to `.githooks`, and the CLAUDE.md note and `.gitattributes` line went out as `eaa89513`.
  - Local changes: `.claude/hooks/no-verify-guard.sh`, its `settings.json` entry and two `commit` skill lines. They're recorded in the local `.claude/` history as `087181c`.
  - Live probes:
    - **Pass:** `eaa89513` was committed through the active hook after a passing review.
    - **Block:** an unreviewed CLAUDE.md edit was refused with "commit blocked. These staged files changed after the last passing `npm run review`: CLAUDE.md".
    - **`--no-verify` guard:** at first it answered "ask", and a live `git commit --dry-run --no-verify` in an auto-mode session ran without a prompt, because auto mode settled the ask itself. ★ The owner switched it to "deny". The same live command was then refused with the guard's reason.
  - Local `main` isn't gated until it contains `.githooks/`. It had diverged from `origin/main`, with another session's unpushed commits, when the gate went on.

### Found during step 1 (for step 2 and follow-ups)

- **Pathspec commits drop `+x` on Windows.** `git commit -- <paths>` builds its tree from the working-tree file. `core.fileMode` is false on Windows, so a new file staged as 100755 was committed as 100644. Commit new executable files with a plain `git commit` from the index, and check with `git ls-tree HEAD <file>`. The `commit` skill says so as of step 2.
- **Review contention:** once the gate is on, every Claude commit needs a full review. 3–4 sessions running coverage suites at once kept 16 cores at 88–100% on 2026-10-28, and a single review took 10–12 minutes. Option: a machine-wide lock so only one review's vitest runs at a time and the others queue.
- **Follow-up (duplication), done:** `review-gate.test.mjs` copied about 40 lines of temp-repo fixtures from `prune-worktrees.fixtures.mjs`, and `review-gate.mjs` copied the `GitError`/`spawnSync` runner from `prune-worktrees.mjs`. `d8d22e3b` moved the runner into `scripts/_lib/git-run.mjs`, and `a4a9931c` moved the fixtures into `scripts/_lib/scratch-git.fixtures.mjs`.
- **Follow-up (runtime), done 2026-10-29:** the gate's test file took 35–42s alone and up to 6 minutes under load, because each hook test spawns sh, node and git one after another, all on one vitest worker.
  - It's now two files, split along `describe` lines and balanced by measured time (22.4s and 18.3s when run one after the other). `review-gate.test.mjs` has decideCommit, the hook's main cases and the hook's file mode. `review-gate.cli.test.mjs` has the hook's partial-commit and rename cases, linked worktrees and the CLI. Their shared helpers are in `review-gate.fixtures.mjs`.
  - Measured back to back at 31–73% CPU: 42.0s for the single file, 19.9s for both halves in one vitest run.

## Why a git hook, not a Claude PreToolUse hook

The `commit` skill stages and commits in one call (`git add -- <paths> && git commit -F - <<'EOF'`). A PreToolUse hook runs before that whole command, so it would see the index before the `git add` and would have to parse the shell to simulate it. Git's own `pre-commit` hook runs after the `git add`, against the exact index being committed, with no parsing.

## Design

Owner decisions from 2026-10-28 are marked ★.

- **Where:** a tracked `.githooks/pre-commit`, enabled with `git config core.hooksPath .githooks` (local config, shared by every worktree of the clone). Git runs hooks from the worktree root. The hook finds the CLI relative to its own file (`"$(dirname "$0")/../scripts/review-gate.mjs"`), so tests can point a temp repo's `core.hooksPath` at the real `.githooks/`.
- ★ **Scope: Claude only.** The hook exits 0 unless `CLAUDECODE=1`, which Claude Code sets in its Bash and PowerShell tool shells (verified 2026-10-28). The owner's terminal and VS Code commits aren't gated.
- **Marker:**
  - `npm run review` runs `node scripts/review-gate.mjs clear` first and `node scripts/review-gate.mjs seal` last, so the marker exists only after a run that passed.
  - `seal` writes `$(git rev-parse --git-path review-gate.json)`, resolved against the cwd. It is per worktree and inside the git dir, so it never shows in `git status`.
  - Marker content: `{ tree, head, sealedAt }`.
  - `tree` is the full working tree. Copy the worktree's index (`git rev-parse --git-path index`) to a temp file, which keeps the stat cache so it's fast. Run `git add -A` into the copy via `GIT_INDEX_FILE`, run `git write-tree`, and delete the temp index (also on failure).
- **No hand sealing:** `seal` refuses (exit 1) unless `npm_lifecycle_event === 'review'`, so an agent can't write the marker without running the review.
- **Check:** the pre-commit hook runs `node scripts/review-gate.mjs check`.
  - No marker → block: no passing `npm run review` on record for this worktree.
  - `staged` = `git diff --cached --name-only -z` (index vs HEAD): what this commit changes.
  - `drifted` = `git diff --cached --name-only -z <tree>`: paths whose staged content differs from what review sealed. This includes reviewed changes that aren't staged.
  - ★ **Binding: per-file.** Block when any staged path is in `drifted`. Reviewed changes left unstaged, such as another session's work in the same checkout, don't block.
  - `decideCommit({ staged, drifted })` in `scripts/_lib/review-gate.mjs` holds the rule. It returns `null` to allow or a reason string to block.
  - The block message lists every staged-and-drifted path, one per line with no cap, and says to re-run `npm run review`. A cap would hide paths Claude has to fix, and pathspec commits keep the list short. Git prints hook stderr into the tool result, so Claude sees it.
- **No exemptions.** The `commit` skill says review runs before every commit, docs included.
- **Fails closed:** any error in `check` exits non-zero, so the commit fails with the error. Examples: bad marker JSON, a git failure.
- **Claude-side `--no-verify` guard:** a PreToolUse `Bash|PowerShell` hook, `.claude/hooks/no-verify-guard.sh`.
  - Bash-only fast exit unless the payload contains `--no-verify`. The match isn't bare `no-verify`, because the hook's own file name contains that.
  - ★ Then a static `permissionDecision: "deny"` (owner, 2026-10-29). "Ask" was dropped because auto mode settles an ask without a prompt. The gate covers Claude only, so the owner makes any unreviewed commit from their own terminal.
  - ★ `onFailure: "continue"` in settings (owner, 2026-10-29), changed from "block". Under heavy load, starting Git Bash took longer than the hook's 30s timeout, and "block" then blocked ordinary shell calls in every session. The cost: while the guard can't start, a command with the skip flag isn't denied.

## Accepted gaps

The gate catches forgetting, not deliberate circumvention.

- `git commit -n` (the short form of `--no-verify`), abbreviated long forms git also accepts (`--no-verif`, `--no-veri`), and `git -c core.hooksPath=… commit`.
- Any shell command whose text contains `--no-verify` is denied, including a commit message or a search that quotes it. Leave the literal flag out of commit messages, and build it from pieces in a search.
- Hand-editing `.githooks/pre-commit` or the marker, or setting `npm_lifecycle_event` by hand.
- A per-file commit of a subset that doesn't build on its own. CI after push is the backstop.
- A file changed while `npm run review` is running is sealed with its post-run content.
- A worktree checked out from a commit before this one has no `.githooks/`, so nothing is gated there.
- Merge, revert and cherry-pick commits don't run `pre-commit` (measured 2026-10-28; rebase replays don't either). A picked or reverted commit was gated where it was made. An automatic merge's combined result isn't reviewed, so CI after push is the backstop.
- A marker whose tree git has garbage-collected blocks the commit with "run `npm run review`". Each seal leaves its tree unreferenced, and `gc --auto` prunes it after about two weeks.
- Ctrl-C during `seal` can leave a `review-gate-index-<pid>.tmp` in the git dir. `clear` doesn't sweep these: a sweep could delete a concurrent review's live temp index.

## Phases

### Step 1: the gate (tracked, 5 files)

- **`scripts/_lib/review-gate.mjs`:** git helpers (marker path, seal, read marker, staged/drifted paths) and `decideCommit`. Node builtins only, so it runs in a worktree without `node_modules`.
- **`scripts/_lib/review-gate.test.mjs`:** `decideCommit` table tests. Integration tests against real temp git repos, isolated from the user's global git config:
  - seal, then commit unchanged → allowed
  - staged file edited after seal → blocked, and the message names it
  - no marker → blocked
  - `seal` outside `npm run review` → refused
  - reviewed but unstaged drift → allowed
  - `CLAUDECODE` unset → the hook exits 0
  - a linked worktree keeps its own marker
  - a corrupt marker → blocked (fails closed)
- **`scripts/review-gate.mjs`:** the CLI, `clear | seal | check`, matching the `check-coverage-floor.mjs` + `_lib/coverage-floor.mjs` split.
- **`.githooks/pre-commit`:** `sh`, mode `+x` in the index.
- **`package.json`:** the `review` script gets `clear` first and `seal` last.

### Step 2: activation

- **`CLAUDE.md`:** a short gate note and the one-time `core.hooksPath` setup.
- **Local only** (the `.claude/` local history):
  - `.claude/hooks/no-verify-guard.sh`
  - the `.claude/settings.json` entry
  - one line in the `commit` skill
- After the step 1 commit lands on main, run `git config core.hooksPath .githooks`. From then on, every Claude session's next commit needs a review run made with the new script. Tell the owner first: the skill-cleanup session commits on main too.
- **Live probes:**
  - a Claude commit with a stale marker is blocked
  - after `npm run review` it passes
  - `--no-verify` asks

## Files to create or modify

- **Step 1:** `scripts/_lib/review-gate.mjs`, `scripts/_lib/review-gate.test.mjs`, `scripts/review-gate.mjs`, `.githooks/pre-commit`, `package.json`
- **Step 2:** `CLAUDE.md`; local `.claude/hooks/no-verify-guard.sh`, `.claude/settings.json`, `.claude/skills/commit/SKILL.md`; `git config core.hooksPath .githooks`

## Data dependencies

None. No tables, env vars or external APIs. One local git config value (`core.hooksPath`).

## Thresholds and constants

None.

## Open questions (defaults in bold)

1. Gate the owner's own commits too? **No: Claude only** (owner, 2026-10-28).
2. Exempt docs-only commits? **No**, to match the `commit` skill. Revisit if docs commits become the main friction.
3. Catch `git commit -n`? **No, accepted gap.** A short-flag match has false positives inside commit messages.
