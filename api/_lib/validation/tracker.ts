/**
 * Zod schemas for the /api/tracker/* endpoint family.
 *
 * Backs the Contract Tracker feature (spec:
 * docs/superpowers/specs/contract-tracker-2026-05-17.md).
 *
 * Three schemas are exported:
 *
 *   - `contractCreateSchema` — structured POST body. All required fields
 *     are checked for finiteness; numeric upper bounds match the OCC
 *     limits the migration's NUMERIC(10,4) columns can store.
 *   - `contractUpdateSchema` — PATCH body. Every field optional; if
 *     `status='closed'` is set, `closed_price` must also be present (the
 *     handler enforces this — Zod alone can't model the conditional cleanly).
 *   - `freeTextContractSchema` — POST body discriminator. When `input`
 *     is present the handler routes through `parseFreeText()` from
 *     `api/_lib/occ.ts` and ignores the structured fields.
 *
 * Numeric thresholds always require `.finite()` so Infinity / NaN are
 * rejected at the boundary before reaching Postgres.
 */

import { z } from 'zod';

// ============================================================
// Shared sub-schemas
// ============================================================

/** Spot-level alert: { op, level } where op is a comparison verb. */
export const spotAlertSchema = z.object({
  op: z.enum(['>=', '<=', '>', '<']),
  level: z.number().finite(),
});

export type SpotAlert = z.infer<typeof spotAlertSchema>;

/**
 * Up thresholds are positive percentages (e.g. 50 = +50%). We don't
 * bound them upward — a 1000% threshold is unusual but valid.
 */
const upThresholdSchema = z.number().finite().positive();

/**
 * Down thresholds are negative percentages (e.g. -30 = -30%). The
 * negativity check guards against the common mistake of entering a
 * positive number meaning "down 30%".
 */
const downThresholdSchema = z.number().finite().negative();

/**
 * UnusualWhales contract URL — captured when the Add form's paste box
 * receives a UW link. Stored verbatim and rendered as the row's
 * click-through target. Hostname + protocol allowlist prevents an
 * accidental open-redirect on the row click (the surface is
 * owner-or-guest, so cheap to enforce). `.trim()` normalizes
 * paste-from-clipboard whitespace — this is the exact UX surface this
 * schema serves. Migration #183 added the underlying column.
 */
const uwUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2000)
  .refine(
    (raw) => {
      try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'https:') return false;
        const host = parsed.hostname.toLowerCase();
        return (
          host === 'unusualwhales.com' || host.endsWith('.unusualwhales.com')
        );
      } catch {
        return false;
      }
    },
    { message: 'uw_url must be an https:// link on unusualwhales.com' },
  );

// ============================================================
// POST /api/tracker/contracts — structured body
// ============================================================

/**
 * Structured contract-create input. Used when the frontend posts the
 * fully-parsed form (ticker, expiry, strike, side, direction, etc.).
 *
 * `ticker` is uppercased before validation — the regex enforces 1-6
 * uppercase alphanumerics so freshly-IPO'd tickers with digits (e.g.
 * `2222.T` style) still pass after callers strip non-OCC chars.
 */
export const contractCreateSchema = z.object({
  ticker: z
    .string()
    .min(1, 'ticker is required')
    .max(6, 'ticker must be 1-6 characters')
    .regex(
      /^[A-Z][A-Z0-9.-]{0,5}$/,
      'ticker must be 1-6 uppercase letters/digits (no spaces)',
    ),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expiry must be YYYY-MM-DD'),
  strike: z.number().finite().positive(),
  side: z.enum(['C', 'P']),
  direction: z.enum(['long', 'short']),
  entry_price: z.number().finite().positive(),
  quantity: z.number().int().finite().positive(),
  notes: z.string().max(2000).optional(),
  up_thresholds: z.array(upThresholdSchema).max(20).optional(),
  down_thresholds: z.array(downThresholdSchema).max(20).optional(),
  spot_alerts: z.array(spotAlertSchema).max(20).optional(),
  uw_url: uwUrlSchema.optional(),
});

export type ContractCreateBody = z.infer<typeof contractCreateSchema>;

// ============================================================
// POST /api/tracker/contracts — free-text body
// ============================================================

/**
 * Free-text input mode — single `input` field parsed server-side via
 * `parseFreeText()`. The threshold/alert fields are optional and
 * applied after the free-text parse extracts ticker/strike/side/expiry.
 */
export const freeTextContractSchema = z.object({
  input: z.string().min(1, 'input is required').max(500),
  notes: z.string().max(2000).optional(),
  up_thresholds: z.array(upThresholdSchema).max(20).optional(),
  down_thresholds: z.array(downThresholdSchema).max(20).optional(),
  spot_alerts: z.array(spotAlertSchema).max(20).optional(),
  uw_url: uwUrlSchema.optional(),
});

export type FreeTextContractBody = z.infer<typeof freeTextContractSchema>;

// ============================================================
// PATCH /api/tracker/contracts/:id
// ============================================================

/**
 * Partial update body. Every field is optional. The handler is
 * responsible for two conditional rules that Zod can't express
 * ergonomically:
 *
 *   1. If `status === 'closed'`, `closed_price` must be provided.
 *   2. `status` cannot be set to 'active' or 'expired' via this endpoint
 *      — only the cron auto-expires; only `'closed'` is user-settable.
 */
export const contractUpdateSchema = z
  .object({
    notes: z.string().max(2000).nullable().optional(),
    up_thresholds: z.array(upThresholdSchema).max(20).nullable().optional(),
    down_thresholds: z.array(downThresholdSchema).max(20).nullable().optional(),
    spot_alerts: z.array(spotAlertSchema).max(20).nullable().optional(),
    status: z.literal('closed').optional(),
    closed_price: z.number().finite().positive().optional(),
    // Position-size + entry-price edits. Both are non-nullable on the
    // underlying column (NOT NULL in tracker_contracts), so we require
    // positive finite values when provided. `quantity` matches the
    // create-schema integer constraint. `entry_price` enforces a
    // minimum of 0.0001 — the NUMERIC(10,4) column rounds anything
    // below that to 0, which would silently corrupt downstream PnL math.
    entry_price: z.number().finite().gte(0.0001).optional(),
    quantity: z.number().int().finite().positive().optional(),
  })
  .refine(
    (data) => {
      // Must include at least one updatable field.
      return (
        data.notes !== undefined ||
        data.up_thresholds !== undefined ||
        data.down_thresholds !== undefined ||
        data.spot_alerts !== undefined ||
        data.status !== undefined ||
        data.closed_price !== undefined ||
        data.entry_price !== undefined ||
        data.quantity !== undefined
      );
    },
    { message: 'PATCH body must include at least one field to update' },
  );

export type ContractUpdateBody = z.infer<typeof contractUpdateSchema>;

// ============================================================
// Param schemas
// ============================================================

/**
 * Schema for the `id` path param + query coercion. Vercel hands the
 * dynamic segment to the handler as `req.query.id` (string), so we
 * coerce and re-validate as a positive integer here.
 */
export const trackerIdParamSchema = z.object({
  id: z.coerce.number().int().finite().positive(),
});

export type TrackerIdParam = z.infer<typeof trackerIdParamSchema>;

/**
 * Query params for GET /api/tracker/contracts.
 *
 * `status` defaults to 'active' to match the most common UI tab. The
 * three values map 1:1 to the DB CHECK constraint on tracker_contracts.
 */
export const trackerContractsListQuerySchema = z.object({
  status: z.enum(['active', 'closed', 'expired']).default('active'),
});

export type TrackerContractsListQuery = z.infer<
  typeof trackerContractsListQuerySchema
>;
