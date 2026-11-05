---
status: Plan
date: 2026-10-29
---

# Rebuild the 2026-07-22 → 09-04 Unusual Whales outage

## Goal

Refill everything the summer UW outage erased: the fire inputs, the fires themselves, their outcomes and Take-It scores, and the derived tables. The fire history and training data then run continuously from June to today. Owner decision 2026-10-29: the gap came from UW billing and API-key trouble, not a choice, so rebuild it ("ALWAYS backfill and correct where we can", 2026-10-28).

## What the outage covered (inventory 2026-10-29, verified in Neon and against UW)

The full per-table inventory, with probes and request counts, is in `docs/tmp/summer-gap-2026-10-29/inventory.md` (gitignored, local).

- **Edges.**
  - **07-21:** normal.
  - **07-22:** partial. REST crons die ~09:45 CT and the websocket ~10:03–10:42 CT. The last lottery fire is at 10:41 CT (1,343 fires that day).
  - **07-23 → 09-04:** dark, 32 trading days with zero lottery or silent-boom fires. 09-04 has a handful of series that a 09-08 premarket catch-up wrote.
  - **09-07:** Labor Day.
  - **09-08:** normal again.
  - Rebuild size, estimated from neighbouring days: 33 days, ~160K lottery fires, ~4.5K silent-boom alerts.
- **Dark:**
  - every UW REST-fed table: `flow_data` (all sources), `spot_exposures`, `greek_exposure(_strike)`, `strike_exposures`, `gex_strike_0dte`, `oi_*`, `vol_*`, `nope_ticks`, ETF and index candles, `vega_flow_etf`, `net_flow_per_ticker_history`, `strike_trade_volume`, `zero_gamma_levels`, `gex_target_features`;
  - the uw-stream tables;
  - the tables derived from them.
  - `flow_data` `zero_dte_index` and `flow_ratio_monitor` succeeded intermittently on some dark days. Re-pull those days rather than trust them.
- **Rows that exist but are placeholders computed on empty inputs**, to be recomputed and overwritten rather than inserted:
  - `opening_flow_signals` (`no_tickets`);
  - `flow_regime_snapshots` (`n_trades = 0`);
  - `training_features` (21–45 of 174 columns);
  - `takeit_health_daily` (`rows_scored = 0`).
- **Not affected:**
  - **GEXBot** ran the whole time. Neon keeps ~1 day, but the Blob archive holds all 33 days of `gexbot_snapshots` and `gexbot_api_capture` (`gexbot_archive_audit`, with sha256).
  - **Schwab** tables are complete, apart from a few partial `strike_iv_snapshots` hours.
- **Separate outage:** Databento `futures_bars` is missing 08-06, 08-07, 08-11 → 08-14 and 09-04 → 09-25. That is not UW billing, and UW's futures candles cannot fill it at 1-minute resolution (no date parameter; 1m capped at the newest 5,000 rows). Out of scope here.

## What can and cannot come back

- **Full 1-minute history by date.** Every date-parameter UW endpoint is inside the plan's lookback (730 trading days on Advanced; the account is not `trialing`). Probes 07-23:
  - `net-prem-ticks` returned the full 1-minute day (405 SPY rows);
  - `spot-exposures` returned the full series (the 09-08 catch-up wrote all 564 rows of 09-04);
  - dark-pool paging works.
- **The option tape.** `/api/option-trades/full-tape/2026-07-23` → 302 to a 1.5 GB zip. The summer files use the 40-column layout, which has every field the replay needs.
- **End-of-day only.** `spot-exposures/expiry-strike?date=` returns one snapshot per date (07-23 SPX 0DTE: 50 strikes at 20:13:42Z). So `strike_exposures`, `gex_strike_0dte`, `gex_target_features` and `zero_gamma_levels` come back with one end-of-day row per day, not the intraday series. The rows carry their real snapshot time, so any point-in-time read (`ts <= fire time`) skips them, as it must.
- **Probably lost.** Both flow-alert tables (`flow_alerts`, `ws_flow_alerts`): the REST probe returned 0 rows where dozens are normal.
- **Lost:** July point-in-time `lottery_ticker_stats`, flow values UW restated after the close, and the partial Schwab `strike_iv_snapshots` hours.

## Phases

Each phase lands on main by itself, through `npm run review` and the code-reviewer loop. Every script follows the `scripts/backfill-range-pos.mjs` pattern:

- `--dry-run`, `--from`/`--to`, `--limit`;
- a one-day probe before the full run;
- idempotent upserts in ≤500-row `unnest` chunks;
- a market-hours guard;
- a printed per-day summary.

UW requests are throttled to ≤300/min so the live crons keep the rest of the key's 2,000/min cap.

1. **Prerequisites** (small).
   - Fix the hardcoded Mac paths in the reused scripts: `backfill_net_flow_history.py`, `reload-ws-option-trades-from-fulltape.py`, `backfill_interval_ba_alerts.py` and the parquet outcome scripts.
   - Add a date-range option to `backfill-net-prem-ticks.mjs`.
   - Fix the stale "last 3 trading days" comment in `scripts/download-fulltape.sh`.
2. **Full Tape.**
   - **Landed by the `nightly` Railway service, not locally** (found 2026-10-29). It fills every missing session since 2026-01-02 into `fulltape/{date}-fulltape.parquet`, newest first, up to 30 per run, Tue–Sat 07:15 UTC. The gap lands over the 10-30 and 10-31 runs. Do not run `download-fulltape.sh`, `ingest-fulltape.py` or `upload-fulltape-to-r2.py` for these days: they would duplicate about 60 GB of downloads, and the service deletes a key whose post-upload size check fails, racing a local upload. A push touching `nightly/` redeploys the service and kills a run in progress.
   - Then cut per-day replay tapes for the 86-ticker universe from the R2 objects, the same rows `replay-day.ts` reads. That needs an R2 → local download step (no script exists yet; see the phase B/E plan, E2). The mapping is in `reload-ws-option-trades-from-fulltape.py`: drop canceled and zero-price prints, and take side from `tags`. Don't run that reload script itself: `ws_option_trades`'s 2-day retention deletes reloaded rows.
3. **REST inputs.**
   - One existing script per table, run over 07-22 → 09-04 (table list and scripts in the inventory, §2a).
   - ~9–10K UW requests in all, ~2.9K of them for `net_flow_per_ticker_history`.
   - Write new scripts only where none exists: `strike_trade_volume` (`/stock/{t}/flow-per-strike-intraday?date=`, probe first) and `economic_events` (probe past-date support first).
   - Dark pool: ~1.3–1.65K paged requests, with the three UW filter rules applied.
   - **Done 2026-10-29** (0 failures each): `net_flow_per_ticker_history` 1,063,486 rows (all 86 tickers × 33 days), `vega_flow_etf` 0DTE 26,574 rows (+162 07-22 morning minutes updated to their final values), `gex_strike_0dte` end-of-day snapshots 2,652 rows.
   - **The rest need code first.** The 2026-10-29 script audit (local, `docs/tmp/summer-gap-2026-10-29/phase3-script-audit.md`) found most scripts take only a lookback count and warn-and-exit-0 on UW or DB errors. Retrofit `--from/--to`, the market-hours guard, the throttle and error counting from `scripts/_lib/net-prem-ticks-backfill.mjs`. Scripts not to run as they are:
     - `backfill-greek-flow-etf.mjs`: its conflict target was dropped by migration #129, so every row fails while it exits 0;
     - `backfill-greek-flow.mjs`: doesn't write `otm_ncp/otm_npp`, so DO NOTHING would leave them NULL for good;
     - `backfill-zero-dte-flow.mjs`: DO NOTHING keeps the untrusted intermittent rows (needs DO UPDATE and the cron's all-null guard);
     - `backfill-flow-ratio.mjs`: duplicates on tick vs wall-clock time, unclamped ratio overflow, silent UW errors;
     - `backfill-spot-gex.mjs`: keeps the last tick per 5-minute bucket (look-ahead); write every tick as the cron does;
     - `backfill-vol-surface.mjs`: stores forward realized vol (fix in `docs/superpowers/plans/2026-10-23-uw-rest-fixes.md`, R2);
     - `backfill-nope.mjs`, `backfill-oi-*`: a lookback run overwrites live days or misdates around Labor Day;
     - the strike-exposure trio (NDX, timestamp, holiday-aware 1DTE, resume scoping, strike-all paging);
     - the SPX/NDX candle scripts (hardcoded 30 days, constant ratio);
     - `backfill-dark-pool-prints.mjs` (swallows failures, no ET-date stop).
   - Owner decisions this phase needs: the SPX/NDX price-ratio source for July–September index candles, and the realized-vol D2 fix. Defaults from standing rules for the rest: 1-minute spot exposures (as live), the dark-pool filter rule applied, NDX dropped from `strike_exposures` (as live), lookback runs fill holes only.
4. **Derived tables.** Rebuild from the refilled inputs and the Full Tape, overwriting the placeholder rows:
   - `interval_ba_alerts`, `opening_flow_signals`, `flow_regime_snapshots`;
   - `gex_target_features`, `zero_gamma_levels`;
   - `flow_regime_0dte_daily`, `day_embeddings`;
   - `ws_gamma_setup_fires`, `cone_breach_events`;
   - `periscope_lottery_fires`.
   - Write scripts where none exists: `flow_regime_snapshots`, `cone_breach_events`.
   - Cautions from the 2026-10-29 audit:
     - `backfill-zero-gamma.ts` deletes every row from its window start through today, live rows included; scope it before any run.
     - `gex_target_features` and `flow_regime_0dte_daily` stay dark for 07-23 → 09-04: neither can be built from one end-of-day snapshot a day.
     - The gamma-setup and periscope-lottery backfills are paused on GEXBot data and do nothing without `--include-gexbot`; leave them dark until that pause is lifted.
     - `day_embeddings` needs a Postgres-sourced script (the existing one reads a sidecar archive frozen at 04-17), and `opening_flow_signals` needs a Full Tape reader.
5. **Fire replay.** This is phase E of `lottery-cron-timeouts-2026-10-28.md`, and it needs that spec's phase B, which makes the detector callable as a library. The detailed design is `docs/superpowers/plans/2026-10-29-lottery-phase-b-e.md`; the summer days run in its `pit` (point-in-time) visibility mode.
   - Run day by day, lottery and silent boom together, in date order. Each day's prior-session win rate is built from the previous days' outcomes, so outcomes are enriched between days.
   - GEXBot context comes from the Blob archive, not Neon.
   - Seed cooldown from the live 07-22 morning rows. Insert only chains with no live fire within ±5 min.
   - Mark every inserted row recovered.
   - No classifier calls. If the classifier replacement's phase 4 has shipped, fill its anchor columns from the tape's `tags`.
   - The same pipeline recovers the 10-16 → 10-28 timeout losses.
6. **After the fires.**
   - Outcomes through the parquet path (the tape is past `ws_option_trades` retention).
   - Take-It scores with the current bundle.
   - The ticker-stats refit, the flow-inversion pass (~25K UW requests), round-trip and wave2.
   - `training_features` via `/api/journal/backfill-features`, then `takeit_health_daily`.
   - The same pass also covers two older outcome holes the inventory found: silent-boom rows next to the gap stamped enriched with NULL outcomes, and `option_intraday_nbbo_fetches` empty 06-12 → 10-19.
7. **Verify.**
   - Per-day row counts for every table against the days on either side of the gap.
   - Fire counts per day against the neighbouring weeks.
   - A spot check of 3 rebuilt days against the tape.
   - A final inventory diff.

## Files to create or modify

- **Phase 1:** the four scripts named above, plus `scripts/download-fulltape.sh`.
- **Phase 2:** a Full Tape batch runner, likely `scripts/fulltape-batch.mjs`, or the `uw-options-data-lake` skill's downloader; `scripts/upload-fulltape-to-r2.py`.
- **Phase 3:** new `scripts/backfill-strike-trade-volume.mjs` and, if UW serves past dates, `scripts/backfill-economic-events.mjs`.
- **Phase 4:** new `scripts/backfill-flow-regime-snapshots.ts`, `scripts/backfill-cone-breach-events.ts`.
- **Phases 5–6:** per `lottery-cron-timeouts-2026-10-28.md` phase E, plus a migration for the recovered marker.

## Data dependencies

- UW REST (~35K requests in all, off-hours) and the UW Full Tape (33 downloads).
- Vercel Blob: the GEXBot archive. R2: the Full Tape mirror.
- Prod Neon writes only through the backfill scripts.
- One migration in phase 5 for the recovered marker.

## Open questions (defaults)

1. **Replay code version.** Current code or the July code? Eight detector commits have landed since 09-08. Default: **current code**, so recovered rows carry the same features and scores as live rows. Ask the owner before phase 5; this is a methodology choice.
2. **Fields that cannot be rebuilt point-in-time** (intraday strike GEX, July ticker stats). Default: leave NULL rather than substitute end-of-day values, which would leak the close into fire-time features. The recovered marker lets ML include or exclude those rows.
3. **Flow alerts.** Default: one more REST probe with other parameters; if it is still empty, accept the loss and note it here.
4. **Recovered marker.** Default: `recovered_at timestamptz NULL`, as in the lottery-timeouts spec.
5. **Order against other work.** Phases 1–4 can start now. Phase 5 waits for lottery-timeouts phase B and is best run after the classifier replacement's phase 4.

## Thresholds / constants

- UW throttle: ≤300 requests/min per script; never during 08:30–15:00 CT.
- Upsert chunk: 500 rows (`unnest`).
- Recovery dedupe: no live fire on the same chain within ±5 min.
- Gap: 2026-07-22 (from the cut) through 2026-09-04.
