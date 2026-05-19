/**
 * CharmClock — multi-ticker dealer-hedging direction for the 0DTE close.
 *
 * `zcharm` is GEXBot's net 0DTE charm, signed. The sign tells the direction
 * dealers must mechanically hedge as charm decays into the bell:
 *   +zcharm → dealers BUY to stay delta-neutral  → lifts price into close
 *   −zcharm → dealers SELL to stay delta-neutral → drags price into close
 *
 * "By close" = zcharm × (hoursRemaining / SESSION_HOURS) — the portion
 * of today's charm that has not yet decayed. Reported in the same unit as
 * net charm: we do not have a defensible conversion from zcharm to a
 * realized % move, so we do not fabricate one. The actionable read is the
 * cross-ticker ranking of |By close| plus the signed direction — biggest
 * mover is where hedging pressure is strongest, and SPX↔SPY↔QQQ direction
 * agreement confirms regime.
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
  byClose: number;
}

const SPEC = { view: 'snapshots-latest' as const };
const SESSION_HOURS = 6.5;
/** Minimum bar fill % so a tiny-but-nonzero value still produces a visible nub. */
const MIN_BAR_PCT = 4;

function hoursToClose(now: Date): number {
  const today = getETToday();
  const closeIso = getETCloseUtcIso(today);
  if (!closeIso) return 0;
  const ms = new Date(closeIso).getTime() - now.getTime();
  return Math.max(0, ms / 3_600_000);
}

function formatHoursMinutes(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

function formatCharm(value: number): string {
  // Auto-scale: GEXBot's zcharm can swing from small-ETF values
  // (sub-thousand $) to index values (millions). A single fixed unit
  // collapses most values to "$0.0M". Pick the unit that keeps two
  // significant digits visible — preserves the relative ordering signal
  // across very different magnitudes.
  const abs = Math.abs(value);
  const signed = value >= 0 ? '+' : '−';
  if (abs >= 1_000_000) return `${signed}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${signed}$${(abs / 1_000).toFixed(2)}K`;
  if (abs >= 1) return `${signed}$${abs.toFixed(2)}`;
  if (abs > 0) return `${signed}$${abs.toFixed(4)}`;
  return '$0';
}

function biasLabel(byClose: number): string {
  if (byClose > 0) return '▲ BUYS';
  if (byClose < 0) return '▼ SELLS';
  return '— FLAT';
}

function toneClass(byClose: number): string {
  if (byClose > 0) return 'text-emerald-300';
  if (byClose < 0) return 'text-rose-300';
  return 'text-tertiary';
}

function CharmClockInner({ marketOpen }: CharmClockProps) {
  const { rows, loading, error } = useGexbotData(SPEC, marketOpen);
  const hoursRemaining = useMemo(() => hoursToClose(new Date()), []);

  const charmRows = useMemo<CharmRow[]>(() => {
    const sessionFraction = hoursRemaining / SESSION_HOURS;
    return rows
      .filter(
        (r): r is SnapshotsLatestRow & { zcharm: number } => r.zcharm != null,
      )
      .map((r) => ({
        ticker: r.ticker,
        zcharm: r.zcharm,
        byClose: r.zcharm * sessionFraction,
      }))
      .sort((a, b) => Math.abs(b.byClose) - Math.abs(a.byClose));
  }, [rows, hoursRemaining]);

  const maxAbsByClose = useMemo(
    () => charmRows.reduce((m, r) => Math.max(m, Math.abs(r.byClose)), 0),
    [charmRows],
  );

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
            <th className="px-3 py-1.5 text-right font-medium">By close</th>
            <th className="px-3 py-1.5 text-right font-medium">EOD bias</th>
          </tr>
        </thead>
        <tbody>
          {charmRows.map((row) => {
            const tone = toneClass(row.byClose);
            const barColor =
              row.byClose > 0
                ? 'bg-emerald-400/50'
                : row.byClose < 0
                  ? 'bg-rose-400/50'
                  : 'bg-white/10';
            const barPct =
              maxAbsByClose > 0 && row.byClose !== 0
                ? Math.max(
                    MIN_BAR_PCT,
                    (Math.abs(row.byClose) / maxAbsByClose) * 100,
                  )
                : 0;
            return (
              <tr key={row.ticker} className="border-t border-white/5">
                <td className="px-3 py-1.5 font-medium">{row.ticker}</td>
                <td className="text-secondary px-3 py-1.5 text-right tabular-nums">
                  {formatCharm(row.zcharm)}
                </td>
                <td
                  data-testid={`charm-by-close-${row.ticker}`}
                  className={`px-3 py-1.5 ${tone}`}
                >
                  <div className="flex items-center justify-end gap-2">
                    <span className="tabular-nums">
                      {formatCharm(row.byClose)}
                    </span>
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-12 overflow-hidden rounded-sm bg-white/5"
                    >
                      <span
                        className={`block h-full ${barColor}`}
                        style={{ width: `${barPct}%` }}
                      />
                    </span>
                  </div>
                </td>
                <td
                  data-testid={`charm-bias-${row.ticker}`}
                  className={`px-3 py-1.5 text-right text-[11px] font-medium tabular-nums ${tone}`}
                >
                  {biasLabel(row.byClose)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const CharmClock = memo(CharmClockInner);
