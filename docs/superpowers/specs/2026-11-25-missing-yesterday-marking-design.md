# Mark snapshot rows saved without a current yesterday

## Goal

When the app has no current "yesterday" (the prior session's open, high and low), a snapshot row must say so, not store a cluster multiplier of 1.0 that reads like a real "no clustering" value. Such a row must never feed the day's ML features, and the owner must hear about it.

## Why

Since the yesterday fix of 2026-11-24 (main 4b3013d46..49f280df9), the app shows nothing for RV/IV and the cluster multiplier until it holds the last completed session, instead of an older one. On screen that is honest. But a row saved in that gap stores:

- `cluster_mult = 1` and `cluster_put_mult = cluster_call_mult = 1`. `computeClusterSignal` returns its no-data fallback `{ rangePct: null, cluster: null, mult: 1 }` (src/utils/volatility-cluster.ts:31). App passes `cluster.signal.mult` to the save (src/App.tsx:631, :701), and `useRegimeClassification` sets both tilts to that 1 (src/hooks/useRegimeClassification.ts:184-186).
- `rv_annualized`, `rv_iv_ratio` and `rv_iv_label` as null, because `useRangeAnalysis` leaves them null without yesterday's high and low (:269-289).
- Range estimates and delta ceilings computed as if the multiplier were 1.

`build-features` copies `cluster_mult` into the day's features unchanged (api/cron/build-features.ts:373). So a 10:00 row saved in the gap feeds a fake 1.0 to the ML data, as the months of 1.0 rows found on 2026-11-07 did. Nothing alerts: the `yesterday.wrong_day` counter (api/yesterday.ts:204) counts only the server answering with the wrong day, not the app's own request failing.

How often: rarely and briefly. The app re-asks for yesterday every poll tick in the session while it lacks the current one, so a gap lasts as long as Schwab's daily candle is late or requests fail. This frequency is not measured.

## Approaches

1. **Save but mark (chosen by the owner, 2026-11-25 00:06 CT).** The row is saved with the yesterday-derived multipliers empty, the owner gets an email for a live row that arrives without them, and the feature build does not pick such a row. Every slot keeps a row, and nothing fake reaches the features.
2. **Don't save until yesterday arrives.** No incomplete rows, but the slots in the gap stay empty until the planned server snapshot builder fills them, the same trade as the 8:30 stale-quote refusal on 2026-11-17.
3. **The server fills yesterday in.** It fits the owner's backend rule best, but the range estimates and ceilings are computed in the browser from the multiplier. They would still assume 1, so the row would contradict itself until the snapshot builder moves that logic to the server (server-snapshot-builder spec, phases 3-6).

Approach 3 is where this ends up once the server builder writes rows; approach 1 is the honest stopgap until then.

## Design

### 1. The save posts empty multipliers when the cluster had no inputs

- **Where:** in the payload assembly in `src/hooks/useSnapshotSave.ts`, not in App. Server-builder phase 3 moves that assembly into `src/utils`, and its phase 4 parity test compares the builder's row with the page's field for field (docs/superpowers/specs/2026-11-17-server-snapshot-builder-design.md). With the rule in App, the builder would write 1.0 again.
- **What:** the save's meta gains a flag saying whether the cluster had inputs (`cluster.signal.cluster != null`). When the flag is false, the payload's `clusterMult`, `clusterPutMult` and `clusterCallMult` are all null. The tilts come from `signals`, not the meta (useSnapshotSave.ts:479-480), so all three are nulled in the payload assembly.
- **The screen is unchanged.** The panels keep 1 as the working value, as today.
- **RV, RV/IV and its label** are already null in that case.
- **The range estimates and ceilings** on such a row stay as computed, at a multiplier of 1. The empty multiplier marks the whole row, and part 3 keeps it out of the features.
- **The server already accepts null** for all three multipliers: `num` is nullable (api/_lib/validation/common.ts:93), and the save writes `?? null` (api/_lib/db-snapshots.ts:161, :174).
- **Re-post once the gap closes.**
  - Each key posts once per session, and a 200 keeps it marked (useSnapshotSave.ts:394-408, :526-529). So a gap of a few seconds at the start of a slot would leave that slot's row empty for good, though yesterday arrives within the slot.
  - A key saved with the mark (the same predicate as parts 2 and 3: `clusterMult` or `rvAnnualized` null) is posted once more when the mark clears, but only while that key is still the page's entry time. This is the same window as the existing re-post of a refused key.
  - **The re-post is armed only by the marked POST's 200 response,** not when it is sent.
    - The key is marked before the fetch (useSnapshotSave.ts:408). Quotes and yesterday land in separate `setData` calls (useMarketData.ts:439-447, :465-470), and a save can take up to two 10 s tries (db-snapshots.ts:130-243).
    - So yesterday can arrive while the marked POST is still in flight. A re-post sent then can commit first, and the marked insert can land second and leave the row marked, with the one re-post spent.
    - If the mark has already cleared by the time the 200 lands, the re-post goes out at once.
  - The live upsert overwrites the row in place and keeps `created_at`.
- **The owner's manual edit of yesterday's range** (author's call; the owner can override):
  - An edit gives the cluster inputs, so the multiplier is saved as typed. RV ignores edits (useRangeAnalysis.ts:269-271), so it stays null. A row saved in a gap with an edit therefore still alerts and is still not trusted. Hand-typed values don't make a row trustworthy for the features.
  - A half-typed or reversed edit while yesterday is present gives a null cluster: `parse('')` is NaN, so `computeClusterSignal` returns its no-data value. That row is marked and alerts although yesterday exists. It is rare, and the mark is honest about what was used.

### 2. The server emails the owner about a live row without yesterday's fields

In `api/snapshot.ts`, after the existing refusals, a live save (`isBacktest !== true`) whose `rvAnnualized` or `clusterMult` is null:

- **is saved as sent,** with no refusal;
- **is counted:** `metrics.increment('snapshot.missing_yesterday_fields')`;
- **is reported:** `Sentry.captureMessage('snapshot.missing_yesterday_fields', …)` at level `error`.
  - It carries tag `snapshot_gap: missing_yesterday_fields`, fingerprint `['snapshot-missing-yesterday-fields', date]`, and extra `{ date, entryTime, rvMissing, clusterMissing }`.
  - **Every qualifying save calls it.** Sentry groups the calls by the fingerprint into one issue per date. There is no in-memory record of dates already reported (R1).
  - **Why `error`:** the project's existing high-priority issue rule emails the owner on a new `error` issue and skips warnings. That is how the feature build's daily no-pick report reaches the owner (build-features.ts:318-329; trust spec "No Sentry rule changes"). So this needs no new Sentry rule and no rule change. Each date opens a new issue, which means one email per date with a gap.

Only `/api/snapshot` sees slot saves; the `pre-market` row is written by api/pre-market.ts and api/cron/auto-prefill-premarket.ts, so it needs no exclusion. Backtest rows are not reported: the replay driver checks them.

### 3. The feature build won't pick a row without yesterday's fields

`featureSnapshotRejection` (api/cron/build-features.ts) gets one more test, with its own named rejection reason (it shows in the no-pick counts). A row is not trusted when either holds:

- `cluster_mult IS NULL`, on any date. Checked 2026-11-25: all 121 existing rows with a null multiplier are `pre-market` rows, and test 1 already rejects those because they have no slot. So no existing pick changes. This half also catches an old row rewritten in place without yesterday, such as by a replay or the phase 6 rebuild, which keep `created_at`.
- `rv_annualized IS NULL` on a row with `created_at >= '2026-11-25 00:00 America/Chicago'`. Older history has about 1,300 slot rows with no RV, mostly January to August, from before RV was saved on every row. Judging those would blank their dates on a rebuild.
  - The cutoff is fixed now, not tied to the deploy. An old-app row saved after it in a gap stores multiplier 1 with RV null, so it is rejected, which is right. An old-app row with yesterday has both, so it stays trusted. A cutoff that lands before a delayed push is harmless, and stale PWA tabs are covered.

How both readers get it:

- **One computed column.** Add it to `SNAPSHOT_TRUST_COLUMNS_SQL` and its field to `SnapshotTrustColumns`, e.g. `(cluster_mult IS NULL OR (rv_annualized IS NULL AND created_at >= TIMESTAMPTZ '2026-11-25 00:00 America/Chicago')) AS missing_yesterday`. That keeps all time-zone math in Postgres, as the module requires.
- **Both readers splice that text:** build-features and `scripts/_lib/snapshot-price-context.ts` (`readRows`, used by `featurePickChange`). Neither selects `rv_annualized` today, so the script would otherwise read undefined.
- **A pglite test at the cutoff instant** goes in the `SNAPSHOT_TRUST_COLUMNS_SQL` suite (snapshot-price-context-pglite.test.ts).
- **The rest of the rule is unchanged.** The pick moves to the nearest trusted row within ±60 min of 10:00 CT. With none, the day gets no snapshot features and the existing no-pick report fires.
- **Docs:** add the test to docs/superpowers/specs/2026-11-22-feature-snapshot-trust-design.md. Add a line to the server-builder spec saying its payload assembly carries part 1's rule.

## Non-goals

- Computing yesterday on the server (approach 3). That is the snapshot builder's job.
- Repairing the legacy 1.0 rows saved since 2026-08-25 that were never replayed. That is an open follow-up in the snapshot-replay-repair notes.
- Changing what the screen shows during a gap.
- Reporting backtest rows.

## Known limits

- **Two open tabs.** A live re-save overwrites every column (db-snapshots.ts:184-238). If tab B is in a gap and saves 10:00 after tab A saved good values, the row is nulled. Tab B's own re-post (part 1) restores the values once its yesterday arrives, while 10:00 is still its slot. An empty mark is still better than a fake 1.0.
- **An email per date with any gap,** including a gap a re-post heals within seconds. If that proves noisy, revisit, for example by reporting only rows still null when the slot ends. That would need the server builder.

## Files

- **Part 1:**
  - src/hooks/useSnapshotSave.ts (payload rule, flag, re-post) and src/App.tsx (pass the flag);
  - tests in the save hook's suite and src/__tests__/App.cluster-mult-wiring.test.ts.
  - Two existing tests assert today's behaviour and must change, not be "fixed" back:
    - src/__tests__/hooks/liveSessionSave.test.ts:973-1003 expects 1 for all three multipliers on a date with no previous day;
    - src/__tests__/App.cluster-mult-wiring.test.ts:33, :78-83 pin the `clusterMult` wiring literal.
  - Keep each commit to 5 files or fewer.
- **Part 2:** api/snapshot.ts and api/__tests__/snapshot.test.ts.
- **Part 3:** split across two commits so each stays at 5 files or fewer:
  - one: build-features.ts and its test; scripts/_lib/snapshot-price-context-pglite.test.ts; and the fixtures in scripts/_lib/snapshot-price-context.test.ts (:121-137) and scripts/_lib/snapshot-price-context-cli.test.ts (:68-82), which break the type-check once `missing_yesterday` is a required field.
    - `snapshot-price-context.ts` itself likely needs no change: `readRows` already splices `SNAPSHOT_TRUST_COLUMNS_SQL` (:1005), and `SnapshotRowIn` extends `SnapshotTrustColumns` (:197). Keep the field required.
  - two: the trust spec and the server-builder spec lines.
- **The cutoff is safe from the start:** a production SELECT at 2026-11-25 00:22 CT found no rows of any kind created since `2026-11-25 00:00 America/Chicago`.

## Constraints

- **No new column and no migration.** The mark is the empty multiplier, plus the row's `created_at` for RV.
- **Push parts 1-3 together,** outside the owner's trading day (not between the pre-open and the 15:00 CT close on a weekday).
- **Tests: TDD**, each with the failure modes R4 asks for:
  - a save without cluster inputs posts null for all three multipliers, and a save with them posts numbers;
  - a marked key re-posts once when the mark clears while it is still the entry time, and not after the slot has moved on. With an owner's edit held, the mark clears once RV arrives;
  - when yesterday arrives while the marked POST is still pending, the re-post waits for that POST's 200, then goes out;
  - the server reports every qualifying live save, at `error` with the per-date fingerprint and the date in extras, and still saves it. It does not report a backtest row;
  - the trust column is true for a null multiplier on any date, and for null RV at and after the cutoff instant but not before it. A pre-cutoff slot row with null RV stays trusted.

## As built (parts 1 to 3, 2026-11-25)

The build follows the spec. Where it differs from the text above, and how each part landed:

- **Part 1, where the rule lives.** `clusterMultForSave(signal)` (`src/utils/volatility-cluster.ts`) is null when `signal.cluster == null`, else `signal.mult`. App passes it as the save meta's `clusterMult`, and a pure helper means the live-session harness runs the same rule as App.
  - The payload assembly in `useSnapshotSave.ts` nulls `clusterPutMult` and `clusterCallMult` when the meta's multiplier is null (they come from `signals`, which keep the working value 1 for the screen). The meta's multiplier must come from `clusterMultForSave`, which is what server-builder phase 3 has to keep (a line in that spec says so).
  - A real multiplier of exactly 1 still saves as 1: the rule is `cluster == null`, not `mult === 1`.
- **Part 1, the re-post.** A key saved marked (payload `clusterMult` or `rvAnnualized` null) is armed when its POST is answered 200, and a tick re-runs the save effect then. The effect posts the key once more if its mark has cleared and it is still the entry time, so a mark that cleared while the POST was in flight posts at once, and one that clears later posts on the next run. A key whose marked POST got a 400, or was aborted, is not armed.
  - The mark's predicate is the server's and the trust column's: no multiplier or no RV. With an owner's edit held, the multiplier is set and RV stays null, so the re-post waits for RV.
- **Part 2.** Every live save with a null or absent `rvAnnualized` or `clusterMult` is counted and reported at `error` with the per-date fingerprint, after the row is saved. A save the database rejects is not reported here (its own report fires), and a backtest row is not reported. There is no `pre-market` exclusion: that row is not written by this endpoint, and a live post with that label is refused (`bad-entry-time`, 422) before the check, which a test pins. Nothing remembers dates already reported.
- **Part 3.** One computed column, `missing_yesterday` in `SNAPSHOT_TRUST_COLUMNS_SQL`: `cluster_mult IS NULL OR (rv_annualized IS NULL AND created_at >= TIMESTAMPTZ '2026-11-25 00:00 America/Chicago')`. `featureSnapshotRejection` returns `missing-yesterday` for it as its last test, reliable backtests included. The field is required on `SnapshotTrustColumns`, so the fixtures in `snapshot-price-context.test.ts` and `snapshot-price-context-cli.test.ts` carry it.
  - `scripts/_lib/snapshot-price-context.ts` needed no change: `readRows` already splices the SQL text and `featurePickChange` calls `pickFeatureSnapshot`. A pglite test shows the plan cannot rescue such a row.
  - The pglite suite runs the real text one second either side of the cutoff, for each field null, for old rows with no RV (trusted) and with no multiplier (rejected), and under a Tokyo session time zone.
- **Docs.** The trust spec has test 9, and the server-builder spec has the line for its payload assembly.
- **Not done here.** Part 4 is not needed: the report is at `error`, so the existing high-priority rule emails the owner and no Sentry rule is added.
