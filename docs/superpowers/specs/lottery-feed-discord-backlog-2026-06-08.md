# Lottery Feed Backlog — Discord session 2026-06-08

**Goal:** Resolve a batch of Lottery Finder / Silent Boom feed bugs + features raised in
a live Discord trading session (2026-06-08), plus a set of ML/analysis follow-ups. This
doc is the durable handoff: it captures the verified root cause of each item (from a
four-agent code investigation), the product decisions made, effort estimates, and the
execution sequence.

Status: **Planned, investigation complete, no code written yet.** All decisions resolved
except where noted.

---

## Source

Discord thread between the owner (Wonce) and dev (Cedoulain), 2026-06-08 ~1:10–2:30 PM CT.
Raw breakdown lives in conversation history; this doc is the actionable distillation.

---

## Tier 1 — Bugs / Fixes

### 1.1 Pagination breaks under active filters  *(the real bug — highest value)*

**Symptom:** With a filter active (e.g. min premium $20k), page 2 shows a single alert and
a phantom page 3 exists. Pagination is fine with no filters.

**Root cause (verified):** Three different "size" numbers drive three different controls:
- Pager *visibility* gate uses union-floored `total` (`useNeverVanishFeed.ts:145`,
  `total = engaged ? max(serverTotal, rows.length) : serverTotal`) → on page 0 the
  never-vanish union inflates `total` past `PAGE_SIZE` (50), so the pager renders.
- Page *label* uses server-anchored `totalPages = ceil(serverTotal / PAGE_SIZE)`
  (`index.tsx:813`).
- Next *button* uses raw server `hasMore` (`index.tsx:685,750`).
- On page ≥1, union disengages and `dedupedPagedFires` (`index.tsx:718-722`) strips any
  row already pinned in the page-0 union → the server slice the server still *counts*
  renders as ~0 rows.

Only breaks with filters because that's the regime where `serverTotal` is small enough for
the page-0 union to over-count it.

**Decision / fix:** Paginate the **client union itself** when engaged-for-the-day (slice
`firesFeed.rows` by page) instead of switching to server slices on page ≥1, so one ordered
list backs every page. Gate the pager on `totalPages > 1` (server-anchored), not
`total > PAGE_SIZE`.

**Files:** `src/components/LotteryFinder/index.tsx` (665, 718-730, 744, 806-813, 1818),
`src/hooks/useNeverVanishFeed.ts` (139-146). **Must fix the duplicated SilentBoom code in
lockstep:** `src/components/SilentBoom/index.tsx` (805-821, 1827).

**Effort: M.** Tests: pagination math under filter (union over-count + page≥1 dedup cases).

---

### 1.2 Grouping — "morning alerts go missing"

**Symptom:** A chain with many fires shows the *latest* fire as its header; the morning
fires appear to vanish.

**Root cause (verified — NOT data loss):** Server collapses each chain
`(underlying, strike, option_type, expiry)` to one representative row via
`ROW_NUMBER() … ORDER BY trigger_time_ct DESC, id DESC → rn=1`
(`api/lottery-finder.ts:591-594`), i.e. the *latest* fire becomes the header. Earlier fires
are carried in `historicalFires` (`:1404`, = `fires_json` minus its last element). They are
present but demoted into a collapsed sublist, so they *read* as missing.

**Decision:** **Reignite expander.** Anchor the group/row header on the **first** fire
(`first_fire_time_ct`, already selected at `api/lottery-finder.ts:588-590`) and render a
"+N reignites" expander that reveals the later fires. The earliest alert — the one the user
actually wants to see — becomes the visible anchor.

**Files:** `api/lottery-finder.ts` (header selection ~588-594, `historicalFires` ~1404),
`src/components/LotteryFinder/LotteryRow.tsx` (consumes `historicalFires`), plus the
group renderer. Mirror in SilentBoom if it shares the rep-row logic.

**Effort: S–M.** Open sub-question for build time: does the *sort position* of the chain
follow the first fire (stable) or the latest fire (jumps to "now")? Recommend sort by latest
activity but display first-fire time as the anchor — confirm during implementation.

---

### 1.3 ITM/OTM filter inconsistency

**Root cause (verified):** Both filter and badge use **alert-time** spot (not current price,
contrary to the original report). But the *filter* classifies with `spotAtFirst`
(`index.tsx:117-121`) while the *badge* displays with `spotAtTrigger ?? spotAtFirst`
(`LotteryRow.tsx:495-505`). For a chain that moved between first and latest fire, the badge
can say "OTM" while the filter treats it as "ITM" (or hides it).

**Decision:** Extract a shared `fireSpot(fire)` helper (`spotAtTrigger ?? spotAtFirst`) used
by both the filter and the row, so classification and display can never disagree. Note
`isFireOtm` is reused by the Aggressive-Premium filter (`index.tsx:133`) — change propagates
there too (intended).

**Effort: S.**

---

### 1.4 Take-it floor `.6` vs `.7` mismatch  *(not a code bug)*

**Root cause (verified):** Code default is uniformly `0.7` for both panels. The `.6` is a
**persisted-localStorage override** (`usePersistedState` lets a saved value shadow the
default) on a per-panel key (`lottery.takeitFloor` vs `silentBoom.takeitFloor`). Two
browsers/panels diverge because one has a saved override.

**Decision (option 3):** Keep per-panel memory, but add a visible marker when the active
floor ≠ the `0.7` default — e.g. "(saved: 0.6 · reset to 0.7)" with the reset as a click —
so the active floor is never a surprise. Do **not** force a shared floor.

**Files:** `src/components/LotteryFinder/index.tsx:531-535`,
`src/components/SilentBoom/index.tsx:619-623`. **Effort: S.**

---

## Tier 2 — Features

### 2.1 Exit Advisor engine  *(0% built, 100% designed)*

Spec: `docs/superpowers/specs/exit-timing-engine-2026-05-29.md` (approved).
Plan: `docs/superpowers/plans/2026-05-29-exit-timing-engine.md` (1,791 lines, 15 tasks,
TDD, every test pre-written). `ml/`-only — skips the npm review gate; each task just needs
pytest green. Reuses existing cost model + benchmark policies (`ml/src/lottery_exit_policies.py`,
`scripts/exit_policy_search.py`) and the `lottery_finder_fires` realized columns.

**Effort: ~4.5–6 focused days.** Caveat: Project A is an *offline research brain* producing
a validated exit policy — the live in-app advisor (endpoint + per-minute scoring + UI) is
deferred to Projects B/C. Decision gate baked into the spec: if the A3 model doesn't beat
the A2 rule out-of-sample, the rule ships as v1.

**Status:** Its own multi-day track. Run after the Tier-1 bugs + quick ML confirms.

---

### 2.2 Filter by # of fires (MAX, free-text)  *(unblocked)*

A MIN-floor fire filter already exists (`MIN_FIRE_COUNT_*` in `index.tsx:182-237`, applied
server-side in `api/lottery-finder.ts` four query branches). The ask is the **inverse**: a
**MAX** cap, as a free-text 1–2 digit input (not preset buttons), to hide high-fire "spam".

**Build:** Mirror the existing min param, inverted, across ~7 files: both Zod schemas
(`api/_lib/validation/lottery.ts` ~98, ~411), `api/lottery-finder.ts` destructure + the four
SQL branches (`AND (max IS NULL OR f.fire_count <= max)`), `useLotteryFinder.ts` +
`useLotteryFinderTickerCounts.ts` URL params, and the UI input near the burst chip strip
(~1133-1160).

**CRITICAL:** `maxFireCount` MUST be added to `buildLotteryFilterSig` (`index.tsx:385,
666-679`) / `LotteryFilterSigParams` — it is a server-narrowing filter, and the never-vanish
union keys on `filterSig`. Omitting it means pinned high-fire rows never drop, defeating the
filter. Go server-side (not client `.filter`) for the same reason.

**Gate:** Was gated on ML 3.1 for the cutoff — but 3.1 is already answered (more fires =
more profitable). So the filter is a *noise-reduction convenience*, not a quality gate; ship
with sensible default OFF. **Effort: M.**

---

### 2.3 Make winners stand out (convergence emphasis)

Infra largely exists: `isHighConviction` (≥3 fires, one direction, ≥2 strikes, clustered
≤15 min) + `isStrongConviction` + badges + sort-promotion in
`src/utils/ticker-rollup-aggregates.ts` and `useTickerGrouping.ts`; group-header badges in
`LotteryFinderTickerGroup.tsx`. The "cluster of TSLA calls all hitting" case = the
`conviction` / `clusterStrikes` axis (distinct from `reignited` and `megaCluster`).

**Options (increasing scope):** (a) **S** — strengthen the group-header visual (glow/ring
on `strongConviction`); (b) **M** — second pinned section above the feed for
`strongConviction` tickers, mirroring `ReignitionSection`, reusing already-computed flags
(no server change); (c) **M–L** — new convergence-strength sort axis. **Recommend (a) or
(b).** Shared `useTickerGrouping` affects SilentBoom too — confirm scope.

---

### 2.4 Dismissable debug overlay  *(quick win)*

`src/components/BacktestDiag/index.tsx` — fixed bottom-right diagnostic box, currently
draggable + collapsible, blocks the bottom corner. Replace drag/collapse with a small "×"
dismiss. Remove drag handlers, `position`/`collapsed` state + effects, and orphaned helpers
in `BacktestDiag/helpers.ts` (`loadStoredPosition`, `writeStoredCollapsed`, `clamp`, etc.).
Renders only in backtest mode. **Effort: S.** Fully isolated — no overlap with 2.2/2.3.

---

## Tier 3 — ML / Analysis

### 3.1 Fire count vs return — **ALREADY ANSWERED**

`docs/tmp/burst-profitability-findings-2026-05-17.md` (93 days, 626k fires / 77k
chain-days): more fires = monotonically more profitable on median + win rate. Single-fire
≈ 45% win; 31–50 fire bucket (TSLA today) ≈ 155% median best-peak, 99% win on best fire.
**No new run.** One open follow-up that cleanly informs 2.2: **ticker-confounding cross-tab**
— is the lift fire-count or just TSLA/NVDA dominating the high buckets? (~1 hr.)

### 3.2 Entry by TOD / Nth fire — **READY (~1 hr)**

All fields present in `lottery_finder_fires` (`tod`, `trigger_time_ct`, `alert_seq`,
`entry_drop_pct_vs_prev`, realized outcomes). Nth-fire half already done in the May 17 study;
the **TOD × fire-position** cross-tab is new. Caveat: segment any takeit_prob-based slice by
`takeit_model_version` (regime changes ~May 5 / May 15 / Jun 2); pure TOD/fire-count queries
don't need it.

### 3.3 Both-sides delineation — **THIN**

Only ~15–40 dual-high-fire ticker-days in history. Discriminators exist
(`mkt_tide_otm_diff`, `direction_gated`) but the "which side wins when both rip" question is
untested and was calibrated on single-side scenarios. **Run the dual-fire discovery query
first to establish n** before committing; if n < 20 it's anecdote territory.

### 3.4 Claude reads the flow — **SCOPEABLE, deferred**

`lottery_finder_fires` is not in the analyze context today. Quickest PoC: check
`scripts/eod-flow-analysis/analyze.py` first (may already do most of it). Production path =
a new formatter in `analyze-context.ts` mirroring `formatSpotExposuresForClaude()` (~2–3 hr),
gated on deciding whether analyze should get lottery data at all.

---

## Data dependencies

- No new tables/migrations for Tier 1 or 2.2/2.3/2.4.
- 2.2 adds a query param only (no schema change).
- ML 3.x read from existing `lottery_finder_fires` (Neon) + `scripts/eod-flow-analysis/output/by-day/*.parquet`.
- 2.1 Exit Advisor consumes existing realized columns + the parquet full-tape archive.

## Open questions

- 1.2: chain sort position — follow first fire (stable) or latest activity (jumps to now)?
  Default pick: sort by latest activity, display first-fire time as anchor. Confirm at build.
- 2.3: which emphasis option (a/b/c) and whether it applies to SilentBoom.
- 2.2: default max value / whether default is OFF (recommend OFF).

## Thresholds / constants referenced

- `PAGE_SIZE = 50` (pagination).
- Take-it default floor = `0.7`; chip option of interest = `0.6`.
- Conviction: ≥3 fires, single direction, ≥2 distinct strikes, clustered ≤15 min.
- Fire-count buckets (May 17 study): 1 / 2–5 / 6–10 / 11–20 / 21–30 / 31–50 / 51–100.

---

## Recommended execution sequence

1. **Quick-win commit:** 1.3 (ITM/OTM shared helper) + 2.4 (overlay ×) + 1.4 (saved-floor
   marker) — all S, independent.
2. **1.1 pagination** (M, SilentBoom in lockstep) — the real bug.
3. **1.2 grouping reignite expander** (S–M).
4. **ML confirms:** 3.1 ticker-confounding cross-tab + 3.2 TOD × fire-position (~1–2 hr,
   tonight's data fresh).
5. **2.2 fires-max filter** → **2.3 convergence emphasis**.
6. **2.1 Exit Advisor** — its own multi-day track (plan already exists; transcribe-test-verify).
7. **3.3 / 3.4** as follow-on analysis when bandwidth allows.
