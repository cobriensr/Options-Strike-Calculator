# Range risk in the analyze prompt: the VIX-implied move, the previous day, and the re-checked Tier 1 text

**Date:** 2026-11-27.

**Status:** owner approved in chat, in three steps:
- **15:11 CT**, "lets do that please": the re-checked Tier 1 text, plus live-context lines for the previous day's range and VIX change.
- **15:17 CT**, "yeah lets do that": test whether the fixed 100-pt flag should scale with VIX.
- **18:15 CT**, "yes": replace the fixed flags with the VIX-implied-move version below, and add the sizing clause.

The second and last spec review is pending.

## Goal

Every live analysis gets two things:
- today's VIX-implied move in points;
- the previous trading day's range and VIX change, put on the same scale.

The prompt's range guidance gets rewritten to use that scale. Fixed-point flags shown not to predict anything once VIX is known are dropped.

## Why

The owner approved re-checked text for the Tier 1 block of `<ml_signal_hierarchy>` (`api/_lib/analyze-prompts.ts`). The evidence is in `docs/tmp/prompt-check-tier1-2026-11-27.md`, section 3. Its one supported rule was range risk: after a 100+ pt day, the next day was 100+ 32% of the time, against 15% otherwise.

A follow-up study (`docs/tmp/prompt-check-range-flag-vix-2026-11-27.md`, 207 day pairs, 2026-01-28 to 11-25) changed that conclusion. The main session recomputed its headline numbers independently.

- **The fixed flags vanish once VIX is known.**
  - 100-pt flag, top VIX third (VIX 18.9–35.9): the next day was 100+ 33% of the time (9/27), against 31% (13/42). Across VIX thirds (Mantel-Haenszel), p = 0.43.
  - 2-pt VIX rise: p = 0.73 in a logistic model with log VIX. 22 of its 25 firings fell in the top VIX third.
- **A fixed 100 pts means different things at different VIX levels.** At VIX 28 a 100-pt day is 0.8× the implied move, about a median day. The fixed flag fired on 11 of the last 20 sessions, while 12 of those 20 ran 100+. So "32%" would understate the current base rate by about half.
- **The scale-free version is suggestive only.** After a day at ≥ 1.25× its implied move, the next day also reached 1.25× 26% of the time (7/27), against 12% (21/180). p = 0.065, q = 0.18, and the effect is absent in the first half of the sample at the 1.0× cut. It is not used as a flag.
- **The live context has no implied move in points before 08:32 CT.** The straddle cone comes from `cone_levels`, which compute-cone writes at 08:32 CT. The VIX levels in the context carry no point value.

## Approaches

1. **Read `outcomes` and compute the implied move from the prior closes (chosen).**
   - `outcomes` holds `settlement` (the 4 pm SPX close), `day_high`, `day_low`, `day_range_pts` and `vix_close` per date. They are written each afternoon at about 15:25 CT.
   - These are the columns the study used, so the numbers match its definitions exactly.
   - All of them are known before the open.
2. **Derive from the SPX candles the context already fetches.** Rejected:
   - `fetchSPXCandles` reads only D's session, from `index_candles_1m`, UW SPY × ratio with a UW fallback (`api/_lib/spx-candles.ts`). It would still need a new query.
   - Its `previousClose` is the first pre-market bar's open.
   - It has no VIX close.
3. **Read `training_features.prev_day_range_pts` / `prev_day_vix_change`.** Rejected:
   - The range column is stale on 14 days (2026-09-22 to 10-01 and 10-09 to 10-16).
   - The VIX column is a different quantity: it uses a snapshot that can sit after 10:00 CT.
4. **Keep the fixed 100-pt / 2-pt flags.** Rejected by the study above.
5. **Use a 1.25× ratio flag.** Rejected: not established (q = 0.18).

## Definitions (must match the study)

Let D = `analysisDate`. P1 = `priorTradingDay(D)` and P2 = `priorTradingDay(P1)`, both from `src/data/marketHours.ts`. √252 is the trading-day annualisation the study used.

- **Today's VIX-implied move:** EM_D = `settlement`(P1) × `vix_close`(P1) / 100 / √252, in points, 1 decimal. Show the 1.0×, 1.25× and 1.5× levels in whole points.
- **Previous day range:** `day_range_pts`(P1), with `day_high` and `day_low`.
- **The previous day's multiple:** (`day_high` − `day_low`)(P1) / EM_P1, 2 decimals, where EM_P1 = `settlement`(P2) × `vix_close`(P2) / 100 / √252.
  - Use high − low, not the integer `day_range_pts`, to match the study.
- **VIX change (P1, close to close):** `vix_close`(P1) − `vix_close`(P2), signed, 2 decimals, plus the percent change, signed, 1 decimal.
- **No flags and no thresholds in the code.** The base rates live in the prompt text only (cached, one place), not in the context line, so they can't drift apart.

**Worked example.** D = 2026-11-27. Thanksgiving (11-26) was closed, so P1 = 11-25 and P2 = 11-24.

| Input | Value |
| --- | --- |
| 11-25 close | 7182.73 |
| 11-25 VIX close | 28.29 |
| 11-25 high / low | 7199.31 / 6970.11 |
| 11-25 range | 229 pts |
| 11-24 close | 7202.45 |
| 11-24 VIX close | 26.36 |

- EM_D = 7182.73 × 28.29 / 100 / √252 = **128.0** pts. The levels are 128 / 160 / 192.
- EM_P1 = 7202.45 × 26.36 / 100 / √252 = 119.6 pts. The multiple = 229.20 / 119.6 = **1.92×**.
- VIX change = **+1.93** (+7.3%).

## Behaviour

- **One query** for exactly the two dates: `SELECT date, settlement, day_high, day_low, day_range_pts, vix_close FROM outcomes WHERE date IN (P1, P2)`.
  - It never reads `date >= D`, so a back-dated analysis can't see its own day.
- **No fallback to an older row.** Otherwise a gap in `outcomes` (from a lapsed Schwab login, for example) would show an older day as "yesterday". Each line degrades on its own:
  - **Today's implied move** needs `settlement` and `vix_close` on P1. Without them it says it's unavailable and names the date.
  - **Previous day range** needs the P1 row with `day_range_pts`, `day_high` and `day_low` non-null. Without them it says it's unavailable. The multiple also needs `settlement` and `vix_close` on P2; without them, the range prints with no multiple.
  - **VIX change** needs `vix_close` on both P1 and P2. Without them it says it's unavailable.
  - Never print "NaN" or "Infinity". Guard against a zero or negative close or VIX, and treat it as unavailable.
  - **No P1 row at all,** whether the query returned zero rows or only P2, means nothing for today is knowable. The fetcher then returns null, so the section is listed under Data Sources Unavailable. That case is common: on 2026-09-21..30, 10-08..15 and 11-18 the P1 row was only backfilled later.
- **Half days.**
  - When D is a half day (`isHalfDay(D)`), add: "Today is a half day (close 12:00 CT); the prompt's base rates come from full sessions and overstate today's range." Take the close hour from `getEarlyCloseHourET(D)` and convert it to CT, not a hard-coded 12:00.
  - When P1 was a half day, the range line says so.
- **Errors.**
  - A DB error drops the section, and the analysis still runs. It follows the neighbouring fetchers: `logger.error`, `Sentry.captureException`, and their metrics call.
  - Compute P1 and P2 **inside** the fetcher's try. `priorTradingDay` throws on input that isn't YYYY-MM-DD, and `context.selectedDate` isn't pattern-checked.
  - A null result adds the section to the "Data Sources Unavailable" list, as every other fetcher's null does.
- **Types.** Neon returns NUMERIC as strings and DATE as `Date`. Parse with `Number.parseFloat`, and match rows to P1/P2 by their `YYYY-MM-DD` date (`toIsoDate`-style, UTC), not by row order.
- **Not added: a flow-agreement count.** The approved text says not to rate confidence or size on it.

## Output sketch

The exact wording is the builder's, within these facts. Keep the labels "VIX-implied move", "Previous day range" and "VIX change", so the model links them to the prompt text.

The section title must contain "Previous Session", because the prompt text points at it by that name. Its entry in the Data Sources Unavailable list is "Previous Session (outcomes)".

```
## Previous Session and Implied Move (from outcomes)
Today's VIX-implied move: 128.0 pts (SPX close 7182.73 × VIX 28.29 / 100 / √252, 2026-11-25). Session high-to-low range at 1.0× = 128, 1.25× = 160, 1.5× = 192 pts (whole range, not distance from the open).
Previous day range (2026-11-25): 229 pts (high 7199.31, low 6970.11) = 1.92× that day's implied move (119.6 pts).
VIX change (2026-11-25, close to close): +1.93 (26.36 → 28.29), +7.3%.
Today is a half day (close 12:00 CT); the prompt's base rates come from full sessions and overstate today's range.
```

## Placement

This goes in the user-message context, outside the cached system block.
- A new fetcher in `api/_lib/analyze-context-fetchers.ts` joins the **second** `Promise.all` in `api/_lib/analyze-context.ts` (~:326, the single-source fan-out).
  - Not the first one (~:261). Its order-sensitive `mockResolvedValueOnce` chains in `analyze-context.test.ts` (vol_realized → cone_levels → pre_market_data) would shift.
- The formatter goes in `api/_lib/analyze-context-formatters.ts`.
- The section sits next to the SPX candles and overnight-gap sections. The analyze-prompt-reviewer settles the exact position.

## Prompt text change (`api/_lib/analyze-prompts.ts`)

### In `<ml_signal_hierarchy>`

**Replace** three things with the text below, verbatim:
- the intro line ("Backtested feature importance analysis (39 trading days) reveals two tiers…");
- the `TIER 1 — …` header;
- its four bullets.

The text is owner-approved, with the range bullet as approved at 18:15 CT:

> Re-checked 2026-11-27. Structure-correctness labels: 52 days (2026-01-02 to 04-20), only 3 wrong. Range data: about 210 days to 2026-11-25. No signal below has been shown to predict structure correctness; the only supported effect is range risk.
>
> What the data supports:
> - Range risk: judge it in multiples of today's VIX-implied move (in the Previous Session section), not in fixed points; 100 pts is about 1.5× the implied move at VIX 15 but 0.8× at VIX 28. These multiples measure the session's whole high-to-low range, not how far price travels from the open toward one short strike. Over 207 sessions (2026-01-28 to 11-25) the median day's range was 0.79× its implied move; 27% reached 1.0×, 13.5% reached 1.25× (about 12% when the prior VIX close was below 19, 17% above it) and 6.8% reached 1.5×. Once VIX is known, a 100+ pt previous day and a 2+ pt VIX rise add nothing measurable; don't treat either as a flag.
>
> Context only (no demonstrated edge):
> - Gamma asymmetry: its link to structure errors rests on one wrong day of 21 (2026-03-23) and shows nothing on 41 days. Don't lower confidence on the skew alone.
> - GEX volume: no test supports it as a correctness predictor, and it adds nothing to OI gamma for range. A sign mismatch with OI gamma went with somewhat wider days (85 vs 74 pts, not adjusted for VIX); a mild flag only.
> - Flow agreement count (how many of the flow sources agree): it hasn't been shown to predict correctness or direction. Don't rate confidence or size on the count.

**Then:**
- **Rename** the Tier 2 header to `Other signals (untested or context-only):`. Its two bullets stay.
- **Delete** "When Tier 1 signals conflict with Tier 2, trust Tier 1." The tiers no longer exist.

### In `<ml_calibration>`

Extend the line that says not to size on confidence alone so it ends:

> Do not size on confidence alone: the confidence label caps size per `<sizing_tiers>`, but does not raise it on its own.

Make it one line, not a new bullet. Write the tag bare (`<sizing_tiers>`), as the rest of the prompt does.

This replaces the 18:15 CT wording ("Sizing follows `<sizing_tiers>`, which also requires the primary signals to agree; the confidence label by itself doesn't change size"). Review round 2 found that wording contradicts four rules that stay:
- the tier definitions (`:584-586`);
- the CONFIDENCE FLOOR (`:591`);
- self_validation #6, which caps Entry 1 size by stated confidence (`:1445`);
- the MINIMUM tier, which doesn't require the signals to agree.

**Owner approved the corrected wording (22:24 CT, "yes").**

### Flow-agreement entry gates (owner approved, 22:24 CT)

- **Backwardation** (~:823): delete the sentence "Require flow agreement ≥ 7/9 before entering any structure." Keep "Widen IC strikes by 5-10 pts or avoid IC entirely."
- **ZN flight-to-safety** (~:833-834): "Require HIGH confidence + ≥ 7/9 agreement to enter, or SIT OUT." becomes "Require HIGH confidence to enter, or SIT OUT."
- **Not approved:** the `:1144` directional check ("Market Tide + at least 2 of …"). Leave it as is.
- Pin all three with tests: both gates no longer mention "7/9", and `:1144` is unchanged.

### Other references to the hierarchy

- **`api/__tests__/analyze-prompts.test.ts`:**
  - Invert the "trust Tier 1" assertion (~:692-694).
  - Update the `<ml_calibration>` exact-text test (it pins the block's lines) to include the clause.
- **`api/_lib/plot-analysis-prompts.ts`:** the plot-analysis reviewer prompts take the old hierarchy as correct at ~:970, ~:984, ~:1054 and ~:1117. Examples: "gamma_asymmetry and gex_vol should be near the top if the hierarchy is correct", and "implemented as a Tier 1 signal in the live prompt".
  - D rewrites each line to ask whether the plot supports the claim, without presuming the hierarchy.
  - At ~:970, the "do wide-range days follow wide-range days?" prompt should also ask whether the effect survives once VIX is known.
  - Pin them with a test.
- **Afterwards,** grep `api/`, `src/` and the tests for "Tier 1", "Tier 2" and "TIER" again. Report any further hit; don't edit it.

## Commits

These go on a fresh branch off origin/main, `fix/analyze-range-implied-move`. It's checked out in the existing `.worktrees/analyze-prompt-checks` worktree, whose old branch is fully on main as 907cda31f..3402710eb, so `node_modules` is already installed.

Order E1 → E2 → D, so every commit is shippable on its own.
- **E1:** the fetcher and formatter, plus their tests (4 files). Commit the spec with E1 (5 files).
- **E2:** the wiring in `analyze-context.ts`, plus its test (2 files).
- **D:** the prompt text, in `analyze-prompts.ts` and `plot-analysis-prompts.ts` plus their tests (4 files).
- **Any owner-approved change to the flow-agreement gates** goes into D (same files). **A change to the gamma-asymmetry label** (`db-strike-formatters.ts` plus its test) is its own commit F.

They push together. The analyze-prompt-reviewer and the code-reviewer run on the three commits.

## Tests

- **Formatter (table):**
  - the worked example, exact line text;
  - a day with VIX falling (negative change and percent, with signs);
  - P1 missing, or zero rows (the fetcher returns null);
  - P2 missing (implied move and range still shown, the range with no multiple, VIX change unavailable);
  - the levels line says "whole range, not distance from the open";
  - `settlement` or `vix_close` NULL on P1, and separately on P2;
  - a NULL `day_range_pts`, `day_high` or `day_low`;
  - a zero or negative close or VIX (unavailable, no NaN or Infinity);
  - P1 a half day;
  - D a half day, with the close hour taken from the calendar;
  - D a normal day, with no half-day line.
- **Fetcher:**
  - D = 2026-11-27 queries exactly 2026-11-25 and 2026-11-24, across Thanksgiving.
  - Rows arrive as NUMERIC strings and `Date` objects, in either order.
  - A DB reject returns null and calls `Sentry.captureException`.
  - A malformed `selectedDate` (`''`, `'2026-13-40'`) returns null without throwing.
- **Context:**
  - The section appears when the fetcher returns text.
  - When the fetcher returns null, the section is absent and is listed under Data Sources Unavailable.
- **Prompt:**
  - The new hierarchy text and the sizing clause are present.
  - "validated by both statistical correlation and ML model gain", "captured by ML through non-linear interactions", "trust Tier 1", "32%" and "36% vs 16%" are absent from the hierarchy.
  - The renamed header is present.
  - The plot-analysis lines are pinned.

## Push

The commits touch only `api/`, so this deploys to Vercel only and touches no Railway watch path. Push after the close or overnight before the open.

## Open

**For the owner.** Nothing left: the flow-agreement gates are settled above, and the gamma label below.

**Gamma-asymmetry label: owner approved, 23:03 CT ("your recommendations are fine").** In `api/_lib/db-strike-formatters.ts` `formatStrikeExposuresForClaude` (~:178-184), keep the percentages and the `SKEWED ABOVE — gamma concentrated above price.` / `SKEWED BELOW — gamma concentrated below price.` / `BALANCED — …` labels, and delete only the sentences "Upside is well-defended; downside is exposed." and "Downside is well-defended; upside is exposed."
- This is commit **F**: that file plus `api/__tests__/db-strike-helpers.test.ts`.
- Pin the two skewed labels and BALANCED, the absence of "well-defended" and "exposed", and the 65% boundary.
- Untouched and untested: `RULE 1: Gamma Asymmetry Overrides Neutral Flow` (`analyze-prompts.ts` ~:613). It is a different measure (a Periscope negative-gamma cliff within 30-40 pts), and no re-check covered it.

The original question, kept for the record:
1. **The gamma-asymmetry label** in the live context (`api/_lib/db-strike-formatters.ts:179-183`) reads "Upside is well-defended; downside is exposed". The re-check found the "defended side" reading unsupported (p = 0.30).

**For the builder:** the section title and its position. The analyze-prompt-reviewer checks them.

**Not in scope:** a 5-session mean of the implied-move multiple looked stronger in the study (27.5% vs 6.8%), but that test was chosen after seeing the data. It needs its own pre-declared check. It overlaps with the unwired 5-day RV question (memory `rv-prior-days-unwired`).

**Review history:**
- Round 1 (verdict "revise") brought:
  - E split into E1 and E2;
  - D covering the plot-analysis lines;
  - the unavailable-manifest entry;
  - P1/P2 computed inside the try;
  - NULL-column handling;
  - the corrected approach 2.
- After round 1, the owner replaced the fixed flags with the implied-move design and added the sizing clause. That redesign is why this doc gets a second review.
- **Round 2 (verdict "revise"; the last review allowed). Author fixes:**
  - The context line names the levels as whole-range, not distance from the open.
  - No P1 row returns null.
  - The section title must contain "Previous Session".
  - The fetcher goes in the second `Promise.all`.
  - Commits are ordered E1 → E2 → D, and the gamma label is its own commit.
- **Round 2, prompt text corrected and pending the owner's OK:**
  - The sizing clause is reworded so it doesn't contradict self_validation #6.
  - "Whole range, not distance from the open" is added. One side reached 0.625× from the open on 49% of days, so the range rates must not be read as strike distance.
  - 1.4× is corrected to about 1.5×.
  - The VIX-split rates (about 12% / 17%) and the 1.5× rate (6.8%) are added.
  - The no-flag sentence is narrowed to the two fixed flags. It now doesn't contradict the RV/IV rule (`analyze-prompts.ts:1087-1095`, yesterday's Parkinson RV over VIX1D), which stays.
  - The GEX-volume figure is marked "not adjusted for VIX".
  - The flow line is narrowed to the agreement count, so it doesn't contradict the general confluence rules (`:584` FULL "3+ data sources confirm", self_validation #3, `:557`).
- **Left out, author's call:** the Tier 1 re-check's correctness note (3 wrong days, all after a 100+ day, q = 0.054). It rests on 3 events that can't be checked out of sample, and the labels end 04-20.
- **Queued as their own re-checks, not in this work:**
  - the RV/IV > 1.15 sizing rule, together with the unwired 5-day RV;
  - the "SPX Net Flow 31%, 36 sessions" claims (`:154`, `:664`, `:699`, `:1144`);
  - curated lessons that may still teach the old 100-pt / 2-pt flags.

## Addendum (owner approved 23:14 CT): recent-sessions line
The prompt's full-sample base rates can't follow the regime (last 20 sessions to 11-25: 9 of 20 reached 1.25×, vs 13.5% full-sample). The section adds a live line: counts of the last 20 full sessions reaching 1.0×, 1.25× and 1.5× their own VIX-implied move, plus the last-5 average multiple. The fetcher becomes one bounded as-of read (`date < D ORDER BY date DESC LIMIT 30`); P1/P2 are still exact-date lookups with no fallback. Half days are excluded from the window; a session needs its prior trading day's close and VIX. Fewer than 10 usable sessions → "unavailable". The preface says recent sessions above the full-sample rates mean those rates understate the current regime. The cached prompt is unchanged. Reviewed by the code and prompt reviewers with the implementation (the doc's two spec reviews were already used).

Status (2026-11-28): the Addendum supersedes the Behaviour and Tests bullets that describe `WHERE date IN (P1, P2)` and "queries exactly 2026-11-25 and 2026-11-24". Review round 4 also added the "(prior-close VIX)" label, the `high > low` range guard and the preface wording (4 pm ET or 1 pm ET on a half day; "context, not an established predictor"; the regime sentence).

Status (2026-11-28 00:47 CT): the owner approved two clarifying parentheticals in `<ml_signal_hierarchy>`, which are commit H. The gamma bullet now names "the % above/below ATM split in the Per-Strike Greek Profile; Rule 1's negative-gamma cliff is a separate rule". The flow bullet now says the count is "the ML pipeline's count of agreeing flow sources, not shown in this context". They replace the wording quoted in "Prompt text change" above.
