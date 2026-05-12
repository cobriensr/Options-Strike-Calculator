/**
 * StrikeTable — sticky-header + scrollable grid of strikes within the
 * display window, with per-strike classification, signal, GEX, MM-cadence
 * Δ% (10m/30m), charm, and vol reinforcement cells. The ATM row is
 * ref-tagged so the parent can scroll it into view on initial load.
 *
 * Phase 3 of docs/superpowers/specs/gex-landscape-mm-swap-2026-05-12.md
 * dropped the 1m/5m/15m columns — MM data publishes at 10-min cadence so
 * faster windows have no signal. SPX-only after the swap; ticker prop +
 * `getDirection`'s ticker param both removed.
 */

import type { Ref } from 'react';
import type { GexStrikeLevel } from './types';
import { CLASS_META, CLS_TOOLTIP } from './constants';
import {
  charmTooltip,
  classify,
  getDirection,
  signalTooltip,
  type GammaPressure,
} from './classify';
import { fmtGex, fmtPct } from './formatters';

/**
 * Strike | Classification | Signal | Net GEX | 10m Δ% | 30m Δ% | Charm | Vol
 */
const COLS = 'grid-cols-[76px_130px_1fr_88px_72px_72px_76px_56px]';

export interface StrikeTableProps {
  rows: GexStrikeLevel[];
  currentPrice: number;
  spotStrike: GexStrikeLevel | null;
  maxChanged10mStrike: number | null;
  maxChanged30mStrike: number | null;
  gexDelta10mMap: Map<number, number | null>;
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
  /**
   * Per-strike gamma-pressure label (reinforcing / unwinding / neutral).
   * Optional — strikes missing from the map render as neutral (no
   * indicator).
   */
  gammaPressureMap?: Map<number, GammaPressure>;
}

export function StrikeTable({
  rows,
  currentPrice,
  spotStrike,
  maxChanged10mStrike,
  maxChanged30mStrike,
  gexDelta10mMap,
  gexDelta30mMap,
  spotRowRef,
  showAtmDistance = false,
  justEntered,
  oldestStrike = null,
  gammaPressureMap,
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
          title="MM-attributed dollar gamma per strike, captured by the periscope-scraper every 10 min during RTH. This is what UW Periscope renders on the Net GEX heat map — the proprietary dealer-attribution number, NOT the naive call+put gamma OI sum."
        >
          Dollar Γ
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="% change in MM dollar gamma vs. the prior 10-min slot. The fastest signal at MM cadence — captures sign flips and acceleration. Empty when no prior slot is available (first slot of the session)."
        >
          10m Δ%
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="% change in MM dollar gamma vs. the slot 30 min ago (3 slots back). Captures session-scale build/unwind. Empty until 3 slots of history exist."
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
          const isMax10m = !isSpot && s.strike === maxChanged10mStrike;
          const isMax30m = !isSpot && s.strike === maxChanged30mStrike;
          // Confluence: same strike leads BOTH timeframes — stronger signal.
          const isConfluence = isMax10m && isMax30m;
          const isHighlighted = isMax10m || isMax30m;
          const dir = getDirection(s.strike, currentPrice);
          const cls = classify(s.netGamma, s.netCharm);
          const meta = CLASS_META[cls];
          const pct10m = gexDelta10mMap.get(s.strike) ?? null;
          const pct30m = gexDelta30mMap.get(s.strike) ?? null;
          const isNew = justEntered?.has(s.strike) ?? false;
          const isAnchor = oldestStrike !== null && s.strike === oldestStrike;
          const pressure: GammaPressure =
            gammaPressureMap?.get(s.strike) ?? 'neutral';

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
                {pressure === 'reinforcing' && (
                  <span
                    className="cursor-help font-mono text-[11px] font-bold text-emerald-400/80"
                    title="Walls reinforcing — customers net selling gamma at this strike (dealers getting longer)"
                    aria-label="Walls reinforcing"
                  >
                    +
                  </span>
                )}
                {pressure === 'unwinding' && (
                  <span
                    className="cursor-help font-mono text-[11px] font-bold text-red-400/80"
                    title="Walls unwinding — customers net buying gamma at this strike (dealers getting shorter)"
                    aria-label="Walls unwinding"
                  >
                    −
                  </span>
                )}
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
