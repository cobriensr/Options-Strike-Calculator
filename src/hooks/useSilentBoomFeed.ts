/**
 * useSilentBoomFeed — fetches /api/silent-boom-feed with filter chips
 * and pagination. Polls every 30s during market hours when on page 0
 * AND the selected date is today (historical days are static).
 *
 * Phase 2M-4: thin wrapper over `useFetchedData` exposing the canonical
 * `{ data, loading, error, refresh, fetchedAt }` shape. Callers
 * destructure `data?.alerts ?? []`, `data?.total ?? 0`, etc.
 */

import { z } from 'zod';
import { useRef } from 'react';
import { POLL_INTERVALS } from '../constants/index.js';
import { useFetchedData, type UseFetchedDataResult } from './useFetchedData.js';
import {
  claimReport,
  INVALID_SHAPE_ERROR,
  summarizeZodIssues,
} from '../lib/response-guard.js';
import { captureUnlessAuth } from '../lib/sentry-helpers.js';
import type {
  AnchorLegKind,
  SpreadLeg,
  SpreadShape,
} from '../types/spread-legs.js';
import type {
  OptionType,
  SilentBoomAskPctBand,
  SilentBoomBurstColor,
  SilentBoomDteBucket,
  SilentBoomFeedResponse,
  SilentBoomSortMode,
  SilentBoomTod,
} from '../components/SilentBoom/types.js';

// ── Response schema ──────────────────────────────────────────────────────
// Guards the spread-leg fields (spec 2026-10-28-classifier-replacement-
// design.md, "Badge"): the row badge feeds spreadShape and spreadLegs to
// describeSpread. Every other field passes through unchecked (looseObject),
// as it did before. All three are optional and nullable, because alerts
// from before migration #197 have none of them.

// Mapped objects, so adding a kind or shape to the shared union fails to
// compile until it is listed here, instead of rejecting the feed at runtime.
const ANCHOR_LEG_KINDS: { [K in AnchorLegKind]: K } = {
  single: 'single',
  multi_leg: 'multi_leg',
  stock_tied: 'stock_tied',
};
const SPREAD_SHAPES: { [S in SpreadShape]: S } = {
  vertical: 'vertical',
  calendar: 'calendar',
  diagonal: 'diagonal',
  straddle: 'straddle',
  combo: 'combo',
  butterfly: 'butterfly',
  three_leg: 'three_leg',
  four_leg: 'four_leg',
  four_leg_multi_expiry: 'four_leg_multi_expiry',
  complex: 'complex',
  unpaired: 'unpaired',
  other: 'other',
};

const spreadLegSchema = z.object({
  optionType: z.enum(['C', 'P']),
  strike: z.number(),
  expiry: z.string(),
  size: z.number(),
  price: z.number(),
  tradeCode: z.string().nullable(),
}) satisfies z.ZodType<SpreadLeg>;

const alertSchema = z.looseObject({
  anchorLegKind: z.enum(ANCHOR_LEG_KINDS).nullish(),
  spreadShape: z.enum(SPREAD_SHAPES).nullish(),
  spreadLegs: z.array(spreadLegSchema).nullish(),
});

const silentBoomFeedResponseSchema = z.looseObject({
  alerts: z.array(alertSchema),
});

interface UseSilentBoomFeedArgs {
  date: string;
  marketOpen: boolean;
  /** When true, the date is in the past — feed is static, skip polling. */
  historical?: boolean;
  ticker?: string | null;
  optionType?: OptionType | null;
  /** Vol/OI floor — UI default 0.5 to trim to actionable density. */
  minVolOi?: number;
  /** Spike-ratio floor. */
  minSpikeRatio?: number;
  /** Composite-score floor — Tier 1 = 21, Tier 2 = 8. */
  minScore?: number | null;
  /** Time-of-day filter — null = all phases. */
  tod?: SilentBoomTod | null;
  /**
   * DTE bucket filter — null = all DTEs. Legacy; new callers should
   * use `minDte` instead. Kept for back-compat with any cached query
   * strings. Server honors `minDte` over this when both are set.
   */
  dte?: SilentBoomDteBucket | null;
  /** Numeric DTE floor — 0 = all DTEs, N = only alerts with dte >= N. */
  minDte?: number;
  /** Numeric premium floor in dollars (entry_price × spike_volume × 100). */
  minPremium?: number;
  /** Hide alerts after 14:30 CT — server-side so pagination is accurate. */
  hideLatePm?: boolean;
  /** Burst-color category filter — null = all colors. */
  burst?: SilentBoomBurstColor | null;
  /** Ask% band filter — null = all bands. */
  askPctBand?: SilentBoomAskPctBand | null;
  /**
   * Aggressive Premium chip — single toggle that ANDs the trader's
   * UW filter (premium ≥ $100K, DTE ≤ 8, vol/OI > 1, single-leg, OTM)
   * onto the existing filters. Server-side enforced in
   * api/silent-boom-feed.ts.
   */
  aggressivePremium?: boolean;
  /** TAKE-IT calibrated P(peak >= +20%) floor. 0 = no floor. Server-
   *  side so pagination + chip totals reflect the post-filter result. */
  minTakeitProb?: number;
  sort?: SilentBoomSortMode;
  page?: number;
  pageSize?: number;
}

export function useSilentBoomFeed({
  date,
  marketOpen,
  historical = false,
  ticker = null,
  optionType = null,
  minVolOi = 0.5,
  minSpikeRatio = 0,
  minScore = null,
  tod = null,
  dte = null,
  minDte = 0,
  minPremium = 0,
  hideLatePm = false,
  burst = null,
  askPctBand = null,
  aggressivePremium = false,
  minTakeitProb = 0,
  sort = 'newest',
  page = 0,
  pageSize = 50,
}: UseSilentBoomFeedArgs): UseFetchedDataResult<SilentBoomFeedResponse> {
  const params = new URLSearchParams({
    date,
    limit: String(pageSize),
    offset: String(page * pageSize),
    minVolOi: String(minVolOi),
    minSpikeRatio: String(minSpikeRatio),
    sort,
  });
  if (ticker) params.set('ticker', ticker);
  if (optionType) params.set('optionType', optionType);
  if (minScore != null) params.set('minScore', String(minScore));
  if (tod) params.set('tod', tod);
  if (dte) params.set('dte', dte);
  if (minDte > 0) params.set('minDte', String(minDte));
  if (minPremium > 0) params.set('minPremium', String(minPremium));
  if (hideLatePm) params.set('hideLatePm', 'true');
  if (burst) params.set('burst', burst);
  if (askPctBand) params.set('askPctBand', askPctBand);
  if (aggressivePremium) params.set('aggressivePremium', 'true');
  if (minTakeitProb > 0) params.set('minTakeitProb', String(minTakeitProb));
  const url = `/api/silent-boom-feed?${params.toString()}`;

  // Original gates were `[marketOpen, page === 0, !historical]` — fold
  // the `page === 0` gate into the historical flag so paginated views
  // single-fetch instead of polling. The cross-day staleness gate lives
  // in the primitive via `requestKey`/`responseKey`.
  // A body that fails the schema is handled like a failed fetch: the throw
  // lands in useFetchedData's catch, which sets `error` and keeps the last
  // good payload. The latch reports a failure that repeats every poll once
  // per date, and a good response re-arms it.
  const reportedKeyRef = useRef<string | null>(null);
  const parse = (raw: unknown): SilentBoomFeedResponse => {
    const parsed = silentBoomFeedResponseSchema.safeParse(raw);
    if (!parsed.success) {
      if (claimReport(reportedKeyRef, date)) {
        captureUnlessAuth(
          new Error('silent-boom-feed response failed schema validation'),
          {
            contexts: {
              silentBoomFeed: {
                date,
                ...summarizeZodIssues(parsed.error.issues),
              },
            },
          },
        );
      }
      throw new Error(INVALID_SHAPE_ERROR);
    }
    reportedKeyRef.current = null;
    // The schema checks only the spread-leg fields; return the body as
    // received rather than a re-built copy of every poll's payload.
    return raw as SilentBoomFeedResponse;
  };

  return useFetchedData<SilentBoomFeedResponse>({
    url,
    marketOpen,
    pollIntervalMs: POLL_INTERVALS.OTM_FLOW,
    historical: historical || page !== 0,
    parse,
    requestKey: date,
    responseKey: (d) => d.date?.slice(0, 10),
  });
}
