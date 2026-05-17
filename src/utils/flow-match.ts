/**
 * flow-match — does an alert's option type agree with the ticker's
 * current cumulative net-flow delta?
 *
 * Used by the Flow Match / Flow Mismatch badge on Lottery + SilentBoom
 * rows. The rule is:
 *   - Call alert with cumNcp > cumNpp  → match (bulls own this tape)
 *   - Put alert  with cumNpp > cumNcp  → match (bears own this tape)
 *   - Equal or both null               → flat / unknown (no badge)
 *
 * Kept as a pure function so it can be unit-tested independently of
 * the polling hook, and so both the Match badge and the Inverted badge
 * (Phase 5) can call into the same primitive without duplication.
 */

export type FlowMatchState =
  /** Direction of net flow agrees with the alert's option type. */
  | 'match'
  /** Direction disagrees. */
  | 'mismatch'
  /** Flow is flat (NCP === NPP) — no directional bias. */
  | 'flat'
  /** Snapshot is unavailable for this ticker (cold start or off-WS). */
  | 'unknown';

export function computeFlowMatch(
  optionType: 'C' | 'P',
  cumNcp: number | null | undefined,
  cumNpp: number | null | undefined,
): FlowMatchState {
  if (cumNcp == null || cumNpp == null) return 'unknown';
  // Treat NaN as unknown — a corrupt upstream value should not
  // misleadingly render as Mismatch via the NaN < 0 fallthrough.
  if (!Number.isFinite(cumNcp) || !Number.isFinite(cumNpp)) return 'unknown';
  const delta = cumNcp - cumNpp;
  if (delta === 0) return 'flat';
  // For a call: positive delta = match (NCP exceeds NPP).
  // For a put:  negative delta = match (NPP exceeds NCP).
  if (optionType === 'C') return delta > 0 ? 'match' : 'mismatch';
  return delta < 0 ? 'match' : 'mismatch';
}
