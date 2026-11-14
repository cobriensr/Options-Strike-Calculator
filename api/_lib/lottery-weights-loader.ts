/**
 * Loads the two lottery score versions the crons score with: the `active`
 * pointer (the feed's version) and the `takeit` pointer (the version Take-It
 * was trained on), from the weights store (migration #208). Both come back in
 * one result, each with the version id the scorer writes into `score_version`.
 *
 * Plan: docs/superpowers/plans/2026-11-05-nightly-pipeline-phase4.md (Task 4, D9)
 *
 * `loadLotteryWeights` never throws. When the store can't give a valid pair it
 * hands back the frozen seed in both slots and says why in `fallback`:
 *
 *   - a transient database error (a Neon blip, the 5 s attempt timeout) with
 *     a loaded pair cached: the cached pair, `fallback: null`, one log warning.
 *     A stale version beats the seed. The cache entry is left as it was, so
 *     the next call queries again and the store is back in use as soon as it
 *     answers;
 *   - a transient error with nothing loaded cached: the seed, kind `transient`;
 *   - a row that fails the schema, a missing pointer, or any other database
 *     error (a table that isn't there): the seed, kind `error`, even when a
 *     pair is cached. Corrupt data is not hidden behind a stale copy.
 *
 * Every seed fallback is one Sentry `error` (a warning emails nobody, D9),
 * and the fallback is cached like a loaded pair, so a store that stays down
 * reports once per cache period, not once per call.
 *
 * Cache (R1): one module-level entry, so the state is bounded by construction.
 * Fluid Compute reuses the instance across requests, so a promotion reaches a
 * warm instance within `WEIGHTS_CACHE_TTL_MS`. One in-flight promise lets
 * concurrent callers share a query; it is dropped when the load settles.
 */

import { getDb, isRetryableDbError, withDbRetry } from './db.js';
import logger from './logger.js';
import { LotteryWeightsSchema } from './lottery-weights-schema.js';
import type { LotteryWeights } from './lottery-weights-schema.js';
import {
  SEED_LOTTERY_WEIGHTS,
  SEED_LOTTERY_WEIGHTS_VERSION,
} from './lottery-weights-seed.js';
import { Sentry } from './sentry.js';

export interface VersionedWeights {
  version: string;
  weights: LotteryWeights;
}

export interface WeightsFallback {
  reason: string;
  kind: 'transient' | 'error';
}

export interface LoadedLotteryWeights {
  active: VersionedWeights;
  takeit: VersionedWeights;
  /** Null when both slots came from the store; set when both are the seed. */
  fallback: WeightsFallback | null;
}

/**
 * How long a loaded pair, or a fallback, is served before the store is read
 * again. A staleness knob: a promotion reaches the crons within a minute.
 */
const WEIGHTS_CACHE_TTL_MS = 60_000;

interface PointerRow {
  name: string;
  version: string;
  weights: unknown;
}

interface CacheEntry {
  value: LoadedLotteryWeights;
  loadedAt: number;
}

type Attempt = { value: LoadedLotteryWeights } | WeightsFallback;

let cache: CacheEntry | null = null;
let inFlight: Promise<LoadedLotteryWeights> | null = null;

function describeError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/** The named pointer's version, validated, or the reason it can't be used. */
function readPointer(
  rows: PointerRow[],
  name: 'active' | 'takeit',
): VersionedWeights | string {
  const row = rows.find((r) => r.name === name);
  if (!row) return `no ${name} pointer`;
  const parsed = LotteryWeightsSchema.safeParse(row.weights);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.map(String).join('.') || 'the root';
    return `${name} version ${row.version} fails validation at ${path}: ${issue?.message ?? 'unknown issue'}`;
  }
  return { version: row.version, weights: parsed.data };
}

async function attempt(): Promise<Attempt> {
  let rows: PointerRow[];
  try {
    const sql = getDb();
    // One retry and a 5 s attempt timeout: a cron waits at most ~11 s for the
    // store before it falls back.
    rows = (await withDbRetry(
      () => sql`
        SELECT p.name, v.version, v.weights
        FROM lottery_score_pointers p
        JOIN lottery_score_versions v ON v.version = p.version
        WHERE p.name IN ('active','takeit')
      `,
      1,
      5_000,
    )) as PointerRow[];
  } catch (err) {
    return {
      kind: isRetryableDbError(err) ? 'transient' : 'error',
      reason: describeError(err),
    };
  }

  const active = readPointer(rows, 'active');
  if (typeof active === 'string') return { kind: 'error', reason: active };
  const takeit = readPointer(rows, 'takeit');
  if (typeof takeit === 'string') return { kind: 'error', reason: takeit };
  return { value: { active, takeit, fallback: null } };
}

function seedFallback(fallback: WeightsFallback): LoadedLotteryWeights {
  logger.error(fallback, 'lottery weights fallback to seed');
  Sentry.captureMessage('lottery weights fallback to seed', {
    level: 'error',
    fingerprint: ['lottery-weights-fallback', fallback.kind],
    tags: { kind: fallback.kind },
    extra: { reason: fallback.reason },
  });
  return {
    active: {
      version: SEED_LOTTERY_WEIGHTS_VERSION,
      weights: SEED_LOTTERY_WEIGHTS,
    },
    takeit: {
      version: SEED_LOTTERY_WEIGHTS_VERSION,
      weights: SEED_LOTTERY_WEIGHTS,
    },
    fallback,
  };
}

async function refresh(
  previous: CacheEntry | null,
): Promise<LoadedLotteryWeights> {
  const outcome = await attempt();
  if ('value' in outcome) {
    cache = { value: outcome.value, loadedAt: Date.now() };
    return outcome.value;
  }
  if (outcome.kind === 'transient' && previous?.value.fallback === null) {
    logger.warn(
      { reason: outcome.reason },
      'lottery weights reload failed; serving the cached version',
    );
    return previous.value;
  }
  const value = seedFallback(outcome);
  cache = { value, loadedAt: Date.now() };
  return value;
}

export async function loadLotteryWeights(): Promise<LoadedLotteryWeights> {
  if (cache && Date.now() - cache.loadedAt < WEIGHTS_CACHE_TTL_MS) {
    return cache.value;
  }
  inFlight ??= refresh(cache).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
