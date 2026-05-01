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
import {
  classifyRegime,
  median,
  type RegimeStatus,
} from '../../utils/calibration-stats';
import { Scatter, type ScatterPoint } from './Scatter';

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
  const biasColor = Math.abs(stats.med) > 5 ? theme.red : theme.textTertiary;
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

interface RegimeStat {
  regime: string;
  n: number;
  median: number;
  mae: number;
  within5: number;
  status: RegimeStatus;
}

const STATUS_COPY: Record<RegimeStatus, string> = {
  good: 'well-calibrated',
  biased: 'slight bias',
  broken: 'significant bias — discount predictions',
  thin: 'thin sample (n<5)',
};

const STATUS_GLYPH: Record<RegimeStatus, string> = {
  good: '✓',
  biased: '~',
  broken: '✗',
  thin: '·',
};

function statusColor(status: RegimeStatus): string {
  switch (status) {
    case 'good':
      return theme.green;
    case 'biased':
      return theme.caution;
    case 'broken':
      return theme.red;
    case 'thin':
      return theme.textMuted;
  }
}

function RegimeAnalysis({ scatter }: { scatter: ScatterPoint[] }) {
  const stats = useMemo<RegimeStat[]>(() => {
    const groups = new Map<string, ScatterPoint[]>();
    for (const p of scatter) {
      const arr = groups.get(p.regime);
      if (arr) arr.push(p);
      else groups.set(p.regime, [p]);
    }
    return [...groups.entries()]
      .map(([regime, points]): RegimeStat => {
        const residuals = points.map((p) => p.actual - p.predicted);
        const n = residuals.length;
        const med = median(residuals);
        const mae = residuals.reduce((s, r) => s + Math.abs(r), 0) / n;
        const within5 = residuals.filter((r) => Math.abs(r) <= 5).length / n;
        return {
          regime,
          n,
          median: med,
          mae,
          within5,
          status: classifyRegime(n, med),
        };
      })
      .sort((a, b) => Math.abs(b.median) - Math.abs(a.median));
  }, [scatter]);

  // Headline: the worst trustworthy bias (if any), else the calmest read.
  const headline = useMemo(() => {
    const trustworthy = stats.filter((s) => s.status !== 'thin');
    if (trustworthy.length === 0) {
      return {
        text: `Only thin per-regime samples so far (max n = ${
          stats[0]?.n ?? 0
        }). Need ≥5 per regime for a calibrated verdict.`,
        tone: 'thin' as const,
      };
    }
    const worst = trustworthy[0];
    if (!worst) return null;
    if (worst.status === 'good') {
      return {
        text: `Model is well-calibrated across all regimes with ≥5 samples (worst median bias ${fmtNum(
          worst.median,
          1,
        )}pt on ${fmtRegime(worst.regime)}).`,
        tone: 'good' as const,
      };
    }
    if (worst.status === 'biased') {
      return {
        text: `Mostly calibrated. Worst regime: ${fmtRegime(
          worst.regime,
        )} biased ${fmtNum(worst.median, 1)}pt — within tolerance but worth noting.`,
        tone: 'biased' as const,
      };
    }
    // broken
    const direction = worst.median > 0 ? 'under-predicting' : 'over-predicting';
    return {
      text: `Model is ${direction} on ${fmtRegime(
        worst.regime,
      )} by ${fmtNum(worst.median, 1)}pt (n=${
        worst.n
      }). Discount predictions on these setups until the calibration cron applies the residual shift.`,
      tone: 'broken' as const,
    };
  }, [stats]);

  if (stats.length === 0 || !headline) return null;

  return (
    <div className="border-edge space-y-2 rounded border p-3">
      <div className="text-muted text-[10px] tracking-wider uppercase">
        Analysis
      </div>
      <div
        className="text-[12px] leading-snug font-medium"
        style={{ color: statusColor(headline.tone) }}
      >
        {headline.text}
      </div>
      <ul className="space-y-1 font-mono text-[11px]">
        {stats.map((s) => (
          <li key={s.regime} className="flex items-baseline gap-2">
            <span
              className="w-3 text-center font-semibold"
              style={{ color: statusColor(s.status) }}
              aria-label={STATUS_COPY[s.status]}
            >
              {STATUS_GLYPH[s.status]}
            </span>
            <span className="text-secondary min-w-[12rem]">
              {fmtRegime(s.regime)}
            </span>
            <span className="text-muted">n={s.n}</span>
            <span
              className="font-semibold"
              style={{ color: statusColor(s.status) }}
            >
              bias {fmtNum(s.median, 1)}
            </span>
            <span className="text-muted">
              MAE {s.mae.toFixed(1)} · within±5 {(s.within5 * 100).toFixed(0)}%
            </span>
            <span className="text-muted italic">— {STATUS_COPY[s.status]}</span>
          </li>
        ))}
      </ul>
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

          {hasScatter && <RegimeAnalysis scatter={data!.scatter} />}

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
              <Scatter
                scatter={data!.scatter}
                regimeColors={REGIME_COLORS}
                formatRegime={fmtRegime}
                formatNum={fmtNum}
              />
              <RegimeLegend scatter={data!.scatter} />
            </div>
          )}
        </div>
      </Collapsible>
    </div>
  );
}

export default TRACELiveCalibrationPanel;
