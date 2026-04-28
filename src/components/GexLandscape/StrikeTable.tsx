/**
 * StrikeTable — sticky-header + scrollable grid of strikes within the
 * display window, with per-strike classification, signal, GEX, multi-window
 * Δ% (1m/5m/10m/15m/30m), charm, and vol reinforcement cells. The ATM row is
 * ref-tagged so the parent can scroll it into view on initial load.
 */

import type { Ref } from 'react';
import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';
import { CLASS_META, CLS_TOOLTIP } from './constants';
import {
  charmTooltip,
  classify,
  getDirection,
  signalTooltip,
} from './classify';
import { fmtGex, fmtPct } from './formatters';

/**
 * Strike | Classification | Signal | Net GEX
 *   | 1m Δ% | 5m Δ% | 10m Δ% | 15m Δ% | 30m Δ% | Charm | Vol
 */
const COLS =
  'grid-cols-[76px_130px_1fr_88px_64px_64px_64px_64px_64px_76px_56px]';

export interface StrikeTableProps {
  rows: GexStrikeLevel[];
  currentPrice: number;
  spotStrike: GexStrikeLevel | null;
  maxChanged1mStrike: number | null;
  maxChanged5mStrike: number | null;
  gexDeltaMap: Map<number, number | null>;
  gexDelta5mMap: Map<number, number | null>;
  gexDelta10mMap: Map<number, number | null>;
  gexDelta15mMap: Map<number, number | null>;
  gexDelta30mMap: Map<number, number | null>;
  spotRowRef: Ref<HTMLDivElement>;
  /**
   * When true, non-ATM rows render a signed point offset from spot beneath
   * the strike number (e.g. "+15 pts", "-30 pts"). Used by the Top 5 tab so
   * distant walls show their distance without needing a separate column.
   */
  showAtmDistance?: boolean;
  /** Strikes that just entered the set on the latest tick (Top 5 only). */
  justEntered?: Set<number>;
  /** Strike that has been in the set the longest (Top 5 only). */
  oldestStrike?: number | null;
}

export function StrikeTable({
  rows,
  currentPrice,
  spotStrike,
  maxChanged1mStrike,
  maxChanged5mStrike,
  gexDeltaMap,
  gexDelta5mMap,
  gexDelta10mMap,
  gexDelta15mMap,
  gexDelta30mMap,
  spotRowRef,
  showAtmDistance = false,
  justEntered,
  oldestStrike = null,
}: StrikeTableProps) {
  return (
    <div className="border-edge overflow-hidden rounded-lg border">
      {/* Sticky column header */}
      <div
        className={`border-edge-heavy bg-surface-alt sticky top-0 grid border-b font-mono text-[10px] font-semibold tracking-wider uppercase ${COLS}`}
        style={{ color: 'var(--color-tertiary)' }}
      >
        <div className="px-3 py-2 text-right">Strike</div>
        <div className="px-3 py-2">Classification</div>
        <div className="px-3 py-2">Signal</div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="Dollar Γ at current spot: γ × OI × 100 × spot² × 0.01 (from /spot-exposures/strike). Gamma is evaluated at SPOT, so values spike sharply at ATM and decay fast. Shows where dealer hedging is concentrated RIGHT NOW. Different metric than the GEX Strike Board's GEX $ — that one uses strike-fixed gamma and converts to dealer hedge dollars per 1% SPX move."
        >
          Dollar Γ
        </div>
        <div className="px-3 py-2 text-right">1m Δ%</div>
        <div className="px-3 py-2 text-right">5m Δ%</div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="GEX Δ% over 10 minutes — empty until 10+ min of buffered snapshots accumulate this session."
        >
          10m Δ%
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="GEX Δ% over 15 minutes — empty until 15+ min of buffered snapshots accumulate this session."
        >
          15m Δ%
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="GEX Δ% over 30 minutes — empty until 30+ min of buffered snapshots accumulate this session."
        >
          30m Δ%
        </div>
        <div className="px-3 py-2 text-right">Charm</div>
        <div className="px-3 py-2 text-center">Vol</div>
      </div>

      {/* Scrollable rows */}
      <div
        className="max-h-[540px] overflow-y-auto"
        role="list"
        aria-label="GEX strike landscape"
      >
        {rows.map((s) => {
          const isSpot = s.strike === spotStrike?.strike;
          const isAboveSpot = s.strike > currentPrice;
          const isMax1m = !isSpot && s.strike === maxChanged1mStrike;
          const isMax5m = !isSpot && s.strike === maxChanged5mStrike;
          // Confluence: same strike leads BOTH timeframes — stronger signal.
          const isConfluence = isMax1m && isMax5m;
          const isHighlighted = isMax1m || isMax5m;
          const dir = getDirection(s.strike, currentPrice);
          const cls = classify(s.netGamma, s.netCharm);
          const meta = CLASS_META[cls];
          const pct1m = gexDeltaMap.get(s.strike) ?? null;
          const pct5m = gexDelta5mMap.get(s.strike) ?? null;
          const pct10m = gexDelta10mMap.get(s.strike) ?? null;
          const pct15m = gexDelta15mMap.get(s.strike) ?? null;
          const pct30m = gexDelta30mMap.get(s.strike) ?? null;
          const isNew = justEntered?.has(s.strike) ?? false;
          const isAnchor = oldestStrike !== null && s.strike === oldestStrike;

          return (
            <div
              key={s.strike}
              ref={isSpot ? spotRowRef : undefined}
              role="listitem"
              className={[
                `border-edge/30 hover:bg-surface-alt/60 grid border-b transition-colors ${COLS}`,
                isSpot
                  ? 'border-l-2 border-l-sky-400/40 bg-sky-500/10'
                  : isConfluence
                    ? isAboveSpot
                      ? 'border-l-2 border-l-green-400/60 bg-green-500/20'
                      : 'border-l-2 border-l-red-400/60 bg-red-500/20'
                    : isHighlighted
                      ? isAboveSpot
                        ? 'border-l-2 border-l-green-400/40 bg-green-500/10'
                        : 'border-l-2 border-l-red-400/40 bg-red-500/10'
                      : meta.rowBg,
              ].join(' ')}
            >
              {/* Strike + ATM label (or signed offset for the Top 5 view) */}
              <div className="flex flex-col items-end justify-center px-3 py-1">
                <span
                  className={`font-mono text-[12px] font-semibold ${isSpot ? 'text-sky-300' : 'text-secondary'}`}
                >
                  {s.strike.toLocaleString()}
                </span>
                {isSpot && (
                  <span className="font-mono text-[9px] font-bold text-sky-400/80">
                    ATM
                  </span>
                )}
                {!isSpot && showAtmDistance && (
                  <span
                    className="font-mono text-[9px] font-semibold"
                    style={{
                      color: isAboveSpot
                        ? 'rgba(74,222,128,0.75)'
                        : 'rgba(248,113,113,0.75)',
                    }}
                    title={`${Math.abs(s.strike - currentPrice).toLocaleString()} points ${isAboveSpot ? 'above' : 'below'} spot`}
                  >
                    {isAboveSpot ? '+' : '−'}
                    {Math.abs(s.strike - currentPrice).toLocaleString()} pts
                  </span>
                )}
              </div>

              {/* Classification badge + lifecycle pills (Top 5 only) */}
              <div className="flex items-center gap-1.5 px-3 py-1.5">
                <span
                  className={`inline-block cursor-help rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${meta.badgeBg} ${meta.badgeText}`}
                  title={CLS_TOOLTIP[cls]}
                >
                  {meta.badge}
                </span>
                {isNew && (
                  <span
                    className="animate-fade-in-up inline-block rounded bg-sky-500/20 px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider text-sky-300 uppercase ring-1 ring-sky-400/40"
                    title="Just entered Top 5 on the latest snapshot"
                    aria-label="New entry"
                  >
                    New
                  </span>
                )}
                {isAnchor && (
                  <span
                    className="inline-block rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider text-amber-300 uppercase ring-1 ring-amber-400/30"
                    title="Oldest strike in the Top 5 — in the set longest this session"
                    aria-label="Anchor strike"
                  >
                    Anchor
                  </span>
                )}
              </div>

              {/* Direction signal */}
              <div className="flex items-center gap-1 px-3 py-1.5">
                <span
                  className="font-mono text-[11px]"
                  style={{
                    color:
                      dir === 'ceiling'
                        ? 'rgba(125,185,232,0.6)'
                        : dir === 'floor'
                          ? 'rgba(232,125,125,0.6)'
                          : 'rgba(255,255,255,0.35)',
                  }}
                >
                  {dir === 'ceiling' ? '↑' : dir === 'floor' ? '↓' : '●'}
                </span>
                <span
                  className={`cursor-help font-mono text-[10px] ${meta.badgeText}`}
                  title={signalTooltip(cls, dir)}
                >
                  {meta.signal(dir)}
                </span>
              </div>

              {/* Net GEX */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  className="font-mono text-[11px]"
                  style={{ color: s.netGamma >= 0 ? '#4ade80' : '#fbbf24' }}
                >
                  {fmtGex(s.netGamma)}
                </span>
              </div>

              {/* 1m GEX Δ% */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  className="font-mono text-[11px]"
                  style={{
                    color:
                      pct1m === null
                        ? 'var(--color-muted)'
                        : pct1m >= 0
                          ? 'rgba(74,222,128,0.85)'
                          : 'rgba(248,113,113,0.85)',
                  }}
                >
                  {fmtPct(pct1m)}
                </span>
              </div>

              {/* 5m GEX Δ% */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  className="font-mono text-[11px]"
                  style={{
                    color:
                      pct5m === null
                        ? 'var(--color-muted)'
                        : pct5m >= 0
                          ? 'rgba(74,222,128,0.85)'
                          : 'rgba(248,113,113,0.85)',
                  }}
                >
                  {fmtPct(pct5m)}
                </span>
              </div>

              {/* 10m GEX Δ% */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  className="font-mono text-[11px]"
                  style={{
                    color:
                      pct10m === null
                        ? 'var(--color-muted)'
                        : pct10m >= 0
                          ? 'rgba(74,222,128,0.85)'
                          : 'rgba(248,113,113,0.85)',
                  }}
                >
                  {fmtPct(pct10m)}
                </span>
              </div>

              {/* 15m GEX Δ% */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  className="font-mono text-[11px]"
                  style={{
                    color:
                      pct15m === null
                        ? 'var(--color-muted)'
                        : pct15m >= 0
                          ? 'rgba(74,222,128,0.85)'
                          : 'rgba(248,113,113,0.85)',
                  }}
                >
                  {fmtPct(pct15m)}
                </span>
              </div>

              {/* 30m GEX Δ% */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  className="font-mono text-[11px]"
                  style={{
                    color:
                      pct30m === null
                        ? 'var(--color-muted)'
                        : pct30m >= 0
                          ? 'rgba(74,222,128,0.85)'
                          : 'rgba(248,113,113,0.85)',
                  }}
                >
                  {fmtPct(pct30m)}
                </span>
              </div>

              {/* Charm */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  className="cursor-help font-mono text-[11px]"
                  style={{
                    color:
                      s.netCharm >= 0
                        ? 'rgba(74,222,128,0.75)'
                        : 'rgba(248,113,113,0.75)',
                  }}
                  title={charmTooltip(s.netCharm)}
                >
                  {fmtGex(s.netCharm)}
                </span>
              </div>

              {/* Vol reinforcement */}
              <div className="flex items-center justify-center px-3 py-1.5">
                {s.volReinforcement === 'reinforcing' && (
                  <span
                    className="font-mono text-[12px] text-emerald-400"
                    title="Volume reinforcing OI structure"
                    aria-label="Volume reinforcing"
                  >
                    ✓
                  </span>
                )}
                {s.volReinforcement === 'opposing' && (
                  <span
                    className="font-mono text-[12px] text-red-400"
                    title="Volume opposing OI structure"
                    aria-label="Volume opposing"
                  >
                    ✗
                  </span>
                )}
                {s.volReinforcement === 'neutral' && (
                  <span
                    className="text-muted font-mono text-[12px]"
                    title="Volume neutral"
                    aria-label="Volume neutral"
                  >
                    ○
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
