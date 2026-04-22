/**
 * RegimeTimeline — Panel 4 of the FuturesGammaPlaybook widget.
 *
 * SVG strip chart showing the intraday GEX regime evolution for the active
 * session. Layout (top to bottom):
 *
 *   1. Regime band — full width, ~40px tall. One contiguous shaded area
 *      per contiguous regime bucket (POSITIVE / NEGATIVE / TRANSITIONING).
 *   2. Price band — ~60px tall. SPX spot polyline (no basis translation
 *      here; the spot is what the regime classifier already used). Phase
 *      boundary markers drawn as faint vertical gridlines.
 *   3. Crossings band — ~30px tall. Zero-gamma regime flips drawn as
 *      dashed vertical lines with small "⚡ ZG flip" labels.
 *
 * Phase 1C fallback: when the hook has no timeseries to plot (the default
 * until `/api/spot-gex-history` ships), the component renders an empty
 * state explaining the gap rather than a degenerate chart. Scrubbed
 * indicator is still drawn atop whatever shell is shown.
 *
 * The chart scales to its container's width via SVG viewBox — callers do
 * not need to pass an explicit width prop.
 */

import { memo, useMemo, useState, type MouseEvent } from 'react';
import { fmtGex } from '../GexLandscape/formatters';
import { getCTTime } from '../../utils/timezone';
import type { RegimeTimelinePoint, SessionPhaseBoundariesCt } from './types';

export interface RegimeTimelineProps {
  timeline: RegimeTimelinePoint[];
  sessionPhaseBoundaries: SessionPhaseBoundariesCt;
  isScrubbed: boolean;
  scrubbedTimestamp: string | null;
}

// ── Chart geometry ─────────────────────────────────────────────────────
//
// ViewBox units — the SVG element scales to container width, so these
// numbers are "internal coordinates" rather than pixel counts. Keeping
// them as constants near the top makes the math below readable.

const VIEW_W = 600;
const REGIME_BAND_Y = 8;
const REGIME_BAND_H = 28;
const PRICE_BAND_Y = REGIME_BAND_Y + REGIME_BAND_H + 8;
const PRICE_BAND_H = 52;
const CROSSINGS_BAND_Y = PRICE_BAND_Y + PRICE_BAND_H + 8;
const CROSSINGS_BAND_H = 22;
const VIEW_H = CROSSINGS_BAND_Y + CROSSINGS_BAND_H + 8;
const CHART_PAD_X = 8;
const CHART_INNER_W = VIEW_W - CHART_PAD_X * 2;

// ── Regime palette ─────────────────────────────────────────────────────

const REGIME_FILL: Record<RegimeTimelinePoint['regime'], string> = {
  POSITIVE: 'rgba(74,222,128,0.22)',
  NEGATIVE: 'rgba(251,191,36,0.22)',
  TRANSITIONING: 'rgba(255,255,255,0.08)',
};

// ── Helpers ────────────────────────────────────────────────────────────

function toMs(iso: string): number {
  return new Date(iso).getTime();
}

interface RegimeBucket {
  regime: RegimeTimelinePoint['regime'];
  start: number;
  end: number;
}

/**
 * Collapse a timeline into contiguous regime runs so each run can be drawn
 * as a single shaded rectangle rather than per-point segments.
 */
function bucketRegimes(timeline: RegimeTimelinePoint[]): RegimeBucket[] {
  if (timeline.length === 0) return [];
  const buckets: RegimeBucket[] = [];
  let current: RegimeBucket = {
    regime: timeline[0]!.regime,
    start: toMs(timeline[0]!.ts),
    end: toMs(timeline[0]!.ts),
  };
  for (let i = 1; i < timeline.length; i += 1) {
    const pt = timeline[i]!;
    const t = toMs(pt.ts);
    if (pt.regime === current.regime) {
      current.end = t;
    } else {
      buckets.push(current);
      current = { regime: pt.regime, start: current.end, end: t };
    }
  }
  buckets.push(current);
  return buckets;
}

/**
 * Zero-gamma crossings = indices where the regime changed away from (or
 * into) `TRANSITIONING` between adjacent points, OR flipped POSITIVE ↔
 * NEGATIVE directly. We return both timestamps and the new regime so the
 * crossings band can annotate each flip.
 */
function zeroGammaCrossings(
  timeline: RegimeTimelinePoint[],
): Array<{ ts: string; regime: RegimeTimelinePoint['regime'] }> {
  const out: Array<{ ts: string; regime: RegimeTimelinePoint['regime'] }> = [];
  for (let i = 1; i < timeline.length; i += 1) {
    const prev = timeline[i - 1]!;
    const curr = timeline[i]!;
    if (prev.regime !== curr.regime) {
      out.push({ ts: curr.ts, regime: curr.regime });
    }
  }
  return out;
}

// ── Component ──────────────────────────────────────────────────────────

export const RegimeTimeline = memo(function RegimeTimeline({
  timeline,
  sessionPhaseBoundaries,
  isScrubbed,
  scrubbedTimestamp,
}: RegimeTimelineProps) {
  // Derivations must run unconditionally on every render — hooks cannot
  // appear after an early return. Each memo is a no-op when the timeline
  // is empty, so the empty-state branch below still benefits from the
  // cached empty results.
  const buckets = useMemo(() => bucketRegimes(timeline), [timeline]);
  const crossings = useMemo(() => zeroGammaCrossings(timeline), [timeline]);

  // Time axis anchored to the full session range: from OPEN to CLOSE,
  // extended if the timeline itself overshoots (pre-market or post-close).
  // Derived eagerly so the memoized price-line below sees consistent
  // inputs.
  const { xMin, xRange } = useMemo(() => {
    const sessionStartMs = toMs(sessionPhaseBoundaries.open);
    const sessionEndMs = toMs(sessionPhaseBoundaries.close);
    const firstMs =
      timeline.length > 0 ? toMs(timeline[0]!.ts) : sessionStartMs;
    const lastMs =
      timeline.length > 0 ? toMs(timeline.at(-1)!.ts) : sessionEndMs;
    const min = Math.min(sessionStartMs, firstMs);
    const max = Math.max(sessionEndMs, lastMs);
    return { xMin: min, xRange: Math.max(1, max - min) };
  }, [timeline, sessionPhaseBoundaries.open, sessionPhaseBoundaries.close]);

  const toX = useMemo(
    () => (ms: number) => CHART_PAD_X + ((ms - xMin) / xRange) * CHART_INNER_W,
    [xMin, xRange],
  );

  // Spot y-axis range. Shared by the price polyline AND the hover-crosshair
  // marker so both use the exact same transform (no drift between line and
  // snap dot). Safe when the timeline is empty — the spotRange falls back
  // to 1 and toY is never actually called (empty-state branch returns
  // before rendering the chart).
  const { minSpot, spotRange } = useMemo(() => {
    if (timeline.length === 0) return { minSpot: 0, spotRange: 1 };
    const spots = timeline.map((p) => p.spot);
    const lo = Math.min(...spots);
    const hi = Math.max(...spots);
    return { minSpot: lo, spotRange: Math.max(0.01, hi - lo) };
  }, [timeline]);

  const toY = (spot: number): number =>
    PRICE_BAND_Y + PRICE_BAND_H - ((spot - minSpot) / spotRange) * PRICE_BAND_H;

  // Price polyline — compact SVG path string built once per timeline update.
  const priceLine = useMemo(() => {
    if (timeline.length === 0) return '';
    return timeline
      .map((p) => `${toX(toMs(p.ts)).toFixed(1)},${toY(p.spot).toFixed(1)}`)
      .join(' ');
    // toY is a pure function of minSpot/spotRange (already in deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, toX, minSpot, spotRange]);

  // Hover crosshair — snap-to-nearest index under the cursor. Mouse-only UX;
  // keyboard users navigate the timeline via the scrubber controls in the
  // header, which is the accessibility-compatible alternative. We also
  // capture the SVG's rendered pixel width at hover time so the HTML readout
  // card can be positioned in the wrapper's pixel coord system without
  // recomputing layout during render (layout reads belong in event handlers
  // to avoid reflow loops).
  const [hoverState, setHoverState] = useState<{
    index: number;
    svgWidthPx: number;
  } | null>(null);

  const hoverSnap = useMemo(() => {
    if (hoverState === null) return null;
    const pt = timeline[hoverState.index];
    if (!pt) return null;
    const snapX = toX(toMs(pt.ts));
    // If the snap sits in the LEFT half of the chart, card flushes to the
    // RIGHT of the crosshair (and vice versa) to avoid going off-viewport.
    const cardSide = snapX < CHART_PAD_X + CHART_INNER_W / 2 ? 'right' : 'left';
    const snapPxX = (snapX / VIEW_W) * hoverState.svgWidthPx;
    const snapY =
      PRICE_BAND_Y +
      PRICE_BAND_H -
      ((pt.spot - minSpot) / spotRange) * PRICE_BAND_H;
    return {
      pt,
      snapX,
      snapY,
      cardSide,
      snapPxX,
      svgWidthPx: hoverState.svgWidthPx,
    } as const;
  }, [hoverState, timeline, toX, minSpot, spotRange]);

  const handleSvgMouseMove = (e: MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const mouseSvgX = ((e.clientX - rect.left) / rect.width) * VIEW_W;
    // Linear scan — timeline is ~80 pts max, so the cost is trivial.
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < timeline.length; i += 1) {
      const px = toX(toMs(timeline[i]!.ts));
      const d = Math.abs(px - mouseSvgX);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    setHoverState({ index: bestIdx, svgWidthPx: rect.width });
  };

  const handleSvgMouseLeave = () => {
    setHoverState(null);
  };

  // Empty-state shell — rendered AFTER all hooks so the hook order is
  // stable across data presence/absence.
  if (timeline.length === 0) {
    return (
      <div
        className="border-edge bg-surface-alt mb-3 rounded-lg border p-4 text-center"
        aria-label="Regime timeline"
      >
        <div
          className="font-mono text-[12px] font-semibold tracking-wider uppercase"
          style={{ color: 'var(--color-tertiary)' }}
        >
          Regime timeline loading
        </div>
        <div
          className="mt-1 font-mono text-[11px]"
          style={{ color: 'var(--color-secondary)' }}
        >
          Waiting for session history.
        </div>
      </div>
    );
  }

  // Phase boundary marks on the x-axis.
  const phaseMarks = [
    { ts: sessionPhaseBoundaries.open, label: 'OPEN' },
    { ts: sessionPhaseBoundaries.lunch, label: 'LUNCH' },
    { ts: sessionPhaseBoundaries.power, label: 'POWER' },
    { ts: sessionPhaseBoundaries.close, label: 'CLOSE' },
  ];

  // Scrub indicator position (only draws when scrubbing with a valid ts).
  const scrubX =
    isScrubbed && scrubbedTimestamp ? toX(toMs(scrubbedTimestamp)) : null;

  return (
    <div
      className="border-edge bg-surface-alt relative mb-3 overflow-hidden rounded-lg border p-2"
      aria-label="Regime timeline"
    >
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Intraday regime timeline with ${buckets.length} regime bucket${
          buckets.length === 1 ? '' : 's'
        } and ${crossings.length} zero-gamma crossing${
          crossings.length === 1 ? '' : 's'
        }, with SPX spot overlay`}
        className="block w-full"
        style={{ height: `${VIEW_H}px`, maxHeight: '160px' }}
        onMouseMove={handleSvgMouseMove}
        onMouseLeave={handleSvgMouseLeave}
        data-testid="regime-timeline-svg"
      >
        {/* ── Regime bands (top) ─────────────────────────── */}
        <g data-testid="regime-bands">
          {buckets.map((b, i) => {
            const x1 = toX(b.start);
            const x2 = toX(b.end);
            const width = Math.max(1, x2 - x1);
            return (
              <rect
                key={`bucket-${i}-${b.regime}`}
                x={x1}
                y={REGIME_BAND_Y}
                width={width}
                height={REGIME_BAND_H}
                fill={REGIME_FILL[b.regime]}
                data-regime={b.regime}
              >
                <title>{`${b.regime} from ${new Date(b.start).toISOString()}`}</title>
              </rect>
            );
          })}
        </g>

        {/* ── Price polyline (middle) ─────────────────────── */}
        <g data-testid="price-line">
          <rect
            x={CHART_PAD_X}
            y={PRICE_BAND_Y}
            width={CHART_INNER_W}
            height={PRICE_BAND_H}
            fill="rgba(255,255,255,0.02)"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={0.5}
          />
          <polyline
            points={priceLine}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={1.2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <text
            x={CHART_PAD_X + 4}
            y={PRICE_BAND_Y + 9}
            fontSize={8}
            fill="var(--color-muted)"
            style={{ fontFamily: 'monospace', pointerEvents: 'none' }}
          >
            SPX
          </text>
        </g>

        {/* ── Phase boundary markers (x-axis gridlines) ──── */}
        <g data-testid="phase-marks">
          {phaseMarks.map((mark) => {
            const x = toX(toMs(mark.ts));
            // Skip marks that fall outside the drawable area.
            if (x < CHART_PAD_X || x > CHART_PAD_X + CHART_INNER_W) return null;
            return (
              <g key={mark.label}>
                <line
                  x1={x}
                  y1={REGIME_BAND_Y}
                  x2={x}
                  y2={PRICE_BAND_Y + PRICE_BAND_H}
                  stroke="rgba(255,255,255,0.12)"
                  strokeWidth={0.5}
                  strokeDasharray="2 2"
                />
                <text
                  x={x}
                  y={VIEW_H - 2}
                  fontSize="8"
                  textAnchor="middle"
                  fill="var(--color-tertiary)"
                  fontFamily="monospace"
                >
                  {mark.label}
                </text>
              </g>
            );
          })}
        </g>

        {/* ── Zero-gamma crossings (bottom band) ─────────── */}
        <g data-testid="zg-crossings">
          {crossings.map((c, i) => {
            const x = toX(toMs(c.ts));
            return (
              <g key={`zg-${i}-${c.ts}`}>
                <line
                  x1={x}
                  y1={CROSSINGS_BAND_Y}
                  x2={x}
                  y2={CROSSINGS_BAND_Y + CROSSINGS_BAND_H}
                  stroke="rgba(255,255,255,0.5)"
                  strokeWidth={1}
                  strokeDasharray="3 2"
                  data-testid="zg-crossing"
                />
                <text
                  x={x + 3}
                  y={CROSSINGS_BAND_Y + CROSSINGS_BAND_H - 4}
                  fontSize="8"
                  fill="var(--color-tertiary)"
                  fontFamily="monospace"
                >
                  ZG flip
                </text>
              </g>
            );
          })}
        </g>

        {/* ── Scrubbed-timestamp indicator ─────────────── */}
        {scrubX !== null ? (
          <g data-testid="scrub-indicator">
            <line
              x1={scrubX}
              y1={REGIME_BAND_Y}
              x2={scrubX}
              y2={CROSSINGS_BAND_Y + CROSSINGS_BAND_H}
              stroke="var(--color-accent)"
              strokeWidth={1.5}
              strokeDasharray="4 2"
            />
            <text
              x={scrubX + 3}
              y={REGIME_BAND_Y + 8}
              fontSize="8"
              fill="var(--color-accent)"
              fontFamily="monospace"
            >
              {new Date(scrubbedTimestamp ?? '').toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
                timeZone: 'America/Chicago',
              })}
            </text>
          </g>
        ) : null}

        {/* ── Hover crosshair (mouse-driven) ───────────────
            Intentionally rendered AFTER the scrub indicator so both can
            co-exist when the user hovers while a scrub is active — the
            user may want to compare "where I'm scrubbed" vs "where my
            cursor is". */}
        {hoverSnap !== null ? (
          <g data-testid="hover-crosshair" pointerEvents="none">
            <line
              x1={hoverSnap.snapX}
              y1={REGIME_BAND_Y}
              x2={hoverSnap.snapX}
              y2={CROSSINGS_BAND_Y + CROSSINGS_BAND_H}
              stroke="var(--color-tertiary)"
              strokeWidth={1}
              strokeDasharray="2 2"
              opacity={0.8}
            />
            <circle
              cx={hoverSnap.snapX}
              cy={hoverSnap.snapY}
              r={2.5}
              fill="var(--color-accent)"
              stroke="var(--color-surface)"
              strokeWidth={0.75}
            />
          </g>
        ) : null}
      </svg>

      {/* ── Hover readout card (HTML, absolutely positioned) ───
          Kept outside the SVG so typography renders without the
          preserveAspectRatio="none" distortion. pointer-events:none ensures
          the card never eats mousemove events headed for the SVG. */}
      {hoverSnap !== null ? (
        <div
          data-testid="hover-readout"
          className="border-edge bg-surface pointer-events-none absolute rounded border px-2 py-1 font-mono text-[10px] shadow"
          style={{
            // SVG sits 8px inside the wrapper (p-2). Add that to align the
            // card's x with the SVG-internal snap position.
            ...(hoverSnap.cardSide === 'right'
              ? { left: `${8 + hoverSnap.snapPxX + 8}px` }
              : {
                  right: `${8 + (hoverSnap.svgWidthPx - hoverSnap.snapPxX) + 8}px`,
                }),
            top: '6px',
            maxWidth: '180px',
            color: 'var(--color-primary)',
          }}
        >
          <div style={{ color: 'var(--color-tertiary)' }}>
            {(() => {
              const d = new Date(hoverSnap.pt.ts);
              const { hour, minute } = getCTTime(d);
              return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} CT`;
            })()}
          </div>
          <div
            style={{
              color:
                hoverSnap.pt.regime === 'POSITIVE'
                  ? 'rgb(74,222,128)'
                  : hoverSnap.pt.regime === 'NEGATIVE'
                    ? 'rgb(251,191,36)'
                    : 'var(--color-secondary)',
            }}
          >
            {hoverSnap.pt.regime === 'POSITIVE'
              ? 'POSITIVE +GEX'
              : hoverSnap.pt.regime === 'NEGATIVE'
                ? 'NEGATIVE −GEX'
                : 'TRANSITIONING'}
          </div>
          <div>SPX {hoverSnap.pt.spot.toFixed(2)}</div>
          <div>{fmtGex(hoverSnap.pt.netGex)}</div>
        </div>
      ) : null}
    </div>
  );
});

export default RegimeTimeline;
