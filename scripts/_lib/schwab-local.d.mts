/**
 * Types for scripts/_lib/schwab-local.mjs, so a TypeScript script can use it
 * (scripts/backfill-market-internals.ts). Keep in step with the module.
 */

import type { Redis } from '@upstash/redis';

export const SCHWAB_BASE: string;

/** The Schwab token could not be read or refreshed; the message says why. */
export class SchwabAuthError extends Error {}

/** Mask token-like runs, then cap the length (api/_lib/redact-upstream-body.ts). */
export function redactBody(body: string): string;

/** The refusal to print on a weekday 13:00-21:59 UTC, else null. */
export function schwabCronsBusyRefusal(): string | null;

export interface SchwabEnv {
  /** The line to print when something is missing, else null. */
  problem: string | null;
  redisUrl: string | undefined;
  redisToken: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
}

export function readSchwabEnv(): SchwabEnv;

/** The stored access token, or a refreshed one written back compare-and-set. */
export function getSchwabAccessToken(
  redis: Redis,
  credentials: { clientId: string; clientSecret: string },
): Promise<string>;
