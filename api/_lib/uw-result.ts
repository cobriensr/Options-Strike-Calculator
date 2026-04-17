/**
 * Discriminated-union result type for Unusual Whales API fetchers.
 *
 * Callers need to distinguish three outcomes — a quiet market (no data
 * legitimately returned), an API failure (network / non-OK), and a
 * successful fetch with real data. Collapsing all three into `[]` silently
 * drops failed-fetch signals from Claude's context, so the model can't
 * tell "nothing institutional happening" from "the data pipeline is down."
 */
export type UwFetchOutcome<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'empty' }
  | { kind: 'error'; reason: string };
