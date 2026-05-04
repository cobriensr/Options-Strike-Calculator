import { useEffect, useMemo, useState } from 'react';
import { SectionBox } from '../ui/SectionBox.js';
import { useLotteryFinder } from '../../hooks/useLotteryFinder.js';
import { ctSessionBounds } from './ct-window.js';
import { LotteryDayBanner } from './LotteryDayBanner.js';
import { LotteryRow } from './LotteryRow.js';
import {
  EXIT_POLICY_LABELS,
  EXIT_POLICY_TOOLTIPS,
  type ExitPolicy,
  type LotteryFire,
  type LotteryMode,
  type OptionType,
  type TimeOfDay,
} from './types.js';

const PAGE_SIZE = 50;

const TOD_FILTERS: Array<{ value: TimeOfDay | null; label: string }> = [
  { value: null, label: 'all TOD' },
  { value: 'AM_open', label: 'AM_open' },
  { value: 'MID', label: 'MID' },
  { value: 'LUNCH', label: 'LUNCH' },
  { value: 'PM', label: 'PM' },
];

interface LotteryFinderSectionProps {
  marketOpen: boolean;
}

const EXIT_POLICIES: ExitPolicy[] = [
  'realizedTrail30_10Pct',
  'realizedHard30mPct',
  'realizedTier50HoldEodPct',
];

const MODE_FILTERS: Array<{ value: LotteryMode | null; label: string }> = [
  { value: null, label: 'All modes' },
  { value: 'A_intraday_0DTE', label: 'Mode A (0DTE)' },
  { value: 'B_multi_day_DTE1_3', label: 'Mode B (DTE 1-3)' },
];

const todayCt = (): string => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
};

const formatTimeCT = (input: string | number | Date): string => {
  const d = input instanceof Date ? input : new Date(input);
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  });
};

export function LotteryFinderSection({
  marketOpen,
}: LotteryFinderSectionProps) {
  const [date, setDate] = useState<string>(todayCt());
  /** 1-minute bucket the slider is on; null = whole day. */
  const [minute, setMinute] = useState<string | null>(null);
  const [exitPolicy, setExitPolicy] = useState<ExitPolicy>(
    'realizedTrail30_10Pct',
  );
  const [reloadOnly, setReloadOnly] = useState<boolean>(false);
  const [cheapCallPmOnly, setCheapCallPmOnly] = useState<boolean>(false);
  const [modeFilter, setModeFilter] = useState<LotteryMode | null>(null);
  const [tickerFilter, setTickerFilter] = useState<string | null>(null);
  const [optionTypeFilter, setOptionTypeFilter] = useState<OptionType | null>(
    null,
  );
  const [todFilter, setTodFilter] = useState<TimeOfDay | null>(null);
  /** 0-based page index. Reset to 0 whenever a filter or minute changes. */
  const [page, setPage] = useState<number>(0);

  // Reset to page 0 whenever the result set's identity changes.
  // Otherwise the user could be on page 3, click a filter, and land
  // on an empty page 3 of a 1-page result set.
  useEffect(() => {
    setPage(0);
  }, [
    date,
    minute,
    tickerFilter,
    reloadOnly,
    cheapCallPmOnly,
    modeFilter,
    optionTypeFilter,
    todFilter,
  ]);

  const { fires, loading, error, fetchedAt, total, offset, hasMore } =
    useLotteryFinder({
      date,
      minute,
      marketOpen,
      ticker: tickerFilter,
      reload: reloadOnly ? true : null,
      cheapCallPm: cheapCallPmOnly ? true : null,
      mode: modeFilter,
      optionType: optionTypeFilter,
      tod: todFilter,
      page,
      pageSize: PAGE_SIZE,
    });

  // Regular-session bounds (08:30 → 15:00 CT) for the selected date,
  // browser-TZ-independent. See ct-window.ts.
  const scrubBounds = useMemo(() => ctSessionBounds(date), [date]);

  const isLive = minute == null && date === todayCt();
  const isHistorical = date !== todayCt();
  // Counts on the chips reflect the current page only — after filter
  // changes the list refetches, but cross-page counts would need a
  // separate aggregation query. Acceptable: the user clicks the chip
  // to apply the filter, the API returns the precise filtered total.
  const reloadCount = useMemo(
    () => fires.filter((f) => f.tags.reload).length,
    [fires],
  );
  const cheapPmCount = useMemo(
    () => fires.filter((f) => f.tags.cheapCallPm).length,
    [fires],
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  // Top tickers by fire count in the displayed page — gives the user
  // an obvious one-click filter dimension without forcing a 50-ticker
  // dropdown. Updates whenever the result set changes (filters/scrub).
  const topTickers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of fires) {
      counts.set(f.underlyingSymbol, (counts.get(f.underlyingSymbol) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [fires]);

  return (
    <SectionBox label="Lottery Finder" collapsible>
      <div className="space-y-3">
        <p className="text-[11px] text-neutral-500">
          Signal detector — not a backtested profitable strategy. Most days
          lose; wins come from rare explosive moves. Edge concentrated in 1-2
          outlier days per 15 in the cheap-call-PM RE-LOAD subset.{' '}
          <a
            className="text-neutral-400 underline hover:text-white"
            href="/docs/superpowers/specs/lottery-finder-2026-05-02.md"
            target="_blank"
            rel="noreferrer"
          >
            methodology
          </a>
        </p>

        {/* Day-level macro banner — at-a-glance regime context */}
        <LotteryDayBanner fires={fires} />

        {/* Date + scrub controls. The slider drives a 1-minute
            point-in-time bucket — drag to a minute, see ONLY what
            fired in that minute. Click "All day" to clear. */}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5">
            <span className="text-neutral-400">date</span>
            <input
              type="date"
              value={date}
              max={todayCt()}
              onChange={(e) => {
                setDate(e.target.value);
                setMinute(null);
              }}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-white"
              aria-label="Select trading day"
            />
          </label>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={`rounded border px-2 py-1 text-xs font-semibold ${
                minute == null
                  ? 'border-green-500 bg-green-950/40 text-green-200'
                  : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-white'
              }`}
              onClick={() => setMinute(null)}
              title={
                isLive
                  ? 'Live: showing today (most recent first), polls every 30s'
                  : 'Show every fire on the selected day'
              }
            >
              {date === todayCt() ? 'Live' : 'All day'}
            </button>
            <input
              type="range"
              min={Date.parse(scrubBounds.min)}
              max={Date.parse(scrubBounds.max)}
              step={60_000}
              value={(() => {
                const lo = Date.parse(scrubBounds.min);
                const hi = Date.parse(scrubBounds.max);
                const raw = minute ? Date.parse(minute) : lo;
                return Math.max(lo, Math.min(hi, raw));
              })()}
              onChange={(e) =>
                setMinute(new Date(Number(e.target.value)).toISOString())
              }
              className="w-64"
              aria-label="Per-minute time scrubber (08:30 → 15:00 CT)"
              title="Drag to a minute to see only that minute's fires"
            />
            {minute && (
              <span className="font-mono text-xs text-purple-200">
                {formatTimeCT(minute)} CT (1 min bucket)
              </span>
            )}
          </div>
          {fetchedAt != null && !isHistorical && (
            <span className="ml-auto text-[10px] text-neutral-500">
              updated {formatTimeCT(fetchedAt)} CT
            </span>
          )}
          {isHistorical && (
            <span className="ml-auto text-[10px] text-neutral-500">
              historical replay
            </span>
          )}
        </div>

        {/* Filter chips */}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setReloadOnly(!reloadOnly)}
            className={`rounded border px-2 py-1 text-xs font-semibold ${
              reloadOnly
                ? 'border-amber-500 bg-amber-950/40 text-amber-200'
                : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-white'
            }`}
            title="Show only fires tagged RE-LOAD (burst ≥2× prior AND entry dropped ≥30%)."
          >
            RE-LOAD only <span className="text-[10px]">{reloadCount}</span>
          </button>
          <button
            type="button"
            onClick={() => setCheapCallPmOnly(!cheapCallPmOnly)}
            className={`rounded border px-2 py-1 text-xs font-semibold ${
              cheapCallPmOnly
                ? 'border-fuchsia-500 bg-fuchsia-950/40 text-fuchsia-200'
                : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-white'
            }`}
            title="Show only fires tagged cheap-call-PM (call + PM session + entry < $1). The Phase 1 selection rule."
          >
            Cheap-call-PM only{' '}
            <span className="text-[10px]">{cheapPmCount}</span>
          </button>
          {MODE_FILTERS.map((m) => (
            <button
              key={m.label}
              type="button"
              onClick={() => setModeFilter(m.value)}
              className={`rounded border px-2 py-1 text-xs font-semibold ${
                modeFilter === m.value
                  ? 'border-blue-500 bg-blue-950/40 text-blue-200'
                  : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-white'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Calls / Puts toggle */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] tracking-wide text-neutral-500 uppercase">
            type
          </span>
          {[
            { value: null, label: 'all' },
            { value: 'C' as OptionType, label: 'calls' },
            { value: 'P' as OptionType, label: 'puts' },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              onClick={() => setOptionTypeFilter(o.value)}
              className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                optionTypeFilter === o.value
                  ? o.value === 'C'
                    ? 'border-green-500 bg-green-950/40 text-green-200'
                    : o.value === 'P'
                      ? 'border-red-500 bg-red-950/40 text-red-200'
                      : 'border-neutral-500 bg-neutral-800 text-neutral-200'
                  : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-white'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {/* Time-of-day chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] tracking-wide text-neutral-500 uppercase">
            tod
          </span>
          {TOD_FILTERS.map((t) => (
            <button
              key={t.label}
              type="button"
              onClick={() => setTodFilter(t.value)}
              className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                todFilter === t.value
                  ? 'border-orange-500 bg-orange-950/40 text-orange-200'
                  : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Ticker chips — top tickers in the current result set, click
            to scope to one ticker. Universe is ~50 tickers; we show
            only those actually present so the user can spot the
            dominant tickers of the day at a glance. */}
        {(topTickers.length > 0 || tickerFilter) && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] tracking-wide text-neutral-500 uppercase">
              ticker
            </span>
            <button
              type="button"
              onClick={() => setTickerFilter(null)}
              className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                tickerFilter == null
                  ? 'border-emerald-500 bg-emerald-950/40 text-emerald-200'
                  : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-white'
              }`}
            >
              all
            </button>
            {topTickers.map(([t, n]) => (
              <button
                key={t}
                type="button"
                onClick={() => setTickerFilter(tickerFilter === t ? null : t)}
                className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                  tickerFilter === t
                    ? 'border-emerald-500 bg-emerald-950/40 text-emerald-200'
                    : 'border-neutral-700 bg-neutral-900 text-neutral-300 hover:text-white'
                }`}
                title={`Filter to ${t} only (${n} fires in current view)`}
              >
                {t} <span className="text-[10px] text-neutral-500">{n}</span>
              </button>
            ))}
            {tickerFilter && !topTickers.some(([t]) => t === tickerFilter) && (
              <button
                type="button"
                onClick={() => setTickerFilter(null)}
                className="rounded border border-emerald-500 bg-emerald-950/40 px-2 py-0.5 text-xs font-semibold text-emerald-200"
                title="Filter active but no fires for this ticker in the current view — click to clear"
              >
                {tickerFilter} <span className="text-[10px]">0</span>
              </button>
            )}
          </div>
        )}

        {/* Exit policy selector */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-neutral-400">realized exit:</span>
          {EXIT_POLICIES.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setExitPolicy(p)}
              className={`rounded border px-2 py-1 text-xs font-semibold ${
                exitPolicy === p
                  ? 'border-purple-500 bg-purple-950/40 text-purple-200'
                  : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-white'
              }`}
              title={EXIT_POLICY_TOOLTIPS[p]}
            >
              {EXIT_POLICY_LABELS[p]}
            </button>
          ))}
        </div>

        {/* Body */}
        {loading && fires.length === 0 ? (
          <div className="text-sm text-neutral-500">Loading lottery feed…</div>
        ) : error ? (
          <div
            className="rounded border border-red-500/40 bg-red-950/30 p-3 text-sm text-red-200"
            role="alert"
          >
            Error: {error}
          </div>
        ) : fires.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-950 p-3 text-sm text-neutral-400">
            {reloadOnly || cheapCallPmOnly || modeFilter ? (
              <>
                No fires on {date} matching the active filters. Try clearing a
                filter chip above.
              </>
            ) : (
              <>
                No fires for {date}. Either the detector hasn&apos;t fired yet
                today, or this date is before historical backfill. Most days are
                genuinely zero — expect 0–5 cheap-call-PM RE-LOAD fires per day
                in the universe.
              </>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-500">
              <span>
                {minute ? (
                  <>
                    {total} fire{total === 1 ? '' : 's'} at{' '}
                    <span className="font-mono text-purple-200">
                      {formatTimeCT(minute)} CT
                    </span>
                  </>
                ) : (
                  <>
                    {total} fire{total === 1 ? '' : 's'} for {date}
                  </>
                )}
                {total > 0 && (
                  <span className="ml-2 text-neutral-600">
                    showing {offset + 1}-{offset + fires.length}
                  </span>
                )}
              </span>
              {/* Pagination — only render when there's more than one page. */}
              {total > PAGE_SIZE && (
                <span className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-xs font-semibold text-neutral-300 enabled:hover:text-white disabled:opacity-40"
                    aria-label="Previous page"
                  >
                    ← prev
                  </button>
                  <span className="font-mono text-xs text-neutral-400">
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={!hasMore}
                    className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-xs font-semibold text-neutral-300 enabled:hover:text-white disabled:opacity-40"
                    aria-label="Next page"
                  >
                    next →
                  </button>
                </span>
              )}
            </div>
            {fires.map((f: LotteryFire) => (
              <LotteryRow key={f.id} fire={f} exitPolicy={exitPolicy} />
            ))}
          </div>
        )}
      </div>
    </SectionBox>
  );
}
