import { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionBox } from '../ui/SectionBox.js';
import { useLotteryFinder } from '../../hooks/useLotteryFinder.js';
import { useLotteryFinderTickerCounts } from '../../hooks/useLotteryFinderTickerCounts.js';
import { ctSessionBounds } from './ct-window.js';
import { LotteryDayBanner } from './LotteryDayBanner.js';
import { LotteryTierBanner } from './LotteryTierBanner.js';
import { LotteryFinderTickerGroup } from './LotteryFinderTickerGroup.js';
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
import {
  BURST_STORM_INTENSITY_THRESHOLDS,
  computeRollupAggregates,
  isBurstStorm,
  isHighConviction,
  type RollupAlertSummary,
} from '../../utils/ticker-rollup-aggregates.js';

const PAGE_SIZE = 50;
/** localStorage keys for persisting user preferences. */
const SORT_LS_KEY = 'lottery.sortMode';
const CONVICTION_LS_KEY = 'lottery.convictionFloor';
const HIDE_LATE_PM_LS_KEY = 'lottery.hideLatePm';
const HIDE_GATED_LS_KEY = 'lottery.hideGated';
const HIDE_ROUND_TRIPPED_LS_KEY = 'lottery.hideRoundTripped';
const AGGRESSIVE_PREMIUM_LS_KEY = 'lottery.aggressivePremium';
const MONEYNESS_LS_KEY = 'lottery.moneynessMode';
const TICKER_EXPANDED_LS_KEY = 'lottery-ticker-expanded';
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

/**
 * Aggressive Premium chip — lottery-native port of the SB chip. Surfaces
 * fires where a meaningful $-premium was deployed: estimated dollar
 * premium ≥ $50K, DTE ≤ 3, tier 1 or 2, and OTM. The premium is
 * derived as entry.price × trigger.volToOiWindow × entry.openInterest
 * × 100 — `volToOiWindow × openInterest` reconstructs in-window
 * contract volume; multiplying by entry.price × 100 yields a $-premium
 * estimate. We drop SB's $100K floor to $50K because the LF universe
 * (~50 mega-cap names) trades cheaper contracts on average than
 * SPX/SPXW. Single-leg gating is dropped because multi-leg share is
 * not in the LF payload; the score tier already filters for conviction.
 * Client-side filter.
 */
const AGGRESSIVE_PREMIUM_MIN_USD = 50_000;
const AGGRESSIVE_PREMIUM_MAX_DTE = 3;

/**
 * Moneyness chip — tri-state filter on strike vs. spot at first fire.
 * Client-side filter only; `entry.spotAtFirst` is always populated by
 * the lottery feed so there's no null fallthrough.
 */
type MoneynessMode = 'all' | 'otm' | 'itm';

const MONEYNESS_FILTERS: ReadonlyArray<{
  value: MoneynessMode;
  label: string;
}> = [
  { value: 'all', label: 'all' },
  { value: 'otm', label: 'OTM' },
  { value: 'itm', label: 'ITM' },
];

function isMoneynessMode(v: unknown): v is MoneynessMode {
  return v === 'all' || v === 'otm' || v === 'itm';
}

function isFireOtm(fire: LotteryFire): boolean {
  return fire.optionType === 'C'
    ? fire.strike > fire.entry.spotAtFirst
    : fire.strike < fire.entry.spotAtFirst;
}

function isFireAggressivePremium(fire: LotteryFire): boolean {
  const estimatedPremium =
    fire.entry.price *
    fire.trigger.volToOiWindow *
    fire.entry.openInterest *
    100;
  return (
    estimatedPremium >= AGGRESSIVE_PREMIUM_MIN_USD &&
    fire.dte <= AGGRESSIVE_PREMIUM_MAX_DTE &&
    (fire.scoreTier === 'tier1' || fire.scoreTier === 'tier2') &&
    isFireOtm(fire)
  );
}

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
  const [hideGated, setHideGated] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(HIDE_GATED_LS_KEY) === '1';
  });
  // Phase 2D — "Hide round-tripped" — filters out fires where the
  // evaluate-round-trip cron applied a non-zero score deduct. Defaults
  // ON (Phase 3 default-on shipped post-2E soak — deducted alerts had
  // +11.4pp trail-loss rate vs baseline; hiding them by default is the
  // higher-EV move). Persists locally; user can flip the chip OFF to
  // see deducted alerts. Spec: round-trip-score-deduct-production-2026-05-16.md
  const [hideRoundTripped, setHideRoundTripped] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const stored = window.localStorage.getItem(HIDE_ROUND_TRIPPED_LS_KEY);
    return stored == null ? true : stored === '1';
  });
  const [aggressivePremium, setAggressivePremium] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(AGGRESSIVE_PREMIUM_LS_KEY) === '1';
  });
  const [moneynessMode, setMoneynessMode] = useState<MoneynessMode>(() => {
    if (typeof window === 'undefined') return 'all';
    const stored = window.localStorage.getItem(MONEYNESS_LS_KEY);
    return isMoneynessMode(stored) ? stored : 'all';
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
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(HIDE_GATED_LS_KEY, hideGated ? '1' : '0');
    }
  }, [hideGated]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(
        HIDE_ROUND_TRIPPED_LS_KEY,
        hideRoundTripped ? '1' : '0',
      );
    }
  }, [hideRoundTripped]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(
        AGGRESSIVE_PREMIUM_LS_KEY,
        aggressivePremium ? '1' : '0',
      );
    }
  }, [aggressivePremium]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MONEYNESS_LS_KEY, moneynessMode);
    }
  }, [moneynessMode]);

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
    hideGated,
    aggressivePremium,
    moneynessMode,
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

  // All-day ticker counts for the chip strip — chain-day deduped on
  // the server so counts match what the user sees in the list.
  // Independent of pagination + the minute scrubber so the strip
  // always shows every ticker that fired today.
  const tickerCounts = useLotteryFinderTickerCounts({
    date,
    marketOpen,
    historical: date !== todayCt(),
    reload: reloadOnly ? true : null,
    cheapCallPm: cheapCallPmOnly ? true : null,
    mode: modeFilter,
    optionType: optionTypeFilter,
    tod: todFilter,
    minScore: CONVICTION_TO_MIN_SCORE[convictionFloor],
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
    let out = fires;
    if (hideLatePm) {
      out = out.filter(
        (f) => ctMinuteOfDay(f.triggerTimeCt) < LATE_PM_CUTOFF_MIN_OF_DAY,
      );
    }
    if (hideGated) {
      out = out.filter((f) => !f.directionGated);
    }
    if (hideRoundTripped) {
      out = out.filter((f) => (f.roundTripScoreDeduct ?? 0) >= 0);
    }
    if (aggressivePremium) {
      out = out.filter(isFireAggressivePremium);
    }
    if (moneynessMode !== 'all') {
      out = out.filter((f) => {
        const otm = isFireOtm(f);
        return moneynessMode === 'otm' ? otm : !otm;
      });
    }
    return out;
  }, [
    fires,
    hideLatePm,
    hideGated,
    hideRoundTripped,
    aggressivePremium,
    moneynessMode,
    ctMinuteOfDay,
  ]);
  // Per-filter hidden counts — computed against the unfiltered set so
  // each chip's "−N" reflects only what THAT filter is hiding.
  const hiddenLatePmCount = hideLatePm
    ? fires.filter(
        (f) => ctMinuteOfDay(f.triggerTimeCt) >= LATE_PM_CUTOFF_MIN_OF_DAY,
      ).length
    : 0;
  const hiddenGatedCount = hideGated
    ? fires.filter((f) => f.directionGated).length
    : 0;
  const hiddenRoundTrippedCount = hideRoundTripped
    ? fires.filter((f) => (f.roundTripScoreDeduct ?? 0) < 0).length
    : 0;

  // Top tickers from the dedicated all-day counts endpoint —
  // independent of pagination + the minute scrubber so tickers that
  // fired off the current page slice still appear in the strip.
  const topTickers = useMemo(
    () =>
      tickerCounts.tickers
        .slice(0, 12)
        .map((t) => [t.ticker, t.count] as const),
    [tickerCounts.tickers],
  );

  // Group displayed fires by ticker so each underlying renders as one
  // collapsible row. When sortMode === 'peak', both group order AND
  // within-group order use realized peak desc (nulls last) so the
  // user's chosen sort survives the grouping. Otherwise: conviction →
  // storm → fire count desc → latest trigger desc.
  const groupedByTicker = useMemo(() => {
    const map = new Map<string, LotteryFire[]>();
    for (const f of displayedFires) {
      const arr = map.get(f.underlyingSymbol);
      if (arr) arr.push(f);
      else map.set(f.underlyingSymbol, [f]);
    }
    return [...map.entries()]
      .map(([ticker, list]) => {
        const orderedFires =
          sortMode === 'peak'
            ? [...list].sort((a, b) => {
                const ap = a.outcomes.peakCeilingPct ?? -Infinity;
                const bp = b.outcomes.peakCeilingPct ?? -Infinity;
                return bp - ap;
              })
            : list;
        const agg = computeRollupAggregates(
          orderedFires.map<RollupAlertSummary>((f) => ({
            optionType: f.optionType,
            mktTideDiff: f.macro.mktTideDiff,
            directionGated: f.directionGated,
            triggeredAt: f.triggerTimeCt,
            strike: f.strike,
            premium: f.entry.price * f.trigger.windowSize * 100,
            intensity: f.fireCount,
          })),
        );
        const peakBest = orderedFires.reduce<number | null>((best, f) => {
          const p = f.outcomes.peakCeilingPct;
          if (p == null) return best;
          if (best == null) return p;
          return Math.max(best, p);
        }, null);
        return {
          ticker,
          fires: orderedFires,
          conviction: isHighConviction(agg, orderedFires.length),
          storm: isBurstStorm(
            agg,
            orderedFires.length,
            BURST_STORM_INTENSITY_THRESHOLDS.lottery,
          ),
          peakBest,
          latestTriggerMs: orderedFires.reduce<number>((max, f) => {
            const t = Date.parse(f.triggerTimeCt);
            return Number.isFinite(t) && t > max ? t : max;
          }, 0),
        };
      })
      .sort((a, b) => {
        if (sortMode === 'peak') {
          const ap = a.peakBest ?? -Infinity;
          const bp = b.peakBest ?? -Infinity;
          if (ap !== bp) return bp - ap;
          return b.latestTriggerMs - a.latestTriggerMs;
        }
        // Conviction first (clean), then storm (loud) — both surface
        // above the regular fire-count + recency rule. A ticker that
        // hits BOTH lives at the very top.
        if (a.conviction !== b.conviction) return a.conviction ? -1 : 1;
        if (a.storm !== b.storm) return a.storm ? -1 : 1;
        if (b.fires.length !== a.fires.length) {
          return b.fires.length - a.fires.length;
        }
        return b.latestTriggerMs - a.latestTriggerMs;
      });
  }, [displayedFires, sortMode]);

  // Per-ticker expand state, persisted to localStorage so users keep
  // their open tickers across refreshes / filter changes. Default
  // closed.
  const [tickerExpandedMap, setTickerExpandedMap] = useState<
    Record<string, boolean>
  >(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem(TICKER_EXPANDED_LS_KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(
          parsed as Record<string, unknown>,
        )) {
          if (typeof v === 'boolean') out[k] = v;
        }
        return out;
      }
      return {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        TICKER_EXPANDED_LS_KEY,
        JSON.stringify(tickerExpandedMap),
      );
    } catch {
      // Quota exceeded or storage disabled — swallow.
    }
  }, [tickerExpandedMap]);
  const handleTickerToggle = useCallback((ticker: string) => {
    setTickerExpandedMap((prev) => ({ ...prev, [ticker]: !prev[ticker] }));
  }, []);

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
            <span className={SECTION_LABEL}>moneyness</span>
            {MONEYNESS_FILTERS.map((m) => {
              const active = moneynessMode === m.value;
              const activeColor: keyof typeof CHIP_ACTIVE =
                m.value === 'otm'
                  ? 'emerald'
                  : m.value === 'itm'
                    ? 'amber'
                    : 'neutral';
              return (
                <button
                  key={m.value}
                  type="button"
                  data-testid={`lottery-moneyness-${m.value}-chip`}
                  onClick={() => setMoneynessMode(m.value)}
                  className={`${CHIP_BASE} ${
                    active ? CHIP_ACTIVE[activeColor] : CHIP_INACTIVE
                  }`}
                  title={
                    m.value === 'otm'
                      ? 'Show only out-of-the-money fires (calls: strike > spotAtFirst, puts: strike < spotAtFirst). Client-side filter.'
                      : m.value === 'itm'
                        ? 'Show only in-the-money fires (calls: strike ≤ spotAtFirst, puts: strike ≥ spotAtFirst). Client-side filter.'
                        : 'Show fires regardless of moneyness.'
                  }
                  aria-pressed={active}
                >
                  {m.label}
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
            <button
              type="button"
              data-testid="lottery-hide-gated-chip"
              onClick={() => setHideGated(!hideGated)}
              className={`${CHIP_BASE} ${
                hideGated ? CHIP_ACTIVE.amber : CHIP_INACTIVE
              }`}
              title="Hide counter-trend fires demoted to tier3 by the Phase 4 direction gate (T=±150M on mkt_tide_otm_diff). Puts when otm_diff > +150M, calls when otm_diff < -150M. Score is preserved on the row; only the displayed tier is forced down. Client-side filter."
              aria-pressed={hideGated}
            >
              hide counter-trend
              {hideGated && hiddenGatedCount > 0 && (
                <span className="text-[10px] opacity-70">
                  −{hiddenGatedCount}
                </span>
              )}
            </button>
            <button
              type="button"
              data-testid="lottery-hide-round-tripped-chip"
              onClick={() => setHideRoundTripped(!hideRoundTripped)}
              className={`${CHIP_BASE} ${
                hideRoundTripped ? CHIP_ACTIVE.amber : CHIP_INACTIVE
              }`}
              title="Hide round-tripped fires — alerts where (ask−bid)/total flow in the 60-min window after the alert was net bid-dominated (round_trip_score_deduct < 0). Phase 1 EDA on 641K alerts × 92 days: AUC 0.59 for predicting loss, concentrated in 0–7 DTE. Score deduct stays on the row; this chip hides the demoted fires entirely. Client-side filter."
              aria-pressed={hideRoundTripped}
            >
              hide round-tripped
              {hideRoundTripped && hiddenRoundTrippedCount > 0 && (
                <span className="text-[10px] opacity-70">
                  −{hiddenRoundTrippedCount}
                </span>
              )}
            </button>
            <button
              type="button"
              data-testid="lottery-aggressive-premium-chip"
              onClick={() => setAggressivePremium(!aggressivePremium)}
              className={`${CHIP_BASE} ${
                aggressivePremium ? CHIP_ACTIVE.sky : CHIP_INACTIVE
              }`}
              title={`Aggressive Premium: surface only fires with estimated $-premium ≥ $${AGGRESSIVE_PREMIUM_MIN_USD.toLocaleString()}, DTE ≤ ${AGGRESSIVE_PREMIUM_MAX_DTE}, tier 1 or 2, and OTM (strike vs spotAtFirst). Premium estimated as entry.price × trigger.volToOiWindow × entry.openInterest × 100. Client-side filter.`}
              aria-pressed={aggressivePremium}
            >
              💎 aggressive premium
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
                  title={`Filter to ${t} only (${n} fire${n === 1 ? '' : 's'} today)`}
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
                {hideGated && hiddenGatedCount > 0 && (
                  <span className="ml-2 text-amber-300/80">
                    ({hiddenGatedCount} counter-trend hidden)
                  </span>
                )}
                {hideRoundTripped && hiddenRoundTrippedCount > 0 && (
                  <span className="ml-2 text-amber-300/80">
                    ({hiddenRoundTrippedCount} round-tripped hidden)
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
            {groupedByTicker.map((g) => (
              <LotteryFinderTickerGroup
                key={g.ticker}
                ticker={g.ticker}
                fires={g.fires}
                expanded={tickerExpandedMap[g.ticker] === true}
                onToggle={handleTickerToggle}
                marketOpen={marketOpen}
                exitPolicy={exitPolicy}
              />
            ))}
          </div>
        )}
      </div>
    </SectionBox>
  );
}
