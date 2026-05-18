import { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionBox } from '../ui/SectionBox.js';
import { useLotteryFinder } from '../../hooks/useLotteryFinder.js';
import { useLotteryFinderTickerCounts } from '../../hooks/useLotteryFinderTickerCounts.js';
import { useTickerNetFlowBatch } from '../../hooks/useTickerNetFlowBatch.js';
import { ctSessionBounds } from './ct-window.js';
import { LotteryDayBanner } from './LotteryDayBanner.js';
import { LotteryTierBanner } from './LotteryTierBanner.js';
import { LotteryFinderTickerGroup } from './LotteryFinderTickerGroup.js';
import { ReignitionSection } from './ReignitionSection.js';
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
import { deltaFromAtFire } from '../../utils/macro-badges.js';
import {
  CHIP_BASE,
  CHIP_INACTIVE,
  SECTION_LABEL,
  TOOLBAR_DIVIDER,
  type FilterChipColor,
} from '../ui/filter-toolbar-tokens.js';
import { FilterChip } from '../ui/FilterChip.js';

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

// ============================================================
// MIN FIRE COUNT — burst-quality filter
// ============================================================
//
// Burst-profitability analysis 2026-05-17
// (docs/tmp/burst-profitability-findings-2026-05-17.md) on 626k fires
// across 93 days:
//   - fire_count = 1: 45% win rate, mean R = -5.8% (negative expectancy)
//   - fire_count 2-3: 50% median win rate, mean R = -5.7%
//   - fire_count 4-7: 53% median win rate, mean R = -4.2%
//   - fire_count >= 8: 60% median win rate, mean R = -1.6% (knee point)
//   - fire_count >= 16: 64% median win rate, mean R = -1.4%
// Single-fire chains are 27% of total chain-days — biggest noise source.
// This filter lets the user dial in the floor without changing the score
// formula. Default `all` keeps the panel behavior unchanged on first
// launch; users opt-in to de-clutter.

const MIN_FIRE_COUNT_LS_KEY = 'lottery.minFireCount';

type MinFireCountFloor = 'all' | 'gte3' | 'gte8' | 'gte16';

const MIN_FIRE_COUNT_OPTIONS: Array<{
  value: MinFireCountFloor;
  label: string;
  tooltip: string;
}> = [
  {
    value: 'all',
    label: 'all fires',
    tooltip: 'No fire-count floor — show single-fire chains too.',
  },
  {
    value: 'gte3',
    label: '×≥3',
    tooltip:
      'Hide single + 2-fire chains. Drops the worst-EV cohort (mean -5.8% / 45% win on singletons).',
  },
  {
    value: 'gte8',
    label: '×≥8',
    tooltip:
      'Knee of the burst curve. Chains in this bucket have median trail +9% and 94% win on the best fire. Recommended day-to-day filter.',
  },
  {
    value: 'gte16',
    label: '×≥16',
    tooltip:
      'Highest-edge cohort — median best peak 127%, median chain trail +16%. Few alerts but every one is a real burst.',
  },
];

const MIN_FIRE_COUNT_TO_FLOOR: Record<MinFireCountFloor, number> = {
  all: 1,
  gte3: 3,
  gte8: 8,
  gte16: 16,
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
  const [minFireCount, setMinFireCount] = useState<MinFireCountFloor>(() => {
    if (typeof window === 'undefined') return 'all';
    const stored = window.localStorage.getItem(MIN_FIRE_COUNT_LS_KEY);
    if (
      stored === 'all' ||
      stored === 'gte3' ||
      stored === 'gte8' ||
      stored === 'gte16'
    ) {
      return stored;
    }
    return 'all';
  });
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
      window.localStorage.setItem(MIN_FIRE_COUNT_LS_KEY, minFireCount);
    }
  }, [minFireCount]);
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

  const {
    fires,
    reignitedFires: rawReignitedFires,
    loading,
    error,
    fetchedAt,
    total,
    offset,
    hasMore,
  } = useLotteryFinder({
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
  // Client-side filter chain applied to BOTH the page slice (drives the
  // ticker-grouped feed below) and the pinned reignited rows (kept in
  // sync so the chip filters affect both surfaces the same way).
  const applyClientFilters = useCallback(
    (input: LotteryFire[]) => {
      let out = input;
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
      const floor = MIN_FIRE_COUNT_TO_FLOOR[minFireCount];
      if (floor > 1) {
        out = out.filter((f) => f.fireCount >= floor);
      }
      return out;
    },
    [
      hideLatePm,
      hideGated,
      hideRoundTripped,
      aggressivePremium,
      moneynessMode,
      minFireCount,
      ctMinuteOfDay,
    ],
  );
  const displayedFires = useMemo(
    () => applyClientFilters(fires),
    [fires, applyClientFilters],
  );
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

  // All tickers with at least one fire today, from the dedicated
  // all-day counts endpoint — independent of pagination + the minute
  // scrubber so tickers that fired off the current page slice still
  // appear in the strip. Previously capped to 12 (hid the long tail of
  // low-count tickers like XOM/MSFT/WDC/UNH on busy days); now uncapped
  // because the API already sorts count desc and `flex flex-wrap`
  // handles the row growing vertically. Mirrors the Silent Boom fix.
  const topTickers = useMemo(
    () => tickerCounts.tickers.map((t) => [t.ticker, t.count] as const),
    [tickerCounts.tickers],
  );

  // Task A of lottery-reignition-ui-2026-05-17 — promote REIGNITED
  // chains into a pinned "Hot Right Now" section above the ticker
  // groups. The `reignited` flag is computed globally per-day in
  // api/lottery-finder.ts (top 5/day by post_gap_fires DESC, fire_count
  // DESC) so the badge stays stable across filter views. The pinned
  // payload (`rawReignitedFires`) is delivered alongside `fires` by the
  // hook but served INDEPENDENT of pagination, so the section stays
  // visible on every page even when the qualifying chains naturally
  // sort onto a later page slice. We re-apply the same client-side
  // filter chain that `displayedFires` uses so chip filters affect both
  // surfaces consistently. Each fire renders in EXACTLY ONE place
  // (reignited list OR ticker group) — `tickerGroupFires` drops any
  // reignited rows that happen to live in the page slice, preventing
  // a duplicate render on pages where they would have grouped.
  const reignitedFires = useMemo(
    () =>
      [...applyClientFilters(rawReignitedFires)].sort((a, b) => {
        // Guard against malformed triggerTimeCt — Date.parse returns
        // NaN on invalid input, and NaN comparators yield unspecified
        // sort order. Production data is always ISO; defensive only.
        const at = Date.parse(a.triggerTimeCt);
        const bt = Date.parse(b.triggerTimeCt);
        return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
      }),
    [rawReignitedFires, applyClientFilters],
  );
  // Fires that don't qualify for the pinned section feed the regular
  // ticker grouping below — keeps the per-ticker rollup counts honest.
  const tickerGroupFires = useMemo(
    () => displayedFires.filter((f) => f.reignited !== true),
    [displayedFires],
  );

  // Group displayed fires by ticker so each underlying renders as one
  // collapsible row. When sortMode === 'peak', both group order AND
  // within-group order use realized peak desc (nulls last) so the
  // user's chosen sort survives the grouping. Otherwise: conviction →
  // storm → fire count desc → latest trigger desc.
  const groupedByTicker = useMemo(() => {
    const map = new Map<string, LotteryFire[]>();
    for (const f of tickerGroupFires) {
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
            tickerNetFlowAtFire: deltaFromAtFire(
              f.macro.tickerCumNcpAtFire,
              f.macro.tickerCumNppAtFire,
            ),
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
  }, [tickerGroupFires, sortMode]);

  // Live ticker net-flow snapshots driving the Flow Match / Mismatch /
  // Inverted badges. One panel-level poll (60s while marketOpen)
  // replaces what would otherwise be N per-row chart fetches. Empty
  // ticker list short-circuits the fetch.
  const visibleTickers = useMemo(
    () => groupedByTicker.map((g) => g.ticker),
    [groupedByTicker],
  );
  const { data: tickerFlowSnapshots } = useTickerNetFlowBatch({
    tickers: visibleTickers,
    date,
    marketOpen,
  });

  // Stable lookup for ReignitionSection — keeps the new function
  // identity tied to `tickerFlowSnapshots` so the memo'd section
  // doesn't re-render on every parent tick (the 30s `nowMinuteMs`
  // interval alone re-renders this section twice a minute, so an
  // inline-literal closure here would defeat the section's memo).
  const getReignitionSnapshot = useCallback(
    (ticker: string) => tickerFlowSnapshots.get(ticker) ?? null,
    [tickerFlowSnapshots],
  );

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
              <FilterChip
                active={minute == null}
                activeColor="green"
                onClick={() => setMinute(null)}
                title={
                  isLive
                    ? 'Live: showing today (most recent first), polls every 30s'
                    : 'Show every fire on the selected day'
                }
                ariaPressed={minute == null}
              >
                {date === todayCt() ? 'Live' : 'All day'}
              </FilterChip>
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
                    <FilterChip
                      onClick={() => step(-60_000)}
                      disabled={atMin}
                      ariaLabel="Step back one minute"
                      title="Step back one minute (−1m)"
                    >
                      ◀ −1m
                    </FilterChip>
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
                    <FilterChip
                      onClick={() => step(60_000)}
                      disabled={atMax}
                      ariaLabel="Step forward one minute"
                      title={
                        isToday && cur != null && cur >= effectiveHi
                          ? 'Cannot step past the current minute'
                          : 'Step forward one minute (+1m)'
                      }
                    >
                      +1m ▶
                    </FilterChip>
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
              <FilterChip
                key={s.value}
                active={sortMode === s.value}
                activeColor="sky"
                onClick={() => setSortMode(s.value)}
                title={s.tooltip}
                ariaPressed={sortMode === s.value}
              >
                {s.label}
              </FilterChip>
            ))}
            <span className={TOOLBAR_DIVIDER} aria-hidden="true" />
            <span className={SECTION_LABEL}>conviction</span>
            {CONVICTION_OPTIONS.map((c) => {
              const active = convictionFloor === c.value;
              // Tier 1 = rose (most exclusive), Tier 2+ = amber, all =
              // emerald. The active style tracks the floor so the user
              // can read the filter at a glance.
              const activeColor: FilterChipColor =
                c.value === 'tier1'
                  ? 'rose'
                  : c.value === 'tier2'
                    ? 'amber'
                    : 'emerald';
              return (
                <FilterChip
                  key={c.value}
                  active={active}
                  activeColor={activeColor}
                  onClick={() => setConvictionFloor(c.value)}
                  title={c.tooltip}
                  ariaPressed={active}
                >
                  {c.label}
                </FilterChip>
              );
            })}
            <span className={TOOLBAR_DIVIDER} aria-hidden="true" />
            <span className={SECTION_LABEL}>burst</span>
            {MIN_FIRE_COUNT_OPTIONS.map((c) => {
              const active = minFireCount === c.value;
              // Tighter floor → deeper orange. Matches the row's ×N
              // badge + the REIGNITION pinned section palette so the
              // visual hierarchy stays consistent.
              const activeColor: FilterChipColor =
                c.value === 'gte16'
                  ? 'rose'
                  : c.value === 'gte8'
                    ? 'orange'
                    : c.value === 'gte3'
                      ? 'amber'
                      : 'emerald';
              return (
                <FilterChip
                  key={c.value}
                  active={active}
                  activeColor={activeColor}
                  onClick={() => setMinFireCount(c.value)}
                  title={c.tooltip}
                  ariaPressed={active}
                  testId={`burst-filter-${c.value}`}
                >
                  {c.label}
                </FilterChip>
              );
            })}
          </div>

          {/* Row 3: Tag toggles + Mode (A/B/all). RE-LOAD and
            cheap-call-PM are independent boolean toggles with their
            own counts; the MODE_FILTERS group is a single-select
            radio set. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={SECTION_LABEL}>mode</span>
            <FilterChip
              active={reloadOnly}
              activeColor="amber"
              onClick={() => setReloadOnly(!reloadOnly)}
              title="Show only fires tagged RE-LOAD (burst ≥2× prior AND entry dropped ≥30%)."
              ariaPressed={reloadOnly}
            >
              RE-LOAD only{' '}
              <span className="text-[10px] opacity-70">{reloadCount}</span>
            </FilterChip>
            <FilterChip
              active={cheapCallPmOnly}
              activeColor="fuchsia"
              onClick={() => setCheapCallPmOnly(!cheapCallPmOnly)}
              title="Show only fires tagged cheap-call-PM (call + PM session + entry < $1). The Phase 1 selection rule."
              ariaPressed={cheapCallPmOnly}
            >
              Cheap-call-PM only{' '}
              <span className="text-[10px] opacity-70">{cheapPmCount}</span>
            </FilterChip>
            <span className={TOOLBAR_DIVIDER} aria-hidden="true" />
            {MODE_FILTERS.map((m) => (
              <FilterChip
                key={m.label}
                active={modeFilter === m.value}
                activeColor="blue"
                onClick={() => setModeFilter(m.value)}
                ariaPressed={modeFilter === m.value}
              >
                {m.label}
              </FilterChip>
            ))}
          </div>

          {/* Row 4: Type (calls/puts) + Moneyness + Time-of-day. Three
            single-select option-type groups merged into one row with
            dividers — narrow-cardinality filters that read cleanly
            side-by-side. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={SECTION_LABEL}>type</span>
            {[
              { value: null, label: 'all' },
              { value: 'C' as OptionType, label: 'calls' },
              { value: 'P' as OptionType, label: 'puts' },
            ].map((o) => {
              const active = optionTypeFilter === o.value;
              const activeColor: FilterChipColor =
                o.value === 'C' ? 'green' : o.value === 'P' ? 'red' : 'neutral';
              return (
                <FilterChip
                  key={o.label}
                  active={active}
                  activeColor={activeColor}
                  onClick={() => setOptionTypeFilter(o.value)}
                  ariaPressed={active}
                >
                  {o.label}
                </FilterChip>
              );
            })}
            <span className={TOOLBAR_DIVIDER} aria-hidden="true" />
            <span className={SECTION_LABEL}>moneyness</span>
            {MONEYNESS_FILTERS.map((m) => {
              const active = moneynessMode === m.value;
              const activeColor: FilterChipColor =
                m.value === 'otm'
                  ? 'emerald'
                  : m.value === 'itm'
                    ? 'amber'
                    : 'neutral';
              return (
                <FilterChip
                  key={m.value}
                  active={active}
                  activeColor={activeColor}
                  testId={`lottery-moneyness-${m.value}-chip`}
                  onClick={() => setMoneynessMode(m.value)}
                  title={
                    m.value === 'otm'
                      ? 'Show only out-of-the-money fires (calls: strike > spotAtFirst, puts: strike < spotAtFirst). Client-side filter.'
                      : m.value === 'itm'
                        ? 'Show only in-the-money fires (calls: strike ≤ spotAtFirst, puts: strike ≥ spotAtFirst). Client-side filter.'
                        : 'Show fires regardless of moneyness.'
                  }
                  ariaPressed={active}
                >
                  {m.label}
                </FilterChip>
              );
            })}
            <span className={TOOLBAR_DIVIDER} aria-hidden="true" />
            <span className={SECTION_LABEL}>tod</span>
            {TOD_FILTERS.map((t) => (
              <FilterChip
                key={t.label}
                active={todFilter === t.value}
                activeColor="orange"
                onClick={() => setTodFilter(t.value)}
                ariaPressed={todFilter === t.value}
              >
                {t.label}
              </FilterChip>
            ))}
          </div>

          {/* Row 5: Hide-toggles + aggressive premium. Independent
            boolean filters that prune the displayed result set without
            affecting the underlying DB query. Grouped here so the
            muscle-memory position matches SilentBoom. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <FilterChip
              active={hideLatePm}
              activeColor="purple"
              onClick={() => setHideLatePm(!hideLatePm)}
              title="Hide fires triggered after 14:30 CT. Late-PM fires often lack enough remaining session for the flow_inversion signal to develop, so they devolve into theta-decay coin flips. Client-side filter — toolbar counts and pagination still reflect the full DB result."
              ariaPressed={hideLatePm}
            >
              hide post-14:30
              {hideLatePm && hiddenLatePmCount > 0 && (
                <span className="text-[10px] opacity-70">
                  −{hiddenLatePmCount}
                </span>
              )}
            </FilterChip>
            <FilterChip
              active={hideGated}
              activeColor="amber"
              testId="lottery-hide-gated-chip"
              onClick={() => setHideGated(!hideGated)}
              title="Hide counter-trend fires demoted to tier3 by the Phase 4 direction gate (T=±150M on mkt_tide_otm_diff). Puts when otm_diff > +150M, calls when otm_diff < -150M. Score is preserved on the row; only the displayed tier is forced down. Client-side filter."
              ariaPressed={hideGated}
            >
              hide counter-trend
              {hideGated && hiddenGatedCount > 0 && (
                <span className="text-[10px] opacity-70">
                  −{hiddenGatedCount}
                </span>
              )}
            </FilterChip>
            <FilterChip
              active={hideRoundTripped}
              activeColor="amber"
              testId="lottery-hide-round-tripped-chip"
              onClick={() => setHideRoundTripped(!hideRoundTripped)}
              title="Hide round-tripped fires — alerts where (ask−bid)/total flow in the 60-min window after the alert was net bid-dominated (round_trip_score_deduct < 0). Phase 1 EDA on 641K alerts × 92 days: AUC 0.59 for predicting loss, concentrated in 0–7 DTE. Score deduct stays on the row; this chip hides the demoted fires entirely. Client-side filter."
              ariaPressed={hideRoundTripped}
            >
              hide round-tripped
              {hideRoundTripped && hiddenRoundTrippedCount > 0 && (
                <span className="text-[10px] opacity-70">
                  −{hiddenRoundTrippedCount}
                </span>
              )}
            </FilterChip>
            <FilterChip
              active={aggressivePremium}
              activeColor="sky"
              testId="lottery-aggressive-premium-chip"
              onClick={() => setAggressivePremium(!aggressivePremium)}
              title={`Aggressive Premium: surface only fires with estimated $-premium ≥ $${AGGRESSIVE_PREMIUM_MIN_USD.toLocaleString()}, DTE ≤ ${AGGRESSIVE_PREMIUM_MAX_DTE}, tier 1 or 2, and OTM (strike vs spotAtFirst). Premium estimated as entry.price × trigger.volToOiWindow × entry.openInterest × 100. Client-side filter.`}
              ariaPressed={aggressivePremium}
            >
              💎 aggressive premium
            </FilterChip>
          </div>

          {/* Row 6 (conditional): Ticker chips — top tickers in the
            current result set, click to scope to one ticker. Universe
            is ~50 tickers; we show only those actually present so the
            user can spot the dominant tickers of the day at a glance. */}
          {(topTickers.length > 0 || tickerFilter) && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={SECTION_LABEL}>ticker</span>
              <FilterChip
                active={tickerFilter == null}
                activeColor="emerald"
                onClick={() => setTickerFilter(null)}
                ariaPressed={tickerFilter == null}
              >
                all
              </FilterChip>
              {topTickers.map(([t, n]) => (
                <FilterChip
                  key={t}
                  active={tickerFilter === t}
                  activeColor="emerald"
                  onClick={() => setTickerFilter(tickerFilter === t ? null : t)}
                  title={`Filter to ${t} only (${n} fire${n === 1 ? '' : 's'} today)`}
                  ariaPressed={tickerFilter === t}
                >
                  {t} <span className="text-[10px] opacity-70">{n}</span>
                </FilterChip>
              ))}
              {tickerFilter &&
                !topTickers.some(([t]) => t === tickerFilter) && (
                  <FilterChip
                    active
                    activeColor="emerald"
                    onClick={() => setTickerFilter(null)}
                    title="Filter active but no fires for this ticker in the current view — click to clear"
                  >
                    {tickerFilter}{' '}
                    <span className="text-[10px] opacity-70">0</span>
                  </FilterChip>
                )}
            </div>
          )}

          {/* Row 7: Exit policy selector — single-select set governing
            which realized-exit metric drives the row badges below. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={SECTION_LABEL}>realized exit</span>
            {EXIT_POLICIES.map((p) => (
              <FilterChip
                key={p}
                active={exitPolicy === p}
                activeColor="purple"
                onClick={() => setExitPolicy(p)}
                title={EXIT_POLICY_TOOLTIPS[p]}
                ariaPressed={exitPolicy === p}
              >
                {EXIT_POLICY_LABELS[p]}
              </FilterChip>
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
            {/* Pinned REIGNITION section — renders above ticker groups.
                Section component returns null when there are no qualifying
                rows, so an empty top-N doesn't show an empty box. Phase 3
                of lottery-reignition-ui-2026-05-17. */}
            <ReignitionSection
              fires={reignitedFires}
              exitPolicy={exitPolicy}
              marketOpen={marketOpen}
              getFlowSnapshot={getReignitionSnapshot}
            />
            {groupedByTicker.map((g) => (
              <LotteryFinderTickerGroup
                key={g.ticker}
                ticker={g.ticker}
                fires={g.fires}
                expanded={tickerExpandedMap[g.ticker] === true}
                onToggle={handleTickerToggle}
                marketOpen={marketOpen}
                exitPolicy={exitPolicy}
                liveFlowSnapshot={tickerFlowSnapshots.get(g.ticker) ?? null}
              />
            ))}
          </div>
        )}
      </div>
    </SectionBox>
  );
}
