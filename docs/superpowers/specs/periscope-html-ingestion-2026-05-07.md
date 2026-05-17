---
status: Likely Shipped
date: 2026-05-07
---

# Periscope HTML Ingestion + Dealer-Hedging Signal Pipeline

**Date:** 2026-05-07
**Status:** Spec — ready for Phase 1
**Trading focus:** /ES + /NQ futures execution off MM-attributed dealer positioning

## Goal

Replace user-triggered Periscope-chat (vision OCR, ~30-strike heat-map slice) with an automated 10-min HTML scrape of UW Periscope. Persist full-chain MM-attributed Gamma / Charm / Vanna / Positions per strike. Derive sign flips (orange bars), dynamic threshold breaches (purple bars), net charm tally, charm-zero level, cone bounds, and cone breach events. Surface as push alerts + frontend panels for futures trading.

## Why this matters

- Current state: Pass 1B vision OCR runs only when user clicks "analyze," covers ~30 strikes around spot, produces approximate values.
- New state: every 10 min of RTH, full chain (~150+ strikes), exact MM-attributed values straight from the DOM, with derived signals computed at write time.
- Trading payoff: real-time alerts on regime changes (sign flips near spot, cone breach, charm-zero migration) without staring at the Periscope tab.

## Non-goals (this spec)

- Predicted-vs-realized ES hedge attribution (separate research project)
- Confluence scoring (separate spec)
- Backtesting engine for the new signals (data first; analytics layer later)
- Silent-boom integration (different scoring system, intentionally separate)

## Why Vanna + VIX matter (added 2026-05-07 mid-build)

**Vanna is not a "nice to have" — on vol-shock days it's the dominant
dealer-flow driver.** Mechanism (the user's Phase 4 prompt):

- Dealers are structurally net short SPX puts (clients buy crash hedges).
- Short put → positive delta → dealer holds short /ES against it.
- VIX drop (e.g. 22 → 18 post-FOMC): put |Δ| shrinks proportionally with σ.
- Dealer is now over-hedged short /ES → mechanically buys /ES to rebalance.

This is the post-event "vanna rally" pattern — the tape that "just won't
sell off" without an obvious bid catalyst. The bid IS the catalyst: it's
the put-side hedge book mechanically reducing.

**The 0DTE caveat:** vanna at 0DTE is small (vega → 0 as T → 0). But
**multi-DTE vanna is enormous** — a 4-point VIX move can shift tens of
thousands of /ES contracts of dealer hedging. The Periscope Vanna panel
on a multi-DTE expiry view is the structural picture; on 0DTE it's
context, not a primary driver.

**Implications for ingestion:**

- Phase 2's `periscope_snapshots` schema already includes `'vanna'` in
  the `panel` enum — the scraper covers it natively when the user
  configures the 4-panel layout. Required, not optional.
- **Add intraday VIX correlation as a Phase 3 derived signal** so the
  raw vanna numbers are interpretable in vol-shock context. New
  derived metric: `vanna_unwind_flow_pm100` = sum of
  `vanna_strike × ΔVIX_last_10min` across strikes within ±100 pts of
  spot. Large + positive on a falling-VIX day = "mechanical /ES buy
  inbound, don't fight the rally."
- Phase 4 Frontend: the Vanna panel needs its own gauge / sparkline
  alongside the Gamma + Charm panels — this is the third leg of the
  three-panel structural read.

## Phases

Each phase is independently shippable. Stop after each phase, run `npm run review`, ship, validate against live data, then proceed.

---

### Phase 1 — Cone auto-compute + breach detection (NO scraper required)

Smallest, lowest-risk first ship. Independent of the Playwright work — uses Schwab option chain you already have.

**Files:**

- `api/_lib/db-migrations.ts` — add migrations for `cone_levels`, `cone_breach_events` tables
- `api/__tests__/db.test.ts` — bump migration count + sequence
- `api/cron/compute-cone.ts` (new) — fires at 14:31 UTC (9:31 ET), pulls SPX 0DTE ATM call+put marks, writes cone bounds row
- `api/cron/check-cone-breach.ts` (new) — fires every 1 min during RTH (14:30–21:00 UTC, M-F), compares current SPX spot to today's cone, INSERTs first-breach event per direction + fires push notification
- `vercel.json` — register both crons + add to botid `protect` list if applicable
- `src/utils/futures-gamma/cone.ts` (new) — frontend helper for cone-status pill (`INSIDE` / `BREACHED_UP` / `BREACHED_DOWN`)
- `src/components/futures-gamma/ConeStatusPill.tsx` (new or wired into existing futures-gamma component)
- `api/__tests__/cron-compute-cone.test.ts` (new) — mock chain + verify INSERT
- `api/__tests__/cron-check-cone-breach.test.ts` (new) — mock spot + cone, verify breach detection idempotency

**Schema:**

```sql
-- migration N: cone_levels
CREATE TABLE cone_levels (
  date DATE PRIMARY KEY,
  calc_time TIMESTAMPTZ NOT NULL,
  spot_at_calc NUMERIC(10,2) NOT NULL,
  atm_strike INT NOT NULL,
  call_premium NUMERIC(8,2) NOT NULL,
  put_premium NUMERIC(8,2) NOT NULL,
  cone_upper NUMERIC(10,2) NOT NULL,
  cone_lower NUMERIC(10,2) NOT NULL,
  cone_width NUMERIC(8,2) NOT NULL,
  asymmetry_pts NUMERIC(8,2) NOT NULL  -- + = downside-skewed
);

-- migration N+1: cone_breach_events
CREATE TABLE cone_breach_events (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL REFERENCES cone_levels(date),
  direction TEXT NOT NULL CHECK (direction IN ('upper', 'lower')),
  breach_time TIMESTAMPTZ NOT NULL,
  spot_at_breach NUMERIC(10,2) NOT NULL,
  cone_bound_at_breach NUMERIC(10,2) NOT NULL,
  UNIQUE (date, direction)  -- first-breach-per-direction-per-day idempotency
);
```

**Done when:** running `compute-cone` against today's chain inserts a row; spot crossing the upper bound triggers exactly one `upper` event + push notification.

---

### Phase 2 — Playwright scraper + raw snapshot ingestion

The big infra lift. Headless Chromium, UW auth session, DOM parse.

**Decision (confirmed 2026-05-07):** Railway service, separate from the Python `sidecar/`. Reuses existing Railway account + Blob token + DATABASE_URL. New top-level directory `periscope-scraper/` (Node + TypeScript + Playwright), own Dockerfile, own auto-deploy on `periscope-scraper/**` pushes (`vercel.json` `ignoreCommand` already excludes top-level dirs that aren't src/api).

**Files:**

- `periscope-scraper/` (new directory, Node/TS service for Railway)
  - `Dockerfile` — node:24-slim + Playwright Chromium install
  - `package.json` — `playwright`, `@neondatabase/serverless`, `@sentry/node`, `pino`
  - `tsconfig.json`
  - `src/index.ts` — entrypoint, scheduled-loop runner (every 10 min during RTH)
  - `src/scrape.ts` — Playwright launch, auth, multi-panel navigate, DOM parse → typed rows
  - `src/auth.ts` — UW session cookie load + refresh
  - `src/db.ts` — Neon client + INSERT helpers
  - `src/derived.ts` — sign flips + thresholds + charm tally + charm-zero (Phase 3 will live here)
  - `README.md` + `TEARDOWN.md` (mirror sidecar/ml-sweep convention)
- `api/_lib/db-migrations.ts` — add migration for `periscope_snapshots` table (writer is Railway, schema lives in Vercel-managed migrations)
- `vercel.json` — extend `ignoreCommand` skip list to include `periscope-scraper/`
- Sentry alert when DOM selectors don't match (UW redesign detection)
- `RAILWAY` env vars set in Railway dashboard: `DATABASE_URL`, `SENTRY_DSN`, `UW_SESSION_COOKIE`, `UW_USERNAME`, `UW_PASSWORD` (re-auth fallback)

**Schema:**

```sql
-- migration N+2: periscope_snapshots
CREATE TABLE periscope_snapshots (
  id BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL,
  expiry DATE NOT NULL,
  panel TEXT NOT NULL CHECK (panel IN ('gamma', 'charm', 'vanna', 'positions')),
  strike INT NOT NULL,
  value NUMERIC(14,2) NOT NULL,
  UNIQUE (captured_at, expiry, panel, strike)
);
CREATE INDEX idx_periscope_snapshots_lookup
  ON periscope_snapshots (expiry, panel, captured_at, strike);
```

**Open questions resolved during Phase 0 probe (run BEFORE Phase 2 implementation):**

- Selectors for per-strike rows on each panel (Gamma table, Charm table, etc.)
- Whether all 4 panels live on one URL (multi-tab) or separate URLs
- Whether UW exposes orange/purple as CSS classes (e.g. `.bar-flipped`, `.bar-highlight`) — if yes, scrape those flags directly into `periscope_snapshots`
- UW auth flow in headless: cookie-based session sufficient, or full login required?

**Done when:** the cron runs at the next 10-min boundary during a trading session and writes ≥150 rows per panel into `periscope_snapshots`. A Sentry test alert fires if any selector returns 0 rows.

---

### Phase 3 — Derived signals (orange bars, purple bars, charm tally, charm-zero)

Read from `periscope_snapshots`, compute, write to derived tables. Runs as a tail step in the scraper cron (same tick as ingestion).

**Files:**

- `api/_lib/periscope-derived.ts` (new) — pure functions: `computeSignFlips`, `computeThresholdEvents`, `computeCharmTally`, `computeCharmZero`
- `api/_lib/db-migrations.ts` — migrations for `periscope_sign_flips`, `periscope_threshold_events`, `periscope_charm_tally`, `periscope_charm_zero`
- `api/cron/scrape-periscope.ts` — extend tail to call derived layer + INSERT
- `api/__tests__/periscope-derived.test.ts` (new) — unit tests for each derived function

**Schema (5 small tables — vanna_unwind added per Vanna+VIX section above):**

```sql
-- periscope_sign_flips: orange-bar events, programmatic
CREATE TABLE periscope_sign_flips (
  id BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL,
  expiry DATE NOT NULL,
  panel TEXT NOT NULL,
  strike INT NOT NULL,
  prev_value NUMERIC(14,2) NOT NULL,
  new_value NUMERIC(14,2) NOT NULL,
  prev_sign CHAR(1) NOT NULL,  -- '+' or '-'
  new_sign CHAR(1) NOT NULL
);

-- periscope_threshold_events: purple-bar events, multiple threshold definitions
CREATE TABLE periscope_threshold_events (
  id BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL,
  expiry DATE NOT NULL,
  panel TEXT NOT NULL,
  strike INT NOT NULL,
  delta_value NUMERIC(14,2) NOT NULL,
  threshold_kind TEXT NOT NULL CHECK (threshold_kind IN
    ('static_1000', 'zscore_2', 'percentile_95', 'hybrid')),
  threshold_value NUMERIC(14,4) NOT NULL  -- the threshold that fired
);

-- periscope_charm_tally: net signed charm within ±100 pts, per snapshot
CREATE TABLE periscope_charm_tally (
  captured_at TIMESTAMPTZ PRIMARY KEY,
  expiry DATE NOT NULL,
  spot NUMERIC(10,2) NOT NULL,
  tally_pm100 NUMERIC(16,2) NOT NULL,  -- ±100pts
  tally_pm50 NUMERIC(16,2) NOT NULL,   -- tighter band
  concentration_top3 NUMERIC(5,4) NOT NULL  -- top-3-strike share
);

-- periscope_charm_zero: charm-zero strike per snapshot
CREATE TABLE periscope_charm_zero (
  captured_at TIMESTAMPTZ PRIMARY KEY,
  expiry DATE NOT NULL,
  spot NUMERIC(10,2) NOT NULL,
  charm_zero_strike INT,  -- nullable: undefined when chain doesn't cross 0
  distance_from_spot NUMERIC(8,2)
);

-- periscope_vanna_unwind: ΔVIX × Σ vanna ±100pts → mechanical /ES flow
-- forecast. The "tape that won't sell off" / vanna-rally signal.
-- Direction: positive = mechanical /ES BUY inbound (puts unwinding on
-- falling VIX); negative = mechanical /ES SELL inbound (puts re-hedging
-- on rising VIX). Flag when |unwind_flow_pm100| exceeds rolling baseline.
CREATE TABLE periscope_vanna_unwind (
  captured_at         TIMESTAMPTZ PRIMARY KEY,
  expiry              DATE NOT NULL,
  spot                NUMERIC(10,2) NOT NULL,
  vix_now             NUMERIC(8,4) NOT NULL,
  vix_delta_10m       NUMERIC(8,4) NOT NULL,
  sum_vanna_pm100     NUMERIC(16,2) NOT NULL,
  unwind_flow_pm100   NUMERIC(16,2) NOT NULL  -- vix_delta_10m × sum_vanna_pm100
);
```

**Threshold definitions (purple bars):**

- `static_1000` — UW-equivalent fixed threshold; serves as control/baseline
- `zscore_2` — z-score > 2 against rolling 30-day mean+std of slice-to-slice deltas at this strike
- `percentile_95` — top 5% of observed deltas at this strike over last 30 sessions
- `hybrid` — `(|delta| > floor_abs) AND (|z| > 2)`; `floor_abs` = 250 default
- All four computed per event in parallel; rows tagged with which definition fired

**Done when:**

- A flip-event row exists for any strike where `sign(t) ≠ sign(t-1)`
- A charm-tally row exists for every snapshot with `tally_pm100` populated
- A charm-zero row exists for every snapshot, with sensible nulls when no crossover
- Unit tests cover empty-chain, all-positive, all-negative, multi-crossing edge cases

---

### Phase 4 — Frontend panels + replace manual cone input

Wire derived data to UI. Trading-focused — these panels are what's open during /ES execution.

**Files:**

- `src/components/futures-gamma/ConeStatusPill.tsx` — already created in Phase 1; extend with breach time + how-far-past-bound metric
- `src/components/futures-gamma/CharmZeroPanel.tsx` (new) — distance from spot, zone label, migration arrow + sparkline of last N snapshots
- `src/components/futures-gamma/VannaUnwindGauge.tsx` (new) — single-number readout of `unwind_flow_pm100` with VIX delta context. Flags large + values as "mechanical /ES BUY inbound" alerts on event/post-event days
- `src/components/futures-gamma/CharmTallyGauge.tsx` (new) — single $ readout, time-of-day weighted styling (grey pre-11:00, bold post-13:30)
- `src/components/futures-gamma/SignFlipLog.tsx` (new) — table of today's flip events, filterable by panel + distance from spot
- `src/components/futures-gamma/ThresholdEventLog.tsx` (new) — same for purple-bar events
- `src/hooks/useFuturesGammaSignals.ts` (new) — polling hook, gated on `marketOpen`, fetches all 4 derived datasets
- `api/futures-gamma/signals.ts` (new) — read endpoint, returns latest `cone_levels` + `charm_tally` + `charm_zero` + recent `sign_flips` + `threshold_events`. Owner-or-guest gated per project pattern.
- **Remove:** the manual cone-input component (whichever file holds it). Replace its display with `ConeStatusPill` reading from DB.

**Done when:** the frontend's futures-gamma section shows all four panels live during RTH, updates within ~1 min of each new 10-min snapshot, and the manual cone input is gone.

---

### Phase 5 — Push notifications + alert routing

The "I'm not at the screen" trigger surface. Layer onto existing futures-gamma alerts subsystem (per memory note `project_futures_integration` — alerts already exist).

**Files:**

- `src/utils/futures-gamma/alerts.ts` — extend with three new alert types:
  - `cone_breach` — first breach per direction per day (already wired in Phase 1, just register it as a routed alert)
  - `near_spot_flip` — sign flip on a strike within ±10 pts of current spot, on Gamma or Charm panel
  - `dominant_threshold_breach` — purple event using the `hybrid` threshold definition, on a strike within ±25 pts
- `api/cron/scrape-periscope.ts` — at tail of derived-signal step, push the relevant events into the alert pipeline
- Alert-rate-limit: max 1 push per (event_type, strike, day) to avoid noise

**Done when:** firing a synthetic flip event on a strike near spot results in exactly one push to your device with the right copy.

---

## Phase 0 — Discovery probe (do this BEFORE Phase 2 — user-driven)

Tooling is in place (`scripts/periscope-probe.mjs`). The probe is a 2-step Playwright script the user runs locally; output goes to `docs/tmp/periscope-probe/<timestamp>/` and is then handed back so Claude can wire the production selectors into `periscope-scraper/src/scrape.ts`.

**Step 1 — one-time login (saves auth state):**

```bash
npm i -D playwright       # if not already installed
npx playwright install chromium
PERISCOPE_URL='https://unusualwhales.com/periscope?...' \
  node scripts/periscope-probe.mjs --login
```

A headed Chromium opens. Log in to UW manually, then close the browser window. The auth state is saved to `~/.periscope-probe-auth.json` (gitignored — do not commit).

**Step 2 — capture (run anytime, headless):**

```bash
PERISCOPE_URL='https://unusualwhales.com/periscope?...' \
  node scripts/periscope-probe.mjs
```

Output:

- `docs/tmp/periscope-probe/<timestamp>/page.html` — full rendered DOM
- `docs/tmp/periscope-probe/<timestamp>/page.png` — screenshot for cross-reference
- `docs/tmp/periscope-probe/<timestamp>/meta.json` — URL, viewport, timing

**Before running:** configure your Periscope view to show all 4 panels (Gamma + Charm + Vanna + Positions) so a single capture covers everything the scraper needs.

**Hand back to Claude:**

- The `page.html` file path
- (Optional) the screenshot, helpful for visual cross-check

**What Claude does with it:**

- Identifies the per-strike row selector + value-extraction pattern for each panel (e.g. confirms the `<div title="Charm: -2,742.48">` pattern from the user's earlier devtools screenshot)
- Identifies orange/purple bar CSS classes if present
- Identifies expiry / timeframe / spot read locations in the header
- Writes `periscope-scraper/src/scrape.ts` with concrete `page.evaluate(...)` selectors
- Writes parser unit tests using a fixture HTML excerpt taken from the captured page

**Fallback if structure is unclear:** Claude can request a second probe capture with the user changing one specific control (panel toggle, threshold slider, expiry switch) so DOM diffs reveal which elements correspond to which UI.

---

## Data dependencies

- **SPX 0DTE option chain** at 9:31 ET — already pulled via Schwab. Phase 1 just needs ATM call + put marks at the 9:31 timestamp.
- **SPX spot, 1-min** — already in `index_candles_1m` per CLAUDE.md.
- **UW Periscope HTML** — new dependency. Auth via session cookie. **Risk:** UW could redesign the page; Sentry alert mitigates silent breakage.
- **UW account / TOS** — verify scraping is acceptable under your subscription terms before merging Phase 2. If not, consider whether UW has a paid API endpoint exposing MM-attributed values directly (worth a support email regardless).

## Thresholds + constants

- **Charm tally band:** ±100 SPX points around current spot (primary), ±50 (secondary).
- **Near-spot flip alert radius:** ±10 SPX points.
- **Dominant-threshold alert radius:** ±25 SPX points.
- **Hybrid threshold floor:** `|delta| > 250` (panel-agnostic placeholder; tune after 2 weeks of data).
- **Z-score window:** rolling 30 trading days, per (strike, panel).
- **Percentile window:** last 30 sessions, per (strike, panel).
- **Cone compute time:** 14:31 UTC (9:31 ET) daily, M-F.
- **Breach check cadence:** every 1 min, 14:30–21:00 UTC, M-F.
- **Scraper cadence:** every 10 min, 14:30–21:00 UTC, M-F. Aligned to UW's tick.
- **Push-alert rate limit:** max 1 per (event_type, strike, day).

## Open questions

1. ~~**Vercel cron + headless Chromium memory cap.**~~ **Resolved 2026-05-07:** Railway service, not Vercel.
2. ~~**UW TOS on automated scraping.**~~ **Resolved 2026-05-07:** Personal automated scraping is acceptable; redistribution is not. Pipeline is internal-use only.
3. **Cone in DOM.** Phase 0 answers this. Default plan: ignore Periscope's cone, use our own compute (Phase 1 already does this).
4. **Vanna data presence.** User has only mentioned Gamma / Charm / Positions. If Vanna isn't always rendered, schema accommodates it but cron should not fail when absent.
5. **Page load timing.** UW renders values via JS — scraper must wait for `[data-loaded]` or equivalent before reading. Phase 0 confirms.

## Definition of done (whole spec)

- [ ] Phase 1 deployed: cone bounds compute daily, breach events fire push notifications
- [ ] Phase 2 deployed: scraper writes ~150 rows per panel every 10 min
- [ ] Phase 3 deployed: all four derived tables populating per snapshot
- [ ] Phase 4 deployed: frontend panels showing live data; manual cone input removed
- [ ] Phase 5 deployed: alerts routing to push surface
- [ ] Two weeks of data captured before tuning hybrid-threshold `floor_abs`
- [ ] No silent failures (Sentry alerts on selector mismatch, scraper timeout, auth expiry)

## Phase 0 findings

_To be filled in by the discovery probe._
