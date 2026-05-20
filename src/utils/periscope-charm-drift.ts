/**
 * Periscope charm-drift read — pure helper that maps the latest scraped
 * charm tally into three human-readable lines (position, drift, weight)
 * with theme colors. Used by the CharmSection of the Periscope panel.
 *
 * Extracted from PeriscopePanel.tsx during the Phase 3A decomposition
 * (2026-05-19) so the time-of-day bucketing and noise-threshold logic
 * can be unit-tested without rendering React.
 *
 * Framework recap:
 *   - Charm is a function of time-to-expiry — its hedging force grows
 *     non-linearly through the session and dominates the final 90 min.
 *   - A positive tally ⇒ mechanical /ES BUY into close (drift up).
 *   - A negative tally ⇒ mechanical /ES SELL into close (drift down).
 *   - Sub-noise tallies are surfaced as "flat" so the reader doesn't
 *     overweight micro-readings.
 *   - Post-close slots freeze on a terminal/expiry charm value that no
 *     longer predicts intraday drift — surfaced explicitly.
 */

import { theme } from '../themes/index.js';
import { getCTTime } from './timezone.js';
import { fmtSigned } from './periscope-formatting.js';

/** Charm-tally magnitude under which we treat the tally as "noise"
 *  rather than directional drift. Matches the threshold used by
 *  computeTradePlan. */
export const CHARM_DRIFT_NOISE_THRESHOLD = 1_000_000;

export interface CharmDriftRead {
  position: { text: string; color: string };
  drift: { text: string; color: string };
  weight: { text: string; color: string };
}

export function computeCharmDriftRead(args: {
  spot: number;
  charmZeroStrike: number;
  tallyWide100: number;
  capturedAt: string;
}): CharmDriftRead {
  const { spot, charmZeroStrike, tallyWide100, capturedAt } = args;

  const distance = spot - charmZeroStrike;
  const absDist = Math.abs(distance);
  let positionText: string;
  if (absDist < 1) {
    positionText = `Spot pinned at charm-zero (${charmZeroStrike})`;
  } else if (distance > 0) {
    positionText = `Spot ${absDist.toFixed(0)} pts above charm-zero (${charmZeroStrike})`;
  } else {
    positionText = `Spot ${absDist.toFixed(0)} pts below charm-zero (${charmZeroStrike})`;
  }

  // Time-of-day weight class. Buckets match the user's 5-phase intraday
  // schedule.
  const ct = getCTTime(new Date(capturedAt));
  const minutes = ct.hour * 60 + ct.minute;
  const isPostClose = minutes >= 15 * 60;

  let driftText: string;
  let driftColor: string;
  if (isPostClose) {
    // Post-close slots freeze on a terminal/expiry charm value that no
    // longer predicts intraday drift — surface that instead of the
    // active "drift up/down" line that would otherwise be misleading.
    driftText = `Tally ${fmtSigned(tallyWide100)} → aftermarket reading, not applicable to intraday price movement`;
    driftColor = theme.textMuted;
  } else if (Math.abs(tallyWide100) < CHARM_DRIFT_NOISE_THRESHOLD) {
    driftText = `Tally ${fmtSigned(tallyWide100)} → flat, no mechanical drift`;
    driftColor = theme.textMuted;
  } else if (tallyWide100 >= 0) {
    driftText = `Tally ${fmtSigned(tallyWide100)} → mechanical /ES BUY into close (drift up)`;
    driftColor = theme.green;
  } else {
    driftText = `Tally ${fmtSigned(tallyWide100)} → mechanical /ES SELL into close (drift down)`;
    driftColor = theme.red;
  }

  let weightText: string;
  let weightColor: string;
  if (minutes < 8 * 60 + 30) {
    weightText = 'Pre-market — charm impact minimal';
    weightColor = theme.textMuted;
  } else if (minutes < 10 * 60 + 30) {
    weightText = 'Morning — gamma dominates, charm light';
    weightColor = theme.textMuted;
  } else if (minutes < 13 * 60) {
    weightText = 'Midday — charm building, dual-force';
    weightColor = theme.textSecondary;
  } else if (minutes < 14 * 60 + 30) {
    weightText = 'Charm window — mechanical drift dominates';
    weightColor = theme.text;
  } else if (minutes < 15 * 60) {
    weightText = 'Final 30m — pin / acceleration';
    weightColor = theme.accent;
  } else {
    weightText = 'Post-close';
    weightColor = theme.textMuted;
  }

  return {
    position: { text: positionText, color: theme.textSecondary },
    drift: { text: driftText, color: driftColor },
    weight: { text: weightText, color: weightColor },
  };
}
