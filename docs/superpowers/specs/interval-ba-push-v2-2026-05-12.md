# Interval B/A Web Push — v2 (Phase 4)

**Created:** 2026-05-12 (evening, market closed)
**Parent spec:** [interval-ba-ask-alert-2026-05-12.md](./interval-ba-ask-alert-2026-05-12.md) (Phase 4 was listed there as "Audio cue + Web Push background" — v1 shipped audio + a dormant SW handler; v2 lights up the actual server fan-out).

## Goal

Fire SPXW Interval B/A alerts on the user's device even when the app tab is **closed**, **minimized**, or running as a **backgrounded mobile PWA** — i.e., scenarios where the Phase 3 in-tab `new Notification(...)` path cannot run because the polling hook isn't running.

The user picked all three target contexts (desktop-tab-closed, mobile PWA, and the already-working desktop-tab-open) in the 2026-05-12 v2 scoping question.

## Architecture

```
uw-stream SPXWIntervalBAHandler emits alert
  → writes row to interval_ba_alerts (existing, Phase 1)
  → POST https://<app>/api/push/notify (NEW, INTERNAL_NOTIFY_SECRET-gated)
      Body: { title, body, tag, requireInteraction }
       ↓
  Vercel /api/push/notify
      → reads ALL rows from push_subscriptions (single owner, multi-device)
      → web-push SDK POSTs payload to each subscription endpoint
      → on 410 Gone / 404: deletes that subscription row (clean up dead devices)
       ↓
  Browser push service (FCM / Mozilla / Apple)
       ↓
  Service Worker push event (existing handler from Phase 3, src/sw.ts)
      → self.registration.showNotification(title, options)
```

## Why this split

- **Subscription state is owned by Vercel** because that's where the user grants permission and where the subscription POST naturally lands. Subscriptions live in Neon alongside the rest of the user's state.
- **Fan-out is done by Vercel** (not uw-stream) so the `web-push` Node SDK + VAPID private key live in one place. uw-stream stays Python-only and free of crypto code.
- **uw-stream → Vercel HTTPs hop** is the bridge. Shared secret `INTERNAL_NOTIFY_SECRET` gates the endpoint. End-to-end latency is dominated by Neon row insert (~50ms) + Vercel function cold start (~100-300ms) + push service hop (~100-300ms) = 250-650ms typical. Acceptable for an alert use case where the bucket boundary is 5 minutes.

## Phases

### Phase 4a — DB migration + push_subscriptions table

**Files:**

- `api/_lib/db-migrations.ts` — Migration #145 creating `push_subscriptions`
- `api/__tests__/db.test.ts` — update mock id list + SQL call count

```sql
CREATE TABLE push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh_key TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX idx_push_subscriptions_created_at
  ON push_subscriptions (created_at DESC);
```

Note: deliberately NOT keyed by user_id — single-owner app. Multiple rows = multiple devices for the same owner. `endpoint` is unique so the same device re-subscribing UPSERTs cleanly.

A previous push_subscriptions table existed (#78) and was dropped in #115 when the FuturesGammaPlaybook feature was removed. This is a fresh table with a different schema (no `user_id`, different index strategy).

**Verification:** `npm run test:run -- db.test`, expect counts bumped by 3 (CREATE TABLE + 1 INDEX + INSERT into schema_migrations).

### Phase 4b — VAPID config + push helper

**Files:**

- `package.json` — add `web-push` dependency
- `api/_lib/push.ts` (NEW) — `sendPushToOwner(payload): Promise<{sent, expired}>` wraps `web-push.sendNotification`, handles 410 Gone (deletes the dead subscription row), retries 500 once
- `api/__tests__/push.test.ts` (NEW) — mocks `web-push` + DB, covers happy path / 410 cleanup / multi-device fan-out

**New env vars** (Vercel + Railway):

- `VAPID_PUBLIC_KEY` — generated via `npx web-push generate-vapid-keys`
- `VAPID_PRIVATE_KEY` — same generation step
- `VAPID_SUBJECT` — `mailto:jerseyse410@gmail.com`
- `INTERNAL_NOTIFY_SECRET` — random 32-byte token shared between uw-stream and Vercel
- `VITE_VAPID_PUBLIC_KEY` — same value as VAPID_PUBLIC_KEY, exposed to the client bundle for `pushManager.subscribe()`

### Phase 4c — Subscribe / unsubscribe / notify endpoints

**Files:**

- `api/push/subscribe.ts` (NEW) — POST, owner-only via `guardOwnerEndpoint`. Body: `{ endpoint, keys: { p256dh, auth }, user_agent? }`. UPSERTs on endpoint. Zod-validated.
- `api/push/unsubscribe.ts` (NEW) — POST, owner-only. Body: `{ endpoint }`. DELETE by endpoint. Idempotent.
- `api/push/notify.ts` (NEW) — POST, gated by `x-internal-notify-secret` header constant-time comparison vs `INTERNAL_NOTIFY_SECRET`. Body: `{ title, body, tag?, requireInteraction?, url? }`. Fans out via `sendPushToOwner`.
- `api/__tests__/push-endpoints.test.ts` (NEW) — auth gate, validation, upsert, delete, notify fan-out, secret header rejection.
- `src/main.tsx` — add `/api/push/subscribe`, `/api/push/unsubscribe` to botid `protect` array. NOT `/api/push/notify` — that's internal, not bot-facing.
- `api/_lib/validation/common.ts` — add `pushSubscribeSchema`, `pushUnsubscribeSchema`, `pushNotifySchema`.

**Security:**

- `notify` endpoint uses `crypto.timingSafeEqual` comparing the bearer header to `INTERNAL_NOTIFY_SECRET`. Constant-time prevents timing side-channels.
- Rate-limit `notify` at the Vercel function level (10 req/sec/IP via @upstash/ratelimit if available, else skip — uw-stream is the only legit caller).

### Phase 4d — uw-stream notifier

**Files:**

- `uw-stream/src/notify.py` (NEW) — `async notify_alert(payload: dict)` using `httpx.AsyncClient`. Fire-and-forget (logs Sentry on failure but doesn't block). 2-second timeout.
- `uw-stream/src/handlers/interval_ba.py` — after successful DB write in `_flush`, schedule `notify_alert` for each row in the just-flushed batch via `asyncio.create_task`.
- `uw-stream/src/config.py` — add `vercel_notify_url: str = ""`, `internal_notify_secret: str = ""`. Both empty by default → notify is no-op (Phase 4 dormant until env vars are set, mirrors Phase 1's enabled flag).
- `uw-stream/tests/test_notify.py` (NEW) — mock httpx, verify payload shape + secret header + URL.
- `uw-stream/requirements.txt` — `httpx` is likely already present; verify.

**Notify payload shape** (matches `pushNotifySchema`):

```python
{
  "title": "SPXW 7360C 71% ASK",
  "body": "$1.33M premium / 5 trades — top: $408K sweep",
  "tag": "interval-ba-{id}",
  "requireInteraction": severity != "warning",
  "url": "/"  # optional click-to-focus deep link
}
```

### Phase 4e — Frontend subscription flow

**Files:**

- `src/hooks/usePushSubscription.ts` (NEW) — manages browser push subscription lifecycle:
  - Checks `Notification.permission` + `serviceWorker.ready`
  - On `permission === 'granted'`: calls `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY })`
  - POSTs subscription to `/api/push/subscribe`
  - Returns `{ subscribed, subscribe, unsubscribe }` for UI control
- `src/components/NotificationPermission.tsx` (MODIFIED) — after `requestPermission()` returns 'granted', call the hook's `subscribe()` to wire up Web Push automatically.
- `src/__tests__/usePushSubscription.test.tsx` (NEW) — mocks `navigator.serviceWorker` + `pushManager`, covers grant flow + already-subscribed short-circuit + unsubscribe.
- `vite.config.ts` — ensure `VITE_VAPID_PUBLIC_KEY` is plumbed (Vite picks up `VITE_*` automatically, no config change needed; just env var in `.env.local`).

### Phase 4f — End-to-end verification

After deploying with the new env vars set:

1. Open the app in Chrome (desktop).
2. Grant notification permission via the existing NotificationPermission UI.
3. Verify a row appears in `push_subscriptions`.
4. Manually trigger a notify via curl:
   ```
   curl -X POST https://<app>/api/push/notify \
     -H "x-internal-notify-secret: $INTERNAL_NOTIFY_SECRET" \
     -d '{"title":"Test","body":"v2 push works"}'
   ```
5. Close the tab entirely.
6. Re-trigger curl → desktop OS notification should appear from the SW.
7. Repeat on mobile (install PWA → grant permission → trigger).

## Activation steps (post-Phase-4)

```bash
# Generate VAPID keys once
npx web-push generate-vapid-keys
# →  Public Key: BNxxx...
#    Private Key: yyy...

# Set on Vercel
vercel env add VAPID_PUBLIC_KEY production
vercel env add VAPID_PRIVATE_KEY production
vercel env add VAPID_SUBJECT production  # mailto:jerseyse410@gmail.com
vercel env add INTERNAL_NOTIFY_SECRET production
vercel env add VITE_VAPID_PUBLIC_KEY production  # client-bundle copy

# Set on Railway uw-stream
railway variables set VERCEL_NOTIFY_URL=https://<app>/api/push/notify
railway variables set INTERNAL_NOTIFY_SECRET=<same value>

# Redeploy both. uw-stream picks up new env vars on restart.
# Phase 4 is active.
```

## Open questions

| Q                                                    | Default                                                                                     | Notes                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Multi-device support?                                | **Yes** — table allows multiple subscriptions per owner. Fan-out sends to all.              | Useful if user has the PWA on phone + desktop  |
| iOS Safari support?                                  | Requires PWA install (add to home screen) + iOS 16.4+.                                      | User has the PWA installed per memory          |
| Click-to-focus URL?                                  | `/` (root). Future: deep link to the specific alert.                                        | v2 ships generic                               |
| Rate limit on `notify`?                              | Not in v2. uw-stream is the only legit caller; bot floods just hit secret-header rejection. | Add @upstash/ratelimit in v3 if abuse surfaces |
| Should ack endpoint also fire push to other devices? | **No** — ack is per-device dismissal. Other devices keep showing it until acked locally.    | Could add a "broadcast ack" channel in v3      |
| Email/SMS fallback?                                  | **No** — user explicitly said Web Push only in 2026-05-12 scoping                           |                                                |

## Files (final tally)

**New (10):**

- `api/_lib/push.ts`
- `api/__tests__/push.test.ts`
- `api/push/subscribe.ts`
- `api/push/unsubscribe.ts`
- `api/push/notify.ts`
- `api/__tests__/push-endpoints.test.ts`
- `uw-stream/src/notify.py`
- `uw-stream/tests/test_notify.py`
- `src/hooks/usePushSubscription.ts`
- `src/__tests__/usePushSubscription.test.tsx`

**Modified (8):**

- `api/_lib/db-migrations.ts` (#145)
- `api/__tests__/db.test.ts`
- `api/_lib/validation/common.ts` (push schemas)
- `package.json` (web-push dep)
- `uw-stream/src/config.py` (new env vars)
- `uw-stream/src/handlers/interval_ba.py` (call notify post-flush)
- `src/components/NotificationPermission.tsx`
- `src/main.tsx` (botid protect entries)

Spec total: ~18 file touches. Sub-phases of 5 files max each.
