/**
 * VIX term structure from the spot VIX / VIX3M ratio.
 *
 * Replaces the VX1/VX2 futures spread, which had no data source: Databento
 * never carried CFE, the UW futures feed is CME-only, and UW's VIX futures
 * endpoint needs a volatility add-on we don't have (see
 * docs/superpowers/specs/databento-removal-2026-09-29.md).
 *
 * Sources — all of them "now", none with history:
 *   - live + priorClose: one Schwab `/quotes` call for `$VIX` and `$VIX3M`.
 *     `lastPrice` gives the live ratio; `closePrice` gives the prior
 *     session's closing ratio (see PRIOR CLOSE below).
 *   - futuresRegime: UW `GET /stock/SPX/volatility/context` →
 *     `market.vix_futures_regime`, UW's label from the front two VIX
 *     futures — the only VX-derived signal we can get. The `market` block
 *     updates intraday (its vix/vix3m moved between two GETs 34 s apart on
 *     2026-10-02) and ignores `?date=`, so it is current data, not a close.
 *
 * The UW label is cached in Redis for 5 min (success or failure) because
 * the snapshot endpoint polls every 30 s. No lock: a concurrent miss costs
 * one extra UW call.
 *
 * `fetchVixTermStructure` never throws and waits at most
 * SOURCE_DEADLINE_MS per source. Each source degrades to null and reports
 * why as a `vix_term.*` Sentry metric.
 */

import { z } from 'zod';
import { isMarketOpen } from './cron-helpers.js';
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
  /** Schwab `lastPrice`s; null when either quote is unavailable. */
  live: LiveVixTermReading | null;
  /**
   * The prior cash session's closing ratio (Schwab `closePrice`). Set only
   * while today's cash session is open — see PRIOR CLOSE.
   */
  priorClose: VixTermReading | null;
  /** UW `vix_futures_regime`: current label from the front two VIX futures. */
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

// ── Live + prior close: Schwab quotes ───────────────────────

const SCHWAB_VIX = '$VIX';
const SCHWAB_VIX3M = '$VIX3M';

/**
 * Schwab returns one entry per recognised symbol and reports unknown ones
 * under a separate `errors` key, so a rejected `$VIX3M` leaves the `$VIX`
 * entry intact. Each entry is validated on its own. A bad `closePrice`
 * only costs the prior close, not the live reading.
 */
const schwabIndexQuoteSchema = z.object({
  quote: z.object({
    lastPrice: z.number().positive(),
    closePrice: z.number().optional().catch(undefined),
    tradeTime: z.number().optional(),
  }),
});

interface SchwabVixQuotes {
  live: LiveVixTermReading | null;
  priorClose: VixTermReading | null;
}

const NO_QUOTES: SchwabVixQuotes = { live: null, priorClose: null };

/** The older trade time, clamped to now; `nowMs` when either is unusable. */
function quoteAsOf(nowMs: number, a?: number, b?: number): string {
  const usable = (t?: number): t is number =>
    t != null && Number.isFinite(t) && t > 0;
  const ms = usable(a) && usable(b) ? Math.min(a, b, nowMs) : nowMs;
  return new Date(ms).toISOString();
}

function liveUnavailable(
  details: Record<string, unknown>,
  msg: string,
): SchwabVixQuotes {
  metrics.increment('vix_term.live_unavailable');
  logger.warn(details, msg);
  return NO_QUOTES;
}

/**
 * PRIOR CLOSE. Schwab's quote schema describes `closePrice` as the
 * previous day's closing price, and this repo already relies on that:
 * /api/quotes serves it as `prevClose`, and fetch-outcomes takes the day's
 * close from `lastPrice` after the session, not from `closePrice`. When
 * `closePrice` rolls over to the session that just ended is not
 * documented, so it is used only while today's cash session is open
 * (isMarketOpen: a trading day, 9:30 ET to the close), when it can only be
 * the prior session's close.
 */
function priorCloseReading(
  vixClose: number | undefined,
  vix3mClose: number | undefined,
): VixTermReading | null {
  return isMarketOpen() ? toReading(vixClose, vix3mClose) : null;
}

async function fetchSchwabQuotes(): Promise<SchwabVixQuotes> {
  try {
    const symbols = encodeURIComponent(`${SCHWAB_VIX},${SCHWAB_VIX3M}`);
    const result = await schwabFetch<Record<string, unknown> | null>(
      `/quotes?symbols=${symbols}&fields=quote`,
    );
    if (!result.ok) {
      // Logged out is an owner action, not a fault: count it quietly
      // instead of warning on every 30 s poll (cf. fetch-strike-iv).
      if (result.code === 'SCHWAB_TOKEN_EXPIRED') {
        metrics.increment('vix_term.live_logged_out');
        return NO_QUOTES;
      }
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
        'vix term: Schwab returned no usable $VIX3M quote — no VIX/VIX3M ratio',
      );
      return NO_QUOTES;
    }
    const v = vix.data.quote;
    const v3 = vix3m.data.quote;
    const reading = toReading(v.lastPrice, v3.lastPrice);
    return {
      live: reading && {
        ...reading,
        asOf: quoteAsOf(Date.now(), v.tradeTime, v3.tradeTime),
      },
      priorClose: priorCloseReading(v.closePrice, v3.closePrice),
    };
  } catch (err) {
    Sentry.captureException(err);
    return liveUnavailable({ err }, 'vix term: Schwab quote fetch threw');
  }
}

// ── VIX futures regime label: UW, cached ────────────────────

/** v2: the v1 entry also carried a UW "close" that was really intraday. */
const UW_REGIME_CACHE_KEY = 'vix-term:uw-regime:v2';
/**
 * The label is current data, so 5 min bounds how stale it can be. The same
 * TTL is the negative cache: a UW outage costs one call per 5 min, not one
 * per poll.
 */
const UW_REGIME_TTL_SEC = 5 * 60;

const uwRegimeEntrySchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    futuresRegime: z.enum(['CONTANGO', 'FLAT', 'BACKWARDATION']).nullable(),
  }),
  z.object({ ok: z.literal(false) }),
]);
type UwRegimeEntry = z.infer<typeof uwRegimeEntrySchema>;

/**
 * The field we read from `volatility/context`. Every UW value is
 * documented nullable ("a value that has no data is null"), so a null or
 * absent label is a data gap, not a malformed body; only a missing
 * `market` object or a wrong type is.
 */
const uwContextSchema = z.object({
  market: z.object({
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

async function fetchUwRegimeUncached(): Promise<UwRegimeEntry> {
  const apiKey = process.env.UW_API_KEY;
  if (!apiKey) {
    metrics.increment('vix_term.uw_error');
    logger.warn('vix term: UW_API_KEY not configured — no VIX futures label');
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

  const label = parsed.data.market.vix_futures_regime;
  if (label == null) {
    // At most ~12/hour: the gap is cached for 5 min.
    metrics.increment('vix_term.uw_empty');
    Sentry.captureMessage('vix term: UW market block empty', 'warning');
    logger.warn('vix term: UW market block has no vix_futures_regime');
    return { ok: true, futuresRegime: null };
  }
  const futuresRegime = parseVixFuturesRegime(label);
  if (futuresRegime == null) {
    metrics.increment('vix_term.regime_unrecognized');
    logger.warn({ label }, 'vix term: unrecognized UW vix_futures_regime');
  }
  return { ok: true, futuresRegime };
}

/**
 * UW label through the Redis cache. Uses the fail-fast client (one
 * attempt, 1.5 s) so a Redis outage degrades to an uncached UW call
 * instead of stalling the request on Upstash's default retries.
 */
async function fetchUwRegime(): Promise<UwRegimeEntry> {
  try {
    const cached = await safeRedis(
      () => limiterRedis.get<unknown>(UW_REGIME_CACHE_KEY),
      null,
    );
    if (cached != null) {
      const hit = uwRegimeEntrySchema.safeParse(cached);
      if (hit.success) return hit.data;
    }

    const entry = await fetchUwRegimeUncached();
    await safeRedisVoid(async () => {
      await limiterRedis.set(UW_REGIME_CACHE_KEY, entry, {
        ex: UW_REGIME_TTL_SEC,
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
 * Live ratio and prior close (Schwab) plus the VIX futures label (UW,
 * cached). Never throws; a failed or slow source is null and counted
 * under `vix_term.*`. Everything returned is current data — callers must
 * not present it as of an earlier moment.
 */
export async function fetchVixTermStructure(): Promise<VixTermStructure> {
  const [quotes, regime] = await Promise.all([
    withDeadline(fetchSchwabQuotes(), SOURCE_DEADLINE_MS, () =>
      liveUnavailable(
        { deadlineMs: SOURCE_DEADLINE_MS },
        'vix term: Schwab quotes missed the deadline — no live ratio',
      ),
    ),
    withDeadline(fetchUwRegime(), SOURCE_DEADLINE_MS, (): UwRegimeEntry => {
      metrics.increment('vix_term.uw_error');
      logger.warn(
        { deadlineMs: SOURCE_DEADLINE_MS },
        'vix term: UW label missed the deadline — none this request',
      );
      return { ok: false };
    }),
  ]);
  return {
    live: quotes.live,
    priorClose: quotes.priorClose,
    futuresRegime: regime.ok ? regime.futuresRegime : null,
  };
}
