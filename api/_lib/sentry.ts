/**
 * Sentry initialization and metrics helpers for Vercel serverless API routes.
 *
 * Import this module at the top of every API handler to ensure
 * Sentry is initialized before any other code runs.
 */

import * as Sentry from '@sentry/node';
import { optionalEnv } from './env.js';

Sentry.init({
  dsn: optionalEnv('SENTRY_DSN'),
  environment: process.env.VERCEL_ENV ?? 'development',
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.25 : 1,
  enabled: process.env.VERCEL_ENV === 'production',
  beforeSend(event) {
    // Strip Authorization / Cookie / api-key / cron-secret headers
    if (event.request?.headers) {
      for (const key of Object.keys(event.request.headers)) {
        if (/^(authorization|cookie|x-api-key|x-cron-secret)$/i.test(key)) {
          event.request.headers[key] = '[Filtered]';
        }
      }
    }
    // Strip secret-named keys from extra / tags context
    const scrubObject = (obj: Record<string, unknown> | undefined) => {
      if (!obj) return;
      for (const key of Object.keys(obj)) {
        if (/(secret|token|api[_-]?key|password|auth)/i.test(key)) {
          obj[key] = '[Filtered]';
        }
      }
    };
    scrubObject(event.extra);
    scrubObject(event.tags as Record<string, unknown> | undefined);
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

/** Increment a named counter by 1. */
function increment(name: string) {
  Sentry.metrics.count(name, 1);
}

export const metrics = {
  request,
  schwabCall,
  rateLimited,
  uwRateLimit,
  tokenRefresh,
  analyzeCall,
  dbSave,
  cacheResult,
  increment,
};

export { Sentry }; // NOSONAR: can't use re-export, Sentry.init() must run first
