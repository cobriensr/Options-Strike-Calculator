# Schwab re-auth: expiry fix + reminders — 2026-09-29

## Goal

Make the weekly Schwab re-login a ~10-second tap from a phone
notification, and stop the auth path from hammering Schwab and flooding
Sentry when the refresh token dies.

## Background (verified 2026-09-29)

- Schwab's refresh token is valid 7 days **from the original login**;
  refreshing access tokens does not extend it. No official non-interactive
  renewal exists.
- Bug: `api/_lib/schwab.ts:216` sets `refreshExpiresAt = now + 7d` on every
  access-token refresh, so the local expiry guard (`:352`) never trips while
  crons keep refreshing. Timeline: last good refresh ~09-21 15:50 UTC →
  `invalid_grant` for 7 days (the dead token was sent to Schwab ~every cron
  run) → local "Refresh token expired" for 1 day → Redis TTL (`:96`) dropped
  the key → "No tokens found" (~800 Sentry events/day, FG).
- No code marks tokens dead on `invalid_grant`; failures map to 500
  `SCHWAB_TOKEN_ERROR` (`schwab-fetch.ts:40-44`), so the UI Re-auth button
  (shown only on 401, `useMarketData.fetchers.ts:156-184`) never appeared.
- `getStoredTokens` (`schwab.ts:84-90`) turns a Redis read error into
  `null` → "No tokens found" (happened 09-29 15:14–15:15 during an Upstash
  outage while the key still existed).
- Schwab wraps `invalid_grant` inside an outer `unsupported_token_type`
  error body (double-encoded JSON) — classify by substring `invalid_grant`,
  not the outer `error` field.
- Existing building blocks: `sendPushToOwner` (`api/_lib/push.ts:105`),
  `push_subscriptions` table, `/api/push/notify`; `src/sw.ts` handles `push`
  but has no `notificationclick` handler. OAuth `state` is stored in Redis
  (`schwab.ts:454-464`), so `/api/auth/init` works from a phone browser.

## Owner decision

Fix + push reminder + countdown. No automated browser login (violates the
Schwab Online Services Agreement; stores full-account credentials).

## Phases

### A1 — Auth-path correctness (`schwab.ts`, `schwab-fetch.ts`)

- Preserve the stored `refreshExpiresAt` across access-token refreshes; only
  the authorization-code exchange (`:437`) sets it.
- On a 400/401 token-endpoint response whose body contains `invalid_grant`,
  throw a typed error. `getAccessToken` then compare-and-clears: only if the
  stored refresh token still equals the one that failed (don't wipe a
  concurrent fresh re-auth), set `refreshExpiresAt = 0`; emit ONE
  fingerprinted `captureMessage('schwab.auth.refresh_rejected')`; return the
  expired state so callers get 401 `SCHWAB_TOKEN_EXPIRED` (Re-auth button
  shows). Subsequent calls stop at the local guard without calling Schwab.
- `getStoredTokens`: a Redis read error returns a distinct `token_error`,
  not "no tokens".
- Populate `ApiResult.code` (`schwab-fetch.ts:26`).
- Keep the `invalid_grant` matcher narrow (false positive = forced re-auth).
- Tests: expiry preserved across refresh; invalid_grant marks dead + no
  further Schwab calls + exactly one message; compare-and-clear doesn't wipe
  fresh tokens; other 400s / 5xx / timeouts still captured; Redis read
  error → token_error.

### A2 — Quiet crons while logged out

- `fetch-market-internals` and `fetch-outcomes`: when the Schwab result code
  is `SCHWAB_TOKEN_EXPIRED` (tokens absent/expired), return
  `status: 'skipped'` with no exception capture. `token_error`, data-API 401
  (`SCHWAB_API_REJECTED`), 5xx, and network errors stay loud.
- Survey the other Schwab-calling crons (`fetch-strike-iv`,
  `fetch-spx-candles-1m`, `fetch-es-overnight`, `compute-cone`) and apply the
  same rule where they capture/mark error on expiry. Note `fetch-strike-iv`
  reports `'success'` even when all tickers failed — fix to reflect failure
  (non-expiry) honestly.
- Tests: skip path (no capture) + loud paths.

### A3 — Reminder + countdown

- Expose the refresh-token expiry to the owner (extend an existing
  owner-gated auth/status endpoint if one exists, else a small
  `withDbReader`-style owner endpoint; value is non-secret but owner-only).
- Cron `schwab-reauth-reminder` (hourly): if tokens exist and expiry is
  ≤ 24 h away → push once; ≤ 2 h → push once; expired/missing → push once.
  Idempotent per `(threshold, refreshExpiresAt)` via Redis `SET NX` with TTL
  (R6). Push payload: title/body + `url: '/api/auth/init'` +
  `requireInteraction`.
- `src/sw.ts`: carry `payload.url` into the notification `data`; add a
  `notificationclick` handler that focuses/opens that URL.
- UI: expiry countdown badge in the header next to the Re-auth control
  (owner only), turning amber < 24 h and red < 2 h / expired.
- Register cron in `vercel.json` + `api/_lib/cron-schedules.ts`.
- Tests: reminder thresholds + idempotency + no-subscription path + push
  failure surfaces; sw click handler; countdown rendering states.

## Files

- A1: `api/_lib/schwab.ts`, `api/_lib/schwab-fetch.ts`,
  `api/__tests__/schwab*.test.ts`
- A2: `api/cron/fetch-market-internals.ts`, `api/cron/fetch-outcomes.ts`,
  other Schwab crons as surveyed, tests
- A3: `api/cron/schwab-reauth-reminder.ts`, status endpoint, `src/sw.ts`,
  header component + hook, `vercel.json`, `api/_lib/cron-schedules.ts`,
  tests

## Data dependencies

None new (existing Redis key, `push_subscriptions`, VAPID config).

## Open questions

- Reminder cadence beyond 24 h / 2 h / expired? (default: those three)
- Owner habit: re-auth Sunday evening so expiry never lands in RTH.

## Thresholds / constants

- Reminder thresholds: 24 h, 2 h, expired.
- Countdown colors: amber < 24 h, red < 2 h or expired.
