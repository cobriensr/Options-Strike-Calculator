/**
 * Guest-key auth — read-only access for trusted friends.
 *
 * Single-owner app, but the owner can hand out comma-separated keys via the
 * GUEST_ACCESS_KEYS env var so a friend can view owner-gated read-only UI
 * (dark pool, GEX maps, etc.) without a Schwab session.
 *
 * The Anthropic-backed analyze endpoint stays owner-only — see CLAUDE.md
 * "Auth is single-owner" — so a leaked guest key cannot drain the API budget.
 *
 * Cookie scheme mirrors the owner pattern (api/auth/callback.ts):
 *   - sc-guest         (HttpOnly, server-validated against env keys)
 *   - sc-guest-hint    (visible to JS so the frontend renders guest UI)
 *
 * Rotation: edit GUEST_ACCESS_KEYS in Vercel and redeploy. Old cookies
 * fail timingSafeEqual against the new env list — no DB to clean up.
 */

import { timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';

import { checkBot, isOwner, parseCookies } from './api-helpers.js';
import logger from './logger.js';

export const GUEST_COOKIE = 'sc-guest';
export const GUEST_HINT_COOKIE = 'sc-guest-hint';
export const GUEST_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

let guestKeysWarned = false;

/**
 * Fixed buffer width for the constant-time key comparison. Matches
 * `guestKeySchema`'s max (128 chars) so any well-formed key fits. Keys
 * longer than this can never match a schema-validated configured key, so
 * truncation into the fixed buffer is safe — the exact-length AND below
 * still rejects them.
 */
const MAX_KEY_LEN = 128;

/**
 * Min/max byte-length bounds for a configured key, mirroring
 * `guestKeySchema` (min 8 / max 128) in api/_lib/validation/common.ts.
 * A configured key longer than `MAX_KEY_LEN` would be silently truncated
 * into the fixed 128-byte comparison buffer — two distinct over-long keys
 * sharing their first 128 bytes AND total length would then compare equal
 * (false-positive auth). Bounding the configured side here guarantees every
 * key fits the buffer with no truncation.
 */
const MIN_KEY_LEN = 8;

/**
 * Returns the comma-separated GUEST_ACCESS_KEYS as a clean array.
 * Empty array means the feature is disabled (env var unset).
 *
 * Keys outside the `guestKeySchema` byte-length bounds (min 8 / max 128)
 * are dropped with a warning so a malformed env entry can never be
 * truncated into the fixed comparison buffer. The key value is never
 * logged.
 */
export function getConfiguredGuestKeys(): string[] {
  const raw = process.env.GUEST_ACCESS_KEYS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .filter((k) => {
      const byteLen = Buffer.byteLength(k);
      if (byteLen < MIN_KEY_LEN || byteLen > MAX_KEY_LEN) {
        logger.warn(
          { byteLen, minLen: MIN_KEY_LEN, maxLen: MAX_KEY_LEN },
          'Dropping out-of-bounds GUEST_ACCESS_KEYS entry (length outside guestKeySchema bounds)',
        );
        return false;
      }
      return true;
    });
}

/**
 * Constant-time check: does the supplied key match any configured key?
 * Walks every entry to avoid early-return timing leak.
 */
export function isValidGuestKey(presented: string): boolean {
  const keys = getConfiguredGuestKeys();
  if (keys.length === 0) {
    if (!guestKeysWarned && process.env.VERCEL) {
      guestKeysWarned = true;
      logger.warn('GUEST_ACCESS_KEYS is not set — guest auth disabled');
    }
    return false;
  }

  // Constant-work comparison: copy both presented and candidate keys into
  // fixed-size buffers and ALWAYS call timingSafeEqual on equal-length
  // buffers, regardless of the real key lengths. A length mismatch must not
  // take a measurably shorter path — that would leak the configured key
  // length via timing. The byte-equality result is ANDed with an exact
  // length check so differing-length keys still fail correctly.
  const presentedBuf = Buffer.alloc(MAX_KEY_LEN);
  presentedBuf.write(presented);
  const presentedLen = Buffer.byteLength(presented);

  const candidateBuf = Buffer.alloc(MAX_KEY_LEN);
  let matched = false;
  for (const key of keys) {
    candidateBuf.fill(0);
    candidateBuf.write(key);
    const bytesEqual = timingSafeEqual(presentedBuf, candidateBuf);
    if (bytesEqual && presentedLen === Buffer.byteLength(key)) {
      matched = true;
    }
  }
  return matched;
}

/** Verify the request carries a valid sc-guest cookie. */
export function isGuest(req: VercelRequest): boolean {
  const cookies = parseCookies(req);
  const cookieVal = cookies[GUEST_COOKIE] ?? '';
  if (!cookieVal) return false;
  return isValidGuestKey(cookieVal);
}

/** Owner OR guest — the gate for read-only owner-gated data endpoints. */
export function isOwnerOrGuest(req: VercelRequest): boolean {
  return isOwner(req) || isGuest(req);
}

/**
 * Guard a read-only owner-gated endpoint. Accepts owner sessions and valid
 * guest cookies. Returns true if the request was rejected (response sent).
 */
export function rejectIfNotOwnerOrGuest(
  req: VercelRequest,
  res: VercelResponse,
): boolean {
  if (isOwnerOrGuest(req)) return false;
  res.setHeader('Cache-Control', 'no-store');
  res.status(401).json({ error: 'Not authenticated' });
  return true;
}

/**
 * Combined bot + owner-or-guest guard, mirroring `guardOwnerEndpoint` from
 * api-helpers.ts but extended to accept guest cookies. Returns `true` if the
 * request was rejected (response already sent), `false` if it passed.
 */
export async function guardOwnerOrGuestEndpoint(
  req: VercelRequest,
  res: VercelResponse,
  done: (opts: { status: number }) => void,
): Promise<boolean> {
  const botCheck = await checkBot(req);
  if (botCheck.isBot) {
    done({ status: 403 });
    res.status(403).json({ error: 'Access denied' });
    return true;
  }
  if (rejectIfNotOwnerOrGuest(req, res)) {
    done({ status: 401 });
    return true;
  }
  return false;
}

/** Build Set-Cookie strings for a successful guest login. */
export function buildGuestSetCookies(key: string, isLocal: boolean): string[] {
  const cookieParts = [
    `${GUEST_COOKIE}=${key}`,
    'Path=/',
    `Max-Age=${GUEST_COOKIE_MAX_AGE}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (!isLocal) cookieParts.push('Secure');

  const hintParts = [
    `${GUEST_HINT_COOKIE}=1`,
    'Path=/',
    `Max-Age=${GUEST_COOKIE_MAX_AGE}`,
    'SameSite=Strict',
  ];
  if (!isLocal) hintParts.push('Secure');

  return [cookieParts.join('; '), hintParts.join('; ')];
}

/** Build Set-Cookie strings to clear the guest session. */
export function buildGuestClearCookies(isLocal: boolean): string[] {
  const expired = 'Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  const cookieClear = [
    `${GUEST_COOKIE}=`,
    expired,
    'HttpOnly',
    'SameSite=Strict',
  ];
  const hintClear = [`${GUEST_HINT_COOKIE}=`, expired, 'SameSite=Strict'];
  if (!isLocal) {
    cookieClear.push('Secure');
    hintClear.push('Secure');
  }
  return [cookieClear.join('; '), hintClear.join('; ')];
}
