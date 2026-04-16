/**
 * Structured JSON logger for API routes.
 *
 * Uses pino for structured output that Vercel function logs can
 * parse and filter. In local dev, set LOG_LEVEL=debug for verbose output.
 */

import pino from 'pino';
import { optionalEnv } from './env.js';

const logger = pino({
  level: optionalEnv('LOG_LEVEL') ?? 'info',
  // Vercel captures stdout as structured logs — no transport needed
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Omit hostname/pid in serverless (not meaningful)
  base: null,
});

export default logger;
