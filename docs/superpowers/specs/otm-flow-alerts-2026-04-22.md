# OTM SPXW Flow Alerts — Live + Backtest Viewer

**Date:** 2026-04-22
**Author:** charlesobrien (Claude-assisted)

## Goal

A scrolling dashboard card showing SPXW option flow alerts where premium on a **far-OTM strike** is heavily lifted at the ask (bullish loading) or hit at the bid (bearish unloading). Rolling 30-minute window in live mode with polling + toast + browser notification + optional audio ping. Historical mode with date + time picker for post-hoc backtesting of what the tape looked like at a past moment.

## Why this is small

The ingest half is already running:

- `api/cron/fetch-flow-alerts.ts` polls UW `/option-trades/flow-alerts` every minute for SPXW 0-1 DTE.
- `api/_lib/db-migrations.ts` migration #59 created `flow_alerts` with pre-computed `is_itm`, `ask_side_ratio`, `bid_side_ratio`, `distance_pct`, `moneyness`, `dte_at_alert`.
- `idx_flow_alerts_created_at` (DESC) already covers 30-min window queries; no new index needed.

So this is **one read endpoint + one polling hook + one component + wiring**. No UW plumbing, no new table.

## Design decisions (defaults, all adjustable in the UI)

| Control              | Default        | Range             | Notes                                             |
| -------------------- | -------------- | ----------------- | ------------------------------------------------- | ------------ | ---------------------------- |
| Heavy-side threshold | 0.60           | 0.50 – 0.90       | `ask_side_ratio ≥ T` OR `bid_side_ratio ≥ T`      |
| Far-OTM threshold    | 0.50 %         | 0.10 – 2.00 %     | `                                                 | distance_pct | ≥ T` — filters out ATM churn |
| Min premium          | $50K           | $10K – $500K      | `total_premium ≥ T` — ignore noise                |
| Sides shown          | Both           | Ask / Bid / Both  | `ask_side_ratio` vs `bid_side_ratio` gate         |
| Lookback (live)      | 30 min         | fixed             | User's requirement                                |
| Audio ping           | ON             | toggle            | Web Audio API (match existing `useAlertPolling`)  |
| Browser notification | requested once | toggle            | `Notification.requestPermission()` on first mount |
| Mode                 | Live           | Live / Historical | Historical = one-shot fetch at date + time        |

**"Heavy" label semantics** (combines `type` + dominant side):

- Call + ask-heavy → "Bullish load" (green)
- Put + ask-heavy → "Bearish hedge / short delta" (red)
- Call + bid-heavy → "Call unwind" (orange)
- Put + bid-heavy → "Put unwind / bullish" (blue)

## Files

### New

1. `api/options-flow/otm-heavy.ts` — read endpoint, mirrors `whale-positioning.ts`
2. `api/__tests__/otm-heavy.test.ts`
3. `src/hooks/useOtmFlowAlerts.ts` — polling + dedup + notification trigger
4. `src/components/OtmFlowAlerts/OtmFlowAlerts.tsx` — main component
5. `src/components/OtmFlowAlerts/OtmFlowControls.tsx` — sliders, toggles, date/time picker
6. `src/components/OtmFlowAlerts/OtmFlowRow.tsx` — single alert row
7. `src/components/OtmFlowAlerts/useOtmFlowSettings.ts` — localStorage-backed settings
8. `src/__tests__/useOtmFlowAlerts.test.tsx`
9. `src/__tests__/OtmFlowAlerts.test.tsx`
10. `src/types/otm-flow.ts` — shared `OtmFlowAlert` type

### Modified

11. `api/_lib/validation.ts` — add `otmHeavyQuerySchema` (Zod)
12. `src/App.tsx` — mount the card in the grid

No DB migration. No cron changes. No UW changes. `vercel.json` unchanged (read endpoint, not a cron).

## API contract

```
GET /api/options-flow/otm-heavy
  ?window_minutes=30        enum [5, 15, 30, 60], default 30
  &min_ask_ratio=0.60       number 0.5–0.9 (either-or with min_bid_ratio)
  &min_bid_ratio=0.60
  &min_distance_pct=0.005   number 0.001–0.02 (absolute value)
  &min_premium=50000        int ≥ 10000
  &sides=both               enum [ask, bid, both]
  &type=both                enum [call, put, both]
  &date=YYYY-MM-DD          optional, historical mode
  &as_of=ISO-8601           optional, requires date, historical mode
  &limit=100                int 1–200, default 100

Response 200:
{
  alerts: OtmFlowAlert[],        // newest first
  alert_count: number,
  last_updated: string | null,   // max(created_at) ISO
  window_minutes: number,
  mode: 'live' | 'historical',
  thresholds: { ask, bid, distance_pct, premium }
}
```

SQL (tagged template, filters at DB):

```sql
SELECT id, option_chain, strike, type, created_at, price, underlying_price,
       total_premium, total_size, volume, open_interest, volume_oi_ratio,
       ask_side_ratio, bid_side_ratio, distance_pct, moneyness,
       dte_at_alert, has_sweep, has_multileg, alert_rule
FROM flow_alerts
WHERE ticker = 'SPXW'
  AND created_at >= ${windowStart}
  AND created_at <= ${windowEnd}
  AND is_itm = false
  AND ABS(distance_pct) >= ${minDistancePct}
  AND total_premium >= ${minPremium}
  AND (
    (ask_side_ratio >= ${minAskRatio} AND ${wantAsk})
    OR (bid_side_ratio >= ${minBidRatio} AND ${wantBid})
  )
  AND (${type} = 'both' OR type = ${type})
ORDER BY created_at DESC
LIMIT ${limit}
```

Cache headers match `whale-positioning.ts`:

- Live: `Cache-Control: max-age=30, stale-while-revalidate=30`
- Historical: `Cache-Control: max-age=3600, stale-while-revalidate=86400`

## Tasks

### Phase 1 — Backend (read endpoint)

- [ ] **T1.** Add `otmHeavyQuerySchema` to `api/_lib/validation.ts` following the cross-field `as_of requires date` pattern from `spotGexHistoryQuerySchema`.
      → Verify: `npm run lint` clean; schema unit test if one exists for the file.
- [ ] **T2.** Create `api/options-flow/otm-heavy.ts` mirroring `whale-positioning.ts` (bot check, Sentry scope, Zod validation, tagged-template SQL, response envelope, cache headers).
      → Verify: `curl 'http://localhost:3000/api/options-flow/otm-heavy?window_minutes=30' | jq '.alert_count'` returns a number in live dev.
- [ ] **T3.** Add `api/__tests__/otm-heavy.test.ts` — mock `getDb` via `vi.mocked(getDb)`, three cases: live query, historical query, empty result.
      → Verify: `npm run test:run otm-heavy` passes.

### Phase 2 — Frontend hook + settings

- [ ] **T4.** Define `src/types/otm-flow.ts` with `OtmFlowAlert` and `OtmFlowSettings` types.
      → Verify: imported cleanly by endpoint + hook.
- [ ] **T5.** `src/components/OtmFlowAlerts/useOtmFlowSettings.ts` — `useState` + `localStorage` round-trip for `{ minAskRatio, minBidRatio, minDistancePct, minPremium, sides, type, audioOn, notificationsOn, mode, historicalDate, historicalTime }`.
      → Verify: refresh page, settings persist.
- [ ] **T6.** `src/hooks/useOtmFlowAlerts.ts` — polls every 30s in live mode (gated on `marketOpen`), one-shot in historical mode. Uses `AbortController` per fetch. Returns `{ alerts, loading, error, lastUpdated, newlyArrived }` where `newlyArrived` is the diff vs previous poll (keyed on `option_chain + created_at`). Skip polling when tab hidden (`document.visibilitychange`).
      → Verify: unit test confirms dedupe logic; live dev shows network requests every 30s during market hours, stops when tab hidden.

### Phase 3 — Component + toasts + audio + notifications

- [ ] **T7.** `OtmFlowRow.tsx` — single alert row: strike badge, ask/bid% bar, premium, distance from spot, alert-rule pill, CT timestamp. Color code by `type + dominant side` per the table above.
      → Verify: Storybook-free — check via a test fixture rendered in `OtmFlowAlerts.test.tsx`.
- [ ] **T8.** `OtmFlowControls.tsx` — three range sliders (ask/bid threshold, distance %, min premium), audio toggle, notifications toggle, sides/type segmented controls, and a `<LiveHistoricalToggle>` that swaps in a `<input type="date">` + `<select>` for time when in Historical mode. Match `ScrubControls.tsx` idiom (native inputs, uncontrolled date ref for iOS).
      → Verify: dev server — slide thresholds, list filters in real time.
      → **Debounce picker inputs.** `useOtmFlowAlerts`'s `fetchOnce` useCallback re-identifies on every `settings` change, which tears down the polling effect and fires a fresh HTTP request. Without debounce, typing character-by-character into the date picker or dragging a slider would fire one request per keystroke. Debounce `updateSettings` at the control layer (≥200ms) or commit on blur for text inputs. Sliders that emit continuous values should similarly settle before pushing.
- [ ] **T9.** `OtmFlowAlerts.tsx` — ties hook + settings + controls + row list. Fires:
  - Toast (existing `useToast`) on each newly-arrived alert batch (one toast per batch summarising count, not one per row).
  - Audio ping (Web Audio API, borrow sine-wave pattern from `useAlertPolling`) gated by `audioOn`.
  - `Notification` (browser) gated by `notificationsOn` — request permission on first toggle.
    → Verify: dev server — simulate a new alert by inserting a `flow_alerts` row via `psql`; confirm toast + optional ping + optional notification fire.
- [ ] **T10.** Mount `<OtmFlowAlerts />` in `src/App.tsx` inside a new `<SectionCard id="sec-otm-flow" title="OTM Flow Alerts">` collapsible section positioned below the existing whale positioning card.
      → Verify: page renders; collapse/expand works; section persists scroll anchor.
- [ ] **T11.** Add test `src/__tests__/OtmFlowAlerts.test.tsx` — renders with fixture data, toggles audio, switches to historical mode.
      → Verify: `npm run test:run OtmFlowAlerts` passes.

### Phase 4 — Verification

- [ ] **T12.** Run `npm run review` (tsc + eslint + prettier + vitest). Zero errors.
- [ ] **T13.** Manual smoke: market-hours tab, pick far-OTM slider to 1.0%, threshold to 0.7, watch for ~30 min during active tape; verify toasts fire and audio pings (if enabled).
- [ ] **T14.** Historical smoke: flip to Historical mode, pick 2026-04-21 + 10:30 CT, confirm at least one alert row returns.
- [ ] **T15.** Update plan file `[x]` marks as tasks complete; archive plan.

## Done when

- [ ] `/api/options-flow/otm-heavy` returns filtered alerts in both live and historical modes with correct cache headers.
- [ ] In-app card shows scrolling last-30-min view with user-adjustable thresholds that persist across reloads.
- [ ] Audio ping toggle works. Browser notification toggle works (permission requested on first enable).
- [ ] Historical mode with date + time picker returns correct data for a past session.
- [ ] `npm run review` green.

## Out of scope (call out up front so we don't scope-creep)

- No new DB index — if queries slow under real load, add `(created_at DESC, is_itm, distance_pct)` in a follow-up.
- No multi-ticker — SPXW only, matching the ingest cron.
- No e2e Playwright spec — component is owner-gated dashboard widget, covered by unit tests.
- No Sentry alert rule for unusual bursts — follow-up if we find patterns worth alerting on.
- No ML classifier on "which OTM loads preceded real moves" — that's a Phase 2 research task, not a UI task.

## Open questions

1. **Should the new card participate in the existing `ScrubControls` global historical toggle, or stay independent?** Current plan: independent local picker per user's explicit ask ("time/date picker … in the component"). If you'd rather have a single global time scrubber drive every panel, say so and I'll subscribe to `ScrubControls` instead.
2. **Audio sound.** Web Audio API sine-wave ping (matches `useAlertPolling`), distinguishable from existing alert ping? Or reuse the same tone?
3. **Default position in layout.** Placing below whale positioning — any preference for above the fold instead?
