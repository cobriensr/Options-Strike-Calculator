# Late-Day BTO Confirmation Detector — two-stage candidate + confirm

**Date:** 2026-05-17
**Status:** spec — scope-out only, NOT ready to implement (thresholds must be tuned first per `feedback_tune_before_ship`)
**Branch:** main (per `feedback_direct_to_main`)

## Goal

Surface 1–3 DTE late-session (13:00–15:00 CT) large ask-side option blocks as CANDIDATE alerts in real-time, then retroactively upgrade them to CONFIRMED / REJECTED / UNKNOWN once Unusual Whales Periscope's lagging BTO/STO open-close classification publishes — giving the trader a fast first look plus a same-day confidence stamp on whether the print was a genuine buy-to-open.

## Empirical anchor case

Friday 2026-05-15 — SPXW 7300P 2026-05-18 (3DTE on Friday):
- 13:30 CT — large ask-side block; QQQ 708P 2026-05-18 spiked alongside it
- 14:20 CT — second large ask-side block on the same SPXW chain
- Lottery Finder did NOT fire on either (the chain was outside its v4 trigger envelope)
- Silent Boom did NOT fire (baseline was not quiet enough at 13:30; ask_pct or vol/OI gates missed)
- Periscope BTO/STO open-close (published post-hoc) confirmed both prints were Buy-To-Open
- The trader caught the move manually but missed the systematic alert

This detector is designed to catch THIS pattern: late-session, near-expiry, ask-heavy, large-premium prints that neither existing detector flags.

## Why a new detector instead of extending Lottery / Silent Boom

| Detector | Signal class | Why it misses the SPXW 7300P case |
|---|---|---|
| Lottery Finder | sustained-burst v4 trigger over 5-min rolling window | Single large block ≠ sustained burst; chain failed the cumulative vol/OI envelope |
| Silent Boom | step-change from quiet trailing baseline | At 14:20 CT a chain may not be "quiet" — the 13:30 print already pushed it above baseline; baseline test is too strict |
| **Late-Day BTO** | **single late-session ask-block on near-expiry contract, confirmed post-hoc by Periscope BTO/STO** | (this spec) |

Different signal class, different time-of-day gate, different post-hoc enrichment. Same architectural shape as the other two — separate table, separate cron, separate UI surface.

## Architecture overview

Two-stage, mirrors `lottery_finder_fires` and `silent_boom_alerts` patterns:

1. **Detect cron** (every minute, 13:00–15:00 CT only) — scans last N minutes of `ws_option_trades`, applies large-block + late-session + DTE filter, INSERTs rows with `status='CANDIDATE'`.
2. **Confirm cron** (every 30 min during market hours + once post-close) — re-reads CANDIDATE rows older than the Periscope publish lag, joins against ingested Periscope BTO/STO data, updates `status` to CONFIRMED / REJECTED / UNKNOWN.
3. **UI** — feed surfacing CANDIDATE + CONFIRMED rows, mirrors LotteryFinder/SilentBoom card patterns.

Periscope BTO/STO ingestion does NOT exist yet in this repo (today's `periscope-scraper` Railway service captures chart/heatmap data via Playwright; the per-strike open-close BTO/STO data is a separate UW surface). A new ingestion path is part of Phase 2.

## Phases

Each phase is independently shippable. Per-phase loop per `feedback_per_phase_loop`: implement → code-reviewer subagent → fix findings → commit+push → next phase. Phase 0 (tuning) must complete BEFORE Phase 1 implementation per `feedback_tune_before_ship`.

### Phase 0 — Threshold tuning (mandatory, pre-implementation)

**Goal:** lock the "large block" definition and the universe filter against the 93-day full-tape parquet archive BEFORE any TypeScript is written.

**Method:** `scripts/late_day_bto_audit.py` (new) — walks every parquet file in `/Users/charlesobrien/Desktop/Eod-Full-Tape-parquet/`, filters to 13:00–15:00 CT trades on 1–3 DTE contracts in the candidate universe, sweeps thresholds on `(size, premium, ask_pct, vol_oi)`, and reports daily fire-density + how many fires correspond to the manual anchor cases the user remembers (SPXW 7300P 2026-05-15 must be in the set; ideally a handful of comparable historical cases the user identifies during scoping).

**Outputs to produce before implementation:**
- A frozen `LATE_DAY_BTO_SPEC_V1` parameter object (thresholds, universe list, time window)
- Daily fire-density table (target: ≤20 candidates/day across the full universe so the feed is scannable)
- Replay verification: SPXW 7300P 2026-05-15 13:30 CT and 14:20 CT both appear in the candidate set under the locked thresholds
- Audit doc at `docs/tmp/late-day-bto-audit-2026-05-17.md`

**Why this gate exists:** every prior detector (Lottery v4, Silent Boom V1, Reignition Top-N) was tuned against the same 93-day archive before code was written. Doing it after ships noisy detectors that need re-tuning weeks later — the `feedback_tune_before_ship` memory was written specifically to enforce this.

### Phase 1 — Schema + detect cron (CANDIDATE pass)

Lands the real-time candidate detector. Periscope ingestion not yet wired — CANDIDATE rows stay CANDIDATE forever until Phase 2 ships.

**Files to create:**
- `api/_lib/late-day-bto.ts` — pure-TS detector. Exports `LATE_DAY_BTO_SPEC_V1` (frozen from Phase 0), `detectLateDayBtoCandidates(buckets: BucketRow[]): CandidateRecord[]`. Mirrors `silent-boom.ts` shape.
- `api/__tests__/late-day-bto.test.ts` — parity tests against the Phase 0 Python script on canonical cases (SPXW 7300P 5/15 must classify as candidate).
- `api/cron/detect-late-day-bto.ts` — cron handler. Reads last 5 min of `ws_option_trades` aggregated by chain × 1-min bucket, applies detector, INSERTs CANDIDATE rows with `ON CONFLICT (option_chain_id, trade_bucket_ct) DO NOTHING`. Wraps in `withCronInstrumentation`.
- `api/__tests__/detect-late-day-bto.test.ts` — cron-level integration test.

**Files to modify:**
- `api/_lib/db-migrations.ts` — append migration (next sequential id) creating table `late_day_bto_alerts`:
  ```sql
  CREATE TABLE IF NOT EXISTS late_day_bto_alerts (
    id                BIGSERIAL PRIMARY KEY,
    date              DATE NOT NULL,
    trade_bucket_ct   TIMESTAMPTZ NOT NULL,
    option_chain_id   TEXT NOT NULL,
    underlying_symbol TEXT NOT NULL,
    option_type       CHAR(1) NOT NULL CHECK (option_type IN ('C','P')),
    strike            NUMERIC NOT NULL,
    expiry            DATE NOT NULL,
    dte               SMALLINT NOT NULL,
    block_size        INT NOT NULL,
    block_premium_usd NUMERIC NOT NULL,
    ask_pct           NUMERIC NOT NULL,
    vol_oi            NUMERIC NOT NULL,
    entry_price       NUMERIC NOT NULL,
    open_interest     INT NOT NULL,
    spot_at_block     NUMERIC,
    status            TEXT NOT NULL DEFAULT 'CANDIDATE'
                      CHECK (status IN ('CANDIDATE','CONFIRMED','REJECTED','UNKNOWN')),
    bto_volume        NUMERIC,
    sto_volume        NUMERIC,
    bto_share         NUMERIC,
    confirmed_at      TIMESTAMPTZ,
    peak_ceiling_pct  NUMERIC,
    minutes_to_peak   NUMERIC,
    realized_30m_pct  NUMERIC,
    realized_60m_pct  NUMERIC,
    realized_eod_pct  NUMERIC,
    enriched_at       TIMESTAMPTZ,
    inserted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX late_day_bto_alerts_chain_bucket_uq
    ON late_day_bto_alerts (option_chain_id, trade_bucket_ct);
  CREATE INDEX late_day_bto_alerts_status_date_idx
    ON late_day_bto_alerts (status, date DESC, trade_bucket_ct DESC);
  CREATE INDEX late_day_bto_alerts_unconfirmed_idx
    ON late_day_bto_alerts (date) WHERE status = 'CANDIDATE';
  CREATE INDEX late_day_bto_alerts_unenriched_idx
    ON late_day_bto_alerts (date) WHERE enriched_at IS NULL;
  ```
- `api/__tests__/db.test.ts` — assert new migration applies cleanly.
- `vercel.json` — register cron `*/1 18-20 * * 1-5` (UTC equivalent of 13:00–15:00 CT, Mon-Fri). NOTE the time window narrows the cron to 120 invocations/day rather than the full 390-min market window.

**Universe (Phase 0 will refine; initial proposal):**
- SPX / SPXW (the anchor case)
- QQQ (co-fired in the anchor case)
- SPY, IWM (parallel index/ETF coverage)
- Liquid single names where 3-DTE OTM blocks are tradable. Start with the Lottery Finder universe intersection: NVDA, TSLA, AMD, AAPL, MSFT, META, GOOGL, AMZN. Wider universe deferred to v2.

**Acceptance:**
- Migration applies cleanly; table + indexes created
- Detector parity test passes (TS detector matches Phase 0 Python on canonical cases)
- Cron runs every minute in 13:00–15:00 CT window, produces ≤20 CANDIDATE rows/day on average over a 30-day dev replay
- SPXW 7300P 2026-05-15 13:30 CT and 14:20 CT both appear as CANDIDATE rows when the cron replays that day
- `npm run review` passes (tsc + eslint + prettier + vitest)

### Phase 2 — Periscope BTO/STO ingestion + confirm cron

Wires the confirmation half. Until Phase 2, all rows stay CANDIDATE.

**Files to create:**
- `api/_lib/periscope-bto-sto.ts` — ingestion module. Wraps the UW Periscope per-strike open-close data fetch (route to be determined during Phase 0 — likely a new method in the existing `periscope-scraper` Railway service, OR a direct API surface if `periscope-direct-xhr-2026-05-10.md` Path A unblocked one). Returns `{ chainId, asOfTimestamp, btoVolume, stoVolume, totalVolume }` per chain × time slot.
- `api/cron/fetch-periscope-bto-sto.ts` — new cron, every 15 min during 13:00–17:00 CT. Pulls BTO/STO snapshots for the active universe, upserts into a new `periscope_bto_sto_snapshots` table.
- `api/cron/confirm-late-day-bto.ts` — every 30 min during 14:00–22:00 CT + once at 22:30 CT (post-close EoD). For each CANDIDATE row older than `PERISCOPE_LAG_MIN` (locked in Phase 0, est. 30–60 min), join against the newest `periscope_bto_sto_snapshots` row covering the candidate's bucket and update `status`, `bto_volume`, `sto_volume`, `bto_share`, `confirmed_at`.
- `api/__tests__/late-day-bto-confirm.test.ts` — covers all four state transitions (CANDIDATE → CONFIRMED, → REJECTED, → UNKNOWN, → stays CANDIDATE if Periscope data missing).
- `api/__tests__/fetch-periscope-bto-sto.test.ts` — ingestion smoke test with mocked UW response.

**Files to modify:**
- `api/_lib/db-migrations.ts` — append migration creating `periscope_bto_sto_snapshots` table with `(option_chain_id, as_of_ts)` unique key.
- `vercel.json` — register both crons.

**Confirmation logic sketch (exact thresholds locked in Phase 0):**
```
For each CANDIDATE row C older than PERISCOPE_LAG_MIN:
  snap = newest periscope_bto_sto_snapshots row where chain = C.chain
         AND as_of_ts >= C.trade_bucket_ct
         AND as_of_ts <= C.trade_bucket_ct + PERISCOPE_CONFIRM_WINDOW_MIN
  if snap is NULL and now - C.trade_bucket_ct > PERISCOPE_GIVEUP_MIN:
    C.status = UNKNOWN
  elif snap.bto_share >= BTO_CONFIRM_THRESHOLD:  # e.g. 0.65 — Phase 0 tunes
    C.status = CONFIRMED
  elif snap.bto_share < BTO_REJECT_THRESHOLD:    # e.g. 0.40
    C.status = REJECTED
  # else: stays CANDIDATE for the next confirm pass
```

**Acceptance:**
- `periscope_bto_sto_snapshots` populates during dev with non-empty rows for the universe
- On a replayed 2026-05-15, SPXW 7300P 5/18 13:30 CT row transitions CANDIDATE → CONFIRMED within 60 min of original bucket
- A synthetic STO-heavy block transitions CANDIDATE → REJECTED
- Coverage gap (no Periscope snap within giveup window) transitions to UNKNOWN, NOT stuck CANDIDATE
- Idempotency: re-running confirm cron does not double-update CONFIRMED rows

### Phase 3 — UI surfacing

Surfaces alerts in the dashboard. Single feed, status pills.

**Files to create:**
- `api/late-day-bto-feed.ts` — paginated feed endpoint. Default sort: status (CONFIRMED first, then CANDIDATE, then UNKNOWN; REJECTED hidden by default), then `trade_bucket_ct DESC`. Filters: date, ticker, status, min_premium.
- `src/hooks/useLateDayBtoFeed.ts` — polling hook mirroring `useSilentBoomFeed`.
- `src/components/LateDayBto/types.ts`
- `src/components/LateDayBto/LateDayBtoSection.tsx` — section component. Reuses `<ContractTapeChart>` + `<TickerNetFlowChart>` from LotteryFinder for the expand panel.
- `src/components/LateDayBto/StatusPill.tsx` — visual chip: green `CONFIRMED ✓`, amber `CANDIDATE ⏳`, gray `UNKNOWN ?`. REJECTED rows hidden by default but accessible via filter chip.
- `src/__tests__/LateDayBtoSection.test.tsx`
- `api/__tests__/late-day-bto-feed.test.ts`

**Files to modify:**
- `src/App.tsx` — wire `<LateDayBtoSection>` below `<SilentBoomSection>`.

**Visual spec:**
- Section header: `🕒 Late-Day BTO (N candidate / M confirmed)`
- Row card shows: ticker / strike / DTE / time / block size / premium / `<StatusPill>`
- CANDIDATE rows pulse subtly (animation cue: result is provisional)
- CONFIRMED rows show `bto_share` as a small inline gauge (e.g. `78% BTO`)
- Expanded row: contract tape chart + the underlying ticker's net flow chart for the same 13:00–15:00 CT window

**Acceptance:**
- Section renders on dashboard; matches LotteryFinder/SilentBoom card aesthetic (per `ui-styling`)
- Status pills update without page reload when the polling hook re-fetches
- Empty state: section hides entirely when N + M = 0
- Accessible heading + landmark role per `wcag-audit-patterns`
- `npm run review` passes; e2e Playwright smoke test asserts section mounts

## Data dependencies

- **New tables:** `late_day_bto_alerts`, `periscope_bto_sto_snapshots`
- **Source for real-time detect:** existing `ws_option_trades` table (same source as Lottery Finder + Silent Boom)
- **Source for confirmation:** UW Periscope per-strike open-close BTO/STO data — INGESTION DOES NOT EXIST YET. Resolution path TBD in Phase 0; two candidate paths:
  1. Extend `periscope-scraper` Railway service to capture the BTO/STO surface alongside its existing chart scrape (Playwright DOM scrape)
  2. Direct XHR path per `periscope-direct-xhr-2026-05-10.md` Path A if Phase 0 feasibility passed for that endpoint
- **New env vars:** none expected (reuses existing UW + Periscope auth)
- **Cron registrations:** detect (1-min, 18-20 UTC M-F), confirm (30-min, 19-22 UTC M-F), fetch-bto-sto (15-min, 18-23 UTC M-F). Exact UTC ranges depend on DST handling — follow the same approach as `vercel.json`'s existing 13:30-21:00 UTC entries.

## Open questions

**(a) "Large block" trigger criteria — UNRESOLVED, locked in Phase 0:**
- Single 1-min bucket size threshold? Or cumulative size over a small window (e.g. 5 ticks within 60s)?
- Premium-dollar floor? (e.g. ≥$50K notional) Or only contract-count floor?
- `ask_pct` minimum? The 2026-05-15 SPXW prints were heavy ask-side but Phase 0 needs to confirm a single threshold doesn't catch routine market-making.
- `vol_oi` minimum? Late-day on a 3DTE often has tiny OI; the gate may need to be small or absent.
- Multi-leg classification: should the existing `classifyAlertMultileg` from `api/_lib/multileg-classify-batch.ts` gate out spreads / straddles, or is that a Phase 2 refinement?

**(b) "Confirmation" semantics — UNRESOLVED, needs Phase 0 investigation of Periscope's actual data shape:**
- Does Periscope publish BTO/STO at chain-level (aggregated, comparable to total volume) or per-trade (timestamped against each print)?
- If chain-level aggregate: what fraction of the chain's volume in the candidate's bucket needs to be BTO to call it confirmed? Proposed thresholds (Phase 0 tunes):
  - `bto_share >= 0.65` → CONFIRMED
  - `bto_share <= 0.40` → REJECTED
  - in-between → stays CANDIDATE until later snapshot or UNKNOWN at giveup
- How long is the publish lag in practice? Phase 0 should measure: scan historical periscope snapshots for the 5/15 prints and time-to-first-non-null.
- What if multiple candidates share the same chain (the 13:30 and 14:20 CT SPXW blocks)? The confirm cron likely needs to attribute Periscope's aggregate split across the candidates in time order, or simply use the snapshot delta (`bto_volume[t+1] - bto_volume[t]`) bracketing each candidate's bucket. Lean toward delta — cleaner attribution.

**(c) UI surface — TENTATIVELY RESOLVED to separate section, confirm during scoping:**
- Proposal: new `<LateDayBtoSection>` below `<SilentBoomSection>`. Pros: clean isolation, status pill is a new UX primitive; Cons: yet another scroll target.
- Alternative: pinned subsection inside `<LotteryFinderSection>` à la the REIGNITION pinned section. Pros: one place to look; Cons: conflates two signal classes.
- Defer until Phase 3; user feedback on Phase 1 + 2 outputs will inform.

**(d) Interaction with REIGNITION badge — TENTATIVELY RESOLVED to independent:**
- REIGNITION lives on `lottery_finder_fires`. Late-Day BTO lives on its own table. A given chain could conceivably be both a Lottery REIGNITION AND a Late-Day BTO CANDIDATE on the same day — the anchor case actually rules this out (Lottery didn't fire) but other chains could double-up.
- Proposal: leave them independent. If a chain appears in both feeds, both surfaces render it; no cross-feed dedup. Mark for re-evaluation if/when overlap is observed in production.

## Thresholds / constants to tune in Phase 0

All locked into `LATE_DAY_BTO_SPEC_V1` before Phase 1 implementation per `feedback_tune_before_ship`. Tuning script: `scripts/late_day_bto_audit.py` (new), data: `/Users/charlesobrien/Desktop/Eod-Full-Tape-parquet/` (93 days, 2026-01-02 → 2026-05-15 inclusive).

| Constant | Initial guess | What Phase 0 outputs |
|---|---|---|
| `WINDOW_START_CT` | 13:00 | Final value (does 12:30 catch more anchors without flooding?) |
| `WINDOW_END_CT` | 15:00 | Final value (does 15:15 hurt density?) |
| `DTE_MIN`, `DTE_MAX` | 1, 3 | Final values + whether 0DTE inclusion helps or just adds noise |
| `MIN_BLOCK_SIZE` | 250 contracts | Calibrated against daily fire-density curve |
| `MIN_BLOCK_PREMIUM_USD` | $50,000 | "" |
| `MIN_ASK_PCT` | 0.65 | "" |
| `MIN_VOL_OI` | 0.10 | "" — lower than Silent Boom because late-day 3DTE often has tiny OI |
| `BTO_CONFIRM_THRESHOLD` | 0.65 | Measured against confirmed-anchor cases |
| `BTO_REJECT_THRESHOLD` | 0.40 | "" |
| `PERISCOPE_LAG_MIN` | 30 | Measured from historical Periscope snapshots |
| `PERISCOPE_GIVEUP_MIN` | 240 | If no BTO/STO data by EoD + 4hr, mark UNKNOWN |
| `UNIVERSE` | SPX/SPXW/QQQ/SPY/IWM + Lottery intersection | Final ticker list |

## Out of scope (deferred)

- **Push notifications** — could plug into existing alert infra but not in this spec. v2.
- **Auto-trading or order generation** — explicitly out. This is a surfacing tool.
- **Outcome scoring / tiering** — like Silent Boom v1, this v1 ships as binary alerts. A tier system can come later once realized-return distribution is measured on production fires.
- **Backfill of historical CANDIDATE rows from parquet** — could add `scripts/backfill_late_day_bto_from_parquet.py` later, similar to `enrich_silent_boom_outcomes.py`. Not in v1.
- **Cross-detector co-fire detection** — i.e. "this chain fired Late-Day-BTO AND Silent Boom in the same 15 min" as a higher-conviction badge. Defer to v2 after both detectors have production data.
- **Wider single-name universe** — start with the Lottery intersection, expand once production noise level is known.
- **Cone breach / IV / charm context overlays** in the row card — keep the v1 card minimal; defer enrichment.
- **Periscope BTO/STO ingestion outside the Late-Day BTO use case** — the new `periscope_bto_sto_snapshots` table will only be consumed by `confirm-late-day-bto.ts` in this spec. Other detectors / UI surfaces consuming it is out of scope.

## Implementation order

1. **Phase 0** (Python tuning + audit doc) — locks `LATE_DAY_BTO_SPEC_V1`, validates anchor coverage
2. **Phase 1** (schema + detect cron) — ships real-time CANDIDATE alerts; UI not yet wired so consumed only via `psql` for the first day to sanity-check density
3. **Phase 2** (Periscope ingestion + confirm cron) — completes the two-stage upgrade
4. **Phase 3** (UI) — surfaces both states to the dashboard

Each phase gets its own commit and code-reviewer pass per `feedback_per_phase_loop`. `npm run review` must pass between phases per `feedback_run_review`.

## Verification gates

- `npm run review` (tsc + eslint + prettier + vitest --coverage) passes after each phase
- Every new module ships with a test file per `feedback_always_test`
- No `console.log` in committed code
- Phase 0 audit doc reviewed by user before Phase 1 begins
- Phase 2 confirm-cron transitions verified on the 2026-05-15 anchor case via dev replay before deploy
