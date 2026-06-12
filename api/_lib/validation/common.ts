/**
 * Cross-cutting Zod schemas + helpers shared by the per-domain validation
 * sub-files.
 *
 * Includes:
 *   - `guestKeySchema` — POST /api/auth/guest-key body
 *   - `alertAckSchema` — POST /api/alerts-ack body
 *   - `num` / `str` / `bool` — nullable-optional zod helpers used by
 *     snapshotBodySchema (shape mirrors the JSON `T | null | undefined`
 *     coalescence we get from frontend payloads)
 */

import { z } from 'zod';

// ============================================================
// /api/auth/guest-key
// ============================================================

/**
 * POST /api/auth/guest-key body.
 *
 * `key` is the shared access key generated locally (e.g. via
 * `openssl rand -base64 24`) and stored comma-separated in the
 * `GUEST_ACCESS_KEYS` env var. Min 8 / max 128 chars to discourage
 * trivial brute-force and bound the request payload.
 */
export const guestKeySchema = z.object({
  key: z.string().min(8).max(128),
});

export type GuestKeyBody = z.infer<typeof guestKeySchema>;

// ============================================================
// /api/alerts-ack
// ============================================================

export const alertAckSchema = z.object({
  id: z.number().int().positive().finite(),
});

export type AlertAckBody = z.infer<typeof alertAckSchema>;

// ============================================================
// /api/push/* — Web Push v2 endpoints
// ============================================================

/**
 * POST /api/push/subscribe body.
 *
 * Shape matches the `PushSubscriptionJSON` interface that the browser's
 * `PushSubscription.toJSON()` returns — we accept it verbatim and split
 * into columns server-side. `user_agent` is the only extra field, sent
 * by the client for "which device is this?" admin display.
 */
export const pushSubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(200),
  }),
  user_agent: z.string().max(500).optional(),
});

export type PushSubscribeBody = z.infer<typeof pushSubscribeSchema>;

/** POST /api/push/unsubscribe body. */
export const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
});

export type PushUnsubscribeBody = z.infer<typeof pushUnsubscribeSchema>;

/**
 * POST /api/push/notify body. Internal-only, gated by
 * INTERNAL_NOTIFY_SECRET header — uw-stream is the legit caller.
 */
export const pushNotifySchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(500),
  tag: z.string().max(200).optional(),
  requireInteraction: z.boolean().optional(),
  url: z.string().url().max(2000).optional(),
});

export type PushNotifyBody = z.infer<typeof pushNotifySchema>;

// ============================================================
// Shared zod helpers
// ============================================================

// Helper: fields from ComputedSignals are often `T | null`, and
// JSON.stringify preserves null (unlike undefined). Accept both.
export const num = z.number().nullable().optional();
export const str = z.string().nullable().optional();
export const bool = z.boolean().nullable().optional();

// `?since=` query param for the poll-since reader endpoints (alerts,
// interval-ba-alerts). Interpolated into a TIMESTAMPTZ compare — parameterized
// so not injectable, but a non-timestamp value makes Postgres throw → a
// repeatable 500 on a 10s-polled endpoint. Validate the ISO-8601 shape so
// garbage degrades to a 400 (AUD-M42).
export const sinceParamSchema = z.string().datetime({ offset: true });
