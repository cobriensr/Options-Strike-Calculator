/**
 * Zod schemas for /api/flow-regime (Flow Regime Recognition badge).
 */

import { z } from 'zod';

/**
 * Query params for GET /api/flow-regime.
 *
 * - `date`: optional YYYY-MM-DD ET trading day (defaults to ET-today).
 *   Lets the badge replay a historical day's slot series for
 *   dev/testing without waiting for the live window.
 */
export const flowRegimeQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
});

export type FlowRegimeQuery = z.infer<typeof flowRegimeQuerySchema>;
