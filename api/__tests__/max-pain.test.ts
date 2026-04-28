// @vitest-environment node

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { fetchMaxPain, formatMaxPainForClaude } from '../_lib/max-pain.js';
import type { MaxPainEntry } from '../_lib/max-pain.js';
import logger from '../_lib/logger.js';

const API_KEY = 'test-key';

function stubFetch(data: MaxPainEntry[], date = '2026-03-24') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data, date }),
    }),
  );
}

function stubFetchError(status = 500, body = 'Internal Server Error') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      text: async () => body,
    }),
  );
}

// ── fetchMaxPain ─────────────────────────────────────────────

describe('fetchMaxPain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns entries on success', async () => {
    const entries: MaxPainEntry[] = [
      { expiry: '2026-03-24', max_pain: '5700' },
      { expiry: '2026-03-26', max_pain: '5720' },
    ];
    stubFetch(entries);

    const result = await fetchMaxPain(API_KEY);

    expect(result).toEqual({ kind: 'ok', data: entries });
    expect(fetch).toHaveBeenCalledOnce();
    const calledUrl = vi.mocked(fetch).mock.calls[0]![0] as string;
    expect(calledUrl).toContain('/stock/SPX/max-pain');
    expect(calledUrl).not.toContain('?');
  });

  it('appends date query param when provided', async () => {
    stubFetch([]);

    await fetchMaxPain(API_KEY, '2026-03-24');

    const calledUrl = vi.mocked(fetch).mock.calls[0]![0] as string;
    expect(calledUrl).toContain('?date=2026-03-24');
  });

  it('sends Authorization header', async () => {
    stubFetch([]);

    await fetchMaxPain(API_KEY);

    const opts = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(opts.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
    });
  });

  it('returns error outcome on non-OK response', async () => {
    stubFetchError(403, 'Forbidden');

    const result = await fetchMaxPain(API_KEY);

    expect(result).toEqual({ kind: 'error', reason: 'HTTP 403' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 403 }),
      expect.stringContaining('non-OK'),
    );
  });

  it('returns error outcome on network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network fail')),
    );

    const result = await fetchMaxPain(API_KEY);

    expect(result).toEqual({ kind: 'error', reason: 'network fail' });
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('returns empty outcome when body.data is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ date: '2026-03-24' }),
      }),
    );

    const result = await fetchMaxPain(API_KEY);

    expect(result).toEqual({ kind: 'empty' });
  });
});

// ── formatMaxPainForClaude ───────────────────────────────────

describe('formatMaxPainForClaude', () => {
  const DATE = '2026-03-24';

  const baseEntries: MaxPainEntry[] = [
    { expiry: '2026-03-24', max_pain: '5700' },
    { expiry: '2026-03-26', max_pain: '5720' },
    { expiry: '2026-03-28', max_pain: '5750' },
    { expiry: '2026-03-31', max_pain: '5780' },
    { expiry: '2026-04-02', max_pain: '5800' },
  ];

  it('returns null for empty entries', () => {
    expect(formatMaxPainForClaude([], DATE)).toBeNull();
  });

  it('falls back to nearest monthly when no 0DTE entry matches analysisDate', () => {
    const entries = [{ expiry: '2026-03-26', max_pain: '5720' }];
    const result = formatMaxPainForClaude(entries, DATE);
    // Now falls back to nearest monthly instead of returning null
    expect(result).toContain('Max Pain (nearest monthly (2026-03-26)): 5720');
  });

  it('returns null when max_pain is not a valid number', () => {
    const entries = [{ expiry: '2026-03-24', max_pain: 'N/A' }];
    expect(formatMaxPainForClaude(entries, DATE)).toBeNull();
  });

  it('shows 0DTE max pain without SPX context', () => {
    const entries = [{ expiry: '2026-03-24', max_pain: '5700' }];
    const result = formatMaxPainForClaude(entries, DATE);

    expect(result).toContain('Max Pain (0DTE): 5700');
    expect(result).not.toContain('SPX at');
  });

  it('shows "AT max pain" when within 10 pts', () => {
    const entries = [{ expiry: '2026-03-24', max_pain: '5700' }];
    const result = formatMaxPainForClaude(entries, DATE, 5705);

    expect(result).toContain('5 pts above');
    expect(result).toContain('Price AT max pain');
  });

  it('shows "moderately above" when 11-30 pts above', () => {
    const entries = [{ expiry: '2026-03-24', max_pain: '5700' }];
    const result = formatMaxPainForClaude(entries, DATE, 5720);

    expect(result).toContain('20 pts above');
    expect(result).toContain('moderately above');
    expect(result).toContain('gravitational pull');
  });

  it('shows "moderately below" when 11-30 pts below', () => {
    const entries = [{ expiry: '2026-03-24', max_pain: '5700' }];
    const result = formatMaxPainForClaude(entries, DATE, 5680);

    expect(result).toContain('20 pts below');
    expect(result).toContain('moderately below');
  });

  it('shows "far above" when >30 pts away', () => {
    const entries = [{ expiry: '2026-03-24', max_pain: '5700' }];
    const result = formatMaxPainForClaude(entries, DATE, 5760);

    expect(result).toContain('60 pts above');
    expect(result).toContain('far above');
    expect(result).toContain('Gamma walls');
  });

  it('shows at most 3 upcoming expirations', () => {
    const result = formatMaxPainForClaude(baseEntries, DATE, 5710);

    expect(result).toContain('Upcoming expirations:');
    expect(result).toContain('2026-03-26: 5720');
    expect(result).toContain('2026-03-28: 5750');
    expect(result).toContain('2026-03-31: 5780');
    // 4th upcoming should be excluded
    expect(result).not.toContain('2026-04-02');
  });

  it('includes distance for upcoming expirations when SPX provided', () => {
    const result = formatMaxPainForClaude(baseEntries, DATE, 5710);

    expect(result).toContain('2026-03-26: 5720 (10 pts below)');
  });

  it('omits distance for upcoming expirations when no SPX', () => {
    const result = formatMaxPainForClaude(baseEntries, DATE);

    expect(result).toContain('2026-03-26: 5720');
    expect(result).not.toContain('pts');
  });

  it('skips upcoming entries with invalid max_pain', () => {
    const entries: MaxPainEntry[] = [
      { expiry: '2026-03-24', max_pain: '5700' },
      { expiry: '2026-03-26', max_pain: 'bad' },
      { expiry: '2026-03-28', max_pain: '5750' },
    ];
    const result = formatMaxPainForClaude(entries, DATE, 5710);

    expect(result).not.toContain('2026-03-26');
    expect(result).toContain('2026-03-28: 5750');
  });
});
