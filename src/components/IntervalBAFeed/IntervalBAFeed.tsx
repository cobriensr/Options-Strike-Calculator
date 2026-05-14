/**
 * IntervalBAFeed — historical backtest panel for SPXW Interval B/A alerts.
 *
 * Pick a CT calendar date + intraday time window (08:30–15:00 default)
 * and the table shows every alert that fired in that slice, sorted
 * newest-first. Each row deep-links to UW's per-contract page so the
 * user can inspect the underlying tape.
 *
 * Distinct from `IntervalBAAlertBanner` (the live bottom-right toast
 * for unacknowledged alerts) — this is the analytical / backtest
 * surface against the 6,851 backfilled rows + every live alert the
 * daemon writes from here on.
 *
 * Spec: docs/superpowers/specs/interval-ba-ask-alert-2026-05-12.md.
 */

import { useMemo, useState } from 'react';
import { SectionBox } from '../ui/SectionBox';
import { DateInput } from '../ui/DateInput';
import { TimeInputCT } from '../ui/TimeInputCT';
import { useIntervalBAFeed } from '../../hooks/useIntervalBAFeed';
import { IntervalBARow } from './IntervalBARow';

const PREMIUM_FLOORS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'all' },
  { value: 250_000, label: '≥$250K' },
  { value: 500_000, label: '≥$500K' },
  { value: 1_000_000, label: '≥$1M' },
];

const CHIP_BASE =
  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-sans text-[11px] font-medium transition-colors';
const CHIP_INACTIVE =
  'border-neutral-800 bg-neutral-900/60 text-neutral-400 hover:border-neutral-700 hover:text-neutral-100';
const CHIP_ACTIVE = 'border-sky-500/70 bg-sky-950/40 text-sky-200';

const SECTION_LABEL =
  'text-[10px] font-semibold tracking-[0.08em] text-neutral-500 uppercase';

function todayCt(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function formatPremiumCompact(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1000)}K`;
  return `$${n.toFixed(0)}`;
}

function formatFetchedAtCT(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  });
}

interface IntervalBAFeedProps {
  /**
   * Whether the user's session is live (drives polling on the lazy
   * tape/flow hooks inside expanded rows). Defaults to false so the
   * component is usable in tests and SSR without prop wiring.
   */
  marketOpen?: boolean;
}

export function IntervalBAFeed({
  marketOpen = false,
}: Readonly<IntervalBAFeedProps> = {}) {
  const [date, setDate] = useState<string>(todayCt());
  const [startTime, setStartTime] = useState<string>('08:30');
  const [endTime, setEndTime] = useState<string>('15:00');
  const [optionType, setOptionType] = useState<'C' | 'P' | null>(null);
  const [minPremium, setMinPremium] = useState<number>(0);
  const [confluenceOnly, setConfluenceOnly] = useState<boolean>(false);

  const params = useMemo(
    () => ({
      date,
      startTime,
      endTime,
      optionType,
      minPremium,
      confluenceOnly,
    }),
    [date, startTime, endTime, optionType, minPremium, confluenceOnly],
  );
  const { alerts, summary, loading, error, fetchedAt, refetch } =
    useIntervalBAFeed(params);

  return (
    <SectionBox label="Interval B/A History" collapsible>
      <div className="space-y-3">
        <p className="text-[11px] text-neutral-500">
          Historical SPXW Interval B/A ask-side alerts. Pick a date and intraday
          CT time window — table shows every alert that fired in that slice,
          click ↗ to open the contract on Unusual Whales. Backfilled from Full
          Tape parquets Jan 2 → May 11 2026; live rows append as the uw-stream
          daemon emits them.
        </p>

        <div className="space-y-2 rounded-lg border border-neutral-800/80 bg-neutral-950/40 p-2.5">
          {/* Row 1: date + time pickers + refresh widget */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <DateInput
              value={date}
              onChange={setDate}
              label="Date"
              max={todayCt()}
            />
            <TimeInputCT
              value={startTime}
              onChange={setStartTime}
              label="Start"
              max={endTime}
            />
            <TimeInputCT
              value={endTime}
              onChange={setEndTime}
              label="End"
              min={startTime}
            />
            <div className="ml-auto flex items-center gap-2">
              {fetchedAt != null && (
                <span className="font-sans text-[10px] text-neutral-500">
                  updated {formatFetchedAtCT(fetchedAt)} CT
                </span>
              )}
              <button
                type="button"
                onClick={refetch}
                disabled={loading}
                title="Refetch the feed for the current filters"
                aria-label="Refresh feed"
                className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900/60 text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
                >
                  <path d="M21 12a9 9 0 1 1-3.46-7.08" />
                  <path d="M21 3v6h-6" />
                </svg>
              </button>
            </div>
          </div>

          {/* Row 2: option type filter */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={SECTION_LABEL}>type</span>
            {(
              [
                { value: null, label: 'all' },
                { value: 'C', label: 'calls' },
                { value: 'P', label: 'puts' },
              ] as const
            ).map((o) => {
              const active = optionType === o.value;
              return (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => setOptionType(o.value)}
                  className={`${CHIP_BASE} ${active ? CHIP_ACTIVE : CHIP_INACTIVE}`}
                  aria-pressed={active}
                >
                  {o.label}
                </button>
              );
            })}
            <span className="mx-1 hidden h-3 w-px bg-neutral-800 sm:block" />
            <span className={SECTION_LABEL}>min prem</span>
            {PREMIUM_FLOORS.map((p) => {
              const active = minPremium === p.value;
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setMinPremium(p.value)}
                  className={`${CHIP_BASE} ${active ? CHIP_ACTIVE : CHIP_INACTIVE}`}
                  aria-pressed={active}
                >
                  {p.label}
                </button>
              );
            })}
            <span className="mx-1 hidden h-3 w-px bg-neutral-800 sm:block" />
            <button
              type="button"
              onClick={() => setConfluenceOnly((v) => !v)}
              aria-pressed={confluenceOnly}
              title="Only show alerts that fired with at least one same-direction partner from SPY/SPXW/QQQ within ~90s. Confluence cohort: +8pp CALL hit-rate vs solo (2026-05-12 backfill)."
              className={`${CHIP_BASE} ${confluenceOnly ? CHIP_ACTIVE : CHIP_INACTIVE}`}
            >
              confluence only
            </button>
          </div>
        </div>

        {/* Summary banner */}
        {summary && summary.count > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-neutral-800/80 bg-neutral-950/40 px-3 py-2 text-xs">
            <span className="font-sans">
              <span className="text-neutral-100">{summary.count}</span>{' '}
              <span className="text-neutral-500">
                alert{summary.count === 1 ? '' : 's'} ·{' '}
                {formatPremiumCompact(summary.total_premium)} total premium
              </span>
            </span>
            <span className="ml-auto flex items-center gap-2 text-[11px]">
              {summary.extreme > 0 && (
                <span className="rounded border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 text-rose-200">
                  extreme {summary.extreme}
                </span>
              )}
              {summary.critical > 0 && (
                <span className="rounded border border-orange-500/40 bg-orange-500/10 px-1.5 py-0.5 text-orange-200">
                  critical {summary.critical}
                </span>
              )}
              {summary.warning > 0 && (
                <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-amber-200">
                  warning {summary.warning}
                </span>
              )}
            </span>
          </div>
        )}

        {/* Body */}
        {loading ? (
          <div className="text-sm text-neutral-500">
            Loading interval B/A feed…
          </div>
        ) : error ? (
          <div
            className="rounded border border-red-500/40 bg-red-950/30 p-3 text-sm text-red-200"
            role="alert"
          >
            Error: {error}
          </div>
        ) : alerts.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-950 p-3 text-sm text-neutral-400">
            No SPXW Interval B/A alerts on {date} between {startTime} and{' '}
            {endTime} CT matching the active filters.
          </div>
        ) : (
          <div className="space-y-1">
            {alerts.map((a) => (
              <IntervalBARow
                key={a.id}
                alert={a}
                date={date}
                marketOpen={marketOpen}
              />
            ))}
          </div>
        )}
      </div>
    </SectionBox>
  );
}
