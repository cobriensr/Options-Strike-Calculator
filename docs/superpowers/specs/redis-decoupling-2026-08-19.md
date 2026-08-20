# Redis decoupling + usage reduction — 2026-08-19

**Date:** 2026-08-19 · **Status:** PAUSED — owner is upgrading the Upstash plan instead, which unblocks Schwab without code changes. Phase A (Schwab off Redis) is now OPTIONAL resilience work; Phase B (cut steady-state commands) remains worthwhile as cost control on a per-command plan. · **Owner:** soonerdude28 fork

## Goal

Upstash Redis hit its free-tier cap (`ERR max requests limit exceeded.
Limit: 500000, Usage: 500000`, ~3 days after provisioning). Every real
command now fails, which **blocks Schwab OAuth entirely**: `getAuthUrl()`
writes the state nonce to Redis and `getAccessToken()` reads/writes the
token blob there. Owner chose "cut Redis usage" over upgrading the plan.

Two objectives:
1. **Unblock Schwab without Redis** — move the OAuth state nonce to a signed
   httpOnly cookie and the token blob to Postgres (already provisioned, no
   command quota).
2. **Cut steady-state Redis commands** so the free tier is sufficient, and
   make every remaining Redis path degrade instead of 500.

## Phases

### A. Schwab OAuth off Redis (unblocks login)

- **State nonce → signed cookie.** `getAuthUrl()` returns `{url, state}`;
  `api/auth/init.ts` sets `sc-oauth-state=<state>.<hmac>` (httpOnly, Secure,
  **SameSite=Lax** so it survives Schwab's top-level GET redirect back,
  Path=/api/auth, Max-Age=600). `api/auth/callback.ts` verifies the HMAC and
  the `state` query param match, then clears the cookie. HMAC key:
  `OWNER_SECRET` (already required in prod) via `crypto.createHmac('sha256')`
  + `timingSafeEqual`. No Redis on either side.
- **Token blob → Postgres.** New migration **#191** creates
  `schwab_tokens (id smallint primary key default 1 check (id = 1),
  access_token text, refresh_token text, expires_at timestamptz,
  refreshed_at timestamptz default now())` — single-row table, matching the
  single-owner model. `storeInitialTokens()` upserts; `getAccessToken()`
  selects. Update `api/__tests__/db.test.ts` per CLAUDE.md (applied-migrations
  mock, expected-output list, SQL call count).
- **Refresh lock → Postgres advisory lock.** Replace the Redis `SET NX` lock
  with `pg_try_advisory_lock(<constant>)` / `pg_advisory_unlock` around the
  refresh, preserving the existing "another instance is refreshing, re-read"
  behaviour and TTL semantics.
- `api/_lib/schwab.ts` must no longer import `_lib/redis.js`.
- `/api/health`'s schwab check keeps working (now Postgres-backed).

### B. Cut steady-state Redis commands

- **In-memory token cache.** Module-scoped cache of the decoded access token
  in `schwab.ts`, valid until `expires_at - 60s`, so a warm lambda serving
  `fetch-market-internals` (every minute × 4 symbols) does zero storage reads.
- **Rate limiter halved + skipped for trusted callers**
  (`api/_lib/auth-helpers.ts`): issue a single `INCR`, and only call `EXPIRE`
  when the returned count is `1` (first hit in the window) — 2 commands → ~1.
  Skip the limiter entirely when the request carries a valid `sc-owner`
  cookie or `Authorization: Bearer <CRON_SECRET>`; brute-force protection is
  for anonymous callers.
- **Wrap remaining Redis reads/writes in `safeRedis`** so a quota error
  degrades to a cache miss instead of a 500: `api/events.ts`,
  `api/history.ts`, `api/vix1d-daily.ts`, `api/cron/refresh-vix1d.ts`.
  Lengthen the events cache TTL (300s → 900s edge, day-scoped key unchanged).

### C. Observability

- `api/_lib/redis.ts`: detect `max requests limit exceeded` in an error and
  log it once per process at `warn` with a distinct metric
  (`redis.quota_exceeded`) rather than a generic Sentry error storm.
- `/api/health` reports redis `degraded` (not `error`) for a quota failure,
  so the endpoint distinguishes "over quota" from "misconfigured/down".

## Data dependencies

Migration #191 (`schwab_tokens`). No new env vars. `OWNER_SECRET` gains a
second use (HMAC key for the OAuth state cookie) — already required.

## Thresholds / constants

State cookie TTL 600s; token in-memory cache = `expires_at - 60s`; advisory
lock id `0x5C4AB` (constant in schwab.ts); rate-limit window 60s unchanged.

## Open questions (defaults picked)

- Keep Upstash for the remaining best-effort caches? **Yes** — after A+B the
  residual volume is small and every path is `safeRedis`-wrapped, so a future
  quota hit is cosmetic rather than fatal.
- Encrypt tokens at rest in Postgres? **No** — same trust boundary as the
  existing plaintext owner cookie; Neon is already the store for everything
  else. Revisit if the app ever becomes multi-user.
