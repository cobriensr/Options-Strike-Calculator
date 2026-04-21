/**
 * Thin wrapper around the `web-push` package for Phase 2A.3 delivery.
 *
 * The regime-alerts cron produces `AlertEvent` objects (from the shared
 * `detectAlertEdges` engine) and hands them here. This module iterates
 * every row in `push_subscriptions`, signs a VAPID request with the
 * configured keys, and sends the serialized event as the push payload.
 *
 * ## Failure handling (matches plan `Phase 2A.3 > Open questions > 7`)
 *
 * - **2xx** — delivery success. Bump `last_delivered_at` and reset
 *   `failure_count` to 0 so a flaky subscription that has now recovered
 *   isn't held against it forever.
 * - **404 / 410 Gone** — the push service permanently dropped the
 *   subscription (browser uninstalled the PWA, user cleared site data,
 *   etc). Delete the row immediately; there is nothing to recover.
 * - **5xx / timeout / transport error** — transient upstream failure.
 *   Increment `failure_count`. When the count reaches
 *   `SUBSCRIPTION_FAILURE_LIMIT`, delete the row to prevent a dead
 *   subscription from endlessly consuming cron budget.
 *
 * ## Concurrency
 *
 * Deliveries run via `Promise.allSettled` so one slow push service
 * (FCM, Mozilla Services, WNS) cannot serialize the others. We cap
 * each individual call with a 5-second socket timeout via web-push's
 * `timeout` option — longer than that and the cron budget for a
 * 1-minute cadence becomes the bottleneck.
 *
 * ## Missing VAPID env
 *
 * If any VAPID env var is missing the module logs a single warning
 * and returns `{ delivered: 0, errors: 0, deliveredEndpoints: [] }`
 * rather than throwing — this keeps the cron's error path clean during
 * initial deployment when ops hasn't populated the keys yet. The
 * frontend will see zero delivery counts in the event history and
 * know something is wrong.
 */

import webpush from 'web-push';
import type { AlertEvent } from '../../src/components/FuturesGammaPlaybook/alerts.js';
import { getDb } from './db.js';
import logger from './logger.js';
import { Sentry } from './sentry.js';

// ── Constants ──────────────────────────────────────────────────────

export const SUBSCRIPTION_FAILURE_LIMIT = 3;
export const PUSH_TIMEOUT_MS = 5_000;
/** TTL (seconds) the push service may hold a payload if the device is offline. */
const PUSH_TTL_SECONDS = 3_600;

// ── Types ──────────────────────────────────────────────────────────

export interface SendPushResult {
  delivered: number;
  errors: number;
  deliveredEndpoints: string[];
}

interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  failure_count: number;
}

// ── VAPID config (lazy + memoized) ─────────────────────────────────

interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

let vapidWarned = false;

function loadVapidConfig(): VapidConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? '';
  const privateKey = process.env.VAPID_PRIVATE_KEY ?? '';
  const subject = process.env.VAPID_SUBJECT ?? '';
  if (!publicKey || !privateKey || !subject) {
    if (!vapidWarned) {
      vapidWarned = true;
      logger.warn(
        {
          hasPublic: publicKey.length > 0,
          hasPrivate: privateKey.length > 0,
          hasSubject: subject.length > 0,
        },
        'web-push-client: VAPID env vars missing — push delivery disabled',
      );
    }
    return null;
  }
  return { publicKey, privateKey, subject };
}

// ── DB helpers ─────────────────────────────────────────────────────

async function listActiveSubscriptions(): Promise<SubscriptionRow[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT endpoint, p256dh, auth, failure_count
    FROM push_subscriptions
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    endpoint: String(r.endpoint),
    p256dh: String(r.p256dh),
    auth: String(r.auth),
    failure_count: Number(r.failure_count ?? 0),
  }));
}

async function markDelivered(endpoint: string): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      UPDATE push_subscriptions
      SET last_delivered_at = now(), failure_count = 0
      WHERE endpoint = ${endpoint}
    `;
  } catch (err) {
    // Bookkeeping failures must never bubble up — the alert was
    // already delivered, the user got the notification, and the next
    // cron will re-sync counts.
    Sentry.captureException(err);
    logger.warn({ err, endpoint }, 'web-push-client: markDelivered failed');
  }
}

async function deleteSubscription(endpoint: string, reason: string): Promise<void> {
  try {
    const sql = getDb();
    await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`;
    logger.info({ endpoint, reason }, 'web-push-client: pruned subscription');
  } catch (err) {
    Sentry.captureException(err);
    logger.warn(
      { err, endpoint, reason },
      'web-push-client: deleteSubscription failed',
    );
  }
}

async function incrementFailure(row: SubscriptionRow): Promise<void> {
  const nextCount = row.failure_count + 1;
  if (nextCount >= SUBSCRIPTION_FAILURE_LIMIT) {
    await deleteSubscription(row.endpoint, 'failure_limit_reached');
    return;
  }
  try {
    const sql = getDb();
    await sql`
      UPDATE push_subscriptions
      SET failure_count = ${nextCount}
      WHERE endpoint = ${row.endpoint}
    `;
  } catch (err) {
    Sentry.captureException(err);
    logger.warn(
      { err, endpoint: row.endpoint },
      'web-push-client: incrementFailure failed',
    );
  }
}

// ── Core delivery ──────────────────────────────────────────────────

interface DeliveryOutcome {
  endpoint: string;
  ok: boolean;
}

async function deliverOne(
  row: SubscriptionRow,
  payload: string,
  vapid: VapidConfig,
): Promise<DeliveryOutcome> {
  try {
    await webpush.sendNotification(
      {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      },
      payload,
      {
        TTL: PUSH_TTL_SECONDS,
        timeout: PUSH_TIMEOUT_MS,
        vapidDetails: {
          subject: vapid.subject,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        },
      },
    );
    await markDelivered(row.endpoint);
    return { endpoint: row.endpoint, ok: true };
  } catch (err) {
    // `WebPushError` has `statusCode`; transport errors don't. Treat
    // missing `statusCode` as a transient error (timeout / DNS / etc).
    const statusCode =
      err && typeof err === 'object' && 'statusCode' in err
        ? Number((err as { statusCode: unknown }).statusCode)
        : null;

    if (statusCode === 404 || statusCode === 410) {
      await deleteSubscription(row.endpoint, `status_${statusCode}`);
    } else {
      await incrementFailure(row);
      // Non-410 errors get logged to Sentry — a flaky push service is
      // the most common cause, but a misconfigured VAPID key also
      // surfaces here and needs to be noticed.
      Sentry.captureException(err);
      logger.warn(
        { endpoint: row.endpoint, statusCode, err },
        'web-push-client: delivery failed',
      );
    }
    return { endpoint: row.endpoint, ok: false };
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Deliver an `AlertEvent` to every active push subscription.
 *
 * Returns counts + a list of endpoints that got the payload. The cron
 * uses the delivered count to stamp the `regime_events` row for
 * history-view badges.
 *
 * Never throws. DB errors, VAPID misconfig, and per-subscription
 * failures are all caught internally so a bad row doesn't poison the
 * whole batch.
 */
export async function sendPushToAll(event: AlertEvent): Promise<SendPushResult> {
  const vapid = loadVapidConfig();
  if (!vapid) {
    return { delivered: 0, errors: 0, deliveredEndpoints: [] };
  }

  let rows: SubscriptionRow[];
  try {
    rows = await listActiveSubscriptions();
  } catch (err) {
    Sentry.captureException(err);
    logger.error(
      { err },
      'web-push-client: failed to list subscriptions',
    );
    return { delivered: 0, errors: 0, deliveredEndpoints: [] };
  }

  if (rows.length === 0) {
    return { delivered: 0, errors: 0, deliveredEndpoints: [] };
  }

  const payload = JSON.stringify(event);
  const results = await Promise.allSettled(
    rows.map((row) => deliverOne(row, payload, vapid)),
  );

  let delivered = 0;
  let errors = 0;
  const deliveredEndpoints: string[] = [];

  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value.ok) {
        delivered += 1;
        deliveredEndpoints.push(r.value.endpoint);
      } else {
        errors += 1;
      }
    } else {
      // Shouldn't reach here — deliverOne already catches internally —
      // but keep the guard so a future refactor can't silently drop
      // rejections.
      errors += 1;
      Sentry.captureException(r.reason);
    }
  }

  return { delivered, errors, deliveredEndpoints };
}
