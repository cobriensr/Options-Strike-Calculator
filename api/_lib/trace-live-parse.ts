/**
 * JSON-extraction + Zod-validation helper for /api/trace-live-analyze
 * model responses. Extracted into its own module so the parsing path is
 * unit-testable without spinning up the whole endpoint handler.
 *
 * Claude often wraps JSON output in markdown fences (```json ... ```)
 * even when instructed not to — this helper strips those before parsing.
 */

import logger from './logger.js';
import { traceAnalysisSchema, type TraceAnalysis } from './trace-live-types.js';

/**
 * Parse a model text response into a validated `TraceAnalysis`. Returns
 * `null` on any failure (JSON parse error, schema mismatch, empty input).
 * Logs warnings on schema mismatch and errors on JSON parse failure so
 * upstream callers don't have to.
 */
export function parseAndValidateTraceAnalysis(
  text: string,
): TraceAnalysis | null {
  if (!text) return null;
  try {
    const trimmed = text.trim();
    const jsonStr = trimmed.startsWith('```')
      ? trimmed.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
      : trimmed;
    const parsed: unknown = JSON.parse(jsonStr);
    const validated = traceAnalysisSchema.safeParse(parsed);
    if (validated.success) return validated.data;
    logger.warn(
      { issues: validated.error.issues.slice(0, 5) },
      'TraceAnalysis schema mismatch — returning null',
    );
    return null;
  } catch (err) {
    logger.error(
      { err, raw: text.slice(0, 500) },
      'TraceAnalysis JSON parse failed',
    );
    return null;
  }
}
