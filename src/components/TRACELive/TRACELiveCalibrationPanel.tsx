/**
 * TRACELiveCalibrationPanel — surfaces the calibration loop's outputs
 * directly on the TRACE Live dashboard.
 *
 * Two views:
 *   1. Residual stats table — per (regime, ttc_bucket): n, median bias,
 *      p25/p75 spread. Reveals systematic bias by regime + time-of-day
 *      bucket at a glance.
 *   2. Mini scatter — pred vs actual for every resolved capture, colored
 *      by regime. Inline SVG (no chart lib). The diagonal is "perfect
 *      prediction"; points above-right of it are under-predictions.
 *
 * Read-only and lazy: the underlying endpoint is cached 5 min server-side
 * + the cron writes once per day, so a session-level fetch is ample.
 */

import { memo, useEffect, useState } from 'react';
import { theme } from '../../themes';
import Collapsible from '../ChartAnalysis/Collapsible';

interface CalibrationRow {
  regime: string;
  ttc_bucket: string;
  n: number;
  residual_mean: number | null;
  residual_median: number | null;
  residual_p25: number | null;
  residual_p75: number | null;
  updated_at: string;
}

interface ScatterPoint {
  id: number;
  capturedAt: string;
  regime: string;
  predicted: number;
  actual: number;
  residual: number;
}

interface CalibrationResponse {
  rows: CalibrationRow[];
  scatter: ScatterPoint[];
}

const REGIME_COLORS: Record<string, string> = {
  range_bound_positive_gamma: '#16a34a',
  trending_positive_gamma: '#86efac',
  range_bound_negative_gamma: '#fbbf24',
  trending_negative_gamma: '#dc2626',
  mixed: '#737373',
};

function fmtNum(n: number | null, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}`;
}

function MiniScatter({ scatter }: { scatter: ScatterPoint[] }) {
  if (scatter.length === 0) {
    return (
      <div className="text-muted text-[11px]">
        No resolved ticks yet. Scatter populates as fetch-outcomes fills
        actual_close.
      </div>
    );
  }
  // Compute axis bounds with a small margin.
  const xs = scatter.flatMap((p) => [p.predicted, p.actual]);
  const minV = Math.min(...xs);
  const maxV = Math.max(...xs);
  const margin = (maxV - minV) * 0.05 || 1;
  const lo = minV - margin;
  const hi = maxV + margin;
  const w = 320;
  const h = 220;
  const padL = 36;
  const padB = 22;
  const padT = 8;
  const padR = 8;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const sx = (v: number) => padL + ((v - lo) / (hi - lo)) * plotW;
  const sy = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * plotH;
  return (
    <svg
      width={w}
      height={h}
      role="img"
      aria-label="Predicted vs actual close scatter"
    >
      {/* Plot box */}
      <rect
        x={padL}
        y={padT}
        width={plotW}
        height={plotH}
        fill="none"
        stroke="#404040"
        strokeWidth={0.5}
      />
      {/* Diagonal y=x (perfect prediction) */}
      <line
        x1={sx(lo)}
        y1={sy(lo)}
        x2={sx(hi)}
        y2={sy(hi)}
        stroke="#737373"
        strokeDasharray="3 3"
        strokeWidth={0.75}
      />
      {/* Axis labels */}
      <text
        x={padL + plotW / 2}
        y={h - 4}
        textAnchor="middle"
        fontSize="9"
        fill="#a3a3a3"
      >
        predicted close
      </text>
      <text
        x={10}
        y={padT + plotH / 2}
        textAnchor="middle"
        fontSize="9"
        fill="#a3a3a3"
        transform={`rotate(-90 10 ${padT + plotH / 2})`}
      >
        actual close
      </text>
      {/* Data points */}
      {scatter.map((p) => (
        <circle
          key={p.id}
          cx={sx(p.predicted)}
          cy={sy(p.actual)}
          r={2.5}
          fill={REGIME_COLORS[p.regime] ?? '#737373'}
          opacity={0.8}
        />
      ))}
    </svg>
  );
}

function TRACELiveCalibrationPanel() {
  const [data, setData] = useState<CalibrationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/trace-live-calibration', { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as CalibrationResponse;
      })
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Collapsible title="Calibration" color={theme.textMuted}>
      <div className="space-y-3 text-[11px]">
        {loading && <div className="text-muted">Loading…</div>}
        {error && (
          <div
            className="rounded border border-red-500/40 bg-red-950/30 p-2 text-red-200"
            role="alert"
          >
            {error}
          </div>
        )}
        {data && data.rows.length === 0 && data.scatter.length === 0 && (
          <div className="text-muted">
            No calibration data yet. Populates after the first
            resolve-trace-residuals cron run (02:00 UTC daily).
          </div>
        )}
        {data && data.rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="font-mono">
              <thead>
                <tr className="text-muted text-[10px]">
                  <th className="px-2 py-1 text-left">Regime</th>
                  <th className="px-2 py-1 text-left">Bucket</th>
                  <th className="px-2 py-1 text-right">N</th>
                  <th className="px-2 py-1 text-right">Median bias</th>
                  <th className="px-2 py-1 text-right">P25</th>
                  <th className="px-2 py-1 text-right">P75</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr
                    key={`${r.regime}|${r.ttc_bucket}`}
                    className="border-edge border-t"
                  >
                    <td className="text-secondary px-2 py-1">
                      {r.regime.replace(/_/g, ' ')}
                    </td>
                    <td className="text-secondary px-2 py-1">{r.ttc_bucket}</td>
                    <td className="text-tertiary px-2 py-1 text-right">
                      {r.n}
                    </td>
                    <td
                      className={
                        r.residual_median != null &&
                        Math.abs(r.residual_median) > 5
                          ? 'px-2 py-1 text-right font-semibold'
                          : 'text-tertiary px-2 py-1 text-right'
                      }
                      style={
                        r.residual_median != null &&
                        Math.abs(r.residual_median) > 5
                          ? { color: theme.red }
                          : undefined
                      }
                    >
                      {fmtNum(r.residual_median, 1)}
                    </td>
                    <td className="text-secondary px-2 py-1 text-right">
                      {fmtNum(r.residual_p25, 1)}
                    </td>
                    <td className="text-secondary px-2 py-1 text-right">
                      {fmtNum(r.residual_p75, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-muted mt-2 text-[10px] italic">
              Buckets with |median bias| &gt; 5 are highlighted —
              applyResidualCorrection() shifts predicted_close by these
              residuals at inference time once n ≥ 5.
            </div>
          </div>
        )}
        {data && data.scatter.length > 0 && (
          <div>
            <div className="text-muted mb-1 text-[10px] uppercase">
              Predicted vs Actual ({data.scatter.length} pts)
            </div>
            <MiniScatter scatter={data.scatter} />
          </div>
        )}
      </div>
    </Collapsible>
  );
}

export default memo(TRACELiveCalibrationPanel);
