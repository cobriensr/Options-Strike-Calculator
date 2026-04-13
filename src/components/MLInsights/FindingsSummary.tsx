/**
 * FindingsSummary — Compact card showing key ML pipeline metrics.
 *
 * Displays pipeline date, dataset stats, overall accuracy,
 * health status, and number of plots analyzed.
 */

import { memo } from 'react';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';

interface Props {
  readonly findings: Record<string, unknown> | null;
  readonly pipelineDate: string | null;
  readonly plotCount: number;
  readonly analyzedCount: number;
}

/** Most recent Monday–Friday in CT, going back from yesterday. */
function getLastExpectedTradingDay(): string {
  const ct = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }),
  );
  ct.setDate(ct.getDate() - 1);
  while (ct.getDay() === 0 || ct.getDay() === 6) {
    ct.setDate(ct.getDate() - 1);
  }
  const y = ct.getFullYear();
  const m = String(ct.getMonth() + 1).padStart(2, '0');
  const d = String(ct.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getNestedValue(
  obj: Record<string, unknown>,
  ...keys: string[]
): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const FindingsSummary = memo(function FindingsSummary({
  findings,
  pipelineDate,
  plotCount,
  analyzedCount,
}: Props) {
  const dataset = findings
    ? (getNestedValue(findings, 'dataset') as Record<string, unknown> | null)
    : null;
  const totalDays = dataset
    ? (getNestedValue(dataset, 'total_days') as number | undefined)
    : undefined;
  const labeledDays = dataset
    ? (getNestedValue(dataset, 'labeled_days') as number | undefined)
    : undefined;

  const overallAccuracy =
    (getNestedValue(findings ?? {}, 'eda', 'overall_accuracy') as
      | number
      | null) ??
    (getNestedValue(findings ?? {}, 'dataset', 'overall_accuracy') as
      | number
      | null);

  const healthStatus = getNestedValue(findings ?? {}, 'health', 'status') as
    | string
    | null;

  const healthColor =
    healthStatus === 'healthy'
      ? theme.green
      : healthStatus === 'stale'
        ? theme.red
        : theme.caution;

  const lastExpected = getLastExpectedTradingDay();
  const freshnessStatus = (() => {
    if (!pipelineDate) return null;
    if (pipelineDate === lastExpected) return 'FRESH';
    // Check if exactly one trading day behind
    const expected = new Date(`${lastExpected}T12:00:00`);
    const actual = new Date(`${pipelineDate}T12:00:00`);
    const diffDays = Math.round(
      (expected.getTime() - actual.getTime()) / 86_400_000,
    );
    if (diffDays === 1) return 'MISSED';
    return 'STALE';
  })();
  const freshnessColor =
    freshnessStatus === 'FRESH'
      ? theme.green
      : freshnessStatus === 'MISSED'
        ? theme.caution
        : theme.red;

  return (
    <div
      className="border-edge grid grid-cols-2 gap-3 rounded-lg border p-3 sm:grid-cols-3 lg:grid-cols-6"
      style={{ backgroundColor: tint(theme.accent, '06') }}
    >
      {/* Pipeline Date */}
      <div>
        <div className="text-muted mb-0.5 font-sans text-[10px] font-bold tracking-[0.12em] uppercase">
          Pipeline Date
        </div>
        <div className="text-primary font-mono text-[12px] font-semibold">
          {pipelineDate ?? 'N/A'}
        </div>
      </div>

      {/* Dataset */}
      <div>
        <div className="text-muted mb-0.5 font-sans text-[10px] font-bold tracking-[0.12em] uppercase">
          Dataset
        </div>
        <div className="text-primary font-mono text-[12px] font-semibold">
          {totalDays != null ? `${totalDays} days` : 'N/A'}
          {labeledDays != null && (
            <span className="text-secondary ml-1 text-[10px] font-normal">
              ({labeledDays} labeled)
            </span>
          )}
        </div>
      </div>

      {/* Accuracy */}
      <div>
        <div className="text-muted mb-0.5 font-sans text-[10px] font-bold tracking-[0.12em] uppercase">
          Accuracy
        </div>
        <div className="font-mono text-[12px] font-semibold">
          {overallAccuracy != null ? (
            <span style={{ color: theme.accent }}>
              {(overallAccuracy * 100).toFixed(1)}%
            </span>
          ) : (
            <span className="text-muted">N/A</span>
          )}
        </div>
      </div>

      {/* Health */}
      <div>
        <div className="text-muted mb-0.5 font-sans text-[10px] font-bold tracking-[0.12em] uppercase">
          Health
        </div>
        <div className="font-mono text-[12px] font-semibold">
          {healthStatus ? (
            <span style={{ color: healthColor }}>
              {healthStatus.toUpperCase()}
            </span>
          ) : (
            <span className="text-muted">N/A</span>
          )}
        </div>
      </div>

      {/* Plots */}
      <div>
        <div className="text-muted mb-0.5 font-sans text-[10px] font-bold tracking-[0.12em] uppercase">
          Plots
        </div>
        <div className="text-primary font-mono text-[12px] font-semibold">
          {analyzedCount}/{plotCount} analyzed
        </div>
      </div>

      {/* Freshness */}
      <div>
        <div className="text-muted mb-0.5 font-sans text-[10px] font-bold tracking-[0.12em] uppercase">
          Freshness
        </div>
        <div className="font-mono text-[12px] font-semibold">
          {freshnessStatus ? (
            <span style={{ color: freshnessColor }}>{freshnessStatus}</span>
          ) : (
            <span className="text-muted">N/A</span>
          )}
        </div>
      </div>
    </div>
  );
});

export default FindingsSummary;
