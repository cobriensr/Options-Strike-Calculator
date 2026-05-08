/**
 * GET /api/silent-boom-feed
 *
 * Read endpoint backing the SilentBoomSection component. Returns
 * recent silent-boom alerts from `silent_boom_alerts` with realized
 * peak/exit metrics when the enrich step has filled them in.
 *
 * Owner-or-guest. Same auth pattern as /api/lottery-finder.
 *
 * Query params: ?date= ?ticker= ?optionType= ?minVolOi= ?minSpikeRatio=
 *               ?sort= ?limit= ?offset=
 * Validated by `silentBoomFeedQuerySchema` in api/_lib/validation.ts.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { silentBoomFeedQuerySchema } from './_lib/validation.js';
import { getETDateStr } from '../src/utils/timezone.js';

type DbId = number | string;
type DbNumeric = string | number;
type DbNullableNumeric = DbNumeric | null;
type DbTimestamp = string | Date;
type DbOptionType = 'C' | 'P';

interface AlertRow {
  id: DbId;
  date: DbTimestamp;
  bucket_ct: DbTimestamp;
  option_chain_id: string;
  underlying_symbol: string;
  option_type: DbOptionType;
  strike: DbNumeric;
  expiry: string;
  dte: number;
  spike_volume: number;
  baseline_volume: DbNumeric;
  spike_ratio: DbNumeric;
  ask_pct: DbNumeric;
  vol_oi: DbNumeric;
  entry_price: DbNumeric;
  open_interest: number;
  peak_ceiling_pct: DbNullableNumeric;
  minutes_to_peak: DbNullableNumeric;
  realized_30m_pct: DbNullableNumeric;
  realized_60m_pct: DbNullableNumeric;
  realized_120m_pct: DbNullableNumeric;
  realized_eod_pct: DbNullableNumeric;
  enriched_at: DbTimestamp | null;
  score: number | null;
  score_tier: 'tier1' | 'tier2' | 'tier3' | null;
  mkt_tide_diff: DbNullableNumeric;
  inserted_at: DbTimestamp;
}

interface SilentBoomAlertResponse {
  id: number;
  date: string;
  bucketCt: string;
  optionChainId: string;
  underlyingSymbol: string;
  optionType: 'C' | 'P';
  strike: number;
  expiry: string;
  dte: number;
  spikeVolume: number;
  baselineVolume: number;
  spikeRatio: number;
  askPct: number;
  volOi: number;
  entryPrice: number;
  openInterest: number;
  /** Composite conviction score. See api/_lib/silent-boom-score.ts. */
  score: number | null;
  /** 'tier1' | 'tier2' | 'tier3' — null only on legacy rows. */
  scoreTier: 'tier1' | 'tier2' | 'tier3' | null;
  /** Market Tide NCP - NPP at the spike-bucket time (display-only). */
  mktTideDiff: number | null;
  outcomes: {
    peakCeilingPct: number | null;
    minutesToPeak: number | null;
    realized30mPct: number | null;
    realized60mPct: number | null;
    realized120mPct: number | null;
    realizedEodPct: number | null;
    enrichedAt: string | null;
  };
  insertedAt: string;
}

type SilentBoomTodEnum = 'AM_open' | 'MID' | 'LUNCH' | 'PM' | 'LATE';
type SilentBoomDteBucket = '0' | '1-3' | '4+';
type SilentBoomBurstColor = 'red' | 'yellow' | 'grey';

interface SilentBoomFeedResponse {
  date: string;
  filters: {
    ticker?: string;
    optionType?: 'C' | 'P';
    minVolOi: number;
    minSpikeRatio: number;
    minScore: number | null;
    tod: SilentBoomTodEnum | null;
    dte: SilentBoomDteBucket | null;
    burst: SilentBoomBurstColor | null;
    sort: 'newest' | 'spike_ratio' | 'vol_oi' | 'peak';
  };
  count: number;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  alerts: SilentBoomAlertResponse[];
}

function toIso(v: DbTimestamp | null | undefined): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  return new Date(v).toISOString();
}

function toIsoOrNull(v: DbTimestamp | null | undefined): string | null {
  if (v == null) return null;
  return toIso(v);
}

function toNum(v: DbNumeric): number {
  return typeof v === 'number' ? v : Number.parseFloat(v);
}

function toNumOrNull(v: DbNullableNumeric): number | null {
  if (v == null) return null;
  return toNum(v);
}

function toDateIso(v: DbTimestamp): string {
  // Server-side DATE columns come back as Date with UTC midnight; the
  // calendar date is what we want.
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const guarded = await guardOwnerOrGuestEndpoint(req, res, () => undefined);
  if (guarded) return;

  const parsed = silentBoomFeedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid query',
      details: parsed.error.issues,
    });
    return;
  }
  const q = parsed.data;
  const date = q.date ?? getETDateStr(new Date());

  // TOD bucket → CT minute-of-day range. Boundaries mirror
  // silentBoomTodFromMinuteCt in api/_lib/silent-boom-score.ts.
  // Returns half-open [lo, hi) on the CT day. Null when no TOD filter.
  const todRange = (() => {
    if (q.tod === 'AM_open') return { lo: 0, hi: 10 * 60 };
    if (q.tod === 'MID') return { lo: 10 * 60, hi: 12 * 60 };
    if (q.tod === 'LUNCH') return { lo: 12 * 60, hi: 13 * 60 };
    if (q.tod === 'PM') return { lo: 13 * 60, hi: 15 * 60 };
    if (q.tod === 'LATE') return { lo: 15 * 60, hi: 24 * 60 };
    return null;
  })();
  const todLo = todRange?.lo ?? null;
  const todHi = todRange?.hi ?? null;

  // DTE bucket → numeric range. '0' is exact; '1-3' is BETWEEN; '4+'
  // is >= 4. Bind boundaries as nullable ints so the gate evaluates
  // to TRUE when no filter is set.
  // DTE bucket → numeric range. '0' is exact; '1-3' is BETWEEN; '4+'
  // is >= 4. Postgres has no IS NULL OR shortcut on BETWEEN, so we
  // encode the "no upper bound" case via a sentinel (100k — larger
  // than any real DTE).
  const dteRange = (() => {
    if (q.dte === '0') return { lo: 0, hi: 0 };
    if (q.dte === '1-3') return { lo: 1, hi: 3 };
    if (q.dte === '4+') return { lo: 4, hi: 100_000 };
    return null;
  })();
  const dteLo = dteRange?.lo ?? null;
  const dteHiBound = dteRange?.hi ?? 100_000;

  // Burst color category → spike_ratio range. Mirrors the
  // SilentBoomRow spike badge: red >= 50×, yellow 20-50×, grey < 20×.
  // Detector floor is 5× so 'grey' lands 5–20×. Same sentinel pattern
  // as DTE — "no upper bound" red collapses to a 1M sentinel.
  const burstRange = (() => {
    if (q.burst === 'red') return { lo: 50, hi: 1_000_000 };
    if (q.burst === 'yellow') return { lo: 20, hi: 50 };
    if (q.burst === 'grey') return { lo: 0, hi: 20 };
    return null;
  })();
  const burstLo = burstRange?.lo ?? null;
  const burstHiBound = burstRange?.hi ?? 1_000_000;

  try {
    const db = getDb();

    // Build the WHERE clause incrementally — using neon-serverless
    // tagged template requires us to execute one of a few precomposed
    // queries based on the active filters. Mirrors the lottery-finder
    // pattern (avoid string-concat SQL).
    const tickerUpper = q.ticker?.toUpperCase();

    // Total count for pagination.
    const totalRow = (await db`
      SELECT COUNT(*)::int AS n
      FROM silent_boom_alerts
      WHERE date = ${date}::date
        AND (${tickerUpper ?? null}::text IS NULL OR underlying_symbol = ${tickerUpper ?? null}::text)
        AND (${q.optionType ?? null}::text IS NULL OR option_type = ${q.optionType ?? null}::text)
        AND vol_oi >= ${q.minVolOi}::numeric
        AND spike_ratio >= ${q.minSpikeRatio}::numeric
        AND (${q.minScore ?? null}::int IS NULL OR score >= ${q.minScore ?? null}::int)
        AND (${todLo}::int IS NULL OR (
          EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
          EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
        ) >= ${todLo}::int)
        AND (${todHi}::int IS NULL OR (
          EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
          EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
        ) < ${todHi}::int)
        AND (${dteLo}::int IS NULL OR dte BETWEEN ${dteLo}::int AND ${dteHiBound}::int)
        AND (${burstLo}::numeric IS NULL OR (spike_ratio >= ${burstLo}::numeric AND spike_ratio < ${burstHiBound}::numeric))
    `) as { n: number }[];
    const total = totalRow[0]?.n ?? 0;

    // Sort clause — neon tagged-template doesn't support unsafe()
    // identifier interpolation, so we route via a switch on the
    // validated enum.
    let rows: AlertRow[];
    if (q.sort === 'spike_ratio') {
      rows = (await db`
        SELECT *
        FROM silent_boom_alerts
        WHERE date = ${date}::date
          AND (${tickerUpper ?? null}::text IS NULL OR underlying_symbol = ${tickerUpper ?? null}::text)
          AND (${q.optionType ?? null}::text IS NULL OR option_type = ${q.optionType ?? null}::text)
          AND vol_oi >= ${q.minVolOi}::numeric
          AND spike_ratio >= ${q.minSpikeRatio}::numeric
          AND (${q.minScore ?? null}::int IS NULL OR score >= ${q.minScore ?? null}::int)
          AND (${todLo}::int IS NULL OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) >= ${todLo}::int)
          AND (${todHi}::int IS NULL OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) < ${todHi}::int)
          AND (${dteLo}::int IS NULL OR dte BETWEEN ${dteLo}::int AND ${dteHiBound}::int)
          AND (${burstLo}::numeric IS NULL OR (spike_ratio >= ${burstLo}::numeric AND spike_ratio < ${burstHiBound}::numeric))
        ORDER BY spike_ratio DESC, bucket_ct DESC
        LIMIT ${q.limit} OFFSET ${q.offset}
      `) as AlertRow[];
    } else if (q.sort === 'vol_oi') {
      rows = (await db`
        SELECT *
        FROM silent_boom_alerts
        WHERE date = ${date}::date
          AND (${tickerUpper ?? null}::text IS NULL OR underlying_symbol = ${tickerUpper ?? null}::text)
          AND (${q.optionType ?? null}::text IS NULL OR option_type = ${q.optionType ?? null}::text)
          AND vol_oi >= ${q.minVolOi}::numeric
          AND spike_ratio >= ${q.minSpikeRatio}::numeric
          AND (${q.minScore ?? null}::int IS NULL OR score >= ${q.minScore ?? null}::int)
          AND (${todLo}::int IS NULL OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) >= ${todLo}::int)
          AND (${todHi}::int IS NULL OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) < ${todHi}::int)
          AND (${dteLo}::int IS NULL OR dte BETWEEN ${dteLo}::int AND ${dteHiBound}::int)
          AND (${burstLo}::numeric IS NULL OR (spike_ratio >= ${burstLo}::numeric AND spike_ratio < ${burstHiBound}::numeric))
        ORDER BY vol_oi DESC, bucket_ct DESC
        LIMIT ${q.limit} OFFSET ${q.offset}
      `) as AlertRow[];
    } else if (q.sort === 'peak') {
      rows = (await db`
        SELECT *
        FROM silent_boom_alerts
        WHERE date = ${date}::date
          AND (${tickerUpper ?? null}::text IS NULL OR underlying_symbol = ${tickerUpper ?? null}::text)
          AND (${q.optionType ?? null}::text IS NULL OR option_type = ${q.optionType ?? null}::text)
          AND vol_oi >= ${q.minVolOi}::numeric
          AND spike_ratio >= ${q.minSpikeRatio}::numeric
          AND (${q.minScore ?? null}::int IS NULL OR score >= ${q.minScore ?? null}::int)
          AND (${todLo}::int IS NULL OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) >= ${todLo}::int)
          AND (${todHi}::int IS NULL OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) < ${todHi}::int)
          AND (${dteLo}::int IS NULL OR dte BETWEEN ${dteLo}::int AND ${dteHiBound}::int)
          AND (${burstLo}::numeric IS NULL OR (spike_ratio >= ${burstLo}::numeric AND spike_ratio < ${burstHiBound}::numeric))
        ORDER BY peak_ceiling_pct DESC NULLS LAST, bucket_ct DESC
        LIMIT ${q.limit} OFFSET ${q.offset}
      `) as AlertRow[];
    } else {
      // 'newest' — default
      rows = (await db`
        SELECT *
        FROM silent_boom_alerts
        WHERE date = ${date}::date
          AND (${tickerUpper ?? null}::text IS NULL OR underlying_symbol = ${tickerUpper ?? null}::text)
          AND (${q.optionType ?? null}::text IS NULL OR option_type = ${q.optionType ?? null}::text)
          AND vol_oi >= ${q.minVolOi}::numeric
          AND spike_ratio >= ${q.minSpikeRatio}::numeric
          AND (${q.minScore ?? null}::int IS NULL OR score >= ${q.minScore ?? null}::int)
          AND (${todLo}::int IS NULL OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) >= ${todLo}::int)
          AND (${todHi}::int IS NULL OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) < ${todHi}::int)
          AND (${dteLo}::int IS NULL OR dte BETWEEN ${dteLo}::int AND ${dteHiBound}::int)
          AND (${burstLo}::numeric IS NULL OR (spike_ratio >= ${burstLo}::numeric AND spike_ratio < ${burstHiBound}::numeric))
        ORDER BY bucket_ct DESC, id DESC
        LIMIT ${q.limit} OFFSET ${q.offset}
      `) as AlertRow[];
    }

    const alerts: SilentBoomAlertResponse[] = rows.map((r) => ({
      id: Number(r.id),
      date: toDateIso(r.date),
      bucketCt: toIso(r.bucket_ct),
      optionChainId: r.option_chain_id,
      underlyingSymbol: r.underlying_symbol,
      optionType: r.option_type,
      strike: toNum(r.strike),
      expiry: r.expiry,
      dte: r.dte,
      spikeVolume: r.spike_volume,
      baselineVolume: toNum(r.baseline_volume),
      spikeRatio: toNum(r.spike_ratio),
      askPct: toNum(r.ask_pct),
      volOi: toNum(r.vol_oi),
      entryPrice: toNum(r.entry_price),
      openInterest: r.open_interest,
      score: r.score,
      scoreTier: r.score_tier,
      mktTideDiff: toNumOrNull(r.mkt_tide_diff),
      outcomes: {
        peakCeilingPct: toNumOrNull(r.peak_ceiling_pct),
        minutesToPeak: toNumOrNull(r.minutes_to_peak),
        realized30mPct: toNumOrNull(r.realized_30m_pct),
        realized60mPct: toNumOrNull(r.realized_60m_pct),
        realized120mPct: toNumOrNull(r.realized_120m_pct),
        realizedEodPct: toNumOrNull(r.realized_eod_pct),
        enrichedAt: toIsoOrNull(r.enriched_at),
      },
      insertedAt: toIso(r.inserted_at),
    }));

    const response: SilentBoomFeedResponse = {
      date,
      filters: {
        ...(tickerUpper ? { ticker: tickerUpper } : {}),
        ...(q.optionType ? { optionType: q.optionType } : {}),
        minVolOi: q.minVolOi,
        minSpikeRatio: q.minSpikeRatio,
        minScore: q.minScore ?? null,
        tod: q.tod ?? null,
        dte: q.dte ?? null,
        burst: q.burst ?? null,
        sort: q.sort,
      },
      count: alerts.length,
      total,
      limit: q.limit,
      offset: q.offset,
      hasMore: q.offset + alerts.length < total,
      alerts,
    };

    setCacheHeaders(res, 30, 60);
    res.status(200).json(response);
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'silent-boom-feed: unexpected error');
    res.status(500).json({ error: 'Internal error' });
  }
}
