/**
 * Structured JSON logger for API routes.
 *
 * Uses pino for structured output that Vercel function logs can
 * parse and filter. In local dev, set LOG_LEVEL=debug for verbose output.
 */

import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Vercel captures stdout as structured logs — no transport needed
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Omit hostname/pid in serverless (not meaningful)
  base: undefined,
});

export default logger;
