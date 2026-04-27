/**
 * Guest-key auth — read-only access for trusted friends.
 *
 * Single-owner app, but the owner can hand out comma-separated keys via the
 * GUEST_ACCESS_KEYS env var so a friend can view owner-gated read-only UI
 * (dark pool, GEX maps, futures playbook, etc.) without a Schwab session.
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
 * Returns the comma-separated GUEST_ACCESS_KEYS as a clean array.
 * Empty array means the feature is disabled (env var unset).
 */
export function getConfiguredGuestKeys(): string[] {
  const raw = process.env.GUEST_ACCESS_KEYS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
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

  const a = Buffer.from(presented);
  let matched = false;
  for (const key of keys) {
    const b = Buffer.from(key);
    if (a.length === b.length && timingSafeEqual(a, b)) {
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
