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
// Shared zod helpers
// ============================================================

// Helper: fields from ComputedSignals are often `T | null`, and
// JSON.stringify preserves null (unlike undefined). Accept both.
export const num = z.number().nullable().optional();
export const str = z.string().nullable().optional();
export const bool = z.boolean().nullable().optional();
