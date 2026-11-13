# Long-lived owner sign-in

**Date:** 2026-11-11 · **Status:** approved by the owner (option 1). Moved to
the front of the queue by the owner on 2026-11-12 (~23:40 CT): since the live
snapshot alert's first amendment (`live-snapshot-alert-2026-11-11.md`), a day
with no live save at all sends no alert, so this plan is what prevents a
repeat of 11-09 to 11-11. In progress.

## Goal

Each of the owner's browsers signs in once and stays signed in, so renewing the
Schwab connection from any device (e.g. tapping the re-auth reminder on the
phone) no longer leaves the trading computer signed out.

## Why

Two things last 7 days today, and they are tied together:

- the **Schwab connection** (refresh token in Redis), shared by the whole app;
- the **owner sign-in** (`sc-owner` + `sc-hint` cookies), stored per browser,
  with `Max-Age` = `OWNER_COOKIE_MAX_AGE` = 7 days "to match the Schwab refresh
  token" (`api/_lib/auth-helpers.ts:69`, `api/auth/callback.ts:158-175`).

A sign-in renews Schwab for everyone but signs in only the browser it ran in.
On 2026-11-09 to 11-11 Schwab stayed valid while the trading browser's owner
cookie had expired, so no live snapshots saved (they save only from a signed-in
owner browser).

The owner check compares the cookie to `OWNER_SECRET`
(`api/_lib/auth-helpers.ts:105`); the cookie's lifetime only sets how long the
browser keeps it. So the 7-day tie has no server-side meaning and can go.

## Decisions (owner, 2026-11-11)

- Option 1: long-lived owner cookies, renewed on use.
- Not now: signing a browser in without Schwab (push approval, passkey).
- Trade-off accepted: a lost device stays signed in longer. Rotating
  `OWNER_SECRET` in Vercel signs every browser out at once.
- To sign every browser out: rotate `OWNER_SECRET` in Vercel (a long random
  value), redeploy (`vercel redeploy`, or a commit the `ignoreCommand` doesn't
  skip), then sign in again per browser through `/api/auth/init`.

## Thresholds / constants

| Name | Value | Why |
| --- | --- | --- |
| `OWNER_COOKIE_MAX_AGE` | 400 days (34,560,000 s) | Chrome's cap on cookie lifetime; a longer value is clamped. |
| Renewal | on app start, then at most once per 24 h while the window stays open | Keeps an always-open window from ever reaching 400 days; one tiny request a day. |

## Data dependencies

None: no table, migration or env var.

## Files

- Task 1 (server): `api/_lib/auth-helpers.ts`, `api/auth/callback.ts`,
  `api/auth/whoami.ts`, `api/auth/guest-key.ts`, `api/auth/guest-logout.ts`,
  and their tests. The last two take their `Secure` rule from the new
  `isLocalDeployment()` helper in `auth-helpers.ts`.
- Task 2 (client): the startup/daily renewal call, in
  `src/lib/owner-session-renewal.ts`, started from `src/main.tsx`, and its
  test.

## Global Constraints

- Skills to load: `backend-development`, `cc-skill-security-review`,
  `test-master` (Task 2 also `react-expert`).
- Cookie attributes stay exactly as today apart from `Max-Age`: `sc-owner` is
  `Path=/; HttpOnly; SameSite=Strict` (+ `Secure` off localhost); `sc-hint` is
  `Path=/; SameSite=Strict` (+ `Secure`).
- Renewal never creates a session: it only re-issues cookies for a request that
  already passes `isOwner(req)`. A guest or public request gets no Set-Cookie.
- R2: the owner check keeps using `secretEquals` via `isOwner`.
- The public repo rule applies: no attack detail in comments, commits or docs.
- Review: `code-reviewer` plus `security-reviewer` for Task 1.

## Task 1: Server — one cookie builder, 400-day lifetime, renewal in whoami

- `api/_lib/auth-helpers.ts`: `OWNER_COOKIE_MAX_AGE` = 400 days with a comment
  saying why (Chrome's cap; independent of the Schwab token). Add
  `buildOwnerSessionCookies(isLocal: boolean): string[]` returning the
  `sc-owner` and `sc-hint` Set-Cookie strings with today's attributes, reading
  `OWNER_SECRET`. One builder, so the callback and the renewal can't drift.
- `api/auth/callback.ts`: use the builder; replace the "Max-Age=7d: matches
  Schwab refresh token lifetime" comment.
- `api/auth/whoami.ts`: when `mode === 'owner'`, set the builder's cookies on
  the response (renewal). Guest and public responses set no cookie. Header
  comment: the endpoint now also renews the owner sign-in.
- Tests: callback sets both cookies with `Max-Age=34560000` and the same
  attributes as before; whoami as owner sets both cookies; as guest and as
  public sets none; a wrong owner cookie sets none; local vs. production
  `Secure`.

**Acceptance:** `npm run review` green; security review passes.

## Task 2: Client — renew on start and once a day

- When the app starts with the `sc-hint` cookie (owner mode,
  `getAccessMode()`), call `GET /api/auth/whoami` once, and again at most once
  per 24 h while the window stays open (interval with cleanup, or on
  `visibilitychange` when 24 h have passed). Failures are ignored (next start
  retries); no Sentry for network errors.
- Don't route it through the 401 interceptor path in
  `src/utils/authInterceptor.ts` in a way that changes that path's behavior;
  whoami always answers 200.
- Tests: owner mode calls whoami on start; guest/public mode doesn't; a second
  call happens only after 24 h; a rejected fetch doesn't throw; cleanup stops
  the timer.

**Acceptance:** `npm run review` green.
