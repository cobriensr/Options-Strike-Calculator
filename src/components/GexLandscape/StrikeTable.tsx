/**
 * StrikeTable — sticky-header + scrollable grid of strikes within the
 * display window, with per-strike classification, signal, GEX, NetCharm,
 * NetVanna, three Δ% windows (5m / 15m / 30m), and a vol-reinforcement
 * badge. The ATM row is ref-tagged so the parent can scroll it into
 * view on initial load.
 *
 * All three Δ% windows come from GEXBot's priors array (t-5 / t-15 / t-30
 * min) —
 * the prior values come from each row's `gammaPrev5m/15m/30m` fields
 * that the endpoint already carries. Δ5m and Δ15m surface short-term
 * acceleration; Δ30m surfaces session-scale build/unwind.
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
 * Strike | Class | Signal | NetGamma | NetCharm | NetVanna | Δ5m | Δ15m | Δ30m | Vol Reinf.
 */
const COLS = 'grid-cols-[76px_130px_1fr_88px_76px_76px_64px_64px_64px_64px]';

export interface StrikeTableProps {
  rows: GexStrikeLevel[];
  currentPrice: number;
  spotStrike: GexStrikeLevel | null;
  maxChanged5mStrike: number | null;
  maxChanged15mStrike: number | null;
  maxChanged30mStrike: number | null;
  gexDelta5mMap: Map<number, number | null>;
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
  maxChanged5mStrike,
  maxChanged15mStrike,
  maxChanged30mStrike,
  gexDelta5mMap,
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
          title="Dollar gamma per strike from the 1-min GEXBot capture, negated to market-maker sign (GEXBot reports it taker-signed). Positive = market makers long gamma here, so they dampen moves; negative = short gamma, so they add to moves."
        >
          NetGamma
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="GEXBot dollar charm per strike, in the vendor's sign, not market-maker attributed. Positive = this level's influence builds into the close; negative = it fades."
        >
          NetCharm
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="GEXBot dollar vanna per strike, in the vendor's sign, not market-maker attributed: how the delta at this strike shifts when implied vol moves."
        >
          NetVanna
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="% change in dollar gamma vs. the slot 5 min ago (GEXBot's shortest priors window) — captures the freshest sign flips and acceleration."
        >
          Δ5m
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="% change in dollar gamma vs. the slot 15 min ago. Smooths the shorter-window noise; useful for setup detection between bigger windows."
        >
          Δ15m
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="% change in dollar gamma vs. the slot 30 min ago. Catches session-scale build/unwind."
        >
          Δ30m
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
          const isMax5m = !isSpot && s.strike === maxChanged5mStrike;
          const isMax15m = !isSpot && s.strike === maxChanged15mStrike;
          const isMax30m = !isSpot && s.strike === maxChanged30mStrike;
          // Confluence: same strike leads ALL three timeframes — strongest signal.
          const isConfluence = isMax5m && isMax15m && isMax30m;
          const isHighlighted = isMax5m || isMax15m || isMax30m;
          const dir = getDirection(s.strike, currentPrice);
          const cls = classify(s.netGamma, s.netCharm);
          const meta = CLASS_META[cls];
          const pct5m = gexDelta5mMap.get(s.strike) ?? null;
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

              {/* NetGamma — GEXBot dollar gamma, negated to MM sign */}
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

              {/* Δ15m */}
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

              {/* Δ30m */}
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
