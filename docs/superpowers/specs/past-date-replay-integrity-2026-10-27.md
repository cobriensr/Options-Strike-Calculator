# Past-date replay integrity (2026-10-27)

## Goal

When a past date is selected, every calculator input, signal, analysis payload and saved snapshot comes from that date's own data, never from today's live quotes. `market_snapshots` stores only rows whose data belongs to the row's date.

## Why now

The VIX-mode fix (`fix/rr-vixmode`, review-remediation F4e) went through five review rounds. Each round found another path where a past-date view reads today's live data. The owner chose to finish VIX-mode's own scope and move the rest here (decision 2026-10-27).

## Findings (prod, read-only, 2026-10-27)

### `market_snapshots`

The table has 4,743 rows from 2026-01-01 to 2026-10-27: 682 with `is_backtest = false` and 4,061 with `true`.

220 of the 682 `is_backtest = false` rows were created on a different ET day than their `date`:

| Created after `date` | Rows | Distinct dates | Weekend dates | Likely cause |
|---|---|---|---|---|
| 1–2 days | 207 | 12 | 165 rows | A tab whose selected date never rolled forward saved the next session's live data under the old date. Latest example: `date` 2026-07-19 (a Sunday), created Mon 07-20 14:20–14:55 CT. |
| 3–79 days | 13 | 7 | 0 | Browsing a past date saved today's live data under it. Example: 03-02..03-04 rows written 03-16..03-21 at SPX 6506. |

51 of 368 checkable `is_backtest = false` rows have an SPX value outside that date's SPX high–low range (±0.5%), checked against `index_candles_1m`. That includes about 45 rows on 03-23..03-30 at a constant SPX of about 5,720, while SPX traded 6,290–6,630. That looks like a placeholder or stale spot (perhaps SPY 572 × 10); the cause is not yet known.

The upsert is `ON CONFLICT (date, entry_time) DO UPDATE` and never touches `created_at`, so a real row that was overwritten in place cannot be seen by timestamp. The range check above is the only signal we have for those.

### The `is_backtest` flag

`App.tsx` ~:559 sets `isBacktest: !!historySnapshot`. As a result:

- A past date without intraday history saves today's live values marked `is_backtest = false`.
- Today has a history snapshot once its candles exist, so today's real live saves are probably marked `is_backtest = true`. Verify this; if it holds, the flag means the opposite of its name for most rows.

### Consumers that read `market_snapshots`

These are affected by the bad rows:

- the VIX/SPX divergence check in Claude's analyze context, which builds VIX intraday bars from `market_snapshots`;
- `pre_market_data` in `analyze-context-fetchers.ts`;
- VIX OHLC derivation in `db-snapshots.ts` ~:318;
- ML features in `build-features-phase2.ts`.

## Code paths that read live data on past dates

These come from the VIX-mode reviews, rounds 2–5.

1. **`useSnapshotSave`** (enabled in `App.tsx` ~:566-579). It is enabled by `market.hasData` on any date and upserts on `(date, entry_time)`.
2. **`useComputedSignals`** ~:202-208. It chooses live or snapshot VIX1D/VIX9D/VVIX by whether a snapshot exists, not by the selected date. `sigmaSource` reads `'VIX1D'` even in VIX mode. This feeds the card's Curve Shape, `useAnalysisContext` ~:145 (Claude's analysis of that date) and `useSnapshotSave` ~:113.
3. **`useAutoFill`.** Its no-history branch and its live effect restore today's SPY/SPX on past dates that have no intraday history (older than about 60 days). Strikes for those dates are priced off today's spot. Nothing in autofill has a daily SPX source.
4. **`App.tsx` `vixOHLCFromHistory`** ~:359-375. It uses the previous date's history while the new date's history loads. The fix is one line: also require `historyData.history?.date === vix.selectedDate`.
5. **Selected date never rolls forward** on a tab left open from a weekend into Monday. This is inferred from the 165 weekend-dated rows; verify it.
6. **CT vs ET.** `useVixData` ~:44-46 initialises `selectedDate` in America/Chicago, but every past-date check uses ET. From 23:00 to 24:00 CT, today counts as past.
7. **Past-date predicate.** It is written four or more ways (`useAutoFill`, `IVInputSection`, `App.tsx` `isBacktestMode`, `useHistoryData`, `useVixData`). Replace them all with one `isPastETDate(date)` in `src/utils/timezone.ts`.
8. **Typed values replaced on a time scrub.** A typed VIX or σ on a past date is overwritten when the time changes. This is owner decision Q16 / remediation phase 3.12. Since `fix/rr-vixmode`, `useVixData` also writes the daily VIX in DIRECT mode on past dates, so 3.12 needs a `vixEdited` guard there as well.

### More paths from the VIX-mode round-5 review

9. **A date with no daily VIX at all** keeps another date's VIX in both modes. That means no table entry, a `/api/vix-ohlc` count of 0 or an error, and no history. This is covered by Q-A, defaulting to blank.
10. **Four writers to the VIX field, ordered only by hook call order:** `useVixData`'s main effect, `useVixData`'s re-apply effect, App's injection, and `useAutoFill`'s history effect. The unread `vixOHLC` dependency and the round-6 `fillsDaily` guard are ordering patches. A CSV upload on a past date with history still lets the daily VIX win when the entry's object reference doesn't change. Phase 6 replaces all four with a single writer.
11. **Today with its own history.** `api/history` serves today, and the history effect runs after the live effect. On every quote poll, today's fields take the 5-minute snapshot over live quotes. Its restore path also ignores `spotEdited` and `spxEdited`.
12. **IVInputSection card key.** `termStructureKey = hist-${candle.datetime}` remounts the card on every 5-minute scrub, which drops a typed VIX1D on a past date with history. Phase 6.
13. **No rollover at ET midnight.** Nothing advances the date in a tab left open past ET midnight. Folds into phase 2.

### Leads from phase 1 (2026-10-27)

14. **Default spot values were probably saved as data.** The `useSpotInputs` defaults are SPY `'572'` and SPX `'5720'`. That matches the 03-23..03-30 rows with a constant SPX of ~5,720. Phase 5 should confirm this and delete those rows. A save guard should also refuse to save untouched default inputs; this belongs to phase 1 follow-ups.
15. **`parseEntryTimeMinutes` (`db-snapshots.ts:217`) may not match App's `'h:mm AM CT'` entry-time format.** If it doesn't, `getVixOhlcFromSnapshots` and `getRecentVixSnapshots` silently ignore calculator rows. Verify against prod, then fix it in phase 3.
16. **Saves lost to aborts.** `useSnapshotSave` aborts its fetch whenever a dependency changes. `signals` changes identity on every render once a history snapshot is set, and an aborted key is never retried, so some backtest saves are probably lost. Phase 6 should look at this alongside the single writer.
17. **Tie-break in `fetchLatestVix`.** When it falls back to yesterday, a replay of yesterday created today wins over yesterday's real last row on `created_at`. A tie-break on `(created_at AT TIME ZONE 'America/New_York')::date = date` fixes it.
18. **Analyze ran in backtest mode during live sessions.** `useAnalysisContext` sent `isBacktest: !!historySnapshot`. Any tab loaded after the first candle therefore ran every analysis as a backtest: no positions, no previous recommendation, no SPX candles, and "Backtest mode: YES". **Fixed in phase 1 commit 6.**

## Phases

Each phase has its own worktree and the full Get It Right loop.

0. **Phase 1 shipped 2026-10-27 at 20:38 CT.** Seven commits, `ae1bb53f` … `5e2ea438`:
   - save rules flagged by date;
   - a backtest save can't replace a live row;
   - the current-VIX reads are keyed on the row's date;
   - the history VIX OHLC uses the selected date's own history only;
   - one shared `isPastETDate`;
   - analyze `isBacktest` by date. Live sessions get positions and SPX candles again, and the prompt now says "Backtest mode: NO".
   - the "Backtesting:" data note by date.

   The code review returned "continue". The owner chose to ship and do round 2 next. The analyze-prompt review passed.

   **Phase 1 round 2 (next stream).** From the phase-1 review:
   - **B1:** a "today" save doesn't check where its inputs came from. Switching from a past date to today saves the past date's values (and the 572/5720 defaults) as today's live row. Give `'live'` an input-identity gate: SPX/VIX must match the live quote or today's own history. The past-date gate also needs `spy`, so a live SPX within 1 point by coincidence can't pass.
   - **B2:** the server trusts the client's `date` and `isBacktest`. Tabs still running the old bundle (PWA `registerType: 'prompt'`) keep writing live rows under past dates, and the new upsert guard then protects those rows. Make `api/snapshot.ts` skip a live save whose date isn't today ET (send a Sentry warning `snapshot.live_save_for_other_date`) and skip future dates. Tighten the `date` schema to `YYYY-MM-DD`.
   - **N1** (owner decision; default backtest): when today is scrubbed back more than 5 minutes, it replays today's 5-minute history but saves it labelled live. Treat it as a backtest with the history gate, using an extracted `isBacktestMode` helper.
   - **N2:** a weekend or holiday "today" saves Friday's quotes as live. Allow `'live'` only on session days.
   - **N3:** `fetchLatestVix` tie-break (lead 17).
   - **N4:** a `skipped: 'live-row'` marker, so a kept live row is distinct from a DB error.
   - **N5:** `useSnapshotSave` must check `res.ok`, release the key, report non-2xx responses other than 401/403, and only post for the owner.
   - **N6:** App wiring tests for the snapshot `history` meta and `historyVixOHLC`.
   - **Prompt-review follow-ups:**
     - compute the backtest flag once and share it;
     - add an ET-midnight dependency in the memos;
     - change the dataNote wording to "past date".
   - **Lead 15: confirmed against prod on 2026-10-27, and deliberately NOT fixed in round 2.**
     - **Evidence:** the 5 newest `entry_time` values are all `"h:mm PM CT"`.
     - **Why it waits:** a parser fix would make `/api/vix-ohlc` (`getVixOhlcFromSnapshots`) return snapshot-derived VIX OHLC for every date after the static VIX table ends (2026-03-06). Those rows still include the 220 misdated rows and the constant-5,720 week. That OHLC would override App's candle-derived fallback and feed the VIX field, σ in VIX mode and analyze's VIX.
     - **When:** do it right after the phase-5 repair. Fix the server parser (`db-snapshots.ts` ~:217) and the client copy (`useVixTrajectory`) together, convert CT to ET minutes so rows sort consistently, and limit `getVixOhlcFromSnapshots` to rows created on their own date.
     - **Later:** the upsert key keeps its zone suffix, so a CT live row and an ET-labelled replay of the same moment never conflict. Normalise the key format in a migration.
   - **Round 2 shipped status:** see the Progress note when it lands. It is 11 commits, `5f2294dd` … `c07d8138`.
   - **Phase 3:** `fetchVixDivergenceBlock` uses `new Date()`, so a past-date analysis still gets today's divergence.

1. **Stop new damage (S).**
   - Add `isPastETDate`.
   - Never save a snapshot with live data for a date other than today ET.
   - Set `is_backtest` from the selected date, not from snapshot presence. Keep backtest saves for past dates that have their own intraday history.
   - Apply the own-date gate in `vixOHLCFromHistory`.
   - Tests for each.
2. **Date roll-forward (S–M).** Reproduce the weekend-tab case. When the tab was showing "today" and the ET day changes, advance the date. Fix the CT/ET init mismatch.
3. **Signals and analysis context (M).**
   - `useComputedSignals` takes `selectedDate` and drops the live fallback on past dates.
   - `sigmaSource` reports the source actually used.
   - The analysis-context payload for a past date carries only that date's values. The `analyze-prompt-reviewer` agent reviews any context change.
4. **Spot/SPX for past dates without intraday history (M, owner decision Q-B).**
5. **Repair stored rows (owner approval required).**
   - A script with a dry-run report to `docs/tmp/` and a JSONL backup.
   - Delete or relabel the 220 misdated rows and the out-of-range rows (Q-C).
   - Investigate the constant-5,720 rows.
   - Recompute anything derived from them (VIX OHLC, phase-2 features).
6. **Typed values stick (remediation 3.12 folds in here).** A single writer for VIX and σ. Typed values survive scrubbing until the date changes.

## Files (estimate)

| Phase | Files |
|---|---|
| 1 | `src/utils/timezone.ts`, `src/App.tsx`, `src/hooks/useSnapshotSave.ts`, tests |
| 2 | `src/hooks/useVixData.ts`, whichever hook owns the date roll, tests |
| 3 | `src/hooks/useComputedSignals.ts`, `src/hooks/useAnalysisContext.ts`, tests |
| 4 | `src/hooks/useAutoFill.ts` plus a daily-SPX source (TBD), tests |
| 5 | `scripts/repair-market-snapshots.mjs` (new), `scripts/_lib/…`, tests |
| 6 | `src/hooks/useVixData.ts`, `src/hooks/useAutoFill.ts`, `src/App.tsx`, tests |

## Data dependencies

No new tables or env vars. Phase 5 writes to prod `market_snapshots` only after the owner approves the dry run. Phase 4 may need a daily SPX history source (Q-B).

## Open questions (defaults in brackets)

**Answered 2026-10-27:** the owner accepted every default below.

- **Q-A.** On a weekend, holiday or other past date with no data, should the VIX field be blanked (the calculator shows its "VIX must be a number" error) or keep its value with a "no data" marker? [Blank.]
- **Q-B.** Where should spot/SPX come from for dates older than the intraday history? [A daily SPX open/close from an existing stored source if one exists, otherwise blank with a marker. Never today's spot.]
- **Q-C.** What should happen to the misdated rows? Delete them, or move them to their creation date when that date has no row at the same time? [Delete, after a dry-run list.]
- **Q-D.** If the flag is confirmed inverted, should existing `is_backtest` values be rewritten from `date` vs `created_at`? [Yes, in phase 5, after the dry run.]

## Thresholds

- **Out-of-range check:** SPX outside the date's `index_candles_1m` SPX high–low by more than 0.5%.
- **Misdated check:** `(created_at AT TIME ZONE 'America/New_York')::date <> date` for `is_backtest = false` rows.
