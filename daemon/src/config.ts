/**
 * Environment configuration for the TRACE Live capture daemon.
 *
 * Validates required env vars at startup so a misconfigured deploy fails
 * fast (process.exit(1)) rather than running for hours producing nothing.
 *
 * Local dev: load from `.env` via tsx's `--env-file=.env` flag (or run
 *   `node --env-file=.env --import tsx src/index.ts`).
 * Railway: env vars set in the service dashboard.
 */

// Required env vars (loaded explicitly below):
//   BROWSERLESS_TOKEN          — Authorization header for chromium.connect()
//   TRACE_EMAIL / TRACE_PASSWORD — SpotGamma login; seeds 7-day persisted cookies
//   TRACE_LIVE_ANALYZE_ENDPOINT — e.g. https://theta-options.com/api/trace-live-analyze
//   OWNER_SECRET               — owner cookie value used to authenticate the POST
//   DATABASE_URL               — Neon connection (daemon queries gex_strike_0dte)
//
// Optional env vars:
//   SENTRY_DSN                 — error capture
//   LOG_LEVEL                  — pino level, default 'info'
//   CADENCE_SECONDS            — override 5-min default (testing only; ≥10s)
//   BYPASS_MARKET_HOURS_GATE   — '1' to fire regardless of weekday/holiday/window

type RequiredKey =
  | 'BROWSERLESS_TOKEN'
  | 'TRACE_EMAIL'
  | 'TRACE_PASSWORD'
  | 'TRACE_LIVE_ANALYZE_ENDPOINT'
  | 'OWNER_SECRET'
  | 'DATABASE_URL';

type OptionalKey =
  | 'SENTRY_DSN'
  | 'LOG_LEVEL'
  | 'CADENCE_SECONDS'
  | 'BYPASS_MARKET_HOURS_GATE';

export interface DaemonConfig {
  browserlessToken: string;
  traceEmail: string;
  tracePassword: string;
  endpoint: string;
  ownerSecret: string;
  databaseUrl: string;
  sentryDsn: string | null;
  logLevel: string;
  cadenceMs: number;
  bypassMarketHoursGate: boolean;
}

function requireEnv(key: RequiredKey): string {
  const v = process.env[key];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
}

function optionalEnv(key: OptionalKey): string | null {
  const v = process.env[key];
  return v && v.trim() !== '' ? v : null;
}

export function loadConfig(): DaemonConfig {
  const cadenceSecondsRaw = optionalEnv('CADENCE_SECONDS');
  const cadenceSeconds = cadenceSecondsRaw
    ? Number.parseInt(cadenceSecondsRaw, 10)
    : 5 * 60;
  if (!Number.isFinite(cadenceSeconds) || cadenceSeconds < 10) {
    throw new Error(
      `CADENCE_SECONDS must be a positive integer ≥10 (got ${cadenceSecondsRaw}). The 5-min default is 300; lower values blow through the browserless 20k-units-per-month budget on the Prototyping tier.`,
    );
  }

  return {
    browserlessToken: requireEnv('BROWSERLESS_TOKEN'),
    traceEmail: requireEnv('TRACE_EMAIL'),
    tracePassword: requireEnv('TRACE_PASSWORD'),
    endpoint: requireEnv('TRACE_LIVE_ANALYZE_ENDPOINT'),
    ownerSecret: requireEnv('OWNER_SECRET'),
    databaseUrl: requireEnv('DATABASE_URL'),
    sentryDsn: optionalEnv('SENTRY_DSN'),
    logLevel: optionalEnv('LOG_LEVEL') ?? 'info',
    cadenceMs: cadenceSeconds * 1000,
    bypassMarketHoursGate: optionalEnv('BYPASS_MARKET_HOURS_GATE') === '1',
  };
}
