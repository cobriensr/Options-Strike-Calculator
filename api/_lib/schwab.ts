/**
 * Shared Schwab OAuth2 token management.
 *
 * Uses Upstash Redis to store access + refresh tokens so all
 * serverless functions share the same auth state.
 *
 * Token lifecycle:
 *   - Access token: expires every 30 minutes → auto-refreshed
 *   - Refresh token: expires 7 days after the ORIGINAL login (the
 *     authorization-code exchange). Refreshing the access token does NOT
 *     extend it, so `refreshExpiresAt` is fixed at login and carried over
 *     unchanged on every refresh → requires manual re-auth.
 *   - If Schwab rejects the refresh token (400/401 `invalid_grant`) the
 *     stored tokens are cleared (compare-and-delete) so later calls stop
 *     locally with `expired_refresh` instead of re-sending a dead token.
 *
 * Environment variables required:
 *   SCHWAB_CLIENT_ID        — App Key from developer.schwab.com
 *   SCHWAB_CLIENT_SECRET     — App Secret from developer.schwab.com
 *   UPSTASH_REDIS_REST_URL   — Auto-set when Upstash Redis is linked in Vercel
 *   UPSTASH_REDIS_REST_TOKEN — Auto-set when Upstash Redis is linked in Vercel
 */

import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import logger from './logger.js';
import { Sentry, metrics } from './sentry.js';
import { requireEnvGroup } from './env.js';
// The Redis singleton lives in the neutral lower-layer `redis.ts` so this
// auth module isn't the source of the shared KV client (avoids inverting the
// layering). Re-exported below for back-compat with existing importers.
import { redis } from './redis.js';

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

/**
 * Token-endpoint 2xx body, validated before anything is stored: a
 * malformed body must surface as a loud token_error rather than persist
 * `accessToken: undefined` / `expiresAt: NaN` (which would re-refresh on
 * every call). `expires_in` is in seconds (typically 1800). Schwab may omit
 * `refresh_token` on a refresh grant — the stored one stays valid and is
 * carried over — but the authorization-code exchange must return one.
 */
const refreshResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
});

const codeExchangeResponseSchema = refreshResponseSchema.extend({
  refresh_token: z.string().min(1),
});

export interface SchwabAuthError {
  type: 'expired_refresh' | 'token_error' | 'missing_config';
  message: string;
}

/**
 * Schwab's token endpoint rejected the refresh token itself — it is
 * expired, revoked, or superseded, and only a manual re-auth recovers.
 * Distinct from transient failures (5xx, timeouts, other 4xx), which stay
 * loud and must NOT clear the stored tokens.
 */
class SchwabRefreshRejectedError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`Schwab rejected the refresh token (${status}): ${body}`);
    this.name = 'SchwabRefreshRejectedError';
    this.status = status;
  }
}

// ============================================================
// CONSTANTS
// ============================================================

const KV_KEY = 'schwab:tokens';
const TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const BUFFER_MS = 60_000; // Refresh 1 minute before expiry
/** Abort budget for a token-endpoint call (refresh + code exchange). */
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

const NO_TOKENS_MESSAGE =
  'No tokens found. Run /api/auth/init to authenticate.';
const REFRESH_EXPIRED_MESSAGE =
  'Refresh token expired. Run /api/auth/init to re-authenticate.';
const REJECTED_MESSAGE =
  'Schwab rejected the refresh token (invalid_grant). Run /api/auth/init to re-authenticate.';

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

function basicAuthHeader(clientId: string, clientSecret: string): string {
  const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Validate a token-endpoint 2xx body. The thrown message names the bad
 * fields only — never the body, which carries token values.
 */
function parseTokenBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const fields = [
    ...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(body)')),
  ].join(', ');
  throw new Error(
    `Schwab token endpoint returned a malformed response (invalid: ${fields})`,
  );
}

/** Where a stored token record stands right now. */
type TokenAssessment =
  | { state: 'missing' }
  | { state: 'refresh_expired' }
  | { state: 'fresh' | 'stale'; tokens: SchwabTokens };

function assessTokens(tokens: SchwabTokens | null): TokenAssessment {
  if (!tokens) return { state: 'missing' };
  const now = Date.now();
  if (now > tokens.refreshExpiresAt) return { state: 'refresh_expired' };
  // Access token still valid (with buffer) → fresh; otherwise refresh it.
  const state = now < tokens.expiresAt - BUFFER_MS ? 'fresh' : 'stale';
  return { state, tokens };
}

function loggedOutMessage(state: 'missing' | 'refresh_expired'): string {
  return state === 'missing' ? NO_TOKENS_MESSAGE : REFRESH_EXPIRED_MESSAGE;
}

// ============================================================
// TOKEN STORAGE (Upstash Redis)
// ============================================================

/**
 * A read of the token record. A Redis failure is kept distinct from an
 * absent key: "the store is down" must not be reported as "logged out".
 */
type StoredTokensRead =
  | { ok: true; tokens: SchwabTokens | null }
  | { ok: false; error: unknown };

async function getStoredTokens(): Promise<StoredTokensRead> {
  try {
    return { ok: true, tokens: await redis.get<SchwabTokens>(KV_KEY) };
  } catch (err) {
    logger.warn({ err }, 'Redis getStoredTokens failed');
    metrics.increment('redis.error');
    return { ok: false, error: err };
  }
}

async function storeTokens(tokens: SchwabTokens): Promise<void> {
  // TTL = REMAINING refresh-token lifetime + 1 day buffer (refreshExpiresAt
  // is fixed at login, so this shrinks with each refresh). Floored at 1 h.
  const ttlMs = tokens.refreshExpiresAt - Date.now() + 86_400_000;
  const ttlSec = Math.max(Math.floor(ttlMs / 1000), 3600);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await redis.set(KV_KEY, tokens, { ex: ttlSec });
      return;
    } catch (err) {
      logger.error({ err, attempt }, 'storeTokens: Redis write failed');
      metrics.increment('redis.error');
      if (attempt < 2)
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  logger.error('storeTokens: all attempts exhausted, tokens NOT persisted');
  Sentry.captureException(
    new Error('storeTokens: all attempts exhausted, tokens NOT persisted'),
  );
}

/**
 * Atomic compare-and-delete of the token record — STATIC script, all inputs
 * via ARGV. Deletes the key only if it still holds the refresh token that
 * Schwab rejected, so a concurrent re-auth's fresh tokens are never wiped.
 *
 * `@upstash/redis` stores the record as `JSON.stringify(tokens)`, so ARGV[1]
 * is the exact `"refreshToken":"<token>"` fragment. JSON escaping means an
 * unescaped `"` only appears at real key/value boundaries, and the closing
 * quote fences the value (a token cannot prefix-match a longer one). The
 * 4th `string.find` arg (`true`) disables Lua patterns.
 *
 * KEYS[1] = token key
 * ARGV[1] = `"refreshToken":` + JSON-encoded rejected refresh token
 *
 * Returns: 0 = key absent, 1 = deleted, 2 = key holds a different token
 */
const CLEAR_REJECTED_LUA = `
  local raw = redis.call('GET', KEYS[1])
  if not raw then return 0 end
  if string.find(raw, ARGV[1], 1, true) then
    redis.call('DEL', KEYS[1])
    return 1
  end
  return 2
`;

type ClearOutcome = 'cleared' | 'replaced' | 'absent' | 'failed';

/**
 * Clear the token record for a refresh token Schwab rejected. Deleting
 * (rather than re-writing it with `refreshExpiresAt = 0`) leaves one
 * logged-out state — "no tokens" — instead of a dead record that the 1 h
 * TTL floor in `storeTokens` would drop an hour later anyway, and it keeps
 * the compare-and-set a single static script with no JSON rewrite in Lua.
 */
async function clearRejectedTokens(
  rejectedRefreshToken: string,
): Promise<ClearOutcome> {
  try {
    const result = await redis.eval(
      CLEAR_REJECTED_LUA,
      [KV_KEY],
      [`"refreshToken":${JSON.stringify(rejectedRefreshToken)}`],
    );
    if (result === 1) return 'cleared';
    if (result === 2) return 'replaced';
    return 'absent';
  } catch (err) {
    // The dead token stays stored, so the next call will re-send it and be
    // rejected again — this must be loud.
    logger.error(
      { err },
      'clearRejectedTokens: compare-and-delete failed; rejected tokens NOT cleared',
    );
    metrics.increment('redis.error');
    Sentry.captureException(err);
    return 'failed';
  }
}

/**
 * Schwab double-encodes the real OAuth error inside an outer one, e.g.
 * `{"error":"unsupported_token_type","error_description":"400 Bad Request:
 * \"{\"error_description\":\"Refresh token is invalid, expired or
 * revoked\",\"error\":\"invalid_grant\"}\""}` — so classify on the
 * `invalid_grant` substring, not the outer `error` field. Deliberately
 * narrow: a false positive clears live tokens and forces a needless re-auth.
 */
function isRefreshRejection(status: number, body: string): boolean {
  return (status === 400 || status === 401) && body.includes('invalid_grant');
}

// ============================================================
// TOKEN REFRESH (with mutex to prevent concurrent refreshes)
// ============================================================

/**
 * Result of a (deduplicated) refresh attempt.
 *   - refreshed:  fresh tokens (ours, or a lock winner's read from Redis)
 *   - logged_out: the refresh token is dead or the tokens are gone →
 *                 caller reports `expired_refresh`
 *   - replaced:   Schwab rejected OUR refresh token, but a concurrent
 *                 re-auth had already stored new tokens → re-read them
 */
type RefreshOutcome =
  | { kind: 'refreshed'; tokens: SchwabTokens }
  | { kind: 'logged_out'; message: string }
  | { kind: 'replaced' };

/**
 * In-memory dedup: when 5 parallel schwabFetch calls in the same
 * serverless invocation all see an expired token, only the first
 * one calls Schwab's OAuth endpoint. The rest await the same promise.
 */
let refreshInFlight: Promise<RefreshOutcome> | null = null;

/**
 * Last-resort in-memory token cache. Only helps within the same
 * serverless invocation (module-scoped variables don't survive cold
 * starts). During a Redis blip inside an active invocation it
 * prevents cascading auth failure.
 */
let inMemoryTokenCache: {
  accessToken: string;
  expiresAt: number;
} | null = null;

/**
 * Redis distributed lock: when separate serverless invocations
 * (e.g. quotes + history) both need to refresh, only one calls
 * Schwab. The other waits for the lock to release, then reads
 * the fresh token from Redis.
 *
 * Semantics (R6):
 *   - Value: a random token per acquisition, so a release is fenced —
 *     it deletes the lock only if it still holds OUR token.
 *   - Renew: none. The TTL is sized to outlive the longest hold instead.
 *   - Expire: LOCK_TTL_SEC = 45 s. Longest hold = the token-endpoint call
 *     (TOKEN_REQUEST_TIMEOUT_MS = 30 s; the abort signal also bounds
 *     reading the body) + storeTokens' retry backoff (0.5 s + 1 s) + a few
 *     Upstash round-trips (re-read, compare-and-delete, writes) ≈ 32 s,
 *     leaving ~13 s of margin. A holder that still overruns can overlap
 *     the next holder's refresh; the token record's compare-and-delete
 *     keeps that safe, and the fenced release stops the late holder from
 *     deleting the next holder's lock.
 *   - Fail: acquisition FAILS OPEN — if Redis errors on all 3 SET NX
 *     attempts we refresh without the lock, because a Redis outage must
 *     not block every Schwab call (the per-invocation in-flight dedup
 *     still bounds it to one refresh per instance). A failed release is
 *     logged and the TTL reclaims the lock.
 */
const LOCK_KEY = 'schwab:refresh_lock';
const LOCK_TTL_SEC = 45;

/**
 * Fenced release — STATIC script: delete the lock only if it still holds
 * our token (it may have expired and been re-acquired by another instance).
 *
 * KEYS[1] = lock key; ARGV[1] = our lock token
 * Returns: 1 = released, 0 = no longer ours (expired / taken over)
 */
const RELEASE_LOCK_LUA = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

/**
 * Try to take the refresh lock. Returns our lock token when held (or when
 * failing open on a Redis outage — see above), or null when another
 * instance holds it.
 */
async function acquireLock(): Promise<string | null> {
  const lockToken = randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await redis.set(LOCK_KEY, lockToken, {
        nx: true,
        ex: LOCK_TTL_SEC,
      });
      return result === 'OK' ? lockToken : null;
    } catch (err) {
      logger.warn({ err, attempt }, 'Redis acquireLock attempt failed');
      metrics.increment('redis.error');
      if (attempt < 2)
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  logger.error(
    'acquireLock: Redis unavailable, proceeding WITHOUT the lock (fail-open)',
  );
  return lockToken;
}

async function releaseLock(lockToken: string): Promise<void> {
  try {
    const released = await redis.eval(
      RELEASE_LOCK_LUA,
      [LOCK_KEY],
      [lockToken],
    );
    if (released !== 1) {
      logger.warn(
        'releaseLock: lock no longer held by us (expired or taken over); left alone',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Redis releaseLock failed; the TTL will reclaim it');
    metrics.increment('redis.error');
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
      metrics.increment('redis.error');
      return;
    }
  }
}

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
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    if (isRefreshRejection(res.status, body)) {
      throw new SchwabRefreshRejectedError(res.status, body);
    }
    throw new Error(`Schwab token refresh failed (${res.status}): ${body}`);
  }

  // Throws on a malformed body → captured token_error; nothing is stored.
  const data = parseTokenBody(refreshResponseSchema, await res.json());

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? stored.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    // Fixed at login: a refresh must not slide the 7-day window forward.
    // (It used to, which made the local expiry guard unreachable while
    // crons kept refreshing — the dead token was then re-sent to Schwab
    // for a week, 2026-09-21 → 09-28.)
    refreshExpiresAt: stored.refreshExpiresAt,
  };
}

/**
 * Handle a refresh token Schwab rejected. Runs inside the refresh lock, so
 * no other lock-respecting instance can re-send the dead token while it is
 * being cleared, and inside the in-flight dedup, so parallel callers in one
 * invocation share a single clear + capture.
 */
async function handleRejectedRefresh(
  rejectedRefreshToken: string,
  err: SchwabRefreshRejectedError,
): Promise<RefreshOutcome> {
  const outcome = await clearRejectedTokens(rejectedRefreshToken);
  logger.warn(
    { status: err.status, outcome },
    'Schwab rejected the refresh token',
  );
  if (outcome === 'replaced') return { kind: 'replaced' };

  inMemoryTokenCache = null;
  if (outcome === 'cleared') {
    // Exactly one event per live → dead transition: only the call whose
    // compare-and-delete removed the key reports it. A warning, not an
    // exception — the login lapsing is expected; the fix is a re-auth.
    Sentry.captureMessage('schwab.auth.refresh_rejected', {
      level: 'warning',
      fingerprint: ['schwab.auth.refresh_rejected'],
      extra: { status: err.status, detail: err.message },
    });
  }
  return { kind: 'logged_out', message: REJECTED_MESSAGE };
}

/**
 * The lock holder's refresh. Re-reads the record first (double-checked
 * locking): the caller's snapshot predates the lock, and meanwhile another
 * holder may have refreshed, a rejected token may have been cleared, or a
 * re-auth may have landed. So it never sends a refresh token the store no
 * longer holds. A failed re-read falls back to the snapshot rather than
 * blocking the refresh (the compare-and-delete still guards a clear).
 */
async function refreshUnderLock(
  snapshot: SchwabTokens,
  clientId: string,
  clientSecret: string,
): Promise<RefreshOutcome> {
  let record = snapshot;
  const latest = await getStoredTokens();
  if (latest.ok) {
    const assessed = assessTokens(latest.tokens);
    if (assessed.state === 'missing' || assessed.state === 'refresh_expired') {
      return { kind: 'logged_out', message: loggedOutMessage(assessed.state) };
    }
    if (assessed.state === 'fresh') {
      return { kind: 'refreshed', tokens: assessed.tokens };
    }
    record = assessed.tokens;
  }

  try {
    const tokens = await refreshAccessToken(record, clientId, clientSecret);
    await storeTokens(tokens);
    inMemoryTokenCache = {
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
    };
    return { kind: 'refreshed', tokens };
  } catch (err) {
    if (!(err instanceof SchwabRefreshRejectedError)) throw err;
    return await handleRejectedRefresh(record.refreshToken, err);
  }
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
 *   2. If acquired → re-read the record under the lock (it may already be
 *      fresh, cleared, or replaced), refresh from THAT record, store
 *      tokens, and release the lock (fenced).
 *   3. If NOT acquired → wait for the current holder to finish, then
 *      read the freshly-written token from Redis. If it's valid,
 *      return it.
 *   4. If the post-wait token is still stale (winner crashed or
 *      Schwab returned nothing), go back to step 1 for another
 *      attempt. Up to LOCK_MAX_ATTEMPTS loops. If the tokens are GONE
 *      after the wait (the winner cleared a rejected refresh token, or
 *      the key expired), stop — never send a refresh token the store no
 *      longer holds.
 *   5. After exhausting attempts, throw a token_error so the caller
 *      gets a loud failure rather than silently refreshing without
 *      coordination.
 *
 * A Schwab `invalid_grant` rejection is handled inside the lock (see
 * `handleRejectedRefresh`) and resolves to `logged_out` / `replaced`
 * rather than throwing; every other failure throws.
 */
async function refreshAccessTokenOnce(
  stored: SchwabTokens,
  clientId: string,
  clientSecret: string,
): Promise<RefreshOutcome> {
  if (refreshInFlight !== null) return refreshInFlight;

  refreshInFlight = (async (): Promise<RefreshOutcome> => {
    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
      const lockToken = await acquireLock();

      if (lockToken !== null) {
        // We own the refresh. Only a lock holder ever calls Schwab,
        // so at most one cross-instance refresh is in flight at any
        // given moment.
        try {
          return await refreshUnderLock(stored, clientId, clientSecret);
        } finally {
          await releaseLock(lockToken);
        }
      }

      // Lost the race. Wait for the current holder to release (or for
      // the lock's TTL to expire), then read what they wrote. A read
      // error counts as "still stale" and loops.
      await waitForLockRelease();
      const fresh = await getStoredTokens();
      if (fresh.ok) {
        const assessed = assessTokens(fresh.tokens);
        if (
          assessed.state === 'missing' ||
          assessed.state === 'refresh_expired'
        ) {
          return {
            kind: 'logged_out',
            message: loggedOutMessage(assessed.state),
          };
        }
        if (assessed.state === 'fresh') {
          return { kind: 'refreshed', tokens: assessed.tokens };
        }
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

type AccessTokenResult = { token: string } | { error: SchwabAuthError };

/**
 * Get a valid Schwab access token.
 * Auto-refreshes if expired. Returns `expired_refresh` when the login has
 * lapsed (no tokens, refresh token expired, or rejected by Schwab — all
 * require manual re-auth) and `token_error` for everything transient
 * (token store unreachable, refresh endpoint 5xx / timeout / other 4xx).
 */
export async function getAccessToken(): Promise<AccessTokenResult> {
  const creds = getCredentials();
  if (!creds) {
    return {
      error: {
        type: 'missing_config',
        message: 'SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET must be set',
      },
    };
  }
  return resolveAccessToken(creds, true);
}

/**
 * @param allowReread one re-resolve is allowed when a concurrent re-auth
 *   replaced the tokens between our read and Schwab's rejection; a second
 *   such race in the same call gives up with a token_error.
 */
async function resolveAccessToken(
  creds: { clientId: string; clientSecret: string },
  allowReread: boolean,
): Promise<AccessTokenResult> {
  const read = await getStoredTokens();

  if (!read.ok) {
    // Token store unreachable. The in-memory cache is the last resort for
    // exactly this case (a Redis blip inside a warm invocation).
    if (
      inMemoryTokenCache &&
      inMemoryTokenCache.expiresAt > Date.now() + BUFFER_MS
    ) {
      logger.warn('Using in-memory token fallback — Redis read failed');
      return { token: inMemoryTokenCache.accessToken };
    }
    // NOT "No tokens found": the tokens are probably intact, so this must
    // stay a loud token_error rather than read as a logout.
    logger.error(
      { err: read.error },
      'getAccessToken: token store read failed',
    );
    Sentry.captureException(read.error);
    const reason =
      read.error instanceof Error ? read.error.message : String(read.error);
    return {
      error: {
        type: 'token_error',
        message: `Token store read failed: ${reason}`,
      },
    };
  }

  const assessed = assessTokens(read.tokens);
  if (assessed.state === 'missing' || assessed.state === 'refresh_expired') {
    return {
      error: {
        type: 'expired_refresh',
        message: loggedOutMessage(assessed.state),
      },
    };
  }
  if (assessed.state === 'fresh') {
    return { token: assessed.tokens.accessToken };
  }

  // Refresh the access token (deduplicated across parallel calls)
  let outcome: RefreshOutcome;
  try {
    outcome = await refreshAccessTokenOnce(
      assessed.tokens,
      creds.clientId,
      creds.clientSecret,
    );
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

  if (outcome.kind === 'refreshed') {
    return { token: outcome.tokens.accessToken };
  }
  if (outcome.kind === 'logged_out') {
    return { error: { type: 'expired_refresh', message: outcome.message } };
  }
  if (allowReread) return resolveAccessToken(creds, false);
  return {
    error: {
      type: 'token_error',
      message:
        'Schwab tokens were replaced twice while refreshing; retry the request.',
    },
  };
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
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
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

    // Throws on a malformed body → token_error below; nothing is stored.
    const data = parseTokenBody(codeExchangeResponseSchema, await res.json());
    const now = Date.now();

    const tokens: SchwabTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: now + data.expires_in * 1000,
      refreshExpiresAt: now + 7 * 24 * 60 * 60 * 1000,
    };

    await storeTokens(tokens);
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
