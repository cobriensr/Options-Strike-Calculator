/**
 * CharmClock — multi-ticker GEXBot net charm drift into the close.
 *
 * `zcharm` is GEXBot's net charm in $MM per hour (a rate, not a total),
 * with the vendor's sign convention: positive = the delta drift adds
 * passive bids (shown "▲ BUYS"), negative = passive offers ("▼ SELLS").
 * These are vendor-defined quantities, not a dealer-position claim.
 *
 * "By close" = zcharm × (hoursRemaining / SESSION_HOURS), displayed in
 * the same $MM/hr unit as a scaled rate. The scaling is an open owner
 * decision (a true remaining total would be zcharm × hoursRemaining), so
 * the math is unchanged here. The actionable read is the cross-ticker
 * ranking of |By close| plus the signed direction.
 *
 * The expiry each ticker's charm refers to is its own nearest listed
 * expiry (`min_dte`): 0DTE for SPX, but 2–3DTE for HYG/UVXY, etc.
 *
 * Spec: docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 */

import { memo, useMemo } from 'react';

import {
  useGexbotData,
  type SnapshotsLatestRow,
} from '../../hooks/useGexbotData';
import { formatHoursMinutes, useHoursToClose } from './session-clock';
import { formatDte } from './types';

interface CharmClockProps {
  marketOpen: boolean;
}

interface CharmRow {
  ticker: string;
  minDte: number | null;
  zcharm: number;
  byClose: number;
}

const SPEC = { view: 'snapshots-latest' as const };
const SESSION_HOURS = 6.5;
/** Minimum bar fill % so a tiny-but-nonzero value still produces a visible nub. */
const MIN_BAR_PCT = 4;
/**
 * The panel frame, shared by the table, the closed line and the loading and
 * empty notes. The error note keeps its own amber border and background: this
 * frame's neutral ones would fight them.
 */
const FRAME_CLASS = 'rounded-md border border-white/5 bg-white/[0.02]';
const CLOSED_LINE = 'Charm Clock: closed. By-close drift resumes at the open.';

/**
 * zcharm is already in $MM per hour. Keep ~3 significant digits across the
 * observed range (sub-1 ETF values to five-digit index values), with
 * thousands separators for the large end.
 */
function formatCharmPerHour(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) return '$0 MM/hr';
  const signed = value > 0 ? '+' : '−';
  let digits = 3;
  if (abs >= 100) digits = 0;
  else if (abs >= 10) digits = 1;
  else if (abs >= 0.01) digits = 2;
  const body = abs.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${signed}$${body} MM/hr`;
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
  // 0 while the market is closed. Hooks run before the closed early return.
  const hoursRemaining = useHoursToClose(marketOpen);

  const charmRows = useMemo<CharmRow[]>(() => {
    const sessionFraction = hoursRemaining / SESSION_HOURS;
    return rows
      .filter(
        (r): r is SnapshotsLatestRow & { zcharm: number } => r.zcharm != null,
      )
      .map((r) => ({
        ticker: r.ticker,
        minDte: r.minDte,
        zcharm: r.zcharm,
        byClose: r.zcharm * sessionFraction,
      }))
      .sort((a, b) => Math.abs(b.byClose) - Math.abs(a.byClose));
  }, [rows, hoursRemaining]);

  const maxAbsByClose = useMemo(
    () => charmRows.reduce((m, r) => Math.max(m, Math.abs(r.byClose)), 0),
    [charmRows],
  );

  // Outside regular hours there is no drift left to read: the hours remaining
  // are 0 and every By close would be $0. One line says so, in the panel's
  // frame, and wins over the loading, error and empty notes, none of which
  // describes a closed market.
  if (!marketOpen) {
    return (
      <div data-testid="charm-clock" className={FRAME_CLASS}>
        <p
          role="status"
          aria-live="polite"
          data-testid="charm-clock-closed"
          className="text-tertiary px-3 py-2 text-xs"
        >
          {CLOSED_LINE}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="charm-clock-loading"
        className={`text-tertiary px-3 py-2 text-xs ${FRAME_CLASS}`}
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
        className={`text-tertiary px-3 py-2 text-xs ${FRAME_CLASS}`}
      >
        Charm Clock — awaiting first GEXBot tick
      </div>
    );
  }

  return (
    <div data-testid="charm-clock" className={FRAME_CLASS}>
      <div className="text-tertiary flex items-baseline justify-between border-b border-white/5 px-3 py-2 text-[10px] tracking-wide uppercase">
        <span>Charm Clock — GEXBot net charm ($MM/hr)</span>
        <span>time to close: {formatHoursMinutes(hoursRemaining)}</span>
      </div>
      <table className="w-full text-left text-xs">
        <thead className="text-tertiary text-[10px] tracking-wide uppercase">
          <tr>
            <th className="px-3 py-1.5 font-medium">Ticker</th>
            <th className="px-3 py-1.5 text-right font-medium">Net charm</th>
            <th
              className="px-3 py-1.5 text-right font-medium"
              title="Scaled to remaining session; unit under review"
            >
              By close
            </th>
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
                <td className="px-3 py-1.5 font-medium">
                  {row.ticker}{' '}
                  <span
                    data-testid={`charm-dte-${row.ticker}`}
                    className="text-tertiary text-[10px] font-normal"
                  >
                    {formatDte(row.minDte)}
                  </span>
                </td>
                <td
                  data-testid={`charm-net-${row.ticker}`}
                  className="text-secondary px-3 py-1.5 text-right tabular-nums"
                >
                  {formatCharmPerHour(row.zcharm)}
                </td>
                <td
                  data-testid={`charm-by-close-${row.ticker}`}
                  className={`px-3 py-1.5 ${tone}`}
                >
                  <div className="flex items-center justify-end gap-2">
                    <span className="tabular-nums">
                      {formatCharmPerHour(row.byClose)}
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
