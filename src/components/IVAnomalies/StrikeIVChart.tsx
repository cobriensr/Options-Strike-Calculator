import { useEffect, useState } from 'react';
import type {
  IVAnomaliesHistoryResponse,
  IVAnomalySide,
  IVAnomalyTicker,
  StrikeIVSample,
} from './types';

/**
 * Per-strike IV bid/mid/ask history mini-chart.
 *
 * Fetches `/api/iv-anomalies?ticker=…&strike=…&side=…&expiry=…` on mount
 * and renders the IV time series as three polylines (bid/mid/ask) in a
 * compact 600×180 SVG. A vertical reference line marks the anomaly
 * detection timestamp so the user can visually align the IV move against
 * the trigger.
 *
 * Recharts is NOT a dependency of this repo (package.json has only
 * `lightweight-charts` for candles). Other fixed-window visualizations
 * in this codebase (StrikeConcentrationChart, CeilingChart) are
 * hand-rolled SVG — we follow that convention to avoid pulling in ~75KB
 * of new deps for a 180px mini-chart.
 */
export function StrikeIVChart({
  ticker,
  strike,
  side,
  expiry,
  detectedAt,
}: {
  readonly ticker: IVAnomalyTicker;
  readonly strike: number;
  readonly side: IVAnomalySide;
  readonly expiry: string;
  readonly detectedAt: string;
}) {
  const [data, setData] = useState<IVAnomaliesHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({
      ticker,
      strike: String(strike),
      side,
      expiry,
      limit: '240',
    });

    fetch(`/api/iv-anomalies?${params.toString()}`, {
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`History API error ${res.status}`);
        const payload = (await res.json()) as IVAnomaliesHistoryResponse;
        if (!cancelled) {
          setData(payload);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Unknown error');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [ticker, strike, side, expiry]);

  if (loading) {
    return (
      <div className="text-muted text-[11px] italic">Loading IV history…</div>
    );
  }
  if (error) {
    return (
      <div className="text-[11px] text-rose-400">IV history error: {error}</div>
    );
  }
  if (!data || data.samples.length < 2) {
    return (
      <div className="text-muted text-[11px] italic">
        Insufficient IV history for this strike yet.
      </div>
    );
  }

  return <ChartBody samples={data.samples} detectedAt={detectedAt} />;
}

// ── Pure rendering path ─────────────────────────────────────────

interface Bounds {
  minT: number;
  maxT: number;
  minIV: number;
  maxIV: number;
}

function computeBounds(samples: readonly StrikeIVSample[]): Bounds {
  let minIV = Number.POSITIVE_INFINITY;
  let maxIV = Number.NEGATIVE_INFINITY;
  for (const s of samples) {
    for (const v of [s.ivBid, s.ivMid, s.ivAsk]) {
      if (v != null && Number.isFinite(v)) {
        if (v < minIV) minIV = v;
        if (v > maxIV) maxIV = v;
      }
    }
  }
  if (!Number.isFinite(minIV) || !Number.isFinite(maxIV)) {
    minIV = 0;
    maxIV = 1;
  }
  // Add a small padding to avoid lines hugging the axis edges.
  const pad = (maxIV - minIV) * 0.1 || 0.01;
  const minT = new Date(samples[0]!.ts).getTime();
  const maxT = new Date(samples[samples.length - 1]!.ts).getTime();
  return {
    minT,
    maxT: Math.max(maxT, minT + 1),
    minIV: minIV - pad,
    maxIV: maxIV + pad,
  };
}

function polyline(
  samples: readonly StrikeIVSample[],
  pick: (s: StrikeIVSample) => number | null,
  bounds: Bounds,
  width: number,
  height: number,
): string {
  const points: string[] = [];
  for (const s of samples) {
    const v = pick(s);
    if (v == null) continue;
    const t = new Date(s.ts).getTime();
    const x = ((t - bounds.minT) / (bounds.maxT - bounds.minT)) * width;
    const y =
      height - ((v - bounds.minIV) / (bounds.maxIV - bounds.minIV)) * height;
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return points.join(' ');
}

function ChartBody({
  samples,
  detectedAt,
}: {
  readonly samples: readonly StrikeIVSample[];
  readonly detectedAt: string;
}) {
  const W = 600;
  const H = 180;
  const padLeft = 40;
  const padBottom = 20;
  const innerW = W - padLeft - 8;
  const innerH = H - padBottom - 8;
  const bounds = computeBounds(samples);

  const detectT = new Date(detectedAt).getTime();
  const detectX =
    ((detectT - bounds.minT) / (bounds.maxT - bounds.minT)) * innerW + padLeft;
  const detectVisible =
    detectT >= bounds.minT - 1 && detectT <= bounds.maxT + 1;

  const askLine = polyline(samples, (s) => s.ivAsk, bounds, innerW, innerH);
  const midLine = polyline(samples, (s) => s.ivMid, bounds, innerW, innerH);
  const bidLine = polyline(samples, (s) => s.ivBid, bounds, innerW, innerH);

  // Axis ticks — simple 2-point Y axis for orientation.
  const minIVPct = (bounds.minIV * 100).toFixed(1);
  const maxIVPct = (bounds.maxIV * 100).toFixed(1);

  return (
    <figure
      className="border-edge bg-surface rounded-md border p-2"
      aria-label="Per-strike IV history"
    >
      <figcaption className="text-muted mb-1 text-[10px]">
        IV bid/mid/ask over last {samples.length} snapshots
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-[180px] w-full"
        role="img"
        aria-label="IV time series"
      >
        {/* Background */}
        <rect
          x={padLeft}
          y={0}
          width={innerW}
          height={innerH}
          fill="rgb(15, 23, 42)"
          opacity={0.25}
        />

        {/* Y-axis labels */}
        <text
          x={padLeft - 4}
          y={10}
          textAnchor="end"
          className="fill-slate-400"
          style={{ fontSize: 9 }}
        >
          {maxIVPct}%
        </text>
        <text
          x={padLeft - 4}
          y={innerH}
          textAnchor="end"
          className="fill-slate-400"
          style={{ fontSize: 9 }}
        >
          {minIVPct}%
        </text>

        {/* Chart body, shifted by padLeft */}
        <g transform={`translate(${padLeft},0)`}>
          {bidLine && (
            <polyline
              points={bidLine}
              fill="none"
              stroke="rgb(56, 189, 248)"
              strokeOpacity={0.6}
              strokeWidth={1.2}
            />
          )}
          {midLine && (
            <polyline
              points={midLine}
              fill="none"
              stroke="rgb(251, 191, 36)"
              strokeWidth={1.5}
            />
          )}
          {askLine && (
            <polyline
              points={askLine}
              fill="none"
              stroke="rgb(244, 114, 182)"
              strokeOpacity={0.6}
              strokeWidth={1.2}
            />
          )}
        </g>

        {/* Detection reference line */}
        {detectVisible && (
          <line
            x1={detectX}
            y1={0}
            x2={detectX}
            y2={innerH}
            stroke="rgb(239, 68, 68)"
            strokeDasharray="4 2"
            strokeWidth={1}
          >
            <title>Detected @ {detectedAt}</title>
          </line>
        )}

        {/* Axis baselines */}
        <line
          x1={padLeft}
          y1={innerH}
          x2={W}
          y2={innerH}
          stroke="rgb(71, 85, 105)"
          strokeWidth={0.5}
        />
      </svg>
      <div className="text-muted mt-1 flex gap-4 text-[10px]">
        <span>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 10,
              height: 2,
              background: 'rgb(56, 189, 248)',
              marginRight: 4,
              verticalAlign: 'middle',
            }}
          />
          bid
        </span>
        <span>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 10,
              height: 2,
              background: 'rgb(251, 191, 36)',
              marginRight: 4,
              verticalAlign: 'middle',
            }}
          />
          mid
        </span>
        <span>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 10,
              height: 2,
              background: 'rgb(244, 114, 182)',
              marginRight: 4,
              verticalAlign: 'middle',
            }}
          />
          ask
        </span>
        <span>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 10,
              borderTop: '1px dashed rgb(239, 68, 68)',
              marginRight: 4,
              verticalAlign: 'middle',
            }}
          />
          detected
        </span>
      </div>
    </figure>
  );
}
