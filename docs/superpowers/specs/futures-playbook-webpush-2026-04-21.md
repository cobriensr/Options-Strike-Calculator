# Phase 2A — Server-Side Web Push Alerts for FuturesGammaPlaybook

**Date:** 2026-04-21
**Status:** Scoped, ready to build
**Scope:** Web Push only. SMS / email deferred.

## Goal

Deliver the five FuturesGammaPlaybook alert types (regime flip, level
approach, level breach, trigger fire, phase transition) to the trader's
phone and laptop even when the browser tab is closed, using free VAPID-
signed Web Push piggybacking on the existing `vite-plugin-pwa` service
worker. Piggyback on the Phase 1E engine — reuse `detectAlertEdges` so
client and server agree on semantics.

## Why Web Push (vs SMS/Email)

- **Free** — no Twilio/Resend fees. VAPID keys are self-generated.
- **Already wired** — `vite-plugin-pwa` is installed and running (`vite.config.ts:28`). Adding a custom SW file is the one change needed.
- **Cross-device** — same code path covers phone (PWA installed) + laptop (browser open or not).
- **iOS support since Safari 16.4** when app is installed as a PWA. Android Chrome works without install.
- **Caveat**: iOS requires the user to add the PWA to the home screen first. Documented in the subscription UI copy.

## Phases

### Phase 2A.1 — Service worker + VAPID infrastructure (~1.5 hrs, 4 files)

Convert `vite-plugin-pwa` from `generateSW` (Workbox-generated, no custom
hooks) to `injectManifest` mode so we can ship a custom `src/sw.ts` with
a `push` event handler. Add `web-push` dep. Scaffold VAPID env vars.

**Create:**

- `src/sw.ts` — custom service worker. Handles `push` event (deserialize
  payload, show notification), `notificationclick` (focus or open the
  app, deep-link to the playbook section), `pushsubscriptionchange`
  (post new subscription to backend). Re-imports Workbox precache
  manifest so existing cache behavior is preserved.

**Modify:**

- `vite.config.ts` — switch to `injectManifest` strategy, point at
  `src/sw.ts`, keep the existing manifest/icons/runtimeCaching config.
- `package.json` — add `web-push` (backend) and
  `@types/web-push` (dev).
- `.env.example` (or `README`) — document the three new env vars:
  `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
  (mailto:address).

**Verify:** `npm run build` produces a service worker that includes the
push handler. `npm run dev` loads without regressing existing
precaching. Generate VAPID keys via `npx web-push generate-vapid-keys`
and add to `.env.local`.

### Phase 2A.2 — Subscription endpoints + table (~1.5 hrs, 5 files)

Three endpoints + a new table for storing the client's push
subscription (endpoint URL, P-256 keys, optional user-agent for device
tagging).

**Create:**

- `api/push/vapid-public-key.ts` — `GET` returning the VAPID public key
  so the frontend can subscribe. Owner-gated.
- `api/push/subscribe.ts` — `POST` accepting the serialized
  `PushSubscription` payload from the browser, upserts into
  `push_subscriptions` table keyed on `endpoint`. Owner-gated.
- `api/push/unsubscribe.ts` — `POST` accepting `{endpoint}`, deletes
  the row. Owner-gated.
- Tests for each endpoint.

**Modify:**

- `api/_lib/db-migrations.ts` — add migration `N + 1` creating
  `push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL,
  auth TEXT NOT NULL, user_agent TEXT, failure_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(), last_delivered_at TIMESTAMPTZ)`.
- `api/_lib/validation.ts` — Zod schemas for subscription payload.
- `src/main.tsx` — add all three new endpoint paths to the `initBotId`
  protect list.
- `api/__tests__/db.test.ts` — update migration mocks + expected output
  + SQL call counts.

**Verify:** `POST /api/journal/init` applies the new migration. Each
endpoint test mocks `getDb` and verifies owner gate + Zod reject +
happy path.

### Phase 2A.3 — Cron engine + delivery (~2 hrs, 5 files)

The server-side equivalent of Phase 1E. A new cron runs every minute
during RTH, reads the latest snapshot state, runs the shared
`detectAlertEdges` engine, writes events to `regime_events` for
history + diagnostics, and pushes via `web-push` to every active
subscription.

**Create:**

- `api/cron/monitor-regime-events.ts` — the cron. Reads latest
  `spot_exposures`, `gex_strike_0dte`, `oi_per_strike` for today's
  trading date. Composes an `AlertState` (regime, phase, levels,
  firedTriggers, esPrice). Compares against the previous snapshot
  stored in a new `regime_monitor_state` table. Calls
  `detectAlertEdges(prev, next, nowIso)` from the shared
  `src/components/FuturesGammaPlaybook/alerts.ts` engine.
  Writes events to `regime_events`. Delivers via `web-push` to every
  row in `push_subscriptions`. Handles 410 Gone responses by
  auto-unsubscribing (delete the row) and 5xx by incrementing
  `failure_count` (auto-remove after 3 consecutive failures).
- `api/_lib/web-push-client.ts` — thin wrapper around `web-push`:
  `sendPushToAll(event: AlertEvent)` iterates `push_subscriptions`,
  calls `webpush.sendNotification(...)` with a 5-sec timeout, handles
  410/5xx gracefully.
- Tests for the cron + web-push wrapper.

**Modify:**

- `api/_lib/db-migrations.ts` — add migration `N + 2` creating
  `regime_events (id SERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL,
  type TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL,
  body TEXT NOT NULL, payload JSONB, delivered_count INTEGER DEFAULT 0)`
  AND `regime_monitor_state (singleton_key TEXT PRIMARY KEY, prev_state
  JSONB, last_run TIMESTAMPTZ)` (only one row ever — `singleton_key =
  'current'`). Using a singleton row for prev-state is simpler than
  inferring from `regime_events` itself and avoids race conditions if
  the cron misses a beat.
- `vercel.json` — register the new cron. Schedule `* 13-21 * * 1-5`
  (every minute during RTH CT on weekdays).
- `api/__tests__/db.test.ts` — two more migrations in the mock
  sequence.

**Verify:** Cron tests mock the DB + `webpush.sendNotification` +
verify edge detection + delivery. Integration check: manually fire
a regime flip scenario in dev, confirm the event appears in
`regime_events` and the mock `sendNotification` was called with
the right payload.

### Phase 2A.4 — Frontend subscription UI + recent events (~1.5 hrs, 4 files)

Give the user a toggle in `AlertConfig` to subscribe/unsubscribe and a
small history list of recent server-fired events. Uses the existing
Phase 1E panel as the host.

**Create:**

- `src/hooks/usePushSubscription.ts` — hook managing the subscription
  lifecycle: checks current registration state, subscribes via
  `ServiceWorkerRegistration.pushManager.subscribe({ userVisibleOnly:
  true, applicationServerKey: vapidPublicKey })`, POSTs to
  `/api/push/subscribe`, and mirrors state. Handles permission
  transitions gracefully (Notification API permission governs both
  Web Push and local notifications — shared concern).
- `src/hooks/useRegimeEventsHistory.ts` — simple polling hook for
  `GET /api/regime-events-recent?limit=20` (new endpoint —
  lightweight, in scope as a small addition to Phase 2A.2 or can
  be rolled here).
- Tests for the hook + component additions.

**Modify:**

- `src/components/FuturesGammaPlaybook/AlertConfig.tsx` — add a new
  section "Push notifications (persistent)". Shows current state
  (Subscribed / Not subscribed / Permission denied), Subscribe /
  Unsubscribe button, iOS PWA-install hint when applicable.
- `src/components/FuturesGammaPlaybook/index.tsx` — render a compact
  "Recent server events" collapsible strip showing the last 20 rows
  from `regime_events` (nice-to-have for validation during live
  use).

**Verify:** `npm run dev`, subscribe, verify row appears in
`push_subscriptions`. Trigger a regime flip in the DB manually,
confirm the browser receives the push notification even with the
tab closed.

## Phase split summary

| Sub-phase | Files created | Files modified | Effort |
|-----------|---------------|----------------|--------|
| 2A.1 | 1 | 3 | 1.5 hrs |
| 2A.2 | 3 endpoints + 3 tests = 6 | 4 | 1.5 hrs |
| 2A.3 | 2 + 2 tests = 4 | 3 | 2 hrs |
| 2A.4 | 2 hooks + 2 tests = 4 | 2 | 1.5 hrs |
| **Total** | **~15 new** | **12 modified** | **~6.5 hrs** |

## Data dependencies

**New tables** (two migrations):

- `push_subscriptions` — one row per device subscription.
- `regime_events` — history of server-detected alert events for
  backtest-style review + debugging.
- `regime_monitor_state` — singleton row holding the previous
  `AlertState` JSON so the cron can compute edges across runs.

**New env vars** (Vercel production + `.env.local`):

- `VAPID_PUBLIC_KEY` — safe to expose to the frontend (served via
  `/api/push/vapid-public-key`).
- `VAPID_PRIVATE_KEY` — **secret**, server-only, used to sign push
  payloads.
- `VAPID_SUBJECT` — `mailto:you@example.com` or a URL; browsers
  require a contact identifier.

**New npm packages:**

- `web-push` (prod) — VAPID signing + push delivery.
- `@types/web-push` (dev).

**New cron schedule:** `* 13-21 * * 1-5` — 1-min cadence during RTH CT
on weekdays. Registered in `vercel.json` alongside existing crons.

## Shared code with Phase 1E

The Phase 1E engine (`src/components/FuturesGammaPlaybook/alerts.ts`)
is pure — no React, no DOM, no timers. The server-side cron imports it
directly via a relative path (the sidecar pattern already establishes
this precedent, though this is a Vercel Function, not sidecar).
Tests must ensure the engine stays Node-compatible (no `window`
references sneak in).

## Open questions (with default picks)

1. **All 5 alert types over Web Push, or a subset?** Default: all 5,
   governed by the existing `AlertConfig` per-type toggles that already
   live in `localStorage`. The server respects a per-subscription
   filter column if it becomes useful — deferred.
2. **Server cooldown vs browser cooldown** — Phase 1E enforces
   90s dedup in the browser. The server should enforce its own
   cooldown independently (if you're subscribed on phone + laptop,
   both shouldn't fire concurrently for the same edge; web-push
   delivery to one subscription at a time is fine). Default: reuse
   the Phase 1E constants, cooldown tracked per (alert type, level
   kind) inside `regime_monitor_state.prev_state.cooldowns`.
3. **Payload size** — web-push payloads are limited to ~4KB. Plenty
   for our event shape. No compression needed.
4. **iOS PWA install prompt** — too intrusive to auto-prompt. Default:
   show a small hint in `AlertConfig` when the user is on iOS Safari
   and hasn't installed the PWA. Text: "Install this app to home
   screen to receive push alerts on iOS."
5. **Notification deep-link** — clicking a notification should open
   the app and focus the FuturesGammaPlaybook section. Default: deep
   link to `/#futures-gamma-playbook` (add `id="futures-gamma-
   playbook"` to the SectionBox wrapper). `notificationclick` handler
   in `sw.ts` uses `clients.openWindow(url)`.
6. **Multi-device cap** — single-owner app; but supporting phone +
   laptop subscription is necessary. Default: allow up to 5
   subscriptions, trimmed oldest-first if exceeded.
7. **Auto-unsubscribe on failure** — Default: 410 Gone (subscription
   invalid) deletes the row immediately; 5xx increments
   `failure_count` and deletes after 3 consecutive failures.
8. **Delivery auditing** — Every send writes `delivered_count` on the
   matching `regime_events` row. Used by `useRegimeEventsHistory` to
   show "delivered to 2 devices" badges.

## Thresholds / constants

```ts
// api/cron/monitor-regime-events.ts
export const MONITOR_CRON_CADENCE_SECONDS = 60;
export const SUBSCRIPTION_FAILURE_LIMIT = 3;
export const MAX_SUBSCRIPTIONS_PER_USER = 5;
export const PUSH_TIMEOUT_MS = 5_000;
export const REGIME_EVENTS_RETENTION_DAYS = 30;

// api/_lib/web-push-client.ts
export const VAPID_SUBJECT_FALLBACK = 'mailto:ops@example.com';
```

## Out of scope (future Phase 2B or later)

- SMS via Twilio (nice fallback when Web Push fails; paid, skip for now).
- Email digest (low-priority fallback).
- Per-alert-type subscription filter (server respects client's
  `AlertConfig` choices implicitly — client can always unsubscribe
  entirely to disable all).
- Multi-user auth / multi-user subscriptions (this is a single-owner
  app by design).
- Backfill of `regime_events` from historical data (doesn't make sense
  — alerts are forward-looking).
- iOS Rich Notifications with custom UI (basic body + title is
  sufficient for trading alerts; actionable buttons can come later).
- Push analytics (open rate, delivery latency) — deferred.

## Verification on completion

1. `npm run review` — zero tsc/eslint/test failures.
2. Generate VAPID keys and add to local `.env`.
3. Run dev server, subscribe via AlertConfig. Verify row in
   `push_subscriptions`.
4. Manually trigger the cron via `curl` with `CRON_SECRET`. Verify the
   event appears in `regime_events` and the browser receives a push
   notification even with the tab backgrounded.
5. On a phone with the PWA installed, confirm the same push arrives.
6. Toggle unsubscribe. Confirm `push_subscriptions` row deleted and no
   further pushes arrive.
7. Clicking a notification focuses the app and scrolls to the
   FuturesGammaPlaybook section.

## Rough total scope

- **4 sub-phases**, ~1.5–2 hrs each.
- **~6.5 hrs total engineering time**.
- **2 new DB tables** + 1 singleton state row.
- **3 new env vars**.
- **1 new cron job** at 1-min RTH cadence.
- **Zero new external subscriptions** (Web Push is free via VAPID).
- **Shared engine** with Phase 1E — no duplication.
