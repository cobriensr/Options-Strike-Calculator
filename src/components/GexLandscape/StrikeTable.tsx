/**
 * StrikeTable — sticky-header + scrollable grid of strikes within the
 * display window, with per-strike classification, signal, GEX, Δ%
 * windows, charm, and vol reinforcement cells. The ATM row is
 * ref-tagged so the parent can scroll it into view on initial load.
 *
 * Δ% windows are split into two groups:
 *   - MM Δ% (10m / 30m) — periscope-scraper cadence is 10 min, so
 *     faster windows have no signal for MM data.
 *   - Naive Δ% (1m / 5m / 10m) — WS feed is continuous, so the fast
 *     windows expose intraday OI rotation that MM cannot see between
 *     snapshots.
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
 * Strike | Class | Signal | MM Γ | MM 10m | MM 30m | Naive Γ | N 1m | N 5m | N 10m | Charm | Vol
 *
 * The Naive Γ + naive Δ% group sits together so MM and naive reads
 * can be compared at a glance without the eye jumping across the row.
 */
const COLS =
  'grid-cols-[76px_130px_1fr_88px_72px_72px_88px_64px_64px_64px_76px_56px]';

export interface StrikeTableProps {
  rows: GexStrikeLevel[];
  currentPrice: number;
  spotStrike: GexStrikeLevel | null;
  maxChanged10mStrike: number | null;
  maxChanged30mStrike: number | null;
  gexDelta10mMap: Map<number, number | null>;
  gexDelta30mMap: Map<number, number | null>;
  /** Naive Δ% maps — fast-cadence WS feed (server-computed via SQL LAG). */
  naiveDelta1mMap: Map<number, number | null>;
  naiveDelta5mMap: Map<number, number | null>;
  naiveDelta10mMap: Map<number, number | null>;
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
  maxChanged10mStrike,
  maxChanged30mStrike,
  gexDelta10mMap,
  gexDelta30mMap,
  naiveDelta1mMap,
  naiveDelta5mMap,
  naiveDelta10mMap,
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
          title="MM-attributed dollar gamma per strike, captured by the periscope-scraper every 10 min during RTH. This is what UW Periscope renders on the Net GEX heat map — the proprietary dealer-attribution number, NOT the naive call+put gamma OI sum."
        >
          MM Γ
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="% change in MM dollar gamma vs. the prior 10-min slot. The fastest signal at MM cadence — captures sign flips and acceleration. Empty when no prior slot is available (first slot of the session)."
        >
          MM 10m
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="% change in MM dollar gamma vs. the slot 30 min ago (3 slots back). Captures session-scale build/unwind. Empty until 3 slots of history exist."
        >
          MM 30m
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="Naive dollar gamma per strike — raw sum of call_gamma_oi + put_gamma_oi from the WS feed. Standing-position read with no dealer-attribution math, so it can disagree on sign with MM Γ at the same strike. That disagreement is itself signal."
        >
          Naive Γ
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="% change in naive (call+put OI) gamma vs. the prior 1-min slot. Fastest naive cadence — only useful intraday since WS pushes continuously. MM cannot expose 1m because periscope-scraper is 10-min cadence."
        >
          N 1m
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="% change in naive gamma vs. the slot 5 min ago. Catches short-term OI rotation that's invisible to MM's 10-min cadence — useful for setup detection between MM snapshots."
        >
          N 5m
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title="% change in naive gamma vs. the slot 10 min ago. Lines up time-wise with MM 10m — direct comparison: if MM 10m and N 10m disagree on sign, the dealer-attribution math is overriding the raw OI structure."
        >
          N 10m
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
          const naive1m = naiveDelta1mMap.get(s.strike) ?? null;
          const naive5m = naiveDelta5mMap.get(s.strike) ?? null;
          const naive10m = naiveDelta10mMap.get(s.strike) ?? null;
          const naiveGamma = s.callGammaOi + s.putGammaOi;
          const naiveGammaColor =
            naiveGamma === 0
              ? 'var(--color-muted)'
              : naiveGamma > 0
                ? '#4ade80'
                : '#fbbf24';
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

              {/* MM Γ — dealer-attributed dollar gamma */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  className="font-mono text-[11px]"
                  style={{ color: s.netGamma >= 0 ? '#4ade80' : '#fbbf24' }}
                >
                  {fmtGex(s.netGamma)}
                </span>
              </div>

              {/* MM 10m Δ% */}
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

              {/* MM 30m Δ% */}
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

              {/* Naive Γ — raw OI sum. Renders "—" when the sum is
                  zero, which covers both (a) WS row absent (`projectMmStrike`
                  zeros the OI fields) and (b) an exact call+put OI gamma
                  cancellation. Case (b) is effectively impossible in
                  real SPX data — call_gamma_oi and put_gamma_oi are
                  computed dollar amounts that never coincide to the
                  cent — so "—" reliably reads as "no WS data". */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  data-testid={`naive-gamma-cell-${s.strike}`}
                  className="font-mono text-[11px]"
                  style={{ color: naiveGammaColor }}
                >
                  {naiveGamma === 0 ? '—' : fmtGex(naiveGamma)}
                </span>
              </div>

              {/* Naive 1m Δ% — fastest WS-cadence window */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  className="font-mono text-[11px]"
                  style={{
                    color:
                      naive1m === null
                        ? 'var(--color-muted)'
                        : naive1m >= 0
                          ? 'rgba(74,222,128,0.85)'
                          : 'rgba(248,113,113,0.85)',
                  }}
                >
                  {fmtPct(naive1m)}
                </span>
              </div>

              {/* Naive 5m Δ% */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  className="font-mono text-[11px]"
                  style={{
                    color:
                      naive5m === null
                        ? 'var(--color-muted)'
                        : naive5m >= 0
                          ? 'rgba(74,222,128,0.85)'
                          : 'rgba(248,113,113,0.85)',
                  }}
                >
                  {fmtPct(naive5m)}
                </span>
              </div>

              {/* Naive 10m Δ% — direct comparator to MM 10m for sign agreement */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  className="font-mono text-[11px]"
                  style={{
                    color:
                      naive10m === null
                        ? 'var(--color-muted)'
                        : naive10m >= 0
                          ? 'rgba(74,222,128,0.85)'
                          : 'rgba(248,113,113,0.85)',
                  }}
                >
                  {fmtPct(naive10m)}
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
