/**
 * TRACELiveCalibrationPanel — surfaces the calibration loop's outputs
 * directly on the TRACE Live dashboard.
 *
 * Three views:
 *   1. Summary banner — N, MAE, median bias, % within ±5pt. The single
 *      line that tells the trader "is the model calibrated right now."
 *   2. Residual stats table — per (regime, ttc_bucket): n, median bias,
 *      p25/p75 spread. Populates nightly from the resolve-trace-residuals
 *      cron once buckets reach n ≥ 5.
 *   3. Full-width scatter — pred vs actual for every resolved capture,
 *      colored by regime, with numeric tick labels, gridlines, a regime
 *      legend, and the y=x "perfect prediction" diagonal.
 *
 * Read-only and lazy: the underlying endpoint is cached 5 min server-side
 * and the cron writes once per day, so a session-level fetch is ample.
 */

import { useEffect, useMemo, useState } from 'react';
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

const REGIME_ORDER: string[] = [
  'range_bound_positive_gamma',
  'trending_positive_gamma',
  'range_bound_negative_gamma',
  'trending_negative_gamma',
  'mixed',
];

function fmtNum(n: number | null, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}`;
}

function fmtRegime(r: string): string {
  return r.replace(/_/g, ' ');
}

/**
 * Pick "nice" numeric tick values across [lo, hi]. Step size is rounded
 * to 1/2/5 × 10^k so the labels read cleanly (7100, 7150, 7200) instead
 * of arbitrary fractions. Returns 3–7 ticks depending on the range.
 */
function niceTicks(lo: number, hi: number, target: number): number[] {
  const range = hi - lo;
  if (range <= 0) return [lo];
  const rawStep = range / (target - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const frac = rawStep / mag;
  let step: number;
  if (frac < 1.5) step = mag;
  else if (frac < 3) step = 2 * mag;
  else if (frac < 7) step = 5 * mag;
  else step = 10 * mag;
  const start = Math.ceil(lo / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= hi + 1e-9; v += step) ticks.push(v);
  return ticks;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

function SummaryBanner({ scatter }: { scatter: ScatterPoint[] }) {
  const stats = useMemo(() => {
    const residuals = scatter.map((p) => p.actual - p.predicted);
    const n = residuals.length;
    if (n === 0) return null;
    const mae = residuals.reduce((s, r) => s + Math.abs(r), 0) / n;
    const med = median(residuals);
    const within5 = residuals.filter((r) => Math.abs(r) <= 5).length / n;
    return { n, mae, med, within5 };
  }, [scatter]);
  if (!stats) return null;
  const biasColor =
    Math.abs(stats.med) > 5 ? theme.red : theme.textTertiary;
  return (
    <div className="border-edge flex flex-wrap gap-x-5 gap-y-1 rounded border px-3 py-2 font-mono text-[11px]">
      <div>
        <span className="text-muted">N </span>
        <span className="text-secondary font-semibold">{stats.n}</span>
      </div>
      <div>
        <span className="text-muted">MAE </span>
        <span className="text-secondary font-semibold">
          {stats.mae.toFixed(1)}
        </span>
      </div>
      <div>
        <span className="text-muted">median bias </span>
        <span className="font-semibold" style={{ color: biasColor }}>
          {fmtNum(stats.med, 1)}
        </span>
      </div>
      <div>
        <span className="text-muted">within ±5 </span>
        <span className="text-secondary font-semibold">
          {(stats.within5 * 100).toFixed(0)}%
        </span>
      </div>
    </div>
  );
}

function RegimeLegend({ scatter }: { scatter: ScatterPoint[] }) {
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of scatter) map.set(p.regime, (map.get(p.regime) ?? 0) + 1);
    return map;
  }, [scatter]);
  return (
    <div className="text-muted flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
      {REGIME_ORDER.filter((r) => counts.has(r)).map((r) => (
        <span key={r} className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: REGIME_COLORS[r] }}
          />
          <span>
            {fmtRegime(r)} ({counts.get(r)})
          </span>
        </span>
      ))}
    </div>
  );
}

function Scatter({ scatter }: { scatter: ScatterPoint[] }) {
  // Both axes share the same [lo, hi] range so the diagonal y=x remains a
  // valid "perfect prediction" reference — do not split sx/sy ranges
  // without revisiting the diagonal.
  const xs = scatter.flatMap((p) => [p.predicted, p.actual]);
  const minV = Math.min(...xs);
  const maxV = Math.max(...xs);
  const margin = maxV > minV ? (maxV - minV) * 0.05 : 10;
  const lo = minV - margin;
  const hi = maxV + margin;
  const w = 800;
  const h = 360;
  const padL = 56;
  const padB = 36;
  const padT = 12;
  const padR = 16;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const sx = (v: number) => padL + ((v - lo) / (hi - lo)) * plotW;
  const sy = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * plotH;
  const ticks = niceTicks(lo, hi, 6);
  const residuals = scatter.map((p) => p.actual - p.predicted);
  const minRes = Math.min(...residuals);
  const maxRes = Math.max(...residuals);
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-labelledby="cal-title cal-desc"
    >
      <title id="cal-title">Predicted vs actual close scatter</title>
      <desc id="cal-desc">
        {scatter.length} resolved capture{scatter.length === 1 ? '' : 's'};
        residuals range from {minRes.toFixed(1)} to {maxRes.toFixed(1)} points.
        Diagonal indicates perfect prediction; points colored by regime.
      </desc>
      {/* Gridlines at tick positions */}
      {ticks.map((t) => (
        <g key={`grid-${t}`}>
          <line
            x1={sx(t)}
            y1={padT}
            x2={sx(t)}
            y2={padT + plotH}
            stroke={theme.border}
            strokeWidth={0.5}
            opacity={0.4}
          />
          <line
            x1={padL}
            y1={sy(t)}
            x2={padL + plotW}
            y2={sy(t)}
            stroke={theme.border}
            strokeWidth={0.5}
            opacity={0.4}
          />
        </g>
      ))}
      {/* Plot box */}
      <rect
        x={padL}
        y={padT}
        width={plotW}
        height={plotH}
        fill="none"
        stroke={theme.border}
        strokeWidth={0.75}
      />
      {/* Diagonal y=x (perfect prediction) */}
      <line
        x1={sx(lo)}
        y1={sy(lo)}
        x2={sx(hi)}
        y2={sy(hi)}
        stroke={theme.textTertiary}
        strokeDasharray="4 4"
        strokeWidth={1}
      />
      {/* X-axis tick labels */}
      {ticks.map((t) => (
        <text
          key={`xt-${t}`}
          x={sx(t)}
          y={padT + plotH + 14}
          textAnchor="middle"
          fontSize="10"
          fill={theme.textMuted}
          fontFamily="ui-monospace, monospace"
        >
          {Math.round(t)}
        </text>
      ))}
      {/* Y-axis tick labels */}
      {ticks.map((t) => (
        <text
          key={`yt-${t}`}
          x={padL - 6}
          y={sy(t) + 3}
          textAnchor="end"
          fontSize="10"
          fill={theme.textMuted}
          fontFamily="ui-monospace, monospace"
        >
          {Math.round(t)}
        </text>
      ))}
      {/* Axis titles */}
      <text
        x={padL + plotW / 2}
        y={h - 6}
        textAnchor="middle"
        fontSize="11"
        fill={theme.textMuted}
      >
        predicted close
      </text>
      <text
        x={14}
        y={padT + plotH / 2}
        textAnchor="middle"
        fontSize="11"
        fill={theme.textMuted}
        transform={`rotate(-90 14 ${padT + plotH / 2})`}
      >
        actual close
      </text>
      {/* Data points */}
      {scatter.map((p) => (
        <circle
          key={p.id}
          cx={sx(p.predicted)}
          cy={sy(p.actual)}
          r={3.5}
          fill={REGIME_COLORS[p.regime] ?? theme.textTertiary}
          opacity={0.85}
          stroke={theme.bg}
          strokeWidth={0.5}
        >
          <title>
            {fmtRegime(p.regime)} — predicted {p.predicted.toFixed(2)}, actual{' '}
            {p.actual.toFixed(2)} (residual {fmtNum(p.actual - p.predicted, 2)})
          </title>
        </circle>
      ))}
    </svg>
  );
}

function ResidualTable({ rows }: { rows: CalibrationRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-[11px]">
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
          {rows.map((r) => {
            const flagged =
              r.residual_median != null && Math.abs(r.residual_median) > 5;
            return (
              <tr
                key={`${r.regime}|${r.ttc_bucket}`}
                className="border-edge border-t"
              >
                <td className="text-secondary px-2 py-1">
                  {fmtRegime(r.regime)}
                </td>
                <td className="text-secondary px-2 py-1">{r.ttc_bucket}</td>
                <td className="text-tertiary px-2 py-1 text-right">{r.n}</td>
                <td
                  className={
                    flagged
                      ? 'px-2 py-1 text-right font-semibold'
                      : 'text-tertiary px-2 py-1 text-right'
                  }
                  style={flagged ? { color: theme.red } : undefined}
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
            );
          })}
        </tbody>
      </table>
      <div className="text-muted mt-2 text-[10px] italic">
        Buckets with |median bias| &gt; 5 are highlighted —
        applyResidualCorrection() shifts predicted_close by these residuals at
        inference time once n ≥ 5.
      </div>
    </div>
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

  const hasScatter = data != null && data.scatter.length > 0;
  const hasRows = data != null && data.rows.length > 0;
  const empty = data != null && !hasScatter && !hasRows;

  return (
    <div className="mt-2.5">
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
          {empty && (
            <div className="text-muted">
              No calibration data yet. Populates after the first
              resolve-trace-residuals cron run (02:00 UTC daily).
            </div>
          )}

          {hasScatter && <SummaryBanner scatter={data!.scatter} />}

          {hasRows && <ResidualTable rows={data!.rows} />}

          {hasScatter && !hasRows && (
            <div className="text-muted text-[10px] italic">
              Per-bucket residual table populates nightly at 02:00 UTC once each
              (regime, ttc_bucket) has n ≥ 5 resolved captures.
            </div>
          )}

          {hasScatter && (
            <div className="space-y-2">
              <div className="text-muted text-[10px] uppercase">
                Predicted vs Actual ({data!.scatter.length} pts)
              </div>
              <Scatter scatter={data!.scatter} />
              <RegimeLegend scatter={data!.scatter} />
            </div>
          )}
        </div>
      </Collapsible>
    </div>
  );
}

export default TRACELiveCalibrationPanel;
