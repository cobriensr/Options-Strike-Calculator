/**
 * Zod schemas for the /api/periscope-* endpoint family (chat ingest,
 * list, detail, image fetch, inline-edit, lessons promote/archive).
 */

import { z } from 'zod';

// ============================================================
// /api/periscope-chat
// ============================================================

// Periscope images can be larger than analyze images because the heat
// maps capture wider strike ranges and the screenshots aren't always
// aggressively compressed. Per spec: 10MB per image, 30MB combined.
const MAX_PERISCOPE_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB in base64 chars
const MAX_PERISCOPE_TOTAL_SIZE = 30 * 1024 * 1024; // 30MB combined

export const periscopeImageSchema = z.object({
  kind: z.enum(['chart', 'gex', 'charm']),
  data: z
    .string()
    .min(1, 'Image data is required')
    .max(MAX_PERISCOPE_IMAGE_SIZE, 'Image too large. Maximum 10MB per image.'),
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
});

export const periscopeChatBodySchema = z
  .object({
    mode: z.enum(['pre_trade', 'intraday', 'debrief']),
    // 0 images is allowed — the handler synthesizes Pass 1A + Pass 1B
    // from `periscope_snapshots` + `cone_levels` for the requested slot
    // when the user submits without screenshots. See
    // api/_lib/periscope-synthesize.ts.
    images: z
      .array(periscopeImageSchema)
      .max(
        3,
        'Maximum 3 images allowed (chart + GEX heat map + charm heat map)',
      ),
    parentId: z.number().int().positive().finite().nullable().optional(),
    /**
     * The trading date the read is FOR (ISO YYYY-MM-DD). The backend
     * uses this to anchor the SPX spot lookup against
     * `index_candles_1m`. Distinct from `captured_at` which the server
     * stamps at request arrival.
     */
    read_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'read_date must be ISO YYYY-MM-DD'),
    /**
     * The wall-clock time the read is FOR, HH:MM 24-hour CT. The
     * backend converts (read_date, read_time, CT) into a TIMESTAMPTZ
     * for `read_time` persistence and queries `index_candles_1m` for
     * the matching SPX bar.
     */
    read_time: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'read_time must be HH:MM (24-hour CT)'),
    /**
     * Legacy alias for `read_date` retained for the existing back-read
     * UI override. Optional and additive.
     */
    tradingDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'tradingDate must be ISO YYYY-MM-DD')
      .optional(),
  })
  .refine(
    (body) => {
      const total = body.images.reduce((sum, img) => sum + img.data.length, 0);
      return total <= MAX_PERISCOPE_TOTAL_SIZE;
    },
    { message: 'Combined image size exceeds 30MB' },
  )
  .refine((body) => body.mode !== 'debrief' || body.parentId != null, {
    message:
      'Debrief mode requires a parent read id. Run a morning read first, then click "Debrief this" on it.',
    path: ['parentId'],
  })
  .refine((body) => body.mode !== 'intraday' || body.parentId != null, {
    message:
      "Intraday mode requires a parent read id (today's pre-trade or the last intraday).",
    path: ['parentId'],
  });

export type PeriscopeChatBody = z.infer<typeof periscopeChatBodySchema>;

// ============================================================
// /api/periscope-chat-list
// ============================================================

/**
 * GET /api/periscope-chat-list?limit=N&before=ID&date=YYYY-MM-DD.
 *
 * Cursor pagination on BIGSERIAL id (descending). `limit` defaults to
 * 20 and is capped at 100 so an unbounded request can't lock the
 * connection. `before` is optional — when omitted, the most recent N
 * rows. `date` is optional — when set, returns ALL rows for that
 * trading_date (still capped by `limit`), used by the history picker
 * to populate per-date time/run subpickers.
 */
export const periscopeChatListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.coerce.number().int().positive().finite().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
});

export type PeriscopeChatListQuery = z.infer<
  typeof periscopeChatListQuerySchema
>;

// ============================================================
// /api/periscope-chat-detail
// ============================================================

export const periscopeChatDetailQuerySchema = z.object({
  id: z.coerce.number().int().positive().finite(),
});

export type PeriscopeChatDetailQuery = z.infer<
  typeof periscopeChatDetailQuerySchema
>;

// ============================================================
// /api/periscope-chat-image
// ============================================================

/**
 * Query schema for GET /api/periscope-chat-image. Replaces the prior
 * ad-hoc regex validation in the handler with a single Zod schema for
 * consistency with sibling endpoints (Phase 6E folded fix).
 */
export const periscopeChatImageQuerySchema = z
  .object({
    id: z.coerce.number().int().positive().finite(),
    kind: z.enum(['chart', 'gex', 'charm']),
  })
  .strict();

export type PeriscopeChatImageQuery = z.infer<
  typeof periscopeChatImageQuerySchema
>;

// ============================================================
// /api/periscope-chat-update
// ============================================================

/**
 * PATCH/POST body for inline annotation edits. Both edit fields are
 * optional; the endpoint requires at least one set/clear directive to
 * be present.
 *
 * `calibration_quality` is the 1-5 star rating; `regime_tag` is the
 * fixed enum from the periscope skill (pin / drift-and-cap /
 * gap-and-rip / trap / cone-breach / chop / other).
 *
 * `clear` is an array of field names to explicitly null out. The
 * endpoint distinguishes "field omitted" (preserve existing) from
 * "field cleared" (set to null) via this list, since plain `null` in
 * JSON would round-trip ambiguously through Zod.
 */
export const periscopeChatUpdateBodySchema = z.object({
  calibration_quality: z.number().int().min(1).max(5).optional(),
  regime_tag: z
    .enum([
      'pin',
      'drift-and-cap',
      'gap-and-rip',
      'trap',
      'cone-breach',
      'chop',
      'other',
    ])
    .optional(),
  clear: z
    .array(z.enum(['regime_tag', 'calibration_quality']))
    .max(2)
    .optional(),
});

export type PeriscopeChatUpdateBody = z.infer<
  typeof periscopeChatUpdateBodySchema
>;

// ============================================================
// /api/periscope-lessons-update
// ============================================================

/**
 * POST body for the LessonLibrary panel's promote / archive / unarchive
 * actions. Mirrors the manual SQL workflow that shipped pre-MVP:
 *
 *   - `promote`   — proposed/active row → status='active' + promoted_at=now()
 *   - `archive`   — any non-archived row → status='archived' + archived_at=now()
 *   - `unarchive` — archived row → status='proposed', clear both timestamps
 *
 * The endpoint enforces the state-machine guards in handler logic
 * (Zod just validates the action enum + the id shape).
 */
export const periscopeLessonsUpdateBodySchema = z.object({
  id: z.number().int().positive(),
  action: z.enum(['promote', 'archive', 'unarchive']),
});

export type PeriscopeLessonsUpdateBody = z.infer<
  typeof periscopeLessonsUpdateBodySchema
>;
