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

// =============================================================
// beforeSend — UW 5xx fingerprint collapse + secret scrubbing
// =============================================================

describe('Sentry.init beforeSend', () => {
  // Extract the beforeSend hook from the mocked Sentry.init call.
  const initArgs = mockInit.mock.calls[0]?.[0] as
    | { beforeSend: (event: Record<string, unknown>) => unknown }
    | undefined;
  const beforeSend = initArgs?.beforeSend;

  it('was configured on init', () => {
    expect(beforeSend).toBeDefined();
  });

  it('collapses UW 503 errors into a stable fingerprint', () => {
    const event = {
      exception: {
        values: [
          {
            value:
              'UW API 503: upstream connect error or disconnect/reset ' +
              'before headers. reset reason: connection termination',
          },
        ],
      },
    };
    const result = beforeSend!(event) as { fingerprint?: string[] };
    expect(result.fingerprint).toEqual(['uw-api-5xx', '503']);
  });

  it('uses status code as the fingerprint discriminator', () => {
    const event502 = {
      exception: { values: [{ value: 'UW API 502: bad gateway' }] },
    };
    const event503 = {
      exception: { values: [{ value: 'UW API 503: upstream reset' }] },
    };
    const event504 = {
      exception: { values: [{ value: 'UW API 504: gateway timeout' }] },
    };
    const r502 = beforeSend!(event502) as { fingerprint?: string[] };
    const r503 = beforeSend!(event503) as { fingerprint?: string[] };
    const r504 = beforeSend!(event504) as { fingerprint?: string[] };
    expect(r502.fingerprint).toEqual(['uw-api-5xx', '502']);
    expect(r503.fingerprint).toEqual(['uw-api-5xx', '503']);
    expect(r504.fingerprint).toEqual(['uw-api-5xx', '504']);
  });

  it('does not collapse UW 4xx errors (semantic body differences)', () => {
    const event = {
      exception: { values: [{ value: 'UW API 429: rate limit exceeded' }] },
    };
    const result = beforeSend!(event) as { fingerprint?: string[] };
    expect(result.fingerprint).toBeUndefined();
  });

  it('does not collapse non-UW errors', () => {
    const event = {
      exception: { values: [{ value: 'Schwab API 503: Service Unavailable' }] },
    };
    const result = beforeSend!(event) as { fingerprint?: string[] };
    expect(result.fingerprint).toBeUndefined();
  });

  it('scrubs Authorization header from request context', () => {
    const event = {
      request: {
        headers: {
          authorization: 'Bearer SECRET_TOKEN_VALUE',
          'content-type': 'application/json',
        },
      },
    };
    const result = beforeSend!(event) as {
      request: { headers: Record<string, string> };
    };
    expect(result.request.headers.authorization).toBe('[Filtered]');
    expect(result.request.headers['content-type']).toBe('application/json');
  });

  it('handles events with no exception value gracefully', () => {
    const event = {};
    const result = beforeSend!(event) as { fingerprint?: string[] };
    expect(result.fingerprint).toBeUndefined();
  });

  it('scrubs secret-named keys from request.cookies, leaving others intact', () => {
    const event = {
      request: {
        cookies: {
          'sc-owner': 'OWNER_SECRET_VALUE',
          'sc-guest': 'guest-key-value',
          'session-id': 'abc',
          theme: 'dark',
          other: 'x',
        },
      },
    };
    const result = beforeSend!(event) as {
      request: { cookies: Record<string, string> };
    };
    expect(result.request.cookies['sc-owner']).toBe('[Filtered]');
    expect(result.request.cookies['sc-guest']).toBe('[Filtered]');
    expect(result.request.cookies['session-id']).toBe('[Filtered]');
    // Non-secret cookies are untouched.
    expect(result.request.cookies.theme).toBe('dark');
    expect(result.request.cookies.other).toBe('x');
  });

  it('does not throw when request.cookies is absent', () => {
    const event = { request: { headers: {} } };
    expect(() => beforeSend!(event)).not.toThrow();
  });

  it('scrubs credential headers and secret-named extra/tags, keeping the event', () => {
    const event = {
      request: {
        headers: {
          cookie: 'FAKE-COOKIE-HEADER',
          'x-api-key': 'FAKE-API-KEY',
          'x-cron-secret': 'FAKE-CRON-SECRET',
          accept: 'application/json',
        },
      },
      extra: { api_key: 'FAKE-EXTRA-KEY', note: 'visible' },
      tags: { endpoint: '/api/thing', auth_token: 'FAKE-TAG-TOKEN' },
    };
    const result = beforeSend!(event) as typeof event;
    expect(result.request.headers.cookie).toBe('[Filtered]');
    expect(result.request.headers['x-api-key']).toBe('[Filtered]');
    expect(result.request.headers['x-cron-secret']).toBe('[Filtered]');
    expect(result.request.headers.accept).toBe('application/json');
    expect(result.extra.api_key).toBe('[Filtered]');
    expect(result.extra.note).toBe('visible');
    expect(result.tags.auth_token).toBe('[Filtered]');
    expect(result.tags.endpoint).toBe('/api/thing');
  });
});

// =============================================================
// beforeSendTransaction / beforeSendSpan — same scrub as errors
// =============================================================

describe('Sentry.init beforeSendTransaction and beforeSendSpan', () => {
  type Obj = Record<string, unknown>;
  const initArgs = mockInit.mock.calls[0]?.[0] as
    | {
        beforeSendTransaction?: (event: Obj) => Obj | null;
        beforeSendSpan?: (span: Obj) => Obj;
      }
    | undefined;
  const beforeSendTransaction = initArgs?.beforeSendTransaction;
  const beforeSendSpan = initArgs?.beforeSendSpan;

  // Obviously fake values. Keys follow the shapes the SDK emits: header
  // names with `-` or `_`, plus one attribute per cookie name.
  const CREDENTIAL_ATTRIBUTES: Obj = {
    'http.request.header.cookie': 'FAKE-COOKIE-HEADER',
    'http.request.header.cookie.some_cookie': 'FAKE-COOKIE-VALUE-ONE',
    'http.request.header.cookie.other_cookie': 'FAKE-COOKIE-VALUE-TWO',
    'http.request.header.authorization': 'Bearer FAKE-BEARER-VALUE',
    'http.request.header.x-api-key': 'FAKE-API-KEY-HYPHEN',
    'http.request.header.x_api_key': 'FAKE-API-KEY-UNDERSCORE',
    'http.request.header.x-cron-secret': 'FAKE-CRON-HYPHEN',
    'http.request.header.x_cron_secret': 'FAKE-CRON-UNDERSCORE',
    'http.response.header.set-cookie': 'FAKE-SET-COOKIE-HYPHEN',
    'http.response.header.set_cookie': [
      'FAKE-SET-COOKIE-A',
      'FAKE-SET-COOKIE-B',
    ],
    'http.response.header.set_cookie.some_cookie': 'FAKE-SET-COOKIE-VALUE',
    'http.response.header.authorization': 'FAKE-RESPONSE-AUTHORIZATION',
  };
  const HARMLESS_ATTRIBUTES: Obj = {
    'sentry.op': 'http.server',
    'http.request.method': 'GET',
    'http.response.status_code': 200,
    'http.request.header.accept': '*/*',
    'http.request.header.content_type': 'application/json',
    'http.request.header.user_agent': 'fake-agent/1.0',
    'http.response.header.cache_control': 'no-store',
    'url.full': 'https://example.test/api/thing',
  };

  function buildTransaction(): Obj {
    return {
      type: 'transaction',
      transaction: 'GET /api/thing',
      request: {
        url: 'https://example.test/api/thing',
        headers: {
          cookie: 'some-cookie=FAKE-COOKIE-VALUE-ONE',
          authorization: 'Bearer FAKE-BEARER-VALUE',
          'x-api-key': 'FAKE-API-KEY',
          'x-cron-secret': 'FAKE-CRON-SECRET',
          accept: '*/*',
          'content-type': 'application/json',
        },
        cookies: {
          'sc-owner': 'FAKE-OWNER-COOKIE',
          'sc-guest': 'FAKE-GUEST-COOKIE',
          theme: 'dark',
        },
      },
      contexts: {
        trace: {
          op: 'http.server',
          data: { ...CREDENTIAL_ATTRIBUTES, ...HARMLESS_ATTRIBUTES },
        },
      },
      spans: [
        {
          description: 'child work',
          data: { ...CREDENTIAL_ATTRIBUTES, ...HARMLESS_ATTRIBUTES },
        },
        { description: 'no attributes' },
      ],
    };
  }

  type Built = {
    request: { headers: Obj; cookies: Obj };
    contexts: { trace: { data: Obj } };
    spans: { data?: Obj; description: string }[];
  };

  it('configures both hooks on init', () => {
    expect(beforeSendTransaction).toBeTypeOf('function');
    expect(beforeSendSpan).toBeTypeOf('function');
  });

  describe('beforeSendTransaction', () => {
    it('scrubs credential headers and parsed cookies from the request', () => {
      const result = beforeSendTransaction!(
        buildTransaction(),
      ) as never as Built;
      expect(result.request.headers.cookie).toBe('[Filtered]');
      expect(result.request.headers.authorization).toBe('[Filtered]');
      expect(result.request.headers['x-api-key']).toBe('[Filtered]');
      expect(result.request.headers['x-cron-secret']).toBe('[Filtered]');
      expect(result.request.cookies['sc-owner']).toBe('[Filtered]');
      expect(result.request.cookies['sc-guest']).toBe('[Filtered]');
    });

    it('leaves non-credential request headers and cookies untouched', () => {
      const result = beforeSendTransaction!(
        buildTransaction(),
      ) as never as Built;
      expect(result.request.headers.accept).toBe('*/*');
      expect(result.request.headers['content-type']).toBe('application/json');
      expect(result.request.cookies.theme).toBe('dark');
    });

    it.each(Object.keys(CREDENTIAL_ATTRIBUTES))(
      'filters %s on the root span and on child spans',
      (key) => {
        const result = beforeSendTransaction!(
          buildTransaction(),
        ) as never as Built;
        expect(result.contexts.trace.data[key]).toBe('[Filtered]');
        expect(result.spans[0]?.data?.[key]).toBe('[Filtered]');
      },
    );

    it('leaves unrelated span attributes untouched', () => {
      const result = beforeSendTransaction!(
        buildTransaction(),
      ) as never as Built;
      for (const [key, value] of Object.entries(HARMLESS_ATTRIBUTES)) {
        expect(result.contexts.trace.data[key]).toEqual(value);
        expect(result.spans[0]?.data?.[key]).toEqual(value);
      }
    });

    it('returns the same event instead of dropping it', () => {
      const event = buildTransaction();
      const result = beforeSendTransaction!(event);
      expect(result).toBe(event);
      expect(result).toMatchObject({
        type: 'transaction',
        transaction: 'GET /api/thing',
      });
      expect((result as never as Built).spans).toHaveLength(2);
    });

    it('scrubs secret-named extra and tags like an error event', () => {
      const event = {
        ...buildTransaction(),
        extra: { api_key: 'FAKE-EXTRA-KEY', note: 'visible' },
        tags: { endpoint: '/api/thing', auth_token: 'FAKE-TAG-TOKEN' },
      };
      const result = beforeSendTransaction!(event) as never as {
        extra: Obj;
        tags: Obj;
      };
      expect(result.extra.api_key).toBe('[Filtered]');
      expect(result.extra.note).toBe('visible');
      expect(result.tags.auth_token).toBe('[Filtered]');
      expect(result.tags.endpoint).toBe('/api/thing');
    });

    it('does not add an error fingerprint', () => {
      const result = beforeSendTransaction!(buildTransaction());
      expect(result).not.toHaveProperty('fingerprint');
    });

    it.each([
      ['an empty event', {}],
      ['no request or contexts', { type: 'transaction', spans: [] }],
      ['empty contexts', { contexts: {} }],
      ['a trace context without data', { contexts: { trace: {} } }],
      ['spans without data', { spans: [{}, { data: undefined }] }],
      ['a null span entry', { spans: [null] }],
      ['string cookies', { request: { cookies: 'a=b' } }],
      ['array cookies', { request: { cookies: ['a=b'] } }],
      ['null headers', { request: { headers: null } }],
    ])('does not throw on %s', (_label, event) => {
      expect(() => beforeSendTransaction!(event as Obj)).not.toThrow();
    });
  });

  describe('beforeSendSpan', () => {
    it.each(Object.keys(CREDENTIAL_ATTRIBUTES))('filters %s', (key) => {
      const span = {
        span_id: 'abc',
        data: { ...CREDENTIAL_ATTRIBUTES, ...HARMLESS_ATTRIBUTES },
      };
      const result = beforeSendSpan!(span) as never as { data: Obj };
      expect(result.data[key]).toBe('[Filtered]');
    });

    it('leaves unrelated attributes untouched and returns the span', () => {
      const span = {
        span_id: 'abc',
        data: { ...CREDENTIAL_ATTRIBUTES, ...HARMLESS_ATTRIBUTES },
      };
      const result = beforeSendSpan!(span) as never as { data: Obj };
      expect(result).toBe(span);
      for (const [key, value] of Object.entries(HARMLESS_ATTRIBUTES)) {
        expect(result.data[key]).toEqual(value);
      }
    });

    it('does not throw on a span with no data', () => {
      expect(() => beforeSendSpan!({ span_id: 'abc' })).not.toThrow();
      expect(() =>
        beforeSendSpan!({ span_id: 'abc', data: null }),
      ).not.toThrow();
    });
  });
});
