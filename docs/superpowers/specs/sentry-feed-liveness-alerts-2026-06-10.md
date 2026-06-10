# Sentry alert rules: feed liveness + lease loss

**Date:** 2026-06-10
**Why:** The 2026-06-09 uw-stream death was silent for ~18h because no alert rule routed the existing signals to a notification. The code now self-heals (lease ON_FAILURE restart + in-process renewal recovery), but these two issue-alert rules turn a *future* sustained failure into a ~5-minute page instead of a "next-morning discovery." Both signals are already emitted by the code — this is pure Sentry-UI wiring.

## First: confirm the events exist (de-risks setup)
In Sentry → Issues, search each query below over the last 24h. This morning's outage (08:30–10:14 CT) fired the empty-window warning every minute, so it should be present, and the search confirms the right **project** to put the rule in.
- `cron.anomaly:empty-window`
- `component:ws_lease`

uw-stream tags `server_name:uw-stream`; the detect crons run as Vercel functions. They may be in the same Sentry project or two — create each rule in whichever project shows the matching events.

---

## Rule A — "Feed dead: empty scan during market hours"
Signal: `detect-lottery-fires` / `detect-silent-boom` emit `captureMessage(level=warning)` with tag `cron.anomaly=empty-window` once per minute each whenever `ws_option_trades` is dry during market hours (gated on `isPastCashOpen(2)`, so no overnight false alarms).

**Sentry → Alerts → Create Alert → Issues (not Metric).**
- **Environment:** `production`
- **WHEN** (conditions) — match `any`:
  - `The issue is seen more than 3 times in 5 minutes`
    - (Both crons fire it ~1×/min, so 3 hits ≈ a sustained ~1.5–3 min dead feed — rides out a single transient empty poll without paging.)
- **IF** (filters) — match `all`:
  - `The event's tags match cron.anomaly equals empty-window`
- **THEN** (actions):
  - `Send a notification to [your email / SMS / Slack channel]`
- **Action interval (rate limit):** `30 minutes` — page once, not every minute of an outage.
- **Name:** `Feed dead — empty scan during market hours`

## Rule B — "uw-stream ws_lease lost / unreachable"
Signal: `WsLease._fence` emits `capture_message(level=error, tags={component: ws_lease})` for messages `uw-stream ws lease lost`, `uw-stream ws lease renewal unreachable`, and (new) `renewal_error`. This fires the moment a genuine lease loss triggers a self-restart — so you see *why* a restart happened.

**Sentry → Alerts → Create Alert → Issues.**
- **Environment:** `production`
- **WHEN** (conditions) — match `any`:
  - `A new event is captured`
- **IF** (filters) — match `all`:
  - `The event's level equals error`
  - `The event's tags match component equals ws_lease`
- **THEN** (actions):
  - `Send a notification to [your email / SMS / Slack channel]`
- **Action interval:** `30 minutes`
- **Name:** `uw-stream ws_lease lost`

---

## Optional Rule C — restart-storm backstop
`restartPolicyMaxRetries=10`: after 10 rapid non-zero exits Railway stops restarting. Rule B fires on each lease loss, so ≥10 `component:ws_lease` events in a short window = the daemon is wedged and won't self-heal.
- Same as Rule B but **WHEN** `The issue is seen more than 8 times in 15 minutes` → notify with higher urgency (PagerDuty/SMS). Catches the "self-heal exhausted" case the code can't recover from alone.

## Notes
- These are **issue alerts** (event/tag based), not **metric alerts** — the freshness signal lives in log events, not a numeric metric series.
- The true ground-truth metric ("0 rows in `ws_option_trades` for >5 min during market hours") lives in Neon, not Sentry; the empty-window warning is the in-Sentry proxy for it. If you ever want the direct DB check, it'd be a small cron that queries freshness and `captureMessage`s — not needed now that Rule A exists.
