# Mark snapshot rows saved without a current yesterday

## Goal

When the app has no current "yesterday" (the prior session's open, high and low), a snapshot row must say so, not store a cluster multiplier of 1.0 that reads like a real "no clustering" value. Such a row must never feed the day's ML features, and the owner must hear about it.

## Why

Since the yesterday fix of 2026-11-24 (main f2648119d..49f280df9), the app shows nothing for RV/IV and the cluster multiplier until it holds the last completed session, instead of an older one. On screen that is honest. But a row saved in that gap stores:

- `cluster_mult = 1` and `cluster_put_mult = cluster_call_mult = 1`. `computeClusterSignal` returns its no-data fallback `{ rangePct: null, cluster: null, mult: 1 }` (src/utils/volatility-cluster.ts:31), App passes `cluster.signal.mult` to the save (src/App.tsx:631), and `useRegimeClassification` sets both tilts to that 1 when it has no yesterday.
- `rv_annualized`, `rv_iv_ratio` and `rv_iv_label` as null (`useRangeAnalysis` leaves them null without yesterday's high and low).
- Range estimates and delta ceilings computed as if the multiplier were 1.

`build-features` copies `cluster_mult` into the day's features unchanged, so a 10:00 row saved in the gap feeds a fake 1.0 to the ML data, as the months of 1.0 rows found on 2026-11-07 did. Nothing alerts: the `yesterday.wrong_day` counter (api/yesterday.ts) counts only the server answering with the wrong day, not the app's own request failing.

How often: rarely and briefly. The app re-asks for yesterday every poll tick in the session while it lacks the current one, so a gap lasts as long as Schwab's daily candle is late or requests fail.

## Approaches

1. **Save but mark (chosen by the owner, 2026-11-25 00:06 CT).** The row is saved with the yesterday-derived multipliers empty, the server raises an alert for a live row that arrives without them, and the feature build does not pick such a row. Every slot keeps a row, and nothing fake reaches the features.
2. **Don't save until yesterday arrives.** No incomplete rows, but the slots in the gap stay empty until the planned server snapshot builder fills them, the same trade as the 8:30 stale-quote refusal on 2026-11-17.
3. **The server fills yesterday in.** It fits the owner's backend rule best, but the range estimates and ceilings are computed in the browser from the multiplier. They would still assume 1, so the row would contradict itself until the snapshot builder moves that logic to the server (server-snapshot-builder spec, phases 3-6).

Approach 3 is where this ends up once the server builder writes rows; approach 1 is the honest stopgap until then.

## Design

### 1. The app saves empty multipliers when it had none

- A row's `clusterMult`, `clusterPutMult` and `clusterCallMult` are null whenever the cluster signal had no inputs: `cluster.signal.cluster == null` (no yesterday range, or no VIX). The owner's manual edit of yesterday's range counts as inputs.
- What the screen shows is unchanged: the panels keep using 1 as the working value, as today.
- RV, RV/IV and its label are already null in that case; no change.
- The range estimates and ceilings on such a row stay as computed (at a multiplier of 1). The empty multiplier marks the whole row as built without yesterday, and part 3 keeps it out of the features.
- `/api/snapshot` already accepts a null `clusterMult` (`num` in api/_lib/validation/snapshot.ts, `?? null` in api/_lib/db-snapshots.ts). Check that the two tilt fields do too.

### 2. The server alerts on a live row without yesterday's fields

In `api/snapshot.ts`, after the existing refusals, a live save (`isBacktest !== true`) for a slot (not the `pre-market` row, which never carries these fields) whose `rvAnnualized` or `clusterMult` is null:

- is saved as sent (no refusal);
- increments `metrics.increment('snapshot.missing_yesterday_fields')`;
- raises one Sentry warning per date: `Sentry.captureMessage('snapshot.missing_yesterday_fields', …)` with tag `snapshot_gap: missing_yesterday_fields`, fingerprint `['snapshot-missing-yesterday-fields', date]`, and extra `{ date, entryTime, rvMissing, clusterMissing }`. One issue per date, so a ten-minute gap is one alert.

This catches the gap whatever its cause (a late Schwab candle, a failed request, a stale tab), because the server judges what arrives. Backtest rows are not alerted: the replay driver checks them.

### 3. The feature build won't pick an unmarked-yesterday row

`featureSnapshotRejection` (api/cron/build-features.ts) gets one more test. A row with `created_at` at or after `MISSING_YESTERDAY_CUTOFF` whose `cluster_mult` or `rv_annualized` is null is not trusted. The existing rules then apply unchanged: the pick moves to the nearest trusted row within ±60 min of 10:00 CT; if there is none, the day gets no snapshot features, and the existing no-pick report fires.

The cutoff matters. Older history already has empty values for ordinary reasons, checked 2026-11-25: about one row per date with no multiplier (the `pre-market` row), and about 1,300 rows from January to August with no RV. Judged by the new test, a rebuild would blank those dates. Rows before the cutoff are judged as they are today.

- `MISSING_YESTERDAY_CUTOFF` = 00:00 CT on the first day after parts 1 and 2 are live in production, so every row the test judges was saved by the new app. The builder sets the exact value when the deploy date is known.
- `scripts/_lib/snapshot-price-context.ts` (`featurePickChange`) follows the same rule. If it calls `featureSnapshotRejection`, it follows automatically; if it has its own copy, change it too.
- Update docs/superpowers/specs/2026-11-22-feature-snapshot-trust-design.md with the new test.

### 4. The alert rule (owner OK required at creation)

A Sentry issue alert that emails the owner when an issue tagged `snapshot_gap: missing_yesterday_fields` is first seen. Model it on the rule that routes the feature build's no-pick email. Sentry alert-rule changes need the owner's explicit OK, so this step waits for it. Parts 1-3 ship without it.

## Non-goals

- Computing yesterday on the server (approach 3): the snapshot builder's job.
- Repairing the legacy 1.0 rows saved since 2026-08-25 that were never replayed (an open follow-up in the snapshot-replay-repair notes).
- Changing what the screen shows during a gap.
- Alerting on backtest rows.

## Files

- Part 1: src/App.tsx (or src/hooks/useSnapshotSave.ts, wherever the save's meta is built), with tests in the App wiring test or the save hook's test.
- Part 2: api/snapshot.ts and api/__tests__/snapshot.test.ts.
- Part 3: api/cron/build-features.ts and its test, scripts/_lib/snapshot-price-context.ts if it has its own copy, and the trust spec.
- Part 4: no repo files. A Sentry rule, with the owner's OK.

## Constraints

- No new column and no migration. The mark is the empty multiplier plus the row's `created_at`.
- Push parts 1-3 together (they touch `api/` and `src/`), after the 15:00 CT close on a weekday.
- Tests: TDD. A save without yesterday posts null multipliers, and a save with one posts numbers. The server alerts once per date for a live slot row and not for a backtest row or the pre-market row, and it still saves. The trust test rejects a post-cutoff row with a null multiplier or RV, and keeps a pre-cutoff one. Each with the failure modes R4 asks for.

## As built (parts 1 to 3, 2026-11-25)

Where the build differs from the text above, and why.

- **Part 1.** `clusterMultForSave(signal)` in `src/utils/volatility-cluster.ts` is `null` when `signal.cluster == null`, else `signal.mult`. App passes it to `buildSnapshotMeta`, and a pure helper means the live-session harness test runs the same rule as App.
  - The two tilts are nulled in `useSnapshotSave`'s payload when the meta's multiplier is null, not in the signals. The screen, the Volatility Clustering panel and the analyze context still read the working value 1.
  - The server schema already accepted null for all three (`num` is `nullable().optional()`); a validation test now pins the whole gap row (multiplier, tilts, RV, RV/IV and its label all null).
  - A real multiplier of exactly 1 (a cluster whose bucket gives 1) still saves as 1: the rule is `cluster == null`, not `mult === 1`.
- **Part 2.** The alert runs after a successful save of a live row, in `api/snapshot.ts`. A save that fails has its own report (`captureException`), and a row that was never saved cannot feed the features, so it raises no gap alert.
  - There is no `pre-market` guard in the handler: that row is written by `/api/pre-market`, and a live post under that label is refused by the quote check (`bad-entry-time`, 422) before this check. A test pins the refusal, so the alert cannot fire for it.
  - A field left out of the body counts as missing, as a null does. The warning also writes one pino line per such save (about one a slot during a gap).
  - Sentry groups every event of a date under the fingerprint `['snapshot-missing-yesterday-fields', date]`, so a gap that spans slots is one issue.
- **Part 3.** The rule is a column the database computes, like `flag_reliable`: `SNAPSHOT_TRUST_COLUMNS_SQL` gains `missing_yesterday` (`created_at >= MISSING_YESTERDAY_CUTOFF AND (cluster_mult IS NULL OR rv_annualized IS NULL)`), and `featureSnapshotRejection` returns `missing-yesterday` when it is true, as its last test. The Chicago-time comparison stays in Postgres, and a pglite test runs the real text on both sides of the cutoff and under another session time zone.
  - `scripts/_lib/snapshot-price-context.ts` needed no change: it reads the same SQL text and calls `pickFeatureSnapshot`, so its pick report follows the rule. A pglite test shows the plan cannot rescue such a row.
  - A reliable backtest row takes the test too.
  - If the deploy slips past the open, the old app's rows in a gap carry a multiplier of 1 but still a null RV, so the RV half of the test catches them.
- **Trust spec.** `2026-11-22-feature-snapshot-trust-design.md` has the new test 9.
- **Not done here.** Part 4, the Sentry alert rule, waits for the owner's OK.
