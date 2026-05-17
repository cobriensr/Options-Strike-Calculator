/**
 * CharmClock — multi-ticker projected dealer-hedging drift to close.
 *
 * 0DTE charm (`zcharm`) measures how much dollar delta will bleed off
 * as time passes. If a dealer is delta-neutral now, that drift forces
 * a mechanical hedge between now and close — predicting the direction
 * of expected intraday flow.
 *
 * Projection formula (v0, scale uncalibrated):
 *   projected_delta_dollars = zcharm × (hours_remaining / 6.5)
 *   projected_drift_pct     = projected_delta_dollars / (spot × 1e9)
 *
 * The 6.5 hours = full SPX session. 1e9 is a rough scale we'll
 * recalibrate after the first week of data by regressing projected
 * vs realized drift. The numbers are heuristic until then; the relative
 * ordering across tickers is the actionable signal.
 *
 * Spec: docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 */

import { memo, useMemo } from 'react';

import { getETToday, getETCloseUtcIso } from '../../utils/timezone';
import {
  useGexbotData,
  type SnapshotsLatestRow,
} from '../../hooks/useGexbotData';

interface CharmClockProps {
  marketOpen: boolean;
}

interface CharmRow {
  ticker: string;
  zcharm: number;
  spot: number | null;
  projectedDriftPct: number | null;
}

const SPEC = { view: 'snapshots-latest' as const };
const SESSION_HOURS = 6.5;
const SCALE = 1e9;

function hoursToClose(now: Date): number {
  const today = getETToday();
  const closeIso = getETCloseUtcIso(today);
  if (!closeIso) return 0;
  const ms = new Date(closeIso).getTime() - now.getTime();
  return Math.max(0, ms / 3_600_000);
}

function projectDrift(
  zcharm: number,
  spot: number | null,
  hoursRemaining: number,
): number | null {
  if (spot == null || spot <= 0) return null;
  const deltaDollars = zcharm * (hoursRemaining / SESSION_HOURS);
  return deltaDollars / (spot * SCALE);
}

function formatHoursMinutes(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

function formatDriftPct(pct: number | null): string {
  if (pct == null) return '—';
  const signed = pct >= 0 ? '+' : '';
  return `${signed}${(pct * 100).toFixed(3)}%`;
}

function formatCharm(value: number): string {
  // Render dollar-charm in M (millions). Sign included.
  const millions = value / 1_000_000;
  const signed = millions >= 0 ? '+' : '';
  return `${signed}$${millions.toFixed(1)}M`;
}

function CharmClockInner({ marketOpen }: CharmClockProps) {
  const { rows, loading, error } = useGexbotData(SPEC, marketOpen);
  const hoursRemaining = useMemo(() => hoursToClose(new Date()), []);

  const charmRows = useMemo<CharmRow[]>(() => {
    return rows
      .filter(
        (r): r is SnapshotsLatestRow & { zcharm: number } => r.zcharm != null,
      )
      .map((r) => ({
        ticker: r.ticker,
        zcharm: r.zcharm,
        spot: r.spot,
        projectedDriftPct: projectDrift(r.zcharm, r.spot, hoursRemaining),
      }))
      .sort(
        (a, b) =>
          Math.abs(b.projectedDriftPct ?? 0) -
          Math.abs(a.projectedDriftPct ?? 0),
      );
  }, [rows, hoursRemaining]);

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="charm-clock-loading"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        Charm Clock — loading…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="charm-clock-error"
        className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/80"
      >
        Charm Clock — {error}
      </div>
    );
  }

  if (charmRows.length === 0) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="charm-clock-empty"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        Charm Clock — awaiting first GEXBot tick
      </div>
    );
  }

  return (
    <div
      data-testid="charm-clock"
      className="rounded-md border border-white/5 bg-white/[0.02]"
    >
      <div className="text-tertiary flex items-baseline justify-between border-b border-white/5 px-3 py-2 text-[10px] tracking-wide uppercase">
        <span>Charm Clock — 0DTE hedge drift</span>
        <span>time to close: {formatHoursMinutes(hoursRemaining)}</span>
      </div>
      <table className="w-full text-left text-xs">
        <thead className="text-tertiary text-[10px] tracking-wide uppercase">
          <tr>
            <th className="px-3 py-1.5 font-medium">Ticker</th>
            <th className="px-3 py-1.5 text-right font-medium">Net charm</th>
            <th className="px-3 py-1.5 text-right font-medium">
              Projected drift
            </th>
          </tr>
        </thead>
        <tbody>
          {charmRows.map((row) => {
            const driftClass =
              row.projectedDriftPct == null
                ? 'text-tertiary'
                : row.projectedDriftPct > 0
                  ? 'text-emerald-300'
                  : 'text-rose-300';
            return (
              <tr key={row.ticker} className="border-t border-white/5">
                <td className="px-3 py-1.5 font-medium">{row.ticker}</td>
                <td className="text-secondary px-3 py-1.5 text-right tabular-nums">
                  {formatCharm(row.zcharm)}
                </td>
                <td
                  className={`px-3 py-1.5 text-right tabular-nums ${driftClass}`}
                >
                  {formatDriftPct(row.projectedDriftPct)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-tertiary px-3 py-2 text-[10px] italic">
        Drift formula uncalibrated — relative ordering across tickers is the
        signal; absolute % needs first-week regression.
      </p>
    </div>
  );
}

export const CharmClock = memo(CharmClockInner);
