import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  boolPersistOpts,
  convictionFloorPersistOpts,
  floatPersistOpts,
  intPersistOpts,
  moneynessPersistOpts,
  type ConvictionFloor,
  type MoneynessMode,
} from '../../hooks/persist-encoding.js';
import {
  usePersistedState,
  type UsePersistedStateOptions,
} from '../../hooks/usePersistedState.js';
import { SectionBox } from '../ui/SectionBox.js';
import { CompactDisclosure } from '../ui/CompactDisclosure.js';
import { useLotteryFinder } from '../../hooks/useLotteryFinder.js';
import { useLotteryFinderTickerCounts } from '../../hooks/useLotteryFinderTickerCounts.js';
import { useNeverVanishFeed } from '../../hooks/useNeverVanishFeed.js';
import { useTickerNetFlowBatch } from '../../hooks/useTickerNetFlowBatch.js';
import { ctSessionBounds } from './ct-window.js';
import { isFireOtm } from './fire-spot.js';
import { DEFAULT_TAKEIT_FLOOR } from '../../constants/takeit.js';
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
  type RollupAlertSummary,
} from '../../utils/ticker-rollup-aggregates.js';
import { useTickerGrouping } from '../../hooks/useTickerGrouping.js';
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
const HIDE_COUNTER_FLOW_LS_KEY = 'lottery.hideCounterFlow';
const AGGRESSIVE_PREMIUM_LS_KEY = 'lottery.aggressivePremium';
const MONEYNESS_LS_KEY = 'lottery.moneynessMode';
const TICKER_EXPANDED_LS_KEY = 'lottery-ticker-expanded';
/**
 * Min premium floor in $K — server-side filter on
 * entry_price * trigger_window_size * 100 (≥ N dollars). Mirrors the
 * SilentBoom `minPremium` chip so muscle memory carries between panels.
 */
const MIN_PREMIUM_K_LS_KEY = 'lotteryFinder.minPremiumK';
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
 * Moneyness chip — tri-state filter on strike vs. fire-time spot.
 * Client-side filter only. Classification goes through the shared
 * `isFireOtm`/`fireSpot` helper (./fire-spot) so the OTM/ITM filter and
 * the row's OTM/ITM badge resolve against the SAME spot
 * (`spotAtTrigger ?? spotAtFirst`) and can never disagree.
 * `MoneynessMode` is imported from the shared persist-encoding module.
 */
const MONEYNESS_FILTERS: ReadonlyArray<{
  value: MoneynessMode;
  label: string;
}> = [
  { value: 'all', label: 'all' },
  { value: 'otm', label: 'OTM' },
  { value: 'itm', label: 'ITM' },
];

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

const sortModePersistOpts: UsePersistedStateOptions<LotterySortMode> = {
  parse: (raw): LotterySortMode | undefined =>
    raw === 'chronological' || raw === 'score' || raw === 'peak'
      ? raw
      : undefined,
  serialize: (v) => v,
};

const minFireCountPersistOpts: UsePersistedStateOptions<MinFireCountFloor> = {
  parse: (raw): MinFireCountFloor | undefined =>
    raw === 'all' || raw === 'gte3' || raw === 'gte8' || raw === 'gte16'
      ? raw
      : undefined,
  serialize: (v) => v,
};

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

// ============================================================
// TAKE-IT FLOOR — calibrated XGBoost P(peak ≥ +20%) floor
// ============================================================
//
// 0.70 is the empirical threshold where realized return stops being
// negative historically (calibration docs in
// takeit-phase3-production-scoring-2026-05-16.md). Default ON at 0.70.

const TAKEIT_FLOOR_LS_KEY = 'lottery.takeitFloor';

const TAKEIT_FLOOR_OPTIONS: Array<{
  value: number;
  label: string;
  tooltip: string;
}> = [
  { value: 0, label: 'all', tooltip: 'No TAKE-IT floor.' },
  {
    value: 0.6,
    label: '≥0.60',
    tooltip: 'Hide fires below 0.60 calibrated P(peak ≥ +20%).',
  },
  {
    value: 0.7,
    label: '≥0.70',
    tooltip:
      'Default. ~0.70 is where historical realized return stops being negative.',
  },
  {
    value: 0.75,
    label: '≥0.75',
    tooltip: 'Stricter — clearly positive expectancy historically.',
  },
  {
    value: 0.8,
    label: '≥0.80',
    tooltip: 'Rare elite tail (≈1–4% of fires).',
  },
];

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
  /**
   * Render inside a bounded scroll pane (Options Alerts split view): drives
   * `fill` on the SectionBox so the card is content-height and the pane's
   * own overflow scroll works instead of the card bleeding past the divider.
   */
  compact?: boolean;
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

/**
 * djb2 string hash → unsigned base36. Produces a single opaque token with
 * NO `:`/`|` delimiters, so it can be appended to a `:`-delimited union
 * storageKey without confusing useStickyUnion's segment-aware stale-key
 * sweep (which parses `feed-union:<feed>:<date>[:<sig>]`).
 */
function hashToken(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = (h * 33) ^ input.charCodeAt(i);
  }
  // >>> 0 coerces to an unsigned 32-bit int before base36.
  return (h >>> 0).toString(36);
}

/**
 * Active SERVER-SIDE filter params that scope the lottery feed. Changing any
 * of these rescopes the never-vanish union (finding #1) — previously-excluded
 * rows must drop rather than stay pinned. Client-only filters (hide-toggles,
 * moneyness, minute scrub) are intentionally EXCLUDED: they prune the rendered
 * view without changing the server's reachable set, so they must not rescope
 * the union.
 */
interface LotteryFilterSigParams {
  minTakeitProb: number;
  minScore: number | null;
  minFireCount: number;
  mode: LotteryMode | null;
  optionType: OptionType | null;
  tod: TimeOfDay | null;
  reload: boolean;
  cheapCallPm: boolean;
  minPremium: number;
  showAll: boolean;
  ticker: string | null;
}

/**
 * Stable, compact signature of the active server-side filters. Joined in a
 * fixed field order so the same filter setting always yields the same token,
 * then hashed to a delimiter-free base36 string for the storageKey suffix.
 */
function buildLotteryFilterSig(p: LotteryFilterSigParams): string {
  const raw = [
    `t${p.minTakeitProb}`,
    `s${p.minScore ?? 'x'}`,
    `f${p.minFireCount}`,
    `m${p.mode ?? 'x'}`,
    `o${p.optionType ?? 'x'}`,
    `d${p.tod ?? 'x'}`,
    `r${p.reload ? 1 : 0}`,
    `c${p.cheapCallPm ? 1 : 0}`,
    `p${p.minPremium}`,
    `a${p.showAll ? 1 : 0}`,
    `k${p.ticker ?? 'x'}`,
  ].join('|');
  return hashToken(raw);
}

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
  compact = false,
}: LotteryFinderSectionProps) {
  const [date, setDate] = useState<string>(todayCt());
  // True once the user has manually picked a date from the date input.
  // Gates the ET-midnight auto-roll (finding #4): a tab left open past
  // midnight should advance to the new trading day so the never-vanish
  // union rescopes (storageKey flips) instead of upserting the new day's
  // fires into the prior day's union — but ONLY when the user is sitting on
  // the live day, never when they've scrubbed back to a historical date.
  const [manualDatePick, setManualDatePick] = useState<boolean>(false);
  /** 1-minute bucket the slider is on; null = whole day. */
  const [minute, setMinute] = useState<string | null>(null);
  const [exitPolicy, setExitPolicy] = useState<ExitPolicy>(
    'realizedTrail30_10Pct',
  );
  const [reloadOnly, setReloadOnly] = useState<boolean>(false);
  const [cheapCallPmOnly, setCheapCallPmOnly] = useState<boolean>(false);
  // Phase 4 inversion-quality filter escape hatch (spec
  // lottery-inversion-quality-filter-2026-05-19.md). When ON, the URL
  // builder appends `showAll=true` and the server bypasses the Q1/Q2
  // suppression. Off by default — the narrowed feed is the intentional
  // default. Not persisted; flips back off on reload so the user can't
  // accidentally leave themselves staring at the noisy feed across
  // sessions.
  const [showFilteredTickers, setShowFilteredTickers] =
    useState<boolean>(false);
  const [modeFilter, setModeFilter] = useState<LotteryMode | null>(null);
  const [tickerFilter, setTickerFilter] = useState<string | null>(null);
  const [optionTypeFilter, setOptionTypeFilter] = useState<OptionType | null>(
    null,
  );
  const [todFilter, setTodFilter] = useState<TimeOfDay | null>(null);
  // Persisted preferences.
  const [sortMode, setSortMode] = usePersistedState<LotterySortMode>(
    SORT_LS_KEY,
    'chronological',
    sortModePersistOpts,
  );
  const [convictionFloor, setConvictionFloor] =
    usePersistedState<ConvictionFloor>(
      CONVICTION_LS_KEY,
      // One-time migration from the legacy boolean key. '1' means the
      // user had Tier 1 only enabled before; preserve that intent.
      () =>
        typeof window !== 'undefined' &&
        window.localStorage.getItem(LEGACY_HIGH_CONVICTION_LS_KEY) === '1'
          ? 'tier1'
          : 'all',
      convictionFloorPersistOpts,
    );
  const [minFireCount, setMinFireCount] = usePersistedState<MinFireCountFloor>(
    MIN_FIRE_COUNT_LS_KEY,
    'all',
    minFireCountPersistOpts,
  );
  const [hideLatePm, setHideLatePm] = usePersistedState<boolean>(
    HIDE_LATE_PM_LS_KEY,
    false,
    boolPersistOpts,
  );
  const [hideGated, setHideGated] = usePersistedState<boolean>(
    HIDE_GATED_LS_KEY,
    false,
    boolPersistOpts,
  );
  const [hideCounterFlow, setHideCounterFlow] = usePersistedState<boolean>(
    HIDE_COUNTER_FLOW_LS_KEY,
    false,
    boolPersistOpts,
  );
  const [aggressivePremium, setAggressivePremium] = usePersistedState<boolean>(
    AGGRESSIVE_PREMIUM_LS_KEY,
    false,
    boolPersistOpts,
  );
  // Min premium floor in $K. Server-side filter so pagination reflects
  // the post-filter count. 0 means no floor. Mirrors the SilentBoom
  // minPremium chip (see SilentBoomSection).
  const [minPremiumK, setMinPremiumK] = usePersistedState<number>(
    MIN_PREMIUM_K_LS_KEY,
    0,
    intPersistOpts,
  );
  const [moneynessMode, setMoneynessMode] = usePersistedState<MoneynessMode>(
    MONEYNESS_LS_KEY,
    'all',
    moneynessPersistOpts,
  );
  // TAKE-IT floor — calibrated XGBoost P(peak ≥ +20%) floor. Default 0.70.
  const [takeitFloor, setTakeitFloor] = usePersistedState<number>(
    TAKEIT_FLOOR_LS_KEY,
    DEFAULT_TAKEIT_FLOOR,
    floatPersistOpts,
  );
  /** 0-based page index. Reset to 0 whenever a filter or minute changes. */
  const [page, setPage] = useState<number>(0);

  // (Phase 2C: the 10 localStorage write effects that lived here were
  // collapsed into the `usePersistedState` calls above. Same keys,
  // same encodings, same defaults.)

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
    hideLatePm,
    hideCounterFlow,
    aggressivePremium,
    takeitFloor,
    moneynessMode,
    minPremiumK,
    minFireCount,
    showFilteredTickers,
  ]);

  // Burst chip → numeric fire_count floor. 1 = no floor; >1 turns into
  // a server-side filter on both the feed and ticker-counts endpoints.
  const minFireCountFloor = MIN_FIRE_COUNT_TO_FLOOR[minFireCount];

  const lotteryFinder = useLotteryFinder({
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
    minPremium: minPremiumK * 1000,
    minFireCount: minFireCountFloor,
    minTakeitProb: takeitFloor,
    showAll: showFilteredTickers,
    page,
    pageSize: PAGE_SIZE,
  });
  const { loading, error, fetchedAt } = lotteryFinder;
  // Destructure response fields into referentially-stable locals — child
  // components (banners, ticker-group, reignited section) consume the
  // array reference and the `useMemo` deps below pin on
  // `lotteryFinder.data` (which is itself referentially stable across
  // ticks where the response is unchanged).
  const fetchedFires = useMemo(
    () => lotteryFinder.data?.fires ?? [],
    [lotteryFinder.data],
  );
  const fetchedReignitedFires = useMemo(
    () => lotteryFinder.data?.reignitedFires ?? [],
    [lotteryFinder.data],
  );

  // All-day ticker counts for the chip strip — chain-day deduped on the
  // server so counts match what the user sees in the list. Independent of
  // pagination + the minute scrubber so the strip always shows every ticker
  // that fired today. Declared before the never-vanish block so its rows feed
  // the per-ticker MAX-merge inside `useNeverVanishFeed`.
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
    minPremium: minPremiumK * 1000,
    minFireCount: minFireCountFloor,
    minTakeitProb: takeitFloor,
    showAll: showFilteredTickers,
  });
  const tickerCountsData = useMemo(
    () => tickerCounts.data?.tickers ?? [],
    [tickerCounts.data],
  );

  // ── Never-vanish accumulator (spec never-vanish-feed-hook-2026-06-07) ──
  //
  // Once a lottery chain appears in the live feed it must never visually
  // disappear for the rest of the trading day, even when a later poll
  // omits it — a server-degrade `[]` (degradeOnTimeout), a Q1/Q2
  // inversion-quality suppression flip, or a chain_max_takeit gate wobble.
  // `useNeverVanishFeed` wraps `useStickyUnion` and consolidates the
  // engaged-gate + page>0 dedup + total floor + server-anchored pagination +
  // per-ticker MAX-merge that this panel (and Silent Boom) previously
  // hand-rolled.
  //
  // The stable key is `optionChainId` — the OCC OSI symbol the server emits
  // for every fire. It encodes (underlying, expiry, type, strike), which is
  // exactly the chain-day dedup partition the API groups on (one row per
  // chain per day), so it's unique across the response and stable across
  // polls as the chain reignites (the row's `id` is the LATEST fire's id and
  // changes on every reignite — not usable as a key).
  //
  // storageKey = `feed-union:lottery:${date}:${filterSig}` (finding #1):
  // OCC symbols repeat across days (expiry, not trigger date, is encoded), so
  // the union is day-scoped to keep days isolated; AND it carries a signature
  // of the active SERVER-SIDE filters so changing a server filter rescopes
  // the union — a previously-pinned row that the tightened filter now excludes
  // drops instead of staying pinned. useStickyUnion's hardened stale-key sweep
  // preserves same-day different-sig siblings, so toggling a filter back and
  // forth re-shows the original union.
  //
  // The union is only engaged in the live polling view (today, all-day,
  // page 0): the only view that re-polls and can drop a row out from under
  // the trader. Minute-scrub buckets and paged slices pass through the raw
  // server response; the union persists in localStorage across the detour and
  // resumes on return.
  const unionEngaged = minute == null && page === 0;
  const filterSig = buildLotteryFilterSig({
    minTakeitProb: takeitFloor,
    minScore: CONVICTION_TO_MIN_SCORE[convictionFloor],
    minFireCount: minFireCountFloor,
    mode: modeFilter,
    optionType: optionTypeFilter,
    tod: todFilter,
    reload: reloadOnly,
    cheapCallPm: cheapCallPmOnly,
    minPremium: minPremiumK * 1000,
    showAll: showFilteredTickers,
    ticker: tickerFilter,
  });
  const firesStorageKey = `feed-union:lottery:${date}:${filterSig}`;
  const reignitedStorageKey = `feed-union:lottery-reignited:${date}:${filterSig}`;
  const fireKey = useCallback((f: LotteryFire) => f.optionChainId, []);
  const fireSymbol = useCallback((f: LotteryFire) => f.underlyingSymbol, []);

  const serverTotal = lotteryFinder.data?.total ?? 0;
  const serverHasMore = lotteryFinder.data?.hasMore ?? false;

  const firesFeed = useNeverVanishFeed<LotteryFire>({
    fetched: fetchedFires,
    engaged: unionEngaged,
    storageKey: firesStorageKey,
    key: fireKey,
    getSymbol: fireSymbol,
    serverTotal,
    hasMore: serverHasMore,
    pageSize: PAGE_SIZE,
    serverTickerCounts: tickerCountsData,
  });
  const reignitedFeed = useNeverVanishFeed<LotteryFire>({
    fetched: fetchedReignitedFires,
    engaged: unionEngaged,
    storageKey: reignitedStorageKey,
    key: fireKey,
    getSymbol: fireSymbol,
    // Reignited rows are served independent of pagination, so they have no
    // own server total / hasMore — pass the fires feed's so the (unused)
    // pagination outputs stay coherent.
    serverTotal,
    hasMore: serverHasMore,
    pageSize: PAGE_SIZE,
  });

  // Pagination-hole guard. The live page renders the WHOLE union, so a chain
  // pinned on page 0 that later demotes past the PAGE_SIZE cut is also
  // returned by the server on a later page — without a guard it renders on
  // BOTH. On the live view's pages > 0 we drop any fetched row already pinned
  // on page 0; the long tail the server only serves on later pages stays
  // reachable.
  const livePagedView = minute == null && page > 0;
  const dedupedPagedFires = useMemo(
    () => fetchedFires.filter((f) => !firesFeed.unionKeys.has(fireKey(f))),
    [fetchedFires, firesFeed.unionKeys, fireKey],
  );
  // Downstream surfaces (banners, filters, grouping, counts) consume the
  // unioned array on page 0, the de-duplicated server slice on later live
  // pages, and the raw response on the minute-scrub view.
  const fires = unionEngaged
    ? firesFeed.rows
    : livePagedView
      ? dedupedPagedFires
      : fetchedFires;
  const rawReignitedFires = unionEngaged
    ? reignitedFeed.rows
    : fetchedReignitedFires;
  // Reignited-union key set drives the ticker-group partition (finding #2):
  // a chain that left the per-poll top-N is `reignited:false` on the main
  // row but still pinned in the reignited union — it must render ONLY in
  // "Hot Right Now", never also in a ticker group.
  const reignitedKeys = reignitedFeed.unionKeys;

  // Engaged → union length floor (the "N pinned" count); disengaged →
  // server total. Pagination is server-anchored via firesFeed.totalPages
  // (finding #3) so a union rendering > PAGE_SIZE pinned rows on the live
  // page never advertises an unreachable page.
  const total = firesFeed.total;
  // Chains hidden by the server-side Q1/Q2 inversion-quality suppression.
  // `total` now excludes these (server counts the reachable set), so we
  // surface this separately as a "(N hidden by quality filter)" hint.
  const suppressedCount = lotteryFinder.data?.suppressedCount ?? 0;
  const offset = lotteryFinder.data?.offset ?? 0;
  const hasMore = serverHasMore;

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

  // Midnight auto-roll (finding #4). A tab left open across the trading-day
  // boundary must advance `date` to the new live day so the never-vanish
  // union's storageKey rescopes — otherwise the new day's fires would upsert
  // into the prior day's union and the count / pin state would bleed across
  // days. We only auto-advance when the user is sitting on the live day
  // (`!manualDatePick`); a user who scrubbed back to a historical replay is
  // left untouched. Low-frequency (60s) check off its own interval — the
  // `setDate` is a true no-op on the dominant case where the day is
  // unchanged (React bails out on an equal primitive), so this cannot drive
  // a render loop.
  useEffect(() => {
    if (manualDatePick) return;
    const id = setInterval(() => {
      const live = todayCt();
      setDate((prev) => (prev === live ? prev : live));
    }, 60_000);
    return () => clearInterval(id);
  }, [manualDatePick]);

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

  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  // SERVER-anchored totalPages (finding #3): derived from the server's
  // reachable set (serverTotal), NOT the union-floored `total`. The
  // never-vanish union may render MORE than PAGE_SIZE pinned rows on the
  // live page — that's fine — but it must NOT advertise pages the server's
  // `hasMore` can't reach. `useNeverVanishFeed` computes this as
  // ceil(serverTotal / PAGE_SIZE).
  const totalPages = firesFeed.totalPages;

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
      if (hideCounterFlow) {
        out = out.filter((f) => {
          const ncp = f.macro.tickerCumNcpAtFire;
          const npp = f.macro.tickerCumNppAtFire;
          if (ncp == null || npp == null) return true;
          const delta = ncp - npp;
          if (delta === 0) return true;
          if (f.optionType === 'C') return delta > 0;
          return delta < 0;
        });
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
      // Burst (fire_count) and TAKE-IT floors are applied server-side
      // via `minFireCount` / `minTakeitProb` on both feed +
      // ticker-counts so pagination + chip totals reflect the post-
      // filter result — see useLotteryFinder above. Previously TAKE-IT
      // ran client-side and routinely dropped 40+ of 50 rows per page,
      // making "page 1 of N" meaningless.
      return out;
    },
    [
      hideLatePm,
      hideGated,
      hideCounterFlow,
      aggressivePremium,
      moneynessMode,
      ctMinuteOfDay,
    ],
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
  const hiddenCounterFlowCount = hideCounterFlow
    ? fires.filter((f) => {
        const ncp = f.macro.tickerCumNcpAtFire;
        const npp = f.macro.tickerCumNppAtFire;
        if (ncp == null || npp == null) return false;
        const delta = ncp - npp;
        if (delta === 0) return false;
        return f.optionType === 'C' ? delta < 0 : delta > 0;
      }).length
    : 0;
  // All tickers with at least one fire today, from the dedicated all-day
  // counts endpoint — independent of pagination + the minute scrubber so
  // tickers that fired off the current page slice still appear in the strip.
  // Uncapped: the API sorts count desc and `flex flex-wrap` handles the row
  // growing vertically.
  //
  // The per-ticker MAX-merge (server count vs. never-vanish union count) now
  // lives in `useNeverVanishFeed`: the server count wins on tickers it still
  // reports, the union backfills any ticker the server dropped (degrade `[]`
  // / Q1-Q2 flip), server count-desc order preserved with union-only tickers
  // appended. Engaged in the live view only; paged / scrubbed views pass
  // through raw server counts. Re-shaped to the `[ticker, n]` tuple the chip
  // strip consumes.
  const topTickers = useMemo(
    () =>
      firesFeed.tickerCounts.map(
        (t) => [t.ticker, t.count] as readonly [string, number],
      ),
    [firesFeed.tickerCounts],
  );

  // Task A of lottery-reignition-ui-2026-05-17 — promote REIGNITED
  // chains into a pinned "Hot Right Now" section above the ticker
  // groups. The `reignited` flag is computed globally per-day in
  // api/lottery-finder.ts (top 5/day by post_gap_fires DESC, fire_count
  // DESC) so the badge stays stable across filter views. The pinned
  // payload (`rawReignitedFires`) is delivered alongside `fires` by
  // the hook but served INDEPENDENT of pagination, so the section
  // stays visible on every page even when the qualifying chains
  // naturally sort onto a later page slice.
  //
  // Both outputs come from one consolidated memo so the chain
  // `fires → applyClientFilters → displayedFires → tickerGroupFires`
  // collapses to a single invalidation pass on every fires/filter change.
  // Each fire still renders in EXACTLY ONE place (reignited list OR ticker
  // group).
  //
  // Finding #2 — partition by the REIGNITED-UNION key set, not the stale
  // per-row `reignited` flag. A chain that left the per-poll top-N is
  // `reignited:false` on its main-union row but is still pinned in the
  // reignited never-vanish union (it must never vanish from "Hot Right
  // Now"). Filtering ticker groups on `reignitedKeys` (the pinned set) — not
  // `f.reignited !== true` — guarantees such a chain renders ONLY in the
  // reignited section, never also in a ticker group.
  const { filteredFires, tickerGroupFires, reignitedFires } = useMemo(() => {
    const filtered = applyClientFilters(fires);
    const filteredReignited = [...applyClientFilters(rawReignitedFires)].sort(
      (a, b) => {
        // Guard against malformed triggerTimeCt — Date.parse returns
        // NaN on invalid input, and NaN comparators yield unspecified
        // sort order. Production data is always ISO; defensive only.
        const at = Date.parse(a.triggerTimeCt);
        const bt = Date.parse(b.triggerTimeCt);
        return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
      },
    );
    return {
      filteredFires: filtered,
      tickerGroupFires: filtered.filter(
        (f) => !reignitedKeys.has(fireKey(f)) && f.reignited !== true,
      ),
      reignitedFires: filteredReignited,
    };
  }, [fires, rawReignitedFires, applyClientFilters, reignitedKeys, fireKey]);

  // Group displayed fires by ticker so each underlying renders as one
  // collapsible row. Grouping + ordering + conviction/storm rollups
  // live in `useTickerGrouping`; only the LotteryFire → normalized
  // shape projection is panel-specific.
  const groupedByTicker = useTickerGrouping({
    items: tickerGroupFires,
    // The full unfiltered fire list — drives conviction/storm so chip
    // filters don't silently erase a ticker's true-footprint badges.
    unfilteredItems: fires,
    sortMode: sortMode === 'peak' ? 'peak' : 'default',
    stormIntensityThreshold: BURST_STORM_INTENSITY_THRESHOLDS.lottery,
    extract: (f) => {
      const triggerMs = Date.parse(f.triggerTimeCt);
      const rollupSummary: RollupAlertSummary = {
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
        // Raw per-fire entry ($/contract) — drives the strong-conviction
        // tier (every fire ≤ $1). Distinct from aggregate `premium`.
        entryPrice: f.entry.price,
      };
      return {
        ticker: f.underlyingSymbol,
        peakPct: f.outcomes.peakCeilingPct,
        triggerMs: Number.isFinite(triggerMs) ? triggerMs : 0,
        rollupSummary,
        clusterStrikeCount: f.suspiciousCluster
          ? (f.clusterStrikeCount ?? 0)
          : 0,
      };
    },
  });

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

  // Filter-chip rows (sort/conviction/burst/TAKE-IT/min-prem/mode/type/
  // moneyness/tod/hide-toggles/ticker/realized-exit). Extracted so the
  // toolbar can render inline in the normal layout or collapsed behind a
  // sticky CompactDisclosure in the dense Options Alerts pane. The
  // date/scrub/export row stays outside this block (always visible).
  const lotteryToolbar = (
    <div className="space-y-2.5">
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
      <div className="flex w-full basis-full flex-wrap items-center gap-x-2 gap-y-1">
        <span className={SECTION_LABEL}>TAKE-IT</span>
        {TAKEIT_FLOOR_OPTIONS.map((o) => {
          const active = takeitFloor === o.value;
          return (
            <FilterChip
              key={o.value}
              active={active}
              activeColor="sky"
              onClick={() => setTakeitFloor(o.value)}
              title={o.tooltip}
              ariaPressed={active}
              testId={`takeit-floor-${o.value}`}
            >
              {o.label}
            </FilterChip>
          );
        })}
        {takeitFloor !== DEFAULT_TAKEIT_FLOOR && (
          <span
            className="inline-flex items-center gap-1 text-[10px] text-neutral-400"
            data-testid="lottery-takeit-floor-saved-marker"
          >
            <span>saved: {takeitFloor.toFixed(2)}</span>
            <button
              type="button"
              onClick={() => setTakeitFloor(DEFAULT_TAKEIT_FLOOR)}
              aria-label={`Reset take-it floor to ${DEFAULT_TAKEIT_FLOOR.toFixed(2)}`}
              title={`Reset take-it floor to the ${DEFAULT_TAKEIT_FLOOR.toFixed(2)} default.`}
              className="rounded border border-neutral-700 px-1 py-0.5 text-[10px] text-neutral-300 transition-colors hover:border-neutral-600 hover:text-neutral-100"
              data-testid="lottery-takeit-floor-reset"
            >
              reset to {DEFAULT_TAKEIT_FLOOR.toFixed(2)}
            </button>
          </span>
        )}
      </div>

      {/* Row 2b: numeric server-side filter — min premium $K. Mirrors
            SilentBoom's "min prem $K" input. Server-side filter so
            pagination + ticker counts reflect the post-filter result.
            Floor is entry_price * trigger_window_size * 100 ≥ N
            dollars; the LF detector's trigger_window_size is the
            rolling window volume (analog of SB's spike_volume). */}
      <div className="flex flex-wrap items-center gap-1.5">
        <label
          className="flex items-center gap-1.5"
          title="Minimum premium floor (entry_price × trigger_window_size × 100), in $K. 0 = no floor. Server-side filter so pagination + ticker counts reflect the post-filter result."
        >
          <span className={SECTION_LABEL}>min prem $K</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={100_000}
            step={10}
            value={minPremiumK === 0 ? '' : minPremiumK}
            placeholder="0"
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '') {
                setMinPremiumK(0);
                return;
              }
              const n = Number.parseInt(raw, 10);
              if (Number.isFinite(n) && n >= 0) setMinPremiumK(n);
            }}
            aria-label="Minimum premium in thousands of dollars"
            data-testid="lottery-min-premium-input"
            className="w-20 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-center text-xs text-neutral-100 tabular-nums focus:border-blue-500 focus:outline-none"
          />
        </label>
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
        {/* Phase 4 inversion-quality escape hatch (spec
              lottery-inversion-quality-filter-2026-05-19.md). When ON,
              flips ?showAll=true on the lottery feed URL and the server
              stops suppressing Q1/Q2 tickers. Off by default — the
              narrowed feed is the intentional default; the toggle is a
              debug / spot-check surface, not a daily-use chip. Reverts
              to OFF on reload (local useState, not persisted). */}
        <FilterChip
          active={showFilteredTickers}
          activeColor="amber"
          testId="lottery-show-filtered-toggle"
          onClick={() => setShowFilteredTickers(!showFilteredTickers)}
          title="Show filtered tickers — bypass the server-side Q1/Q2 inversion-quality suppression and include the bottom-quintile tickers. Off by default."
          ariaPressed={showFilteredTickers}
        >
          Show filtered tickers
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
                  ? 'Show only out-of-the-money fires (calls: strike ≥ fire-time spot, puts: strike ≤ fire-time spot (ATM counts as OTM), using spotAtTrigger ?? spotAtFirst — same spot as the row badge). Client-side filter.'
                  : m.value === 'itm'
                    ? 'Show only in-the-money fires (calls: strike < fire-time spot, puts: strike > fire-time spot, using spotAtTrigger ?? spotAtFirst — same spot as the row badge). Client-side filter.'
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
            <span className="text-[10px] opacity-70">−{hiddenLatePmCount}</span>
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
            <span className="text-[10px] opacity-70">−{hiddenGatedCount}</span>
          )}
        </FilterChip>
        <FilterChip
          active={hideCounterFlow}
          activeColor="amber"
          testId="lottery-hide-counter-flow-chip"
          onClick={() => setHideCounterFlow(!hideCounterFlow)}
          title="Hide counter-flow alerts — rows where the per-ticker net flow (cumNcpAtFire − cumNppAtFire) at fire time contradicts the option type. Calls hidden when NCP < NPP; puts hidden when NCP > NPP. Rows with no fire-time snapshot are never hidden. Client-side filter — does not affect score or tier."
          ariaPressed={hideCounterFlow}
        >
          hide counter-flow
          {hideCounterFlow && hiddenCounterFlowCount > 0 && (
            <span className="text-[10px] opacity-70">
              −{hiddenCounterFlowCount}
            </span>
          )}
        </FilterChip>
        <FilterChip
          active={aggressivePremium}
          activeColor="sky"
          testId="lottery-aggressive-premium-chip"
          onClick={() => setAggressivePremium(!aggressivePremium)}
          title={`Aggressive Premium: surface only fires with estimated $-premium ≥ $${AGGRESSIVE_PREMIUM_MIN_USD.toLocaleString()}, DTE ≤ ${AGGRESSIVE_PREMIUM_MAX_DTE}, tier 1 or 2, and OTM (strike vs fire-time spot). Premium estimated as entry.price × trigger.volToOiWindow × entry.openInterest × 100. Client-side filter.`}
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
          {tickerFilter && !topTickers.some(([t]) => t === tickerFilter) && (
            <FilterChip
              active
              activeColor="emerald"
              onClick={() => setTickerFilter(null)}
              title="Filter active but no fires for this ticker in the current view — click to clear"
            >
              {tickerFilter} <span className="text-[10px] opacity-70">0</span>
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
  );

  return (
    <SectionBox label="Lottery Finder" collapsible fill={compact}>
      <div className="space-y-3">
        {/* Methodology blurb — hidden in compact (half-height alerts pane)
            to reclaim vertical space; kept in the full calculator view. */}
        {!compact && (
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
        )}

        {/* Day-level macro banner — at-a-glance regime context. Hidden in
            compact mode to maximize row density. */}
        {!compact && <LotteryDayBanner fires={fires} />}

        {/* Day-level tier breakdown — counts + dominant ticker + top
            score on the current page. Mirrors SilentBoomDayBanner. Hidden
            in compact mode (carries the "No lottery fires yet today"
            placeholder + populated day stats). */}
        {!compact && <LotteryTierBanner fires={fires} total={total} />}

        {/* Filter toolbar — single contained panel for date/scrub,
            sort/conviction, type/TOD, mode tags, ticker, and exit
            policy. All chips share CHIP_BASE styling so spacing and
            weight stay consistent across groups. */}
        <div className="space-y-2.5 rounded-lg border border-neutral-800/80 bg-neutral-950/40 p-2.5">
          {/* Row 1: date + scrub controls. Prev/next buttons step the
            1-minute point-in-time bucket by ±1 min — the drag slider
            was too finicky to land on a target minute. Click "Live ·
            All day" (today) or "All day" (historical) to clear the
            bucket. Keyboard: tab to a button and press space/enter to
            step. Export anchors are inlined to the right so the
            toolbar starts with a single row of controls instead of
            two. */}
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
                  // Mark the date as user-chosen so the ET-midnight
                  // auto-roll won't yank them off a historical replay.
                  // Picking today again re-arms the auto-roll.
                  setManualDatePick(e.target.value !== todayCt());
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
                    ? 'Live · All day — clears the minute pick and shows every fire on today (polls every 30s)'
                    : 'All day — clears the minute pick and shows every fire on the selected day'
                }
                ariaPressed={minute == null}
              >
                {date === todayCt() ? 'Live · All day' : 'All day'}
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

          {/* Filter chips — inline in the normal layout, collapsed
            behind a sticky CompactDisclosure in the dense Options
            Alerts pane. The date/scrub/export row above stays visible
            in both modes. */}
          {compact ? (
            <CompactDisclosure label="Filters">
              {lotteryToolbar}
            </CompactDisclosure>
          ) : (
            lotteryToolbar
          )}
        </div>
        {/* /toolbar panel */}

        {/* Body */}
        {loading && fires.length === 0 && reignitedFires.length === 0 ? (
          <div className="text-sm text-neutral-500">Loading lottery feed…</div>
        ) : error ? (
          <div
            className="rounded border border-red-500/40 bg-red-950/30 p-3 text-sm text-red-200"
            role="alert"
          >
            Error: {error}
          </div>
        ) : fires.length === 0 && reignitedFires.length === 0 ? (
          <div
            className="space-y-2 rounded border border-neutral-800 bg-neutral-950 p-3 text-sm text-neutral-400"
            data-testid={
              page > 0 ? 'lottery-past-last-page' : 'lottery-empty-state'
            }
          >
            {page > 0 ? (
              <>
                <p>
                  No fires on page {currentPage} — either you&apos;ve navigated
                  past the last page or the result set shrank since you opened
                  it.
                </p>
                <p className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-xs font-semibold text-neutral-300 hover:text-white"
                  >
                    ← back one page
                  </button>
                  <button
                    type="button"
                    onClick={() => setPage(0)}
                    className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-xs font-semibold text-neutral-300 hover:text-white"
                  >
                    ↻ jump to page 1
                  </button>
                </p>
              </>
            ) : !showFilteredTickers && suppressedCount > 0 ? (
              <>
                {suppressedCount} chain{suppressedCount === 1 ? '' : 's'} for{' '}
                {date} matched the filters but{' '}
                {suppressedCount === 1 ? 'was' : 'were'} hidden by the
                inversion-quality filter (bottom-quintile ticker). Toggle{' '}
                <span className="font-medium text-neutral-200">
                  Show filtered tickers
                </span>{' '}
                in the MODE row to view {suppressedCount === 1 ? 'it' : 'them'}.
              </>
            ) : reloadOnly || cheapCallPmOnly || modeFilter ? (
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
                    showing {filteredFires.length} of {total}
                  </span>
                )}
                {suppressedCount > 0 && !showFilteredTickers && (
                  <span
                    className="ml-2 text-neutral-600"
                    title="Chains in bottom-quintile (Q1/Q2) inversion-quality tickers, hidden by default. Toggle “Show filtered tickers” in the MODE row to include them."
                  >
                    ({suppressedCount} hidden by quality filter)
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
                {hideCounterFlow && hiddenCounterFlowCount > 0 && (
                  <span className="ml-2 text-amber-300/80">
                    ({hiddenCounterFlowCount} counter-flow hidden)
                  </span>
                )}
                {takeitFloor > 0 && (
                  <span className="ml-2 text-sky-300/80">
                    (TAKE-IT ≥ {takeitFloor.toFixed(2)})
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
                    page {currentPage} / {totalPages}
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
            {/* Post-filter empty state — server returned rows but every
                one was hidden by client-side chips (hideLatePm, moneyness,
                takeitFloor, etc.). Without this branch the body renders
                literal whitespace below the pagination header and the user
                has no signal that filters caused the blank. */}
            {groupedByTicker.length === 0 && reignitedFires.length === 0 ? (
              <div
                className="rounded border border-neutral-800 bg-neutral-950 p-3 text-sm text-neutral-400"
                data-testid="lottery-all-filtered-empty"
              >
                All {fires.length} fire{fires.length === 1 ? '' : 's'} on this
                page were hidden by active filter chips.{' '}
                {hasMore
                  ? 'Try Next to skip to the next server page, or'
                  : 'Try'}{' '}
                relaxing a filter (TAKE-IT floor, hide-* toggles, moneyness,
                etc.).
              </div>
            ) : (
              groupedByTicker.map((g) => (
                <LotteryFinderTickerGroup
                  key={g.ticker}
                  ticker={g.ticker}
                  fires={g.items}
                  expanded={tickerExpandedMap[g.ticker] === true}
                  onToggle={handleTickerToggle}
                  marketOpen={marketOpen}
                  exitPolicy={exitPolicy}
                  conviction={g.conviction}
                  strongConviction={g.strongConviction}
                  storm={g.storm}
                  clusterStrikes={g.clusterStrikes}
                  wasConvictionAt={g.wasConvictionAt}
                  wasConvictionFireCount={g.wasConvictionFireCount}
                  liveFlowSnapshot={tickerFlowSnapshots.get(g.ticker) ?? null}
                />
              ))
            )}
          </div>
        )}
      </div>
    </SectionBox>
  );
}
