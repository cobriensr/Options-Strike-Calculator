import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  requireEnv,
  optionalEnv,
  requireEnvGroup,
  _resetEnvCache,
} from '../_lib/env.js';

beforeEach(() => {
  _resetEnvCache();
  vi.unstubAllEnvs();
});

// ── requireEnv ────────────────────────────────────────────────

describe('requireEnv', () => {
  it('returns the value when the env var is set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-123');
    expect(requireEnv('ANTHROPIC_API_KEY')).toBe('sk-test-123');
  });

  it('throws when the env var is missing', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(() => requireEnv('ANTHROPIC_API_KEY')).toThrow(
      'Missing required environment variable: ANTHROPIC_API_KEY',
    );
  });

  it('throws when the env var is undefined', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => requireEnv('ANTHROPIC_API_KEY')).toThrow(
      'Missing required environment variable: ANTHROPIC_API_KEY',
    );
  });

  it('caches the validated env on first call', () => {
    vi.stubEnv('UW_API_KEY', 'first');
    expect(requireEnv('UW_API_KEY')).toBe('first');

    // Changing the env var after first parse doesn't affect cached result
    vi.stubEnv('UW_API_KEY', 'second');
    expect(requireEnv('UW_API_KEY')).toBe('first');
  });

  it('returns fresh value after cache reset', () => {
    vi.stubEnv('UW_API_KEY', 'first');
    expect(requireEnv('UW_API_KEY')).toBe('first');

    _resetEnvCache();
    vi.stubEnv('UW_API_KEY', 'second');
    expect(requireEnv('UW_API_KEY')).toBe('second');
  });
});

// ── optionalEnv ───────────────────────────────────────────────

describe('optionalEnv', () => {
  it('returns the value when set', () => {
    vi.stubEnv('FRED_API_KEY', 'fred-123');
    expect(optionalEnv('FRED_API_KEY')).toBe('fred-123');
  });

  it('returns undefined when not set', () => {
    delete process.env.FRED_API_KEY;
    expect(optionalEnv('FRED_API_KEY')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    vi.stubEnv('FRED_API_KEY', '');
    // Zod min(1) rejects empty strings, so parse drops it
    expect(optionalEnv('FRED_API_KEY')).toBeUndefined();
  });
});

// ── requireEnvGroup ───────────────────────────────────────────

describe('requireEnvGroup', () => {
  describe('schwab', () => {
    it('returns both values when set', () => {
      vi.stubEnv('SCHWAB_CLIENT_ID', 'client-id');
      vi.stubEnv('SCHWAB_CLIENT_SECRET', 'client-secret');
      const result = requireEnvGroup('schwab');
      expect(result).toEqual({
        clientId: 'client-id',
        clientSecret: 'client-secret',
      });
    });

    it('throws listing all missing vars', () => {
      delete process.env.SCHWAB_CLIENT_ID;
      delete process.env.SCHWAB_CLIENT_SECRET;
      expect(() => requireEnvGroup('schwab')).toThrow(
        'SCHWAB_CLIENT_ID, SCHWAB_CLIENT_SECRET',
      );
    });

    it('throws listing only the missing var', () => {
      vi.stubEnv('SCHWAB_CLIENT_ID', 'id');
      delete process.env.SCHWAB_CLIENT_SECRET;
      expect(() => requireEnvGroup('schwab')).toThrow('SCHWAB_CLIENT_SECRET');
    });
  });

  describe('redis', () => {
    it('prefers KV_REST_API_URL over UPSTASH fallback', () => {
      vi.stubEnv('KV_REST_API_URL', 'kv-url');
      vi.stubEnv('KV_REST_API_TOKEN', 'kv-token');
      vi.stubEnv('UPSTASH_REDIS_REST_URL', 'upstash-url');
      const result = requireEnvGroup('redis');
      expect(result.url).toBe('kv-url');
      expect(result.token).toBe('kv-token');
    });

    it('falls back to UPSTASH vars when KV vars are missing', () => {
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
      vi.stubEnv('UPSTASH_REDIS_REST_URL', 'upstash-url');
      vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'upstash-token');
      const result = requireEnvGroup('redis');
      expect(result.url).toBe('upstash-url');
      expect(result.token).toBe('upstash-token');
    });

    it('throws when neither KV nor UPSTASH vars are set', () => {
      delete process.env.KV_REST_API_URL;
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.KV_REST_API_TOKEN;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      expect(() => requireEnvGroup('redis')).toThrow(
        'KV_REST_API_URL / UPSTASH_REDIS_REST_URL',
      );
    });
  });

  describe('twilio', () => {
    it('returns all four values when set', () => {
      vi.stubEnv('TWILIO_ACCOUNT_SID', 'sid');
      vi.stubEnv('TWILIO_AUTH_TOKEN', 'token');
      vi.stubEnv('TWILIO_PHONE_FROM', '+1111');
      vi.stubEnv('ALERT_PHONE_TO', '+2222');
      const result = requireEnvGroup('twilio');
      expect(result).toEqual({
        accountSid: 'sid',
        authToken: 'token',
        phoneFrom: '+1111',
        phoneTo: '+2222',
      });
    });

    it('throws listing all four when none are set', () => {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_PHONE_FROM;
      delete process.env.ALERT_PHONE_TO;
      expect(() => requireEnvGroup('twilio')).toThrow(
        'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_FROM, ALERT_PHONE_TO',
      );
    });
  });
});
