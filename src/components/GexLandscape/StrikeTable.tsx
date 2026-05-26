/**
 * StrikeTable — sticky-header + scrollable grid of strikes within the
 * display window, with per-strike classification, signal, GEX, NetCharm,
 * NetVanna, three Δ% windows (1m / 5m / 10m), and a vol-reinforcement
 * badge. The ATM row is ref-tagged so the parent can scroll it into
 * view on initial load.
 *
 * All three Δ% windows share the same GexBot-native 1-min cadence —
 * the prior values come from each row's `gammaPrev1m/5m/10m` fields
 * that the endpoint already carries. Δ1m and Δ5m surface short-term
 * acceleration; Δ10m surfaces session-scale build/unwind.
 *
 * Vol Reinforcement column is the new (Phase 4) delta-trend agreement
 * signal — see `computeVolReinforcement` in `classify.ts`. ↑↑ = all
 * three deltas push with the wall (reinforcing); ↓↓ = all three push
 * against the wall (opposing); — = mixed / sparse data.
 */

import type { Ref } from 'react';
import type { GexStrikeLevel } from './types';
import { CLASS_META, CLS_TOOLTIP } from './constants';
import {
  charmTooltip,
  classify,
  getDirection,
  signalTooltip,
} from './classify';
import { fmtGex, fmtPct } from './formatters';

/**
 * Strike | Class | Signal | NetGamma | NetCharm | NetVanna | Δ1m | Δ5m | Δ10m | Vol Reinf.
 */
const COLS = 'grid-cols-[76px_130px_1fr_88px_76px_76px_64px_64px_64px_64px]';

export interface StrikeTableProps {
  rows: GexStrikeLevel[];
  currentPrice: number;
  spotStrike: GexStrikeLevel | null;
  maxChanged1mStrike: number | null;
  maxChanged5mStrike: number | null;
  maxChanged10mStrike: number | null;
  gexDelta1mMap: Map<number, number | null>;
  gexDelta5mMap: Map<number, number | null>;
  gexDelta10mMap: Map<number, number | null>;
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
  maxChanged10mStrike,
  gexDelta1mMap,
  gexDelta5mMap,
  gexDelta10mMap,
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
          title="MM-attributed dollar gamma per strike from the 1-min GexBot capture. This is what UW Periscope renders on the Net GEX heat map — the proprietary dealer-attribution number."
        >
          NetGamma
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="MM-attributed dollar charm per strike — how dealer hedge demand at this level decays into the close. Positive = pressure grows into close; negative = pressure fades."
        >
          NetCharm
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="MM-attributed dollar vanna per strike — sensitivity of dealer delta hedge to IV moves. Positive = vol crush forces dealers to buy; negative = vol expansion forces dealers to sell."
        >
          NetVanna
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="% change in dollar gamma vs. the prior 1-min slot — captures the freshest sign flips and acceleration. Native cadence at GexBot's 1-min push rate."
        >
          Δ1m
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="% change in dollar gamma vs. the slot 5 min ago. Smooths the 1-min noise; useful for setup detection between bigger windows."
        >
          Δ5m
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="% change in dollar gamma vs. the slot 10 min ago. Catches session-scale build/unwind."
        >
          Δ10m
        </div>
        <div
          className="cursor-help px-3 py-2 text-center"
          title="Vol Reinforcement — delta-trend agreement. ↑↑ (reinforcing): all three Δ% windows push with the netGamma sign; the wall is being added to. ↓↓ (opposing): all three push against; the wall is being unwound. — (neutral): mixed / sparse / no data."
        >
          Vol Reinf.
        </div>
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
          const isMax10m = !isSpot && s.strike === maxChanged10mStrike;
          // Confluence: same strike leads ALL three timeframes — strongest signal.
          const isConfluence = isMax1m && isMax5m && isMax10m;
          const isHighlighted = isMax1m || isMax5m || isMax10m;
          const dir = getDirection(s.strike, currentPrice);
          const cls = classify(s.netGamma, s.netCharm);
          const meta = CLASS_META[cls];
          const pct1m = gexDelta1mMap.get(s.strike) ?? null;
          const pct5m = gexDelta5mMap.get(s.strike) ?? null;
          const pct10m = gexDelta10mMap.get(s.strike) ?? null;
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

              {/* NetGamma — dealer-attributed dollar gamma */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  className="font-mono text-[11px]"
                  style={{ color: s.netGamma >= 0 ? '#4ade80' : '#fbbf24' }}
                >
                  {fmtGex(s.netGamma)}
                </span>
              </div>

              {/* NetCharm */}
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

              {/* NetVanna */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  data-testid={`net-vanna-cell-${s.strike}`}
                  className="font-mono text-[11px]"
                  style={{
                    color:
                      s.netVanna === 0
                        ? 'var(--color-muted)'
                        : s.netVanna > 0
                          ? 'rgba(74,222,128,0.75)'
                          : 'rgba(248,113,113,0.75)',
                  }}
                >
                  {s.netVanna === 0 ? '—' : fmtGex(s.netVanna)}
                </span>
              </div>

              {/* Δ1m */}
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

              {/* Δ5m */}
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

              {/* Δ10m */}
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

              {/* Vol reinforcement — delta-trend agreement (Phase 4) */}
              <div className="flex items-center justify-center px-3 py-1.5">
                {s.volReinforcement === 'reinforcing' && (
                  <span
                    className="font-mono text-[12px] font-bold text-emerald-400"
                    title="Reinforcing — all three Δ% windows push with the netGamma sign; the wall is being added to."
                    aria-label="Vol reinforcing"
                  >
                    ↑↑
                  </span>
                )}
                {s.volReinforcement === 'opposing' && (
                  <span
                    className="font-mono text-[12px] font-bold text-red-400"
                    title="Opposing — all three Δ% windows push against the netGamma sign; the wall is being unwound."
                    aria-label="Vol opposing"
                  >
                    ↓↓
                  </span>
                )}
                {s.volReinforcement === 'neutral' && (
                  <span
                    className="text-muted font-mono text-[12px]"
                    title="Neutral — mixed direction across the three windows, or sparse data (any null / zero prior value)."
                    aria-label="Vol neutral"
                  >
                    —
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
