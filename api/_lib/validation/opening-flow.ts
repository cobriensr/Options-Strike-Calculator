/**
 * Zod schemas for /api/opening-flow-signal.
 */

import { z } from 'zod';

/**
 * Query params for GET /api/opening-flow-signal.
 *
 * - `date`: optional YYYY-MM-DD trading day (defaults to ET-today).
 *   Lets us replay historical days for dev/testing without waiting
 *   for the live window.
 */
export const openingFlowSignalQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
});

export type OpeningFlowSignalQuery = z.infer<
  typeof openingFlowSignalQuerySchema
>;
