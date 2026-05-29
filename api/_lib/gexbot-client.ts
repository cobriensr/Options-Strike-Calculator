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
 *   (latest/gexbot.spec3.yaml, GEXBot v2.2.0)
 *
 * Rate-limit contract from AGENTS.md (verbatim):
 *   "Data is not updated more than once per second. Requests should
 *    not exceed one request per second per ticker per metric."
 * The fetch crons hit each (ticker, endpoint) pair once per minute
 * (well under the cap). No client-side rate limiter — Vercel cron
 * cadence is the budget. Note: that contract bounds REQUEST RATE, not
 * the per-request HTTP timeout; GEXBot occasionally responds in
 * 1–2 s under load.
 */

const GEXBOT_BASE = 'https://api.gex.bot/v2';

/**
 * Per-call HTTP timeout. Bumped 1 s → 2.5 s after
 * SENTRY-EMERALD-DESERT-8F/76 showed 163 TimeoutError events when
 * GEXBot returned in 1–2 s during slow minutes. The cron's
 * maxDuration is 60 s so even a 32-way burst at 2.5 s each fits.
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
 * `_zero` = 0DTE only; `_one` = next-expiry+1 (the "1DTE+" bucket).
 * Skipped: the bare `{gamma,delta,vanna,charm}` (all-DTE) variants
 * — derivable as `_zero + _one` and not worth the extra calls.
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
 * 0DTE (`gex_zero`), 1DTE+ (`gex_one`), and full-DTE (`gex_full`).
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
 * Internal: build the GEXBot bearer header value.
 *
 * Token format is `gexbot_custom_<secret>`. We accept either form
 * from the env var (with or without the prefix) so a copy-paste of
 * the full token from the GEXBot dashboard still works.
 */
function buildAuthHeader(apiKey: string): string {
  const token = apiKey.startsWith(TOKEN_PREFIX)
    ? apiKey
    : `${TOKEN_PREFIX}${apiKey}`;
  return `Bearer ${token}`;
}

/**
 * Issue a single authenticated GEXBot request. Throws on non-2xx,
 * timeout, or network failure. The thrown error message includes
 * HTTP status when available, so caller logs/Sentry can distinguish
 * 401 (bad token) vs 429 (rate limit) vs network errors.
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
    throw new Error(`GEXBot ${res.status} ${path}: ${text.slice(0, 200)}`);
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
 * gammas) plus spot/ticker/timestamp.
 *
 * NOTE: the OpenAPI `orderflow_response` schema *lists* zero_gamma,
 * sum_gex_*, major_*, delta_risk_reversal, and min_dte/sec_min_dte, but the
 * LIVE payload omits all of them (verified 2026-05-29 — spec-vs-live drift).
 * Those fields are sourced from `fetchClassicBasic` instead. See
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
 * bucket: zero_gamma (gamma-flip price), sum_gex_vol/oi, major_pos/neg_vol/oi,
 * delta_risk_reversal, min_dte/sec_min_dte, plus a strikes[] GEX profile.
 *
 * This is the live home of the 10 aggregate fields the /orderflow payload
 * drops. We poll `gex_zero` (0DTE) and merge them into the orderflow
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
 * one DTE bucket. The response shape matches `basic_response` but
 * `strikes[]` values are the requested Greek (gamma/delta/vanna/charm)
 * rather than GEX.
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
