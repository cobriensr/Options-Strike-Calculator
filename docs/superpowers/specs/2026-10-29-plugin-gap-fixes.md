# Plugin, skill and MCP gap fixes (2026-10-29)

## Goal

Act on the 2026-10-29 transcript audit. Remove the unused and duplicate plugins and skills. Make the installed language servers and the Unusual Whales MCP actually load. Add the GEXBot and R2 skills that agents keep improvising. Stop two hooks timing out when many sessions run at once. Hand the agent findings to the skill cleanup that is already running.

## Status

| Phase | State | Record |
|---|---|---|
| 1 remove unused/duplicate plugins and skills | queued | – |
| 2 language servers | queued | – |
| 3 MCP servers (UW, Neon read-only) | queued; 3b waits on owner | – |
| 4 hook timeouts | queued | – |
| 5 `gexbot-api` skill | queued | – |
| 6 `r2-storage` skill | queued | – |
| 7 Unity projects | queued | – |
| 8 lost-question rule | queued | – |

## Evidence

The audit covered all 42 strike-calculator sessions (about 540 subagent transcripts) and mecha-ttrpg. The scripts and raw counts are local-only in `docs/tmp/plugin-gap-audit-2026-10-29/` (gitignored, since they quote session text). ✓ marks a count the main session re-checked against the transcripts or the machine.

- **Unused:**
  - `pr-review-toolkit`: 0 agent dispatches and 0 skill uses ✓.
  - `chrome-devtools-mcp`: 0 calls, against 69 Playwright MCP calls ✓.
  - `code-review` plugin skill: 0 uses ✓.
  - `claude-code-guide`: 0 dispatches, against about 12 owner questions about the harness ✓.
- **Language servers can't start:** `typescript-language-server`, `pyright-langserver` and `csharp-ls` are not on PATH ✓. `gopls` and `rust-analyzer` are.
- **Unusual Whales MCP:** `.vscode/mcp.json` runs the official `@unusualwhales/mcp` 1.2.0 ✓. There is no `.mcp.json`, so Claude Code never loads it. Agents made about 195 raw curl calls to UW instead.
- **GEXBot:** about 100 doc fetches and API probes, and there's no skill. UW has two.
- **R2:** 52 ad-hoc boto3 script runs and about 14 owner asks, with no tool.
- **Hook timeouts on 10-29:**
  - `env-shell-guard` 32. It is a shell wrapper over `env-shell-guard.py`, so every Bash call starts Python.
  - `no-verify-guard` 17, already fixed in local history `11390e0`.
  - `git-context.sh`, reported by the owner.
- **Neon MCP:** the plugin's server (`https://mcp.neon.tech/mcp`) runs in write mode against the production database. Neon supports `?readonly=true` ✓ (neon.com/docs/ai/neon-mcp-server, "Read-only mode").
- **Agents:**
  - 144 implementer and 77 read-only research dispatches went to `general-purpose`, with median briefs of about 5K and 3.9K characters.
  - 38 spec-plus-quality reviews went to `general-purpose`.
  - Specialists were bypassed 13 times.

## Ownership: what this plan does not do

- **`skill-cleanup-2026-10-28.md` phases 6–7** own these:
  - agent fixes and the `codebase-scout` deletion;
  - the `implementer` and `verifier` agents;
  - `watch-deploy`, `review-summary` and the status view.

  This plan doesn't edit `.claude/agents/` or that spec. What this audit adds is in "Handoff to skill cleanup" below.
- **The GEXBot EOD capture design** owns the Node R2 client and committing the rescue script under `scripts/`.
- **Not adding:**
  - Axiom MCP (25 calls in total), Upstash, `hookify`, `claude-security`, `duckdb-skills`.
  - `gopls-lsp` and `rust-analyzer-lsp` stay installed and disabled: their binaries exist, but no Go or Rust project is known.

## Safety

- **Backup before phase 1.** Copy `~/.claude/settings.json`, `~/.claude/plugins/{installed_plugins,known_marketplaces,blocklist}.json` and `~/.claude/skills/` to `~/.claude/backups/2026-10-29-plugin-gap/`. An uninstall is undone with `claude plugin install <name>@claude-plugins-official`.
- **Where changes are recorded.** `.claude/` changes go in the local-only history: `git --git-dir="$HOME/.claude/config-history/strike-calculator-dotclaude.git"`. Tracked files go on main.
- **The UW key.** A script reads it from `.env.local` and passes it to `claude mcp add` as an argument array. It is never echoed, and never appears in a command line the transcript records.
- **Running sessions.** Open sessions keep their loaded plugins. Changes apply to new sessions.

## Phases

One implementer at a time. The main session checks each phase against this spec before the next one starts. Phase 4 is code, so it gets the full Get It Right loop. The skill phases (5, 6) get a reviewer that checks every claim against the docs and the code.

### Phase 1: remove unused and duplicate plugins and skills (user config)

- **Uninstall** at user scope:
  - Unused or duplicated: `pr-review-toolkit`, `chrome-devtools-mcp`, `code-review`, `code-simplifier`, `skill-creator`, `commit-commands`.
  - Already disabled: `terraform`, `agent-sdk-dev`, `claude-code-setup`, `explanatory-output-style`, `plugin-dev`, `feature-dev`, `ralph-loop`, `security-guidance`, `github`.
- **`vercel` plugin:** set `enabledPlugins` to false at user level, and keep it installed. It has had zero uses, and it injects about 8K characters at every session start.
- **Duplicate user skills:**
  - Delete `~/.claude/skills/use-railway` once a diff shows the plugin's `railway:use-railway` is the same or newer.
  - Delete `~/.claude/skills/context7-mcp`; `~/.claude/rules/context7.md` carries the same rule.
- **Clutter:**
  - the `temp_git_*` folders in `~/.claude/plugins/cache`;
  - `enabledPlugins` entries for plugins that were never installed;
  - the `code-review` test entry in `blocklist.json`.
- **References:** grep `CLAUDE.md`, `~/.claude/CLAUDE.md`, memory, `.claude/agents`, `.claude/skills` and `.claude/hooks` for every removed name. Fix references in files this plan owns. List the rest for the handoff.
- **Verify:**
  - `claude plugin list` shows none of the removed plugins.
  - A fresh headless session (`claude -p`) lists no `pr-review-toolkit` agents and no `chrome-devtools` tools.

### Phase 2: language servers

- Run `npm i -g typescript-language-server typescript pyright`.
- Enable `typescript-lsp` and `pyright-lsp` at user level.
- **Verify:**
  - both binaries resolve on PATH;
  - a headless probe shows the language-server tool answering in this repo (a TS file in `src/` and a Python file in `ml/src/`).
- C# is set up in phase 7.

### Phase 3: MCP servers

- **3a, Unusual Whales:**
  - A script in the session scratchpad, not the repo, reads `UW_API_KEY` from `.env.local` and runs `claude mcp add --scope local unusual-whales -e UW_API_KEY=… -- npx -y @unusualwhales/mcp`.
  - Check the Claude Code docs for whether native Windows needs a `cmd /c` wrapper for `npx`.
  - Local scope keeps the key out of the public repo.
  - **Verify:** `claude mcp list` shows the server connected, and a headless probe calls one read endpoint.
  - Update the memory `project_uw_key_two_places.md`: the key now lives in three places.
- **3b, Neon read-only** (waiting on the owner):
  - Add a user-scope HTTP server `neon-readonly` at `https://mcp.neon.tech/mcp?readonly=true`.
  - Add the plugin's Neon server to `deniedMcpServers`. Read the exact server name from `claude mcp list`.
  - The owner authenticates once via `/mcp`.
  - Writes to production go through reviewed scripts.
  - **Verify:** a fresh session has no Neon write tools.

### Phase 4: hook timeouts (code: full loop)

- **`env-shell-guard.sh`:** add a prefilter that exits 0 before starting Python when the command text contains no `.env`. Real matches still block (fail closed).
- **`git-context.sh`:** bound its git calls (`--no-optional-locks`, plus a time limit). Print one line, "git state unavailable", instead of hanging.
- Follow the fail-open-under-load change in local history `11390e0` for structure, not policy. This guard must stay closed on a real match.
- **Test:**
  - a case table for the prefilter, covering `.env` writes that are blocked and ordinary commands that pass;
  - timing for 10 parallel runs before and after.
- Commit in the local-only history.

### Phase 5: `gexbot-api` skill

- **File:** `.claude/skills/gexbot-api/SKILL.md`, at most 300 lines, modeled on `unusual-whales-api`.
- **It covers:**
  - where the docs.gexbot.com docs are;
  - the auth env var name;
  - plan and rate limits;
  - the endpoints the repo uses and where (grep `api/`, `scripts/`, `uw-stream/`, `ml/`);
  - the EOD ZIP (link the EOD capture design);
  - GEXBot (taker flow) is not UW Periscope (market-maker position): separate rules for each source, no negation;
  - the data-licensing rule (owner or guest auth only).
- **Description:** about 300 characters or fewer.

### Phase 6: `r2-storage` skill

- **File:** `.claude/skills/r2-storage/SKILL.md`.
- **It covers:**
  - the `R2_*` env var names;
  - the buckets and key layouts in use (Full Tape, `gexbot-eod/`);
  - one boto3 client per thread (the TLS-verification finding);
  - how to verify an upload (head plus size or sha256);
  - where the helpers live: the rescue script once it's in `scripts/`, and the Node module once the EOD build adds it.

### Phase 7: Unity projects (`cthulhu-crpg`, `mecha-ttrpg`, `space-attorney`)

- Run `dotnet tool install -g csharp-ls`.
- In each Unity project, at project scope: enable `csharp-lsp` and install the `unity` plugin.
- Check the `unity` plugin's skills for one that runs tests. Only if none exists, add a `run-unity-tests` skill to mecha-ttrpg (TestRunnerApi through the Unity MCP). 18 of 31 RunCommand calls were hand-written test runners.

### Phase 8: lost-question rule

- **Feedback memory:** when a turn ends waiting on the owner, the last message restates every open question in plain words, never only a code such as "D4" or "I4". Evidence: 9 lost-question turns and 33 status polls.
- **`~/.claude/CLAUDE.md`:** propose one line to the owner. It's the owner's file, so apply it only on approval.

## Handoff to skill cleanup (phases 6–7)

- **Phase 7 agents:**
  - The `implementer` evidence: 144 briefs. Most restate `npm run review` (90%), worktrees (84%), commit rules (68–87%) and R1–R7 (56%).
  - Make the `verifier` cover read-only research too: 77 briefs restate read-only, the scratch dir, Windows/Git Bash notes and never printing secrets.
  - The harness refuses report files from subagents, so the agent must return its findings as text.
- **Spec compliance:** fold it into `code-reviewer`, since 38 spec-plus-quality reviews went to `general-purpose`.
- **Routing:**
  - `cron-job-auditor`, `build-error-resolver`, `db-migration-specialist` and `ml-pipeline-analyst` were bypassed 13 times. Fix their `description` triggers.
  - `claude-code-guide` had 0 dispatches against about 12 harness questions.
- **Open question 3 is decided:** on 2026-10-29 the owner removed `pr-review-toolkit` and the `code-review` plugin (0 uses each).
- **Status view:** show "waiting on owner:" with the question in full.

## Files to create or modify

- **Phase 1:** user config only: `~/.claude/settings.json`, `~/.claude/plugins/`, `~/.claude/skills/{use-railway,context7-mcp}`
- **Phase 2:** global npm packages, `~/.claude/settings.json`
- **Phase 3:** `~/.claude.json` (through `claude mcp add`), `~/.claude/settings.json`, one memory file
- **Phase 4:** `.claude/hooks/env-shell-guard.sh`, `.claude/hooks/git-context.sh`, plus their tests
- **Phase 5:** `.claude/skills/gexbot-api/SKILL.md`
- **Phase 6:** `.claude/skills/r2-storage/SKILL.md`
- **Phase 7:** the Unity projects' `.claude/settings.json`; possibly one skill
- **Phase 8:** one memory file, plus the proposal text

## Data dependencies

- No tables, migrations or app env vars.
- `UW_API_KEY` gets a third home: the local Claude MCP config.
- Neon read-only needs one OAuth login.

## Open questions (defaults in bold)

1. Make the Neon MCP read-only? **Yes.** Waiting on the owner's answer (asked 2026-10-29).
2. `chrome-devtools-mcp`: **remove it.** 0 calls, and `npx lighthouse` covers Lighthouse if it's ever needed.
3. The `vercel` plugin: **disable it at user level and keep it installed.**
4. The Go and Rust language-server plugins: **leave them installed and disabled.**
