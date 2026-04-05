/**
 * Centralized environment variable validation and typed access.
 *
 * This module provides a Zod-validated, typed interface to process.env
 * for the API serverless functions. It does NOT validate at import time
 * (serverless functions only need a subset of vars per invocation).
 *
 * Usage patterns:
 *
 *   // Get an env var that must exist — throws with a clear error
 *   const apiKey = requireEnv('ANTHROPIC_API_KEY');
 *
 *   // Get an env var that may be absent — returns undefined
 *   const fredKey = optionalEnv('FRED_API_KEY');
 *
 *   // Validate a group of related vars at once
 *   const schwab = requireEnvGroup('schwab');
 *   //    ^? { clientId: string; clientSecret: string }
 *
 * Gradual migration: existing `process.env.X` reads continue to work.
 * New code should prefer these helpers for better error messages and
 * type safety.
 */

import { z } from 'zod';

// ============================================================
// SCHEMAS — grouped by feature domain
// ============================================================

/** Core infrastructure: database and cache. */
const coreSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  KV_REST_API_URL: z.string().min(1).optional(),
  KV_REST_API_TOKEN: z.string().min(1).optional(),
  UPSTASH_REDIS_REST_URL: z.string().min(1).optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
});

/** Auth and security: owner gating, cron auth, Schwab OAuth. */
const authSchema = z.object({
  OWNER_SECRET: z.string().min(1).optional(),
  CRON_SECRET: z.string().min(1).optional(),
  SCHWAB_CLIENT_ID: z.string().min(1).optional(),
  SCHWAB_CLIENT_SECRET: z.string().min(1).optional(),
});

/** Third-party API keys for data and analysis. */
const apiKeysSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  UW_API_KEY: z.string().min(1).optional(),
  FRED_API_KEY: z.string().min(1).optional(),
  FINNHUB_API_KEY: z.string().min(1).optional(),
});

/** Twilio SMS alerting (all four must be present to send). */
const twilioSchema = z.object({
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_PHONE_FROM: z.string().min(1).optional(),
  ALERT_PHONE_TO: z.string().min(1).optional(),
});

/** Observability: Sentry, logging. */
const observabilitySchema = z.object({
  SENTRY_DSN: z.string().min(1).optional(),
  SENTRY_AUTH_TOKEN: z.string().min(1).optional(),
  LOG_LEVEL: z.string().min(1).optional(),
});

/** Vercel runtime vars (auto-set by platform, read-only). */
const vercelSchema = z.object({
  VERCEL: z.string().optional(),
  VERCEL_ENV: z.enum(['production', 'preview', 'development']).optional(),
  NODE_ENV: z.enum(['production', 'development', 'test']).optional(),
  APP_URL: z.string().url().optional(),
});

/** Combined schema: union of all groups. */
const envSchema = coreSchema
  .merge(authSchema)
  .merge(apiKeysSchema)
  .merge(twilioSchema)
  .merge(observabilitySchema)
  .merge(vercelSchema);

/** All known env var names, derived from the schema. */
export type EnvKey = keyof z.infer<typeof envSchema>;

// ============================================================
// LAZY SINGLETON — validated env object
// ============================================================

let _validated: z.infer<typeof envSchema> | null = null;

/**
 * Parse and validate process.env against the combined schema.
 * Cached after first call. Uses safeParse so empty strings
 * (common in CI) don't crash the module — they're treated as
 * missing. Strips unknown keys and coerces known ones.
 */
function getValidatedEnv(): z.infer<typeof envSchema> {
  if (!_validated) {
    // Strip empty strings before parsing — some CI/deploy systems
    // set unset vars to '' rather than leaving them undefined.
    const cleaned: Record<string, string | undefined> = {};
    for (const key of Object.keys(envSchema.shape)) {
      const val = process.env[key];
      cleaned[key] = val === '' ? undefined : val;
    }
    _validated = envSchema.parse(cleaned);
  }
  return _validated;
}

/** Reset the cache. Exported for tests only. */
export function _resetEnvCache(): void {
  _validated = null;
}

// ============================================================
// PUBLIC API — typed accessors
// ============================================================

/**
 * Get a required environment variable. Throws a descriptive error
 * if the variable is missing or empty, making misconfiguration
 * obvious in Vercel function logs.
 *
 * Use this at the point where the variable is actually needed,
 * not at module load time.
 *
 * @example
 *   const key = requireEnv('ANTHROPIC_API_KEY');
 */
export function requireEnv(key: EnvKey): string {
  const env = getValidatedEnv();
  const value = env[key];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${key}. ` +
        'Check Vercel project settings or .env.local.',
    );
  }
  return value;
}

/**
 * Get an optional environment variable. Returns undefined if
 * the variable is not set, never throws.
 *
 * @example
 *   const key = optionalEnv('FINNHUB_API_KEY');
 *   if (key) { ... }
 */
export function optionalEnv(key: EnvKey): string | undefined {
  const env = getValidatedEnv();
  return env[key] ?? undefined;
}

// ============================================================
// GROUPED ACCESSORS — validate related vars together
// ============================================================

/** Typed groups returned by requireEnvGroup(). */
interface EnvGroups {
  schwab: { clientId: string; clientSecret: string };
  redis: { url: string; token: string };
  twilio: {
    accountSid: string;
    authToken: string;
    phoneFrom: string;
    phoneTo: string;
  };
}

/**
 * Validate and return a group of related environment variables.
 * Throws a single descriptive error listing all missing vars in
 * the group, rather than failing one-by-one.
 *
 * @example
 *   const { clientId, clientSecret } = requireEnvGroup('schwab');
 */
export function requireEnvGroup<K extends keyof EnvGroups>(
  group: K,
): EnvGroups[K] {
  const env = getValidatedEnv();
  const missing: string[] = [];

  switch (group) {
    case 'schwab': {
      const clientId = env.SCHWAB_CLIENT_ID;
      const clientSecret = env.SCHWAB_CLIENT_SECRET;
      if (!clientId) missing.push('SCHWAB_CLIENT_ID');
      if (!clientSecret) missing.push('SCHWAB_CLIENT_SECRET');
      if (missing.length) throwGroupError(group, missing);
      return {
        clientId: clientId!,
        clientSecret: clientSecret!,
      } as EnvGroups[K];
    }
    case 'redis': {
      const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
      const token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
      if (!url) missing.push('KV_REST_API_URL / UPSTASH_REDIS_REST_URL');
      if (!token) missing.push('KV_REST_API_TOKEN / UPSTASH_REDIS_REST_TOKEN');
      if (missing.length) throwGroupError(group, missing);
      return { url: url!, token: token! } as EnvGroups[K];
    }
    case 'twilio': {
      const accountSid = env.TWILIO_ACCOUNT_SID;
      const authToken = env.TWILIO_AUTH_TOKEN;
      const phoneFrom = env.TWILIO_PHONE_FROM;
      const phoneTo = env.ALERT_PHONE_TO;
      if (!accountSid) missing.push('TWILIO_ACCOUNT_SID');
      if (!authToken) missing.push('TWILIO_AUTH_TOKEN');
      if (!phoneFrom) missing.push('TWILIO_PHONE_FROM');
      if (!phoneTo) missing.push('ALERT_PHONE_TO');
      if (missing.length) throwGroupError(group, missing);
      return {
        accountSid: accountSid!,
        authToken: authToken!,
        phoneFrom: phoneFrom!,
        phoneTo: phoneTo!,
      } as EnvGroups[K];
    }
    default: {
      const _exhaustive: never = group;
      throw new Error(`Unknown env group: ${_exhaustive}`);
    }
  }
}

function throwGroupError(group: string, missing: string[]): never {
  throw new Error(
    `Missing environment variables for "${group}": ${missing.join(', ')}. ` +
      'Check Vercel project settings or .env.local.',
  );
}
