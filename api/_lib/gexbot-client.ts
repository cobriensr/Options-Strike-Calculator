/**
 * GEXBot API client (Orderflow tier).
 *
 * Thin HTTP wrapper around api.gex.bot v2 endpoints accessible at the
 * Orderflow tier (which inherits Public + Classic + State). Returns
 * the raw JSON body — callers extract scalars they care about. Raw
 * body is destined for a `JSONB` column so no Zod validation past
 * "the server returned an object".
 *
 * See: docs/superpowers/specs/gexbot-trial-capture-2026-05-16.md
 * Spec source: github.com/nfa-llc/gexbot-openapi
 *   (latest/gexbot.spec3.yaml, spec 2.13.0, published 2026-10-27)
 *
 * Rate limits (vendor docs, spec 2.17.0, re-read 2026-11-14). GEXBot
 * documents two different things that answer 429:
 *   - a per-account short-window limit: an account sending requests in a
 *     loop with no delay can be limited over a window such as a second or a
 *     minute, all keys counted together. The docs say this 429 carries
 *     `Retry-After`.
 *   - daily and monthly pool quotas per endpoint, reset at midnight ET.
 *     The docs say nothing about `Retry-After` on a quota 429.
 * AGENTS.md's "do not send more than one request per second per ticker per
 * metric" is the vendor's polling advice, not an enforced limit. The fetch
 * crons hit each (ticker, endpoint) pair once per minute, with no
 * client-side limiter: Vercel cron cadence is the budget.
 *
 * The one burst seen (2026-11-11: 4 calls within about 120 ms, nothing
 * after) was transient. Whether it was the short-window limit is not
 * established; one hypothesis is the two crons' roughly 256 calls starting
 * together each minute, which that limit counts per account. So a live-route
 * 429 is counted (`gexbot.rate_limited`) and the callers' `withRetry`
 * retries it with backoff, bounded, waiting out `Retry-After` up to 3 s. A
 * 429 still there after the retries is filed by the crons as one warning
 * whose `gexbot.retry_after_ms` tag says what it carried: a number is a
 * `Retry-After` the vendor sent, `none` is a 429 with no usable one
 * (`gexbotRetryAfterTags`). The docs document `Retry-After` on the
 * short-window limit and are silent for a quota 429, so `none` is only
 * consistent with a quota; a 429 that persists across ticks is what confirms
 * one. The EOD report route (`gexbot-eod.ts`) treats a 429 as a quota and
 * stops.
 *
 * AGENTS.md also says to "use a short timeout (about 1 second) for the
 * snapshot routes"; we run 2.5 s on purpose because GEXBot occasionally
 * responds in 1–2 s under load (see GEXBOT_TIMEOUT_MS).
 */

import { metrics } from './sentry.js';

export const GEXBOT_BASE = 'https://api.gex.bot/v2';

/**
 * Per-call HTTP timeout. Bumped 1 s → 2.5 s after
 * SENTRY-EMERALD-DESERT-8F/76 showed 163 TimeoutError events when
 * GEXBot returned in 1–2 s during slow minutes. The vendor recommends
 * about 1 s for snapshot routes; we keep 2.5 s deliberately because
 * 1 s is what produced those timeouts. Both fetch crons set
 * maxDuration to 60 s (the plan constant shared with fetch-gexbot-strikes).
 *
 * Worst case, not the normal one: a persistently failing task costs about
 * 10.5 s (3 attempts x 2.5 s + 1 s + 2 s backoff), so 128 tasks in waves of
 * 32 take about 42 s. Each DB write in fetch-gexbot-fast can add up to about
 * 33 s on top (3 x 10 s + 3 s backoff), so a double outage (GEXBot down and
 * Neon down) can reach about 75 s and Vercel kills the run at 60 s with no
 * Axiom event. We keep 60 s: normal ticks finish far below it, and the Sentry
 * cron monitor (SCHEDULE_MAP, 10:00-15:59 ET) times out the check-in
 * of a killed run (in_progress with no completion).
 */
const GEXBOT_TIMEOUT_MS = 2_500;

/**
 * GEXBot bearer-token prefix (literal). The README requires the
 * `gexbot_custom_` prefix on every token — the env var holds the
 * secret portion only.
 */
const TOKEN_PREFIX = 'gexbot_custom_';

/**
 * The 16 tickers the user pays for at the Orderflow tier (matches
 * the Index + ETF columns in the GEXBot UI 2026-05-16 screenshot).
 *
 * The `ES_SPX` and `NQ_NDX` slugs are GEXBot's variant tickers for
 * "SPX⇒ES" (SPX-anchored futures) and "NDX⇒NQ" — both appear in the
 * `ticker_variant` enum of the OpenAPI spec.
 */
export const GEXBOT_TICKERS = [
  // Indexes
  'SPX',
  'ES_SPX',
  'NDX',
  'NQ_NDX',
  'RUT',
  'VIX',
  // ETFs
  'SPY',
  'QQQ',
  'IWM',
  'TLT',
  'GLD',
  'USO',
  'TQQQ',
  'UVXY',
  'HYG',
  'SLV',
] as const;

export type GexbotTicker = (typeof GEXBOT_TICKERS)[number];

/**
 * State endpoint categories we poll per-strike for each ticker.
 * `_zero` = the nearest expiry (0DTE for tickers with dailies); `_one`
 * = the single next expiry (one expiry, not every expiry after 0DTE).
 * Skipped: the bare `{gamma,delta,vanna,charm}` and `one{greek}` names
 * — the spec lists them as aliases of `_zero` and `_one`, so polling
 * them would duplicate calls.
 */
export const STATE_CATEGORIES = [
  'gamma_zero',
  'delta_zero',
  'vanna_zero',
  'charm_zero',
  'gamma_one',
  'delta_one',
  'vanna_one',
  'charm_one',
] as const;

export type StateCategory = (typeof STATE_CATEGORIES)[number];

/**
 * Classic-tier maxchange categories we capture. Each returns the
 * top-mover strike across 6 lookback windows (`current` / `one` /
 * `five` / `ten` / `fifteen` / `thirty`). All three DTE buckets:
 * nearest expiry (`gex_zero`), the single next expiry (`gex_one`), and
 * full aggregation up to 90 days out (`gex_full`).
 */
export const MAXCHANGE_CATEGORIES = [
  'gex_zero',
  'gex_one',
  'gex_full',
] as const;

export type MaxchangeCategory = (typeof MAXCHANGE_CATEGORIES)[number];

/**
 * State-tier maxchange categories. The `/state/{category}/maxchange`
 * sub-route accepts the same 3 DTE buckets as `/classic/...` — the
 * Greek×DTE values (`gamma_zero`, `charm_one`, etc.) used by the
 * non-maxchange `/state/{category}` endpoint are rejected here with
 * HTTP 400 ("Category must be one of gex_full, gex_one or gex_zero").
 */
export const STATE_MAXCHANGE_CATEGORIES = MAXCHANGE_CATEGORIES;

/**
 * Generic JSON object returned by GEXBot. Each endpoint has its own
 * shape (see latest/gexbot.spec3.yaml) but they all share the
 * `timestamp` / `ticker` / `spot` header fields. Callers cast to a
 * specific shape only for the orderflow scalar-extraction path.
 */
export type GexbotResponse = Record<string, unknown>;

/**
 * Non-2xx response from GEXBot. The message keeps the historical
 * `GEXBot <status> <path>: <body, first 200 chars>` text, which
 * `withRetry`'s classifier and the logs match on; `status` and `path`
 * expose the same facts without re-parsing it (see `classifyGexbotError`).
 * `retryAfterMs` is the `Retry-After` of a 429 in ms, null when it sent none
 * or sent something unreadable; `withRetry` reads it by that property name.
 */
export class GexbotHttpError extends Error {
  readonly status: number;
  readonly path: string;
  readonly retryAfterMs: number | null;

  constructor(
    status: number,
    path: string,
    body: string,
    retryAfterMs: number | null = null,
  ) {
    super(`GEXBot ${status} ${path}: ${body.slice(0, 200)}`);
    this.name = 'GexbotHttpError';
    this.status = status;
    this.path = path;
    this.retryAfterMs = retryAfterMs;
  }
}

const RETRY_AFTER_SECONDS = /^\d+(?:\.\d+)?$/;
// IMF-fixdate, the one HTTP-date form current servers send (RFC 9110).
const RETRY_AFTER_HTTP_DATE =
  /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * A `Retry-After` header as ms: delta-seconds or an HTTP-date (read against
 * the clock, never negative). Null for an absent or unreadable value, so a
 * garbled header falls back to the default backoff instead of a bad wait.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
): number | null {
  const v = value?.trim();
  if (!v) return null;
  if (RETRY_AFTER_SECONDS.test(v))
    return Math.round(Number.parseFloat(v) * 1000);
  if (!RETRY_AFTER_HTTP_DATE.test(v)) return null;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

export type GexbotStatusClass =
  | 'http-429'
  | 'http-4xx'
  | 'http-5xx'
  | 'no-data'
  | 'timeout'
  | 'other';

/**
 * The vendor's normal "no snapshot yet" answers: maxchange returns 404 when
 * there is no data, and the orderflow route returns 500 `Failed to get redis
 * chart data: null or zero length`. They get their own class so the routine
 * noise cannot hide a 401/403 or a real 5xx in the same Sentry issue.
 */
function isNoData(err: GexbotHttpError): boolean {
  if (err.status === 404) return err.path.endsWith('/maxchange');
  return err.status === 500 && err.message.includes('null or zero length');
}

/**
 * Bucket a failed GEXBot call for Sentry. `statusClass` is the fingerprint
 * component, so a 401/403 (auth), 429 (rate limit) and 5xx (vendor outage) land
 * in separate issues instead of one `Error`. `statusTag` is the `gexbot.status`
 * tag: the numeric HTTP status when there is one, otherwise the class.
 */
export function classifyGexbotError(err: unknown): {
  statusClass: GexbotStatusClass;
  statusTag: string;
} {
  if (err instanceof GexbotHttpError) {
    let statusClass: GexbotStatusClass = 'other';
    if (isNoData(err)) statusClass = 'no-data';
    else if (err.status === 429) statusClass = 'http-429';
    else if (err.status >= 500) statusClass = 'http-5xx';
    else if (err.status >= 400) statusClass = 'http-4xx';
    return { statusClass, statusTag: String(err.status) };
  }
  if (
    err instanceof Error &&
    (err.name === 'TimeoutError' || err.name === 'AbortError')
  ) {
    return { statusClass: 'timeout', statusTag: 'timeout' };
  }
  return { statusClass: 'other', statusTag: 'other' };
}

/**
 * The tag that puts the evidence for which limit an exhausted 429 was on the
 * event. The docs say the short-window limit sends `Retry-After` and are
 * silent for a pool quota, so a number is the short-window limit and `none` is
 * only consistent with a quota; its persistence across ticks confirms it. A
 * tag, not an extra: Sentry tags are string-valued and searchable, so
 * `gexbot.retry_after_ms:none` finds those, and this value is a short string
 * either way. `Retry-After` in ms as a string (a sent 0 is `0`), or `none`
 * when the 429 carried none or an unreadable one. Empty for any failure that
 * is not a 429, so the tag only ever answers this question.
 */
export function gexbotRetryAfterTags(err: unknown): Record<string, string> {
  if (!(err instanceof GexbotHttpError) || err.status !== 429) return {};
  return {
    'gexbot.retry_after_ms':
      err.retryAfterMs === null ? 'none' : String(err.retryAfterMs),
  };
}

/**
 * Sentry level for a GEXBot fetch that failed after its retries. A 429 that
 * outlasted the backoff is a warning: the next tick re-fetches, and the cron
 * still reports `partial` or `error` for the run. The `gexbot.retry_after_ms`
 * tag carries the evidence for which limit it was. Everything else is an
 * error.
 */
export function gexbotFailureLevel(
  statusClass: GexbotStatusClass,
): 'warning' | 'error' {
  return statusClass === 'http-429' ? 'warning' : 'error';
}

/**
 * Internal: build the GEXBot bearer header value.
 *
 * Token format is `gexbot_custom_<secret>`. We accept either form
 * from the env var (with or without the prefix) so a copy-paste of
 * the full token from the GEXBot dashboard still works.
 */
export function buildAuthHeader(apiKey: string): string {
  const token = apiKey.startsWith(TOKEN_PREFIX)
    ? apiKey
    : `${TOKEN_PREFIX}${apiKey}`;
  return `Bearer ${token}`;
}

/**
 * Issue a single authenticated GEXBot request. Throws on non-2xx,
 * timeout, or network failure. A non-2xx throws `GexbotHttpError`
 * (status + path), so caller logs/Sentry can distinguish 401 (bad
 * token) vs 429 (rate limit) vs 5xx vs network errors. Every 429 is
 * counted here, `Retry-After` kept on the error.
 *
 * We deliberately don't pool or batch here, and the retry is the
 * caller's `withRetry` (both crons wrap every call), not this function's:
 * a call that fails after its retries is reported by the cron, and the
 * next minute tick re-fetches.
 */
async function gexbotFetch(
  apiKey: string,
  path: string,
): Promise<GexbotResponse> {
  const url = `${GEXBOT_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: buildAuthHeader(apiKey),
      Accept: 'application/json',
      'User-Agent': 'strike-calculator/1.0 (gexbot-trial)',
    },
    signal: AbortSignal.timeout(GEXBOT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res
      .text()
      .catch((e) => `[parse error: ${(e as Error).message}]`);
    if (res.status === 429) {
      // The ticker is the first segment; naming the route alone keeps the
      // attribute to the route list instead of tickers x routes.
      metrics.gexbotRateLimit(path.replace(/^\/[^/]+/, '/{ticker}'));
      throw new GexbotHttpError(
        res.status,
        path,
        text,
        parseRetryAfterMs(res.headers?.get?.('retry-after')),
      );
    }
    throw new GexbotHttpError(res.status, path, text);
  }

  const body = (await res.json()) as unknown;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`GEXBot ${path}: expected object body, got ${typeof body}`);
  }
  return body as GexbotResponse;
}

/**
 * GET /{ticker}/orderflow/orderflow — the Orderflow-tier snapshot
 * containing the proprietary flow scalars (zcvr, zgr, dexoflow, gexoflow,
 * cvroflow, the dex family, and the z-prefixed / o-prefixed moneyness
 * gammas) plus spot/ticker/timestamp. Per the spec every flow field is
 * net TAKER exposure, not a dealer position: `agg_*` = cumulative since
 * the 09:30 ET open (resets daily); `net_*`, `*cvr`, `*gr`, `*vanna`,
 * `*charm` = across the active chain at this moment; `*oflow` = the
 * change over the last second.
 *
 * NOTE: zero_gamma, sum_gex_*, major_*, delta_risk_reversal and
 * min_dte/sec_min_dte are not in this payload. Spec 2.13.0's
 * `orderflow_response` no longer lists them, and the live body is the 34
 * flow fields plus timestamp/ticker/spot. Those fields are sourced from
 * `fetchClassicBasic` instead. See
 * docs/superpowers/specs/gexbot-classic-basic-capture-2026-05-29.md.
 */
export function fetchOrderflow(
  apiKey: string,
  ticker: GexbotTicker,
): Promise<GexbotResponse> {
  return gexbotFetch(apiKey, `/${ticker}/orderflow/orderflow`);
}

/**
 * GET /{ticker}/classic/{category} — the basic (non-maxchange) classic
 * endpoint. Returns the `basic_response` aggregate scalars for one DTE
 * bucket: zero_gamma (a spline crossing on GEX by volume, not a spot-sweep
 * "gamma flip"), sum_gex_vol/oi, major_pos/neg_vol/oi,
 * delta_risk_reversal, min_dte/sec_min_dte, plus a strikes[] GEX profile.
 *
 * This is the live home of the 10 aggregate fields the /orderflow payload
 * doesn't carry. We poll `gex_zero` (0DTE) and merge them into the orderflow
 * snapshot row. Distinct from `fetchMaxchange` (`/classic/{cat}/maxchange`),
 * which returns biggest-mover strikes over the lookback windows.
 */
export function fetchClassicBasic(
  apiKey: string,
  ticker: GexbotTicker,
  category: MaxchangeCategory,
): Promise<GexbotResponse> {
  return gexbotFetch(apiKey, `/${ticker}/classic/${category}`);
}

/**
 * GET /{ticker}/state/{category} — per-strike Greek profile for
 * one DTE bucket. For the Greek categories (STATE_CATEGORIES) the spec
 * returns `option_profile_response`, NOT `basic_response`: timestamp,
 * ticker, spot, min_dte, sec_min_dte, major_positive, major_negative,
 * major_long_gamma, major_short_gamma and mini_contracts. There is no
 * `strikes[]`. Each mini_contracts row carries the requested Greek
 * (gamma/delta/vanna/charm) as a net taker imbalance from GEXBot's
 * orderflow classification engine, not a dealer position (row layout:
 * `decodeStrikes` in periscope-gexbot.ts). The gex categories
 * (`/state/gex_*`) return `basic_response`.
 */
export function fetchStatePerStrike(
  apiKey: string,
  ticker: GexbotTicker,
  category: StateCategory,
): Promise<GexbotResponse> {
  return gexbotFetch(apiKey, `/${ticker}/state/${category}`);
}

/**
 * GET /{ticker}/classic/{category}/maxchange — biggest-mover strike
 * across the 6 lookback windows. Response carries one `[strike, change]`
 * tuple per window plus the standard timestamp/ticker/spot header.
 */
export function fetchMaxchange(
  apiKey: string,
  ticker: GexbotTicker,
  category: MaxchangeCategory,
): Promise<GexbotResponse> {
  return gexbotFetch(apiKey, `/${ticker}/classic/${category}/maxchange`);
}

/**
 * GET /{ticker}/state/{category}/maxchange — biggest-mover strike
 * over the 6 lookback windows for one of the three DTE buckets
 * (`gex_zero`, `gex_one`, `gex_full`). Distinct from `fetchMaxchange`
 * (`/classic/{category}/maxchange`) which is keyed on GEX dollar
 * change at the strike — `state` ranks by raw state-vector magnitude
 * over the same lookback windows.
 */
export function fetchStateMaxchange(
  apiKey: string,
  ticker: GexbotTicker,
  category: MaxchangeCategory,
): Promise<GexbotResponse> {
  return gexbotFetch(apiKey, `/${ticker}/state/${category}/maxchange`);
}
