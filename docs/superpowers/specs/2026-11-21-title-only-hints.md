# Hover-only text for screen readers: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Give screen readers the explanation that 96 role-less elements in 32 component files currently show only as a mouse-hover `title`.
- Fix ten tooltips whose wording is wrong.
- Make the GEX landscape say when its feed has gone stale.
- Shorten the live edge cache on the GEX landscape and three Periscope endpoints to 10 seconds.
- Add a source guard, so a new hover-only element fails the gate.

**Why:** Screen readers often skip an element's `title`. Users who can't hover never get the explanation (a tier cutoff, what `1H` means, why a chip is grey). The 2026-11-21 outcome report asked: "Should I give them the same hidden hints?" The owner answered "yes". The Lottery Finder and Silent Boom row badges got hints on 2026-11-19 (6038758ec, 87cea42d0, e2d694632, b1a817f14). The `aria-label` sites in the other panels were fixed on 2026-11-21 (e37dfbd88..577a0c938). This plan covers the rest.

**Architecture:**
- Each site gets one of the fixes in "Fix codes" below.
- The fixes reuse `<SrHint>` (`src/components/ui/SrHint.tsx`, unchanged) and the helpers in `src/__tests__/helpers/aria.ts`.
- The last task adds a source scan beside `no-generic-aria-name.test.ts`. It fails on a titled generic element that has no hint and no listed exemption.

**Tech stack:** React 19, Tailwind 4, Vitest with Testing Library and jest-dom, and the `typescript` compiler API, which the existing guard already uses.

**Spec:** This document. Scope was set in conversation on 2026-11-21. A scan of every app `.tsx` found 109 titled generic elements without a hint, plus 3 `StatusBadge` callers that pass a `title` without an `srHint`. Three read-only passes sorted those 112 into 95 sites and 17 exemptions. The plan review rebuilt the guard's detector independently and found the same 112.

On 2026-11-22 the owner added the GEX landscape freshness fix ("yes"). That makes one exemption, the unreachable DELAYED badge in `ScrubControls.tsx`, into site 96. The plan now has 96 sites and the 16 exemptions in Task 20.

## Global Constraints

- **No visible change.** Visible text, classes, colors and layout stay as they are, and so does where a tooltip appears on hover. Wrapping a glyph in `<span aria-hidden="true">` is allowed. The one exception is Tasks 18–19: the GEX landscape freshness display the owner approved.
- **Hint text goes through `<SrHint>` only,** as the element's last *direct* child. `srHintText` and `titledElementsNeedingHint` read direct children only. If the hint is conditional (`{x != null && <SrHint>…</SrHint>}`), it is still the last child. No ad-hoc `sr-only` spans.
- **Keep every `title` byte-identical,** except the ten W sites, whose new text the table gives. When a site builds its title from a new `srText`/hint constant, a test pins the full title string. Add no new `title`.
- **A hint never repeats what the element already shows.** Where the title starts with or contains the visible label, the hint is a trimmed variant: a separate constant or field, the `Moneyness.srText` pattern (`IntervalBARow.tsx:113-145`).
- **Per-row hints are short.** A hint on an element that repeats in every row of a table, feed or list is at most 60 characters (see Thresholds). The long explanation stays on the column header or in the `title`.
- **Live regions get short hints.** An element inside `role="status"` or `role="alert"` is re-read on every announcement, so its hint is at most 60 characters too.
- **The cap covers exactly these sites,** marked *(per row)* or *(live)* in the tables: 7–9, 13–16, 27–28, 37–40, 68, 69, 71–75, 82, 83, 88 and 94. It does not cover:
  - site 22, at most two target rows per column, whose hint is the existing `CLS_TOOLTIP` sentence;
  - site 76, one pill per expanded detail panel, whose hint is the existing `moneyness.srText`.
- **`role="img"` + `aria-label` (fix I) only on glyph-only elements** (`—`, `↑↑`, `↓↓`, `⚡`, `★★★★`), matching `StrikeTable.tsx:343-372`. The label carries the whole meaning, because an `img`'s children are not read.
- **Inside a control,** a hint joins the control's accessible name. Only the sites the table marks get one. The Lottery Finder and Silent Boom ticker-group buttons stay under their 400-character cap, which existing tests enforce.
- **Hint wording follows the existing test bans:**
  - In GexLandscape (`BiasPanel`, `StrikeTable`), `GexLandscape.test.tsx` `dealerClaims()` scans body text and titles against `DEALER_CLAIM_PATTERNS` in `src/__tests__/helpers/dealer-claims.ts`. That file is the ban list; check every hint against it. The only exception is the exact phrase `not a market-maker position`. No `↑` or `↓` in BiasPanel text (`:724`).
  - `DealerStateSummaryStrip.test.tsx:378` bans `/raw|cross-ticker/i` in the tile text.
  - `SiblingAssetConfirmationBar.test.tsx:263` runs a dealer-wording scan.
  - Before writing a hint, grep the component's tests for regex `getByText`/`queryByText` queries the hint could also match.
- **Tests:** every site gets an assertion (see "Test pattern"). A test that pinned an old title is updated in the same commit. Never delete an assertion without a replacement.
- **Vercel-only.** Everything is under `src/` and `docs/`, plus four endpoints' cache headers: `api/gex-landscape.ts` (Task 18) and `api/periscope-map.ts`, `periscope-exposure.ts`, `periscope-strikes.ts` (Task 18b).

## Fix codes

| Code | When | Change |
|---|---|---|
| **H** (hint) | The element shows words or numbers, and the title adds meaning | Add `<SrHint>` as the last direct child, with the hint the table gives. Keep `title`. |
| **I** (img) | The element shows only glyphs | Add `role="img"` and `aria-label` (the table gives the text). Keep `title`. |
| **W** (wording) | The title says something the code doesn't do | Change the title to the table's text, and the hint to match. Update the test that pins it. |
| **K** (keep) | Exempt, for the reason the table gives | No change. Task 20 lists it as an exemption. |

## Thresholds / constants

- **60 characters:** the most a per-row or live-region hint may be, counted on the string passed to `<SrHint>`, without SrHint's ` — ` prefix. This is my call. About ten spoken words keeps a 20-row strike table or a busy feed listenable, and every per-row hint in the tables below fits.
- **400 characters:** the existing toggle-button name cap in `LotteryFinderTickerGroup.test.tsx:1288-1297` and `SilentBoomTickerGroup.test.tsx:1111-1120`. Unchanged.
- **10 s edge cache, no stale reuse,** for a live `/api/gex-landscape` response that carries fresh data or comes during the session (Task 18). The owner asked for a shorter cache on 2026-11-22.
  - Today it is `s-maxage=30, stale-while-revalidate=30` during the session and 300 + 60 s otherwise (`api/gex-landscape.ts:263`). That lets healthy data sit at the edge for up to 60 s. It also lets the first polls after the open get a pre-open response up to about 6 minutes old.
  - Every owner or guest session has its own cache entry (`Vary: Cookie`) and polls once a minute, so the longer cache saved almost nothing. 10 s still collapses a burst from several tabs or a refresh click.
- **3 minutes:** `GEX_STALE_THRESHOLD_MS`, the age at which the GEX landscape's LIVE badge turns into DELAYED (Task 19). This is my call. It is a staleness timeout, kept local to `GexLandscape/index.tsx` with this reason in a comment, the way `ScrubControls.tsx` keeps `DEFAULT_STALE_THRESHOLD_MS`. The numbers behind it:
  - **Healthy data can reach about 135 s.** That is the sum of four waits:
    - Captures land once a minute. For SPX `gamma_zero` on the two retained days (2026-11-19 and 11-20, 08:35–14:55 CT), the 758 gaps had a median of 60.0 s and a maximum of 63 s.
    - A response can sit up to 10 s at the edge, after Task 18.
    - The panel polls every 60 s (`POLL_INTERVALS.PERISCOPE`).
    - Allow about 2 s for the request itself.
  - **3 minutes leaves about 45 s of margin over that,** and still means at least one capture was missed.
  - **A throttled background tab can poll less often.** On return, it can show DELAYED until the next poll lands. The data on screen then really is that old.
  - **The server stops serving a live capture after 5 minutes** (`STALENESS_CUTOFF_MS`, `api/_lib/periscope-gexbot.ts:26`). Between 3 and about 5 minutes, the numbers show under DELAYED. Past that, the stall message shows.
  - **The age is measured, not estimated from the client clock:** `ageSec` from the server, plus the response's `Age` header, plus the time since the response arrived (Task 18). A fast or slow desktop clock can't trigger it.

## Site tables

`file:line` is relative to `src/components/` at 577a0c938. "Visible" is what the element shows.

### Gamma-node detector and Greek flow (sites 1–17)

| # | Site | Visible | Fix |
|---|---|---|---|
| 1 | `GammaNodeDetector/DayConfidenceBanner.tsx:97` pre-day filter (firing) | `pre-day filter active (prior 5d: …)` | **H** `fires when the prior 5-day return is below -1% and the prior IV rank is above 25`. Keep "pre-day filter active" out of the hint (`GammaNodeDetector.test.tsx:150` regex). |
| 2 | `…/DayConfidenceBanner.tsx:107` pre-day filter (inactive) | `pre-day filter inactive` | **H** `needs the prior 5-day return below -1% and the prior IV rank above 25 to fire` (`:133` regex). |
| 3 | `…/DayConfidenceBanner.tsx:121` anti-filter chips (`.map`) | `FOMC DAY` / `DOM 1-5` / `DOM 16-20` | **H** `f.title` |
| 4 | `…/DayConfidenceBanner.tsx:141` ceiling | `ceiling 7445 (300K)` | **H** `nearest positive-gamma strike above current spot` |
| 5 | `…/DayConfidenceBanner.tsx:147` floor | `floor 7390 (250K)` | **H** `nearest positive-gamma strike below current spot` |
| 6 | `…/DayConfidenceBanner.tsx:172` no-tier dash | `—` | **I** `no confidence tier on weekends`, plus **W**: title → `No confidence tier on weekends`. The old title says "outside the weekday RTH window", but `confidence_tier` is null only when `getDowLabel` is null, which is Saturday and Sunday (`api/gamma-setups/active.ts:203-206`, `api/_lib/gamma-detector.ts:151-159, 186-193`). |
| 7 | `…/FireRow.tsx:107` signal badge (per row) | `E1` / `E5` / `PCS` | **H**. Split `signalTitle(s)` into a new `signalHint(s)` (the description only, first letter lower-case, e.g. `long call on +γ ceiling breakthrough + 3-bar hold`). Build the title as `${signalLabel(s)} — ` plus `signalHint(s)` with its first letter upper-cased, so every title stays byte-identical (`E1 — Long call on …`). Keep `breakthrough confirmed` and `failed-bounce breakdown` out of the hint (`GammaNodeDetector.test.tsx:73,79`). |
| 8 | `…/FireRow.tsx:119` GEXBot data badge (per row) | `GEXBot data` | **H** `GEXBot taker flow; rules were tuned on UW Periscope data` |
| 9 | `…/FireRow.tsx:127` outcome (per row) | `+5.4 pts @ +30m` | **H** `direction-adjusted return from the fire bar close` |
| 10 | `…/RollingStatsBar.tsx:94` stats error | `stats error` | **H** `{error}`. Add the missing error-state test. |
| 11 | `…/RollingStatsBar.tsx:108` outcomes note | `(18 outcomes)` | **H**: hoist the title ternary to one const and use it for both. **W**: `` `${n} fires still awaiting +30m backfill` `` → pluralize (`1 fire still awaiting …`). |
| 12 | `GreekFlowPanel/MetricsBar.tsx:48` slope placeholder | `—` | **I** `not enough points to compute the slope`. This keeps `MetricsBar.test.tsx:50, 211-212` (`textContent === '—'`, one span) passing. |
| 13 | `…/MetricsBar.tsx:64` slope badge (per row) | `↑ slope` | **H** `` `last 15 min: ${slope.slope.toFixed(2)} per min` `` |
| 14 | `…/MetricsBar.tsx:82` flip badge (per row) | `flip` | **H** `` `sign changed within 30 min, at ${time} (magnitude ${mag})` ``, where `mag` is in compact notation (`1.2M`), like `FlowChart.tsx:199-203` (`Intl.NumberFormat` `notation: 'compact'`); share one formatter. The raw `toFixed(0)` can run 9 digits and break the 60-character cap. Drop the `at …` clause whenever `fmtTime(...)` returns `—`, which covers a null and an invalid timestamp. Test with magnitude 123456789. The title is unchanged. |
| 15 | `…/MetricsBar.tsx:94` cliff badge (per row) | `cliff` | **H** `` `over 10 min, at ${time} (magnitude ${mag})` ``, with the same compact `mag` and the same rule. The cliff badge never renders with a null timestamp (`:89`), so test the dropped clause with an invalid ISO string, as `MetricsBar.test.tsx:135` does. |
| 16 | `…/MetricsBar.tsx:106` divergence badge (per row) | `⇄ div` | **H** `SPY and QQQ have opposite signs on this field` |
| 17 | `…/Verdict.tsx:165` regime changes | `Regime changes: 3` | **H** `` `only changes between kinds other than no-trade; all transitions, including no-trade churn: ${summary.transitions}` `` |

Exempt here: `GreekFlowPanel/Verdict.tsx:148`, the timeline run spans. They are children of a `role="img"` (`aria-label="Verdict timeline through the session"`), so a hint would never be read.

### GEX landscape (sites 18–40)

Files: `GexLandscape/BiasPanel.tsx`, `StrikeTable.tsx`, `classify.ts`, `constants.ts`.

| # | Site | Visible | Fix |
|---|---|---|---|
| 18 | `BiasPanel.tsx:59` verdict label | `▲ TOP ABOVE · LONG γ` | **H** `VERDICT_TOOLTIP_TAIL` (export it from `constants.ts`). The rest of the title repeats the sibling `vm.desc` span. |
| 19 | `BiasPanel.tsx:72` net-gamma badge | `NET LONG γ +2.3B` | **H**: hoist the title ternary to `regimeHint`, used for both. |
| 20 | `BiasPanel.tsx:90` top-gamma block | `Top \|γ\| strike …` | **H** the title text (one const). |
| 21 | `BiasPanel.tsx:178` `DriftTargetColumn` (2 renders) | `▲ Top \|γ\| above` / `below` | **H** `{title}` (the prop). |
| 22 | `BiasPanel.tsx:199` target row (≤4 rows) | `7,050 Takers +γ +charm +1.2B` | **H** `CLS_TOOLTIP[t.cls]`, after the optional glyph spans. |
| 23 | `BiasPanel.tsx:221` `↑↑` | glyph | **I** aria-label = the title text, the way StrikeTable's marks do it. |
| 24 | `BiasPanel.tsx:229` `↓↓` | glyph | **I**, same. |
| 25 | `BiasPanel.tsx:237` `⚡` | glyph | **I**, same. |
| 26 | `BiasPanel.tsx:273` `TrendLadder` | `Trend Ladder` + 3 rows | **H** `average % change in GEXBot dollar gamma in taker-side sign. F is the strikes more than 25 pts below spot and C the strikes more than 25 pts above, each against the value 5, 15 and 30 min ago` |
| 27 | `BiasPanel.tsx:312` F cell (per row, 3 rows) | `F +2.5%` | **H** `` `average Δ${label} of the strikes below spot` `` |
| 28 | `BiasPanel.tsx:319` C cell (per row, 3 rows) | `C +2.5%` | **H** `` `average Δ${label} of the strikes above spot` `` |
| 29 | `StrikeTable.tsx:96` Position header | `Position` | **H** the title text. |
| 30–32 | `StrikeTable.tsx:102,108,114` NetGamma / NetCharm / NetVanna headers | the header word | **H** the title text: hoist each to a const shared by title and hint. The tail stays exactly `not a market-maker position`. |
| 33–35 | `StrikeTable.tsx:120,126,132` Δ5m / Δ15m / Δ30m headers | the header word | **H** the title text. |
| 36 | `StrikeTable.tsx:138` Vol Reinf. header | `Vol Reinf.` | **H** `delta-trend agreement. Reinforcing: all three Δ% windows move with the netGamma sign, so the strike's gamma is growing in that sign. Opposing: all three move against it, so it is shrinking toward zero. Neutral: mixed, sparse or no data` |
| 37 | `StrikeTable.tsx:205` signed distance (per row) | `+15 pts` | **H** `above spot` / `below spot` |
| 38 | `StrikeTable.tsx:222` class badge (per row) | `Takers −γ +charm` | **H** `` `takers net ${gamma} gamma, net ${charm} charm` ``. The shared piece is a new `takerSideWords(cls): { gamma: 'long' \| 'short'; charm: 'long' \| 'short' }` in `classify.ts`. `signalTooltip` takes its two words from it and still builds its own sentence, which stays byte-identical. The hint string is built from the same words. |
| 39 | `StrikeTable.tsx:266` position signal (per row) | `Taker-short γ above spot` | **H** a new `positionBand(dir)` in `classify.ts`: `` `more than ${SPX_SPOT_BAND} pts above spot` `` / `below spot` / `` `within ${SPX_SPOT_BAND} pts of spot` ``. `signalTooltip` reuses it. |
| 40 | `StrikeTable.tsx:286` charm value (per row) | `+2.0M` | **H** a new `charmHint(netCharm)`: `takers net long charm` (≥ 0) / `takers net short charm`. Same split as `charmTooltip`. |

### Lottery Finder panel and banners (sites 41–54)

| # | Site | Visible | Fix |
|---|---|---|---|
| 41 | `LotteryFinder/index.tsx:1771` | `(1-min)` | **H** `filtered to the selected 1-minute bucket` |
| 42 | `…/index.tsx:1813` | `12:34 CT` | **H** `last updated` |
| 43 | `…/index.tsx:1821` | `replay` | **H** `showing the selected past day, no live polling` |
| 44 | `…/index.tsx:1933` | `(4 hidden by quality filter)` | **H** `chains from Q1/Q2 inversion-quality tickers, hidden by default; turn on Show filtered tickers to include them`. Keep `hidden by quality filter` out of the hint (`LotteryFinderSection.test.tsx:438,453`). **W**: `bottom-quintile (Q1/Q2)` → `bottom-two-quintile (Q1/Q2)`. The API suppresses quintiles 1 and 2 (`api/lottery-finder.ts:858-869`). |
| 45 | `…/LotteryDayBanner.tsx:93` metric, no-data branch (3 metrics) | `Market Tide —` | **H** one module const: `no data: early-session fire before the macro tables filled, or a backfilled fire without macro` |
| 46 | `…/LotteryDayBanner.tsx:105` SPX Gamma sign | `SPX Gamma 🟢` | **H** via a new `srText` prop on `DayMetric`: `dealer gamma sign at the latest fire: green is long gamma (vol-suppressing), red is short gamma (vol-amplifying), white is zero` (as built; the label already says "SPX") |
| 47 | `…/LotteryDayBanner.tsx:121` signed metrics | `Market Tide ⬆ +1.2M` | **H** via `srText`. Market Tide: `net call minus net put premium at the latest fire; positive means calls dominate, negative means puts dominate`. 0DTE Flow: `net call minus net put premium at the latest fire` (as built; the label already says "0DTE"). |
| 48 | `…/LotteryTierBanner.tsx:105` headline | `This page · 25 fires of 100 today` | **H**, per branch. When `hasMoreToday`, the hint is the title string, hoisted to one const used for both. When the page holds the whole day, the hint is `every fire of the day is on this page`, which keeps the word "today" out, because `LotteryTierBanner.test.tsx:219` asserts no text says it in that branch. |
| 49–51 | `…/LotteryTierBanner.tsx:126,132,138` tier counts | `🔥🔥🔥 3` | **H** `tierTitle(n, cutoffs, rate)`, computed once per tier and used for both. |
| 52 | `…/LotteryTierBanner.tsx:146` dominant ticker | `top: AAPL ×12` | **H** `most fires of any ticker on the current page` |
| 53 | `…/LotteryTierBanner.tsx:161` top score | `top score: AAPL 85` | **H** `` `${topFire.strike}${topFire.optionType}, highest-scoring fire in the current view` `` |
| 54 | `…/ReignitionSection.tsx:121` floor-blind pill (in the `h3` that names the section) | `floor-blind` | **H** `ranks by cadence, skipping the Take-It floor, score, premium and quality filters`. Keep `ignores the TAKE-IT floor` out (`ReignitionSection.test.tsx:272`, case-insensitive). From `sm` up, the `<p>` at `:129` already shows part of this. The hint is there for phones, where that `<p>` is hidden. The section's region name grows by this hint. Update any `getByRole('region', { name })` query in `src/__tests__/` and `e2e/`. |

Exempt here, unchanged and pinned by tests:
- Five chips in each ticker-group header: count, strikes, premium, last hit, best peak. `LotteryFinderTickerGroup.tsx:280, 344, 389, 409, 417, 423` and `SilentBoomTickerGroup.tsx:247, 311, 356, 376, 384, 390`. They sit inside the toggle button, whose name already measures 396–397 of the 400-character cap.
- The expiry chip inside the contract link: `LotteryRow.tsx:943` and `SilentBoomRow.tsx:822`. Its text already shows the expiry and DTE (`d02d395dc`).
- `LotteryRow.tsx:963` already has a conditional hint (the scan misread it).

### Silent Boom panel and banners (sites 55–67)

| # | Site | Visible | Fix |
|---|---|---|---|
| 55 | `SilentBoom/index.tsx:1496` exit label | `EXIT` | **H** `sets which outcome % shows first on every alert` (as built; "exit" repeated the label, and "realized" was wrong for the peak option) |
| 56 | `…/index.tsx:1676` | `(5-min)` | **H** `filtered to the selected 5-minute bucket` |
| 57 | `…/index.tsx:1713` | `12:34 CT` | **H** `last updated` |
| 58 | `…/index.tsx:1721` | `replay` | **H** `showing the selected past day, no live polling` |
| 59 | `…/index.tsx:1818` | `(2 hidden by filters)` | **H** `removed by the filter chips on this page; still counted in the day total`. Keep `hidden by filters` out (`SilentBoomSection.test.tsx:1833`). |
| 60–62 | `…/SilentBoomDayBanner.tsx:95,101,107` tier counts | `🔥🔥🔥 1` | **H**: hoist each title literal to a const, used for both. |
| 63 | `…/SilentBoomDayBanner.tsx:117` dominant ticker | `top: AAPL ×12` | **H** `most alerts of any ticker on the current page` |
| 64 | `…/SilentBoomDayBanner.tsx:134` loudest | `loudest: AAPL ×150` | **H** `` `${topAlert.strike}${topAlert.optionType}, largest spike ratio in the current view` ``. Keep the ticker out (`SilentBoomDayBanner.test.tsx` `getAllByText('NVDA')`). **W**: `(floored at 100 to match the row badge)` → `(baseline volume counted as at least 100, to match the row badge)`. The floor is on the baseline (`:13-16`), not on the ratio. |
| 65 | `…/SilentBoomRegimeBanner.tsx:89` no-data branch | `Market Tide —` | **H** one const: `no data: alert fired outside the macro window or before the macro tables filled` |
| 66 | `…/SilentBoomRegimeBanner.tsx:101` SPX Gamma sign | `SPX Gamma 🟢` | **H** via `srText`: `dealer gamma sign at the latest alert: green is long gamma (vol-suppressing), red is short gamma (vol-amplifying), white is zero` (as built) |
| 67 | `…/SilentBoomRegimeBanner.tsx:115` signed metrics | `Market Tide ⬆ +1.2M` | **H** via `srText`. Market Tide: `net call minus net put premium at the latest alert; positive means calls dominate, negative means puts dominate`. 0DTE Flow: `net call minus net put premium at the latest alert` (as built). |

### Interval B/A (sites 68–76)

Files: `IntervalBAAlertBanner.tsx`, `IntervalBAFeed/IntervalBAFeed.tsx`, `IntervalBAFeed/IntervalBARow.tsx`, plus one new module, `IntervalBAFeed/side-text.ts`, for the CALL/PUT text that both the row and the banner use. A non-component module keeps `react-refresh/only-export-components` quiet.

| # | Site | Visible | Fix |
|---|---|---|---|
| 68 | `IntervalBAAlertBanner.tsx:178` side pill (live: `role="alert"` toast) | `CALL` / `PUT` | **H** `SIDE_SR_TEXT[side]`: `buyers paid the ask for upside calls, bullish` / `buyers paid the ask for downside puts, bearish`. The title stays the current literal. |
| 69 | `IntervalBAAlertBanner.tsx:190` confluence pill (live: toast) | `+QQQ +SPY` | **H** `same direction within about 90 seconds` |
| 70 | `IntervalBAFeed/IntervalBAFeed.tsx:149` | `stale` | **H** `three polls in a row went unanswered; the rows shown may be out of date` |
| 71 | `IntervalBARow.tsx:293` severity pill (per row) | `EXTREME` / `CRITICAL` / `WARNING` | **H** a new `srText` field in `SEVERITY_STYLES`: `bucket total premium at least $1M, the highest tier` / `bucket total premium $500K to $1M, the middle tier` (no "floor": `IntervalBARow.test.tsx:238` queries `/floor/`) / `bucket total premium $250K to $500K, the lowest tier`. `tooltip` is unchanged. |
| 72 | `IntervalBARow.tsx:306` side pill (per row) | `CALL` / `PUT` | **H** `SIDE_SR_TEXT[side]` (shared with site 68). |
| 73 | `IntervalBARow.tsx:329` confluence pill (per row) | `+QQQ +SPY` | **H** `cross-symbol confluence within about 90 seconds`. **W**: drop the title's hit-rate sentence (`CALL hit-rate lifts from 53% solo to 61% with at least one partner (per 2026-05-12 backfill analysis).`). The title keeps only the confluence definition (see the note below the table). |
| 74 | `IntervalBARow.tsx:341` ratio block (per row) | `86% ratio` | **H** `ask-side share of bucket premium; 75% is the anomaly bar` |
| 75 | `IntervalBARow.tsx:429` side letter (per row, detail panel) | `C` / `P` | **H** `call` / `put` |
| 76 | `IntervalBARow.tsx:436` moneyness pill (detail panel) | `ITM 1.7%` | **H** `moneyness.srText`, as the summary pill at `:322` uses it. |

**Why site 73 and W-only item 97 drop the hit-rate claim:**
- It was measured on SPXW calls only (`docs/superpowers/specs/interval-ba-confluence-2026-05-13.md:18`), and the pill also shows on PUT, SPY and QQQ rows.
- It does not hold on the live alerts. From 2026-05-14 to 11-20, counting the first alert per contract, SPXW calls closed in the bet's direction 46.8% of the time solo and 43.8% with confluence.
- Confluence alerts did not hit more often than solo in any of the six ticker × side groups once days are treated as the unit of dependence. Every day-clustered interval contains zero, and all q ≥ 0.44 (`docs/tmp/interval-ba-confluence-recheck-2026-11-21.md`).

### Greek heatmap and Gexbot (sites 77–83)

| # | Site | Visible | Fix |
|---|---|---|---|
| 77 | `GreekHeatmap/DataAgeBadge.tsx:27` | `as of 10:05 CT` | **H** `snapshot time, Central Time` |
| 78 | `GreekHeatmap/index.tsx:303` stale strip | `⚠ Stale — last good snapshot (…)` + Retry button | **H** `{error}`, with an `error != null &&` guard, as the strip's last child after Retry. The title stays on the strip. Today the error text never reaches a screen reader. |
| 79 | `GreekHeatmap/NetFlowRow.tsx:47` NCP value | `$1.2M` | **H** `` `net call premium, ${formatVol(netFlow.cumulativeCallVol)} contracts` `` |
| 80 | `GreekHeatmap/NetFlowRow.tsx:58` NPP value | `$0.8M` | **H** `` `net put premium, ${formatVol(netFlow.cumulativePutVol)} contracts` `` |
| 81 | `GreekHeatmap/NetFlowRow.tsx:69` total | `$2.0M` | **H** `net call premium plus net put premium` |
| 82 | `Gexbot/DealerStateSummaryStrip.tsx:374` loudest sub-line (live: `role="status"`) | `taker +Δ flow +1.20 · 3.0× typical` | **H** a new `LOUDEST_HINT`: `last-minute change in taker delta, ranked by that multiple`. It doesn't say "of typical", because in the floored case (`pick.floored`, `:356`) the visible text reads `× the 0.25 floor`. No "raw" (`DealerStateSummaryStrip.test.tsx:378`). `LOUDEST_TITLE` is unchanged. |
| 83 | `Gexbot/SiblingAssetConfirmationBar.tsx:172` (per row: the bar is on every Lottery Finder and Silent Boom row) | `no data` | **H** `` `no sibling snapshot near the ${asOfLabel}` `` (≤ 48 characters with the longest `asOfLabel`, `5-min bucket start`). The title stays its current literal (`SiblingAssetConfirmationBar.test.tsx:222-227`). |

### Futures and status badges (sites 84–90)

| # | Site | Visible | Fix |
|---|---|---|---|
| 84 | `FuturesCalculator/FuturesGrid.tsx:103` volume badge | `2.5x` | **H** `heavy volume versus its 20-day average` / `elevated volume versus its 20-day average`. In the NORMAL band, as built: `volume versus its 20-day average`, with no level word, because NORMAL covers every ratio under 1.5, even 0.3×. `HEAVY`/`ELEVATED` is shown today only as the badge color, so this gives screen readers the level. Rename the test "shows HEAVY label in title" (its title has no such word) to say what it checks. |
| 85 | `…/FuturesGrid.tsx:123` | `1H +0.35%` | **H** `1-hour change`. `FuturesGrid.test.tsx:165,168` pin `textContent` exactly, and it now includes the hint. Keep those assertions pinning the visible text exactly (the element's text with its `.sr-only` child removed), and add `srHintText`. |
| 86 | `…/FuturesGrid.tsx:130` | `D +1.20%` | **H** `day change`. Same for `FuturesGrid.test.tsx:180,183`. |
| 87 | `…/FuturesGrid.tsx:144` basis line | `Basis: +3.20 pts` | **H** `ES price minus SPX`. **W**: `ES - SPX fair value basis` → `ES price minus SPX (raw basis)`. `deriveEsSpxBasis` returns `es.price - spx` (`api/futures/snapshot.ts:354-357`), with no fair-value adjustment. Update `FuturesGrid.test.tsx:302`. |
| 88 | `FuturesCalculator/FuturesPanel.tsx:144` `StatusBadge` "VIEWING HISTORICAL" | label | Add `srHint="a snapshot, not live; click Now to return to live data"`. As built, this avoids repeating "historical" from the label. The badge sits in a `<span role="status">`, so the 60-character cap applies. Also as built, two fixes for WCAG 2.5.3 (Label in Name):<br>• The Now button's `aria-label` becomes `Now: reset to live data`. It was `Reset to live data`, so a screen reader never said the "Now" the hint names.<br>• The Refresh button's `aria-label` follows its visible `Loading...` text while it loads. |
| 89 | `AppHeader/index.tsx:217` `StatusBadge` "NO INTRADAY" | label | Add `srHint={historyData.error}`. `AppHeader.test.tsx:500` pins what assistive tech reads (`'● NO INTRADAY'`). Update it to the new full string, with the fixture's error text after ` — `. |
| 90 | `AppHeader/QuoteStatusBadge.tsx:56` `StatusBadge` | `STALE` / `LIVE` / `CLOSED` | Add `srHint` = the title without what the label shows: `` `quotes ${staleAgeSec}s old${missedPolls}` `` when stale, else none. This badge has no `shortLabel`, so `StatusBadge` doesn't make it `relative`, and its absolutely positioned sr-only hint could widen the sideways-scrolling header on a phone (`StatusBadge.tsx:14-16, 33-35`). Make `StatusBadge` add `relative` when `srHint` is set too. Nothing visible changes. Test it in `src/__tests__/components/ui.test.tsx`. |

### P&L tables, Periscope and pin setup (sites 91–95)

| # | Site | Visible | Fix |
|---|---|---|---|
| 91 | `BWBSection/BWBPnLProfileTable.tsx:227` struck-through PoP | `65.3%` | **H** `log-normal PoP, without the fat-tail adjustment` |
| 92 | `IronCondorSection/PnLProfileTable.tsx:210` struck-through PoP | `65.3%` | **H** same text. |
| 93 | `PeriscopeChat/PeriscopeChatHistory.tsx:459` stars, inside the row toggle button | `★★★★` | **I** `` `calibration quality ${item.calibration_quality} of 5` ``. A run of ★ reads as "black star" over and over. |
| 94 | `PeriscopeLottery/PeriscopeLotteryPanel.tsx:332` outcome pill (per row) | `peak 250% · eod -0.50R` | **H** `` `at peak, ${rPeakLabel}` `` when `realizedRPeak != null`. **W**: when it is null, drop the ` (—)` from the title, so the title equals the visible text and needs no hint. |
| 95 | `PinSetupTile/index.tsx:165` | `⚠ update failed` | **H** `{error}` |

### GEX landscape freshness (site 96)

| # | Site | Visible | Fix |
|---|---|---|---|
| 96 | `ScrubControls.tsx:176` DELAYED badge (reachable after Task 19) | `DELAYED 12m` | **H** `the upstream feed has not sent new data`. **W**: the title `` `Latest data is ${staleMinutes}m old — upstream feed has not emitted new alerts` `` → `` `Latest data is ${staleMinutes}m old — the upstream feed has not sent new data` ``. The panel shows GEX data, not alerts. |

### Wording-only fixes (items 97–98)

These are button titles, not hint sites: a button's `title` becomes its accessible description, so screen readers already hear it. They repeat a claim this plan corrects elsewhere.

| # | Where | Fix | Task |
|---|---|---|---|
| 97 | `IntervalBAFeed/IntervalBAFeed.tsx:254` "confluence only" button | **W**: keep the first sentence. Drop `Confluence cohort: +8pp CALL hit-rate vs solo (2026-05-12 backfill).` (the reason is under site 73's table). Pin the new title. | 10 |
| 98 | `LotteryFinder/index.tsx:1380` "Show filtered tickers" button | **W**: `bottom-quintile tickers` → `bottom-two-quintile tickers`, matching site 44. Pin the new title. | 5 |

## Test pattern

Use the helpers in `src/__tests__/helpers/aria.ts`, including `titledGenericsWithoutHint`, which Task 0 adds.

- **H:** `expect(srHintText(el)).toBe('<exact hint>')`. Where the title is now built from a shared constant, also `expect(el).toHaveAttribute('title', '<exact title>')`.
- **I:** `screen.getByRole('img', { name: '<exact label>' })`, and the title is unchanged.
- **W:** the new title, pinned exactly.
- **The 60-character cap:** for each site in the Global Constraints list, assert `srHintText(el)!.length <= 60` once per hint variant. For example, use one `it.each` over the three severities and two sides.
- **Every touched component's test file** adds `expect(titledGenericsWithoutHint(container)).toEqual([])` for a render that reaches each fixed site.
  - The check covers generic tags only. Titled elements outside `GENERIC_TAGS` are out of scope, so the older all-tags `titledElementsWithoutHint` would fail on them for reasons this plan doesn't address. Examples: the `<label title>` toolbar controls in Lottery Finder (`index.tsx:1279, 1311`) and Silent Boom (`index.tsx:1215, 1241`), and the `<td title aria-label>` cells in `GreekHeatmapTable.tsx:154-177`.
  - The one generic exemption a runtime check meets is the Verdict timeline runs. Filter them out by test id, with a comment giving the reason.
  - A component with no test file gets one.
- **Pinned text content.** Where a test pins an element's whole `textContent` (sites 85, 86 and 89), keep pinning the visible text exactly and add the hint assertion. The one exception is `AppHeader.test.tsx:500`, which pins what assistive tech reads; it moves to the new full string.
- **Each branch gets its own assertion,** because the conditional sites render different spans per state. That means:
  - the pre-day filter on and off, and tier null;
  - flip and cliff with a valid and an invalid time;
  - each `DayMetric`/`RegimeMetric` branch;
  - the three severities and two sides;
  - both `LotteryTierBanner` headline branches;
  - `realizedRPeak` null and set.

## Review Focus

1. **Double reading.** A hint that repeats the visible label makes a screen reader say it twice. This matters most where the title starts with the label (sites 1, 2, 7, 18, 43, 47, 58, 67, 68–73).
2. **Hint not a direct child.** Sites 52, 53, 63 and 64 have nested spans. The hint must be the outer span's last direct child, or `srHintText` returns null and the guard fails.
3. **Regex queries matching hint text.** Hints add text, so a `getByText(/…/)` or `queryByText(/…/)` that also matches the hint finds two elements, or finds the hint instead. The table names the known ones. The implementer greps for the rest.
4. **Names that grow.** Site 54 lengthens a region name. Site 93 changes a toggle button's name. Sites 88–90 change status-badge names in the futures panel and the app header. Check every `getByRole(…, { name })` in `src/__tests__/` and `e2e/`.
5. **Title drift.** Wherever a title is rebuilt from a new constant, the old and new titles must match byte for byte, and the tests pin the strings. That's sites 7, 11, 19, 38–40, 48–51, 60–62, 71 and 83.
6. **Freshness clock (Task 19).** The 15 s tick must not run while the panel is scrubbed, while the market is closed, or after unmount. A DELAYED badge that lights up after the close, or a leaked interval, is the failure to look for. Healthy data reaches about 135 s just before a poll, once Task 18 shortens the edge cache to 10 s. That leaves the 3-minute threshold about 45 s of margin. The threshold holds only if the cache change lands too; with the old 30 + 30 s cache, it would flicker. The age must use `dataAgeMsAtReceipt`, not the client clock against `asOf`.

---

Each task below is one commit of at most 5 files, tests included (CLAUDE.md, "Phased Execution"). The controller may batch neighboring small tasks into one implementer dispatch and one review, keeping one commit per task. Every task follows the same steps:

- [ ] Write the failing assertions from "Test pattern" for the task's sites.
- [ ] Run the touched test files. They fail on the new assertions.
- [ ] Apply the fixes from the site table.
- [ ] Run the touched test files. They pass. Grep `src/__tests__`, the colocated `__tests__/` and `e2e/` for queries the change affects.
- [ ] `npm run review` green, then commit with the task's message.

### Task 0: A generic-only hover-text check

**Files:**
- Modify: `src/__tests__/helpers/aria.ts`
- Test: the file where the runtime-helper tests live (`src/__tests__/no-generic-aria-name.test.ts`, or an existing `aria` helper test)

**Interfaces:**
- `titledElementsNeedingHint` exempts an element only when its role is real. It uses the same rule as `genericElementsWithAriaLabel`: `role != null && !countsAsNoRole(role)`. So `role=""`, `none` and `presentation` no longer exempt.
- Produces: `titledGenericsWithoutHint(root: ParentNode): string[]`, the snippets from `titledElementsWithoutHint` limited to elements that match `GENERIC_TAGS`.

Fixture tests:
- A titled `<span>` without a hint is reported.
- A titled `<span role="none">` is reported.
- A titled `<label>` and a titled `<td>` are not reported.

Also check that the six existing callers' tests still pass. Commit: `test(a11y): Add a generic-only hover-text check and count an empty role as none`.

### Task 1: Gamma-node detector (sites 1–11)

- Modify: `src/components/GammaNodeDetector/DayConfidenceBanner.tsx`, `FireRow.tsx`, `RollingStatsBar.tsx`
- Test: `src/__tests__/GammaNodeDetector.test.tsx`, `src/__tests__/RollingStatsBar.test.tsx`
- Commit: `fix(a11y): Give the gamma-node detector's hover text to screen readers`

If `signalTitle` lives in another file, that file joins this task. Move a test to keep the commit at 5 files.

### Task 2: Greek flow (sites 12–17)

- Modify: `src/components/GreekFlowPanel/MetricsBar.tsx`, `Verdict.tsx`
- Test: `src/components/GreekFlowPanel/__tests__/MetricsBar.test.tsx`, `src/__tests__/components/GreekFlowPanel.test.tsx`
- Commit: `fix(a11y): Give the Greek-flow badges' hover text to screen readers`

### Task 3: GEX landscape helpers (for sites 18, 38–40)

- Modify: `src/components/GexLandscape/classify.ts` (`takerSideWords`, `positionBand`, `charmHint`), `constants.ts` (export `VERDICT_TOOLTIP_TAIL`)
- Test: `src/__tests__/components/GexLandscape-classify.test.ts`. It pins `signalTooltip` byte-identical for every class × direction, plus each new helper's output.
- Commit: `refactor(gex): Split the strike-table tooltip words into reusable helpers`

### Task 4: GEX landscape panels (sites 18–40)

- Modify: `src/components/GexLandscape/BiasPanel.tsx`, `StrikeTable.tsx`
- Test: `src/__tests__/components/GexLandscape.test.tsx`. The dealer-claims scan and the no-arrow assertion must still pass.
- Commit: `fix(a11y): Give the GEX landscape hover text to screen readers`

### Task 5: Lottery Finder panel and Hot Right Now (sites 41–44, 54; item 98)

- Modify: `src/components/LotteryFinder/index.tsx`, `ReignitionSection.tsx`
- Test: `src/__tests__/LotteryFinderSection.test.tsx`, `src/__tests__/ReignitionSection.test.tsx`. The ticker-group and row tests must still pass unchanged.
- Commit: `fix(a11y): Give the Lottery Finder toolbar and Hot Right Now hover text to screen readers`

### Task 6: Lottery Finder banners (sites 45–53)

- Modify: `src/components/LotteryFinder/LotteryDayBanner.tsx`, `LotteryTierBanner.tsx`
- Test: `src/__tests__/LotteryDayBanner.test.tsx`, `src/__tests__/LotteryTierBanner.test.tsx`
- Commit: `fix(a11y): Give the Lottery Finder banners' hover text to screen readers`

### Task 7: Silent Boom panel and day banner (sites 55–64)

- Modify: `src/components/SilentBoom/index.tsx`, `SilentBoomDayBanner.tsx`
- Test: `src/__tests__/SilentBoomSection.test.tsx`, `src/__tests__/SilentBoomDayBanner.test.tsx`
- Commit: `fix(a11y): Give the Silent Boom toolbar and day banner hover text to screen readers`

### Task 8: Silent Boom regime banner (sites 65–67)

- Modify: `src/components/SilentBoom/SilentBoomRegimeBanner.tsx`
- Test: `src/__tests__/SilentBoomRegimeBanner.test.tsx`
- Commit: `fix(a11y): Give the Silent Boom regime banner's hover text to screen readers`

### Task 9: Interval B/A toast (sites 68–69)

- Create: `src/components/IntervalBAFeed/side-text.ts` (`SIDE_SR_TEXT`)
- Modify: `src/components/IntervalBAAlertBanner.tsx`
- Test: `src/__tests__/IntervalBAAlertBanner.test.tsx`
- Commit: `fix(a11y): Give the Interval B/A toast pills' hover text to screen readers`

### Task 10: Interval B/A feed and rows (sites 70–76; item 97)

- Modify: `src/components/IntervalBAFeed/IntervalBAFeed.tsx`, `IntervalBARow.tsx`
- Test: `src/__tests__/IntervalBAFeed.test.tsx`, `src/__tests__/IntervalBARow.test.tsx`, `src/__tests__/IntervalBARow.lazy-chart.test.tsx` (detail panel)
- Commit: `fix(a11y): Give the Interval B/A row pills' hover text to screen readers`

### Task 11: Greek heatmap (sites 77–81)

- Modify: `src/components/GreekHeatmap/DataAgeBadge.tsx`, `index.tsx`, `NetFlowRow.tsx`
- Test: `src/__tests__/DataAgeBadge.test.tsx`, `src/__tests__/GreekHeatmapSection.test.tsx`
- Commit: `fix(a11y): Give the Greek heatmap's hover text to screen readers`

### Task 12: Gexbot strips (sites 82–83)

- Modify: `src/components/Gexbot/DealerStateSummaryStrip.tsx`, `SiblingAssetConfirmationBar.tsx`
- Test: `src/__tests__/DealerStateSummaryStrip.test.tsx`, `src/__tests__/SiblingAssetConfirmationBar.test.tsx`
- Commit: `fix(a11y): Give the dealer-state and sibling-asset strips' hover text to screen readers`

### Task 13: Futures grid and historical badge (sites 84–88)

- Modify: `src/components/FuturesCalculator/FuturesGrid.tsx`, `FuturesPanel.tsx`
- Test: `src/__tests__/components/FuturesGrid.test.tsx`, and the `FuturesPanel` test that renders the historical badge (`src/__tests__/components/FuturesPanel.historical.test.tsx` if it does)
- Commit: `fix(a11y): Give the futures grid and historical badge hover text to screen readers`

### Task 14: Header status badges (sites 89–90)

- Modify: `src/components/ui/StatusBadge.tsx` (`relative` when `srHint` is set), `src/components/AppHeader/index.tsx`, `QuoteStatusBadge.tsx`
- Test: `src/__tests__/components/ui.test.tsx`, `src/__tests__/AppHeader.test.tsx`. Grep `e2e/` for the header badges.
- Commit: `fix(a11y): Give the header status badges' hover text to screen readers`

### Task 15: P&L tables (sites 91–92)

- Modify: `src/components/BWBSection/BWBPnLProfileTable.tsx`, `src/components/IronCondorSection/PnLProfileTable.tsx`
- Test: `src/__tests__/components/BWBSection.test.tsx`, `src/__tests__/components/IronCondorSection.test.tsx`
- Commit: `fix(a11y): Name the struck-through log-normal PoP for screen readers`

### Task 16: Periscope (sites 93–94)

- Modify: `src/components/PeriscopeChat/PeriscopeChatHistory.tsx`, `src/components/PeriscopeLottery/PeriscopeLotteryPanel.tsx`
- Test: `src/__tests__/components/PeriscopeChatHistory.test.tsx`, `src/components/PeriscopeLottery/PeriscopeLotteryPanel.test.tsx`
- Commit: `fix(a11y): Give the Periscope rating stars and outcome pill hover text to screen readers`

### Task 17: Pin setup (site 95)

- Modify: `src/components/PinSetupTile/index.tsx`
- Test: `src/__tests__/components/PinSetupTile.test.tsx`
- Commit: `fix(a11y): Give the pin setup's update-failed reason to screen readers`

### Task 18: GEX landscape: a shorter live cache, and freshness fields in its data hook

**Files:**
- Modify: `api/gex-landscape.ts`, `src/hooks/useGexLandscapeData.ts`
- Test: `api/__tests__/gex-landscape.test.ts` (find the endpoint's test file by name), `src/__tests__/hooks/useGexLandscapeData.test.ts`

**Server cache:**
- Replace the up-front `setCacheHeaders(res, marketOpen ? 30 : 300, marketOpen ? 30 : 60)` (`api/gex-landscape.ts:263`) with a call on each success path, chosen by what the response is.
- Use `setCacheHeaders(res, 10, 0)` for:
  - a live request (no `at`) whose response carries data; the capture is under 5 minutes old, so captures are running, the pre-open included;
  - a live request during the session (`marketOpen`) with `no_slot` or `no_spot`, so a recovering feed shows within seconds.
- Use `setCacheHeaders(res, 300, 60)`, as today, for:
  - a scrubbed request (`at` set); a past minute's capture doesn't change;
  - a live request outside the session with no data.
- An error response sets no cache header. Today the header is set before the queries run, so a 5xx reply carries `s-maxage=30`.
- The tests (`setCacheHeaders` is already mocked there) assert the exact arguments for each of the five cases:
  - live with data, in session and pre-open;
  - live `no_slot` in session;
  - live, closed, no data;
  - scrubbed;
  - a DB error (no call).
- `api/` imports no `src/` file here, so the `.js` rule doesn't apply.

**Interfaces:**
- `UseGexLandscapeDataReturn` gains one field, `freshness: GexLandscapeFreshness | null`. It is null before the first response. It is also null whenever the stored response came from a scrubbed (`at`) fetch. To know that, the hook records the `at` each response was fetched with and doesn't trust the panel's current state; this is R6's "key ingests on a response-echoed identity".
  ```ts
  interface GexLandscapeFreshness {
    /** Server's market-open flag for this response. */
    serverMarketOpen: boolean;
    reason: 'no_slot' | 'no_spot' | null;
    /** Age of the capture when the response arrived:
     *  (ageSec + the response's `Age` header) × 1000.
     *  Null when the response carried no data. */
    dataAgeMsAtReceipt: number | null;
    /** Date.now() when the response arrived. Used only as a delta. */
    receivedAt: number;
  }
  ```
- `fetchGexLandscape` returns the response's `Age` header (seconds, 0 when absent) along with the body.
- `/api/gex-landscape` already sends `marketOpen`, `reason` and `ageSec` (`api/gex-landscape.ts:280-327`). Its body doesn't change; only the cache headers do.

Tests:
- A data response with `ageSec: 40` and `Age: 20` yields `dataAgeMsAtReceipt: 60_000`.
- A missing `Age` header counts as 0.
- A `no_slot` response yields `reason: 'no_slot'` and `dataAgeMsAtReceipt: null`.
- `serverMarketOpen` follows the response.
- A scrubbed fetch yields `freshness: null`.
- After switching from scrubbed back to live, `freshness` stays null until the live response lands, then reflects it.

Commits (two, each with its own test): `perf(gex): Cache the live landscape response for 10 seconds, not up to a minute` (the api file and its test), then `feat(gex): Keep the landscape response's freshness fields in its data hook` (the hook and its test).

### Task 18b: The same shorter live cache on three Periscope endpoints

The owner asked for this on 2026-11-22 ("yeah lets do that too"). The `/api/periscope-map`, `/api/periscope-exposure` and `/api/periscope-strikes` endpoints use the cache the GEX landscape had: live reads at 30 + 30 s in the session, and 300 + 60 s otherwise. So the same two lags apply. Healthy data can sit up to 60 s at the edge, and the first polls after the open can get a pre-open response up to about 6 minutes old.

**Files:**
- Commit 1: `api/periscope-map.ts` (`:219`) and `api/__tests__/periscope-map.test.ts`
- Commit 2: `api/periscope-exposure.ts` (`:113-119`), `api/periscope-strikes.ts` (`:135-139`), `api/__tests__/periscope-exposure.test.ts`, `api/__tests__/periscope-strikes.test.ts`

**Rule.** The same rule as Task 18, applied on each success path:
- A live (non-historical) read gets `setCacheHeaders(res, 10, 0)` when its response carries data, or when `marketOpen`.
- Otherwise it gets `setCacheHeaders(res, 300, 60)`.
- A historical or scrubbed read keeps `setCacheHeaders(res, 300, 60)` (exposure and strikes already split on `isHistoricalRead`; map's scrub path follows the same rule).
- An error response sets no cache header.

Move each call from before the queries to the point where the response kind is known.

**Tests:** in each endpoint's test, where `setCacheHeaders` is already mocked, assert the exact arguments for these cases:
- live with data, in session and pre-open;
- live with no data, in session and closed;
- historical;
- a DB error (no call).

Commits: `perf(periscope): Cache the live Periscope map for 10 seconds, not up to a minute`, then `perf(periscope): Cache live Periscope exposure and strikes for 10 seconds, not up to a minute`.

### Task 19: GEX landscape shows a stale feed (site 96)

**Files:**
- Modify: `src/components/GexLandscape/index.tsx` (`GEX_STALE_THRESHOLD_MS = 3 * 60_000`, local, with the reason from Thresholds in a comment), `src/components/ScrubControls.tsx` (site 96)
- Test: `src/__tests__/components/GexLandscape.test.tsx`, `src/__tests__/components/GexLandscape-HeaderControls.test.tsx`

**Behavior:**
- **When it applies.** Freshness is computed only when `isLive` (the existing `scrubTimestamp == null && marketOpen`, where `marketOpen` is the panel prop) and `freshness?.serverMarketOpen` are both true. Otherwise `lastDataAgeMs` is null.
  - At the open, the pre-open responses that carry data are cached for only 10 s once Task 18 lands, so the first poll after 9:30 ET gets a fresh session response. The `serverMarketOpen` gate still keeps DELAYED off any pre-open response that slips through. The panel doesn't poll before the open anyway, because `isLive` needs the prop `marketOpen`.
- **Age.**
  - With data: `dataAgeMsAtReceipt + (now − receivedAt)`.
  - On `no_slot`: now minus the last entry of `liveTimestamps`, when there is one. This one case uses the client clock against minute-truncated stamps. The panel is already abnormal there, and the error runs toward DELAYED.
  - A clock state ticks every 15 s, only while freshness applies, so the age grows between polls. The effect returns its cleanup and stops when the panel is scrubbed, the market closes, or the panel unmounts (R1).
- **Badge.** Pass `lastDataAgeMs` and `staleThresholdMs={GEX_STALE_THRESHOLD_MS}` to `ScrubControls`.
- **Empty-state message.** It changes only while freshness applies and the response is `no_slot`. Format the time with the existing `formatTimeCT` in `src/utils/component-formatters.ts`.
  - If the last `liveTimestamps` entry is at least `GEX_STALE_THRESHOLD_MS` old, it reads `` `Feed stalled: last capture ${formatTimeCT(last)} CT` ``.
  - Otherwise one GEX panel (charm or vanna) is missing while gamma keeps landing, and it reads `Some GEX panels have no capture in the last 5 minutes`.
  - Every other empty case keeps `No strike data available`: scrubbed, closed, `no_spot`, or no captures today.
- **Site 96:** the DELAYED badge's hint and corrected title.

**Tests:**
- **`GexLandscape-HeaderControls.test.tsx`:** pin the exact boundary on `ScrubControls`. `lastDataAgeMs` 179_999 shows LIVE; 180_000 shows `DELAYED 3m` with site 96's hint and title. Pass `staleThresholdMs={180_000}`.
- **`GexLandscape.test.tsx`, fake timers, phases aligned to the 15 s tick:**
  - A response with data 2 min 45 s old shows LIVE. Advance 15 s and it shows `DELAYED 3m`, with no new response.
  - A `no_slot` response with the last capture 6 minutes old shows the stall message and DELAYED.
  - A `no_slot` response with the last capture 1 minute old shows the some-panels message and LIVE.
  - `serverMarketOpen: false`, a closed market or a scrubbed panel each show no DELAYED, and the generic empty text.
  - Leaving a scrub never shows the scrubbed response's age.
  - The interval is cleared on unmount and when the panel is scrubbed. Spy on `clearInterval`.

Commit: `fix(gex): Show DELAYED and a stalled-feed message when the landscape data goes stale`.

### Task 20: Source guard

**Files:**
- Create: `src/__tests__/helpers/title-hint-scan.ts`, `src/__tests__/no-title-only-generic.test.ts`
- Reuse: `GENERIC_TAGS` and `countsAsNoRole` from `src/__tests__/helpers/aria.ts`, and the file walk in `no-generic-aria-name.test.ts`. If both tests need the walk, extract it to a shared helper; that is at most two more files.

**Interfaces:**
- Produces: `findTitleOnlyGenerics(fileName: string, source: string): { line: number; tag: string; title: string }[]`. `title` is the title initializer's source text, whitespace-collapsed.

- [ ] Write the detector's fixture tests first, on inline source strings.
  - Flagged:
    - `<span title="x">a</span>`
    - `<div title={t}>{v}</div>`
    - `<span title="x" role="">a</span>`
    - `<StatusBadge label="A" title="x" />` (no `srHint`)
  - Not flagged:
    - `<span title="x">a<SrHint>y</SrHint></span>`
    - `<span title="x">a{c && <SrHint>y</SrHint>}</span>`
    - `<span title="x">a{c ? <SrHint>y</SrHint> : null}</span>`
    - `<span role="img" aria-label="x" title="x">↑</span>`
    - `<button title="x" />`
    - `<span title="ab">ab</span>` (a string-literal title equal to the element's only text child)
    - `<span {...p} title="x">a</span>` (a spread may carry a role)
    - `<StatusBadge title="x" srHint="y" />`
- [ ] Implement it with `ts.createSourceFile(..., ScriptKind.TSX)`. An element is flagged when:
  - it is an intrinsic tag in `GENERIC_TAGS`;
  - it has a `title` attribute;
  - it has no role, or a role `countsAsNoRole` accepts;
  - it has no spread;
  - none of its direct JSX children is an `SrHint` element, or a `&&` or conditional expression that yields one;
  - and it is not a string-literal title equal to its only text child.

  `<StatusBadge>` is flagged when it has `title` and no `srHint`. It is the one component whose `title` the scan can see. Other components' `title` props are a documented blind spot.
- [ ] Add the repo scan. It covers the same files as `no-generic-aria-name.test.ts` and checks the result against an `EXEMPTIONS` list of `{ file, title, reason }`.
  - Give the scan test a 60 s timeout, with a comment saying why. A whole-tree compiler parse timed out at the default 15 s under machine load in `api/__tests__/no-session-set.test.ts`.
  - Entries are keyed by file and title text, so a line move doesn't break them.
  - It fails on any hit not in the list. The message names `file:line tag title` and the fix ("add `<SrHint>`, or a role for a glyph; see `src/components/ui/SrHint.tsx`").
  - It also fails on any exemption that matches nothing (stale).
  - The list holds exactly the 16 K sites:
    - the 12 ticker-group chips (the two `best peak` titles in each file share a key, so match them by count);
    - the 2 expiry chips;
    - `Verdict.tsx:148`;
    - `Tracker/ContractRow.tsx:181`, whose title equals its visible text. The title is an expression, so the literal rule can't see that.
- [ ] Run it. It passes on the branch after Tasks 0–19, and fails when one fixed site's hint is removed. Check that by hand, then revert.
- [ ] `npm run review` green, then commit: `test(a11y): Fail when a plain element explains itself only in hover text`.

## Open questions

None. My default calls:

- **The scan covers generic tags only.** `<td title>`, `<li title>` and other named-role elements with a hover-only title are out of scope, the same boundary as the `aria-label` guard.
- **Hint placement in the stale strip (site 78)** is after the Retry button, not inside the label span. Moving the `title` would change where the tooltip appears on hover.
- **The ticker-group "best peak" caution stays mouse-only.** Its title is the only exempt one with a warning ("look-ahead reference, not tradeable"). The button has 3–4 characters of room, so adding it would mean trimming another hint. Leave it until the owner asks.

## Notes for the owner (found, not changed)

- **The futures volume level is color-only for sighted users too.** Site 84 gives screen readers the word. Showing `HEAVY`/`ELEVATED` on screen would be a visible change, so it is not in this plan.
