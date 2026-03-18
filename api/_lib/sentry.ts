/**
 * Sentry initialization for Vercel serverless API routes.
 *
 * Import this module at the top of every API handler to ensure
 * Sentry is initialized before any other code runs.
 */

import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.VERCEL_ENV ?? 'development',
  tracesSampleRate: 1.0,
  enabled: process.env.VERCEL_ENV === 'production',
});

export { Sentry }; // NOSONAR: can't use re-export, Sentry.init() must run first
