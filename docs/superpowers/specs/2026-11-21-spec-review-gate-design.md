# Spec review gate: make the adversarial review hard to skip

**Status:** built and live (see "As built"). The hooks went live phase by phase from 2026-11-21 to 25, from the local `.claude` history. The commit check lands on main with this note, 2026-11-26. The owner approved the approach in conversation 2026-11-21 ("yeah go ahead") and answered the scope question the same day. Adversarial review rounds 1 and 2 are settled, the rule's limit.

## As built (2026-11-26)

Built subagent-driven from `docs/superpowers/plans/2026-11-21-spec-review-gate.md`: the plan's six tasks plus two added mid-build (the named-reviewer `done`, the waiver list). Each task had its own review. Then one whole-branch review (Opus), one fix wave, and a scoped re-review, whose two test-only Minors got a follow-up commit in each history.

**Where it is.**

- **Local `.claude` history** (not public):
  - what it holds: `hooks/_spec-review-lib.sh`, the five `hooks/spec-review-*.sh` hooks, `hooks/tests/spec-review-gate.test.mjs` and `spec-review-reminder.test.mjs`, the spec-review hunks of `settings.json`, and the agents-md skill's hook table;
  - commits: the ones after `297a2bc`, up to `36e9344`, plus one `test(hooks)` follow-up. The `agents/*.md` commits in that range are other sessions' work.
- **Main:**
  - what it holds: `scripts/_lib/spec-review-log.mjs` and its test, `scripts/spec-review-check.mjs`, `scripts/_lib/spec-review-check.cli.test.mjs`, `.githooks/pre-commit`, one `SPAWN_TEST_FILES` line in `vite.config.ts`, and `CLAUDE.md`;
  - commits: `930792427` to `b679a7b16` (rebased onto main 2026-11-26), one `test(githooks)` follow-up, and this note.

**What changed from the design while building.** The sections below already hold every change but two, which only this note records: the recorders' `CLAUDE_PROJECT_DIR` rule and the block read.

- **Named reviewers.** A spec-reviewer dispatched with a `name` runs as a teammate. It goes idle instead of stopping, and its SubagentStop carries the name, not `spec-reviewer`, as `agent_type`. Its `done` is recorded on TeammateIdle when the log has an open `start` for that agent id (Recording).
- **The release warning moved to the next prompt.** The owner didn't confirm seeing the Stop `systemMessage` on release. So the waiver hook prints the warning at the session's next prompt, the channel the owner did see.
  - A prompt that starts with `<`, such as a hand-back or a task notification, holds the warning for the next prompt. The first live announce had landed on a subagent's hand-back.
- **The waiver list** (owner, 2026-11-24): only the docs named right after the phrase are waived, and a sentence period ends the list. A doc named later is reported as not waived, with what to type.
- **A review this session ran before its first `write` counts** (final review). Before this fix, the gate cost one extra Opus review in live use:
  - session `b9cb1791` reviewed `specs/gexbot-expected-move-net-vanna-2026-11-20.md`;
  - 23 minutes later it Wrote the doc to settle the findings;
  - the gate blocked it, and it ran a second review (about 7.5 minutes).
- **Recorders need `CLAUDE_PROJECT_DIR`,** so a shell command can't forge a `start`, `done` or `waive` line. A `start` or `done` with no session id records `-`; the readers pair by agent id.
- **The commit check:**
  - It blocks a doc with no key, and the message says to rename it.
  - It lists added docs with `git --no-literal-pathspecs diff … ':(glob,icase)…'`, so a pathspec setting in the hook's environment can't empty the list or drop a doc (final review).
- **Every hook reads its input in blocks** (`read -N`, in the lib). A 1 MB payload went from about 1.6 s to under 0.1 s.

**Live checks.**

- **Recording (2026-11-22):**
  - A throwaway spec got its `write`, `start` and `done` lines from a real review.
  - The real SubagentStop payload had its fields in the order the tests assume.
- **Named reviewer (2026-11-24):** the `done` came from TeammateIdle, about 2 minutes after the `start`.
- **Guard and waiver (2026-11-22):**
  - The deny rule refused a Write and an Edit in the log's folder, and the guard refused a shell command that named the log.
  - The owner typed the waiver phrase. The `waive` line landed, and the owner saw the message.
- **Stop gate (2026-11-24):** a throwaway spec gave block, block, release. The release warning reached the session's next prompt, which led to the `<` rule above.
- **Commit check:** no live check, by design. Its tests run the real hook through git, from the main checkout and from a linked worktree.

**Cost** on a 5,000-line log:

| Hook | Case | Time |
| --- | --- | --- |
| Waiver hook, every prompt | nothing pending | 23 ms |
| Waiver hook, every prompt | one or twenty releases already announced | 30 ms |
| Stop, every turn end | a session that wrote no doc | 23 ms (666 ms before the final fix wave's early exit) |

The live log held about 80 lines after four days.

**CLAUDE.md.** Plan First's first review bullet now says the hooks enforce the rule, and it gives the waiver phrase. The status-edit bullet adds "Make such edits with Edit". The Commit gate paragraph says `.githooks/pre-commit` also blocks an unreviewed doc.

**Left as is by the final review:**

- When the log can't be written, the Stop's fail-open message uses the Stop channel that wasn't confirmed on screen. No other channel exists then.
- The Stop reason prints the doc path as the log holds it.
- A pending release behind 20 announced ones costs 3 to 7 s, once.
- The hook test file stays one file, about 3,200 lines.
- The new `.mjs` files aren't type-checked by the gate. The same holds for every `scripts/_lib` `.mjs` (`tsconfig.scripts.json` includes `.ts` only).

## Goal

A session can't end its turn, and can't commit, while a spec or plan it wrote has had no `spec-reviewer` run. Skipping the review takes either the owner's waiver or a deliberate workaround that leaves a trace.

## Why

CLAUDE.md ("Plan First", adversarial review, owner rule 2026-11-20) says every spec in `docs/superpowers/specs/` and every plan in `docs/superpowers/plans/` gets a hostile read by a fresh `spec-reviewer` agent before the owner sees it. Today the only machinery is `spec-review-reminder.sh`, a PostToolUse hook that reminds Claude after a Write. A reminder can be ignored, and it can miss a doc written by a shell command. A side agent pointed this out on 2026-11-20 and the owner asked how to force it.

## Decisions

From the conversation of 2026-11-21:

- **The proof comes from hooks, not from Claude.** Hook scripts record each spec-reviewer run in a log, and Claude is denied writes to that log. If Claude could write "reviewed", the gate would only check that Claude claimed a review.
- **Block at the two points where skipping does harm:** handing the doc over (the `Stop` event, when the main agent ends its turn) and committing it (`.githooks/pre-commit`). Saving the file isn't the harm, so nothing blocks the Write itself.
- **An escape hatch that's loud.** After two blocks for the same doc in a session, the gate lets the turn end and shows the owner a warning that the doc went unreviewed. A broken reviewer can't trap a session, and a skip can't be silent.
- **An owner-only waiver**, for a doc the owner doesn't want reviewed.
- **No hook that runs the review itself** (a `type: "agent"` hook). An Opus review takes about 15 minutes, so every save would freeze that long.

Not decided by the owner (my calls, open to change): the waiver phrase, the two-block limit, the 45-minute running window, and which events count as a write (below).

## Non-goals

- Checking that the review's findings were settled. A hook sees actions, not judgment; a finished review whose findings are ignored passes the gate.
- Re-review after design changes. The rule leaves that to judgment ("re-review only when the fixes changed the design"), so the gate asks for one review per doc per session.
- Docs outside `docs/superpowers/specs/` and `docs/superpowers/plans/`, and any file that isn't `.md`.
- Commits made outside Claude Code. The owner's own terminal commits stay ungated, as with the commit gate.

## Facts this design rests on

**Probe.** Checked on 2026-11-21 against Claude Code 2.1.330 with a temporary logging hook. The field names were kept; the payloads weren't, because the project's settings are shared by every session and the log caught other sessions' prompts.

- **Subagent tool calls.** They fire the project's PreToolUse and PostToolUse hooks, carrying the parent session's `session_id` plus `agent_id` and `agent_type`. So a spec a helper agent writes is recorded against the session that dispatched it.
- **PostToolUse on the Agent tool.** It has `tool_input.subagent_type`, `tool_input.prompt` and `tool_response.agentId`. Every agent the probe saw launched in the background (`tool_response.isAsync: true`, `status: "async_launched"`).
- **The same agent id appears in three places:** `tool_response.agentId`, SubagentStop's `agent_id`, and the `id` of that agent's entry in `background_tasks`. An entry reads `{"id":"…","type":"subagent","status":"running","description":"…","agent_type":"…"}`, in that field order.
- **SubagentStop.** It has `agent_id`, `agent_type`, `agent_transcript_path` and `background_tasks`. `last_assistant_message` was missing for an agent that ended through its hand-back tool, so the gate never reads the report.
- **Stop.** It has `session_id`, `stop_hook_active`, `last_assistant_message` and `background_tasks`.
- **UserPromptSubmit.** It has `prompt`. It also fires when a subagent's hand-back arrives, and that prompt starts with `<agent-message from=…>`.
- **Raw JSON.** Hooks get it, so a Windows path arrives with each backslash doubled (`F:\\dev\\…`).
- **`CLAUDE_PROJECT_DIR`.** It is set for hooks (their commands use it) and unset in Claude's own Bash tool.
- **Slow hooks.** Hooks that start child processes (python, node, git) took 20.6 s on a busy machine on 2026-11-20 against 1.6 s by hand, and missed a 5 s timeout. `spec-review-reminder.sh` was rewritten in bash builtins only and fires reliably at a 30 s timeout. The new hooks follow it.

**Hooks reference** (https://code.claude.com/docs/en/hooks, read 2026-11-21):

- **`UserPromptSubmit` doesn't fire only on typed prompts.** It also runs on "a session-scoped scheduled task firing, including a `/loop` iteration", "a background subagent reporting back", and "a message another session sends to your main conversation". No input field tells a typed prompt from these. The cross-session messaging page says a message from another session "arrives as plain text". It doesn't say what the hook's `prompt` holds.
- **Stop.**
  - `{"decision":"block","reason":…}` "prevents Claude from stopping"; `reason` "tells Claude why it should continue".
  - After 8 blocks in a row with no tool call in between, Claude Code stops honouring them (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`).
  - Stop "does not run if the stoppage occurred due to a user interrupt".
- **`systemMessage`** is shown to the user on every event unless that event's section says it is discarded. Stop's section says nothing, so it is shown. Phase 3's live check didn't confirm that for Stop, so the release warning moved to UserPromptSubmit ("Why the warning waits for the next prompt").
- **Failures don't block.**
  - A hook that times out "renders no decision".
  - An exit code other than 0 or 2 is a "non-blocking error" and "the action goes ahead".
  - `onFailure: "block"` "has no effect" on Stop and SubagentStop.
  - Command hooks default to a 600 s timeout.
- **SubagentStop's matcher matches the agent type,** a custom agent's frontmatter `name`, here `spec-reviewer`. It also fires for internal agents, whose `agent_type` can be empty.
- **A foreground Agent call** (`run_in_background: false`) fires PostToolUse only after the subagent finishes, with `status: "completed"`, `agentId` and `content` (the subagent's final text). So its SubagentStop `done` line lands before its `start` line, and `tool_response` can quote other doc paths.
- **Stop's input also carries `session_crons[].prompt` and `background_tasks[].description`**, free text of up to 1000 characters.
- **A paste of more than 3 lines or 800 characters** reaches `UserPromptSubmit` wrapped in a `<pasted_content …>` line.
- **The settings docs say moving a session with `/cd` or EnterWorktree** makes Claude Code read project settings from the new folder. A live test on 2026-11-21 contradicts that for EnterWorktree. After EnterWorktree with `path` into `.worktrees/spec-review-gate`:
  - the main folder's spec reminder fired on a Write there;
  - `no-verify-guard.sh` denied a probe `echo`.

  So EnterWorktree keeps the hooks. `/cd` is untested. A Bash `cd` keeps them: this session wrote this spec from that worktree, and the reminder fired.

- **How sessions here reach worktrees:** in the 18 sessions of the three weeks to 2026-11-21, 16 worked in a worktree. Every move was a Bash `cd`; none used EnterWorktree or `/cd`. The only sessions started inside a worktree folder are two from 2026-10-29, in `.worktrees/plugin-gap`.
- **Not documented:** whether a `!` shell command typed by the user goes through PreToolUse hooks.

## Design

### The review log

- **Where:** `.claude/state/spec-reviews.tsv` in the main folder, `F:/dev/strike-calculator`. Sessions started there run their hooks from `$CLAUDE_PROJECT_DIR/.claude/hooks/`, including sessions that move into a worktree with a Bash `cd`, so one log covers all worktrees.
  - The hooks find it from their own location: `<hooks dir>/../state/spec-reviews.tsv`.
  - The pre-commit check finds it from `git rev-parse --git-common-dir`, resolved against the current directory: it prints a relative `.git` in the main folder and an absolute path in a worktree. Its parent is the main folder.
  - `.claude/` is gitignored, so the log is in no public history. The local `.claude` history's exclude file starts with `/*` and un-ignores only a few folders; `state/` stays untracked as long as nobody adds `!/state/`.
- **Format:** one event per line, six tab-separated fields: `epoch  event  session  agent  key  path`. Unused fields are `-`.
  - `epoch`: Unix seconds, from bash's `printf '%(%s)T' -1`.
  - `key`: `specs/<file>.md` or `plans/<file>.md`. The same doc keeps its key across worktrees and after it lands on main. Both folders are flat, and file names use `[A-Za-z0-9._-]`.
    - The Stop gate and the waiver hook skip a line whose key doesn't have that shape. Only a hand edit makes one, and its key would go into the JSON they print.
  - `path`: the doc's full path with forward slashes, or `-`.
- **Events:**

| Event     | Written by                                    | When                                                                                                   | Fields set          |
| --------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------- |
| `write`   | `spec-review-reminder.sh` (PostToolUse Write) | a Write to a spec or plan inside the project folder                                                    | session, key, path  |
| `start`   | `spec-review-record.sh` (PostToolUse Agent)   | an Agent call with `subagent_type` `spec-reviewer`: one line per doc under review (below)              | session, agent, key |
| `done`    | `spec-review-record.sh` (SubagentStop)        | that agent finishes                                                                                    | session, agent      |
| `waive`   | `spec-review-waive.sh` (UserPromptSubmit)     | the owner types the waiver phrase                                                                      | session, key        |
| `block`   | `spec-review-stop.sh` (Stop)                  | the gate blocks a turn end for a doc                                                                   | session, key        |
| `release` | `spec-review-stop.sh`                         | the gate lets a turn end after two blocks                                                              | session, key        |
| `ask`     | `spec-review-stop.sh`                         | a turn ends unblocked because its last message asks the owner for the waiver; once per doc per session | session, key        |
| `announced` | `spec-review-waive.sh`                      | the session's next prompt after a `release` that doesn't start with `<`: the prompt that prints the owner's warning, or that waives the key | session, key        |

- **Writes are appends** of one short line (`printf … >> log`), so concurrent sessions don't need a lock.
- **The `state/` folder** is created once with `mkdir`, with no placeholder file. It is created only once both the `write` recorder and the `start`/`done` recorder exist, so no `write` line is logged in a stretch when reviews can't be. A hook that finds it missing writes one line to stderr and exits 0.
- **Size:** a few lines per doc. No rotation; revisit if the file passes 1 MB.

### Recording

- **Path normalisation**, shared by every recorder:
  - Turn each JSON-escaped backslash pair into `/`, then any single backslash into `/`, as `spec-review-reminder.sh` lines 30–31 do.
  - Compare case-insensitively.
  - A key is the `specs/` or `plans/` folder name plus the file name, taken from a match of `docs/superpowers/(specs|plans)/<name>.md`, where `<name>` uses `[A-Za-z0-9._-]`.
    - No slash is required before `docs/`, so a relative path (`docs/superpowers/specs/x.md`) matches.
    - So does a path that starts a line, where the JSON `\n` before it has become `/n`.
- **`write`** (in `spec-review-reminder.sh`, after the reminder it already prints):
  - It parses `session_id` the way it parses `file_path`. A `"session_id"` key inside written content arrives with escaped quotes, so it can't match.
  - It records only paths under `$CLAUDE_PROJECT_DIR`, normalised the same way. That keeps a probe file in a temp folder out of the log.
    - The value's exact form in a hook process isn't verified, so an MSYS form (`/f/dev/…`) is also turned into `f:/dev/…` before comparing.
    - The Phase 3 live check proves a real Write is recorded.
  - When `CLAUDE_PROJECT_DIR` is unset or empty, it records nothing. Claude's Bash tool doesn't set it, so running the existing reminder test by hand can't touch the real log.
  - The reminder text is unchanged.
- **`start`** (`spec-review-record.sh`, PostToolUse matcher `Agent`):
  - The first check is a bash regex for `"subagent_type"[[:space:]]*:[[:space:]]*"spec-reviewer"` on the raw input. Without it, exit 0.
  - **Keys:** every doc path in the brief, deduplicated.
    - The brief is the first `"prompt"` string value in the raw input, which is `tool_input.prompt`: the probe saw `tool_input` before `tool_response`.
    - Nothing else is scanned. A foreground call's `tool_response.content` holds the reviewer's report, which can cite other docs. An async call's `tool_response.prompt` is a copy.
  - **A plan's brief:** it names the plan and its spec, so when it names any `plans/` key, only the `plans/` keys are recorded. A plan review is not a review of its spec.
  - **No `agentId` in `tool_response`, or no key,** means nothing is recorded.
- **`done`** (`spec-review-record.sh`, SubagentStop matcher `^spec-reviewer$`):
  - The script checks `agent_type` itself as well.
  - It records `agent_id` and nothing else. Whether it counts depends on the matching `start` line.
- **`done` of a named reviewer** (`spec-review-record.sh`, TeammateIdle, no matcher; added 2026-11-22 after a probe, live-checked 2026-11-24):
  - An Agent call with a `name` runs as an agent-team teammate. Its `start` is recorded as above, but its SubagentStop carries `agent_type` = the teammate's name, so the matcher misses it.
  - Its TeammateIdle carries the same `agent_id` as the `start`. When the log has a `start` with that agent id and no `done` for it, one `done` is appended. That lookup stands in for the type check, since only spec-reviewer dispatches get a `start`.
  - A running teammate's `background_tasks` entry has a task id and `"type":"teammate"`, so the Stop gate's "running" test can't see it. A named reviewer falls back to the 45-minute window until its `done` lands.
- **One script for `start` and `done`.** It switches on `hook_event_name`.
- **`start` and `done` pair by agent id in either order.** A foreground reviewer writes its `done` first. Every reader (the Stop gate and the pre-commit check) collects both kinds of line before pairing them, and a `start`'s time is the time the review counts from.

### The Stop gate (`spec-review-stop.sh`)

It runs at every turn end of every session in the project, so its first step is to read the log and exit when this session has no `write` lines.

For each key with a `write` line in this session whose `path` still exists, with `t0` the time of its first `write` in this session:

1. **Settled** when either:
   - a `start` for the key in this session, or at or after `t0` from any session, has a `done` with the same agent id, or
   - a `waive` for the key is in this session or at or after `t0`. The owner can waive before the doc exists.

   A review this session ran before its first `write` counts, as a waiver does. The session that reviews a doc often settles the findings with a Write, and the gate asks for one review per doc per session (Non-goals); a later re-review is the session's judgment.
2. **Running** when a `start` for the key in this session, or at or after `t0`, has no `done` yet, and either:
   - its agent is running: the raw input contains `{"id":"<agent id>","type":"subagent","status":"running"`. A copy of that text inside `last_assistant_message` arrives with escaped quotes, so it can't match.
   - the start is under 45 minutes old.

   This lets Claude end a turn to wait for the reviewer.

3. **Asking** when `last_assistant_message`, normalised, contains `waive review` and names the key anywhere, and this session has no `ask` line for the key yet.
   - **Why:** Claude has asked the owner for the waiver, and the owner has to be able to answer. The turn ends without a block counted, and the gate writes an `ask` line.
   - **Once per doc per session** (owner, 2026-11-21: every waiver request is a decision). A second request for the same key doesn't exempt its turn; that turn is unsettled as usual. So an unanswered request leads to the normal blocks and then the owner's warning. The owner answers by typing the phrase or by telling Claude to run the review.
   - One request naming two keys covers both.
   - The check reads only that one field, cut out of the raw input with the same quoted-string regex as `file_path`. `session_crons[].prompt` and `background_tasks[].description` are free text too, and either could otherwise exempt the turn.
   - When a key has `write` lines at two paths (one file name in two worktrees), the session's latest `write` decides whether the doc still exists, and its path goes in the reason.
4. **Released** when a `release` line exists for this session and key. The gate already let it go, and the owner is warned at the next prompt.
5. Otherwise **unsettled**.

For the unsettled keys:

- **Under two `block` lines** for this session and key: write a `block` line and add the key to the block reason.
- **Two or more:** write a `release` line. The turn end prints nothing for that key. The owner's warning goes out at the session's next prompt (The waiver, "Release warnings").
- **One JSON object**, `decision` `block` with `reason`, when any key blocks. Otherwise no output, unless the log can't be written (below).
- **The reason**, for Claude:
  > spec-review gate: `<key>` (`<path>`) was written in this session and has had no spec-reviewer run since. Dispatch the spec-reviewer agent (model opus) with only the doc's path (for a plan, also its spec's path), then settle its findings (CLAUDE.md, Plan First). If the owner said to skip the review, ask them to type `waive review <key>` and end your turn; the first turn whose last message asks for that isn't blocked, and a second request is. This is block N of 2; after that the gate lets the turn end and tells the owner the doc went unreviewed.
- **The warning**, for the owner, printed by `spec-review-waive.sh` at the next prompt:
  > spec-review gate: `<key>` was handed over without an adversarial review (the gate blocked twice, then let go). Ask Claude for the review, or type `waive review <key>` to accept the doc as it is.
- **When the log can't be written,** the gate fails open. It says why on stderr, and tells the owner in a `systemMessage` in the same object, one line per key. This is the Stop channel the owner couldn't confirm seeing (below), but it's the only one left.
  - **A `block` line it can't write:** the key doesn't block. A block the gate can't count would repeat every turn and never reach the release. The owner sees:
    > spec-review gate: `<key>` was handed over without an adversarial review, and the gate could not write the review log, so it let the turn end instead of blocking. Ask Claude for the review, or type `waive review <key>` to accept the doc as it is.
  - **A `release` line it can't write:** the waiver hook would find nothing to announce, so the Stop prints the owner's warning itself: the text above, then one sentence. The next turn end tries the release again.
    > The gate could not write the review log, so it prints this warning at the turn end instead of at your next prompt.
  - **An `ask` line it can't write:** the turn is still exempt.

**Why the warning waits for the next prompt.** Phase 3's live check (2026-11-24) printed it from the Stop hook as a `systemMessage`. Claude Code's transcript recorded it as a hook message, but the owner couldn't confirm seeing it on screen. The waiver hook's `systemMessage` (UserPromptSubmit) was confirmed on screen in Phase 2's live check. So the warning goes out through `spec-review-waive.sh` at the owner's next prompt instead, with an `announced` event so it prints once.

### The waiver (`spec-review-waive.sh`, UserPromptSubmit)

- **The phrase:** a prompt that starts with `waive review`, in any case and after leading spaces, followed by one or more doc paths or keys. Example: `waive review specs/2026-11-20-gexbot-after-close-design.md`.
  - It must start the prompt. A subagent's hand-back starts with `<agent-message`, so a report can't trigger it by quoting the phrase.
  - **Only the docs listed right after the phrase are waived** (owner, 2026-11-24). Each one gets a `waive` line. A full path works too, with either slash.
    - The list is keys or paths separated by spaces, line breaks, commas, semicolons, colons, `&` or the word `and`. A drive letter's colon (`F:/…`, `F:\…`) belongs to its path. A key may sit in backticks or quotes.
    - A key may end with a sentence period. The period ends the list after that key: `waive review specs/a.md. plans/b.md can wait` waives only `specs/a.md`.
    - The first word that isn't a key or a separator ends the list. A doc named after it isn't waived: `waive review specs/a.md, then look at plans/b.md` waives only `specs/a.md`.
    - A path with a space in it ends the list at the space. Use its key instead.
  - It is typed on one line. Several keys can share that line.
    - A paste of more than 3 lines or 800 characters arrives wrapped in `<pasted_content …>`, so it doesn't start with the phrase.
    - It then gets the "nothing waived" message, so the miss is visible.
- **Output:** a `systemMessage` naming what was waived, so a waiver nobody typed would be seen. It also passes `additionalContext` telling Claude the gate won't block on those keys. A phrase with no key right after it gets a `systemMessage` saying nothing was waived.
  - A doc the prompt names after the list is named in both, as not waived, with what to type to waive it. That holds when the list is empty too.
- **Release warnings.** At every prompt that doesn't start with `<` (after the same leading-space strip as the phrase), the hook looks for `release` lines of this session that have no `announced` line for the same session and key.
  - A prompt that starts with `<` is a harness wrapper: a subagent's hand-back, a task notification, a message from another session. The owner may not be looking at it, so it prints no warning and writes no `announced` line, and the next prompt that doesn't start with `<` prints it. A paste wrapped in `<pasted_content …>` waits one prompt too. (Live, 2026-11-25: the first prompt after the hook went live was a hand-back, and it spent the probe's warning there.)
  - Each such key gets the owner's warning (the text under "The Stop gate") in `systemMessage`, the same text in `additionalContext` so Claude knows what the owner was just told, and one `announced` line.
  - A key that the same prompt waives gets its `announced` line and no warning, since the waiver message already names it.
  - If the `announced` line can't be written, the warning still prints, and prints again at the next prompt. A repeat beats a lost warning.
  - The warnings join the waiver's own messages in the one JSON object the hook prints, one warning per line.
  - Fast path: when this session's `release` lines and its `announced` lines are equal in number, nothing is pending, and the lookup ends after one read of the log, with no per-line loop. Each key gets at most one `release` line per session, and each `release` at most one `announced` line, so equal counts mean every warning went out. Every prompt of every session pays this check.
  - A prompt that starts with `<` is found by an anchored match on the raw input, without cutting out the prompt field, so a 1 MB hand-back costs little.
- **The phrase anywhere but the start** of a prompt that doesn't begin with `<` (a harness wrapper) gets a `systemMessage`: nothing was waived, the phrase must start the prompt, and here are the prompt's first 60 characters. If the owner's client puts something before the typed text, this shows what.
- **Keys** are read by a matcher used only by the waiver, which accepts a bare `specs/x.md` as well as a full path. The `start` recorder keeps the strict `docs/superpowers/…` match.
- **Channels Claude controls:** a scheduled task, a `/loop` iteration and a message from another session all fire `UserPromptSubmit`, possibly with plain text Claude wrote. The guard denies CronCreate, ScheduleWakeup, RemoteTrigger and SendMessage when their input contains `waive review`. SendMessage is covered because agent teams are on (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`).
- **Why not a script the owner runs with `!`:** the docs don't say whether a typed `!` command goes through PreToolUse hooks. If it does, the guard that keeps Claude off the waiver script would block the owner too. A typed phrase works either way.

### Keeping Claude out of the log

- **File tools:** a `permissions.deny` rule, `Edit(//**/.claude/state/**)`, in `.claude/settings.json`. Edit path rules cover every file-writing tool (Edit, Write, NotebookEdit), and a deny rule needs no script. Reading the log with the Read tool stays allowed.
- **The guard, `spec-review-guard.sh`** (PreToolUse), denies with `permissionDecision: "deny"` and a reason that points at the waiver:
  - **Bash or PowerShell** whose command text names `spec-reviews.tsv` or `.claude/state` (either slash, case-insensitive).
    - Bash's `if` filter strips redirects before matching (`env-shell-guard.sh`, probe 2026-10-26), so the script runs on every shell command, with a bash-only substring test as its first line.
    - It denies any mention, including a commit message that names the log. Commands and commit messages for this work say "the review log" instead, as `no-verify-guard.sh` already requires for its own word.
  - **CronCreate, ScheduleWakeup, RemoteTrigger and SendMessage** whose input contains `waive review`, case-insensitive.
- **It fails open** (`onFailure: "continue"`). A missing guard only makes a forgery possible. A broken guard on `onFailure: "block"` would stop every shell command in every session.

### The pre-commit backstop

- **`.githooks/pre-commit`** keeps its `CLAUDECODE=1` early exit, so only Claude Code commits are checked.
- **New step,** before the review-gate check:
  1. Skip it when the commit replays existing commits: `MERGE_HEAD`, `CHERRY_PICK_HEAD` or `REVERT_HEAD` exists, or a rebase is in progress (`rebase-merge/` or `rebase-apply/` in the git dir). A merge from main lists every doc main added since the branch last synced, and those docs belong to other sessions or predate the log.
  2. List the staged paths that the commit adds under `docs/superpowers/specs/` or `docs/superpowers/plans/` and end in `.md`: `git --no-literal-pathspecs diff --cached --no-renames --name-only --diff-filter=A`, limited to those folders by the pathspecs `:(glob,icase)docs/superpowers/specs/**/*.md` and `:(glob,icase)docs/superpowers/plans/**/*.md`. The explicit `glob` magic and `--no-literal-pathspecs` keep git's global settings (`GIT_LITERAL_PATHSPECS`, `GIT_NOGLOB_PATHSPECS`, `GIT_GLOB_PATHSPECS`) from emptying the list or dropping a doc in a subfolder. A doc moved in from `docs/tmp/` shows as added anyway, since git applies the pathspec before it looks for renames. `--no-renames` makes a rename inside `specs/` or `plans/` show as added too.
  3. Only when there are some, run `node scripts/spec-review-check.mjs <paths>`.
- **`scripts/spec-review-check.mjs`** reads the log and blocks (exit 1) when an added doc's key has neither:
  - a completed review: a `start` and a `done` for one agent id, nor
  - a `waive`.

  The block message names each doc and both fixes: run the spec-reviewer, or the owner types the waiver phrase. A missing log blocks, naming the file. Any other error blocks too, as with the review gate. A line it can't parse is skipped.

  - **A doc with no key blocks too:** a name outside `[A-Za-z0-9._-]`, such as one with a space. No hook can record a review or a waiver for it, so passing it would let a file name dodge the gate. The message tells Claude to rename it.
  - **The waiver phrase in the message** names every blocked key, separated by spaces, because the waiver reads a list.
  - **A non-ASCII name** may reach the check quoted, through git's `core.quotepath`. It has no key either way, so it blocks.

- **Node builtins only,** for both `scripts/spec-review-check.mjs` and `scripts/_lib/spec-review-log.mjs`. The hook runs them in worktrees that may have no `node_modules`, the same reason `scripts/_lib/git-run.mjs` gives for the review gate.
- **Only added docs.** A later commit that changes a doc (an "As built" note, a checked box) passes, as the rule says.
- **No time condition.** A commit can't tell when the doc was written, so any recorded review counts.
- **What it catches that Stop doesn't:**
  - a doc written with a shell command;
  - a doc a session created with Edit, if Edit can create files;
  - a doc from a session whose Stop hook timed out;
  - a doc released after two blocks.

### Settings (`.claude/settings.json`)

Each new hook is a `command` hook on `"$CLAUDE_PROJECT_DIR"/.claude/hooks/<script>`, timeout 30, added beside the existing groups:

- **PostToolUse**, matcher `Agent`: `spec-review-record.sh`.
- **SubagentStop**, matcher `^spec-reviewer$`: `spec-review-record.sh`.
- **TeammateIdle**, no matcher: `spec-review-record.sh`.
- **Stop**, no matcher: `spec-review-stop.sh`.
- **UserPromptSubmit**: `spec-review-waive.sh`.
- **PreToolUse**, matcher `Bash|PowerShell|CronCreate|ScheduleWakeup|RemoteTrigger|SendMessage`, `onFailure: "continue"`: `spec-review-guard.sh`.
- **`permissions.deny`**: `Edit(//**/.claude/state/**)`.

`settings.json` holds other sessions' uncommitted edits, so each phase adds only its own entries, and the local-history commit stages only those hunks.

## Known limits

- **Hooks constrain actions, not thinking.** The gate proves a reviewer ran; it can't prove its findings were settled.
- **A deliberate workaround still works.** Each one leaves a trace in the transcript or the local `.claude` history, and every waiver shows the owner a `systemMessage`. The aim is that a skip is never silent.
  - The known workarounds are listed in `spec-review-guard.sh`'s header comment, local-only in `.claude/`.
  - They aren't listed here, by owner decision on 2026-11-21: this doc is public, and every session reads it.

- **A reviewer stopped mid-run** may still fire SubagentStop and count as done. That isn't known; the probe saw only normal ends.
- **A hook that times out** doesn't block: Claude stops, or the tool runs, as normal. The bash-only scripts and 30 s timeouts make this rare, and the pre-commit check backs up the Stop gate.
- **A doc created with Edit, or by a shell command,** gets no `write` line and no Stop block. Only the pre-commit check sees it.
- **A session started inside a worktree folder** has no project hooks: that worktree's `.claude/` holds only `skills/`. A session moved there with `/cd` may be the same; the docs say so, but it is untested. EnterWorktree and a Bash `cd` keep the hooks (Facts). Such a session gets no Stop gate, no guard and no deny rule. The env guards are missing too, since they live in the same settings file. This has happened twice, both on 2026-10-29. Its writes aren't recorded, it can't record a waiver, and its spec commits are blocked by the pre-commit check. The owner can waive from a main-folder session, or commit from their own terminal.
- **Renaming a reviewed doc** makes the new name an added doc with no log lines, so its commit needs a waiver.
- **A Write that only records status** on a doc from an earlier session counts as a new write and asks for a review. Status edits should use Edit; otherwise the owner waives it.
- **Appends from concurrent sessions** are assumed not to interleave, since each is one short line. That isn't tested on Cygwin bash.
- **Docs written before this ships** have no log lines. Committing one with Claude after Phase 5 needs a waiver. Uncommitted on 2026-11-21:
  - `specs/2026-11-20-gexbot-after-close-design.md` (two review rounds, 2026-11-20 and 21);
  - `specs/pinets-evaluation-2026-11-12.md`;
  - `specs/2026-11-06-reader-rate-limits.md`;
  - `specs/server-snapshot-capture-2026-11-14.md`;
  - `plans/2026-11-16-server-snapshot-capture.md`.
- **Scope (owner, 2026-11-21: leave both open):** two kinds of redesign are never gated.
  - A later session that redesigns a committed spec with Edits is never gated. Edits make no `write` line, and the pre-commit check sees only added docs.
  - `/clear` starts a new `session_id`, so a doc written before it is no longer gated by Stop.
- **A release warning can go unseen.** It waits for the session's next prompt that doesn't start with `<`. A `/loop` iteration or a scheduled task with plain text is such a prompt, so the warning prints there, maybe while the owner is away. After `/clear` the session id changes, and a pending warning is never shown. The pre-commit check still blocks the doc's commit.
- **A hand-edited log can hide or slow a warning.** The fast path compares counts, so a stray `announced` line hides one pending warning. A `release` line with a key that isn't a doc key never gets its `announced` line, so every later prompt of that session pays the full lookup (about 0.2 s at 5,000 lines). Neither can happen without a hand edit: the hooks write `announced` only after a `release`, and `release` only for doc keys.
- **Same-named docs in two worktrees share a key.** A review or waiver of one settles the other, at the Stop gate (same session) and at the commit (any time). Dated file names make this rare.
- **The guard and the deny rule match any `.claude/state` folder,** Claude Code's own one in the home directory included. Read it with the Read or Grep tools.
- **A background subagent that Writes a spec or plan** gets its parent blocked at the parent's next turn end, while the subagent may still be writing. A `write` line's agent field is `-`, so the gate can't tell who wrote it.
- **A named (teammate) reviewer that runs past 45 minutes** gets one block that asks for a review already running. Its `background_tasks` entry carries a task id, not the agent id (Recording).
- **A release warning can be stale.** It still prints when the doc was reviewed between the release and the owner's next plain prompt.
- **A worktree branched before this shipped runs its own older `.githooks/pre-commit`,** because `core.hooksPath` is relative and resolves per worktree. Its doc commits get no check until it takes main.
- **A Write to an upper-case folder spelling** (`Docs/Superpowers/…`) may not fire the reminder. Its `if` filter, `Write(//**/docs/superpowers/**)`, hasn't been tested for case on Windows, where that path reaches the same folder. If the filter misses, the doc gets no `write` line and no Stop block. The commit check's case-insensitive listing still blocks it. An upper-case file name (`X.MD`) isn't affected, since the filter sees only the folders.

## Phases

Each phase is shippable on its own, ends with its tests passing, and touches at most five files.

1. **Recorders.**
   - `mkdir .claude/state`.
   - `write` lines from the reminder hook, plus `spec-review-record.sh` for `start` and `done`.
   - Settings entries.
   - Tests.
   - After this phase, reviews are recorded and nothing blocks yet.
2. **Guard and waiver.**
   - `spec-review-guard.sh` and `spec-review-waive.sh`.
   - The deny rule and the guard's settings entry.
   - Tests.
   - A live check: Claude's own Write or Edit under `.claude/state/` is denied.
   - The owner types the waiver phrase once, which confirms it reaches the hook from the owner's client. Phase 3 waits for this, because the Stop gate needs a working waiver.
3. **Stop gate.**
   - `spec-review-stop.sh` and its settings entry.
   - Tests.
   - A live check in this session: write a throwaway spec under a name not used before in the session, and let the gate block twice. Confirm the owner sees the release warning; if the owner doesn't, add the fallback announcement to `spec-review-waive.sh`. Then delete the throwaway spec. Outcome, 2026-11-24: not confirmed, so the warning moved to the waiver hook ("Why the warning waits for the next prompt").
   - It comes after the waiver, so the owner can always unblock a session.
4. **Pre-commit check (tracked, in the worktree).**
   - `scripts/_lib/spec-review-log.mjs`: parsing the log and the decision, pure functions.
   - `scripts/spec-review-check.mjs`: the command-line wrapper.
   - The library test.
   - A CLI test listed in the vitest `spawn` project.
   - `npm run review`, then commit.
5. **Wire and document.**
   - The `.githooks/pre-commit` step.
   - Its hook cases in `scripts/_lib/spec-review-check.cli.test.mjs`. They run the real hook through `initRepo` and `claudeCommit` in `scripts/_lib/review-gate.fixtures.mjs`, and assert on the spec check's own message, since the review gate runs after it.
   - CLAUDE.md's adversarial-review bullets: say the gate enforces the rule, and give the waiver phrase, typed on one line.
   - The agents-md skill's hook table.
   - An "As built" note here.

This spec and its plan are committed before Phase 5, so the new check never sees them.

## Files

- **Phase 1** (six files, so the plan runs it as two tasks of at most five):
  - `.claude/hooks/_spec-review-lib.sh` (new): the parsing every spec-review hook shares (path normalisation, JSON string fields, doc keys, log appends), sourced, bash builtins only
  - `.claude/hooks/spec-review-reminder.sh` (edit)
  - `.claude/hooks/spec-review-record.sh` (new)
  - `.claude/hooks/tests/spec-review-gate.test.mjs` (new; later phases add cases)
  - `.claude/hooks/tests/spec-review-reminder.test.mjs`: runs the hook with `CLAUDE_PROJECT_DIR` removed from its env. Its new "writes nothing" case runs on a temp copy with a `state/` folder and asserts no log file appears; a check against the real log would race other sessions.
  - `.claude/settings.json`
- **Phase 2:**
  - `.claude/hooks/spec-review-guard.sh`
  - `.claude/hooks/spec-review-waive.sh`
  - the gate test
  - `.claude/settings.json`
- **Phase 3:**
  - `.claude/hooks/spec-review-stop.sh`
  - the gate test
  - `.claude/settings.json`
  - `spec-review-waive.sh` (the release warnings; the fallback was needed)
- **Phase 4:**
  - `scripts/_lib/spec-review-log.mjs`
  - `scripts/_lib/spec-review-log.test.mjs`
  - `scripts/spec-review-check.mjs`
  - `scripts/_lib/spec-review-check.cli.test.mjs`
  - `vite.config.ts` (`SPAWN_TEST_FILES`)
- **Phase 5:**
  - `.githooks/pre-commit`
  - `scripts/_lib/spec-review-check.cli.test.mjs` (hook cases; already in `SPAWN_TEST_FILES`)
  - `CLAUDE.md`
  - `.claude/skills/agents-md/SKILL.md`
  - this spec

The `.claude/` files commit to the local `.claude` history; the rest commit in `.worktrees/spec-review-gate` and land on main.

## Tests

The hook tests extend the existing pattern in `.claude/hooks/tests/spec-review-reminder.test.mjs`: Node spawns `bash <hook>` with a synthetic payload on stdin. Each case copies the hooks into a temp folder laid out like `.claude/` (`hooks/`, `state/`) and sets `CLAUDE_PROJECT_DIR` to a fake project path, so the hooks write a throwaway log. No env var or flag redirects the log.

Cases that must exist:

- **Recorders:**
  - **Write:**
    - inside the project folder → `write` line; outside → none;
    - a Windows backslash path → forward slashes;
    - `CLAUDE_PROJECT_DIR` unset → none;
    - a subagent's Write (`agent_id` present) → recorded under the parent `session_id`;
    - a `session_id` key inside the written content can't replace the real one.
  - **Agent call with `spec-reviewer`, by what its brief names:**
    - one spec, with a forward-slash path, an `F:\…` path (doubled backslashes in the raw JSON), a relative `docs/superpowers/specs/x.md`, or a path that starts a line → recorded;
    - a foreground payload (`status: "completed"`) whose `content` names another spec and a plan → only the brief's keys;
    - two specs → both;
    - a duplicate → one line;
    - a plan and its spec → only the plan;
    - no doc → nothing;
    - `"subagent_type": "spec-reviewer"` with spaces → recorded.
  - **Agent call of another type** → nothing.
  - **SubagentStop:** `spec-reviewer` → `done`; another type → nothing.
- **Stop:**
  - **Silent:**
    - no writes this session;
    - another session's writes;
    - the reviewer is running per `background_tasks`;
    - reviewed (a `start` after `t0` plus its `done`), including a `done` logged before its `start` (a foreground reviewer);
    - reviewed earlier in this session, before its first `write`, then rewritten with Write;
    - waived;
    - the doc was deleted;
    - an empty or malformed payload, or a missing log (exit 0);
    - released, with or without an `announced` line.
  - **Block:**
    - written and unreviewed → block 1, then block 2, then release (a `release` line, no output), then silent;
    - started 50 minutes ago, no `done`, not running → block;
    - the running pattern appears only inside `last_assistant_message` → not running, block;
    - reviewed in an earlier session, before this session's first write → block.
  - **Asking:**
    - `last_assistant_message` asks for `waive review <key>` → silent, with no block counted, and an `ask` line written;
    - a second request for the same key in the same session → block 1, no new `ask` line;
    - a request for another key after the first key's `ask` → that key is still exempt once;
    - the phrase only in a `background_tasks` description or a `session_crons` prompt → block.
  - **Two docs:**
    - one reviewed → the block names only the other;
    - one at block 1 and one at block 2 → `decision` and `reason` naming only the first, and a `release` line for the second.
- **Waiver:**
  - **Records:**
    - the phrase with a key;
    - with a full Windows path;
    - with two keys;
    - with a list joined by commas and `and`;
    - in upper case.
  - **Records only the list:**
    - `waive review specs/a.md, then look at plans/b.md` → `specs/a.md` only, and both messages name `plans/b.md` as not waived.
  - **Records nothing:**
    - the phrase in mid-prompt;
    - an `<agent-message …>` prompt quoting the phrase;
    - the phrase with no key, which prints "nothing waived";
    - the phrase, other words, then a key → "nothing waived", naming that key as not waived.
  - **Release warnings:**
    - a `release` line with no `announced` line, and a plain prompt → the warning in `systemMessage` and `additionalContext`, one `announced` line; the next prompt → silent;
    - another session's `release` → nothing;
    - two released keys → both warnings, two `announced` lines;
    - the prompt waives a released key → its `waive` and `announced` lines and the waiver message, no warning;
    - a released key plus a waiver of another key → both messages in one object;
    - the `announced` line can't be written → the warning prints, and prints again at the next prompt;
    - a prompt that starts with `<` (an `<agent-message …>` hand-back) → no warning and no `announced` line; then a plain prompt → the warning and one `announced` line;
    - a prompt that starts with spaces and then `<` → the same as `<`.
- **Guard:**
  - **Deny:**
    - Bash `echo x >> .claude/state/spec-reviews.tsv`;
    - Bash with a backslash path;
    - PowerShell `Add-Content … spec-reviews.tsv`;
    - CronCreate or SendMessage whose input has `waive review`.
  - **Silent:** an ordinary Bash command, and SendMessage without the phrase.
- **Settings wiring:** each hook is in its group with its matcher, `if` and timeout, and the deny rule is present.
- **Pre-commit check:**
  - **Library (vitest):**
    - added doc with a review → pass; with a waiver → pass;
    - a `start` with no `done` → block; a `done` with no `start` → block;
    - a `done` before its `start` → pass;
    - a key the log doesn't have → block, naming the doc;
    - a corrupt line → skipped.
  - **CLI (spawned, temp git repo):**
    - a missing log → block, naming the file;
    - an added unreviewed doc → exit 1;
    - a reviewed one → exit 0.
  - **Hook (spawned, real `.githooks/pre-commit`, Phase 5):**
    - an added unreviewed doc → blocked;
    - a modified doc → passes the spec check;
    - a doc moved in from `docs/tmp/` → counted as added;
    - `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` or `rebase-merge/` present → skipped;
    - no docs → falls through to the review gate (the existing review-gate tests cover this too).

## Constants

- **Two blocks** per doc per session before release.
- **45 minutes:** how long a started review with no `done` counts as running when `background_tasks` doesn't list it. A review takes about 15–20 minutes.
- **30 s** timeout on every new hook.

## Left to the builder

- How the Stop hook reads the log (one pass with `while IFS=$'\t' read -r`, building bash associative arrays, is the expected shape).
- The exact error text, within the meanings above.

## Review rounds

**Round 1 (spec-reviewer, 2026-11-21): verdict revise, 13 findings.** All but one are settled here:

- **A real review would have gone unrecorded.** A brief's Windows path arrives with doubled backslashes; the `start` normalisation now follows the reminder hook, with tests.
- **A turn that both blocked and released lost the warning for good.** Now one JSON object carries both, and `release` is written only when its warning prints.
- **Phase 1 had six files.** `start` and `done` became one script, the placeholder file was dropped, and the old Phase 4 split into a check phase and a wiring phase.
- **A plan review counted as a review of its spec.** Now a brief naming a plan records only the plan.
- **Merge commits would have blocked on other sessions' docs.** The check now skips during a merge, cherry-pick, revert or rebase, and `--no-renames` catches a doc moved in.
- **SendMessage could carry a forged waiver.** The guard covers it.
- **Asking the owner for a waiver used up both blocks.** The "asking" state now lets that turn end without a block.
- **An unset `CLAUDE_PROJECT_DIR` could have let the old reminder test write the real log.** Now it records nothing.
- **Smaller corrections:** the list of pre-gate docs, what the local history tracks, the guard denying commit messages that name the log, and `systemMessage` being documented for Stop.
- **File tools are now kept out of the log by a deny rule,** not a hook script.
- **The owner's call (answered 2026-11-21, "leave both open"):** whether the gate should reach Edit-only redesigns and docs written before `/clear` (Known limits, "Scope").

**Round 2 (spec-reviewer, 2026-11-21): verdict revise, 11 findings, all settled here:**

- **A foreground reviewer logs `done` before `start`, and its report can cite other docs.** Now `start` and `done` pair by agent id in either order, and keys come only from the brief.
- **A relative path in a brief** (`docs/superpowers/specs/x.md`) matched no key. Now the match needs no slash before `docs/`.
- **The pre-commit step had only a live check,** which would have left a throwaway commit. Now hook cases run the real hook in a temp repo, through the review-gate fixtures.
- **The "asking" check** now reads only `last_assistant_message`.
- **`CLAUDE_PROJECT_DIR`** is normalised from its MSYS form too, and the Phase 3 live check proves a real Write is recorded.
- **The reminder test's new case** runs on a temp copy, not against the real log.
- **Node builtins only** for the check script and its library.
- **The waiver phrase** is typed on one line.
- **New known limits:** renaming a reviewed doc needs a waiver; one more workaround, now in the local list.
- **The reviewer's claim that `/cd` and EnterWorktree drop the hooks** came from the docs. A live test on 2026-11-21 showed that EnterWorktree keeps them; `/cd` is untested (Facts).

No third round: the rule allows two. Nothing is left open.

**Owner change (2026-11-21), after a side agent pointed out that asking for a waiver every turn would keep the gate from ever firing:** "treat every waiver request as a decision". The asking exemption now applies once per doc per session (Stop gate, step 3, and the `ask` event).

**Owner change (2026-11-24), after a side agent pointed out that a waiver prompt waived every doc it named, so mentioning a second doc skipped its review too:** "yeah lets adjust this". Only the docs listed right after the phrase are waived. A doc named after other words isn't, and the messages name it as not waived (The waiver; Testing).
