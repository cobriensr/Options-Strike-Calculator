# Endpoint licensing and auth fix (2026-10-25)

## Goal

Make every endpoint follow the owner's data-licensing rule. Schwab data may be public. Unusual Whales (UW) and GEXBot data must require owner or guest auth. Also close the CDN cache paths that can hand a guarded response to an anonymous visitor.

## Background

- **The rule.** The owner stated it on 2026-10-25, and it's recorded in CLAUDE.md under "Data-licensing rule". By owner decision, the ML research carousel (`/api/ml/plots`, `/api/ml/plot-image`) stays public. It serves aggregate tests and plots, not market data.
- **The audit.** A read-only audit (2026-10-25) covered 92 route files. Every guarded endpoint runs its guard before doing anything else, and none has a query-param or method bypass. It found:
  1. **`/api/bwb-anchor` is public and serves UW data.** Its only check is `checkBot` (`api/bwb-anchor.ts:103-107`), which any real browser passes. It returns gamma centroids, concentration and the UW spot price from `strike_exposures`, for any `?date=`. Every writer of that table is UW: `fetch-strike-exposure`, `fetch-strike-all`, the ws gex rollup, and the backfill scripts.
  2. **`/api/iv-term-structure` (UW) may leak through the CDN.** It sets `Cache-Control: s-maxage=300, stale-while-revalidate=60` after the guard, with no `Vary: Cookie` and no `private` (`:132`). If Vercel's CDN stores the response, the next anonymous request within 5 minutes is served from the CDN, and the function and its guard never run.
  3. **`/api/history` (Schwab) has the same pattern.** On a Redis hit it sets `s-maxage=86400` (`:266-268`). That isn't a licensing violation, but it bypasses the endpoint's own guard.
- **Frontend impact.** `src/components/BWBCalculator/index.tsx:61-72` already treats a non-OK response as "no anchor" (`r.ok ? r.json() : null`, `.catch(() => {})`). After the gate, anonymous visitors keep the BWB calculator without the auto-anchor, and nothing errors. No frontend change is needed.

## Phases

### Phase 1: gate `/api/bwb-anchor` (small)

- Add `guardOwnerOrGuestEndpoint` (`api/_lib/guest-auth.ts`), following the existing pattern (`if (await guardOwnerOrGuestEndpoint(req, res, done)) return;`). Read the helper's real signature first.
- Keep `checkBot`, and keep the path in `src/main.tsx`'s BotID protect list. Whichever order the existing guarded endpoints use, use the same one.
- **Tests** (`api/__tests__/bwb-anchor.test.ts`):
  - An anonymous request gets 401/403 and never queries the DB.
  - Owner and guest requests get 200 with the existing response shape.
  - The existing tests still pass.
  - Mock the guard at the module boundary (R3).

### Phase 2: no shared caching of guarded responses on the two leaky endpoints (small)

- **`api/iv-term-structure.ts:132`** → `Cache-Control: private, max-age=300`. Browser-only, so no CDN entry. This drops `s-maxage` and `stale-while-revalidate`.
- **`api/history.ts:266-268`** (Redis-hit path) → `private, max-age=86400`. Check its other response paths for shared-cache headers too, and treat them the same way.
- **`api/history.ts` Redis entries** (added during review): a past-date partial result is cached with `ex: 120`, but a hit always sent the day-long max-age, so a browser kept an incomplete response for a day. Entries are now `{ response, complete }` under a bumped `history:v3:` prefix, and a hit sends `max-age=86400` only when `complete`, otherwise 120. Old `history:v2:` keys are never read again and expire on their own TTL. A wrong-shaped entry is a miss: it logs a warning, and the fetch overwrites it.
- **`api/bwb-anchor.ts`** (added during implementation): once Phase 1 guards it, its two `setCacheHeaders` calls (no-data 200: `s-maxage=30`, anchor 200: `s-maxage=60`, both with `Vary: Cookie`) would rely on the same unverified `Vary: Cookie` for guarded UW data, so both became `private, max-age=30` and `private, max-age=60`.
- **500s** on all three endpoints go through `sendError`, which sets `no-store`, so a failure after the success header was set can't leave a cacheable `Cache-Control` on the error.
- **Shared guards' bot 403** (added during review; a separate commit that lands before the endpoint changes): `guardOwnerOrGuestEndpoint` (`api/_lib/guest-auth.ts`) and `guardOwnerEndpoint` (`api/_lib/auth-helpers.ts`) now send `Cache-Control: no-store` on the bot 403, as their 401 already did. A 403 with no freshness wasn't cacheable before either, so this is consistency rather than a leak fix: every rejection now explicitly opts out of caching, and bwb-anchor keeps the `no-store` its own bot check used to send. Every guarded endpoint inherits it.
- `private` is safe whether or not Vercel's CDN honors `Vary: Cookie`, which is unverified (see Phase 3).
- **Tests:** assert the exact `Cache-Control` value on the success paths of all three endpoints, and that no header contains `s-maxage`.

### Phase 3: verify the shared helper live (needs the owner's go-ahead; not started)

`setCacheHeaders` (`api/_lib/auth-helpers.ts:318-330`) protects many guarded endpoints with `s-maxage` + `Vary: Cookie`. That's only safe if Vercel's CDN keys its cache on the Cookie header. Vercel's docs show `Vary` working for other headers, but say nothing about cookies.

To verify:
1. Request one `setCacheHeaders` endpoint with a guest key.
2. Within its `s-maxage` window, request it again with no cookie.
3. Look for `x-vercel-cache: HIT` with a 200.

If the cookieless request is served from the CDN, switch the helper to `private, max-age=N` for guarded responses. Guarded traffic comes from a handful of logins, so the CDN hit rate is near zero and dropping it costs little.

## Files

- **Phase 1:** `api/bwb-anchor.ts`, `api/__tests__/bwb-anchor.test.ts`, `vite.config.ts` (removed the `api/bwb-anchor.ts` coverage exclusion: the handler is now unit-tested at 100%)
- **Phase 2:** `api/iv-term-structure.ts`, `api/__tests__/iv-term-structure.test.ts`, `api/history.ts`, `api/__tests__/history.test.ts`
- **Phase 2, shared guards (separate commit, first):** `api/_lib/guest-auth.ts`, `api/__tests__/guest-auth.test.ts`, `api/_lib/auth-helpers.ts`, `api/__tests__/api-helpers.test.ts`
- **Phase 3 (if approved):** `api/_lib/auth-helpers.ts` and its test

## Data dependencies

No tables, migrations, env vars or new upstream calls. One Redis key change: `/api/history` entries move from `history:v2:` to `history:v3:` (Phase 2); v2 keys expire on their own.

## Open questions

- **Phase 3 go-ahead:** it needs the owner. The live check needs a guest key, and the fix touches many endpoints. Default: don't start it without approval.
- **Schwab-only endpoints that currently require login** (quotes, chain, intraday, history, ticker-candles, yesterday, movers, vix-snapshots-recent) could be public under the rule. Default: leave them as they are. Not in scope.
- **Other providers' terms:** `/api/events` (FRED, Finnhub) and `/api/vix1d-daily` (CBOE) are public, and the rule doesn't cover their providers. Default: out of scope. Flagged to the owner.

## Thresholds / constants

- `iv-term-structure` keeps its 300 s lifetime as a browser `max-age`.
- `history` keeps its 86400 s lifetime as a browser `max-age`.
