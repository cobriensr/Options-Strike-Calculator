import { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionBox } from '../ui/SectionBox.js';
import { useSilentBoomFeed } from '../../hooks/useSilentBoomFeed.js';
import { useSilentBoomTickerCounts } from '../../hooks/useSilentBoomTickerCounts.js';
import { useTickerNetFlowBatch } from '../../hooks/useTickerNetFlowBatch.js';
import { ctSessionBounds } from '../LotteryFinder/ct-window.js';
import { SilentBoomDayBanner } from './SilentBoomDayBanner.js';
import { SilentBoomRegimeBanner } from './SilentBoomRegimeBanner.js';
import { SilentBoomTickerGroup } from './SilentBoomTickerGroup.js';
import {
  BURST_STORM_INTENSITY_THRESHOLDS,
  computeRollupAggregates,
  isBurstStorm,
  isHighConviction,
  type RollupAlertSummary,
} from '../../utils/ticker-rollup-aggregates.js';
import {
  SILENT_BOOM_EXIT_POLICY_LABELS,
  SILENT_BOOM_EXIT_POLICY_TOOLTIPS,
  type OptionType,
  type SilentBoomAlert,
  type SilentBoomAskPctBand,
  type SilentBoomBurstColor,
  type SilentBoomDteBucket,
  type SilentBoomExitPolicy,
  type SilentBoomSortMode,
  type SilentBoomTod,
} from './types.js';
import {
  CHIP_ACTIVE,
  CHIP_BASE,
  CHIP_INACTIVE,
  SECTION_LABEL,
  TOOLBAR_DIVIDER,
} from '../ui/filter-toolbar-tokens.js';

const PAGE_SIZE = 50;
const SORT_LS_KEY = 'silentBoom.sortMode';
const MIN_VOL_OI_LS_KEY = 'silentBoom.minVolOi';
const CONVICTION_LS_KEY = 'silentBoom.convictionFloor';
const HIDE_LATE_PM_LS_KEY = 'silentBoom.hideLatePm';
const HIDE_GHOSTS_LS_KEY = 'silentBoom.hideGhosts';
const HIDE_GATED_LS_KEY = 'silentBoom.hideGated';
const HIDE_ROUND_TRIPPED_LS_KEY = 'silentBoom.hideRoundTripped';
const HIDE_ROUND_TRIPPED_ANY_DTE_LS_KEY = 'silentBoom.hideRoundTrippedAnyDte';
const MIN_DTE_LS_KEY = 'silentBoom.minDte';
const MIN_PREMIUM_K_LS_KEY = 'silentBoom.minPremiumK';
/** Structural round-trip cutoff: net_pct < this → contract clearly
 *  reversed in the 60-min post-fire window. Not outcome-predictive at
 *  8+ DTE (AUC 0.528) — pure structural filter. */
const ROUND_TRIPPED_ANY_DTE_CUTOFF = -0.5;
const AGGRESSIVE_PREMIUM_LS_KEY = 'silentBoom.aggressivePremium';
const MONEYNESS_LS_KEY = 'silentBoom.moneynessMode';
const EXIT_POLICY_LS_KEY = 'silentBoom.exitPolicy';
const ASK_PCT_BAND_LS_KEY = 'silentBoom.askPctBand';
const TICKER_EXPANDED_LS_KEY = 'silent-boom-ticker-expanded';

const EXIT_POLICIES: SilentBoomExitPolicy[] = [
  'realized30mPct',
  'realized60mPct',
  'realized120mPct',
  'realizedEodPct',
  'peakCeilingPct',
];

function isSilentBoomExitPolicy(v: unknown): v is SilentBoomExitPolicy {
  return (
    typeof v === 'string' && (EXIT_POLICIES as readonly string[]).includes(v)
  );
}

/**
 * "Ghost print" thresholds — a row is a ghost print when BOTH:
 *  - baseline_volume ≤ 50 (chain effectively dormant — see audit:
 *    <50 baseline lifts at 0.74×, the worst baseline bucket), AND
 *  - spike_ratio ≥ 100 (apparent burst is mostly arithmetic from a
 *    near-zero baseline — audit lift 0.64× on 100×+, also worst).
 *
 * Either threshold alone is too aggressive: a chain with baseline=30
 * and ratio=30 may still be a real moderate spike on a quiet name; a
 * chain with baseline=200 and ratio=200 is a normal-trading chain
 * with a genuinely huge spike. Both have to hold to identify the
 * "block hit a dormant chain" pattern.
 */
const GHOST_PRINT_BASELINE_MAX = 50;
const GHOST_PRINT_SPIKE_RATIO_MIN = 100;

/**
 * Late-PM cutoff (CT minute-of-day). Alerts whose bucket_ct is at or
 * after this minute are hidden when the filter is on. 14:30 CT — 30
 * min before the regular-session close — chosen because by that
 * point the silent-boom audit's PM stratum lift is 0.50× and
 * post-14:30 fires are the worst slice; the user's discretionary
 * exit windows close fast enough that the move can't develop. Now
 * a server-side filter (`hideLatePm=true` query param) so pagination
 * accurately reflects the post-filter count — was previously
 * client-side which left empty pages when the entire 50-item slice
 * fell after the cutoff. Cutoff (14:30 CT → minute-of-day 870) lives
 * in api/silent-boom-feed.ts and api/silent-boom-ticker-counts.ts.
 */

/** Tier floors — must match SILENT_BOOM_TIER_THRESHOLDS in
 *  api/_lib/silent-boom-score.ts. */
const TIER1_MIN_SCORE = 21;
const TIER2_MIN_SCORE = 8;

type ConvictionFloor = 'all' | 'tier2' | 'tier1';

/**
 * Moneyness chip — tri-state filter on the alert's strike vs. underlying
 * price at the spike bucket. Client-side filter only; rows with no spot
 * snapshot (pre-#152 backfill) fall through under 'all' and are hidden
 * under either 'otm' or 'itm'.
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

const TOD_FILTERS: Array<{ value: SilentBoomTod | null; label: string }> = [
  { value: null, label: 'all TOD' },
  { value: 'AM_open', label: 'AM_open' },
  { value: 'MID', label: 'MID' },
  { value: 'LUNCH', label: 'LUNCH' },
  { value: 'PM', label: 'PM' },
];

/**
 * Burst color category — matches the spike-ratio badge in
 * SilentBoomRow. Visual-intensity ordering, NOT empirical-lift
 * ordering. The audit shows smaller spike ratios actually score
 * better historically (5–10× has lift 2.11× vs 100×+ at 0.64×).
 * Tooltip notes this so the user picks deliberately.
 */
/**
 * Ask% band filter — five buckets from the 2026-05-12 saturation
 * audit. The '100' band is the cliff: win > 0% drops from ≥99% in
 * every other band to 77%, and the cron now demotes those fires to
 * tier3 by default. The 70-80 band is the strongest historical
 * cohort (median peak +16.52%, win > 100% = 12.6%); leaving the
 * filter at "all" matches Tier-1+ conviction without the cliff fires.
 */
const ASK_PCT_BAND_FILTERS: Array<{
  value: SilentBoomAskPctBand | null;
  label: string;
  tooltip: string;
}> = [
  {
    value: null,
    label: 'all ask%',
    tooltip: 'Show every ask% band.',
  },
  {
    value: '70-80',
    label: '70-80%',
    tooltip:
      'Strongest historical cohort: median peak +16.52%, win > 100% at 12.6% (vs 4.3% at the 100% cliff).',
  },
  {
    value: '80-90',
    label: '80-90%',
    tooltip: 'Median peak +14.03%, win > 0% = 99.0%.',
  },
  {
    value: '90-95',
    label: '90-95%',
    tooltip: 'Median peak +13.83%, win > 0% = 99.1%.',
  },
  {
    value: '95-99',
    label: '95-99%',
    tooltip:
      'Median peak +12.51%, win > 0% = 98.9%. The high-ask cohort that still performs.',
  },
  {
    value: '100',
    label: '100%',
    tooltip:
      'Cliff bucket — every print at the ask. Median peak +4.51%, win > 0% drops to 77.0%. These are auto-demoted to tier3 by the scorer; keep this filter off unless you specifically want to inspect them.',
  },
];

const BURST_FILTERS: Array<{
  value: SilentBoomBurstColor | null;
  label: string;
  cls: keyof typeof CHIP_ACTIVE | null;
  tooltip: string;
}> = [
  {
    value: null,
    label: 'all bursts',
    cls: null,
    tooltip: 'Show every burst color.',
  },
  {
    value: 'red',
    label: '🔴 ≥50×',
    cls: 'rose',
    tooltip:
      'Red burst — spike_ratio ≥ 50×. Visually extreme but historically WEAKER (audit lift 1.17× and below). Often ghost prints on dead chains.',
  },
  {
    value: 'yellow',
    label: '🟡 20-50×',
    cls: 'amber',
    tooltip:
      'Yellow burst — spike_ratio in [20×, 50×). Audit lift ~1.40-1.74×.',
  },
  {
    value: 'grey',
    label: '⚪ <20×',
    cls: 'neutral',
    tooltip:
      'Grey burst — spike_ratio in [5×, 20×). Visually mild but historically the STRONGEST bucket (audit lift 1.74-2.11× on 5-25×).',
  },
];

interface ExportUrlParams {
  date: string;
  ticker?: string | null;
  optionType?: OptionType | null;
  minVolOi?: number;
  minScore?: number | null;
  tod?: SilentBoomTod | null;
  dte?: SilentBoomDteBucket | null;
  burst?: SilentBoomBurstColor | null;
  askPctBand?: SilentBoomAskPctBand | null;
}

/**
 * Build the /api/silent-boom-export URL with only the params the user
 * actually set. Boolean-true / non-default values get serialized;
 * null / 0 / undefined are omitted so the schema's defaults kick in.
 */
const buildExportUrl = (params: ExportUrlParams): string => {
  const sp = new URLSearchParams({ date: params.date });
  if (params.ticker) sp.set('ticker', params.ticker);
  if (params.optionType) sp.set('optionType', params.optionType);
  if (params.minVolOi != null && params.minVolOi > 0) {
    sp.set('minVolOi', String(params.minVolOi));
  }
  if (params.minScore != null) sp.set('minScore', String(params.minScore));
  if (params.tod) sp.set('tod', params.tod);
  if (params.dte) sp.set('dte', params.dte);
  if (params.burst) sp.set('burst', params.burst);
  if (params.askPctBand) sp.set('askPctBand', params.askPctBand);
  return `/api/silent-boom-export?${sp.toString()}`;
};

const CONVICTION_OPTIONS: Array<{
  value: ConvictionFloor;
  label: string;
  tooltip: string;
}> = [
  {
    value: 'all',
    label: 'all',
    tooltip: 'No score floor — show every alert including Tier 3.',
  },
  {
    value: 'tier2',
    label: '🔥🔥 Tier 2+',
    tooltip: `Tier 2 or better (score ≥ ${TIER2_MIN_SCORE}). Historical high-peak rate ~37% (vs ~8% for Tier 3).`,
  },
  {
    value: 'tier1',
    label: '🔥🔥🔥 Tier 1',
    tooltip: `Tier 1 only (score ≥ ${TIER1_MIN_SCORE}). Historical high-peak rate ~56%, ~5% of fires.`,
  },
];

const CONVICTION_TO_MIN_SCORE: Record<ConvictionFloor, number | null> = {
  all: null,
  tier2: TIER2_MIN_SCORE,
  tier1: TIER1_MIN_SCORE,
};

const VOL_OI_FLOORS: Array<{ value: number; label: string; tooltip: string }> =
  [
    {
      value: 0,
      label: 'all',
      tooltip:
        'No vol/OI floor — show every alert that cleared the detector (vol/OI ≥ 25%).',
    },
    {
      value: 0.5,
      label: '≥0.5',
      tooltip:
        'Spike traded at least 50% of the contract OI in 5 minutes. Default — actionable density without too much noise.',
    },
    {
      value: 1,
      label: '≥1.0',
      tooltip:
        'Spike volume met or exceeded the entire prior open interest in one bucket. Strongest opening-trade signal.',
    },
  ];

const SORT_OPTIONS: Array<{
  value: SilentBoomSortMode;
  label: string;
  tooltip: string;
}> = [
  {
    value: 'newest',
    label: 'newest',
    tooltip: 'Order by spike-bucket time (most recent first). Default.',
  },
  {
    value: 'spike_ratio',
    label: 'spike ratio',
    tooltip: 'Order by spike-vol / baseline-median. Most extreme bursts first.',
  },
  {
    value: 'vol_oi',
    label: 'vol/OI',
    tooltip: 'Order by spike-vol / OI. Highest single-bucket OI churn first.',
  },
  {
    value: 'peak',
    label: 'peak',
    tooltip:
      'Order by realized peak ceiling (largest move first). Post-hoc — only meaningful once enrich-silent-boom-outcomes has populated peak_ceiling_pct.',
  },
];

interface SilentBoomSectionProps {
  marketOpen: boolean;
}

const todayCt = (): string => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
};

const formatTimeCT = (input: number | string): string =>
  new Date(input).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  });

export function SilentBoomSection({ marketOpen }: SilentBoomSectionProps) {
  const [date, setDate] = useState<string>(todayCt());
  const [tickerFilter, setTickerFilter] = useState<string | null>(null);
  const [optionTypeFilter, setOptionTypeFilter] = useState<OptionType | null>(
    null,
  );
  const [todFilter, setTodFilter] = useState<SilentBoomTod | null>(null);
  // Numeric DTE floor — 0 means all DTEs. Replaces the legacy enum
  // chip group (0DTE / 1-3D / 4D+) so the user can scope to e.g. "1+"
  // (= 1-DTE and beyond) which the bucket form couldn't express.
  const [minDte, setMinDte] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    const stored = window.localStorage.getItem(MIN_DTE_LS_KEY);
    const n = stored == null ? 0 : Number.parseInt(stored, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  // Min premium floor in $K. Server-side filter so pagination reflects
  // the post-filter count. 0 means no floor.
  const [minPremiumK, setMinPremiumK] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    const stored = window.localStorage.getItem(MIN_PREMIUM_K_LS_KEY);
    const n = stored == null ? 0 : Number.parseInt(stored, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  // Legacy bucket state retained for type compatibility with the hook's
  // `dte` field. Now hard-wired to null; the numeric `minDte` controls
  // the filter exclusively from this component.
  const dteFilter: SilentBoomDteBucket | null = null;
  const [burstFilter, setBurstFilter] = useState<SilentBoomBurstColor | null>(
    null,
  );
  const [askPctBand, setAskPctBand] = useState<SilentBoomAskPctBand | null>(
    () => {
      if (typeof window === 'undefined') return null;
      const stored = window.localStorage.getItem(ASK_PCT_BAND_LS_KEY);
      if (
        stored === '70-80' ||
        stored === '80-90' ||
        stored === '90-95' ||
        stored === '95-99' ||
        stored === '100'
      ) {
        return stored;
      }
      return null;
    },
  );
  const [sortMode, setSortMode] = useState<SilentBoomSortMode>(() => {
    if (typeof window === 'undefined') return 'newest';
    const stored = window.localStorage.getItem(SORT_LS_KEY);
    if (
      stored === 'newest' ||
      stored === 'spike_ratio' ||
      stored === 'vol_oi' ||
      stored === 'peak'
    ) {
      return stored;
    }
    return 'newest';
  });
  const [minVolOi, setMinVolOi] = useState<number>(() => {
    if (typeof window === 'undefined') return 0.5;
    const stored = window.localStorage.getItem(MIN_VOL_OI_LS_KEY);
    if (stored == null) return 0.5;
    const parsed = Number.parseFloat(stored);
    return Number.isFinite(parsed) ? parsed : 0.5;
  });
  const [convictionFloor, setConvictionFloor] = useState<ConvictionFloor>(
    () => {
      if (typeof window === 'undefined') return 'all';
      const stored = window.localStorage.getItem(CONVICTION_LS_KEY);
      if (stored === 'tier1' || stored === 'tier2' || stored === 'all') {
        return stored;
      }
      return 'all';
    },
  );
  const [hideLatePm, setHideLatePm] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(HIDE_LATE_PM_LS_KEY) === '1';
  });
  const [hideGhosts, setHideGhosts] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(HIDE_GHOSTS_LS_KEY) === '1';
  });
  const [hideGated, setHideGated] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(HIDE_GATED_LS_KEY) === '1';
  });
  // "Hide round-tripped" — filters out alerts where the round-trip
  // cron applied a non-zero score deduct. Default ON (Phase 3, post-2E
  // soak: deducted alerts had +14.4pp trail-loss rate vs baseline on
  // silent_boom — hiding them by default is the higher-EV move). User
  // can flip the chip OFF to see deducted alerts. Persists locally.
  // Spec: docs/superpowers/specs/round-trip-score-deduct-production-2026-05-16.md
  const [hideRoundTripped, setHideRoundTripped] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const stored = window.localStorage.getItem(HIDE_ROUND_TRIPPED_LS_KEY);
    return stored == null ? true : stored === '1';
  });
  // "Hide round-tripped (any DTE)" — structural filter on
  // round_trip_net_pct < ROUND_TRIPPED_ANY_DTE_CUTOFF. Independent of the
  // outcome-gated `hideRoundTripped` chip (which is ≤7 DTE only via the
  // cron's score_deduct). This one catches visually-obvious in/outs at
  // any DTE — e.g. MSTR 11-DTE puts that fire on a big ask print and get
  // sold back on a similar-size bid print in the next 60min.
  const [hideRoundTrippedAnyDte, setHideRoundTrippedAnyDte] = useState<boolean>(
    () => {
      if (typeof window === 'undefined') return false;
      return (
        window.localStorage.getItem(HIDE_ROUND_TRIPPED_ANY_DTE_LS_KEY) === '1'
      );
    },
  );
  // Aggressive Premium chip — single toggle that ANDs together the
  // trader's 5-criterion UW filter: premium ≥ $100K, DTE ≤ 8,
  // vol/OI > 1, single-leg, OTM. See server-side enforcement in
  // api/silent-boom-feed.ts and the migration #152 column it gates on.
  const [aggressivePremium, setAggressivePremium] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(AGGRESSIVE_PREMIUM_LS_KEY) === '1';
  });
  const [moneynessMode, setMoneynessMode] = useState<MoneynessMode>(() => {
    if (typeof window === 'undefined') return 'all';
    const stored = window.localStorage.getItem(MONEYNESS_LS_KEY);
    return isMoneynessMode(stored) ? stored : 'all';
  });
  const [exitPolicy, setExitPolicy] = useState<SilentBoomExitPolicy>(() => {
    if (typeof window === 'undefined') return 'realized60mPct';
    const stored = window.localStorage.getItem(EXIT_POLICY_LS_KEY);
    return isSilentBoomExitPolicy(stored) ? stored : 'realized60mPct';
  });
  /** ISO of the 5-min bucket the scrubber is on; null = whole day. */
  const [bucketIso, setBucketIso] = useState<string | null>(null);
  const [page, setPage] = useState<number>(0);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SORT_LS_KEY, sortMode);
    }
  }, [sortMode]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MIN_VOL_OI_LS_KEY, String(minVolOi));
    }
  }, [minVolOi]);
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
      window.localStorage.setItem(HIDE_GHOSTS_LS_KEY, hideGhosts ? '1' : '0');
    }
  }, [hideGhosts]);
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
        HIDE_ROUND_TRIPPED_ANY_DTE_LS_KEY,
        hideRoundTrippedAnyDte ? '1' : '0',
      );
    }
  }, [hideRoundTrippedAnyDte]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MIN_DTE_LS_KEY, String(minDte));
    }
  }, [minDte]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MIN_PREMIUM_K_LS_KEY, String(minPremiumK));
    }
  }, [minPremiumK]);
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
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(EXIT_POLICY_LS_KEY, exitPolicy);
    }
  }, [exitPolicy]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (askPctBand == null) {
      window.localStorage.removeItem(ASK_PCT_BAND_LS_KEY);
    } else {
      window.localStorage.setItem(ASK_PCT_BAND_LS_KEY, askPctBand);
    }
  }, [askPctBand]);

  // Reset bucket scrub when the date changes — a bucket from yesterday
  // shouldn't carry over.
  useEffect(() => {
    setBucketIso(null);
  }, [date]);

  // Reset page on any filter change so we don't land on an empty page.
  // hideLatePm is server-side (Phase 4); a flip changes the server's
  // total + pagination so the page must reset.
  useEffect(() => {
    setPage(0);
  }, [
    date,
    tickerFilter,
    optionTypeFilter,
    todFilter,
    dteFilter,
    minDte,
    minPremiumK,
    burstFilter,
    askPctBand,
    sortMode,
    minVolOi,
    convictionFloor,
    bucketIso,
    hideLatePm,
    hideGhosts,
    hideGated,
    moneynessMode,
  ]);

  const isHistorical = date !== todayCt();
  const isLive = !isHistorical && bucketIso == null;

  const { alerts, loading, error, fetchedAt, total, offset, hasMore } =
    useSilentBoomFeed({
      date,
      marketOpen,
      historical: isHistorical,
      ticker: tickerFilter,
      optionType: optionTypeFilter,
      tod: todFilter,
      dte: dteFilter,
      minDte,
      minPremium: minPremiumK * 1000,
      hideLatePm,
      burst: burstFilter,
      askPctBand,
      aggressivePremium,
      minVolOi,
      minScore: CONVICTION_TO_MIN_SCORE[convictionFloor],
      sort: sortMode,
      page,
      pageSize: PAGE_SIZE,
    });

  // All-day ticker counts for the chip strip — independent of the
  // 50-item page slice so tickers that fired on later pages still
  // appear. Mirrors the feed's server-side filters minus `ticker`
  // (the chip strip IS the ticker selector).
  const tickerCounts = useSilentBoomTickerCounts({
    date,
    marketOpen,
    historical: isHistorical,
    optionType: optionTypeFilter,
    tod: todFilter,
    dte: dteFilter,
    minDte,
    minPremium: minPremiumK * 1000,
    hideLatePm,
    burst: burstFilter,
    askPctBand,
    minVolOi,
    minScore: CONVICTION_TO_MIN_SCORE[convictionFloor],
  });

  // Regular-session bounds (08:30 → 15:00 CT) for the selected date,
  // browser-TZ-independent. Reused from the LotteryFinder helper so the
  // two date scrubbers stay in lockstep.
  const scrubBounds = useMemo(() => ctSessionBounds(date), [date]);

  // Current wall-clock 5-min bucket (UTC ms, floored to the bucket).
  // Used to cap forward navigation when viewing today — refreshed every
  // 30s so the dropdown grows in lockstep with the trading session.
  const [nowBucketMs, setNowBucketMs] = useState<number>(
    () => Math.floor(Date.now() / 300_000) * 300_000,
  );
  useEffect(() => {
    const id = setInterval(() => {
      setNowBucketMs(Math.floor(Date.now() / 300_000) * 300_000);
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  // Apply the client-side filters (bucket scrub + late-PM hide) to the
  // server-paginated list. Server `total` and pagination remain tied to
  // the unfiltered DB result so the page chips stay accurate; the
  // displayed list reflects the user's local view.
  const isGhostPrint = (a: SilentBoomAlert): boolean =>
    a.baselineVolume <= GHOST_PRINT_BASELINE_MAX &&
    a.spikeRatio >= GHOST_PRINT_SPIKE_RATIO_MIN;
  const displayedAlerts = useMemo(() => {
    let out = alerts;
    if (bucketIso != null) {
      out = out.filter((a) => a.bucketCt === bucketIso);
    }
    // hideLatePm is server-side (api/silent-boom-feed.ts) — pagination
    // reflects the post-filter count and we don't double-filter here.
    if (hideGhosts) {
      out = out.filter((a) => !isGhostPrint(a));
    }
    if (hideGated) {
      out = out.filter((a) => !a.directionGated);
    }
    if (hideRoundTripped) {
      out = out.filter((a) => (a.roundTripScoreDeduct ?? 0) >= 0);
    }
    if (hideRoundTrippedAnyDte) {
      // Structural read — applies at all DTEs. Cron writes net_pct for
      // every alert with post-fire flow; null means not yet evaluated
      // (alert younger than the 60-min lookback floor) so we let it pass.
      out = out.filter(
        (a) =>
          a.roundTripNetPct == null ||
          a.roundTripNetPct >= ROUND_TRIPPED_ANY_DTE_CUTOFF,
      );
    }
    if (moneynessMode !== 'all') {
      out = out.filter((a) => {
        const spot = a.underlyingPriceAtSpike;
        if (spot == null) return false;
        const isOtm = a.optionType === 'C' ? a.strike > spot : a.strike < spot;
        return moneynessMode === 'otm' ? isOtm : !isOtm;
      });
    }
    return out;
  }, [
    alerts,
    bucketIso,
    hideGhosts,
    hideGated,
    hideRoundTripped,
    hideRoundTrippedAnyDte,
    moneynessMode,
  ]);
  // Per-filter hidden counts — computed against the unfiltered set
  // so each chip's "−N" count reflects what THAT filter is hiding,
  // independent of any other active filter. (hideLatePm moved
  // server-side so its count isn't shown anymore — pagination
  // accurately reflects the filtered total instead.)
  const hiddenGhostsCount =
    bucketIso == null && hideGhosts
      ? alerts.filter((a) => isGhostPrint(a)).length
      : 0;
  const hiddenGatedCount =
    bucketIso == null && hideGated
      ? alerts.filter((a) => a.directionGated).length
      : 0;
  const hiddenRoundTrippedCount =
    bucketIso == null && hideRoundTripped
      ? alerts.filter((a) => (a.roundTripScoreDeduct ?? 0) < 0).length
      : 0;
  const hiddenRoundTrippedAnyDteCount =
    bucketIso == null && hideRoundTrippedAnyDte
      ? alerts.filter(
          (a) =>
            a.roundTripNetPct != null &&
            a.roundTripNetPct < ROUND_TRIPPED_ANY_DTE_CUTOFF,
        ).length
      : 0;

  // All tickers with at least one alert today, from the dedicated
  // counts endpoint — independent of pagination. The list was
  // previously built from the 50-item page slice (hid tickers that
  // fired on later pages) and then capped to 12 (hid the long tail
  // of low-count tickers entirely). Now uncapped: the API already
  // sorts count desc, and `flex flex-wrap` lets the chip strip grow
  // vertically on heavy days. Lets the user filter to TLT/CRWV/AMD-style
  // singleton-alert tickers without typing.
  const topTickers = useMemo(
    () => tickerCounts.tickers.map((t) => [t.ticker, t.count] as const),
    [tickerCounts.tickers],
  );

  // Group the displayed alerts by ticker so each underlying renders
  // as one collapsible row instead of N scattered cards. When
  // sortMode === 'peak', both group order AND within-group order use
  // realized peak desc (nulls last) so the user's chosen sort survives
  // the grouping. Otherwise: conviction → storm → alert count desc →
  // most-recent bucket desc.
  const groupedByTicker = useMemo(() => {
    const map = new Map<string, SilentBoomAlert[]>();
    for (const a of displayedAlerts) {
      const arr = map.get(a.underlyingSymbol);
      if (arr) arr.push(a);
      else map.set(a.underlyingSymbol, [a]);
    }
    return [...map.entries()]
      .map(([ticker, list]) => {
        const orderedAlerts =
          sortMode === 'peak'
            ? [...list].sort((a, b) => {
                const ap = a.outcomes.peakCeilingPct ?? -Infinity;
                const bp = b.outcomes.peakCeilingPct ?? -Infinity;
                return bp - ap;
              })
            : list;
        const agg = computeRollupAggregates(
          orderedAlerts.map<RollupAlertSummary>((a) => ({
            optionType: a.optionType,
            mktTideDiff: a.mktTideDiff,
            directionGated: a.directionGated,
            triggeredAt: a.bucketCt,
            strike: a.strike,
            premium: a.entryPrice * a.spikeVolume * 100,
            intensity: a.spikeRatio,
          })),
        );
        const peakBest = orderedAlerts.reduce<number | null>((best, a) => {
          const p = a.outcomes.peakCeilingPct;
          if (p == null) return best;
          if (best == null) return p;
          return Math.max(best, p);
        }, null);
        return {
          ticker,
          alerts: orderedAlerts,
          conviction: isHighConviction(agg, orderedAlerts.length),
          storm: isBurstStorm(
            agg,
            orderedAlerts.length,
            BURST_STORM_INTENSITY_THRESHOLDS.silentBoom,
          ),
          peakBest,
          // Latest bucket within the group — used as tiebreak so two
          // tickers with the same alert count are ordered by recency.
          latestBucketMs: orderedAlerts.reduce<number>((max, a) => {
            const t = Date.parse(a.bucketCt);
            return Number.isFinite(t) && t > max ? t : max;
          }, 0),
        };
      })
      .sort((a, b) => {
        if (sortMode === 'peak') {
          const ap = a.peakBest ?? -Infinity;
          const bp = b.peakBest ?? -Infinity;
          if (ap !== bp) return bp - ap;
          return b.latestBucketMs - a.latestBucketMs;
        }
        // Conviction first (clean), then storm (loud); both above the
        // alert-count + recency rule.
        if (a.conviction !== b.conviction) return a.conviction ? -1 : 1;
        if (a.storm !== b.storm) return a.storm ? -1 : 1;
        if (b.alerts.length !== a.alerts.length) {
          return b.alerts.length - a.alerts.length;
        }
        return b.latestBucketMs - a.latestBucketMs;
      });
  }, [displayedAlerts, sortMode]);

  // Live ticker net-flow snapshots driving the Flow Match / Mismatch /
  // Inverted badges. One panel-level poll (60s while marketOpen)
  // replaces what would otherwise be N per-row chart fetches.
  const visibleTickers = useMemo(
    () => groupedByTicker.map((g) => g.ticker),
    [groupedByTicker],
  );
  const { data: tickerFlowSnapshots } = useTickerNetFlowBatch({
    tickers: visibleTickers,
    date,
    marketOpen,
  });

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

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <SectionBox label="Silent Boom" collapsible>
      <div className="space-y-3">
        <p className="text-[11px] text-neutral-500">
          Detector for chains that trade quietly for 15-20 min then print a
          single ask-side burst ≥5× the prior 4-bucket median, with vol/OI ≥
          25%, ask% ≥ 70%, and OI ≥ 100. Discretionary signal — peak-ceiling is
          a look-ahead reference, not a tradeable exit. Empirical sample (19
          days, 13.9k fires): peak +26.15% mean, 71.7% high-peak rate. Realized
          horizons average ~0%, so timing matters.{' '}
          <a
            className="text-neutral-400 underline hover:text-white"
            href="https://github.com/cobriensr/Options-Strike-Calculator/blob/main/docs/superpowers/specs/silent-boom-detector-2026-05-08.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            methodology
          </a>
        </p>

        {/* Regime banner — Market Tide / 0DTE Flow / SPX Gamma at the
            latest alert's bucket time. Display-only macro context. */}
        <SilentBoomRegimeBanner alerts={alerts} />

        {/* Day banner — tier counts + dominant ticker + loudest spike */}
        <SilentBoomDayBanner alerts={alerts} total={total} />

        <div className="space-y-2.5 rounded-lg border border-neutral-800/80 bg-neutral-950/40 p-2.5">
          {/* Row 1: date + scrub controls. Prev/next step the 5-min
              bucket by ±5 min — matches the detector's bucket cadence
              so every step lands on a real bucket boundary. The scrub
              filter is client-side; the API still returns the whole
              day and pagination/total stay tied to the unfiltered set. */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1.5">
              <span className={SECTION_LABEL}>date</span>
              <input
                type="date"
                value={date}
                max={todayCt()}
                onChange={(e) => {
                  setDate(e.target.value);
                  setBucketIso(null);
                }}
                className="rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-1 font-mono text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none"
                aria-label="Select trading day"
              />
            </label>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className={`${CHIP_BASE} ${
                  bucketIso == null ? CHIP_ACTIVE.green : CHIP_INACTIVE
                }`}
                onClick={() => setBucketIso(null)}
                title={
                  isLive
                    ? 'Live: showing today (most recent first), polls every 30s'
                    : 'Show every alert on the selected day'
                }
                aria-pressed={bucketIso == null}
              >
                {date === todayCt() ? 'Live' : 'All day'}
              </button>
              {(() => {
                const lo = Date.parse(scrubBounds.min);
                const hi = Date.parse(scrubBounds.max);
                const isToday = date === todayCt();
                const effectiveHi = isToday ? Math.min(hi, nowBucketMs) : hi;
                const noValidBucket = effectiveHi < lo;
                const cur = bucketIso ? Date.parse(bucketIso) : null;
                const atMin = noValidBucket || (cur != null && cur <= lo);
                const atMax =
                  noValidBucket || (cur != null && cur >= effectiveHi);
                const step = (deltaMs: number) => {
                  const seed = cur ?? (deltaMs < 0 ? effectiveHi : lo);
                  const next = Math.max(
                    lo,
                    Math.min(effectiveHi, seed + deltaMs),
                  );
                  setBucketIso(new Date(next).toISOString());
                };
                const options: { value: string; label: string }[] = [];
                if (!noValidBucket) {
                  for (let t = lo; t <= effectiveHi; t += 300_000) {
                    const iso = new Date(t).toISOString();
                    options.push({ value: iso, label: formatTimeCT(iso) });
                  }
                }
                return (
                  <>
                    <button
                      type="button"
                      onClick={() => step(-300_000)}
                      disabled={atMin}
                      className={`${CHIP_BASE} ${CHIP_INACTIVE} disabled:opacity-40 disabled:hover:border-neutral-700 disabled:hover:text-neutral-300`}
                      aria-label="Step back one 5-min bucket"
                      title="Step back one bucket (−5m)"
                    >
                      ◀ −5m
                    </button>
                    <select
                      value={bucketIso ?? ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        setBucketIso(v === '' ? null : v);
                      }}
                      disabled={noValidBucket}
                      aria-label="Jump to a specific 5-min bucket (Central Time)"
                      title={
                        isToday
                          ? `Jump to a specific bucket. Capped at the current open bucket (${formatTimeCT(nowBucketMs)}).`
                          : 'Jump to a specific 5-min bucket (08:30–15:00 CT).'
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
                      onClick={() => step(300_000)}
                      disabled={atMax}
                      className={`${CHIP_BASE} ${CHIP_INACTIVE} disabled:opacity-40 disabled:hover:border-neutral-700 disabled:hover:text-neutral-300`}
                      aria-label="Step forward one 5-min bucket"
                      title={
                        isToday && cur != null && cur >= effectiveHi
                          ? 'Cannot step past the current bucket'
                          : 'Step forward one bucket (+5m)'
                      }
                    >
                      +5m ▶
                    </button>
                  </>
                );
              })()}
              {bucketIso && (
                <span className="font-mono text-xs text-purple-200">
                  (5-min bucket)
                </span>
              )}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              <span className={SECTION_LABEL}>export</span>
              <a
                href={buildExportUrl({
                  date,
                  ticker: tickerFilter,
                  optionType: optionTypeFilter,
                  minVolOi,
                  minScore: CONVICTION_TO_MIN_SCORE[convictionFloor],
                  tod: todFilter,
                  dte: dteFilter,
                  burst: burstFilter,
                  askPctBand,
                })}
                download
                className={`${CHIP_BASE} ${CHIP_INACTIVE}`}
                title="Export the current filtered view as CSV (one row per alert, all columns including score / tier / outcomes)."
              >
                ⤓ filtered
              </a>
              <a
                href={buildExportUrl({ date })}
                download
                className={`${CHIP_BASE} ${CHIP_INACTIVE}`}
                title="Export every alert on the selected day as CSV — ignores active filters."
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

          {/* Row 2: conviction tier */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={SECTION_LABEL}>conviction</span>
            {CONVICTION_OPTIONS.map((c) => {
              const active = convictionFloor === c.value;
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

          {/* Row 2.5: min DTE + min premium numeric inputs + Burst color.
              DTE input replaced the 0DTE / 1-3D / 4D+ chip buckets so
              the user can scope to any custom floor (e.g. "1+" to span
              1-3D and 4D+ together — the bucket form couldn't express
              that). Min premium is a new server-side filter that gates
              entry_price * spike_volume * 100 ≥ N dollars. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <label
              className="flex items-center gap-1.5"
              title="Minimum days-to-expiry floor. 0 shows all DTEs; N restricts to alerts with dte >= N. Server-side filter — pagination + ticker counts reflect the post-filter result."
            >
              <span className={SECTION_LABEL}>min dte</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={365}
                step={1}
                value={minDte === 0 ? '' : minDte}
                placeholder="0"
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === '') {
                    setMinDte(0);
                    return;
                  }
                  const n = Number.parseInt(raw, 10);
                  if (Number.isFinite(n) && n >= 0) setMinDte(n);
                }}
                aria-label="Minimum DTE"
                className="w-14 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-center text-xs tabular-nums text-neutral-100 focus:border-blue-500 focus:outline-none"
              />
            </label>
            <label
              className="flex items-center gap-1.5"
              title="Minimum premium floor (entry_price × spike_volume × 100), in $K. 0 = no floor. Server-side filter."
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
                className="w-20 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-center text-xs tabular-nums text-neutral-100 focus:border-blue-500 focus:outline-none"
              />
            </label>
            <span className={TOOLBAR_DIVIDER} aria-hidden="true" />
            <span className={SECTION_LABEL}>burst</span>
            {BURST_FILTERS.map((b) => (
              <button
                key={b.label}
                type="button"
                onClick={() => setBurstFilter(b.value)}
                className={`${CHIP_BASE} ${
                  burstFilter === b.value && b.cls
                    ? CHIP_ACTIVE[b.cls]
                    : burstFilter === b.value
                      ? CHIP_ACTIVE.emerald
                      : CHIP_INACTIVE
                }`}
                title={b.tooltip}
                aria-pressed={burstFilter === b.value}
              >
                {b.label}
              </button>
            ))}
            <span className={TOOLBAR_DIVIDER} aria-hidden="true" />
            <span className={SECTION_LABEL}>ask %</span>
            {ASK_PCT_BAND_FILTERS.map((b) => (
              <button
                key={b.label}
                type="button"
                onClick={() => setAskPctBand(b.value)}
                className={`${CHIP_BASE} ${
                  askPctBand === b.value
                    ? b.value === '100'
                      ? CHIP_ACTIVE.rose
                      : CHIP_ACTIVE.purple
                    : CHIP_INACTIVE
                }`}
                title={b.tooltip}
                aria-pressed={askPctBand === b.value}
              >
                {b.label}
              </button>
            ))}
          </div>

          {/* Row 2.6: realized-exit policy. Whichever chip is active
              becomes the primary % shown on every row. Mirrors the
              LotteryFinder pattern. Default 60m (least disruptive
              switch from the row's prior emphasized column). */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={SECTION_LABEL}
              title="Choose which realized exit % is shown as the primary number on every alert. Peak is a look-ahead reference; the 30m / 60m / 120m / EOD options are tradeable horizons from the spike bucket start."
            >
              exit
            </span>
            {EXIT_POLICIES.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setExitPolicy(p)}
                className={`${CHIP_BASE} ${
                  exitPolicy === p ? CHIP_ACTIVE.purple : CHIP_INACTIVE
                }`}
                title={SILENT_BOOM_EXIT_POLICY_TOOLTIPS[p]}
                aria-pressed={exitPolicy === p}
              >
                {SILENT_BOOM_EXIT_POLICY_LABELS[p]}
              </button>
            ))}
          </div>

          {/* Row 3: sort + vol/OI floor */}
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
            <span className={SECTION_LABEL}>vol/OI</span>
            {VOL_OI_FLOORS.map((f) => (
              <button
                key={f.label}
                type="button"
                onClick={() => setMinVolOi(f.value)}
                className={`${CHIP_BASE} ${
                  minVolOi === f.value ? CHIP_ACTIVE.amber : CHIP_INACTIVE
                }`}
                title={f.tooltip}
                aria-pressed={minVolOi === f.value}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Row 4: option type + hide-late-PM */}
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
                  data-testid={`silent-boom-moneyness-${m.value}-chip`}
                  onClick={() => setMoneynessMode(m.value)}
                  className={`${CHIP_BASE} ${
                    active ? CHIP_ACTIVE[activeColor] : CHIP_INACTIVE
                  }`}
                  title={
                    m.value === 'otm'
                      ? 'Show only out-of-the-money alerts (calls: strike > spot, puts: strike < spot). Client-side filter using underlying_price_at_spike from migration #152. Rows without a spot snapshot are hidden.'
                      : m.value === 'itm'
                        ? 'Show only in-the-money alerts (calls: strike ≤ spot, puts: strike ≥ spot). Client-side filter using underlying_price_at_spike from migration #152. Rows without a spot snapshot are hidden.'
                        : 'Show alerts regardless of moneyness.'
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
                title={
                  t.value === 'AM_open'
                    ? 'Filter to AM_open (08:30–10:00 CT). Audit lift: 1.65× — strongest TOD bucket.'
                    : t.value === 'MID'
                      ? 'Filter to MID (10:00–12:00 CT). Audit lift: 1.09×.'
                      : t.value === 'LUNCH'
                        ? 'Filter to LUNCH (12:00–13:00 CT). Audit lift: 0.99× — neutral.'
                        : t.value === 'PM'
                          ? 'Filter to PM (13:00–15:00 CT). Audit lift: 0.50× — weakest TOD bucket.'
                          : 'Show all time-of-day buckets.'
                }
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
              title="Hide alerts whose 5-min bucket is at or after 14:30 CT. Audit shows the PM stratum lift is 0.50× and post-14:30 fires are the worst slice — discretionary exit windows close fast enough that the move can't develop. Server-side filter — pagination + ticker counts reflect the post-filter count."
              aria-pressed={hideLatePm}
            >
              hide post-14:30
            </button>
            <button
              type="button"
              onClick={() => setHideGhosts(!hideGhosts)}
              className={`${CHIP_BASE} ${
                hideGhosts ? CHIP_ACTIVE.red : CHIP_INACTIVE
              }`}
              title={`Hide "ghost prints" — alerts where baseline_volume ≤ ${GHOST_PRINT_BASELINE_MAX} AND spike_ratio ≥ ${GHOST_PRINT_SPIKE_RATIO_MIN}×. Pattern: a single block hits an effectively-dormant chain, producing a visually extreme ratio (red badge) but no follow-through volume. Audit lift on this cohort is ~0.6× — historically the worst combo. Client-side filter.`}
              aria-pressed={hideGhosts}
            >
              hide ghosts
              {hideGhosts && hiddenGhostsCount > 0 && (
                <span className="text-[10px] opacity-70">
                  −{hiddenGhostsCount}
                </span>
              )}
            </button>
            <button
              type="button"
              data-testid="silent-boom-hide-gated-chip"
              onClick={() => setHideGated(!hideGated)}
              className={`${CHIP_BASE} ${
                hideGated ? CHIP_ACTIVE.amber : CHIP_INACTIVE
              }`}
              title="Hide counter-trend alerts demoted to tier3 by the Phase 4 direction gate (T=±100M on mkt_tide_diff). Puts when mkt_tide_diff > +100M, calls when mkt_tide_diff < -100M. Score is preserved on the row; only the displayed tier is forced down. Client-side filter."
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
              data-testid="silent-boom-hide-round-tripped-chip"
              onClick={() => setHideRoundTripped(!hideRoundTripped)}
              className={`${CHIP_BASE} ${
                hideRoundTripped ? CHIP_ACTIVE.amber : CHIP_INACTIVE
              }`}
              title="Hide round-tripped alerts — fires where (ask−bid)/total flow in the 60-min window after the alert was net bid-dominated (round_trip_score_deduct < 0). Phase 1 EDA on 641K alerts × 92 days: AUC 0.59 for predicting loss, concentrated in 0–7 DTE. Score deduct stays on the row; this chip hides the demoted alerts entirely. Client-side filter."
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
              data-testid="silent-boom-hide-round-tripped-any-dte-chip"
              onClick={() =>
                setHideRoundTrippedAnyDte(!hideRoundTrippedAnyDte)
              }
              className={`${CHIP_BASE} ${
                hideRoundTrippedAnyDte ? CHIP_ACTIVE.amber : CHIP_INACTIVE
              }`}
              title={`Hide round-tripped (any DTE) — structural filter. Hides alerts where post-fire flow in the 60-min window had net_pct < ${ROUND_TRIPPED_ANY_DTE_CUTOFF.toFixed(2)} (heavy bid-side, contract clearly reversed). Distinct from "hide round-tripped" which gates on the score deduct (≤7 DTE only, outcome-predictive). This one applies at ALL DTEs — catches the visually-obvious in/out pattern even when the predictive signal is weak (8+ DTE, AUC 0.528). Client-side filter on round_trip_net_pct populated by the evaluate-round-trip cron 60-75 min after fire.`}
              aria-pressed={hideRoundTrippedAnyDte}
            >
              hide round-tripped (any DTE)
              {hideRoundTrippedAnyDte && hiddenRoundTrippedAnyDteCount > 0 && (
                <span className="text-[10px] opacity-70">
                  −{hiddenRoundTrippedAnyDteCount}
                </span>
              )}
            </button>
            <button
              type="button"
              data-testid="silent-boom-aggressive-premium-chip"
              onClick={() => setAggressivePremium(!aggressivePremium)}
              className={`${CHIP_BASE} ${
                aggressivePremium ? CHIP_ACTIVE.sky : CHIP_INACTIVE
              }`}
              title="Aggressive Premium: surface only alerts with premium ≥ $100K, DTE ≤ 8, vol/OI > 1, single-leg (multi_leg_share < 10%), and OTM (calls strike > spot, puts strike < spot). Mirrors the trader's UW filter. Server-side enforced via #152 underlying_price_at_spike — alerts with no spot snapshot are excluded from the OTM check."
              aria-pressed={aggressivePremium}
            >
              💎 aggressive premium
            </button>
          </div>

          {/* Row 4 (conditional): ticker chips */}
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
                  title={`Filter to ${t} only (${n} alert${n === 1 ? '' : 's'} today)`}
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
                    title="Filter active but no alerts for this ticker in the current view — click to clear"
                  >
                    {tickerFilter}{' '}
                    <span className="text-[10px] opacity-70">0</span>
                  </button>
                )}
            </div>
          )}
        </div>

        {/* Body */}
        {loading && alerts.length === 0 ? (
          <div className="text-sm text-neutral-500">
            Loading silent-boom feed…
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
            No silent-boom alerts on {date} matching the active filters. Try
            lowering the vol/OI floor or clearing the ticker / type chips.
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-500">
              <span>
                {bucketIso ? (
                  <>
                    {displayedAlerts.length} alert
                    {displayedAlerts.length === 1 ? '' : 's'} in{' '}
                    <span className="font-mono text-purple-200">
                      {formatTimeCT(bucketIso)} CT
                    </span>{' '}
                    bucket
                  </>
                ) : (
                  <>
                    {total} alert{total === 1 ? '' : 's'} for {date}
                    {total > 0 && (
                      <span className="ml-2 text-neutral-600">
                        showing {offset + 1}-{offset + alerts.length}
                      </span>
                    )}
                  </>
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
                {sortMode !== 'newest' && (
                  <span className="ml-2 text-sky-300/80">
                    sorted by {sortMode.replace('_', ' ')}
                  </span>
                )}
                {minVolOi > 0 && (
                  <span className="ml-2 text-amber-300/80">
                    vol/OI ≥ {minVolOi}
                  </span>
                )}
                {todFilter && (
                  <span className="ml-2 text-orange-300/80">
                    {todFilter} only
                  </span>
                )}
                {dteFilter && (
                  <span className="ml-2 text-blue-300/80">
                    {dteFilter === '0'
                      ? '0DTE only'
                      : dteFilter === '1-3'
                        ? '1-3D only'
                        : '4D+ only'}
                  </span>
                )}
                {burstFilter && (
                  <span
                    className={`ml-2 ${
                      burstFilter === 'red'
                        ? 'text-rose-300/80'
                        : burstFilter === 'yellow'
                          ? 'text-amber-300/80'
                          : 'text-neutral-400'
                    }`}
                  >
                    {burstFilter} burst only
                  </span>
                )}
                {hideGhosts && hiddenGhostsCount > 0 && (
                  <span className="ml-2 text-red-300/80">
                    ({hiddenGhostsCount} ghost prints hidden)
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
              <SilentBoomTickerGroup
                key={g.ticker}
                ticker={g.ticker}
                alerts={g.alerts}
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
