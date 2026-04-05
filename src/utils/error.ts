/**
 * Extract a human-readable message from an unknown error value.
 * Standardizes the various catch(err) patterns across hooks.
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'An unexpected error occurred';
}
