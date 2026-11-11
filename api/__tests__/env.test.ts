import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  requireEnv,
  optionalEnv,
  requireEnvGroup,
  isRedisConfigured,
  _resetEnvCache,
} from '../_lib/env.js';

beforeEach(() => {
  _resetEnvCache();
  vi.unstubAllEnvs();
});

// ── GEXBOT_API_KEY ────────────────────────────────────────────

describe('GEXBOT_API_KEY', () => {
  it('is accepted when set', () => {
    vi.stubEnv('GEXBOT_API_KEY', 'gb-test');
    expect(requireEnv('GEXBOT_API_KEY')).toBe('gb-test');
  });

  it('is optional: optionalEnv returns undefined when absent', () => {
    vi.stubEnv('GEXBOT_API_KEY', undefined);
    expect(optionalEnv('GEXBOT_API_KEY')).toBeUndefined();
  });

  it('is rejected as empty by requireEnv', () => {
    vi.stubEnv('GEXBOT_API_KEY', '');
    expect(() => requireEnv('GEXBOT_API_KEY')).toThrow(
      'Missing required environment variable: GEXBOT_API_KEY',
    );
  });
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

// ── isRedisConfigured ─────────────────────────────────────────

describe('isRedisConfigured', () => {
  it.each([
    ['KV_REST_API_URL alone', 'https://kv.example', undefined, true],
    ['UPSTASH_REDIS_REST_URL alone', undefined, 'https://up.example', true],
    ['both', 'https://kv.example', 'https://up.example', true],
    ['neither', undefined, undefined, false],
    [
      'an empty KV_REST_API_URL and an UPSTASH url',
      '',
      'https://up.example',
      true,
    ],
    [
      'a KV url and an empty UPSTASH_REDIS_REST_URL',
      'https://kv.example',
      '',
      true,
    ],
    ['both empty', '', '', false],
  ])('with %s', (_label, kvUrl, upstashUrl, expected) => {
    vi.stubEnv('KV_REST_API_URL', kvUrl);
    vi.stubEnv('UPSTASH_REDIS_REST_URL', upstashUrl);

    expect(isRedisConfigured()).toBe(expected);
  });

  it('treats an empty KV url as unset, the way requireEnvGroup does', () => {
    vi.stubEnv('KV_REST_API_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://up.example');
    vi.stubEnv('KV_REST_API_TOKEN', 'kv-token');

    expect(isRedisConfigured()).toBe(true);
    expect(requireEnvGroup('redis').url).toBe('https://up.example');
  });

  it('reads process.env on every call, not the cached validated env', () => {
    vi.stubEnv('KV_REST_API_URL', undefined);
    vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined);
    // Warm the validated-env cache with no Redis URL in it.
    expect(optionalEnv('KV_REST_API_URL')).toBeUndefined();
    expect(isRedisConfigured()).toBe(false);

    vi.stubEnv('KV_REST_API_URL', 'https://kv.example');

    expect(isRedisConfigured()).toBe(true);
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
});
