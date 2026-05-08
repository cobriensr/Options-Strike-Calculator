# Sentry Monitoring + Alerting Hardening (2026-05-07)

## Goal

Close the three observability gaps surfaced by Sentry's Monitor/Alert split: (1) volume-spike issues bypass our only alert rule because they aren't auto-classified high-priority, (2) all 49 Vercel cron jobs are unmonitored end-to-end, (3) routing is email-only with no push fallback. Result: any spike that crosses a real threshold reaches my phone within minutes, every cron miss is visible, and the new Sentry taxonomy is correctly populated.

## Background — what's actually wired today

Audited 2026-05-07 against `no-org-jc / sentry-emerald-desert`:

| Item                                                 | Type (post-split)   | Notes                                                                                 |
| ---------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------- |
| Issue alert rule 16804820 — "high priority issues"   | **Alert** (routing) | Email-only → IssueOwners, fallthrough ActiveMembers. Last fired 2026-05-07 20:45 UTC. |
| Uptime monitor 6838188 — `https://theta-options.com` | **Monitor**         | 60s GET, 200–299 OK. Healthy.                                                         |
| Metric monitors                                      | **Monitor**         | None. None to migrate (no metric alerts existed pre-split).                           |
| Cron monitors                                        | **Monitor**         | None. 49 Vercel crons fire blind.                                                     |
| Recent metric incidents                              | —                   | None.                                                                                 |

**Last 24h volume**: 1,466 errors + 793 warnings.

- **1,413 events**: `NeonDbError: fetch failed` on `/api/gex-strike-expiry` (3h–6h ago) — _did not trigger high-priority alert_.
- **354 events**: ES options Definition lag in sidecar.
- **~450 events**: ~30 distinct UW 429 issues clustered in one rate-limit window.
- 7 Postgres deadlocks; 1 missing `periscope_lessons` table; 1 `numeric field overflow` in `backfill-features`.

The NeonDb spike is the smoking gun: 1,413 events with zero alerts is exactly the case the new "Monitor" concept is designed for.

## Architecture — leverage what exists

The codebase already has a clean choke point: `api/_lib/cron-instrumentation.ts` exports `withCronInstrumentation()`. **33 of 49** cron handlers funnel through it; the wrapper already calls `Sentry.setTag('cron.job', name)` and `Sentry.captureException()`. Adding `Sentry.withMonitor()` here instruments all 33 in a single file edit. The other 16 handlers (legacy / non-standard shapes) get a follow-up sweep.

Sentry node SDK is `^10.44.0` — `Sentry.withMonitor()` and the metric alert API are both supported.

## Phases

Each phase respects the CLAUDE.md ≤5 file budget. Run `npm run review` between phases.

### Phase 1 — Three issue alert rules (no code changes)

**API path decision**: The new Sentry split exposes detectors (Monitors) + workflows (Alerts), but the legacy project-rules endpoint (`/api/0/projects/{org}/{project}/rules/`) is still primary — Sentry transparently maps each rule to a backing workflow. The deprecated `/alert-rules/` (metric alert) endpoint is a trap. We stay on the proven rules endpoint and use `event_frequency` conditions to cover the spike-detection case.

Three rules created via `sentry api POST /api/0/projects/no-org-jc/sentry-emerald-desert/rules/`, idempotent (find-by-name → PUT, else POST):

**1a. Volume spike on a single issue**

- Condition: `event_frequency >= 50` in `1h` (interval) → routes immediately
- Frequency: 30 min (no re-page on same issue)
- Action: email Member 14663143 (the user) + fan-out to per-user notification preferences (mobile push if enabled)
- Catches: NeonDb-style spike (1,413 events on ONE issue), ES Definition lag (354 events sustained)

**1b. Aggregate error spike (substitute for the deprecated metric monitor)**

- Condition: `event_frequency >= 25` in `5 minutes` for any issue with `level:error`
- Frequency: 30 min (deduplicates re-pages)
- Action: email Member 14663143
- Catches: the case where many distinct issues each fire a few times — collective volume spike that 1a's per-issue threshold misses

**1c. Critical infra patterns (first occurrence)**

- Filter: `message` contains `deadlock` OR `does not exist` OR `numeric field overflow`
- Condition: any first-seen issue matching the filter
- Frequency: 5 min (immediate page on new occurrence)
- Action: email Member 14663143
- Catches: 7 deadlocks today, the missing `periscope_lessons` table, the `numeric field overflow` in `backfill-features` — these are correctness bugs and we want first-occurrence routing.

**Files touched**: 0 code, 3 API mutations. Deliverable is a tiny shell helper script (`scripts/sentry/setup-monitors.sh` — written once, idempotent, safe to re-run) that creates/updates these rules so the config is reproducible if the org is ever rebuilt.

### Phase 2 — Cron monitoring via single-file extension

Modify `api/_lib/cron-instrumentation.ts` only:

- Wrap the existing handler `try` block in `Sentry.withMonitor(jobName, async () => { … }, { schedule: { type: 'crontab', value: SCHEDULE_MAP[jobName] } })`.
- Maintain a `SCHEDULE_MAP` constant pulled from `vercel.json` at module load (or hard-coded — the schedules don't drift often). Each entry: `{ schedule, checkinMargin, maxRuntime, failureIssueThreshold, recoveryThreshold, timezone: 'UTC' }`.
- Add a unit test asserting the wrapper still calls `reportCronRun` on success/failure (regression).

This single edit covers all 33 wrapped crons: they each get a Sentry cron monitor with auto-created issues on missed/late/long-running checks, plus the rate-spike metric monitor catches anything that throws inside.

**Files touched**: `api/_lib/cron-instrumentation.ts`, `api/__tests__/cron-instrumentation.test.ts` (new or extend), 1 schedule map (could be in `cron-instrumentation.ts` or a new `api/_lib/cron-schedules.ts`).

### Phase 3 — Bring the 16 unwrapped crons under instrumentation

Sixteen handlers don't use `withCronInstrumentation` (mostly: paginated, non-standard return contract, or written before the wrapper existed):

```
backfill-futures-gaps.ts, backup-tables.ts, curate-periscope-lessons.ts,
curate-lessons.ts, fetch-spx-candles-1m.ts, monitor-flow-ratio.ts,
refresh-vix1d.ts, fetch-strike-exposure.ts, fetch-futures-snapshot.ts,
fetch-vol-surface.ts, fetch-strike-all.ts, monitor-vega-spike.ts,
fetch-zero-dte-flow.ts, fetch-vol-0dte.ts, refresh-current-snapshot.ts,
warm-tbbo-percentile.ts
```

These get a lighter wrapper — a new `withCronCheckin(jobName, schedule)` that ONLY wraps the `Sentry.withMonitor()` boundary without changing return shape or guard semantics. Applied in 4 batches of ≤5 files each. Out of scope for the initial ship — Phase 1 and Phase 2 land first; this becomes a follow-up after we validate the Phase 2 wrapper works in production for ~24h.

### Phase 4 — Push notifications (user action, not automated)

Sentry mobile app push is configured per-user in account settings, not via API:

1. Install Sentry mobile app (iOS / Android)
2. Sign in as charles.a.obrien@outlook.com
3. Settings → Notifications → enable push for `no-org-jc / sentry-emerald-desert`
4. Settings → Personal Notifications → "Issue Alerts" set to "On"
5. Verify by triggering a test issue (Sentry has a test event button) — confirm the push arrives

This is a one-time setup. Once enabled, the Phase 1b and 1c alert rules' "Send a notification to IssueOwners" action will fan out to email + mobile push automatically (Sentry routes per the recipient's notification preferences).

## Open questions / decisions made

- **Why not Slack?** User doesn't use Slack; not a requirement.
- **Why not PagerDuty?** Single-owner trader, no on-call rotation, overkill.
- **Threshold 100/min for the metric monitor?** Calibrated to today's tail — peak NeonDb spike was ~470 events/min (1,413 events / 3h with rate-limit windowing). 100 is well below peak, well above normal noise (current baseline: 0–5/min).
- **Threshold 50 events in 1 hour for the issue-volume rule?** Below the 354 ES Definition issue rate (~15/min sustained), well above any healthy issue's frequency. Tunable later if it pages too often during normal sidecar lag spikes.

## Thresholds / constants

| Constant                          | Value          | Reason                                                                                                                                 |
| --------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `METRIC_MONITOR_CRITICAL_PER_MIN` | 100            | 5x current baseline tail; catches NeonDb-style spike.                                                                                  |
| `METRIC_MONITOR_WARNING_PER_MIN`  | 25             | 25x baseline; early signal.                                                                                                            |
| `ISSUE_VOLUME_THRESHOLD`          | 50 events / 1h | Above sustained-noise ceiling for normal infra issues.                                                                                 |
| `CRON_CHECKIN_MARGIN_MIN`         | 2              | Vercel cold-start jitter; alert if late > 2 min.                                                                                       |
| `CRON_MAX_RUNTIME_MIN`            | 15             | Most crons finish < 30s; long-runners (`build-features`, `curate-lessons`) have explicit Vercel timeouts up to 800s, override per-job. |
| `CRON_FAILURE_THRESHOLD`          | 1              | Single failure pages immediately (not 3 — these are 1/min jobs, 3 = 3 min lag).                                                        |
| `CRON_RECOVERY_THRESHOLD`         | 1              | Resolve immediately on next success.                                                                                                   |

## Files to create / modify

**Phase 1**:

- `scripts/sentry/setup-monitors.sh` (new) — idempotent CLI script to create/update the three alert rules

**Phase 2**:

- `api/_lib/cron-instrumentation.ts` — wrap handler in `Sentry.withMonitor()`
- `api/_lib/cron-schedules.ts` (new) — `Record<string, CronMonitorConfig>` map of jobName → schedule + thresholds
- `api/__tests__/cron-instrumentation.test.ts` — extend existing test (verify monitor wrapping doesn't break success/error paths)

**Phase 4**:

- No code; 5-step user runbook in this doc

## Verification per phase

- **Phase 1**: `sentry api /api/0/organizations/no-org-jc/alert-rules/` returns the new metric monitor; `…/projects/.../rules/` returns the two new issue rules. Trigger a test event via `Sentry.captureMessage('test')` from a one-off invocation and confirm email arrives.
- **Phase 2**: `npm run review` green. Deploy to preview; tail one cron run; confirm `/api/0/organizations/no-org-jc/monitors/` lists 33 new monitors with recent check-ins.
- **Phase 3 (deferred)**: same as Phase 2 for the additional 16.
- **Phase 4**: User runbook step (5) — test event triggers a push on the mobile device.

## Out of scope

- Migrating any pre-existing email-only Sentry settings to a different transport (we keep email).
- Rewriting `api/_lib/sentry.ts` — the metrics helpers are correct and unrelated.
- Sidecar (Railway) Sentry monitoring — out of scope for this pass; sidecar has its own SENTRY_DSN and a separate cron lives in Railway, not Vercel.
- Adding new Sentry instrumentation to existing routes that already have it (e.g. `api/analyze.ts`).
