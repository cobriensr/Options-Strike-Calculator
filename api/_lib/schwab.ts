/**
 * Shared Schwab OAuth2 token management.
 *
 * Uses Upstash Redis to store access + refresh tokens so all
 * serverless functions share the same auth state.
 *
 * Token lifecycle:
 *   - Access token: expires every 30 minutes → auto-refreshed
 *   - Refresh token: expires every 7 days → requires manual re-auth
 *
 * Environment variables required:
 *   SCHWAB_CLIENT_ID        — App Key from developer.schwab.com
 *   SCHWAB_CLIENT_SECRET     — App Secret from developer.schwab.com
 *   UPSTASH_REDIS_REST_URL   — Auto-set when Upstash Redis is linked in Vercel
 *   UPSTASH_REDIS_REST_TOKEN — Auto-set when Upstash Redis is linked in Vercel
 */

import { Redis } from '@upstash/redis';

// ============================================================
// TYPES
// ============================================================

/**
 * Upstash Redis client.
 * When created via Vercel Marketplace, these env vars are auto-set:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * Uses the REST-based client (no persistent connections needed).
 * Exported so api-helpers.ts can use it for rate limiting.
 */
export const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '',
  token:
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '',
});

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

// ============================================================
// HELPERS
// ============================================================

function getCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.SCHWAB_CLIENT_ID;
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
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
  } catch {
    return null;
  }
}

async function storeTokens(tokens: SchwabTokens): Promise<void> {
  try {
    // TTL = refresh token lifetime + 1 day buffer
    const ttlMs = tokens.refreshExpiresAt - Date.now() + 86_400_000;
    const ttlSec = Math.max(Math.floor(ttlMs / 1000), 3600);
    await redis.set(KV_KEY, tokens, { ex: ttlSec });
  } catch (err) {
    console.error('Failed to store tokens in Redis:', err);
  }
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
 * Redis distributed lock: when separate serverless invocations
 * (e.g. quotes + history) both need to refresh, only one calls
 * Schwab. The other waits for the lock to release, then reads
 * the fresh token from Redis.
 */
const LOCK_KEY = 'schwab:refresh_lock';
const LOCK_TTL = 10; // seconds

async function acquireLock(): Promise<boolean> {
  try {
    const result = await redis.set(LOCK_KEY, '1', { nx: true, ex: LOCK_TTL });
    return result === 'OK';
  } catch {
    return true; // If Redis fails, proceed anyway
  }
}

async function releaseLock(): Promise<void> {
  try {
    await redis.del(LOCK_KEY);
  } catch {
    // Best effort
  }
}

async function waitForLockRelease(maxWaitMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const held = await redis.get(LOCK_KEY);
      if (!held) return;
    } catch {
      return;
    }
  }
}

async function refreshAccessToken(
  refreshToken: string,
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
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Schwab token refresh failed (${res.status}): ${body}`);
  }

  const data: SchwabTokenResponse = await res.json();
  const now = Date.now();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: now + data.expires_in * 1000,
    refreshExpiresAt: now + 7 * 24 * 60 * 60 * 1000,
  };
}

/**
 * Refresh with deduplication — both in-memory (same invocation)
 * and Redis-based (across invocations).
 */
async function refreshAccessTokenOnce(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<SchwabTokens> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const gotLock = await acquireLock();

    if (!gotLock) {
      // Another invocation is refreshing — wait, then read fresh token
      await waitForLockRelease();
      const fresh = await getStoredTokens();
      if (fresh && Date.now() < fresh.expiresAt - BUFFER_MS) {
        return fresh;
      }
    }

    try {
      const tokens = await refreshAccessToken(
        refreshToken,
        clientId,
        clientSecret,
      );
      await storeTokens(tokens);
      return tokens;
    } finally {
      if (gotLock) await releaseLock();
    }
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

  // Check if access token is still valid (with buffer)
  if (Date.now() < stored.expiresAt - BUFFER_MS) {
    return { token: stored.accessToken };
  }

  // Refresh the access token (deduplicated across parallel calls)
  try {
    const newTokens = await refreshAccessTokenOnce(
      stored.refreshToken,
      creds.clientId,
      creds.clientSecret,
    );
    return { token: newTokens.accessToken };
  } catch (err) {
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

  const data: SchwabTokenResponse = await res.json();
  const now = Date.now();

  const tokens: SchwabTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: now + data.expires_in * 1000,
    refreshExpiresAt: now + 7 * 24 * 60 * 60 * 1000,
  };

  await storeTokens(tokens);
  return { success: true };
}

/**
 * Build the Schwab OAuth authorization URL for manual login.
 */
export function getAuthUrl(redirectUri: string): string | null {
  const creds = getCredentials();
  if (!creds) return null;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: creds.clientId,
    redirect_uri: redirectUri,
  });

  return `https://api.schwabapi.com/v1/oauth/authorize?${params.toString()}`;
}
