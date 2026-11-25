# Spec Review Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a session from ending its turn or committing while a spec or plan it wrote has had no `spec-reviewer` run, unless the owner waives it.

**Architecture:**

- **Recorders.** Bash hooks record the evidence in an append-only log, `.claude/state/spec-reviews.tsv`: Writes of specs and plans, reviewer starts and finishes, owner waivers, and blocks.
- **The Stop gate** reads the log and blocks a turn end while a doc this session wrote is unsettled.
- **The pre-commit check,** a Node script, reads the same log and blocks a Claude commit that adds an unreviewed doc.
- **The guard.** A permissions deny rule and a guard hook keep Claude from writing the log or forging a waiver.

**Tech Stack:** bash 5 (Git Bash, builtins only) for the Claude Code hooks; Node 24 ESM with builtins only for the pre-commit check; vitest for `scripts/_lib` tests; plain `node` test scripts for `.claude/hooks/tests/`.

**Spec:** `docs/superpowers/specs/2026-11-21-spec-review-gate-design.md`. It holds the design, the facts it rests on, the exact message texts and the known limits; read it first.

## Global Constraints

- **Hooks use bash builtins only.** No `python`, `node`, `git`, `cat`, `sed`, `grep`, `date` and no `$(…)` command substitution, since a fork costs seconds on a busy Cygwin box. `source`, `printf -v`, `[[ =~ ]]`, `read`, `local -n` and `>>` are fine.
- **Every new hook** has `"timeout": 30`.
- **The log** is `<.claude>/state/spec-reviews.tsv`: six tab-separated fields, `epoch event session agent key path`, with `-` for an unused field. It is found from the hook file's own location (`<hooks dir>/../state/`). No env var or flag redirects it; tests run copies of the hooks in a temp `.claude/` layout.
- **Keys** are lowercase: `specs/<name>.md` or `plans/<name>.md`, with `<name>` matching `[a-z0-9._-]+`. They come from a match of `docs/superpowers/(specs|plans)/<name>.md` on a normalised string; no slash is needed before `docs/`.
- **Normalising** a string turns each `\\` pair, then each single `\`, into `/`, lowercases it, and rewrites a leading MSYS `/x/` as `x:/`.
- **Constants:** block limit `2`; running window `2700` s (45 minutes); hook timeout `30`.
- **Node builtins only** in `scripts/spec-review-check.mjs` and `scripts/_lib/spec-review-log.mjs`, because the pre-commit hook runs them in worktrees with no `node_modules`.
- **Never name the log file or `.claude/state` in a shell command or commit message.** From Task 3 on, the guard denies it. Say "the review log". Read the log with the Read tool.
- **Edit the spec and this plan only with Edit, never Write,** from Task 1 on: checked boxes, "As built". A Write records a `write` line, and these docs' reviews predate the recorders, so the turn would be blocked.
- **Live checks run in the main session,** whose project folder is `F:/dev/strike-calculator`. A session started inside a worktree folder runs none of these hooks, and per the docs (untested) neither may one moved there with `/cd`. A Bash `cd` and EnterWorktree keep them, tested 2026-11-21. Implementer subagents have no Agent tool and no Stop event. If a live check's `write` line doesn't appear, check the session's project folder first.
- **Every live-check probe doc gets a new name.** The log never forgets a key, so a name reused in one session inherits the earlier review.
- **Commit hunks, not files, in `.claude/settings.json`.** It carries other sessions' uncommitted edits, so stage only this task's hunks. Build the blob from `git show HEAD:settings.json`, then use `git hash-object -w` and `git update-index --cacheinfo`, as the 2026-11-20 commit of the reminder hook did.
- **`.claude/` changes commit to the local history:** `git --git-dir="$HOME/.claude/config-history/strike-calculator-dotclaude.git" --work-tree=.`, run from `F:/dev/strike-calculator/.claude/`. A new file in an un-ignored folder (`hooks/`) is added normally; `state/` is never added.
- **Tracked changes** (`scripts/`, `.githooks/`, `vite.config.ts`, `CLAUDE.md`, docs) commit in `F:/dev/strike-calculator/.worktrees/spec-review-gate`, after `npm run review` passes. The `commit` skill has the format.

## Review Focus

These inputs aren't in the spec's test list but will reach the code. Each one's test is added to the task named.

1. **A log line with a CRLF ending** (the owner edits the log in a Windows editor) must not make a doc look deleted, since the trailing `\r` sits in the path field. Expect a block, not silence. Task 4.
2. **A project folder whose path has a space** (`F:/dev/strike calc/`) must still record and settle. Tasks 1 and 4.
3. **A reviewer started in the same second as the doc's first write** (`start` epoch equal to `t0`) counts as after it. Task 4.
4. **A 300 KB Write payload,** five times this repo's longest spec, must still be recorded within the hook's budget. Expect under 5 s. bash reads a pipe one byte at a time: the plan review timed 50 KB at 168 ms, 200 KB at 633 ms and 1 MB at 3,059 ms. Task 1.
5. **A drive letter in a different case** between the payload (`F:\…`) and `CLAUDE_PROJECT_DIR` (`f:/…`) must record. Task 1.

---

### Task 0: Commit the spec and this plan

The docs land before the pre-commit check exists (Task 6), so the check never sees them.

- [ ] **Step 1:** In the worktree, run `npm run review`. Expected: exit 0 and `review-gate: sealed tree …`.
- [ ] **Step 2:** Commit both docs by explicit path: `docs(spec): Design and plan the spec review gate`.

### Task 1: Shared hook library and the `write` recorder

**Files:**

- Create: `.claude/hooks/_spec-review-lib.sh`
- Modify: `.claude/hooks/spec-review-reminder.sh`
- Create: `.claude/hooks/tests/spec-review-gate.test.mjs`
- Modify: `.claude/hooks/tests/spec-review-reminder.test.mjs`

**Interfaces:**

- Produces, in `_spec-review-lib.sh` (sourced; each function sets its out-variable through `local -n`; none forks):
  - `SRL_LOG`: the log's path, built from `${BASH_SOURCE[0]%/*}/../state/spec-reviews.tsv`.
  - `srl_read_input`: reads all of stdin into `SRL_INPUT`.
  - `srl_field NAME OUTVAR`: the first `"NAME": "…"` JSON string in `SRL_INPUT`, still JSON-escaped. Regex: `"NAME"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)"`. Returns 1 when absent.
  - `srl_norm IN OUTVAR`: the normalising rule in Global Constraints.
  - `srl_keys TEXT OUTARRAY`: the deduplicated keys in the normalised `TEXT`, in first-seen order.
  - `srl_now OUTVAR`: epoch seconds, via `printf -v … '%(%s)T' -1`.
  - `srl_append EVENT SESSION AGENT KEY PATH`: appends one line to `SRL_LOG`. When the `state/` folder is missing, it prints `spec-review gate: no state folder at <dir>` to stderr and returns 0.
- Produces, in `spec-review-gate.test.mjs` (shared by Tasks 2–4):
  - `layout(projectDir?)`: copies `_spec-review-lib.sh` and every `spec-review-*.sh` from the real hooks folder into `<tmp>/.claude/hooks/` and creates `<tmp>/.claude/state/`. Returns `{ root, hooks, log }`.
  - `runHook(lay, script, payload, env)`: runs `bash <hooks>/<script>` with `JSON.stringify(payload)` (or a raw string) on stdin. `CLAUDE_PROJECT_DIR` defaults to `lay.root`. Returns `{ status, stdout, stderr, ms }`.
  - `logLines(lay)`: the log's lines split on tabs, or `[]` when there is no log.
  - `seed(lay, rows)`: appends rows to the log.
  - `check(name, want, got)`: the `ok` / `FAIL` harness of `spec-review-reminder.test.mjs`; the script ends with `all N passed`.

- [ ] **Step 1: Write the failing tests** in `spec-review-gate.test.mjs`. Each case runs `spec-review-reminder.sh` with a PostToolUse Write payload (`session_id` `S1`). It checks `logLines` for `[epoch, 'write', 'S1', '-', key, path]`, with an epoch within 5 s of now.

  | Case                                                                   | Expected                                      |
  | ---------------------------------------------------------------------- | --------------------------------------------- |
  | spec inside the project, forward slashes                               | one line, key `specs/a.md`, path normalised   |
  | plan inside the project, Windows backslashes (doubled in the raw JSON) | key `plans/b.md`, path with `/`               |
  | spec outside the project (`C:/tmp/docs/superpowers/specs/c.md`)        | no line                                       |
  | `CLAUDE_PROJECT_DIR` unset                                             | no line                                       |
  | `CLAUDE_PROJECT_DIR` in MSYS form (`/f/…` for an `F:\…` path)          | one line                                      |
  | payload `F:\…`, project dir `f:/…` (Review Focus 5)                    | one line                                      |
  | project folder named with a space (Review Focus 2)                     | one line                                      |
  | payload with `agent_id` (a subagent's Write)                           | session field `S1`                            |
  | `content` contains `{"session_id": "EVIL"}`                            | session field `S1`                            |
  | 300 KB `content` (Review Focus 4)                                      | one line, `ms < 5000`                         |
  | no `state/` folder                                                     | exit 0, no log, stderr names the folder       |
  | the reminder's stdout                                                  | unchanged: still the `additionalContext` JSON |

- [ ] **Step 2: Run** `node .claude/hooks/tests/spec-review-gate.test.mjs` from `F:/dev/strike-calculator`. Expected: FAIL on the recording cases.
- [ ] **Step 3: Implement.**
  - Write `_spec-review-lib.sh`.
  - Make `spec-review-reminder.sh` source it, keep the reminder logic as is, and append the `write` line only when `CLAUDE_PROJECT_DIR` is non-empty and the normalised path starts with the normalised project dir plus `/`.
  - Extend its header comment: the log, and why it is builtins only.
- [ ] **Step 4: Change `spec-review-reminder.test.mjs`.**
  - Spawn the hook with `CLAUDE_PROJECT_DIR` deleted from a copy of `process.env`.
  - Add the case `writes no log without CLAUDE_PROJECT_DIR`: run a temp copy (lib + reminder, with `state/`) and assert no log file appears.
- [ ] **Step 5: Run both test scripts.** Expected: `all N passed` for each. `node .claude/hooks/tests/env-guard.test.mjs` still passes.
- [ ] **Step 6: Commit** the four files to the local history: `feat(hooks): Record spec and plan writes in the review log`.
  - Don't create the real `state/` folder yet. Without it the recorder exits quietly. If `write` lines started before Task 2 records reviews, a spec reviewed in between would be blocked later.

### Task 2: Reviewer `start` and `done` recorder

**Files:**

- Create: `.claude/hooks/spec-review-record.sh`
- Modify: `.claude/hooks/tests/spec-review-gate.test.mjs`
- Modify: `.claude/settings.json`

**Interfaces:**

- Consumes: Task 1's library.
- Produces: `start` lines (session, agent id, key) and `done` lines (session, agent id) in the log.

- [ ] **Step 1: Write the failing tests.**

  **PostToolUse Agent payloads.** The async shape is `tool_input {subagent_type, prompt}` with `tool_response {isAsync: true, status: "async_launched", agentId: "A1", prompt}`.

  | Case                                                                                        | Expected                                      |
  | ------------------------------------------------------------------------------------------- | --------------------------------------------- |
  | brief names one spec by `F:\…` path                                                         | one `start` with agent `A1`, key `specs/x.md` |
  | brief names a relative path (`docs/superpowers/specs/x.md`)                                 | one `start`                                   |
  | the path starts a line (after `\n`)                                                         | one `start`                                   |
  | two specs                                                                                   | two lines                                     |
  | the same spec twice                                                                         | one line                                      |
  | a plan and its spec                                                                         | only `plans/p.md`                             |
  | no doc                                                                                      | no line                                       |
  | `"subagent_type": "spec-reviewer"` with spaces                                              | recorded                                      |
  | `subagent_type` `general-purpose`                                                           | no line                                       |
  | no `agentId`                                                                                | no line                                       |
  | foreground shape (`status: "completed"`, `content` names `specs/other.md` and `plans/q.md`) | only the brief's keys                         |

  **SubagentStop payloads:**

  | Case                                          | Expected                            |
  | --------------------------------------------- | ----------------------------------- |
  | `agent_type` `spec-reviewer`, `agent_id` `A1` | one `done` with agent `A1`, key `-` |
  | `agent_type` `Explore`                        | no line                             |
  | `agent_type` empty                            | no line                             |

  **Settings checks**, reading the real `settings.json`:
  - PostToolUse has a group with matcher `Agent` holding `spec-review-record.sh`, timeout 30.
  - SubagentStop has a group with matcher `^spec-reviewer$` holding it, timeout 30.

- [ ] **Step 2: Run** the gate test. Expected: FAIL on the new cases.
- [ ] **Step 3: Implement `spec-review-record.sh`.**
  - Switch on `hook_event_name`.
  - For PostToolUse:
    - exit unless the input matches the whitespace-tolerant `subagent_type` regex;
    - read the brief with `srl_field prompt`, which gives the first match, `tool_input.prompt`;
    - read `agentId` with `srl_field agentId`;
    - apply the plans-only rule, then append.
  - For SubagentStop: check `agent_type` is `spec-reviewer`, then append.
- [ ] **Step 4: Add the two settings groups,** with `"command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/spec-review-record.sh"`.
- [ ] **Step 5: Run** the gate test. Expected: `all N passed`.
- [ ] **Step 6: Create the real log folder:** `mkdir F:/dev/strike-calculator/.claude/state`, with no file in it. From here on, every session records.
- [ ] **Step 7: Live check, in the main session.**
  - Write a three-line throwaway doc at `F:/dev/strike-calculator/.worktrees/spec-review-gate/docs/superpowers/specs/zz-gate-record-probe.md`.
  - Dispatch `spec-reviewer` with `model: "haiku"` and the doc's path as the whole brief.
  - When it finishes, Read the log. Expected:
    - a `write` line for `specs/zz-gate-record-probe.md`, which proves the real `CLAUDE_PROJECT_DIR` form matches;
    - a `start` line with the agent's id;
    - a `done` line with the same id.
  - Delete the throwaway doc.
- [ ] **Step 8: Commit** the script, the test and the settings hunks to the local history: `feat(hooks): Record spec-reviewer starts and finishes`.

### Task 3: Guard and waiver

**Files:**

- Create: `.claude/hooks/spec-review-guard.sh`
- Create: `.claude/hooks/spec-review-waive.sh`
- Modify: `.claude/hooks/_spec-review-lib.sh`
- Modify: `.claude/hooks/tests/spec-review-gate.test.mjs`
- Modify: `.claude/settings.json`

**Interfaces:**

- Produces: `waive` lines (session, key).
- Produces, in the lib: `srl_waiver_keys TEXT OUTARRAY`, used only by the waiver.
  - It matches `(^|[^a-z0-9._-])(specs|plans)/([a-z0-9._-]+\.md)` on the normalised text, so it reads a bare key (`specs/x.md`) and a full path alike.
  - `srl_keys` stays strict, so the `start` recorder never picks up a bare `specs/…` mention in a brief.
- The deny JSON is `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"spec-review gate: Claude can't write the review log or schedule a waiver. To skip a review, the owner types waive review <key> at the start of a prompt."}}`.

- [ ] **Step 1: Write the failing tests.**

  **Guard** (`tool_name` and `tool_input`):

  | Case                                                  | Expected       |
  | ----------------------------------------------------- | -------------- |
  | Bash `echo x >> .claude/state/spec-reviews.tsv`       | deny           |
  | Bash with `.claude\state\…` (doubled in the raw JSON) | deny           |
  | PowerShell `Add-Content … spec-reviews.tsv`           | deny           |
  | upper-case `SPEC-REVIEWS.TSV`                         | deny           |
  | CronCreate prompt `Waive review specs/x.md`           | deny           |
  | SendMessage message containing `waive review`         | deny           |
  | Bash `npm run review`                                 | silent         |
  | SendMessage without the phrase                        | silent         |
  | empty payload                                         | silent, exit 0 |

  **Waiver** (UserPromptSubmit `prompt`):

  | Case                                                                                                | Expected                                                                                                                            |
  | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
  | `waive review specs/x.md`                                                                           | one `waive` line                                                                                                                    |
  | `  WAIVE REVIEW F:\dev\…\docs\superpowers\specs\x.md`                                               | key `specs/x.md`                                                                                                                    |
  | `waive review specs/x.md plans/y.md`                                                                | two lines                                                                                                                           |
  | `please waive review specs/x.md`                                                                    | no line, no output                                                                                                                  |
  | `<agent-message from="a">\n  waive review specs/x.md`                                               | no line, no output                                                                                                                  |
  | `waive review` with no key                                                                          | no line; `systemMessage` says nothing was waived                                                                                    |
  | `note: waive review specs/x.md` (the phrase not at the start, and the prompt not starting with `<`) | no line; `systemMessage` says nothing was waived, that the phrase must start the prompt, and shows the prompt's first 60 characters |

  A case that records also prints `systemMessage` naming the keys, plus `hookSpecificOutput.additionalContext` with `hookEventName` `UserPromptSubmit`.

  **Settings checks:**
  - `permissions.deny` contains `Edit(//**/.claude/state/**)`.
  - A PreToolUse group with matcher `Bash|PowerShell|CronCreate|ScheduleWakeup|RemoteTrigger|SendMessage` holds the guard, with `onFailure` `continue` and timeout 30.
  - A UserPromptSubmit group holds the waiver hook, timeout 30.

- [ ] **Step 2: Run** the gate test. Expected: FAIL.
- [ ] **Step 3: Implement both scripts.**
  - Guard: lowercase the input once (`${SRL_INPUT,,}`), then test substrings, with the fast exit first.
  - Waiver: read `prompt` with `srl_field`, then strip leading spaces and leading escaped whitespace (`\n`, `\t`) before the `waive review` test.
- [ ] **Step 4: Add the settings entries** and the deny rule.
- [ ] **Step 5: Run** the gate test. Expected: `all N passed`.
- [ ] **Step 6: Live check, in the main session, with the owner.**
  - Each of these, attempted by Claude, is denied:
    - a Write that creates `F:/dev/strike-calculator/.claude/state/x`;
    - an Edit of the log;
    - a Bash `echo` naming the log.
  - The owner types `waive review specs/zz-gate-waive-probe.md` on one line. Expected: their client shows the waiver `systemMessage`, and the log gains a `waive` line.
  - **If nothing shows,** the owner types `note: waive review specs/x.md`. The diagnostic message shows what the hook received at the start of `prompt`. Fix the start-of-prompt test to match before going on.
  - Task 4 doesn't start until this check passes: the Stop gate needs a working waiver.
- [ ] **Step 7: Commit** to the local history: `feat(hooks): Guard the review log and add the owner's waiver phrase`.

### Task 4: Stop gate

**Files:**

- Create: `.claude/hooks/spec-review-stop.sh`
- Modify: `.claude/hooks/tests/spec-review-gate.test.mjs`
- Modify: `.claude/settings.json`
- Modify, only if Step 6 needs the fallback: `.claude/hooks/spec-review-waive.sh`

**Interfaces:**

- Consumes: every event kind.
- Produces: `block`, `release` and `ask` lines, and one stdout JSON object. An `ask` line is written the first time a key is exempt because the last message asks for its waiver; with one already in the session, a further request doesn't exempt the turn (spec, Stop gate step 3). The object has `decision` and `reason` when any key blocks; a release prints nothing (as built after Step 6: the owner's warning moved to `spec-review-waive.sh`, which writes `announced`). The texts are copied from the spec's "The Stop gate" section, with `N` the block number.

- [ ] **Step 1: Write the failing tests.**
  - Each case seeds the log with `seed()` and creates real doc files under `lay.root` for the paths that "exist".
  - Stop payloads carry `session_id` `S1`, `last_assistant_message` and `background_tasks`.
  - The spec's Tests section lists the Stop cases: silent, block, asking, two docs.
  - Add the Review Focus cases:
    - a seeded log with CRLF endings → block (Focus 1);
    - a project path with a space → block, then settled after a `start` and `done` (Focus 2);
    - a `start` epoch equal to `t0` → settled (Focus 3).
  - More cases:
    - a request naming two keys in one `waive review` line → both asking, no block, two `ask` lines;
    - the same request on the next turn end → block 1 for each key;
    - one key written at two paths, the latest one deleted → silent; the latest one present → its path in the reason.
  - Assert the third consecutive stop for one unsettled key:
    - writes a `release` line;
    - its stdout is empty (as built after Step 6; the next prompt's waiver hook prints the warning);
    - a fourth stop prints nothing.
  - Settings check: a Stop group with no matcher holds `spec-review-stop.sh`, timeout 30.
- [ ] **Step 2: Run** the gate test. Expected: FAIL.
- [ ] **Step 3: Implement `spec-review-stop.sh`.**
  - Read the log in one `while IFS=$'\t' read -r` pass, stripping a trailing `\r` from each line, into associative arrays.
  - Then apply the spec's settled, running, asking, released and unsettled rules in that order.
  - Read "running" only from the `{"id":"<agent>","type":"subagent","status":"running"` substring.
  - Read "asking" only from `srl_field last_assistant_message`.
    - A key is asking when that message, normalised, contains `waive review` and names the key anywhere.
    - So one request line naming two keys covers both.
  - When a key has `write` lines at two paths (one file name in two worktrees), the session's latest `write` decides whether the doc still exists, and its path goes in the reason.
- [ ] **Step 4: Add the Stop group to settings.**
- [ ] **Step 5: Run** the gate test. Expected: `all N passed`.
- [ ] **Step 6: Live check, in the main session, with the owner.**
  - Write `zz-gate-stop-probe.md`, a name not used before in this session, in the worktree's specs folder.
  - End the turn three times: block 1, block 2, then release. Ask the owner whether they saw the release warning.
  - **If they didn't:** add the fallback to `spec-review-waive.sh`. At the owner's next prompt it prints a `systemMessage` for each `release` line in the session that has no `announced` line, then appends `announced`. Add its tests, then re-run.
  - Delete the doc.
- [ ] **Step 7: Commit** to the local history: `feat(hooks): Block a turn end while a new spec or plan is unreviewed`.

### Task 5: Pre-commit check script

**Files:**

- Create: `scripts/_lib/spec-review-log.mjs`
- Create: `scripts/_lib/spec-review-log.test.mjs`
- Create: `scripts/spec-review-check.mjs`
- Create: `scripts/_lib/spec-review-check.cli.test.mjs`
- Modify: `vite.config.ts` (add the CLI test to `SPAWN_TEST_FILES`, sorted)

**Interfaces:**

- Produces, in `spec-review-log.mjs` (JSDoc-typed, builtins only):
  - `@typedef {{ epoch: number, event: string, session: string, agent: string, key: string, path: string }} LogEvent`
  - `parseLog(text: string): LogEvent[]`. It splits on `\r?\n` and skips any line without six fields or with a non-integer epoch.
  - `docKey(p: string): string | null`. It uses the Global Constraints rule.
  - `unreviewed(paths: string[], events: LogEvent[]): string[]`. A path stays out when its key has a `start` and a `done` sharing an agent id, in any order, or has a `waive`.
  - `blockMessage(paths: string[]): string` and `missingLogMessage(logPath: string, paths: string[]): string`. They give the texts below.
  - `logPathFor(gitCommonDir: string, cwd: string): string`. It returns `<dirname(resolve(cwd, gitCommonDir))>/.claude/state/spec-reviews.tsv`.
- Produces, in `scripts/spec-review-check.mjs <path>…`:
  - It runs `git rev-parse --git-common-dir` through `git()` from `scripts/_lib/git-run.mjs`.
  - It exits 0 when nothing is unreviewed and 1 when a doc is blocked or anything errors, with messages on stderr.
  - It exits 2 with a usage line when given no paths.

The messages:

- `blockMessage`:
  ```
  spec-review gate: commit blocked. These new docs have no spec-reviewer run and no waiver on record:
    <path>
  Run the spec-reviewer on each (CLAUDE.md, Plan First), or ask the owner to type "waive review <key>" at the start of a prompt. Then commit again.
  ```
- `missingLogMessage`: `spec-review gate: commit blocked. There is no review log at <logPath>, so these new docs have no recorded review:`, followed by the same list and fix lines.

- [ ] **Step 1: Write the failing library tests** in `spec-review-log.test.mjs`. They are pure, with no spawn.
  - `parseLog`:
    - CRLF lines parse;
    - a five-field line is skipped;
    - an epoch `abc` is skipped.
  - `docKey`:
    - `F:\x\docs\superpowers\specs\A.md` → `specs/a.md`;
    - `docs/superpowers/plans/b.md` → `plans/b.md`;
    - `src/a.md` → `null`.
  - `unreviewed`, by what the log holds:

    | The log holds                             | Result   |
    | ----------------------------------------- | -------- |
    | `start` and `done` for one agent          | `[]`     |
    | a `done` logged before its `start`        | `[]`     |
    | a `waive`                                 | `[]`     |
    | a `start` with no `done`                  | the path |
    | a `done` with no `start`                  | the path |
    | a `start` and `done` for different agents | the path |
    | nothing for the key                       | the path |

  - `blockMessage(['docs/superpowers/specs/a.md'])` contains the path and `waive review specs/a.md`.

- [ ] **Step 2: Write the failing CLI tests** in `spec-review-check.cli.test.mjs`.
  - Use `setupScratchGit`, `makeTempDir`, `initRepo` and `run`.
  - The log goes at `<repo>/.claude/state/spec-reviews.tsv`, and `.claude/` goes in the test repo's `.gitignore`, so the log never enters a sealed tree.
  - Cases:
    - No log → exit 1; stderr contains `There is no review log at` and the path.
    - An unreviewed doc → exit 1.
    - A reviewed doc → exit 0.
    - No arguments → exit 2.
    - Run in a folder that isn't a git repo → exit 1. Any error blocks.
- [ ] **Step 3: Run** `npx vitest run scripts/_lib/spec-review-log.test.mjs scripts/_lib/spec-review-check.cli.test.mjs`. Expected: FAIL.
- [ ] **Step 4: Implement** the library and the CLI, following `scripts/review-gate.mjs` for its `main(args)` / `process.exitCode` shape.
- [ ] **Step 5: Run** the same vitest command. Expected: PASS. Then run `npm run review`. Expected: exit 0, with `spawn-test-group.test.mjs` passing with the new entry.
- [ ] **Step 6: Commit** the five files in the worktree: `feat(scripts): Add the spec review check for the pre-commit hook`.

### Task 6: Wire the pre-commit hook and document the gate

**Files:**

- Modify: `.githooks/pre-commit`
- Modify: `scripts/_lib/spec-review-check.cli.test.mjs`
- Modify: `CLAUDE.md` (the adversarial-review bullets in "Plan First")
- Modify: `.claude/skills/agents-md/SKILL.md` (local history)
- Modify: `docs/superpowers/specs/2026-11-21-spec-review-gate-design.md` (an "As built" note)

**Interfaces:**

- Consumes: Task 5's CLI.

- [ ] **Step 1: Write the failing hook tests.**
  - Each runs `claudeCommit` in an `initRepo` repo, after `review(repo)` seals the staged tree.
  - The spec check's own message is `spec-review gate: commit blocked`.

  | Case                                                                                                                                                 | Expected                                        |
  | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
  | an added, unreviewed `docs/superpowers/specs/a.md`                                                                                                   | exit 1 with that message                        |
  | the same doc, reviewed in the log                                                                                                                    | exit 0                                          |
  | a modified committed doc (commit it first without `CLAUDECODE`)                                                                                      | exit 0                                          |
  | `git mv docs/tmp/a.md docs/superpowers/specs/a.md`                                                                                                   | the spec check's message                        |
  | `MERGE_HEAD`, `CHERRY_PICK_HEAD` or `REVERT_HEAD` written into the git dir, or a `rebase-merge/` folder created there, with an unreviewed doc staged | the spec check is skipped, with no spec message |
  | no docs staged                                                                                                                                       | no spec message                                 |

  The skip cases run the hook directly, `run(repo, 'sh', [path.join(ROOT, '.githooks', 'pre-commit')], { CLAUDECODE: '1' })`, rather than `git commit`. A hand-written `MERGE_HEAD` would make the commit a merge. `ROOT` is exported by the fixtures; `HOOKS_DIR` isn't, so build the path in the test.

- [ ] **Step 2: Run** the CLI test file. Expected: FAIL on the blocking cases.
- [ ] **Step 3: Change `.githooks/pre-commit`.**
  - After the `CLAUDECODE` line, take `GIT_DIR=$(git rev-parse --git-dir)`.
  - Skip the spec step when `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge` or `rebase-apply` exists there.
  - Otherwise set `ADDED` to `git diff --cached --no-renames --name-only --diff-filter=A -- 'docs/superpowers/specs/*.md' 'docs/superpowers/plans/*.md'`. When it is non-empty, run `node "$(dirname "$0")/../scripts/spec-review-check.mjs" $ADDED || exit 1`.
  - Keep the `exec node … review-gate.mjs check` last.
  - Extend the header comment to name the new step and the spec.
- [ ] **Step 4: Run** the CLI test file. Expected: PASS.
- [ ] **Step 5: CLAUDE.md.**
  - In the bullet that starts "After writing a spec or plan, dispatch the `spec-reviewer` agent", keep its first sentence. Replace only its second sentence, "A PostToolUse hook (`spec-review-reminder.sh`) reminds you after each Write there.", with:
    > Hooks enforce it: a turn can't end while a spec or plan written in the session has no spec-reviewer run, and a Claude commit that adds one is blocked. To skip a review, the owner types `waive review <specs/… or plans/….md>` on one line at the start of a prompt. Design and limits: `docs/superpowers/specs/2026-11-21-spec-review-gate-design.md`.
  - Leave the other bullets as they are.
- [ ] **Step 6: agents-md skill.** In the `SKILL.md` hook table, add `spec-review-guard.sh` to the PreToolUse row. Add rows for the Stop hook, the SubagentStop and PostToolUse `Agent` recorder, and the waiver hook (UserPromptSubmit). Commit it to the local history: `docs(skills): List the spec review gate hooks`.
- [ ] **Step 7: Add the spec's "As built" note.** List what differs from the design, the live-check results from Tasks 2–4, and the commit ids.
- [ ] **Step 8: Run `npm run review`** in the worktree (expected exit 0), then commit the four tracked files: `feat(githooks): Block a Claude commit that adds an unreviewed spec or plan`.
- [ ] **Step 9: Land on main** by the `git-advanced-workflows` skill's worktree route.
  - Rebase onto `origin/main`; re-run `npm run review` if the rebase picked up new commits.
  - Push `HEAD:main`.
  - Check the deploy with the `github` skill.

## Self-review notes

- **Spec coverage:**
  - The log and its format: Tasks 1–4.
  - Recorders: Tasks 1–2.
  - Stop gate: Task 4.
  - Waiver and guard: Task 3.
  - Pre-commit: Tasks 5–6.
  - Settings: Tasks 2–4.
  - Docs: Task 6.
  - Live checks: Tasks 2, 3, 4.
  - The known limits need no code.
- **File counts:** at most five per task. Phase 1 of the spec is Tasks 1–2.
