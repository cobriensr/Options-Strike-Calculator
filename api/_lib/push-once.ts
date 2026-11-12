/**
 * Send one owner push at most once per claim key (R6).
 *
 * The claim is a Redis key taken with SET NX BEFORE sending, so two runs of
 * a cron, or a retry after a timeout, cannot push the same alert twice.
 * Shared by the Schwab re-auth reminder and the stale-snapshot alert.
 *
 *   - Key: the caller's. It must be derived from the event itself (a login
 *     expiry, a CT date), never from `NOW()`, so a rerun maps to the same key.
 *   - Value: a random token per run, so a release is fenced. It deletes the
 *     key only while the key still holds this run's token, and never a claim
 *     that expired and was re-taken by a later run.
 *   - Renew: none. One SET NX, one send.
 *   - Expire: `claimTtlSec`, set by the caller. It must outlive the window
 *     in which the same key can be derived, or a rerun after expiry would
 *     push again. Each caller states its own arithmetic.
 *   - Fail: the claim FAILS CLOSED. If SET NX throws (Redis down), nothing
 *     is sent and the error propagates, because sending without a claim
 *     would repeat the push on every run.
 *   - Release: when no device received the push (no live subscriptions, or
 *     every send failed or expired), or when the send threw, the claim is
 *     released so the next run retries. A failed release is logged and
 *     captured, not thrown: the claim then holds until its TTL and that push
 *     is not retried.
 *   - Known gap: a run killed between the claim and the send (a function
 *     timeout) loses that one push until the key expires.
 *
 * `pushTtlSec` is how long the push service holds the message for an
 * unreachable device. A message dropped at its TTL is lost while the claim
 * still blocks a retry, so a caller whose push must reach a phone that is
 * offline or asleep passes hours, not the 60 s live-alert default.
 */

import { randomUUID } from 'node:crypto';

import logger from './logger.js';
import {
  sendPushToOwner,
  type FanOutResult,
  type PushPayload,
} from './push.js';
import { redis } from './redis.js';
import { Sentry } from './sentry.js';

export type PushOnceOutcome =
  | { claimed: false }
  | { claimed: true; result: FanOutResult };

/**
 * Fenced release, as a STATIC script: delete the claim only if it still
 * holds this run's token.
 *
 * KEYS[1] = claim key; ARGV[1] = this run's claim token
 * Returns: 1 = released, 0 = no longer ours (expired or re-claimed)
 */
const RELEASE_CLAIM_LUA = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

/** Release a claim so the next run retries the push. */
async function releaseClaim(
  key: string,
  token: string,
  job: string,
): Promise<void> {
  try {
    await redis.eval(RELEASE_CLAIM_LUA, [key], [token]);
  } catch (err) {
    // The claim now holds until its TTL, so this push is not retried.
    logger.error(
      { err, key },
      `${job}: claim release failed; the push will not be retried`,
    );
    Sentry.captureException(err);
  }
}

/**
 * Why a push reached no device, for the caller's log line and Sentry extra.
 * Only meaningful when `result.sent === 0`.
 */
export function undeliveredReason(result: FanOutResult): string {
  if (result.failed > 0) return 'every send failed';
  if (result.expired > 0) return 'every subscription expired';
  return 'no push subscriptions';
}

/**
 * Claim `key`, push `payload` to the owner's devices, and release the claim
 * when no device received it.
 *
 *   - `{ claimed: false }`: an earlier run holds the claim. Nothing was sent.
 *   - `{ claimed: true, result }`: this run sent. `result.sent === 0` means
 *     nothing was delivered and the claim has been released; the caller
 *     picks the status and the Sentry message.
 *   - Throws if SET NX throws (nothing sent) or the send throws (claim
 *     released first, original error rethrown).
 *
 * `job` prefixes the release-failure log line.
 */
export async function sendOwnerPushOnce(opts: {
  key: string;
  claimTtlSec: number;
  payload: PushPayload;
  pushTtlSec: number;
  job: string;
}): Promise<PushOnceOutcome> {
  const { key, claimTtlSec, payload, pushTtlSec, job } = opts;
  const claimToken = randomUUID();
  // Throws on a Redis error: fail closed (see the header).
  const claimed = await redis.set(key, claimToken, {
    nx: true,
    ex: claimTtlSec,
  });
  if (claimed !== 'OK') return { claimed: false };

  let result: FanOutResult;
  try {
    result = await sendPushToOwner(payload, { ttlSec: pushTtlSec });
  } catch (err) {
    await releaseClaim(key, claimToken, job);
    throw err;
  }

  if (result.sent === 0) await releaseClaim(key, claimToken, job);
  return { claimed: true, result };
}
