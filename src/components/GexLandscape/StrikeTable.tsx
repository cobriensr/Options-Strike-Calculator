/**
 * StrikeTable — sticky-header + scrollable grid of strikes within the
 * display window, with per-strike classification, position, GEX, NetCharm,
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
 * three deltas move with the strike's gamma sign (reinforcing); ↓↓ = all
 * three move against it (opposing); — = mixed / sparse data.
 */

import type { Ref } from 'react';
import type { GexStrikeLevel } from './types';
import { CLASS_META, CLS_TOOLTIP, takerSignHex, trendColor } from './constants';
import {
  charmHint,
  charmTooltip,
  classify,
  getDirection,
  positionDistance,
  signalTooltip,
  takerSideWords,
} from './classify';
import { fmtGex, fmtPct } from './formatters';
import { SrHint } from '../ui/SrHint.js';

/**
 * Strike | Class | Position | NetGamma | NetCharm | NetVanna | Δ5m | Δ15m | Δ30m | Vol Reinf.
 */
const COLS = 'grid-cols-[76px_130px_1fr_88px_76px_76px_64px_64px_64px_64px]';

/**
 * What each column header means. The header word is all a sighted user sees,
 * and the same text is its mouse-hover `title`; a screen reader never reads a
 * `title`, so each header also carries it as a hidden `SrHint`. One constant
 * per header, so the two cannot drift apart. The three Greek headers keep
 * their closing "not a market-maker position": it denies a claim, and the
 * dealer-claim scan allows exactly that phrase.
 */
const POSITION_HEADER_TEXT =
  "Taker side of the strike's GEXBot gamma and where the strike sits relative to spot (25-pt band).";
const NET_GAMMA_HEADER_TEXT =
  "GEXBot dollar gamma per strike from the 1-min capture, in GEXBot's taker-side sign: positive = traders (takers) are net long gamma at this strike, negative = net short. A taker-flow measure, not a market-maker position.";
const NET_CHARM_HEADER_TEXT =
  "GEXBot dollar charm per strike, in GEXBot's taker-side sign: positive = traders (takers) are net long charm at this strike, negative = net short. A taker-flow measure, not a market-maker position.";
const NET_VANNA_HEADER_TEXT =
  "GEXBot dollar vanna per strike, in GEXBot's taker-side sign: positive = traders (takers) are net long vanna at this strike, negative = net short. A taker-flow measure, not a market-maker position.";
const DELTA_5M_HEADER_TEXT =
  "% change in dollar gamma vs. the slot 5 min ago (GEXBot's shortest priors window) — shows the freshest sign flips and the fastest changes.";
const DELTA_15M_HEADER_TEXT =
  '% change in dollar gamma vs. the slot 15 min ago. Smooths the shorter-window noise; useful for setup detection between bigger windows.';
const DELTA_30M_HEADER_TEXT =
  '% change in dollar gamma vs. the slot 30 min ago. Catches session-scale build/unwind.';
/**
 * The Vol Reinf. title spells the three states with their glyphs (↑↑ / ↓↓ /
 * —). The hint is a trimmed variant: it names the states in words, because a
 * screen reader reads the glyphs as nothing useful, and drops the title's
 * opening "Vol Reinforcement" that the header already shows.
 */
const VOL_REINF_TITLE =
  "Vol Reinforcement — delta-trend agreement. ↑↑ (reinforcing): all three Δ% windows move with the netGamma sign, so the strike's gamma is growing in that sign. ↓↓ (opposing): all three move against it, so it is shrinking toward zero. — (neutral): mixed / sparse / no data.";
const VOL_REINF_HINT =
  "delta-trend agreement. Reinforcing: all three Δ% windows move with the netGamma sign, so the strike's gamma is growing in that sign. Opposing: all three move against it, so it is shrinking toward zero. Neutral: mixed, sparse or no data";

/**
 * What each vol-reinforcement mark means. The marks are glyphs (↑↑ / ↓↓ / —),
 * so the same text is the mouse-hover `title` and the `role="img"` label a
 * screen reader reads in place of the glyph.
 */
const VOL_REINFORCING_TEXT =
  "Reinforcing — all three Δ% windows move with the netGamma sign; the strike's gamma is growing in that sign.";
const VOL_OPPOSING_TEXT =
  "Opposing — all three Δ% windows move against the netGamma sign; the strike's gamma is shrinking toward zero.";
const VOL_NEUTRAL_TEXT =
  'Neutral — mixed direction across the three windows, or sparse data (any null / zero prior value).';

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
   * distant strikes show their distance without needing a separate column.
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
        <div className="cursor-help px-3 py-2" title={POSITION_HEADER_TEXT}>
          Position
          <SrHint>{POSITION_HEADER_TEXT}</SrHint>
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title={NET_GAMMA_HEADER_TEXT}
        >
          NetGamma
          <SrHint>{NET_GAMMA_HEADER_TEXT}</SrHint>
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title={NET_CHARM_HEADER_TEXT}
        >
          NetCharm
          <SrHint>{NET_CHARM_HEADER_TEXT}</SrHint>
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title={NET_VANNA_HEADER_TEXT}
        >
          NetVanna
          <SrHint>{NET_VANNA_HEADER_TEXT}</SrHint>
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title={DELTA_5M_HEADER_TEXT}
        >
          Δ5m
          <SrHint>{DELTA_5M_HEADER_TEXT}</SrHint>
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title={DELTA_15M_HEADER_TEXT}
        >
          Δ15m
          <SrHint>{DELTA_15M_HEADER_TEXT}</SrHint>
        </div>
        <div
          className="cursor-help px-3 py-2 text-right"
          title={DELTA_30M_HEADER_TEXT}
        >
          Δ30m
          <SrHint>{DELTA_30M_HEADER_TEXT}</SrHint>
        </div>
        <div
          className="cursor-help px-3 py-2 text-center"
          title={VOL_REINF_TITLE}
        >
          Vol Reinf.
          <SrHint>{VOL_REINF_HINT}</SrHint>
        </div>
      </div>

      {/* Scrollable rows */}
      <div
        className="relative max-h-[540px] overflow-y-auto"
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
          const sides = takerSideWords(cls);
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
                  ? // Neutral ring, not a hue: sky means taker-long γ here, and
                    // the row keeps its own gamma tint.
                    `ring-edge-strong ring-1 ring-inset ${meta.rowBg}`
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
                  className={`font-mono text-[12px] font-semibold ${isSpot ? 'text-primary' : 'text-secondary'}`}
                >
                  {s.strike.toLocaleString()}
                </span>
                {isSpot && (
                  <span className="text-secondary font-mono text-[9px] font-bold">
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
                    <SrHint>{isAboveSpot ? 'above spot' : 'below spot'}</SrHint>
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
                  <SrHint>{`net ${sides.gamma} gamma, net ${sides.charm} charm`}</SrHint>
                </span>
                {isNew && (
                  <span
                    className="animate-fade-in-up inline-block rounded bg-sky-500/20 px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider text-sky-300 uppercase ring-1 ring-sky-400/40"
                    title="Just entered Top 5 on the latest snapshot"
                  >
                    New
                    <SrHint>just entered Top 5 on the latest snapshot</SrHint>
                  </span>
                )}
                {isAnchor && (
                  <span
                    className="inline-block rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider text-amber-300 uppercase ring-1 ring-amber-400/30"
                    title="Oldest strike in the Top 5 — in the set longest this session"
                  >
                    Anchor
                    <SrHint>
                      oldest strike in the Top 5 — in the set longest this
                      session
                    </SrHint>
                  </span>
                )}
              </div>

              {/* Position: taker gamma side + where the strike sits */}
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
                  {dir === 'ceiling' ? '▲' : dir === 'floor' ? '▼' : '●'}
                </span>
                <span
                  className={`cursor-help font-mono text-[10px] ${meta.badgeText}`}
                  title={signalTooltip(cls, dir)}
                >
                  {meta.signal(dir)}
                  <SrHint>{positionDistance(dir)}</SrHint>
                </span>
              </div>

              {/* NetGamma — GEXBot dollar gamma, coloured by taker-side sign */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  className="font-mono text-[11px]"
                  style={{ color: takerSignHex(s.netGamma) }}
                >
                  {fmtGex(s.netGamma)}
                </span>
              </div>

              {/* NetCharm */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  className="cursor-help font-mono text-[11px]"
                  style={{ color: takerSignHex(s.netCharm) }}
                  title={charmTooltip(s.netCharm)}
                >
                  {fmtGex(s.netCharm)}
                  <SrHint>{charmHint(s.netCharm)}</SrHint>
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
                        : takerSignHex(s.netVanna),
                  }}
                >
                  {s.netVanna === 0 ? '—' : fmtGex(s.netVanna)}
                </span>
              </div>

              {/* Δ5m */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  className="font-mono text-[11px]"
                  style={{ color: trendColor(pct5m) }}
                >
                  {fmtPct(pct5m)}
                </span>
              </div>

              {/* Δ15m */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  className="font-mono text-[11px]"
                  style={{ color: trendColor(pct15m) }}
                >
                  {fmtPct(pct15m)}
                </span>
              </div>

              {/* Δ30m */}
              <div className="flex items-center justify-end px-3 py-1.5">
                <span
                  className="font-mono text-[11px]"
                  style={{ color: trendColor(pct30m) }}
                >
                  {fmtPct(pct30m)}
                </span>
              </div>

              {/* Vol reinforcement — delta-trend agreement (Phase 4) */}
              <div className="flex items-center justify-center px-3 py-1.5">
                {s.volReinforcement === 'reinforcing' && (
                  <span
                    className="text-secondary font-mono text-[12px] font-bold"
                    title={VOL_REINFORCING_TEXT}
                    role="img"
                    aria-label={VOL_REINFORCING_TEXT}
                  >
                    ↑↑
                  </span>
                )}
                {s.volReinforcement === 'opposing' && (
                  <span
                    className="text-secondary font-mono text-[12px] font-bold"
                    title={VOL_OPPOSING_TEXT}
                    role="img"
                    aria-label={VOL_OPPOSING_TEXT}
                  >
                    ↓↓
                  </span>
                )}
                {s.volReinforcement === 'neutral' && (
                  <span
                    className="text-muted font-mono text-[12px]"
                    title={VOL_NEUTRAL_TEXT}
                    role="img"
                    aria-label={VOL_NEUTRAL_TEXT}
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
