/**
 * RollingStatsBar — compact rolling stats strip at the top of the
 * Gamma-Node Composite Detector tile.
 *
 * Phase 3b of docs/superpowers/specs/gamma-node-composite-detector-2026-05-21.md.
 *
 * Shows three numbers side-by-side over a user-selectable trailing
 * window (7/14/30/60/90 days):
 *
 *   [7d | 14d | 30d | 60d | 90d]   18 fires • 67% win • +6.4 pts mean
 *
 * No journal UI — these stats are derived entirely from the EOD-backfill
 * cron's auto-filled ret_30m column. The user toggles the window button
 * group; everything else updates on its own.
 *
 * A CSV-export anchor lives at the right edge so the user can pull the
 * raw data into their own journal without us re-implementing one.
 */

import { memo, useState } from 'react';

import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import {
  useGammaWeeklyStats,
  type WindowDays,
} from '../../hooks/useGammaWeeklyStats';

const WINDOWS: ReadonlyArray<WindowDays> = [7, 14, 30, 60, 90];

interface RollingStatsBarProps {
  marketOpen: boolean;
}

function formatWinRate(rate: number | null): string {
  if (rate == null) return '— win';
  return `${(rate * 100).toFixed(0)}% win`;
}

function formatMeanEdge(pts: number | null): string {
  if (pts == null) return '— pts mean';
  const sign = pts >= 0 ? '+' : '';
  return `${sign}${pts.toFixed(1)} pts mean`;
}

function meanEdgeColor(pts: number | null): string {
  if (pts == null) return theme.textMuted;
  return pts >= 0 ? theme.green : theme.red;
}

export const RollingStatsBar = memo(function RollingStatsBar({
  marketOpen,
}: RollingStatsBarProps) {
  const [days, setDays] = useState<WindowDays>(30);
  const { data, loading, error } = useGammaWeeklyStats(days, marketOpen);

  const exportHref = `/api/gamma-setups/export?from=${data?.from ?? ''}&to=${data?.to ?? ''}&format=csv`;

  return (
    <div className="border-edge bg-surface-alt mb-3 flex flex-wrap items-center gap-2.5 rounded-[10px] border p-3">
      <span className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
        Last
      </span>
      <fieldset className="flex gap-1 border-0 p-0">
        <legend className="sr-only">Window length</legend>
        {WINDOWS.map((d) => {
          const active = d === days;
          return (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              aria-pressed={active}
              className={
                'rounded px-2 py-0.5 font-mono text-[10px] font-semibold transition-colors ' +
                (active ? 'text-primary' : 'text-muted hover:text-primary')
              }
              style={
                active
                  ? {
                      backgroundColor: tint(theme.accent, '18'),
                      color: theme.accent,
                    }
                  : undefined
              }
            >
              {d}d
            </button>
          );
        })}
      </fieldset>

      {error != null && (
        <span
          className="font-mono text-[10px]"
          style={{ color: theme.red }}
          title={error}
        >
          stats error
        </span>
      )}

      {data != null && (
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-primary font-mono text-[11px] font-semibold">
            {data.n_total} fire{data.n_total === 1 ? '' : 's'}
          </span>
          <span
            className="text-muted font-mono text-[10px]"
            title={
              data.n_with_outcome === data.n_total
                ? 'All outcomes resolved'
                : `${data.n_total - data.n_with_outcome} fires still awaiting +30m backfill`
            }
          >
            ({data.n_with_outcome} outcomes)
          </span>
          <span
            className="font-mono text-[11px] font-semibold"
            style={{
              color:
                data.win_rate != null && data.win_rate >= 0.6
                  ? theme.green
                  : data.win_rate != null && data.win_rate < 0.55
                    ? theme.red
                    : theme.text,
            }}
          >
            {formatWinRate(data.win_rate)}
          </span>
          <span
            className="font-mono text-[11px] font-semibold"
            style={{ color: meanEdgeColor(data.mean_edge_pts) }}
          >
            {formatMeanEdge(data.mean_edge_pts)}
          </span>
        </div>
      )}

      {data == null && loading && (
        <span className="text-muted font-mono text-[10px]">loading…</span>
      )}

      <a
        href={exportHref}
        className="text-muted hover:text-primary ml-auto font-mono text-[10px] underline"
        title="Download the underlying fires + outcomes as CSV"
        download
      >
        export csv
      </a>
    </div>
  );
});
