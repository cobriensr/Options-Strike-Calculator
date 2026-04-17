/**
 * ProgressCounter — top-of-section KPI block for dataset readiness.
 *
 * Three stacked sections:
 *   1. Headline: `N / 30 (min) / 50 (target) / 100 (robust)` + segmented bar
 *      scaled to the 100-chain robust threshold.
 *   2. Meta: elapsed calendar days (null before the first chain) and a pill
 *      row of chain counts stratified by day_type.
 *   3. Fill rates: a scrollable list of per-feature capture percentages,
 *      sorted lowest-first so the user sees what needs attention. Each item
 *      is colour-banded:
 *        green   >= 80%  (ready for modeling)
 *        amber  50-79%   (partially useful)
 *        red     < 50%   (unusable at current fill)
 *
 * Spec: docs/superpowers/specs/pyramid-tracker-2026-04-16.md §143.
 */

import { useMemo } from 'react';
import type { PyramidProgress } from '../../types/pyramid';

// Exported so ExportCSVButton / parent tests can reuse the threshold text.
export const SAMPLE_SIZE_MIN = 30;
export const SAMPLE_SIZE_TARGET = 50;
export const SAMPLE_SIZE_ROBUST = 100;

// Fill-rate band thresholds (exported for test assertions).
export const FILL_RATE_GREEN = 0.8;
export const FILL_RATE_AMBER = 0.5;

type FillRateBand = 'green' | 'amber' | 'red';

export interface ProgressCounterProps {
  readonly progress: PyramidProgress;
}

/** Classify a [0, 1] fill rate into one of the three display bands. */
function classifyFillRate(rate: number): FillRateBand {
  if (rate >= FILL_RATE_GREEN) return 'green';
  if (rate >= FILL_RATE_AMBER) return 'amber';
  return 'red';
}

/** Colour token per band — uses the app's existing --color-* CSS vars. */
const BAND_STYLE: Record<FillRateBand, { text: string; bar: string }> = {
  green: { text: 'text-success', bar: 'bg-success' },
  amber: { text: 'text-caution', bar: 'bg-caution' },
  red: { text: 'text-danger', bar: 'bg-danger' },
};

const BAND_LABEL: Record<FillRateBand, string> = {
  green: 'Ready for modeling',
  amber: 'Partially useful',
  red: 'Unusable at current fill',
};

/** Human label for the day_type pills. Capitalises the enum keys. */
function dayTypeLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Display the leg feature key as a friendly label (e.g. `ob_poc_pct` -> `ob poc pct`). */
function featureLabel(key: string): string {
  return key.replaceAll('_', ' ');
}

export default function ProgressCounter({ progress }: ProgressCounterProps) {
  const {
    total_chains,
    chains_by_day_type,
    elapsed_calendar_days,
    fill_rates,
  } = progress;

  // Progress bar percentage — capped at 100% (robust target).
  const pctOfRobust = Math.min(
    100,
    Math.round((total_chains / SAMPLE_SIZE_ROBUST) * 100),
  );

  // Sort fill rates lowest-first so the items needing attention bubble up.
  const sortedFillRates = useMemo(() => {
    return Object.entries(fill_rates).sort((a, b) => a[1] - b[1]);
  }, [fill_rates]);

  const dayTypeEntries = useMemo(
    () => Object.entries(chains_by_day_type),
    [chains_by_day_type],
  );

  return (
    <section
      aria-label="Dataset progress"
      className="border-edge bg-surface-alt flex flex-col gap-3 rounded-md border p-3"
      data-testid="pyramid-progress-counter"
    >
      {/* Headline */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span
              className="text-primary font-mono text-[18px] font-bold tabular-nums"
              data-testid="pyramid-progress-total"
            >
              {total_chains}
            </span>
            <span className="text-muted font-sans text-[11px] tracking-wide">
              / {SAMPLE_SIZE_MIN} min / {SAMPLE_SIZE_TARGET} target /{' '}
              {SAMPLE_SIZE_ROBUST} robust
            </span>
          </div>
          <span
            className="text-muted font-mono text-[11px] tabular-nums"
            aria-hidden="true"
          >
            {pctOfRobust}%
          </span>
        </div>
        <div
          className="bg-surface h-1.5 overflow-hidden rounded-full"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={SAMPLE_SIZE_ROBUST}
          aria-valuenow={total_chains}
          aria-label={`Chains logged: ${total_chains} of ${SAMPLE_SIZE_ROBUST} robust target`}
        >
          <div
            className="bg-accent h-full rounded-full transition-[width] duration-300"
            style={{ width: `${pctOfRobust}%` }}
          />
        </div>
      </div>

      {/* Meta: elapsed days + day-type pills */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-muted font-sans text-[11px]">
          {elapsed_calendar_days == null
            ? 'No chains logged yet'
            : `Collected over ${elapsed_calendar_days} ${
                elapsed_calendar_days === 1 ? 'day' : 'days'
              }`}
        </span>
        {dayTypeEntries.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1.5"
            data-testid="pyramid-progress-day-types"
          >
            {dayTypeEntries.map(([key, count]) => (
              <span
                key={key}
                className="bg-chip-bg text-muted rounded-full px-2 py-0.5 font-sans text-[10px] tracking-wider uppercase"
              >
                {dayTypeLabel(key)}:{' '}
                <span className="tabular-nums">{count}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Per-feature fill rates */}
      {sortedFillRates.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-muted font-sans text-[10px] tracking-wider uppercase">
            Per-feature fill rates
          </h3>
          <ul
            className="border-edge bg-surface max-h-56 divide-y overflow-y-auto rounded-md border"
            data-testid="pyramid-progress-fill-rates"
          >
            {sortedFillRates.map(([key, rate]) => {
              const band = classifyFillRate(rate);
              const { text, bar } = BAND_STYLE[band];
              const pct = Math.round(rate * 100);
              return (
                <li
                  key={key}
                  className="border-edge flex items-center gap-3 px-3 py-1.5 first:border-t-0"
                  data-testid={`pyramid-fill-${key}`}
                  data-band={band}
                >
                  <span className="text-primary flex-1 font-mono text-[11px]">
                    {featureLabel(key)}
                  </span>
                  <div className="bg-surface-alt h-1 w-20 overflow-hidden rounded-full">
                    <div
                      className={`${bar} h-full rounded-full`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span
                    className={`${text} w-12 text-right font-mono text-[11px] tabular-nums`}
                  >
                    {pct}%
                  </span>
                  <span
                    className={`${text} w-32 text-right font-sans text-[10px] italic`}
                    aria-hidden="true"
                  >
                    {BAND_LABEL[band]}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="text-muted font-sans text-[11px] italic">
          Fill rates appear once legs are logged.
        </p>
      )}
    </section>
  );
}
