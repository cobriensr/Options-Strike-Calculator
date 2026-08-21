/**
 * Shared Schwab OAuth2 token management.
 *
 * Uses Upstash Redis to store access + refresh tokens so all
 * serverless functions share the same auth state.
 *
 * Token lifecycle:
 *   - Access token: expires every 30 minutes → auto-refreshed
 *   - Refresh token: expires 7 days after the ORIGINAL OAuth login →
 *     requires manual re-auth. Schwab does NOT hand out a new 7-day refresh
 *     token when you exchange one for an access token, so `refreshExpiresAt`
 *     is set exactly once (at `storeInitialTokens`) and carried forward
 *     unchanged by every subsequent refresh. Recomputing it per refresh —
 *     the pre-2026-08-20 behavior — walked the deadline (and the Redis TTL
 *     derived from it) forward forever, so the app never saw the expiry
 *     coming and positions/breadth went dark with zero warning.
 *
 * The decoded access token is additionally cached in module memory (see
 * `tokenCache`) so a warm lambda does zero Redis reads between refreshes —
 * Upstash bills per command.
 *
 * Environment variables required:
 *   SCHWAB_CLIENT_ID        — App Key from developer.schwab.com
 *   SCHWAB_CLIENT_SECRET     — App Secret from developer.schwab.com
 *   UPSTASH_REDIS_REST_URL   — Auto-set when Upstash Redis is linked in Vercel
 *   UPSTASH_REDIS_REST_TOKEN — Auto-set when Upstash Redis is linked in Vercel
 */

import { randomBytes } from 'node:crypto';

import logger from './logger.js';
import { Sentry } from './sentry.js';
import { requireEnvGroup } from './env.js';
// The Redis singleton lives in the neutral lower-layer `redis.ts` so this
// auth module isn't the source of the shared KV client (avoids inverting the
// layering). Re-exported below for back-compat with existing importers.
import { redis, recordRedisError } from './redis.js';

export { redis };

// ============================================================
// TYPES
// ============================================================

interface SchwabTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix ms when access token expires
  refreshExpiresAt: number; // Unix ms when refresh token expires
}

interface SchwabTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds (typically 1800 = 30 min)
  token_type: string;
  scope: string;
  id_token: string;
}

export interface SchwabAuthError {
  type: 'expired_refresh' | 'token_error' | 'missing_config';
  message: string;
}

// ============================================================
// CONSTANTS
// ============================================================

const KV_KEY = 'schwab:tokens';
const TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const BUFFER_MS = 60_000; // Refresh 1 minute before expiry

/**
 * Lifetime Schwab grants a refresh token at the OAuth login. This is the
 * ONLY moment the clock starts — an access-token refresh does not restart
 * it (see the module docblock).
 */
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Start nagging the owner to re-auth this long before the deadline. */
const REFRESH_EXPIRY_WARN_MS = 24 * 60 * 60 * 1000;

const MS_PER_HOUR = 60 * 60 * 1000;

// ============================================================
// REFRESH-TOKEN DEADLINE
// ============================================================

/**
 * Once-per-process latch for the "expires soon" alarm. `getAccessToken` runs
 * on every Schwab call — crons hit it every minute — so an unlatched capture
 * would be thousands of identical Sentry events a day. One per lambda
 * lifetime is enough to page the owner.
 */
let refreshExpiryWarned = false;

/** Once-per-process latch for the "stored deadline unusable" fallback log. */
let refreshDeadlineFallbackWarned = false;

/**
 * Re-arm both warn latches. Called after a real re-auth (a new 7-day window
 * means the next expiry deserves its own alarm) and by tests.
 */
function resetRefreshWarnLatches(): void {
  refreshExpiryWarned = false;
  refreshDeadlineFallbackWarned = false;
}

/** Re-arm both warn latches. Exported for tests only. */
export function _resetSchwabWarnLatchesForTests(): void {
  resetRefreshWarnLatches();
}

/**
 * The refresh-token deadline to persist after an access-token refresh.
 *
 * Carries the stored deadline forward rather than inventing a new one, and
 * clamps with `Math.min` against `now + 7d`: we cannot prove Schwab ever
 * rotates the refresh token, so the app must never end up believing it has
 * MORE time than the longest window Schwab could possibly have granted. The
 * clamp is what neutralizes a blob written by the old code (or any corrupted
 * value) — it stops the deadline drifting further out, it just cannot
 * retroactively recover the true login time.
 *
 * A missing / non-numeric / non-finite value (an old blob, a partial write)
 * falls back to a full window and logs once. Assuming 7 days there is the
 * safe direction: the alternative — treating it as expired — would take
 * positions offline over a bookkeeping gap.
 */
function carryForwardRefreshExpiry(stored: SchwabTokens, now: number): number {
  const fullWindow = now + REFRESH_TOKEN_TTL_MS;
  // Typed `number`, but it round-trips through Redis JSON written by older
  // code, so it is untrusted at runtime.
  const storedDeadline: unknown = stored.refreshExpiresAt;

  if (
    typeof storedDeadline !== 'number' ||
    !Number.isFinite(storedDeadline) ||
    storedDeadline <= 0
  ) {
    if (!refreshDeadlineFallbackWarned) {
      refreshDeadlineFallbackWarned = true;
      logger.warn(
        { storedRefreshExpiresAt: storedDeadline },
        'schwab refresh: stored refreshExpiresAt is missing or invalid — assuming a full 7-day window from now; re-auth at /api/auth/init to record the real deadline',
      );
    }
    return fullWindow;
  }

  return Math.min(storedDeadline, fullWindow);
}

/**
 * Emit ONE warning per process when the refresh token is inside its final
 * 24 hours. Without this the first sign of trouble is Schwab rejecting the
 * refresh — at which point the Position Monitor and the NYSE breadth
 * internals have already gone dark and `/api/health` is the only tell.
 */
function warnIfRefreshExpiringSoon(
  refreshExpiresAt: number,
  now: number,
): void {
  if (refreshExpiryWarned) return;
  if (!Number.isFinite(refreshExpiresAt)) return;

  const msRemaining = refreshExpiresAt - now;
  if (msRemaining > REFRESH_EXPIRY_WARN_MS) return;

  refreshExpiryWarned = true;
  const hoursRemaining = Math.round((msRemaining / MS_PER_HOUR) * 10) / 10;
  const expiresAt = new Date(refreshExpiresAt).toISOString();
  const message =
    'schwab refresh token expires soon — re-auth at /api/auth/init';

  logger.warn({ expiresAt, hoursRemaining }, message);
  Sentry.captureMessage(message, {
    level: 'warning',
    extra: { expiresAt, hoursRemaining },
  });
}

// ============================================================
// HELPERS
// ============================================================

function getCredentials(): { clientId: string; clientSecret: string } | null {
  try {
    return requireEnvGroup('schwab');
  } catch {
    return null;
  }
}

/**
 * True when both `SCHWAB_CLIENT_ID` and `SCHWAB_CLIENT_SECRET` are set.
 *
 * Schwab is an OPTIONAL integration (positions + NYSE breadth internals);
 * the UW + Theta facade serves everything else. Entry points that would
 * otherwise 500 on missing creds (`/api/auth/init`) or want to offer the
 * Schwab OAuth flow only when it can succeed (`/api/auth/login` form) use
 * this predicate. Deliberately shares `getCredentials()` with `getAuthUrl`
 * so the two can never disagree about "configured".
 */
export function isSchwabConfigured(): boolean {
  return getCredentials() !== null;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  return `Basic ${encoded}`;
}

// ============================================================
// TOKEN STORAGE (Upstash Redis)
// ============================================================

async function getStoredTokens(): Promise<SchwabTokens | null> {
  try {
    return await redis.get<SchwabTokens>(KV_KEY);
  } catch (err) {
    logger.warn({ err }, 'Redis getStoredTokens failed');
    recordRedisError(err);
    return null;
  }
}

async function storeTokens(tokens: SchwabTokens): Promise<void> {
  // TTL = time left on the refresh token + 1 day of slack.
  //
  // `refreshExpiresAt` is the deadline set at the original OAuth login and
  // carried forward untouched by refreshes, so this TTL now SHRINKS as the
  // deadline approaches instead of being pushed out every ~30 minutes. Once
  // the deadline passes, the 1-hour floor keeps the (dead) blob around long
  // enough for `getAccessToken` to answer with the precise "Refresh token
  // expired. Run /api/auth/init" error rather than a bare "No tokens found".
  const ttlMs = tokens.refreshExpiresAt - Date.now() + 86_400_000;
  const ttlSec = Math.max(Math.floor(ttlMs / 1000), 3600);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await redis.set(KV_KEY, tokens, { ex: ttlSec });
      return;
    } catch (err) {
      logger.error({ err, attempt }, 'storeTokens: Redis write failed');
      recordRedisError(err);
      if (attempt < 2)
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  logger.error('storeTokens: all attempts exhausted, tokens NOT persisted');
  Sentry.captureException(
    new Error('storeTokens: all attempts exhausted, tokens NOT persisted'),
  );
}

// ============================================================
// TOKEN REFRESH (with mutex to prevent concurrent refreshes)
// ============================================================

/**
 * In-memory dedup: when 5 parallel schwabFetch calls in the same
 * serverless invocation all see an expired token, only the first
 * one calls Schwab's OAuth endpoint. The rest await the same promise.
 */
let refreshInFlight: Promise<SchwabTokens> | null = null;

/**
 * Module-scoped in-memory access-token cache (Redis cost control).
 *
 * Upstash bills per command, and the single largest steady-state reader
 * was `getAccessToken()` hitting `GET schwab:tokens` on EVERY Schwab call —
 * e.g. `fetch-market-internals` every minute × 4 symbols. The decoded
 * token is valid for ~30 min, so a warm lambda can serve it from memory
 * and only go back to Redis when it is within `BUFFER_MS` of expiry (the
 * same threshold that triggers a refresh).
 *
 * Population / invalidation points:
 *   - a Redis read that yields a still-valid token      → populate
 *   - a successful refresh (lock winner)                 → replace
 *   - the lost-race re-read of the winner's fresh token  → replace
 *   - `storeInitialTokens()` (OAuth callback re-login)   → replace
 *   - `invalidateSchwabTokenCache()`                     → clear (tests,
 *     or a caller that just saw Schwab reject the token)
 *
 * Error outcomes are never cached. Module-scoped state does not survive
 * cold starts — each new instance pays exactly one Redis read, and other
 * warm instances keep their own copy until its expiry (≤ 30 min), which is
 * the same window the old Redis-only flow already tolerated between a
 * refresh and the next read.
 *
 * This also subsumes the previous "last-resort in-memory fallback": a
 * still-valid cached token is served even if Redis is down or over quota.
 */
let tokenCache: {
  accessToken: string;
  expiresAt: number;
} | null = null;

function cacheToken(tokens: SchwabTokens): void {
  tokenCache = { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
}

/**
 * Drop the in-memory access token so the next `getAccessToken()` re-reads
 * Redis. Exported for tests and for callers that observe Schwab rejecting
 * the bearer (401) before its expiry.
 */
export function invalidateSchwabTokenCache(): void {
  tokenCache = null;
}

/**
 * Redis distributed lock: when separate serverless invocations
 * (e.g. quotes + history) both need to refresh, only one calls
 * Schwab. The other waits for the lock to release, then reads
 * the fresh token from Redis.
 */
const LOCK_KEY = 'schwab:refresh_lock';
const LOCK_TTL = 30; // seconds — must be >= SCHWAB_API timeout

async function acquireLock(): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await redis.set(LOCK_KEY, '1', { nx: true, ex: LOCK_TTL });
      return result === 'OK';
    } catch (err) {
      logger.warn({ err, attempt }, 'Redis acquireLock attempt failed');
      recordRedisError(err);
      if (attempt < 2)
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  logger.error('acquireLock: all retries exhausted, proceeding without lock');
  return true;
}

async function releaseLock(): Promise<void> {
  try {
    await redis.del(LOCK_KEY);
  } catch (err) {
    logger.warn({ err }, 'Redis releaseLock failed');
    recordRedisError(err);
  }
}

async function waitForLockRelease(maxWaitMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const held = await redis.get(LOCK_KEY);
      if (!held) return;
    } catch (err) {
      logger.warn({ err }, 'Redis lock check failed, proceeding');
      recordRedisError(err);
      return;
    }
  }
}

/**
 * Exchange the stored refresh token for a fresh access token.
 *
 * Takes the whole stored record (not just the refresh-token string) because
 * the result has to inherit its `refreshExpiresAt` — Schwab's response says
 * nothing about the refresh token's remaining life, so the only source of
 * truth is what we recorded at login.
 */
async function refreshAccessToken(
  stored: SchwabTokens,
  clientId: string,
  clientSecret: string,
): Promise<SchwabTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(clientId, clientSecret),
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Schwab token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as SchwabTokenResponse;
  const now = Date.now();
  const refreshExpiresAt = carryForwardRefreshExpiry(stored, now);

  // Belt-and-braces with the same check in `getAccessToken`: a refresh can
  // finish materially later than the read that triggered it (lock wait +
  // network), so the deadline can cross the 24h line in between.
  warnIfRefreshExpiringSoon(refreshExpiresAt, now);

  return {
    accessToken: data.access_token,
    // Schwab echoes the refresh token back; if a response ever omits it,
    // keep the one we already hold rather than persisting `undefined` and
    // bricking auth until the next manual login.
    refreshToken: data.refresh_token || stored.refreshToken,
    expiresAt: now + data.expires_in * 1000,
    refreshExpiresAt,
  };
}

/**
 * Maximum number of lock-acquisition attempts before giving up. Three
 * handles the realistic failure modes (lose-race-then-read-fresh,
 * lose-race-then-winner-crashed-so-retry) while guaranteeing the loop
 * cannot spin forever if Schwab is genuinely down.
 *
 * BE-CRON-001: the previous implementation fell through and refreshed
 * WITHOUT the lock when a waiting instance found stale tokens in Redis
 * after the winner released (or had its lock expire). That re-created
 * the thundering-herd scenario the lock was designed to prevent — N
 * losing instances would all call Schwab in parallel during the narrow
 * window after lock expiry but before the next winner wrote fresh
 * tokens. The loop here guarantees only a lock holder ever issues
 * the Schwab request.
 */
const LOCK_MAX_ATTEMPTS = 3;

/**
 * Refresh with deduplication — both in-memory (same invocation)
 * and Redis-based (across invocations).
 *
 * Lock protocol:
 *   1. Try to acquire the Redis SET-NX lock.
 *   2. If acquired → do the Schwab refresh, store tokens, release lock.
 *   3. If NOT acquired → wait for the current holder to finish, then
 *      read the freshly-written token from Redis. If it's valid,
 *      return it.
 *   4. If the post-wait token is still stale (winner crashed or
 *      Schwab returned nothing), go back to step 1 for another
 *      attempt. Up to LOCK_MAX_ATTEMPTS loops.
 *   5. After exhausting attempts, throw a token_error so the caller
 *      gets a loud failure rather than silently refreshing without
 *      coordination.
 */
async function refreshAccessTokenOnce(
  stored: SchwabTokens,
  clientId: string,
  clientSecret: string,
): Promise<SchwabTokens> {
  if (refreshInFlight !== null) return refreshInFlight;

  refreshInFlight = (async () => {
    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
      const gotLock = await acquireLock();

      if (gotLock) {
        // We own the refresh. Only a lock holder ever calls Schwab,
        // so at most one cross-instance refresh is in flight at any
        // given moment.
        try {
          const tokens = await refreshAccessToken(
            stored,
            clientId,
            clientSecret,
          );
          await storeTokens(tokens);
          cacheToken(tokens);
          return tokens;
        } finally {
          await releaseLock();
        }
      }

      // Lost the race. Wait for the current holder to release (or for
      // the lock's TTL to expire), then read what they wrote.
      await waitForLockRelease();
      const fresh = await getStoredTokens();
      if (fresh && Date.now() < fresh.expiresAt - BUFFER_MS) {
        cacheToken(fresh);
        return fresh;
      }

      // Winner either crashed, timed out, or didn't write fresh
      // tokens before their lock TTL expired. Loop and try to become
      // the new winner ourselves. Do NOT fall through to an unlocked
      // refresh — that re-creates the thundering-herd scenario.
    }

    throw new Error(
      `Token refresh: exhausted ${LOCK_MAX_ATTEMPTS} lock attempts without acquiring the lock or reading a fresh token`,
    );
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Get a valid Schwab access token.
 * Auto-refreshes if expired. Returns an error if the refresh token
 * is expired (requires manual re-auth).
 */
export async function getAccessToken(): Promise<
  { token: string } | { error: SchwabAuthError }
> {
  const creds = getCredentials();
  if (!creds) {
    return {
      error: {
        type: 'missing_config',
        message: 'SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET must be set',
      },
    };
  }

  // Memory first: zero Redis commands while the cached token is still
  // outside the refresh buffer.
  if (tokenCache && Date.now() < tokenCache.expiresAt - BUFFER_MS) {
    return { token: tokenCache.accessToken };
  }

  const stored = await getStoredTokens();

  if (!stored) {
    return {
      error: {
        type: 'expired_refresh',
        message: 'No tokens found. Run /api/auth/init to authenticate.',
      },
    };
  }

  // Check if refresh token is expired
  if (Date.now() > stored.refreshExpiresAt) {
    return {
      error: {
        type: 'expired_refresh',
        message:
          'Refresh token expired. Run /api/auth/init to re-authenticate.',
      },
    };
  }

  // Still authenticated, but possibly not for much longer. Checked on every
  // Redis read (i.e. at most once per ~30 min per warm instance) rather than
  // only on refresh, so a low-traffic instance that never needs to refresh
  // still raises the alarm.
  warnIfRefreshExpiringSoon(stored.refreshExpiresAt, Date.now());

  // Check if access token is still valid (with buffer)
  if (Date.now() < stored.expiresAt - BUFFER_MS) {
    cacheToken(stored);
    return { token: stored.accessToken };
  }

  // Refresh the access token (deduplicated across parallel calls)
  try {
    const newTokens = await refreshAccessTokenOnce(
      stored,
      creds.clientId,
      creds.clientSecret,
    );
    return { token: newTokens.accessToken };
  } catch (err) {
    logger.error({ err }, 'getAccessToken: token refresh failed');
    Sentry.captureException(err);
    return {
      error: {
        type: 'token_error',
        message: err instanceof Error ? err.message : 'Token refresh failed',
      },
    };
  }
}

/**
 * Store initial tokens after the manual OAuth browser flow.
 * Called by /api/auth/callback after the user completes login.
 */
export async function storeInitialTokens(
  authCode: string,
  redirectUri: string,
): Promise<{ success: true } | { error: SchwabAuthError }> {
  const creds = getCredentials();
  if (!creds) {
    return {
      error: {
        type: 'missing_config',
        message: 'SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET must be set',
      },
    };
  }

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuthHeader(creds.clientId, creds.clientSecret),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        error: {
          type: 'token_error',
          message: `Initial token exchange failed (${res.status}): ${body}`,
        },
      };
    }

    const data = (await res.json()) as SchwabTokenResponse;
    const now = Date.now();

    // The ONE place a new 7-day window is legitimately minted: this is a
    // genuine authorization-code exchange, so the refresh token really is
    // brand new. Every later access-token refresh inherits this deadline.
    const tokens: SchwabTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: now + data.expires_in * 1000,
      refreshExpiresAt: now + REFRESH_TOKEN_TTL_MS,
    };

    await storeTokens(tokens);
    // Fresh window → re-arm the alarms so the NEXT expiry is announced too
    // (a long-lived instance would otherwise stay latched forever).
    resetRefreshWarnLatches();
    // Replace (not just drop) the in-memory copy so this instance serves
    // the post-login token without a Redis read; other warm instances age
    // out their old copy at its expiry.
    cacheToken(tokens);
    return { success: true };
  } catch (err) {
    return {
      error: {
        type: 'token_error',
        message: err instanceof Error ? err.message : 'Token exchange failed',
      },
    };
  }
}

/**
 * Build the Schwab OAuth authorization URL for manual login.
 * Generates a random state nonce and stores it in Redis (10 min TTL)
 * to prevent CSRF attacks on the OAuth callback.
 */
export async function getAuthUrl(
  redirectUri: string,
): Promise<{ url: string; state: string } | null> {
  const creds = getCredentials();
  if (!creds) return null;

  const state = randomBytes(32).toString('hex');
  await redis.set(`oauth:state:${state}`, '1', { ex: 600 });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    state,
  });

  return {
    url: `https://api.schwabapi.com/v1/oauth/authorize?${params.toString()}`,
    state,
  };
}
