/**
 * Shared constant-time secret comparison — the only place a secret is
 * compared (CLAUDE.md R2). Re-exported from `auth-helpers.ts`; modules on
 * the cron path (`cron-helpers.ts`, `cron-instrumentation.ts`) import this
 * file directly because it has no dependencies beyond `node:crypto`, so the
 * test files that replace `api-helpers` with a mock do not pull in
 * auth-helpers' botid/redis imports.
 *
 * Audit: docs/tmp/llm-antipattern-audit-2026-09-08/crypto-and-config.md
 * (R2-3).
 */

import { createHash, timingSafeEqual } from 'node:crypto';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * True when `presented` equals `expected`, byte for byte.
 *
 * Both sides are hashed to fixed-length SHA-256 digests before the
 * `timingSafeEqual`, so the comparison takes the same time whether or not
 * the lengths match — unlike a length guard, which returns early and leaks
 * the secret's length. Returns false (never throws) for an empty, missing
 * or non-string input on either side: an unset secret must never match an
 * empty presented value.
 */
export function secretEquals(presented: unknown, expected: unknown): boolean {
  if (typeof presented !== 'string' || typeof expected !== 'string') {
    return false;
  }
  if (presented.length === 0 || expected.length === 0) return false;
  return timingSafeEqual(sha256(presented), sha256(expected));
}

/**
 * True when an `Authorization` header value is exactly `Bearer <secret>`.
 *
 * The whole header is compared, so a missing header, an array header, a
 * different scheme, a lowercase `bearer`, extra whitespace or a bare
 * `Bearer` all fail — the same rules the hand-rolled cron compares
 * enforced. Returns false for an empty or unset secret.
 */
export function bearerMatches(authHeader: unknown, secret: unknown): boolean {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  return secretEquals(authHeader, `Bearer ${secret}`);
}
