/**
 * Schwab access for the plain-node scripts: read the token record the
 * production crons keep in Upstash Redis, refresh it in place when the access
 * token has run out, and the guard that keeps a script off the crons' window.
 * Lifted out of the market-internals backfill so the candle backfill
 * (candles-backfill.mjs) uses the same code instead of a second copy. Both the
 * market-internals backfill (scripts/backfill-market-internals.ts, through
 * schwab-local.d.mts) and the candle backfill use it.
 *
 * WARNING: the Redis these scripts read is the PRODUCTION one that holds the
 * live Schwab token record. A script that uses it should run only while the
 * Schwab crons are idle (schwabCronsBusyRefusal says when) so its refresh
 * doesn't race theirs. The refresh write is a compare-and-set: it never
 * overwrites a re-login and never resurrects a cleared record, but it does not
 * take the crons' refresh lock.
 *
 * Failures throw a SchwabAuthError (the scripts used to process.exit(1) here),
 * so a caller can turn them into failed days instead of ending the process.
 */

export const SCHWAB_BASE = 'https://api.schwabapi.com/marketdata/v1';
const TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const KV_KEY = 'schwab:tokens';
const BUFFER_MS = 60_000;

/**
 * Compare-and-set of a refreshed token record — keep in sync with
 * STORE_REFRESHED_LUA in api/_lib/schwab.ts. Writes only if the record still
 * holds the refresh token we refreshed with (plain-find on its
 * `"refreshToken":<JSON>` fragment), so a re-login that lands mid-refresh is
 * never overwritten and a cleared record is never resurrected.
 * Returns: 0 = key absent, 1 = written, 2 = key holds a different token.
 */
const STORE_REFRESHED_LUA = `
  local raw = redis.call('GET', KEYS[1])
  if not raw then return 0 end
  if not string.find(raw, ARGV[1], 1, true) then return 2 end
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
`;

/** The Schwab token could not be read or refreshed; the message says why. */
export class SchwabAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchwabAuthError';
  }
}

/**
 * Mask token-like runs, then cap the length — same rule as
 * api/_lib/redact-upstream-body.ts (keep in sync): 24+ chars of
 * `A-Za-z0-9+/=_.-\%` become `[redacted]`, then truncate to 200.
 */
export function redactBody(body) {
  const masked = body.replaceAll(/[A-Za-z0-9+/=_.%\\-]{24,}/g, '[redacted]');
  if (masked.length <= 200) return masked;
  return `${masked.slice(0, 200)}… (${body.length} chars)`;
}

// ── Idle-window guard ──────────────────────────────────────

/**
 * First and last UTC hour of the Schwab crons' day: vercel.json registers
 * fetch-spx-candles-1m and fetch-strike-iv as `* 13-21 * * 1-5`, and
 * compute-cone and fetch-outcomes inside it. fetch-market-internals settles
 * once after them at 22:30 UTC (`30 22 * * 1-5`), and it too reads and
 * refreshes the Schwab token, so the window runs to the end of hour 22.
 */
const BUSY_FIRST_UTC_HOUR = 13;
const BUSY_LAST_UTC_HOUR = 22;

/**
 * The refusal to print when a script that refreshes the Schwab token would
 * start on a weekday from 13:00 to 22:59 UTC, else null. A refresh from here
 * could race the crons' own. The window is the crons' registered hours, not
 * the market's: it is a little wider than the session on purpose.
 *
 * Holidays aren't known here. The crons skip a market holiday, so a caller
 * lets its --allow-market-hours flag past this guard for one.
 */
export function schwabCronsBusyRefusal() {
  const now = new Date();
  const weekday = now.getUTCDay();
  const hour = now.getUTCHours();
  const busy =
    weekday >= 1 &&
    weekday <= 5 &&
    hour >= BUSY_FIRST_UTC_HOUR &&
    hour <= BUSY_LAST_UTC_HOUR;
  if (!busy) return null;
  return (
    'Refusing to run on a weekday 13:00–22:59 UTC: the Schwab crons are ' +
    'active, and a token refresh here could race theirs. Run outside that ' +
    'window, or pass --allow-market-hours (e.g. on a market holiday, when ' +
    'the crons skip).'
  );
}

// ── Env ────────────────────────────────────────────────────

/**
 * The Redis and Schwab app settings a script needs, from the environment.
 * `problem` is the line to print when one is missing, else null. The Redis
 * pair has the Upstash names and the Vercel KV names (the same fallback as
 * api/_lib/redis.ts).
 */
export function readSchwabEnv() {
  const env = process.env;
  const redisUrl = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  const clientId = env.SCHWAB_CLIENT_ID;
  const clientSecret = env.SCHWAB_CLIENT_SECRET;
  let problem = null;
  if (!redisUrl || !redisToken) {
    problem = 'Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN';
  } else if (!clientId || !clientSecret) {
    problem = 'Missing SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET';
  }
  return { problem, redisUrl, redisToken, clientId, clientSecret };
}

// ── Token ──────────────────────────────────────────────────

/**
 * A Schwab access token: the stored one while it has more than a minute left,
 * else a refresh (written back with the compare-and-set). `redis` is an
 * Upstash client; `clientId` and `clientSecret` are the Schwab app's.
 * Throws a SchwabAuthError when there is no record, the refresh token has
 * lapsed (it lives 7 days from the original login), Schwab refuses the
 * refresh or answers with something unusable, or the record changed or was
 * cleared mid-refresh and the one now stored is no good.
 */
export async function getSchwabAccessToken(redis, { clientId, clientSecret }) {
  const stored = await redis.get(KV_KEY);
  if (!stored) {
    throw new SchwabAuthError(
      'No Schwab tokens in Redis. Run /api/auth/init to authenticate first.',
    );
  }

  // Refresh token lapsed? It lives 7 days from the ORIGINAL login; sending a
  // dead one only earns a 400 invalid_grant.
  if (Date.now() > stored.refreshExpiresAt) {
    throw new SchwabAuthError(
      'Schwab refresh token expired. Run /api/auth/init to re-authenticate.',
    );
  }

  // Token still valid?
  if (Date.now() < stored.expiresAt - BUFFER_MS) {
    return stored.accessToken;
  }

  // Refresh
  console.log('  Schwab access token expired, refreshing...');
  const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${encoded}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new SchwabAuthError(
      `Token refresh failed (${res.status}): ${redactBody(body)}`,
    );
  }

  const data = await res.json();
  if (
    typeof data.access_token !== 'string' ||
    data.access_token === '' ||
    typeof data.expires_in !== 'number'
  ) {
    throw new SchwabAuthError(
      'Token refresh returned a malformed response; not storing.',
    );
  }
  const now = Date.now();
  const newTokens = {
    accessToken: data.access_token,
    // Schwab may omit refresh_token on a refresh; the stored one stays valid.
    refreshToken: data.refresh_token ?? stored.refreshToken,
    expiresAt: now + data.expires_in * 1000,
    // Fixed at the original login — a refresh must NOT slide the 7-day
    // window forward (same rule as api/_lib/schwab.ts).
    refreshExpiresAt: stored.refreshExpiresAt,
  };

  const ttlSec = Math.max(
    Math.floor((newTokens.refreshExpiresAt - now + 86_400_000) / 1000),
    3600,
  );
  const written = await redis.eval(
    STORE_REFRESHED_LUA,
    [KV_KEY],
    [
      `"refreshToken":${JSON.stringify(stored.refreshToken)}`,
      JSON.stringify(newTokens),
      String(ttlSec),
    ],
  );
  if (written !== 1) {
    // The record changed under us (a re-login, or a clear). Use what is
    // stored now if it's valid; otherwise stop rather than overwrite it.
    const current = await redis.get(KV_KEY);
    if (current && Date.now() < current.expiresAt - BUFFER_MS) {
      console.log(
        '  Token record changed during refresh (re-login?); using the stored token.',
      );
      return current.accessToken;
    }
    throw new SchwabAuthError(
      'Token record changed or was cleared during refresh; not overwriting it. Re-run the script.',
    );
  }
  console.log('  Token refreshed and stored.');
  return newTokens.accessToken;
}
