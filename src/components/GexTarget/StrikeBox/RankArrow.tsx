/**
 * RankArrow — visual indicator for how a strike's leaderboard position
 * shifted since the previous snapshot.
 *
 * - `new`  : just entered the top 5 (purple "NEW" badge)
 * - `up`   : moved up N spots (green ↑N)
 * - `down` : moved down N spots (red ↓N)
 * - `same` : unchanged (muted em-dash)
 *
 * The numeric `delta` is positive when the strike improved (i.e., `prevRank
 * - currentRank`), so callers can pass it through unchanged for the up/down
 * cases. `Math.abs` is used for the down label to drop the leading minus.
 */

import { theme } from '../../../themes';

export interface RankChangeInfo {
  type: 'new' | 'up' | 'down' | 'same';
  /** Positions improved (positive) or worsened (negative). Zero for same/new. */
  delta: number;
}

export function RankArrow({ info }: Readonly<{ info: RankChangeInfo }>) {
  if (info.type === 'new')
    return (
      <span
        style={{ color: '#7c7cff', fontSize: 9, fontWeight: 700 }}
        aria-label="New entry"
      >
        NEW
      </span>
    );
  if (info.type === 'up')
    return (
      <span
        style={{ color: theme.green }}
        aria-label={`Rank improved by ${info.delta}`}
      >
        ↑{info.delta}
      </span>
    );
  if (info.type === 'down')
    return (
      <span
        style={{ color: theme.red }}
        aria-label={`Rank worsened by ${Math.abs(info.delta)}`}
      >
        ↓{Math.abs(info.delta)}
      </span>
    );
  return (
    <span style={{ color: theme.textMuted }} aria-label="Rank unchanged">
      &mdash;
    </span>
  );
}
