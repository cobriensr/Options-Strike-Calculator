---
status: Plan
date: 2026-10-29
---

# Weekly docs audit as a Claude Code cloud routine

## Goal

Keep the README and the docs it links true to the code. Each week, a
scheduled Claude Code cloud routine checks the docs against the code.
It commits the mechanical fixes straight to `main` and writes the rest
into a dated, public report.

## Why

The 2026-10-28 manual pass found about 400 stale claims across 14 docs.
Examples:

- the README quoted 6,897 tests when there were 14,806;
- the docs said the analyze endpoint took 4 images when it takes 2;
- LOCAL_DEV gave a cron curl that can't work;
- whole features were missing from FEATURES.md.

About 40% of these were mechanical: counts, paths, links, env names.
The rest were narrative that no script can regenerate. That pass ran 5
read-only auditors, then a verify-and-edit loop, and it is the template
for this routine.

## Decisions recorded (owner, 2026-10-28)

- **Host:** a Claude Code cloud routine (`RemoteTrigger`), not GitHub
  Actions or the workstation.
- **Output mode 2:**
  - auto-commit _mechanical_ fixes to `main`;
  - write _narrative and behavior_ findings to a report for the owner.
- **Report inbox:** a committed file, `docs/audits/YYYY-MM-DD.md`. The
  repo is a public showcase, and a visible audit trail is part of that.
- **Order:** build only after the 2026-10-28/29 docs refresh landed
  (done: commits `c43d89d3` → `0158bde3`), so the first run sees real
  new drift, not the backlog.

## Design

### Two passes per run

1. **Audit.** Read the in-scope docs. Check every factual claim against
   the code, not against other docs. Each finding has:
   - a location;
   - the current text;
   - what is true;
   - evidence (`file:line` or command output);
   - a proposed replacement.
2. **Verify.** A separate subagent tries to disprove each finding
   against the code. Only findings that survive go forward. The report
   lists rejected findings too, with the reason, so the trail shows the
   verifier at work.

### Scope per run

- **Diff-driven:**
  - The routine reads the last audited SHA from `docs/audits/state.json`.
  - It takes `git diff --name-only <sha>..HEAD`.
  - It maps the changed paths to doc sections with `docs/audits/doc-map.json`.
  - It audits only those sections.
- **Rotation:** each run also fully audits one doc, cycling through the
  in-scope list in `state.json`. This catches drift no diff points at.
  The 10Δ floor conflict, for example, sat in code that hadn't changed.
- **In scope:**
  - `README.md` and the docs it links: `docs/{ONBOARDING,LOCAL_DEV,FEATURES,ARCHITECTURE,DEPLOYMENT,TRADING_WORKFLOW,INDEX}.md`;
  - the subproject READMEs: `sidecar/`, `uw-stream/`, `ml/`, `scripts/`, `e2e/`;
  - `AGENTS.md`;
  - CLAUDE.md, _factual claims only_: never rules or policy.
- **Out of scope:**
  - dated specs and plans (historical records);
  - `.env*` files;
  - code.

### Mechanical vs narrative

**Mechanical** findings (auto-commit) have exactly one right answer in
the code:

- counts (tests, specs, migrations, crons, tables), stated with an
  "as of" date;
- file and directory paths, and relative link targets;
- env-var names;
- npm script names and chains;
- model IDs;
- function `maxDuration` values;
- a mention of a file, route, cron or table that the code proves was
  removed, where the fix is deletion or a one-line correction.

**Narrative** findings (report only) are everything else:

- feature descriptions;
- trading rules;
- how something works or why;
- missing sections;
- any claim where reasonable people could word the fix differently.

When in doubt, the finding is narrative.

### Public-repo rule

The repo is public, so the routine must never write a security gap into
a commit or the report. That covers missing auth or rate limits,
unauthenticated routes, and unset security settings. If the routine
notices one, the report says only: "1 security-relevant observation
withheld; run a local audit." The local follow-up note pattern is
`docs/tmp/security-gaps-*.md`, which is gitignored.

### Commit and report

- **Mechanical fixes:** one commit per run,
  `docs(audit): Fix N mechanical drifts found <date>`, with the list in
  the body.
- **The report:**
  - `docs/audits/<date>.md` holds the run window (SHA range), the
    sections audited, the rotation doc, accepted mechanical fixes,
    narrative findings with proposed wording, rejected findings with
    reasons, and owner-to-confirm items;
  - the report and `state.json` go in the same commit as the fixes;
  - a run with no findings still commits a short report and the
    advanced SHA.
- **Gate before commit:**
  - `npm ci && npm run review` (the repo rule: docs included);
  - `npx prettier --check` on every changed `.md`;
  - a relative-link check.

  If the gate fails on something the run didn't cause, the routine
  commits nothing, writes the failure into the report and says so.

### Procedure lives in the repo

The routine's prompt stays short: "Follow `docs/runbooks/docs-audit.md`
exactly." The procedure, the doc map and the state file are versioned
in the repo. Changing the audit means a commit, not a routine edit.

## Phases

1. **Phase 0: keep docs commits from redeploying Railway.** About 15 min.
   - **The problem:** `railway.toml` `watchPatterns` are `sidecar/**`
     and `uw-stream/**`. A
     README-only commit under those dirs rebuilds and redeploys the
     service; uw-stream drops its websockets. The routine commits
     unattended, possibly during market hours.
   - **The fix:** narrow each pattern to code and build files, e.g.
     `uw-stream/src/**`, `uw-stream/Dockerfile`,
     `uw-stream/requirements.txt`, `uw-stream/railway.toml`, and the
     same idea for the others.
   - **Verification:** a docs-only push shows no new Railway deploy,
     and a code push still deploys.
2. **Phase 1: procedure, doc map, state.** About 45 min.
   - `docs/runbooks/docs-audit.md`: the two-pass procedure, the
     mechanical/narrative rule, the public-repo rule, the gate, the
     commit and report format.
   - `docs/audits/doc-map.json`: code globs → doc sections, seeded from
     the 2026-10-28 audit (e.g. `vercel.json` + `api/cron/**` →
     DEPLOYMENT crons and ARCHITECTURE data flow).
   - `docs/audits/state.json`: `last_audited_sha` (`0158bde3` or later),
     the rotation list and the next index.
3. **Phase 2: create the routine and run it once.** About 30 min.
   - Create the routine with `RemoteTrigger` `run_once_at` in the near
     future. Use the default environment, repo
     `cobriensr/Options-Strike-Calculator`, and allowed tools
     Bash/Read/Write/Edit/Glob/Grep.
   - Read the run log. It answers the open question of whether the
     routine can push to `main`, and shows the report quality.
4. **Phase 3: weekly schedule.**
   - Switch the routine to a cron.
   - After 2–3 runs, review the reports with the owner and tune the doc
     map and the rules.

## Files

- **Phase 0:** `sidecar/railway.toml`, `uw-stream/railway.toml`, and `scripts/ws-canary/railway.toml` if it
  has watchPatterns.
- **Phase 1:** `docs/runbooks/docs-audit.md`, `docs/audits/doc-map.json`,
  `docs/audits/state.json`, a README line pointing at `docs/audits/`,
  and an INDEX entry.
- **Phase 2/3:** none in the repo (the routine is configured through
  `RemoteTrigger`). Each run then adds `docs/audits/<date>.md`.

## Data dependencies

None:

- no tables;
- no env vars;
- no external APIs beyond GitHub access for the routine's checkout
  and push.

## Open questions (default picks)

1. **Can the routine push to `main`?** This depends on the GitHub app's
   permissions. _Default:_ find out in the Phase 2 test run. If it
   can't, run report-only (write the report into the run log) until
   access is granted. No branches or PRs, per the owner's
   direct-to-main rule.
2. **Model.** _Default:_ `claude-sonnet-5-5`. Switch to Opus if the
   verifier rejects too little or the narrative wording is weak.
3. **Cadence.** _Default:_ Saturday 08:00 CT, which is
   `0 14 * * 6` UTC after DST ends 2026-11-01. The cron is UTC, so the
   local time shifts an hour at each DST switch.
4. **Narrowing the Railway watch patterns (Phase 0).** _Default:_ do it.
   It only changes which pushes deploy, and docs-only pushes should
   never restart live services.
5. **Full `npm run review` in the cloud.** _Default:_ yes (repo rule).
   If the sandbox can't run it in reasonable time, fall back to
   prettier plus the link check for md-only commits, and say so in the
   report.

## Thresholds and constants

- One commit per run. At most 25 mechanical fixes per commit. Any more
  go to the report, as a sign that something bigger changed.
- Rotation: one full doc per run, 14 docs, so each gets a full audit
  about every 3 months.
- A report is written even when nothing is found.
