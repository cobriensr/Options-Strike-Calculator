/**
 * Shared pieces of the fetch-boundary guard in the response-validating
 * hooks (useHistoryData, useOpeningFlowSignal, usePinSetupStatus,
 * useGreekHeatmap). A 200 whose body is not JSON, or fails the hook's Zod
 * schema, is handled like a failed fetch and reported to Sentry.
 *
 * Spec: docs/superpowers/specs/panel-payload-guards-2026-10-28.md
 */

/** The error a hook exposes when the body fails its schema. */
export const INVALID_SHAPE_ERROR = 'invalid response shape';

/** The error a hook exposes when a 2xx body is not JSON at all. */
export const NOT_JSON_ERROR = 'invalid response (not JSON)';

/** Most issues listed in one Sentry event; `issueCount` has the total. */
const MAX_REPORTED_ISSUES = 20;

interface IssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/**
 * Zod issues as flat `"path: message"` strings for a Sentry context.
 * Sentry normalizes contexts at depth 3, so the issue objects themselves
 * would arrive as "[Object]".
 */
export function summarizeZodIssues(issues: readonly IssueLike[]): {
  issues: string[];
  issueCount: number;
} {
  return {
    issues: issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
      const path =
        issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
      return `${path}: ${issue.message}`;
    }),
    issueCount: issues.length,
  };
}

/**
 * Report latch for a polling hook, so a request that keeps failing the
 * same way sends one Sentry event, not one per poll. Returns true, and
 * records `key`, when `key` differs from the last reported one; false for
 * a repeat. Key it on the request (its date, or `'live'`), and set
 * `latch.current = null` after a good response so the next failure
 * reports again.
 */
export function claimReport(
  latch: { current: string | null },
  key: string,
): boolean {
  if (latch.current === key) return false;
  latch.current = key;
  return true;
}
