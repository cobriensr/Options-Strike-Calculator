/**
 * Sentry initialization and metrics helpers for Vercel serverless API routes.
 *
 * Import this module at the top of every API handler to ensure
 * Sentry is initialized before any other code runs.
 */

import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.VERCEL_ENV ?? 'development',
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.25 : 1.0,
  enabled: process.env.VERCEL_ENV === 'production',
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

export const metrics = {
  request,
  schwabCall,
  rateLimited,
  tokenRefresh,
  analyzeCall,
  dbSave,
  cacheResult,
};

export { Sentry }; // NOSONAR: can't use re-export, Sentry.init() must run first
