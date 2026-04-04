// @vitest-environment node

/**
 * Tests for sentry.ts metrics helpers.
 *
 * The file exports a `metrics` object with helper functions that wrap
 * Sentry.metrics calls. We mock @sentry/node to verify the correct
 * metrics are emitted with the right attributes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs before vi.mock hoisting — safe to reference in factory
const { mockInit, mockMetrics } = vi.hoisted(() => ({
  mockInit: vi.fn(),
  mockMetrics: {
    count: vi.fn(),
    distribution: vi.fn(),
  },
}));

vi.mock('@sentry/node', () => ({
  init: mockInit,
  metrics: mockMetrics,
}));

import { metrics } from '../_lib/sentry.js';

// =============================================================
// Sentry.init
// =============================================================

describe('Sentry.init', () => {
  it('was called on module load', () => {
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit).toHaveBeenCalledWith(
      expect.objectContaining({
        tracesSampleRate: expect.any(Number),
      }),
    );
  });
});

// =============================================================
// metrics.request
// =============================================================

describe('metrics.request', () => {
  beforeEach(() => {
    mockMetrics.count.mockClear();
    mockMetrics.distribution.mockClear();
  });

  it('emits a count on creation', () => {
    metrics.request('/api/quotes');

    expect(mockMetrics.count).toHaveBeenCalledWith('api.request', 1, {
      attributes: { route: '/api/quotes' },
    });
  });

  it('emits duration on end', () => {
    const done = metrics.request('/api/analyze');
    done({ status: 200 });

    expect(mockMetrics.distribution).toHaveBeenCalledWith(
      'api.duration_ms',
      expect.any(Number),
      { attributes: { route: '/api/analyze', status: '200' } },
    );
  });

  it('emits error count for 4xx/5xx status', () => {
    const done = metrics.request('/api/quotes');
    done({ status: 500, error: 'Internal' });

    expect(mockMetrics.count).toHaveBeenCalledWith('api.error', 1, {
      attributes: expect.objectContaining({
        route: '/api/quotes',
        status: '500',
        error: 'Internal',
      }),
    });
  });

  it('does not emit error count for 2xx status', () => {
    const done = metrics.request('/api/quotes');
    done({ status: 200 });

    // count called for api.request, but NOT for api.error
    const errorCalls = mockMetrics.count.mock.calls.filter(
      (c) => c[0] === 'api.error',
    );
    expect(errorCalls).toHaveLength(0);
  });

  it('handles end call with no args', () => {
    const done = metrics.request('/api/test');
    done();

    expect(mockMetrics.distribution).toHaveBeenCalledWith(
      'api.duration_ms',
      expect.any(Number),
      { attributes: { route: '/api/test' } },
    );
  });
});

// =============================================================
// metrics.schwabCall
// =============================================================

describe('metrics.schwabCall', () => {
  beforeEach(() => {
    mockMetrics.count.mockClear();
    mockMetrics.distribution.mockClear();
  });

  it('emits duration for successful call', () => {
    const done = metrics.schwabCall('/chains');
    done(true);

    expect(mockMetrics.distribution).toHaveBeenCalledWith(
      'schwab.duration_ms',
      expect.any(Number),
      { attributes: { endpoint: '/chains', ok: 'true' } },
    );
  });

  it('emits error count for failed call', () => {
    const done = metrics.schwabCall('/chains');
    done(false);

    expect(mockMetrics.count).toHaveBeenCalledWith('schwab.error', 1, {
      attributes: { endpoint: '/chains', ok: 'false' },
    });
  });

  it('does not emit error count for successful call', () => {
    const done = metrics.schwabCall('/quotes');
    done(true);

    const errorCalls = mockMetrics.count.mock.calls.filter(
      (c) => c[0] === 'schwab.error',
    );
    expect(errorCalls).toHaveLength(0);
  });
});

// =============================================================
// metrics.rateLimited
// =============================================================

describe('metrics.rateLimited', () => {
  beforeEach(() => {
    mockMetrics.count.mockClear();
  });

  it('emits rate limit counter', () => {
    metrics.rateLimited('/api/analyze');

    expect(mockMetrics.count).toHaveBeenCalledWith('api.rate_limited', 1, {
      attributes: { route: '/api/analyze' },
    });
  });
});

// =============================================================
// metrics.tokenRefresh
// =============================================================

describe('metrics.tokenRefresh', () => {
  beforeEach(() => {
    mockMetrics.count.mockClear();
  });

  it('tracks successful token refresh', () => {
    metrics.tokenRefresh(true);

    expect(mockMetrics.count).toHaveBeenCalledWith('schwab.token_refresh', 1, {
      attributes: { success: 'true' },
    });
  });

  it('tracks failed token refresh', () => {
    metrics.tokenRefresh(false);

    expect(mockMetrics.count).toHaveBeenCalledWith('schwab.token_refresh', 1, {
      attributes: { success: 'false' },
    });
  });
});

// =============================================================
// metrics.analyzeCall
// =============================================================

describe('metrics.analyzeCall', () => {
  beforeEach(() => {
    mockMetrics.count.mockClear();
    mockMetrics.distribution.mockClear();
  });

  it('emits duration, request count, and image count', () => {
    metrics.analyzeCall({
      model: 'claude-sonnet-4-20250514',
      mode: 'entry',
      durationMs: 12345,
      imageCount: 3,
    });

    expect(mockMetrics.distribution).toHaveBeenCalledWith(
      'analyze.duration_ms',
      12345,
      { attributes: { model: 'claude-sonnet-4-20250514', mode: 'entry' } },
    );
    expect(mockMetrics.count).toHaveBeenCalledWith('analyze.request', 1, {
      attributes: { model: 'claude-sonnet-4-20250514', mode: 'entry' },
    });
    expect(mockMetrics.distribution).toHaveBeenCalledWith(
      'analyze.image_count',
      3,
      { attributes: { model: 'claude-sonnet-4-20250514', mode: 'entry' } },
    );
  });
});

// =============================================================
// metrics.dbSave
// =============================================================

describe('metrics.dbSave', () => {
  beforeEach(() => {
    mockMetrics.count.mockClear();
  });

  it('tracks successful DB save', () => {
    metrics.dbSave('market_snapshots', true);

    expect(mockMetrics.count).toHaveBeenCalledWith('db.save', 1, {
      attributes: { table: 'market_snapshots', success: 'true' },
    });
  });

  it('tracks failed DB save', () => {
    metrics.dbSave('analyses', false);

    expect(mockMetrics.count).toHaveBeenCalledWith('db.save', 1, {
      attributes: { table: 'analyses', success: 'false' },
    });
  });
});

// =============================================================
// metrics.cacheResult
// =============================================================

describe('metrics.cacheResult', () => {
  beforeEach(() => {
    mockMetrics.count.mockClear();
  });

  it('tracks cache hit', () => {
    metrics.cacheResult('/api/quotes', true);

    expect(mockMetrics.count).toHaveBeenCalledWith('cache.result', 1, {
      attributes: { route: '/api/quotes', hit: 'true' },
    });
  });

  it('tracks cache miss', () => {
    metrics.cacheResult('/api/analyze', false);

    expect(mockMetrics.count).toHaveBeenCalledWith('cache.result', 1, {
      attributes: { route: '/api/analyze', hit: 'false' },
    });
  });
});

// =============================================================
// metrics.increment
// =============================================================

describe('metrics.increment', () => {
  beforeEach(() => {
    mockMetrics.count.mockClear();
  });

  it('increments a named counter', () => {
    metrics.increment('custom.counter');

    expect(mockMetrics.count).toHaveBeenCalledWith('custom.counter', 1);
  });
});
