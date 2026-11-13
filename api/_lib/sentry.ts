/**
 * Sentry initialization and metrics helpers for Vercel serverless API routes.
 *
 * Import this module at the top of every API handler to ensure
 * Sentry is initialized before any other code runs.
 */

import * as Sentry from '@sentry/node';
import type { Event } from '@sentry/node';
import { optionalEnv } from './env.js';

const FILTERED = '[Filtered]';

// Matches every key: used to filter all values of a bag.
const EVERY_KEY = /^/;

// Request header names that carry credentials: the four standard credential
// headers by exact name, and any other header whose name contains an api key,
// secret or token word (`x-internal-notify-secret`, `x-csrf-token`, ...).
const CREDENTIAL_HEADER =
  /^(?:authorization|proxy[-_]authorization|cookie|set[-_]cookie)$|api[-_]?key|secret|token/i;

// Secret-named keys in `extra` / `tags`.
const SECRET_NAMED_KEY = /(secret|token|api[_-]?key|password|auth)/i;

// Span attributes the SDK derives from request and response headers:
// `http.request.header.<name>` and `http.response.header.<name>`, with `-` or
// `_` in the name, plus one `...cookie.<cookie-name>` attribute per cookie.
// Capture group 1 is the header name, tested with CREDENTIAL_HEADER; keys
// outside the header namespace are never matched, so an attribute elsewhere
// that merely contains `token` or `secret` is untouched.
const HEADER_SPAN_ATTRIBUTE = /^http\.(?:request|response)\.header\.([^.]*)/i;

// The request body the SDK copies onto the root span.
const BODY_SPAN_ATTRIBUTE = /^http\.request\.body\.data$/i;

// Query parameter names that carry credentials. `token`, `secret`, `password`
// and the api-key spellings match anywhere in the name; `key` alone matches
// only as a whole word (`key`, `access_key`, `x-key`), so `monkey` and
// `keyword` are kept.
const SECRET_QUERY_PARAM =
  /token|secret|password|api[-_]?key|(?:^|[-_.])key(?:$|[-_.])/i;

/**
 * Replace the value of every key in `bag` that `sensitiveKey` matches: a
 * pattern tested against the key, or a predicate on it.
 */
function filterKeys(
  bag: unknown,
  sensitiveKey: RegExp | ((key: string) => boolean),
): void {
  if (typeof bag !== 'object' || bag === null || Array.isArray(bag)) return;
  const record = bag as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const sensitive =
      typeof sensitiveKey === 'function'
        ? sensitiveKey(key)
        : sensitiveKey.test(key);
    if (sensitive) record[key] = FILTERED;
  }
}

/** True for a span attribute that holds a credential header or the request body. */
function isCredentialSpanAttribute(key: string): boolean {
  const headerName = HEADER_SPAN_ATTRIBUTE.exec(key)?.[1];
  if (headerName !== undefined) return CREDENTIAL_HEADER.test(headerName);
  return BODY_SPAN_ATTRIBUTE.test(key);
}

function decodeParamName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** True when a query parameter name (any case, or percent-encoded) is a credential. */
function isSecretQueryParam(rawName: string): boolean {
  // Split camelCase (`accessKey` -> `access_Key`) so `key` is a whole word.
  const name = decodeParamName(rawName).replaceAll(/([a-z])([A-Z])/g, '$1_$2');
  return SECRET_QUERY_PARAM.test(name);
}

/** Redact the value of every credential parameter in a query string. */
function redactQueryString(query: string): string {
  const prefix = query.startsWith('?') ? '?' : '';
  const pairs = query.slice(prefix.length).split('&');
  const redacted = pairs.map((pair) => {
    const equals = pair.indexOf('=');
    if (equals < 0) return pair;
    const name = pair.slice(0, equals);
    return isSecretQueryParam(name) ? `${name}=${FILTERED}` : pair;
  });
  return prefix + redacted.join('&');
}

/** Redact credential parameters in a URL or path, keeping the rest readable. */
function redactUrlQuery(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return url;
  const hashStart = url.indexOf('#', queryStart);
  const queryEnd = hashStart < 0 ? url.length : hashStart;
  return (
    url.slice(0, queryStart + 1) +
    redactQueryString(url.slice(queryStart + 1, queryEnd)) +
    url.slice(queryEnd)
  );
}

// URL-shaped fields, by span attribute or breadcrumb data key, and how to
// redact each. `url.query` is a bare query; `http.query` may keep its `?`.
const SPAN_URL_FIELDS: Record<string, (value: string) => string> = {
  'url.full': redactUrlQuery,
  'http.url': redactUrlQuery,
  'http.target': redactUrlQuery,
  'url.query': redactQueryString,
  'http.query': redactQueryString,
};
const BREADCRUMB_URL_FIELDS: Record<string, (value: string) => string> = {
  url: redactUrlQuery,
  'http.query': redactQueryString,
};

/** Redact the string values of the named URL-shaped fields of `bag`. */
function redactUrlFields(
  bag: unknown,
  fields: Record<string, (value: string) => string>,
): void {
  if (typeof bag !== 'object' || bag === null || Array.isArray(bag)) return;
  const record = bag as Record<string, unknown>;
  for (const [key, redact] of Object.entries(fields)) {
    const value = record[key];
    if (typeof value === 'string') record[key] = redact(value);
  }
}

/** Scrub credential attributes on one span (or a transaction's trace context). */
function scrubSpanData(span: { data?: unknown } | null | undefined): void {
  if (!span) return;
  filterKeys(span.data, isCredentialSpanAttribute);
  redactUrlFields(span.data, SPAN_URL_FIELDS);
}

/** Redact credential parameters in `request.query_string`, in any shape. */
function scrubQueryString(request: NonNullable<Event['request']>): void {
  const queryString = request.query_string;
  if (typeof queryString === 'string') {
    request.query_string = redactQueryString(queryString);
  } else if (Array.isArray(queryString)) {
    request.query_string = queryString.map((pair): [string, string] =>
      Array.isArray(pair) && isSecretQueryParam(String(pair[0]))
        ? [pair[0], FILTERED]
        : pair,
    );
  } else {
    filterKeys(queryString, isSecretQueryParam);
  }
}

/** Scrub credentials from the request, extra and tags of any event type. */
function scrubEvent(event: Event): void {
  const { request } = event;
  if (request) {
    filterKeys(request.headers, CREDENTIAL_HEADER);
    // The parsed `request.cookies` object is separate from the raw Cookie
    // header. Every value in it is filtered, whatever the cookie is called.
    filterKeys(request.cookies, EVERY_KEY);
    if (request.data != null) request.data = FILTERED;
    if (typeof request.url === 'string') {
      request.url = redactUrlQuery(request.url);
    }
    scrubQueryString(request);
  }
  filterKeys(event.extra, SECRET_NAMED_KEY);
  filterKeys(event.tags, SECRET_NAMED_KEY);
}

Sentry.init({
  dsn: optionalEnv('SENTRY_DSN'),
  environment: process.env.VERCEL_ENV ?? 'development',
  serverName: 'api',
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.25 : 1,
  enabled: process.env.VERCEL_ENV === 'production',
  // A request body can carry a credential, so the http integration does not
  // capture incoming bodies at all. scrubEvent still filters `request.data`
  // and the span body attribute in case another path attaches one.
  integrations: [
    Sentry.httpIntegration({ maxIncomingRequestBodySize: 'none' }),
  ],
  // The SDK runs beforeSendSpan on the root span and on every child span,
  // then beforeSendTransaction on the whole transaction. Scrub in all three
  // so every event type goes through the same filter.
  beforeSendSpan(span) {
    scrubSpanData(span);
    return span;
  },
  beforeSendTransaction(event) {
    scrubEvent(event);
    scrubSpanData(event.contexts?.trace);
    if (Array.isArray(event.spans)) {
      for (const span of event.spans) scrubSpanData(span);
    }
    return event;
  },
  // Breadcrumbs for outgoing calls record the URL and its query string.
  beforeBreadcrumb(breadcrumb) {
    redactUrlFields(breadcrumb.data, BREADCRUMB_URL_FIELDS);
    return breadcrumb;
  },
  beforeSend(event) {
    scrubEvent(event);

    // Collapse upstream UW 5xx errors into one Sentry issue per status
    // code. uwFetch() throws `Error("UW API <status>: <body>")` and the
    // upstream body text varies per failure ("upstream connect error",
    // "no healthy upstream", etc.), so the default fingerprint
    // (stacktrace + message) splits a single Cloudfront/Envoy event
    // into N distinct issues — DESERT-7V + DESERT-50 are the same UW
    // 503 episode in two groups. Pinning the fingerprint to
    // ['uw-api-5xx', '<status>'] keeps the issue count proportional to
    // the failure mode rather than to caller diversity. 4xx (auth /
    // rate limit) keep default fingerprinting — their bodies carry
    // semantic differences worth distinguishing.
    const uwMessage = event.exception?.values?.[0]?.value;
    if (typeof uwMessage === 'string') {
      const match = uwMessage.match(/^UW API (5\d\d):/);
      if (match?.[1]) {
        event.fingerprint = ['uw-api-5xx', match[1]];
      }
    }
    return event;
  },
});

// ============================================================
// METRICS HELPERS
// ============================================================

/**
 * Track an API request: increments a counter and records duration.
 * Call at the start of a handler, then call the returned `end()` when done.
 *
 * Usage:
 *   const done = metrics.request('/api/quotes');
 *   // ... handler logic ...
 *   done({ status: 200 });
 */
function request(route: string) {
  const start = Date.now();
  Sentry.metrics.count('api.request', 1, { attributes: { route } });

  return (opts?: { status?: number; error?: string }) => {
    const durationMs = Date.now() - start;
    const attributes: Record<string, string> = { route };
    if (opts?.status) attributes.status = String(opts.status);
    if (opts?.error) attributes.error = opts.error;

    Sentry.metrics.distribution('api.duration_ms', durationMs, { attributes });

    if (opts?.status && opts.status >= 400) {
      Sentry.metrics.count('api.error', 1, { attributes });
    }
  };
}

/** Track a Schwab API call (latency + errors). */
function schwabCall(endpoint: string) {
  const start = Date.now();
  return (ok: boolean) => {
    const durationMs = Date.now() - start;
    const attributes = { endpoint, ok: String(ok) };
    Sentry.metrics.distribution('schwab.duration_ms', durationMs, {
      attributes,
    });
    if (!ok) {
      Sentry.metrics.count('schwab.error', 1, { attributes });
    }
  };
}

/** Track a rate limit rejection. */
function rateLimited(route: string) {
  Sentry.metrics.count('api.rate_limited', 1, { attributes: { route } });
}

/**
 * Track an upstream Unusual Whales rate-limit (429) response. Emits
 * both a metric (time-series counter, grouped by endpoint) AND a
 * scoped warning message so the first one pages immediately instead
 * of waiting for someone to notice the counter climb.
 *
 * Called from uwFetch. Follow-up to BE-CRON-002 — we're currently at
 * ~8% of UW's 120/min budget, but if that ever drifts we want to see
 * it immediately rather than after the data silently thins out.
 */
function uwRateLimit(endpoint: string, retryAfter: string | null) {
  Sentry.metrics.count('uw.rate_limited', 1, { attributes: { endpoint } });
  Sentry.withScope((scope) => {
    scope.setTag('uw.endpoint', endpoint);
    scope.setLevel('warning');
    if (retryAfter) scope.setExtra('retry_after_s', retryAfter);
    Sentry.captureMessage(`UW 429 on ${endpoint}`);
  });
}

/**
 * Gauge UW's self-reported request budget, read from `x-uw-*` response
 * headers. UW publishes no usage endpoint — these headers on any 200 are
 * the only source of truth for the real limits, and they are what tells us
 * whether our own `UW_PER_MINUTE_CAP` guard is still sized sanely. Emitted
 * on a low sample (and always when the minute budget runs low) so a UW-side
 * limit change shows up as a step in the gauge instead of a silent surprise.
 */
function uwBudget(opts: {
  minuteRemaining: number | null;
  dailyLimit: number | null;
  dailyUsed: number | null;
}) {
  const { minuteRemaining, dailyLimit, dailyUsed } = opts;
  if (minuteRemaining !== null) {
    Sentry.metrics.gauge('uw.budget.minute_remaining', minuteRemaining);
  }
  if (dailyLimit !== null) {
    Sentry.metrics.gauge('uw.budget.daily_limit', dailyLimit);
  }
  if (dailyUsed !== null) {
    Sentry.metrics.gauge('uw.budget.daily_used', dailyUsed);
  }
  if (dailyLimit !== null && dailyUsed !== null && dailyLimit > 0) {
    Sentry.metrics.gauge(
      'uw.budget.daily_pct_used',
      (dailyUsed / dailyLimit) * 100,
    );
  }
}

/**
 * Distribution of UW requests observed in the current 60s window. The
 * limiter already pays for this INCR on every call; emitting it turns that
 * round-trip into the one signal we otherwise lack — actual per-minute UW
 * call volume — instead of discarding the count unless it trips the guard.
 */
function uwMinuteCount(count: number) {
  Sentry.metrics.distribution('uw.rate_limit.minute_count', count);
}

/** Track a Schwab token refresh failure. */
function tokenRefresh(success: boolean) {
  Sentry.metrics.count('schwab.token_refresh', 1, {
    attributes: { success: String(success) },
  });
}

/** Track an analyze request (expensive — Claude API call). */
function analyzeCall(opts: {
  model: string;
  mode: string;
  durationMs: number;
  imageCount: number;
}) {
  const attributes = { model: opts.model, mode: opts.mode };
  Sentry.metrics.distribution('analyze.duration_ms', opts.durationMs, {
    attributes,
  });
  Sentry.metrics.count('analyze.request', 1, { attributes });
  Sentry.metrics.distribution('analyze.image_count', opts.imageCount, {
    attributes,
  });
}

/** Track a DB save (snapshot, analysis, positions). */
function dbSave(table: string, success: boolean) {
  Sentry.metrics.count('db.save', 1, {
    attributes: { table, success: String(success) },
  });
}

/** Track a Redis cache hit/miss. */
function cacheResult(route: string, hit: boolean) {
  Sentry.metrics.count('cache.result', 1, {
    attributes: { route, hit: String(hit) },
  });
}

/**
 * Track an Anthropic prompt-cache hit/miss. Distinct from `cacheResult`
 * which is for Redis. Surfaces the 5-min TTL effectiveness across
 * analyze / periscope-chat / trace-live so dashboards can see when
 * request spacing is too wide for prompt caching to pay off.
 */
function anthropicCache(model: string, hit: boolean) {
  Sentry.metrics.count('anthropic.cache_result', 1, {
    attributes: { model, hit: String(hit) },
  });
}

/** Increment a named counter by 1. */
function increment(name: string) {
  Sentry.metrics.count(name, 1);
}

export const metrics = {
  request,
  schwabCall,
  rateLimited,
  uwRateLimit,
  uwBudget,
  uwMinuteCount,
  tokenRefresh,
  analyzeCall,
  dbSave,
  cacheResult,
  anthropicCache,
  increment,
};

export { Sentry }; // NOSONAR: can't use re-export, Sentry.init() must run first
