import { useEffect, useMemo, useState } from 'react';
import { SectionBox } from '../ui/SectionBox.js';
import { useLotteryFinder } from '../../hooks/useLotteryFinder.js';
import { ctSessionBounds } from './ct-window.js';
import { LotteryDayBanner } from './LotteryDayBanner.js';
import { LotteryTierBanner } from './LotteryTierBanner.js';
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
const HIDE_LATE_PM_LS_KEY = 'lottery.hideLatePm';
/**
 * Late-PM cutoff (CT minute-of-day). Fires whose triggerTimeCt is at
 * or after this minute are hidden when the filter is on. 14:30 CT —
 * 30 min before regular-session close — chosen because by that point
 * there is structurally not enough remaining session for the
 * cumulative-flow shape to develop a peak + inversion, so the
 * flow_inversion exit policy can't fire and the fire becomes a coin
 * flip on theta crush.
 */
const LATE_PM_CUTOFF_MIN_OF_DAY = 14 * 60 + 30;
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

/**
 * Shared chip styling. Every filter pill in the toolbar uses these so
 * padding, radius, and weight stay consistent across groups. Active
 * variants are looked up by accent name (Tailwind JIT can't synthesize
 * `border-${color}-500` from a runtime string).
 */
const CHIP_BASE =
  'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors';
const CHIP_INACTIVE =
  'border-neutral-800 bg-neutral-900/60 text-neutral-400 hover:border-neutral-700 hover:text-neutral-100';
const CHIP_ACTIVE: Record<
  | 'sky'
  | 'rose'
  | 'amber'
  | 'emerald'
  | 'green'
  | 'red'
  | 'blue'
  | 'fuchsia'
  | 'orange'
  | 'purple'
  | 'neutral',
  string
> = {
  sky: 'border-sky-500/70 bg-sky-950/40 text-sky-200',
  rose: 'border-rose-500/70 bg-rose-950/40 text-rose-200',
  amber: 'border-amber-500/70 bg-amber-950/40 text-amber-200',
  emerald: 'border-emerald-500/70 bg-emerald-950/40 text-emerald-200',
  green: 'border-green-500/70 bg-green-950/40 text-green-200',
  red: 'border-red-500/70 bg-red-950/40 text-red-200',
  blue: 'border-blue-500/70 bg-blue-950/40 text-blue-200',
  fuchsia: 'border-fuchsia-500/70 bg-fuchsia-950/40 text-fuchsia-200',
  orange: 'border-orange-500/70 bg-orange-950/40 text-orange-200',
  purple: 'border-purple-500/70 bg-purple-950/40 text-purple-200',
  neutral: 'border-neutral-500 bg-neutral-800 text-neutral-200',
};

const SECTION_LABEL =
  'text-[10px] font-semibold tracking-[0.08em] text-neutral-500 uppercase';
const TOOLBAR_DIVIDER = 'mx-1 hidden h-4 w-px bg-neutral-800 sm:block';

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
  const [hideLatePm, setHideLatePm] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(HIDE_LATE_PM_LS_KEY) === '1';
  });
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
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(HIDE_LATE_PM_LS_KEY, hideLatePm ? '1' : '0');
    }
  }, [hideLatePm]);

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

  // Current wall-clock minute (UTC ms, floored to the minute). Used
  // to cap forward navigation when viewing today — can't pick a
  // minute that hasn't happened yet. Refreshed every 30s so the
  // dropdown grows in lockstep with the trading session. Calling
  // Date.now() inline during render would violate React 19's
  // react-hooks/purity rule.
  const [nowMinuteMs, setNowMinuteMs] = useState<number>(
    () => Math.floor(Date.now() / 60_000) * 60_000,
  );
  useEffect(() => {
    const id = setInterval(() => {
      setNowMinuteMs(Math.floor(Date.now() / 60_000) * 60_000);
    }, 30_000);
    return () => clearInterval(id);
  }, []);

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

  // Late-PM cutoff is applied client-side: keep `total` and pagination
  // tied to the server's view (so filter chips and counts remain
  // accurate to what's in the DB), and only filter the rendered list.
  // The DOM-Intl conversion handles DST transparently.
  const ctMinuteOfDay = useMemo(() => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
    return (iso: string): number => {
      const parts = fmt.formatToParts(new Date(iso));
      const h = Number.parseInt(
        parts.find((p) => p.type === 'hour')?.value ?? '0',
        10,
      );
      const m = Number.parseInt(
        parts.find((p) => p.type === 'minute')?.value ?? '0',
        10,
      );
      // 24-hour formatter sometimes emits hour=24 at midnight.
      const hh = h === 24 ? 0 : h;
      return hh * 60 + m;
    };
  }, []);
  const displayedFires = useMemo(() => {
    if (!hideLatePm) return fires;
    return fires.filter(
      (f) => ctMinuteOfDay(f.triggerTimeCt) < LATE_PM_CUTOFF_MIN_OF_DAY,
    );
  }, [fires, hideLatePm, ctMinuteOfDay]);
  const hiddenLatePmCount = fires.length - displayedFires.length;

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

        {/* Day-level tier breakdown — counts + dominant ticker + top
            score on the current page. Mirrors SilentBoomDayBanner. */}
        <LotteryTierBanner fires={fires} total={total} />

        {/* Filter toolbar — single contained panel for date/scrub,
            sort/conviction, type/TOD, mode tags, ticker, and exit
            policy. All chips share CHIP_BASE styling so spacing and
            weight stay consistent across groups. */}
        <div className="space-y-2.5 rounded-lg border border-neutral-800/80 bg-neutral-950/40 p-2.5">
          {/* Row 1: date + scrub controls. Prev/next buttons step the
            1-minute point-in-time bucket by ±1 min — the drag slider
            was too finicky to land on a target minute. Click "All
            day" / "Live" to clear the bucket. Keyboard: tab to a
            button and press space/enter to step. Export anchors are
            inlined to the right so the toolbar starts with a single
            row of controls instead of two. */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1.5">
              <span className={SECTION_LABEL}>date</span>
              <input
                type="date"
                value={date}
                max={todayCt()}
                onChange={(e) => {
                  setDate(e.target.value);
                  setMinute(null);
                }}
                className="rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-1 font-mono text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none"
                aria-label="Select trading day"
              />
            </label>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className={`${CHIP_BASE} ${
                  minute == null ? CHIP_ACTIVE.green : CHIP_INACTIVE
                }`}
                onClick={() => setMinute(null)}
                title={
                  isLive
                    ? 'Live: showing today (most recent first), polls every 30s'
                    : 'Show every fire on the selected day'
                }
                aria-pressed={minute == null}
              >
                {date === todayCt() ? 'Live' : 'All day'}
              </button>
              {/* Per-minute controls. Lo = 08:30 CT, hi = 15:00 CT
                (regular session). For today, hi is further capped at
                the current CT minute (floored) so the user can't
                scrub into the future. When `minute` is null, prev
                seeds from the (effective) upper bound and next seeds
                from the lower bound. The <select> lists every valid
                minute as a fast-jump dropdown. */}
              {(() => {
                const lo = Date.parse(scrubBounds.min);
                const hi = Date.parse(scrubBounds.max);
                const isToday = date === todayCt();
                const effectiveHi = isToday ? Math.min(hi, nowMinuteMs) : hi;
                const noValidBucket = effectiveHi < lo;
                const cur = minute ? Date.parse(minute) : null;
                const atMin = noValidBucket || (cur != null && cur <= lo);
                const atMax =
                  noValidBucket || (cur != null && cur >= effectiveHi);
                const step = (deltaMs: number) => {
                  const seed = cur ?? (deltaMs < 0 ? effectiveHi : lo);
                  const next = Math.max(
                    lo,
                    Math.min(effectiveHi, seed + deltaMs),
                  );
                  setMinute(new Date(next).toISOString());
                };
                const options: { value: string; label: string }[] = [];
                if (!noValidBucket) {
                  for (let t = lo; t <= effectiveHi; t += 60_000) {
                    const iso = new Date(t).toISOString();
                    options.push({ value: iso, label: formatTimeCT(iso) });
                  }
                }
                return (
                  <>
                    <button
                      type="button"
                      onClick={() => step(-60_000)}
                      disabled={atMin}
                      className={`${CHIP_BASE} ${CHIP_INACTIVE} disabled:opacity-40 disabled:hover:border-neutral-800 disabled:hover:text-neutral-400`}
                      aria-label="Step back one minute"
                      title="Step back one minute (−1m)"
                    >
                      ◀ −1m
                    </button>
                    <select
                      value={minute ?? ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        setMinute(v === '' ? null : v);
                      }}
                      disabled={noValidBucket}
                      aria-label="Jump to a specific minute (Central Time)"
                      title={
                        isToday
                          ? `Jump to a specific minute. Capped at the current CT minute (${formatTimeCT(nowMinuteMs)}).`
                          : 'Jump to a specific minute (08:30–15:00 CT).'
                      }
                      className="rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-1 font-mono text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-40"
                    >
                      <option value="">— pick —</option>
                      {options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => step(60_000)}
                      disabled={atMax}
                      className={`${CHIP_BASE} ${CHIP_INACTIVE} disabled:opacity-40 disabled:hover:border-neutral-800 disabled:hover:text-neutral-400`}
                      aria-label="Step forward one minute"
                      title={
                        isToday && cur != null && cur >= effectiveHi
                          ? 'Cannot step past the current minute'
                          : 'Step forward one minute (+1m)'
                      }
                    >
                      +1m ▶
                    </button>
                  </>
                );
              })()}
              {minute && (
                <span className="font-mono text-xs text-purple-200">
                  (1 min bucket)
                </span>
              )}
            </div>
            {/* Export anchors — owner-only CSV dump of the day. "Filtered"
              mirrors the active feed filters; "All" is date-only. The
              anchor element with `download` attribute lets the browser
              handle the file save while carrying the owner cookie
              naturally (no JS fetch + Blob round-trip needed). Inlined
              here so the toolbar starts with one row of controls. */}
            <div className="ml-auto flex items-center gap-1.5">
              <span className={SECTION_LABEL}>export</span>
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
                className={`${CHIP_BASE} ${CHIP_INACTIVE}`}
                title="Export the current filtered view as CSV (one row per fire, all columns)."
              >
                ⤓ filtered
              </a>
              <a
                href={buildExportUrl({ date })}
                download
                className={`${CHIP_BASE} ${CHIP_INACTIVE}`}
                title="Export every fire on the selected day as CSV — ignores active filters."
              >
                ⤓ all
              </a>
              {fetchedAt != null && !isHistorical && (
                <span className="ml-1 text-[10px] text-neutral-500">
                  updated {formatTimeCT(fetchedAt)} CT
                </span>
              )}
              {isHistorical && (
                <span className="ml-1 text-[10px] text-neutral-500">
                  historical replay
                </span>
              )}
            </div>
          </div>

          {/* Row 2: Sort + Conviction — score-driven controls that gate
            the API ORDER BY and WHERE clauses. Persist to localStorage
            so the user's preferred ranking sticks across reloads. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={SECTION_LABEL}>sort</span>
            {SORT_OPTIONS.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setSortMode(s.value)}
                className={`${CHIP_BASE} ${
                  sortMode === s.value ? CHIP_ACTIVE.sky : CHIP_INACTIVE
                }`}
                title={s.tooltip}
                aria-pressed={sortMode === s.value}
              >
                {s.label}
              </button>
            ))}
            <span className={TOOLBAR_DIVIDER} aria-hidden="true" />
            <span className={SECTION_LABEL}>conviction</span>
            {CONVICTION_OPTIONS.map((c) => {
              const active = convictionFloor === c.value;
              // Tier 1 = rose (most exclusive), Tier 2+ = amber, all =
              // emerald. The active style tracks the floor so the user
              // can read the filter at a glance.
              const activeColor: keyof typeof CHIP_ACTIVE =
                c.value === 'tier1'
                  ? 'rose'
                  : c.value === 'tier2'
                    ? 'amber'
                    : 'emerald';
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setConvictionFloor(c.value)}
                  className={`${CHIP_BASE} ${
                    active ? CHIP_ACTIVE[activeColor] : CHIP_INACTIVE
                  }`}
                  title={c.tooltip}
                  aria-pressed={active}
                >
                  {c.label}
                </button>
              );
            })}
          </div>

          {/* Row 3: Tag toggles + Mode (A/B/all). RE-LOAD and
            cheap-call-PM are independent boolean toggles with their
            own counts; the MODE_FILTERS group is a single-select
            radio set. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={SECTION_LABEL}>mode</span>
            <button
              type="button"
              onClick={() => setReloadOnly(!reloadOnly)}
              className={`${CHIP_BASE} ${
                reloadOnly ? CHIP_ACTIVE.amber : CHIP_INACTIVE
              }`}
              title="Show only fires tagged RE-LOAD (burst ≥2× prior AND entry dropped ≥30%)."
              aria-pressed={reloadOnly}
            >
              RE-LOAD only{' '}
              <span className="text-[10px] opacity-70">{reloadCount}</span>
            </button>
            <button
              type="button"
              onClick={() => setCheapCallPmOnly(!cheapCallPmOnly)}
              className={`${CHIP_BASE} ${
                cheapCallPmOnly ? CHIP_ACTIVE.fuchsia : CHIP_INACTIVE
              }`}
              title="Show only fires tagged cheap-call-PM (call + PM session + entry < $1). The Phase 1 selection rule."
              aria-pressed={cheapCallPmOnly}
            >
              Cheap-call-PM only{' '}
              <span className="text-[10px] opacity-70">{cheapPmCount}</span>
            </button>
            <span className={TOOLBAR_DIVIDER} aria-hidden="true" />
            {MODE_FILTERS.map((m) => (
              <button
                key={m.label}
                type="button"
                onClick={() => setModeFilter(m.value)}
                className={`${CHIP_BASE} ${
                  modeFilter === m.value ? CHIP_ACTIVE.blue : CHIP_INACTIVE
                }`}
                aria-pressed={modeFilter === m.value}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Row 4: Type (calls/puts) + Time-of-day. Two single-select
            groups merged into one row with a divider — both are
            narrow-cardinality option-type filters and read more
            cleanly side-by-side than as separate rows. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={SECTION_LABEL}>type</span>
            {[
              { value: null, label: 'all' },
              { value: 'C' as OptionType, label: 'calls' },
              { value: 'P' as OptionType, label: 'puts' },
            ].map((o) => {
              const active = optionTypeFilter === o.value;
              const activeColor: keyof typeof CHIP_ACTIVE =
                o.value === 'C' ? 'green' : o.value === 'P' ? 'red' : 'neutral';
              return (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => setOptionTypeFilter(o.value)}
                  className={`${CHIP_BASE} ${
                    active ? CHIP_ACTIVE[activeColor] : CHIP_INACTIVE
                  }`}
                  aria-pressed={active}
                >
                  {o.label}
                </button>
              );
            })}
            <span className={TOOLBAR_DIVIDER} aria-hidden="true" />
            <span className={SECTION_LABEL}>tod</span>
            {TOD_FILTERS.map((t) => (
              <button
                key={t.label}
                type="button"
                onClick={() => setTodFilter(t.value)}
                className={`${CHIP_BASE} ${
                  todFilter === t.value ? CHIP_ACTIVE.orange : CHIP_INACTIVE
                }`}
                aria-pressed={todFilter === t.value}
              >
                {t.label}
              </button>
            ))}
            <span className={TOOLBAR_DIVIDER} aria-hidden="true" />
            <button
              type="button"
              onClick={() => setHideLatePm(!hideLatePm)}
              className={`${CHIP_BASE} ${
                hideLatePm ? CHIP_ACTIVE.purple : CHIP_INACTIVE
              }`}
              title="Hide fires triggered after 14:30 CT. Late-PM fires often lack enough remaining session for the flow_inversion signal to develop, so they devolve into theta-decay coin flips. Client-side filter — toolbar counts and pagination still reflect the full DB result."
              aria-pressed={hideLatePm}
            >
              hide post-14:30
              {hideLatePm && hiddenLatePmCount > 0 && (
                <span className="text-[10px] opacity-70">
                  −{hiddenLatePmCount}
                </span>
              )}
            </button>
          </div>

          {/* Row 5 (conditional): Ticker chips — top tickers in the
            current result set, click to scope to one ticker. Universe
            is ~50 tickers; we show only those actually present so the
            user can spot the dominant tickers of the day at a glance. */}
          {(topTickers.length > 0 || tickerFilter) && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={SECTION_LABEL}>ticker</span>
              <button
                type="button"
                onClick={() => setTickerFilter(null)}
                className={`${CHIP_BASE} ${
                  tickerFilter == null ? CHIP_ACTIVE.emerald : CHIP_INACTIVE
                }`}
                aria-pressed={tickerFilter == null}
              >
                all
              </button>
              {topTickers.map(([t, n]) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTickerFilter(tickerFilter === t ? null : t)}
                  className={`${CHIP_BASE} ${
                    tickerFilter === t ? CHIP_ACTIVE.emerald : CHIP_INACTIVE
                  }`}
                  title={`Filter to ${t} only (${n} fires in current view)`}
                  aria-pressed={tickerFilter === t}
                >
                  {t} <span className="text-[10px] opacity-70">{n}</span>
                </button>
              ))}
              {tickerFilter &&
                !topTickers.some(([t]) => t === tickerFilter) && (
                  <button
                    type="button"
                    onClick={() => setTickerFilter(null)}
                    className={`${CHIP_BASE} ${CHIP_ACTIVE.emerald}`}
                    title="Filter active but no fires for this ticker in the current view — click to clear"
                  >
                    {tickerFilter}{' '}
                    <span className="text-[10px] opacity-70">0</span>
                  </button>
                )}
            </div>
          )}

          {/* Row 6: Exit policy selector — single-select set governing
            which realized-exit metric drives the row badges below. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={SECTION_LABEL}>realized exit</span>
            {EXIT_POLICIES.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setExitPolicy(p)}
                className={`${CHIP_BASE} ${
                  exitPolicy === p ? CHIP_ACTIVE.purple : CHIP_INACTIVE
                }`}
                title={EXIT_POLICY_TOOLTIPS[p]}
                aria-pressed={exitPolicy === p}
              >
                {EXIT_POLICY_LABELS[p]}
              </button>
            ))}
          </div>
        </div>
        {/* /toolbar panel */}

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
                {hideLatePm && hiddenLatePmCount > 0 && (
                  <span className="ml-2 text-purple-300/80">
                    ({hiddenLatePmCount} hidden after 14:30 CT)
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
            {displayedFires.map((f: LotteryFire) => (
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
