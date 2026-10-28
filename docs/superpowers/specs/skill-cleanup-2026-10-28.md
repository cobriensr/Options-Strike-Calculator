# Skill and instruction cleanup (2026-10-28)

## Goal

Cut the Claude Code instruction surface for this repo down to what gets used and is correct. That means removing skills that contradict the owner's rules, duplicates, and broken or off-stack skills; fixing or rewriting the skills that stay; refreshing stale agents; and scripting the mechanical work agents keep redoing. Done, the skill listing fits its budget and a weekly improvement loop can start from a clean baseline.

## Status

Phase 1 is done. Phases 2–7 are queued and run one at a time, in order. Phase 8 (the weekly loop) gets its own spec after phase 7.

## Evidence

Three read-only investigations ran on 2026-10-28 over 4 weeks of transcripts (30 main sessions, 268 subagent transcripts) and every active skill and agent. The reports are local-only in `docs/tmp/skill-audit-2026-10-28/` (gitignored, since they quote session text): `static-audit.md`, `skill-runs.md`, `repetition.md`. Measured findings:

- **Skills don't run badly.** Tool-error rate after a skill loads: 2.21% with skills vs 2.14% without. The owner pushed back 13 times in 4 weeks, and none of it was about a skill.
- **The listing is over budget.** 212 skill entries are listed every session, and 119 of them show with a name only. In practice only skills with recorded use keep their descriptions. About 4 in 5 listed skills never ran in 4 weeks.
- **Skill text contradicts the owner's rules.**
  - `commit` creates a branch when on main.
  - `git-pushing` stages with `git add .`.
  - `plan-writing` forbids plans in `docs/`.
  - Several skills and agents use done-gates other than `npm run review`.
  - The pre-work hook said "parallel-first" against the one-implementer-stream rule (fixed in phase 1).
- **Most of what recurs is mechanical work by the agent:** subagent-brief boilerplate, hand-grepping the `npm run review` log, and watching deploys five different ways. These become scripts and agent definitions, not skills.

## Safety and where changes are recorded

| What | Where it's recorded |
|---|---|
| `.claude/skills`, `.claude/agents`, `.claude/hooks`, `.claude/settings.json` | Local-only git history: `git --git-dir="$HOME/.claude/config-history/strike-calculator-dotclaude.git" <cmd>` (the work tree is preset to `.claude/`). Baseline commit `228c7cf`. Never pushed. `skills/zod` is its own git clone, so it's recorded as a pointer only |
| Tracked repo files (`CLAUDE.md`, `.gitignore`, `.vercelignore`, `scripts/`, this spec, `.claude/skills/periscope`) | The main repo, committed to main |
| `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, memory | Not versioned. Copies are in the backup |
| Everything above, before any change | `~/.claude/backups/2026-10-28-skill-cleanup/` (a 1,261-file tarball of `.claude/` + `.agents/`, plus the global CLAUDE.md and settings) |

Skill text stays out of the public main repo: the project skills come from many third-party sources under mixed licenses.

## Phases

Run one at a time. Each phase: implementer subagent → main-session check against this spec → review → commit (local history and/or main repo) → next phase.

- **Review rules.** Content-only phases get a reviewer subagent when the new text makes claims about the repo (phases 3, 5, 6). The mechanical phases (2, 4) are checked in the main session against the local-history diff.
- **Phase 7 is code,** so it gets the full Get It Right loop.
- **File limit.** Phase 2's deletions are scripted from the manifest below, so the 5-files-per-phase limit doesn't apply to them.

### Phase 1: rule conflicts (DONE 2026-10-28)

- `.claude/hooks/pre-work-check.sh`: Step 2 now says read-only work runs in parallel and implementers run one stream at a time.
- `~/.claude/CLAUDE.md`:
  - Work section: "Once work is approved, carry it through. Don't end a turn with 'Want me to…?'…"
  - Parallel-First Dispatch: now limited to read-only agents, with the project's stream limit taking precedence for implementers.
- `CLAUDE.md` Execution Mode step 1: one implementer stream at a time; read-only agents in parallel.

### Phase 2: prune (mechanical)

1. Delete these 34 project skills from `.claude/skills/`, and mirror each deletion in `.agents/skills/`:
   - **Contradict the owner's rules:** `git-pushing`, `create-branch`, `pr-writer`, `iterate-pr`, `plan-writing`, `build`, `lint-and-validate`, `production-code-audit`, `debugging-wizard`, `cc-skill-coding-standards`
   - **Stale forks of superpowers skills** (the plugin copies stay): `subagent-driven-development`, `executing-plans`, `finishing-a-development-branch`, `using-git-worktrees`, `using-superpowers`, `verification-before-completion`
   - **Broken, unusable or off-stack:** `deep-research`, `sentry-automation`, `github-automation`, `sequential-thinking`, `context7-auto-research`, `conductor-manage`, `conductor-status`, `openclaw-github-repo-commander`, `claude-code-guide`, `claude-code-expert`, `claude-settings-audit`, `xss-html-injection`, `landing-page-generator`, `monorepo-architect`
   - **Unused, and covered elsewhere:** `agent-memory-systems`, `changelog-automation`, `closed-loop-delivery`, `fixing-metadata`
2. Also delete the three dead TRACE skills that exist only in `.agents/skills/`: `charm-pressure`, `delta-pressure`, `gamma`.
3. **Fix `commit` in the same phase**, because deleting `create-branch` breaks it.
   - Remove the branch-on-main block (SKILL.md :14-28).
   - Stage by pathspec (`git add -- <paths> && git commit`), never `git add .` or `-A`.
   - Drop the hard-coded `Co-Authored-By` line; the harness supplies attribution.
   - Commit straight to main.
4. In the project `.claude/settings.json`, set `enabledPlugins` to false for `vercel`, `commit-commands`, `code-simplifier` and `skill-creator`, all `@claude-plugins-official`. Disabling them here affects only this project. Before relying on it, confirm in the docs that a project-level `false` overrides a user-level `true`.
   - **vercel:** zero uses in 4 weeks; about 40 entries; it injects 8K characters at every session start, assuming Next.js.
   - **commit-commands:** its `commit-push-pr` branches and opens PRs.
   - **code-simplifier:** its agent is byte-identical to the `pr-review-toolkit` one.
   - **skill-creator:** older than the synced `anthropic-skills:skill-creator`.
5. Tracked files:
   - `.gitignore:48-69` and `.vercelignore:55-81`: remove the whitelists for the three dead TRACE skills, and the stale "loaded by api/…" reasons for tracking `periscope`. `periscope` stays tracked as a record.
   - `periscope/SKILL.md:407`: remove the instruction aimed at the deleted `/api/periscope-chat` endpoint.
6. Grep for each deleted name in `CLAUDE.md`, `~/.claude/CLAUDE.md`, memory, `.claude/agents`, `.claude/hooks` and the surviving skills. Fix any reference, or list it in the report.

**Verify:**
- The local-history diff shows only the manifest deletions plus the `commit` and `periscope` edits.
- A fresh subagent reports the listing count and how many entries are name-only.

### Phase 3: merge overlap groups

Each group becomes one skill that carries this repo's rules. Bodies come from the best member, with repo-specific content added. The other members are deleted.

- **Security:** `cc-skill-security-review` + `frontend-security-coder` + `secure-code-guardian` → one skill. It carries the owner/guest auth model, the data-licensing rule, `withDbReader` auth modes, `secretEquals`/`bearerMatches`, and Zod at boundaries.
- **Accessibility:** `accessibility-compliance-accessibility-audit` + `fixing-accessibility` + `wcag-audit-patterns` + `screen-reader-testing` → one skill (axe-core in `e2e/`).
- **Observability:** `monitoring-expert` + `observability-monitoring-monitor-setup` + `observability-monitoring-slo-implement` → one skill (Sentry, pino, Axiom `reportCronRun` rules).
- **Performance:** `performance-optimizer` + `web-performance-optimization`.
- **Dependencies:** `dependency-management-deps-audit` + `dependency-upgrade`. Drop `git stash` / `checkout -b`, and use audit-ci via node (EALLOWSCRIPTS).
- **Risk:** `risk-manager` + `risk-metrics-calculation`.
- **Anthropic / prompting:** `prompt-caching` + `llm-structured-output` → into `claude-api`.
- **Agent docs:** `agents-md` + `ai-md` → one skill.
- **Data:** `data-transform` → into `pandas-pro`.
- **GitHub:** `issues` → into `github`.
- **Simplify:** `kaizen`, `code-refactoring-refactor-clean`. Delete both; the built-in `simplify` covers them.
- **ML:** `data-scientist` → fold the useful parts into `scikit-learn` / `statistical-analysis`.

### Phase 4: fix survivors

- **Point the done-gate at `npm run review`:** `typescript-expert` and `git-advanced-workflows`. In `git-advanced-workflows`, also remove `git add .` and the force-push examples.
- **Repo-specific content for generic bodies:**
  - `postgres-pro`: Neon, `migrateDb`, and a pointer to the `db-migration-specialist` agent.
  - `auth-implementation-patterns`: owner/guest and data licensing.
  - `vercel-deployment`: Fluid Compute, `ignoreCommand`, Railway no-push window.
  - `progressive-web-app`: vite-plugin-pwa.
  - `playwright-expert`: axe-core.
- **Stale references:**
  - `unusual-whales-api` :204/:234/:276
  - `matplotlib` and `scikit-learn`: missing bundled scripts
  - `pydantic-models-py`: template paths
- **`zod`:** fix the invalid YAML at :3. The change shows in zod's own git, not the local history.
- **Small rewrites:**
  - `csv-data-summarizer`: remove "DO NOT ASK" / "IMMEDIATELY".
  - `ui-styling`: Tailwind 4 only; drop shadcn and canvas fonts.
- **Descriptions:** drop ALWAYS/MUST from every description whose body doesn't deliver what it promises (41 per the audit).

### Phase 5: rewrite the high-traffic generic skills

These are the most-loaded skills, and their bodies are generic.

- **`test-master`** (61 loads): Vitest, the cron test pattern, `vi.mocked(getDb)` sequencing, the R3/R4 rules, coverage floors.
- **`backend-development`** (50 loads): absorbs `nodejs-best-practices` and `fullstack-guardian`. Covers `withDbReader`, `cronGuard`, the Neon/Upstash/pino/Sentry patterns, R1/R5/R6/R7, and `.js` extensions for `src/` files that `api/` imports.
- **`react-expert`** (19 loads): React 19 without Server Components/Redux/Zustand, the custom-hook patterns, the polling gate on `marketOpen`, the PWA dynamic-import `.catch()` rule.

Each rewrite must cite real repo files. The reviewer checks every cited path and API against the source.

### Phase 6: agents and CLAUDE.md facts

- **Done-gate → `npm run review`:** `build-error-resolver` :98-101, `db-migration-specialist` :78. In `session-reviewer`, remove the :55 "npm run build anti-pattern" line and fix the :28 Mac memory path.
- **Rewrite `cron-job-auditor`** against `api/_lib/cron-helpers.ts`: 83 cron entries, synchronous `cronGuard`, `bearerMatches`, the `marketHours` option, flat `api/__tests__/` test paths.
- **Fix `analyze-prompt-reviewer`:** model names, formatter locations.
- **Fix `security-reviewer`:** guest keys, `withDbReader` modes, data licensing.
- **Rewrite `ml-pipeline-analyst`:** the Windows venv path, the `ml/src/utils` package, `ml/conftest.py`, the current phase status.
- **Delete `codebase-scout`:** its map has been stale since 2026-05-10, and the built-in Explore agent covers it.
- **Project `CLAUDE.md`:** formatter locations (only `formatSpotExposuresForClaude` is in `db-flow.ts`); the `ml/.venv` path on the Windows workstation.

### Phase 7: scripts and agent definitions for repeated work (code: full loop, tests required)

- **`scripts/review-summary.mjs`:** reads the `npm run review` output and prints a short pass/fail per stage with the first errors. This replaces the hand-written grep/tail calls that followed 360 runs.
- **`scripts/watch-deploy.mjs <sha>`:** polls the GitHub commit status (Vercel and Railway contexts) until a terminal state, prints one line, and sets the exit code. This replaces about 5 ad-hoc calls per push.
- **Status view:** a statusline or Stop-hook footer showing the active stream, the queue, git ahead/behind and the last deploy state. Status asks went up after the watch-background-work memory was written, so this has to be something the owner can see, not another rule.
- **Agent definitions:**
  - `implementer`: commit rules, `npm run review`, R1–R7 pointer, one stream.
  - `verifier`: read-only, verifies against the source.
  
  These replace the boilerplate rewritten into 135 briefs. Add a `CLAUDE.md` line saying reviewer and implementer briefs carry scope only.

### Phase 8: weekly loop (separate spec)

- Reuse the transcript-mining approach from the audit (re-home the scripts, which lived in a session's temp folder).
- Add a before/after check on each rule's creation date; it would have caught all five rules that aren't working.
- Output a diff and a report for the owner to approve. No auto-apply.
- Transcript retention is now 90 days (`cleanupPeriodDays: 90`, set 2026-10-28).

## Files to create or modify

- **Phase 1:** `.claude/hooks/pre-work-check.sh`, `~/.claude/CLAUDE.md`, `CLAUDE.md` (done)
- **Phase 2:** 34 skill dirs (+3 in `.agents/skills`), `.claude/skills/commit/SKILL.md`, `.claude/settings.json`, `.gitignore`, `.vercelignore`, `.claude/skills/periscope/SKILL.md`
- **Phase 3:** about 26 skill dirs merged into about 10
- **Phase 4:** about 17 skill files
- **Phase 5:** `test-master`, `backend-development` (+2 deleted), `react-expert`
- **Phase 6:** 8 agent files, `CLAUDE.md`
- **Phase 7:** `scripts/review-summary.mjs`, `scripts/watch-deploy.mjs` (+ tests), the status script and its settings, 2 new agent files, `CLAUDE.md`

## Data dependencies

None. No tables, migrations, env vars or external APIs. Phase 7's `watch-deploy` uses `gh api` with the existing CLI auth.

## Thresholds and constants

- SKILL.md body: 500 lines or fewer; detail goes in `references/`.
- Description: about 300 characters or fewer. No ALWAYS/MUST unless the body carries repo-specific content that justifies it.
- Success check after phases 2–3: in a fresh session's listing, every surviving project skill shows its description. The listing budget isn't documented, so measure it rather than assume it.

## Open questions (defaults in bold)

1. Publish the skills to the public main repo? **No. Local history only** (mixed third-party licenses).
2. The learning-output-style plugin asks the main session to hand code to the owner, which conflicts with "main session doesn't write code". **Keep it; the owner chose it.** Owner's call.
3. The `code-review` and `pr-review-toolkit` plugins are PR-centric. **Keep for now**, and revisit after the phase 2 listing check.
4. `.agents/skills/` holds a stale third copy, probably for Codex. **Mirror the deletions and keep the folder.**
5. Retire `codebase-scout`? **Delete it** (phase 6).
