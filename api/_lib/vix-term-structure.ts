/**
 * VIX term structure from the spot VIX / VIX3M ratio.
 *
 * Replaces the VX1/VX2 futures spread, which had no data source: Databento
 * never carried CFE, the UW futures feed is CME-only, and UW's VIX futures
 * endpoint needs a volatility add-on we don't have (see
 * docs/superpowers/specs/databento-removal-2026-09-29.md).
 *
 * Two sources:
 *   - live: Schwab `$VIX` + `$VIX3M` index quotes, both in one /quotes call.
 *   - lastClose + futuresRegime: UW `GET /stock/SPX/volatility/context` →
 *     `market.{vix, vix3m, vix_futures_regime}`. That block reports the
 *     latest daily closes only and ignores `?date=`, so it has no history:
 *     during the session it holds the prior close, after the close that
 *     day's. `vix_futures_regime` is UW's daily label from the front two
 *     VIX futures — the only VX-derived signal we can get.
 *
 * The UW result is cached in Redis (30 min for a complete reading; 5 min
 * after a failure or a data gap) because the snapshot endpoint polls every
 * 30 s and the value only changes once a day. No lock: a concurrent miss
 * costs one extra UW call.
 *
 * `fetchVixTermStructure` never throws and waits at most
 * SOURCE_DEADLINE_MS per source. Each source degrades to null and reports
 * why as a `vix_term.*` Sentry metric.
 */

import { z } from 'zod';
import logger from './logger.js';
import { limiterRedis, safeRedis, safeRedisVoid } from './redis.js';
import { schwabFetch } from './schwab-fetch.js';
import { metrics, Sentry } from './sentry.js';
import { uwFetch } from './uw-fetch.js';

// ── Bands ───────────────────────────────────────────────────

/**
 * VIX / VIX3M ratio bands: CONTANGO ≤ 0.90 < FLAT < 1.00 ≤ BACKWARDATION.
 *
 * Evidence — CBOE daily closes 2009–2026 (n = 4,285; median ratio 0.884):
 *
 *   ratio          share of days  mean VIX  next-day |ΔVIX|  next-day >10% spike
 *   ≤ 0.90              59%         15.7         3.3%
 *   0.90 – 1.00         33%         20.6         4.8%
 *   ≥ 1.00             7.6%         30.8         7.6%               30%
 *
 * 1.00 is the structural inversion point (spot VIX above 3-month). 0.90
 * sits just above the median, so CONTANGO is the calm majority and FLAT is
 * the elevated-vol third, where next-day VIX moves are ~45% larger.
 */
export const VIX_RATIO_CONTANGO_MAX = 0.9;
export const VIX_RATIO_BACKWARDATION_MIN = 1.0;

export type VixTermBand = 'CONTANGO' | 'FLAT' | 'BACKWARDATION';

export interface VixTermReading {
  vix: number;
  vix3m: number;
  /** VIX / VIX3M, rounded to 3 decimals (the band is classified on it). */
  ratio: number;
  band: VixTermBand;
}

export interface LiveVixTermReading extends VixTermReading {
  /**
   * ISO time of the older of the two quotes (Schwab `tradeTime`), so a
   * stale VIX3M can't pass as live. The fetch time when either quote
   * lacks a usable trade time.
   */
  asOf: string;
}

export interface VixTermStructure {
  /** Schwab intraday quotes; null when either quote is unavailable. */
  live: LiveVixTermReading | null;
  /** UW latest daily closes; null on UW failure or missing values. */
  lastClose: VixTermReading | null;
  /** UW `vix_futures_regime` (front two VIX futures, latest close). */
  futuresRegime: VixTermBand | null;
}

// ── Pure helpers ────────────────────────────────────────────

/**
 * VIX / VIX3M rounded to 3 decimals, or null unless both are finite and
 * positive.
 */
export function vixRatio(
  vix: number | null | undefined,
  vix3m: number | null | undefined,
): number | null {
  if (vix == null || vix3m == null) return null;
  if (!Number.isFinite(vix) || !Number.isFinite(vix3m)) return null;
  if (vix <= 0 || vix3m <= 0) return null;
  return Math.round((vix / vix3m) * 1000) / 1000;
}

/** Band for a VIX / VIX3M ratio (see the evidence on the constants). */
export function classifyVixRatio(ratio: number): VixTermBand {
  if (ratio <= VIX_RATIO_CONTANGO_MAX) return 'CONTANGO';
  if (ratio >= VIX_RATIO_BACKWARDATION_MIN) return 'BACKWARDATION';
  return 'FLAT';
}

/**
 * Map UW's `vix_futures_regime` label (`contango` | `flat` |
 * `backwardation`, per the operation docs) to a band. Case and surrounding
 * whitespace are ignored; any other label returns null.
 */
export function parseVixFuturesRegime(label: string): VixTermBand | null {
  switch (label.trim().toLowerCase()) {
    case 'contango':
      return 'CONTANGO';
    case 'flat':
      return 'FLAT';
    case 'backwardation':
      return 'BACKWARDATION';
    default:
      return null;
  }
}

function toReading(
  vix: number | null | undefined,
  vix3m: number | null | undefined,
): VixTermReading | null {
  const ratio = vixRatio(vix, vix3m);
  if (ratio == null || vix == null || vix3m == null) return null;
  return { vix, vix3m, ratio, band: classifyVixRatio(ratio) };
}

// ── Live: Schwab quotes ─────────────────────────────────────

const SCHWAB_VIX = '$VIX';
const SCHWAB_VIX3M = '$VIX3M';

/**
 * Schwab returns one entry per recognised symbol and reports unknown ones
 * under a separate `errors` key, so a rejected `$VIX3M` leaves the `$VIX`
 * entry intact. Each entry is validated on its own.
 */
const schwabIndexQuoteSchema = z.object({
  quote: z.object({
    lastPrice: z.number().positive(),
    tradeTime: z.number().optional(),
  }),
});

/** The older trade time, clamped to now; `nowMs` when either is unusable. */
function quoteAsOf(nowMs: number, a?: number, b?: number): string {
  const usable = (t?: number): t is number =>
    t != null && Number.isFinite(t) && t > 0;
  const ms = usable(a) && usable(b) ? Math.min(a, b, nowMs) : nowMs;
  return new Date(ms).toISOString();
}

function liveUnavailable(details: Record<string, unknown>, msg: string) {
  metrics.increment('vix_term.live_unavailable');
  logger.warn(details, msg);
  return null;
}

async function fetchLiveReading(): Promise<LiveVixTermReading | null> {
  try {
    const symbols = encodeURIComponent(`${SCHWAB_VIX},${SCHWAB_VIX3M}`);
    const result = await schwabFetch<Record<string, unknown> | null>(
      `/quotes?symbols=${symbols}&fields=quote`,
    );
    if (!result.ok) {
      return liveUnavailable(
        { code: result.code, status: result.status },
        'vix term: Schwab quote call failed — no live VIX/VIX3M ratio',
      );
    }
    const data = result.data ?? {};
    const vix = schwabIndexQuoteSchema.safeParse(data[SCHWAB_VIX]);
    if (!vix.success) {
      return liveUnavailable(
        { issues: vix.error.issues },
        'vix term: Schwab $VIX quote missing or malformed',
      );
    }
    const vix3m = schwabIndexQuoteSchema.safeParse(data[SCHWAB_VIX3M]);
    if (!vix3m.success) {
      metrics.increment('vix_term.vix3m_quote_missing');
      logger.warn(
        { schwabErrors: data.errors ?? null },
        'vix term: Schwab returned no usable $VIX3M quote — falling back to the UW close',
      );
      return null;
    }
    const reading = toReading(
      vix.data.quote.lastPrice,
      vix3m.data.quote.lastPrice,
    );
    if (reading == null) return null; // unreachable: both prices are > 0
    return {
      ...reading,
      asOf: quoteAsOf(
        Date.now(),
        vix.data.quote.tradeTime,
        vix3m.data.quote.tradeTime,
      ),
    };
  } catch (err) {
    Sentry.captureException(err);
    return liveUnavailable({ err }, 'vix term: Schwab quote fetch threw');
  }
}

// ── Last close + futures regime: UW, cached ─────────────────

const UW_CLOSE_CACHE_KEY = 'vix-term:uw-close:v1';
/** The block changes once a day; 30 min bounds post-close staleness. */
const UW_CLOSE_TTL_SEC = 30 * 60;
/** Negative cache: a UW outage costs one call per 5 min, not per poll. */
const UW_CLOSE_NEGATIVE_TTL_SEC = 5 * 60;

const bandSchema = z.enum(['CONTANGO', 'FLAT', 'BACKWARDATION']);

const uwCloseEntrySchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    lastClose: z
      .object({
        vix: z.number(),
        vix3m: z.number(),
        ratio: z.number(),
        band: bandSchema,
      })
      .nullable(),
    futuresRegime: bandSchema.nullable(),
  }),
  z.object({ ok: z.literal(false) }),
]);
type UwCloseEntry = z.infer<typeof uwCloseEntrySchema>;

/**
 * The fields we read from `volatility/context`. Every UW value is
 * documented nullable ("a value that has no data is null"), so null or
 * absent values are data gaps, not malformed bodies; only a missing
 * `market` object or a wrong type is.
 */
const uwContextSchema = z.object({
  market: z.object({
    vix: z.number().nullish(),
    vix3m: z.number().nullish(),
    vix_futures_regime: z.string().nullish(),
  }),
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The live response wraps the payload in `data`; the OpenAPI spec shows
 * it unwrapped. Accept both.
 */
function unwrapContext(body: unknown): unknown {
  return isRecord(body) && isRecord(body.data) ? body.data : body;
}

async function fetchUwCloseUncached(): Promise<UwCloseEntry> {
  const apiKey = process.env.UW_API_KEY;
  if (!apiKey) {
    metrics.increment('vix_term.uw_error');
    logger.warn('vix term: UW_API_KEY not configured — no VIX close');
    return { ok: false };
  }

  let body: unknown;
  try {
    const rows = await uwFetch<unknown>(
      apiKey,
      '/stock/SPX/volatility/context',
      (b) => [b],
    );
    body = rows[0];
  } catch (err) {
    metrics.increment('vix_term.uw_error');
    logger.warn({ err }, 'vix term: UW volatility/context fetch failed');
    return { ok: false };
  }

  const parsed = uwContextSchema.safeParse(unwrapContext(body));
  if (!parsed.success) {
    metrics.increment('vix_term.uw_malformed');
    logger.warn(
      { issues: parsed.error.issues },
      'vix term: UW volatility/context body has no usable market block',
    );
    return { ok: false };
  }

  const { vix, vix3m, vix_futures_regime: label } = parsed.data.market;
  const lastClose = toReading(vix, vix3m);
  if (lastClose == null || label == null) {
    // At most ~12/hour: an incomplete reading is cached for 5 min.
    metrics.increment('vix_term.uw_empty');
    Sentry.captureMessage('vix term: UW market block empty', 'warning');
    logger.warn(
      { vix, vix3m, label },
      'vix term: UW market block has no usable VIX/VIX3M close or regime label',
    );
  }
  let futuresRegime: VixTermBand | null = null;
  if (label != null) {
    futuresRegime = parseVixFuturesRegime(label);
    if (futuresRegime == null) {
      metrics.increment('vix_term.regime_unrecognized');
      logger.warn({ label }, 'vix term: unrecognized UW vix_futures_regime');
    }
  }
  return { ok: true, lastClose, futuresRegime };
}

/** Full TTL only for a complete reading; gaps are retried sooner. */
function cacheTtlSec(entry: UwCloseEntry): number {
  return entry.ok && entry.lastClose != null && entry.futuresRegime != null
    ? UW_CLOSE_TTL_SEC
    : UW_CLOSE_NEGATIVE_TTL_SEC;
}

/**
 * UW close + label through the Redis cache. Uses the fail-fast client
 * (one attempt, 1.5 s) so a Redis outage degrades to an uncached UW call
 * instead of stalling the request on Upstash's default retries.
 */
async function fetchUwClose(): Promise<UwCloseEntry> {
  try {
    const cached = await safeRedis(
      () => limiterRedis.get<unknown>(UW_CLOSE_CACHE_KEY),
      null,
    );
    if (cached != null) {
      const hit = uwCloseEntrySchema.safeParse(cached);
      if (hit.success) return hit.data;
    }

    const entry = await fetchUwCloseUncached();
    await safeRedisVoid(async () => {
      await limiterRedis.set(UW_CLOSE_CACHE_KEY, entry, {
        ex: cacheTtlSec(entry),
      });
    });
    return entry;
  } catch (err) {
    // Not expected — every step above handles its own failures.
    metrics.increment('vix_term.uw_error');
    Sentry.captureException(err);
    return { ok: false };
  }
}

// ── Public ──────────────────────────────────────────────────

/**
 * Per-source wait before giving up on it for this request. Callers are
 * the 30 s snapshot poll and the analyze context; without a bound, a slow
 * Schwab call (30 s timeout × 3 attempts) or a queued UW slot would hold
 * the whole snapshot response — including the DB-only futures grid —
 * past the next poll, which aborts it. Healthy calls take well under 1 s.
 * The abandoned call is not cancelled. A late UW result fills the cache
 * only if the instance is still running (best-effort — Vercel may suspend
 * it once the response is sent), and a Schwab call that fails after its
 * deadline counts `live_unavailable` a second time.
 */
const SOURCE_DEADLINE_MS = 4_000;

/** `p`, or `onTimeout()` if `p` hasn't settled within `ms`. */
async function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Live ratio (Schwab) plus the latest close and futures label (UW, cached).
 * Never throws; a failed or slow source is null and counted under
 * `vix_term.*`.
 */
export async function fetchVixTermStructure(): Promise<VixTermStructure> {
  const [live, close] = await Promise.all([
    withDeadline(fetchLiveReading(), SOURCE_DEADLINE_MS, () =>
      liveUnavailable(
        { deadlineMs: SOURCE_DEADLINE_MS },
        'vix term: Schwab quotes missed the deadline — no live ratio',
      ),
    ),
    withDeadline(fetchUwClose(), SOURCE_DEADLINE_MS, (): UwCloseEntry => {
      metrics.increment('vix_term.uw_error');
      logger.warn(
        { deadlineMs: SOURCE_DEADLINE_MS },
        'vix term: UW close missed the deadline — no close this request',
      );
      return { ok: false };
    }),
  ]);
  return {
    live,
    lastClose: close.ok ? close.lastClose : null,
    futuresRegime: close.ok ? close.futuresRegime : null,
  };
}
