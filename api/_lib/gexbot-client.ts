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
 * Rate-limit contract from AGENTS.md (verbatim):
 *   "Data updates at most once per second. Do not send more than one
 *    request per second per ticker per metric."
 * The fetch crons hit each (ticker, endpoint) pair once per minute
 * (well under the cap). No client-side rate limiter — Vercel cron
 * cadence is the budget. AGENTS.md also says to "use a short timeout
 * (about 1 second) for the snapshot routes"; we run 2.5 s on purpose
 * because GEXBot occasionally responds in 1–2 s under load (see
 * GEXBOT_TIMEOUT_MS).
 */

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
 */
export class GexbotHttpError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, body: string) {
    super(`GEXBot ${status} ${path}: ${body.slice(0, 200)}`);
    this.name = 'GexbotHttpError';
    this.status = status;
    this.path = path;
  }
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
 * component, so a 401/403 (auth), 429 (quota) and 5xx (vendor outage) land in
 * separate issues instead of one `Error`. `statusTag` is the `gexbot.status`
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
 * token) vs 429 (quota) vs 5xx vs network errors.
 *
 * We deliberately don't pool, batch, or retry here. The cron-level
 * fan-out uses `Promise.allSettled` so one bad call doesn't take
 * down the batch, and re-runs happen on the next minute tick
 * (cheaper than a retry loop inside a tight rate-limit envelope).
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
