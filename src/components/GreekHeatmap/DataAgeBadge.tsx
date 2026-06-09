/**
 * Always-on data-freshness indicator for the Greek Heatmap section header.
 *
 * Renders a subtle, muted "as of {time} CT" label showing the snapshot
 * timestamp (Central Time) whenever there's a snapshot to display — live,
 * scrubbed, or post-close/historical. This is intentionally understated so
 * it does not compete with the PriceChip / RegimeChip and is distinct from
 * the amber "⚠ Stale" badge (which only appears on a failed poll).
 *
 * Renders nothing when there's no parseable timestamp, so we never show
 * "as of  CT" with an empty time.
 */

import { formatTimeCT } from '../../utils/component-formatters';

interface DataAgeBadgeProps {
  asOf: string | null;
}

export function DataAgeBadge({ asOf }: DataAgeBadgeProps) {
  if (asOf == null || asOf === '') return null;

  const time = formatTimeCT(asOf);
  if (time === '') return null;

  return (
    <span
      className="text-[10px] text-neutral-400 tabular-nums"
      title="Snapshot timestamp (Central Time)"
    >
      as of {time} CT
    </span>
  );
}
