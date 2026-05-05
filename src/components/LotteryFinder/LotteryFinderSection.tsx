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
  type LotterySortMode,
  type OptionType,
  type TimeOfDay,
} from './types.js';

const PAGE_SIZE = 50;
/** localStorage keys for persisting user preferences. */
const SORT_LS_KEY = 'lottery.sortMode';
const CONVICTION_LS_KEY = 'lottery.convictionFloor';
/**
 * Legacy boolean key (pre-Tier 2 filter). Read on init for migration
 * then ignored — the new key supersedes it.
 */
const LEGACY_HIGH_CONVICTION_LS_KEY = 'lottery.highConvictionOnly';
/** Tier floors — match LOTTERY_TIER_THRESHOLDS on the API. */
const TIER1_MIN_SCORE = 18;
const TIER2_MIN_SCORE = 12;

type ConvictionFloor = 'all' | 'tier2' | 'tier1';

const CONVICTION_OPTIONS: Array<{
  value: ConvictionFloor;
  label: string;
  tooltip: string;
}> = [
  {
    value: 'all',
    label: 'all',
    tooltip: 'No score floor — show every fire including Tier 3.',
  },
  {
    value: 'tier2',
    label: '🔥🔥 Tier 2+',
    tooltip: `Tier 2 or better (score ≥ ${TIER2_MIN_SCORE}). Historical high-peak rate ~63% (vs ~32% for Tier 3).`,
  },
  {
    value: 'tier1',
    label: '🔥🔥🔥 Tier 1',
    tooltip: `Tier 1 only (score ≥ ${TIER1_MIN_SCORE}). Historical high-peak rate ~80%, ~4 fires/day.`,
  },
];

const CONVICTION_TO_MIN_SCORE: Record<ConvictionFloor, number | null> = {
  all: null,
  tier2: TIER2_MIN_SCORE,
  tier1: TIER1_MIN_SCORE,
};

const SORT_OPTIONS: Array<{
  value: LotterySortMode;
  label: string;
  tooltip: string;
}> = [
  {
    value: 'chronological',
    label: 'newest',
    tooltip: 'Order by trigger time (most recent first). Default.',
  },
  {
    value: 'score',
    label: 'score',
    tooltip:
      'Order by composite score (Tier 1 first). Highest-conviction fires float to the top regardless of fire time.',
  },
  {
    value: 'peak',
    label: 'peak',
    tooltip:
      'Order by realized peak ceiling (largest move first). Post-hoc browsing — only meaningful once enrich-lottery-outcomes has populated peak_ceiling_pct.',
  },
];

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
  'realizedFlowInversionPct',
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

interface ExportUrlParams {
  date: string;
  ticker?: string | null;
  reload?: boolean | null;
  cheapCallPm?: boolean | null;
  mode?: LotteryMode | null;
  optionType?: OptionType | null;
  tod?: TimeOfDay | null;
  minScore?: number | null;
}

/**
 * Build the /api/lottery-export URL with only the params the user
 * actually set. Boolean-true flags get serialized; null / false are
 * omitted so the server schema's `.optional()` defaults are preserved.
 */
const buildExportUrl = (params: ExportUrlParams): string => {
  const sp = new URLSearchParams({ date: params.date });
  if (params.ticker) sp.set('ticker', params.ticker);
  if (params.reload === true) sp.set('reload', 'true');
  if (params.cheapCallPm === true) sp.set('cheapCallPm', 'true');
  if (params.mode) sp.set('mode', params.mode);
  if (params.optionType) sp.set('optionType', params.optionType);
  if (params.tod) sp.set('tod', params.tod);
  if (params.minScore != null) sp.set('minScore', String(params.minScore));
  return `/api/lottery-export?${sp.toString()}`;
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
  // Persisted preferences. SSR-safe init via lazy useState fn.
  const [sortMode, setSortMode] = useState<LotterySortMode>(() => {
    if (typeof window === 'undefined') return 'chronological';
    const stored = window.localStorage.getItem(SORT_LS_KEY);
    return stored === 'score' || stored === 'peak' ? stored : 'chronological';
  });
  const [convictionFloor, setConvictionFloor] = useState<ConvictionFloor>(
    () => {
      if (typeof window === 'undefined') return 'all';
      const stored = window.localStorage.getItem(CONVICTION_LS_KEY);
      if (stored === 'tier1' || stored === 'tier2' || stored === 'all') {
        return stored;
      }
      // One-time migration from the legacy boolean key. '1' means the
      // user had Tier 1 only enabled before; preserve that intent.
      const legacy = window.localStorage.getItem(LEGACY_HIGH_CONVICTION_LS_KEY);
      return legacy === '1' ? 'tier1' : 'all';
    },
  );
  /** 0-based page index. Reset to 0 whenever a filter or minute changes. */
  const [page, setPage] = useState<number>(0);

  // Persist on change. The === checks keep the writes idempotent so
  // we don't thrash the storage on every render.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SORT_LS_KEY, sortMode);
    }
  }, [sortMode]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(CONVICTION_LS_KEY, convictionFloor);
    }
  }, [convictionFloor]);

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
    sortMode,
    convictionFloor,
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
      sort: sortMode,
      minScore: CONVICTION_TO_MIN_SCORE[convictionFloor],
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

        {/* Date + scrub controls. Prev/next buttons step the 1-minute
            point-in-time bucket by ±1 min — the drag slider was too
            finicky to land on a target minute. Click "All day" /
            "Live" to clear the bucket. Keyboard: tab to a button and
            press space/enter to step. */}
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
            {/* Per-minute step controls. Lo = 08:30 CT, hi = 15:00 CT
                (regular session). When `minute` is null, prev seeds
                from the upper bound (scrub back from close) and next
                seeds from the lower bound (scrub forward from open). */}
            {(() => {
              const lo = Date.parse(scrubBounds.min);
              const hi = Date.parse(scrubBounds.max);
              const cur = minute ? Date.parse(minute) : null;
              const atMin = cur != null && cur <= lo;
              const atMax = cur != null && cur >= hi;
              const step = (deltaMs: number) => {
                const seed = cur ?? (deltaMs < 0 ? hi : lo);
                const next = Math.max(lo, Math.min(hi, seed + deltaMs));
                setMinute(new Date(next).toISOString());
              };
              return (
                <>
                  <button
                    type="button"
                    onClick={() => step(-60_000)}
                    disabled={atMin}
                    className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs font-semibold text-neutral-300 enabled:hover:text-white disabled:opacity-40"
                    aria-label="Step back one minute"
                    title="Step back one minute (−1m)"
                  >
                    ◀ −1m
                  </button>
                  <button
                    type="button"
                    onClick={() => step(60_000)}
                    disabled={atMax}
                    className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs font-semibold text-neutral-300 enabled:hover:text-white disabled:opacity-40"
                    aria-label="Step forward one minute"
                    title="Step forward one minute (+1m)"
                  >
                    +1m ▶
                  </button>
                </>
              );
            })()}
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

        {/* Export bar — owner-only CSV dump of the day. "Filtered"
            mirrors the active feed filters; "All" is date-only. The
            anchor element with `download` attribute lets the browser
            handle the file save while carrying the owner cookie
            naturally (no JS fetch + Blob round-trip needed). */}
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-[10px] tracking-wide text-neutral-500 uppercase">
            export
          </span>
          <a
            href={buildExportUrl({
              date,
              ticker: tickerFilter,
              reload: reloadOnly ? true : null,
              cheapCallPm: cheapCallPmOnly ? true : null,
              mode: modeFilter,
              optionType: optionTypeFilter,
              tod: todFilter,
              minScore: CONVICTION_TO_MIN_SCORE[convictionFloor],
            })}
            download
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-xs font-semibold text-neutral-300 hover:text-white"
            title="Export the current filtered view as CSV (one row per fire, all columns)."
          >
            ⤓ filtered
          </a>
          <a
            href={buildExportUrl({ date })}
            download
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-xs font-semibold text-neutral-300 hover:text-white"
            title="Export every fire on the selected day as CSV — ignores active filters."
          >
            ⤓ all
          </a>
        </div>

        {/* Sort + High Conviction filter — score-driven controls
            that gate the API ORDER BY and WHERE clauses. Persist to
            localStorage so the user's preferred ranking sticks across
            reloads. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] tracking-wide text-neutral-500 uppercase">
            sort
          </span>
          {SORT_OPTIONS.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setSortMode(s.value)}
              className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                sortMode === s.value
                  ? 'border-sky-500 bg-sky-950/40 text-sky-200'
                  : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-white'
              }`}
              title={s.tooltip}
              aria-pressed={sortMode === s.value}
            >
              {s.label}
            </button>
          ))}
          <span className="ml-2 text-[10px] tracking-wide text-neutral-500 uppercase">
            conviction
          </span>
          {CONVICTION_OPTIONS.map((c) => {
            const active = convictionFloor === c.value;
            // Tier 1 = rose (most exclusive), Tier 2+ = amber, all =
            // neutral. The active style tracks the floor so the
            // user can read the filter at a glance.
            const activeClass =
              c.value === 'tier1'
                ? 'border-rose-500 bg-rose-950/40 text-rose-200'
                : c.value === 'tier2'
                  ? 'border-amber-500 bg-amber-950/40 text-amber-200'
                  : 'border-emerald-500 bg-emerald-950/40 text-emerald-200';
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => setConvictionFloor(c.value)}
                className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                  active
                    ? activeClass
                    : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-white'
                }`}
                title={c.tooltip}
                aria-pressed={active}
              >
                {c.label}
              </button>
            );
          })}
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
                {convictionFloor !== 'all' && (
                  <span
                    className={`ml-2 ${
                      convictionFloor === 'tier1'
                        ? 'text-rose-300/80'
                        : 'text-amber-300/80'
                    }`}
                  >
                    ({convictionFloor === 'tier1' ? 'Tier 1 only' : 'Tier 2+'})
                  </span>
                )}
                {sortMode !== 'chronological' && (
                  <span className="ml-2 text-sky-300/80">
                    sorted by {sortMode}
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
              <LotteryRow
                // Key by chain (stable across polls). Using `f.id`
                // would change every time a new fire on the same
                // chain bumps the rep id, remounting the row and
                // losing the user's expand state.
                key={f.optionChainId}
                fire={f}
                exitPolicy={exitPolicy}
                marketOpen={marketOpen}
              />
            ))}
          </div>
        )}
      </div>
    </SectionBox>
  );
}
