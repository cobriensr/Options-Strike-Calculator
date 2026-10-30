/**
 * DexoflowVelocityTape — per-ticker minute-over-minute change in taker
 * exposure. (Legacy name: the tape used to show the vendor's
 * dexoflow / gexoflow / cvroflow scalars, which are the change over ONE 1-2 s
 * vendor step sampled once a minute, so 70-99% of values were exact zeros on
 * the smaller tickers. Owner decision D4 replaced them.)
 *
 * Columns, differenced server-side with a SQL window (`view=velocity`):
 *   Δ agg_dex — session-cumulative taker delta, so its minute difference is
 *               the taker delta flow over the last minute;
 *   Δ zgr     — change in the call − put GEX imbalance;
 *   Δ zcvr    — change in net convexity.
 *
 * A dash means the change is unavailable (first minute of the session, a gap
 * of more than 3 minutes, or the vendor repeating its prior source
 * timestamp) — not a zero. Rows are ranked by |Δ agg_dex| against the
 * ticker's own median minute change (see velocity-tape.ts), never by a raw
 * sum of mixed units. Futures views (ES_SPX / NQ_NDX) are excluded: they
 * duplicate SPX / NDX.
 *
 * Each cell shows the value with a trend arrow (▲/▼/─) from its sign.
 * Each row shows the ticker's own DTE from `min_dte`.
 *
 * Spec: docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 */

import { memo, useMemo } from 'react';

import { useGexbotData } from '../../hooks/useGexbotData';
import { GEXBOT_FUTURES_VIEWS } from './ticker-order';
import { formatDte } from './types';
import { sortVelocityRows } from './velocity-tape';

interface DexoflowVelocityTapeProps {
  marketOpen: boolean;
}

const SPEC = { view: 'velocity' as const };
const FUTURES_VIEWS: readonly string[] = GEXBOT_FUTURES_VIEWS;

function arrow(value: number | null): { glyph: string; cls: string } {
  if (value == null) return { glyph: '·', cls: 'text-tertiary' };
  if (value > 0) return { glyph: '▲', cls: 'text-emerald-300' };
  if (value < 0) return { glyph: '▼', cls: 'text-rose-300' };
  return { glyph: '─', cls: 'text-tertiary' };
}

function formatScalar(value: number | null): string {
  if (value == null) return '—';
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '−';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(2)}K`;
  if (abs >= 1) return `${sign}${abs.toFixed(2)}`;
  return `${sign}${abs.toFixed(4)}`;
}

function DexoflowVelocityTapeInner({ marketOpen }: DexoflowVelocityTapeProps) {
  const { rows, loading, error } = useGexbotData(SPEC, marketOpen);

  const velocityRows = useMemo(
    () =>
      sortVelocityRows(rows.filter((r) => !FUTURES_VIEWS.includes(r.ticker))),
    [rows],
  );

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="dexoflow-tape-loading"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        Dexoflow Velocity — loading…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="dexoflow-tape-error"
        className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/80"
      >
        Dexoflow Velocity — {error}
      </div>
    );
  }

  if (velocityRows.length === 0) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="dexoflow-tape-empty"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        Dexoflow Velocity — awaiting first GEXBot tick
      </div>
    );
  }

  return (
    <div
      data-testid="dexoflow-tape"
      className="rounded-md border border-white/5 bg-white/[0.02]"
    >
      <div className="text-tertiary border-b border-white/5 px-3 py-2 text-[10px] tracking-wide uppercase">
        Velocity — taker change over the last minute, DTE per ticker
      </div>
      <table className="w-full text-left text-xs">
        <thead className="text-tertiary text-[10px] tracking-wide uppercase">
          <tr>
            <th className="px-3 py-1.5 font-medium">Ticker</th>
            <th className="px-3 py-1.5 text-right font-medium">
              Taker Δ flow / min
            </th>
            <th className="px-3 py-1.5 text-right font-medium">
              Call−put GEX Δ / min
            </th>
            <th className="px-3 py-1.5 text-right font-medium">
              Net convexity Δ / min
            </th>
          </tr>
        </thead>
        <tbody>
          {velocityRows.map((row) => (
            <tr key={row.ticker} className="border-t border-white/5">
              <td className="px-3 py-1.5 font-medium">
                {row.ticker}
                <span className="text-tertiary ml-1.5 text-[10px] font-normal">
                  {formatDte(row.minDte)}
                </span>
              </td>
              <Cell value={row.dAggDex} />
              <Cell value={row.dZgr} />
              <Cell value={row.dZcvr} />
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-tertiary border-t border-white/5 px-3 py-1.5 text-[10px]">
        Δ = this minute minus the last. — means no clean prior minute. Sorted by
        taker Δ flow against each ticker&rsquo;s own typical minute.
      </p>
    </div>
  );
}

function Cell({ value }: { value: number | null }) {
  const { glyph, cls } = arrow(value);
  const verdict =
    value == null
      ? 'no data'
      : value > 0
        ? 'positive'
        : value < 0
          ? 'negative'
          : 'flat';
  const ariaLabel = `${verdict} ${formatScalar(value)}`;
  return (
    <td className="px-3 py-1.5 text-right tabular-nums">
      <span className={cls} aria-label={ariaLabel}>
        <span className="mr-1.5" aria-hidden>
          {glyph}
        </span>
        {formatScalar(value)}
      </span>
    </td>
  );
}

export const DexoflowVelocityTape = memo(DexoflowVelocityTapeInner);
