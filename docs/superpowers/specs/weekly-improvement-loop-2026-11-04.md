# Weekly improvement loop (2026-11-04)

Phase 8 of `skill-cleanup-2026-10-28.md`. **Scope approved by the owner on 2026-11-04 (about 14:15 CT), with the default pick on all four decisions below.** All 5 phases were built by 2026-11-06. The tool, the `/weekly-review` skill and the SessionStart reminder are local-only under `.claude/`, recorded in its history repo. How to run it and its limits are in `.claude/scripts/weekly-review/README.md`.

## Goal

Once a week, read the past week's Claude Code sessions for this repo and report what keeps going wrong: work that stalls, corrections the owner had to make, mechanical steps repeated by hand, flaky tests, and rules that were written but didn't change behaviour. Then propose specific changes for the owner to approve. Nothing is applied automatically.

## Why now

The 2026-10-28 audit found the problems by hand, once. One working day (2026-11-04) then produced a typical week's worth of signal that no rule or memory had prevented:

- **Four subagents stalled for 15–45 minutes each, for three different reasons.** The harness moved a long command into the background, and the agent waited for a notice that never woke it. A subagent ran an ask-rule `git checkout --` and waited silently on an approval prompt while the owner was trading. One Sonnet reviewer stalled with no command running at all.
- **Two recorded rules recurred anyway.** A pipe hid a failed `git rebase --continue` inside an `&&` chain. A UTC wake-up was computed with the summer (CDT) offset three days after DST ended. Both were already in memory, so a memory line alone doesn't stop them.
- **The same watcher script was hand-written about a dozen times**: progress log, commits, and a stall alarm, for each agent.

A weekly pass would surface these as counts with dates, instead of relying on someone noticing.

## What it measures

| Signal | How it's found in the transcripts | What it can lead to |
|---|---|---|
| Subagent stalls | A gap of more than 10 min between tool calls inside one agent run. Classify by the last call before the gap: backgrounded command, ask-rule command, or none. | Brief or agent-definition changes, a hook, or a model choice |
| Owner corrections | Owner messages that redirect or undo ("no, I mean", "stop", "why did", or a repeated "status") | Memory or CLAUDE.md wording |
| Repeated manual sequences | The same normalised Bash or tool pattern 5 or more times a week across 2 or more sessions | A script under `scripts/` or an agent definition |
| Flaky tests | A test that fails, then passes on a rerun with no code change, 2 or more times a week | A flaky-test ledger entry and a fix ticket |
| Model use | Agent calls by type and model, tokens, and stall rate per model | The subagent-model rule; Sonnet vs Opus per task type |
| Rule efficacy | For each memory or rule with a creation date, the rate of the behaviour it targets in the 2 weeks before vs since | Keep it, reword it, or replace it with a hook or script |
| Skill use | Skills loaded vs listed; skills never loaded in 4 weeks | Prune or merge |

The rule-efficacy check is the one the audit lacked. It would have flagged all five rules that weren't working on 2026-10-28, and today it would flag the pipe and time-zone rules.

## Output

- A report at `docs/tmp/weekly-review/<date>/report.md`. `docs/tmp/` is gitignored, because the report quotes session text. One section per signal: counts this week, the change from last week, and the 3 worst examples with transcript references.
- A proposals file next to it. Each proposal is a concrete diff (a memory edit, CLAUDE.md wording, a hook, or a script stub) with the evidence behind it. The owner approves, edits or rejects each one, and only approved proposals get applied, in a normal session with the usual review loop.

## Phases

1. **Re-home the miners.** The audit's transcript-mining scripts lived in a session temp folder. Move them into `.claude/scripts/weekly-review/` (local-only, recorded in the `.claude` local history repo, never in the public repo). Make the parser tolerant of Claude Code transcript format changes: skip unknown record types and log a count of them. About half a day.
2. **Signals 1–5 as a report.** Stalls, corrections, repeats, flaky tests and model use, with tests on fixture transcripts. About a day.
3. **Rule efficacy.** Read each memory file's `modified` date and each CLAUDE.md rule's date from `git log -L`, pair it with a matcher for its target behaviour, and compare before and after. Start with the 10 newest rules. About a day.
4. **Proposals and the approval flow.** Generate diffs, write the proposals file, and add a `/weekly-review` skill that runs the miners and walks the owner through the proposals one at a time. About half a day.
5. **Cadence.** A SessionStart hook prints one line when the last report is more than 7 days old. No scheduled runs: transcripts are local, and nothing runs unattended. About an hour.

## Builds on phase 7

Phase 7's `implementer` and `verifier` agent definitions and its `watch-deploy` / `review-summary` scripts remove several of today's repeated manual sequences. The weekly loop then measures whether they did. Phase 7 should go first, and should take today's lessons into the `implementer` definition:

- poll a backgrounded command's output rather than wait for a notice;
- no ask-rule commands during market hours;
- log progress at least every 10 minutes;
- never pipe a gate or git command inside an `&&` chain.

## Data dependencies

None external. It reads:

- the transcripts in `~/.claude/projects/f--dev-strike-calculator/`, kept 90 days (`cleanupPeriodDays: 90`);
- the memory folder;
- `git log`;
- optionally `gh` for CI history.

No tables, env vars or services.

## Thresholds

- Stall: a gap of more than 10 min between tool calls within one agent run.
- Repeat: the same normalised pattern 5 or more times a week, in 2 or more sessions.
- Flaky: fails then passes on rerun with no change, 2 or more times a week.
- Rule efficacy window: 2 weeks before vs everything since. A rule needs at least 5 target events across both windows to be judged.

The spec left these open. They were picked during the build (2026-11-06), not by the owner, so the owner can overrule them:

- Rule verdict: the rate since the rule divided by the rate before it. Keep at 0.5 or less, replace with a hook or script at 1.0 or more, reword in between. A verdict needs the whole 95% interval (z = 1.96) inside one band. Otherwise the row is inconclusive and names the bands it spans.
- Rates use the kind of call the rule watches as the denominator: shell commands, Agent calls, tool calls or sessions. The rule's own day is in neither window.
- Each window also needs 5 active days, and 100 watched calls or 3 sessions. No events before the rule reads "no baseline", with no verdict. With no events since, the upper bound is the exact one for a zero count.
- Proposals need 3 approval waits of one kind, 3 runs left asleep, 3 corrections or 2 flips of one test. A hook or script needs a confident replace or a known case recurring. An inconclusive row can only ask for a rewording, and only when its bands exclude keep.
- "Owner away" means an approval wait over 6 h. Approval figures lead with wall-clock and market-hours time, with overlapping waits counted once.

The transcripts only went back to 2026-10-22 at the first run, so the before windows then were 6 to 7 days, not 14.

## Decisions (owner, 2026-11-04 about 14:15 CT: all defaults)

1. **Where the miners live: `.claude/scripts/weekly-review/` (local only).** Not `scripts/` in the public repo, though the code itself quotes nothing private.
2. **Cadence: manual `/weekly-review`, plus a SessionStart reminder when the last report is over 7 days old.** No scheduled job: the alternative, a weekly Windows Task Scheduler job running `claude -p` headless, was not chosen.
3. **Report format: Markdown in `docs/tmp/weekly-review/<date>/`.** Not a private Artifact page with charts.
4. **The flaky-test signal includes `gh run list` CI history, when it takes under 1 minute.**
