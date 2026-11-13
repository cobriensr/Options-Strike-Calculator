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
const { mockInit, mockMetrics, mockHttpIntegration } = vi.hoisted(() => ({
  mockInit: vi.fn(),
  mockMetrics: {
    count: vi.fn(),
    distribution: vi.fn(),
  },
  mockHttpIntegration: vi.fn((options: unknown) => ({
    name: 'Http',
    options,
  })),
}));

vi.mock('@sentry/node', () => ({
  init: mockInit,
  metrics: mockMetrics,
  httpIntegration: mockHttpIntegration,
}));

import { metrics } from '../_lib/sentry.js';

type Obj = Record<string, unknown>;

// The hooks, extracted from the mocked Sentry.init call.
const initOptions = mockInit.mock.calls[0]?.[0] as
  | {
      integrations?: unknown[];
      beforeSend?: (event: Obj) => Obj | null;
      beforeSendTransaction?: (event: Obj) => Obj | null;
      beforeSendSpan?: (span: Obj) => Obj;
      beforeBreadcrumb?: (breadcrumb: Obj) => Obj | null;
    }
  | undefined;

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

  it('stops the http integration from capturing incoming request bodies', () => {
    expect(mockHttpIntegration).toHaveBeenCalledTimes(1);
    expect(mockHttpIntegration).toHaveBeenCalledWith({
      maxIncomingRequestBodySize: 'none',
    });
    // The configured integration is the one handed to init.
    expect(initOptions?.integrations).toEqual([
      mockHttpIntegration.mock.results[0]?.value,
    ]);
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
  const beforeSend = initOptions?.beforeSend;

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
  const beforeSendTransaction = initOptions?.beforeSendTransaction;
  const beforeSendSpan = initOptions?.beforeSendSpan;

  // Obviously fake values. Keys follow the shapes the SDK emits: header
  // names with `-` or `_`, plus one attribute per cookie name. The
  // `Proxy-Authorization` / `X_Internal_Notify_Secret` keys are mixed case to
  // pin the `i` flag.
  const CREDENTIAL_ATTRIBUTES: Obj = {
    'http.request.header.cookie': 'FAKE-COOKIE-HEADER',
    'http.request.header.cookie.some_cookie': 'FAKE-COOKIE-VALUE-ONE',
    'http.request.header.cookie.other_cookie': 'FAKE-COOKIE-VALUE-TWO',
    'http.request.header.authorization': 'Bearer FAKE-BEARER-VALUE',
    'http.request.header.proxy-authorization': 'FAKE-PROXY-HYPHEN',
    'http.request.header.proxy_authorization': 'FAKE-PROXY-UNDERSCORE',
    'http.request.header.Proxy-Authorization': 'FAKE-PROXY-MIXED-CASE',
    // Any `*-authorization` header, not only the two standard ones.
    'http.request.header.x-forwarded-authorization': 'FAKE-FORWARDED-HYPHEN',
    'http.request.header.x_original_authorization': 'FAKE-ORIGINAL-UNDERSCORE',
    'http.request.header.X_Original_Authorization': 'FAKE-ORIGINAL-MIXED-CASE',
    'http.request.header.authorization_scheme': 'FAKE-SCHEME-UNDERSCORE',
    'http.request.header.x-api-key': 'FAKE-API-KEY-HYPHEN',
    'http.request.header.x_api_key': 'FAKE-API-KEY-UNDERSCORE',
    'http.request.header.x-apikey': 'FAKE-APIKEY-JOINED',
    'http.request.header.x-cron-secret': 'FAKE-CRON-HYPHEN',
    'http.request.header.x_cron_secret': 'FAKE-CRON-UNDERSCORE',
    'http.request.header.x-internal-notify-secret': 'FAKE-NOTIFY-HYPHEN',
    'http.request.header.x_internal_notify_secret': 'FAKE-NOTIFY-UNDERSCORE',
    'http.request.header.X_Internal_Notify_Secret': 'FAKE-NOTIFY-MIXED-CASE',
    'http.request.header.x-csrf-token': 'FAKE-TOKEN-HYPHEN',
    'http.request.header.x_csrf_token': 'FAKE-TOKEN-UNDERSCORE',
    'http.request.header.x-vercel-protection-bypass': 'FAKE-BYPASS-HYPHEN',
    'http.request.header.x_vercel_protection_bypass': 'FAKE-BYPASS-UNDERSCORE',
    'http.request.header.X_Vercel_Protection_Bypass': 'FAKE-BYPASS-MIXED-CASE',
    'http.request.header.x-session-id': 'FAKE-SESSION-HYPHEN',
    'http.request.header.x_password': 'FAKE-PASSWORD-UNDERSCORE',
    'http.request.header.x_jwt_assertion': 'FAKE-JWT-UNDERSCORE',
    'http.request.header.x-hub-signature-256': 'FAKE-SIGNATURE-HYPHEN',
    // `auth` and `key` as a whole word, at the start, middle or end.
    'http.request.header.x-takeit-auth': 'FAKE-AUTH-HYPHEN',
    'http.request.header.x_takeit_auth': 'FAKE-AUTH-UNDERSCORE',
    'http.request.header.X_TakeIt_Auth': 'FAKE-AUTH-MIXED-CASE',
    'http.request.header.x_auth_key': 'FAKE-AUTH-KEY-UNDERSCORE',
    'http.request.header.x-key': 'FAKE-KEY-HYPHEN',
    'http.request.header.x_key': 'FAKE-KEY-UNDERSCORE',
    // The credential word matches anywhere in the header name, so a longer
    // name that merely contains one is filtered too (over-matching is the
    // safe side).
    'http.request.header.x-api-key-version': 'FAKE-API-KEY-VERSION',
    'http.response.header.access-control-allow-credentials': 'true',
    'http.response.header.set-cookie': 'FAKE-SET-COOKIE-HYPHEN',
    'http.response.header.set_cookie': [
      'FAKE-SET-COOKIE-A',
      'FAKE-SET-COOKIE-B',
    ],
    'http.response.header.set_cookie.some_cookie': 'FAKE-SET-COOKIE-VALUE',
    'http.response.header.authorization': 'FAKE-RESPONSE-AUTHORIZATION',
    'http.response.header.x-refresh-token': 'FAKE-RESPONSE-TOKEN',
    // The request body the SDK copies onto the root span.
    'http.request.body.data': '{"key":"FAKE-BODY-VALUE"}',
  };
  // Look-alikes the pattern must leave alone: a name that only starts like a
  // credential header, and credential words outside the header namespace.
  const HARMLESS_ATTRIBUTES: Obj = {
    'sentry.op': 'http.server',
    'http.request.method': 'GET',
    'http.response.status_code': 200,
    'http.request.header.accept': '*/*',
    'http.request.header.content_type': 'application/json',
    'http.request.header.user_agent': 'fake-agent/1.0',
    'http.response.header.cache_control': 'no-store',
    'http.request.header.cookie_policy': 'strict',
    'http.request.header.cookie-policy': 'strict',
    'http.response.header.www_authenticate': 'Bearer realm="api"',
    'http.response.header.proxy_authenticate': 'Basic realm="proxy"',
    'http.response.header.authentication_info': 'nextnonce="fake"',
    'http.request.header.x_author': 'fake-author',
    'http.request.header.x_monkey': 'fake-monkey',
    'http.request.header.x_keyword': 'fake-keyword',
    'http.request.token_count': 3,
    'app.secret_santa_group': 'blue',
    'http.request.body.size': 26,
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

    it('leaves non-credential request headers untouched', () => {
      const result = beforeSendTransaction!(
        buildTransaction(),
      ) as never as Built;
      expect(result.request.headers.accept).toBe('*/*');
      expect(result.request.headers['content-type']).toBe('application/json');
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
      ['spans as an object', { spans: {} }],
      ['spans as null', { spans: null }],
      ['spans as a string', { spans: 'not-a-list' }],
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

// =============================================================
// request.headers / cookies / data / url on every event type
// =============================================================

describe.each([
  ['beforeSend', initOptions?.beforeSend],
  ['beforeSendTransaction', initOptions?.beforeSendTransaction],
])('%s request scrub', (_hookName, hook) => {
  /** Run an event that carries only `request`; return the scrubbed request. */
  const scrub = (request: Obj): Obj =>
    (hook!({ request }) as Obj).request as Obj;

  // Only `cookie` and `set-cookie` match by exact name. Any other name is
  // filtered when it contains a credential word anywhere (authorization, api
  // key, secret, token, bypass, session, password, jwt, bearer, credential,
  // signature) or `auth` / `key` as a whole word.
  it.each([
    'authorization',
    'Proxy-Authorization',
    'cookie',
    'Set-Cookie',
    // Any `*-authorization` header carries an Authorization value.
    'x-forwarded-authorization',
    'X-Original-Authorization',
    'x_original_authorization',
    'authorization-scheme',
    'authorization_scheme',
    'x-api-key',
    'X-API-KEY',
    'x_api_key',
    'x-apikey',
    'x-goog-api-key',
    'x-cron-secret',
    'x-internal-notify-secret',
    'x-csrf-token',
    // Words that match anywhere in the name.
    'x-vercel-protection-bypass',
    'X-Vercel-Protection-Bypass',
    'x-session-id',
    'x-password',
    'x-passwd',
    'x-jwt-assertion',
    'x-forwarded-bearer',
    'x-user-credentials',
    'x-hub-signature-256',
    // `auth` and `key` as a whole word, at the start, middle or end.
    'auth',
    'x-takeit-auth',
    'X-TakeIt-Auth',
    'x_takeit_auth',
    'x-auth-key',
    'x-auth',
    'key',
    'x-key',
    'x-cache-key',
    // A longer name that contains a credential word is filtered too, even
    // when its value is harmless: over-matching is the safe side.
    'x-api-key-version',
    'x-token-scope',
    'access-control-allow-credentials',
  ])('filters the %s request header', (name) => {
    const headers = scrub({
      headers: { [name]: 'FAKE-HEADER-VALUE', accept: '*/*' },
    }).headers as Obj;
    expect(headers[name]).toBe('[Filtered]');
    expect(headers.accept).toBe('*/*');
  });

  it.each([
    'accept',
    'content-type',
    'user-agent',
    'x-forwarded-for',
    'x-request-id',
    'sec-fetch-site',
    // Start like a credential header but are not one: `cookie` is matched by
    // exact name only, `auth` / `key` only as whole words, and the
    // authentication challenge headers carry no secret.
    'cookie-policy',
    'www-authenticate',
    'proxy-authenticate',
    'authentication-info',
    'x-author',
    'x-monkey',
    'x-keyword',
    'x-keys',
  ])('keeps the %s request header', (name) => {
    const headers = scrub({ headers: { [name]: 'harmless-value' } })
      .headers as Obj;
    expect(headers[name]).toBe('harmless-value');
  });

  it('filters the value of every cookie, whatever its name', () => {
    const cookies = scrub({
      cookies: {
        'sc-owner': 'FAKE-OWNER-COOKIE',
        'sc-guest': 'FAKE-GUEST-COOKIE',
        theme: 'dark',
        'a-cookie-added-next-year': 'FAKE-NEW-COOKIE',
      },
    }).cookies;
    expect(cookies).toEqual({
      'sc-owner': '[Filtered]',
      'sc-guest': '[Filtered]',
      theme: '[Filtered]',
      'a-cookie-added-next-year': '[Filtered]',
    });
  });

  it.each([
    ['a string', '{"key":"FAKE-BODY-VALUE"}'],
    ['an object', { key: 'FAKE-BODY-VALUE' }],
    ['a list', ['FAKE-BODY-VALUE']],
  ])('filters a request body given as %s', (_label, data) => {
    expect(scrub({ data }).data).toBe('[Filtered]');
  });

  it('does not add a body to a request that has none', () => {
    expect(scrub({ headers: {} }).data).toBeUndefined();
  });

  it('redacts secret query values in request.url, keeping the rest', () => {
    expect(
      scrub({
        url: 'https://example.test/api/thing?token=FAKE-URL-TOKEN&date=2026-01-01',
      }).url,
    ).toBe('https://example.test/api/thing?token=[Filtered]&date=2026-01-01');
  });

  it('leaves a request.url without a query alone', () => {
    expect(scrub({ url: 'https://example.test/api/thing' }).url).toBe(
      'https://example.test/api/thing',
    );
  });

  it('redacts the OAuth callback parameters in request.url', () => {
    expect(
      scrub({
        url: 'https://example.test/api/auth/callback?code=FAKE-CODE&session=FAKE-SESSION&state=FAKE-STATE&date=2026-01-01',
      }).url,
    ).toBe(
      'https://example.test/api/auth/callback?code=[Filtered]&session=[Filtered]&state=[Filtered]&date=2026-01-01',
    );
  });

  it('redacts the account identifier path segment in request.url', () => {
    expect(
      scrub({
        url: 'https://example.test/trader/v1/accounts/FAKE-ACCOUNT-HASH/orders?status=OPEN',
      }).url,
    ).toBe(
      'https://example.test/trader/v1/accounts/[Filtered]/orders?status=OPEN',
    );
  });

  // The referer is a URL the client sent, so it gets the same query and path
  // redaction as the request URL. Header names compare case-insensitively.
  it.each(['referer', 'Referer'])(
    'redacts the query and account path in the %s request header',
    (name) => {
      const headers = scrub({
        headers: {
          [name]:
            'https://example.test/accounts/FAKE-ACCOUNT-HASH?token=FAKE-REFERER-TOKEN&view=compact',
        },
      }).headers as Obj;
      expect(headers[name]).toBe(
        'https://example.test/accounts/[Filtered]?token=[Filtered]&view=compact',
      );
    },
  );

  it('keeps a referer without a secret as it is, and survives a non-string one', () => {
    const plain = 'https://example.test/page?view=compact';
    expect(scrub({ headers: { referer: plain } }).headers).toEqual({
      referer: plain,
    });
    expect(() =>
      scrub({ headers: { referer: ['a', 'b'], other: 1 } }),
    ).not.toThrow();
  });

  it.each([
    [
      'a string',
      'token=FAKE-QS-TOKEN&date=2026-01-01',
      'token=[Filtered]&date=2026-01-01',
    ],
    [
      'an object',
      { token: 'FAKE-QS-TOKEN', date: '2026-01-01' },
      { token: '[Filtered]', date: '2026-01-01' },
    ],
    [
      'a list of pairs',
      [
        ['token', 'FAKE-QS-TOKEN'],
        ['date', '2026-01-01'],
      ],
      [
        ['token', '[Filtered]'],
        ['date', '2026-01-01'],
      ],
    ],
  ])(
    'redacts secret query values in request.query_string given as %s',
    (_label, query_string, expected) => {
      expect(scrub({ query_string }).query_string).toEqual(expected);
    },
  );

  it('does not throw on a malformed query_string', () => {
    expect(() => scrub({ query_string: 42 })).not.toThrow();
    expect(() =>
      scrub({ query_string: [null, 'x', ['only-a-name']] }),
    ).not.toThrow();
    // A pair whose name is not a string, including one with no prototype
    // (String() on it throws).
    expect(() =>
      scrub({ query_string: [[Object.create(null), 'x']] }),
    ).not.toThrow();
    expect(() => scrub({ query_string: [[1, 'x']] })).not.toThrow();
  });
});

// =============================================================
// Query-string secrets in URL-shaped span attributes and breadcrumbs
// =============================================================

describe('query-string secret redaction', () => {
  const beforeSendTransaction = initOptions?.beforeSendTransaction;
  const beforeSendSpan = initOptions?.beforeSendSpan;
  const beforeBreadcrumb = initOptions?.beforeBreadcrumb;

  const FAKE = 'FAKE-QUERY-SECRET';
  const FULL_URL = `https://upstream.example.test/v1/data?api_key=${FAKE}&from=2026-01-01&token=${FAKE}#top`;
  const FULL_URL_REDACTED =
    'https://upstream.example.test/v1/data?api_key=[Filtered]&from=2026-01-01&token=[Filtered]#top';

  // [attribute, value the SDK would record, value after the scrub]. `url.query`
  // is a bare query; `http.query` keeps its leading `?`.
  const FIELDS: [string, string, string][] = [
    ['url.full', FULL_URL, FULL_URL_REDACTED],
    ['http.url', FULL_URL, FULL_URL_REDACTED],
    [
      'http.target',
      `/v1/data?token=${FAKE}&limit=5`,
      '/v1/data?token=[Filtered]&limit=5',
    ],
    [
      'url.query',
      `api_key=${FAKE}&from=2026-01-01`,
      'api_key=[Filtered]&from=2026-01-01',
    ],
    [
      'http.query',
      `?api_key=${FAKE}&from=2026-01-01`,
      '?api_key=[Filtered]&from=2026-01-01',
    ],
  ];

  describe('on spans', () => {
    it.each(FIELDS)(
      'redacts %s in beforeSendSpan',
      (field, input, expected) => {
        const result = beforeSendSpan!({ data: { [field]: input } }) as {
          data: Obj;
        };
        expect(result.data[field]).toBe(expected);
      },
    );

    it.each(FIELDS)(
      'redacts %s on the root span and child spans of a transaction',
      (field, input, expected) => {
        const result = beforeSendTransaction!({
          contexts: { trace: { data: { [field]: input } } },
          spans: [{ data: { [field]: input } }],
        }) as {
          contexts: { trace: { data: Obj } };
          spans: { data: Obj }[];
        };
        expect(result.contexts.trace.data[field]).toBe(expected);
        expect(result.spans[0]?.data[field]).toBe(expected);
      },
    );

    it('redacts every occurrence of a repeated parameter', () => {
      const result = beforeSendSpan!({
        data: { 'url.query': `token=${FAKE}-A&from=1&token=${FAKE}-B` },
      }) as { data: Obj };
      expect(result.data['url.query']).toBe(
        'token=[Filtered]&from=1&token=[Filtered]',
      );
    });

    it('leaves a value that is already filtered as it is', () => {
      const result = beforeSendSpan!({
        data: { 'url.query': 'token=[Filtered]&from=1' },
      }) as { data: Obj };
      expect(result.data['url.query']).toBe('token=[Filtered]&from=1');
    });

    it.each([
      ['url.full', 'https://example.test/api/thing'],
      ['url.full', 'https://example.test/api/thing?date=2026-01-01&limit=5'],
      ['url.full', 'https://example.test/path/token=abc'],
      ['http.target', '/api/thing'],
      ['url.query', 'date=2026-01-01'],
      ['url.query', 'token'],
      ['http.query', ''],
      ['url.full', 42],
      ['url.query', null],
    ])('leaves %s = %j alone', (field, value) => {
      const result = beforeSendSpan!({ data: { [field]: value } }) as {
        data: Obj;
      };
      expect(result.data[field]).toBe(value);
    });

    // `key` alone is a credential name only as a whole word (`key`,
    // `access_key`, `accessKey`), so look-alikes such as `monkey` stay.
    it.each([
      'token',
      'Token',
      'api_key',
      'api-key',
      'apikey',
      'apiKey',
      'API_KEY',
      'secret',
      'client_secret',
      'password',
      'key',
      'access_key',
      'accessKey',
      'x-key',
      'api%5Fkey',
      // Credential words that match anywhere in the name, like the header
      // words: a bypass token and a pre-signed URL's signature and credential.
      'x-vercel-protection-bypass',
      'bypass',
      'X-Amz-Signature',
      'signature',
      'X-Amz-Credential',
      'credential',
      'jwt',
      'bearer',
      // The OAuth callback parameters, by exact name in any case.
      'code',
      'state',
      'session',
      'Code',
      'STATE',
      // A malformed escape cannot be decoded; the raw name is tested instead.
      'bad%ZZ_token',
    ])('redacts the value of the %s parameter', (name) => {
      const result = beforeSendSpan!({
        data: { 'url.query': `${name}=${FAKE}&from=2026-01-01` },
      }) as { data: Obj };
      expect(result.data['url.query']).toBe(
        `${name}=[Filtered]&from=2026-01-01`,
      );
    });

    it.each([
      'from',
      'limit',
      'date',
      'ticker',
      'monkey',
      'keyword',
      'keys',
      // `code`, `state` and `session` match only as the whole name.
      'statement',
      'postcode',
      'codec',
      'sessions',
      // The rest of a pre-signed URL stays readable.
      'X-Amz-Algorithm',
      'X-Amz-Date',
      'X-Amz-Expires',
      'X-Amz-SignedHeaders',
      'to%ZZken',
    ])('keeps the value of the %s parameter', (name) => {
      const result = beforeSendSpan!({
        data: { 'url.query': `${name}=harmless&limit=5` },
      }) as { data: Obj };
      expect(result.data['url.query']).toBe(`${name}=harmless&limit=5`);
    });
  });

  describe('beforeBreadcrumb', () => {
    it('is configured on init', () => {
      expect(beforeBreadcrumb).toBeTypeOf('function');
    });

    it('redacts the query in data.url and data["http.query"], keeping the rest', () => {
      const breadcrumb = {
        category: 'http',
        type: 'http',
        level: 'info',
        data: {
          url: FULL_URL,
          'http.method': 'GET',
          'http.query': `?api_key=${FAKE}&from=2026-01-01&token=${FAKE}`,
          status_code: 200,
        },
      };
      const result = beforeBreadcrumb!(breadcrumb);
      // Returned, not dropped.
      expect(result).toBe(breadcrumb);
      expect(result).toMatchObject({
        category: 'http',
        data: {
          url: FULL_URL_REDACTED,
          'http.method': 'GET',
          'http.query': '?api_key=[Filtered]&from=2026-01-01&token=[Filtered]',
          status_code: 200,
        },
      });
    });

    it.each([
      ['no data', { category: 'console', message: 'hello' }],
      ['null data', { category: 'http', data: null }],
      ['non-string url and query', { data: { url: 5, 'http.query': {} } }],
      ['array data', { data: ['a=b'] }],
    ])('returns a breadcrumb with %s untouched', (_label, breadcrumb) => {
      const before = structuredClone(breadcrumb);
      expect(beforeBreadcrumb!(breadcrumb)).toEqual(before);
    });
  });

  // The path segment after `/accounts/` is an account identifier. The SDK
  // records the path in url.full / http.url / http.target / url.path, in the
  // sanitized `url`, in the span description (`GET <url>`) and, for a
  // breadcrumb, in data.url.
  describe('account identifier path segment', () => {
    const HASH = 'FAKE-ACCOUNT-HASH';
    const ACCOUNT_URL = `https://upstream.example.test/trader/v1/accounts/${HASH}/orders?status=OPEN#top`;
    const ACCOUNT_URL_REDACTED =
      'https://upstream.example.test/trader/v1/accounts/[Filtered]/orders?status=OPEN#top';
    const ACCOUNT_PATH = `/trader/v1/accounts/${HASH}/orders`;
    const ACCOUNT_PATH_REDACTED = '/trader/v1/accounts/[Filtered]/orders';

    const ACCOUNT_FIELDS: [string, string, string][] = [
      ['url.full', ACCOUNT_URL, ACCOUNT_URL_REDACTED],
      ['http.url', ACCOUNT_URL, ACCOUNT_URL_REDACTED],
      ['url', ACCOUNT_URL, ACCOUNT_URL_REDACTED],
      [
        'http.target',
        `${ACCOUNT_PATH}?status=OPEN`,
        `${ACCOUNT_PATH_REDACTED}?status=OPEN`,
      ],
      ['url.path', ACCOUNT_PATH, ACCOUNT_PATH_REDACTED],
    ];

    it.each(ACCOUNT_FIELDS)(
      'redacts the segment in %s on a span',
      (field, input, expected) => {
        const result = beforeSendSpan!({ data: { [field]: input } }) as {
          data: Obj;
        };
        expect(result.data[field]).toBe(expected);
      },
    );

    it.each(ACCOUNT_FIELDS)(
      'redacts the segment in %s on the root span and child spans of a transaction',
      (field, input, expected) => {
        const result = beforeSendTransaction!({
          contexts: { trace: { data: { [field]: input } } },
          spans: [{ data: { [field]: input } }],
        }) as {
          contexts: { trace: { data: Obj } };
          spans: { data: Obj }[];
        };
        expect(result.contexts.trace.data[field]).toBe(expected);
        expect(result.spans[0]?.data[field]).toBe(expected);
      },
    );

    it('redacts the segment in the span description, keeping the rest', () => {
      const span = beforeSendSpan!({
        description: `GET https://upstream.example.test${ACCOUNT_PATH}`,
        data: {},
      });
      expect(span.description).toBe(
        'GET https://upstream.example.test/trader/v1/accounts/[Filtered]/orders',
      );
      const result = beforeSendTransaction!({
        contexts: {
          trace: { description: `GET /trader/v1/accounts/${HASH}`, data: {} },
        },
        spans: [{ description: `GET /trader/v1/accounts/${HASH}/orders` }],
      }) as {
        contexts: { trace: { description: string } };
        spans: { description: string }[];
      };
      expect(result.contexts.trace.description).toBe(
        'GET /trader/v1/accounts/[Filtered]',
      );
      expect(result.spans[0]?.description).toBe(
        'GET /trader/v1/accounts/[Filtered]/orders',
      );
    });

    it('redacts the segment in a breadcrumb data.url', () => {
      const breadcrumb = {
        category: 'http',
        data: { url: ACCOUNT_URL, 'http.method': 'GET' },
      };
      expect(beforeBreadcrumb!(breadcrumb)).toMatchObject({
        data: { url: ACCOUNT_URL_REDACTED, 'http.method': 'GET' },
      });
    });

    it('redacts every segment that follows /accounts/, the literal list segment included', () => {
      const span = beforeSendSpan!({
        data: {
          'url.path': '/trader/v1/accounts/accountNumbers',
          'url.full': `https://x.test/accounts/${HASH}/a/accounts/${HASH}-2/b`,
        },
      }) as { data: Obj };
      expect(span.data['url.path']).toBe('/trader/v1/accounts/[Filtered]');
      expect(span.data['url.full']).toBe(
        'https://x.test/accounts/[Filtered]/a/accounts/[Filtered]/b',
      );
    });

    it.each([
      'https://x.test/trader/v1/accounts',
      'https://x.test/trader/v1/accounts/',
      'https://x.test/trader/v1/my-accounts/abc',
      'https://x.test/trader/v1/accountsettings/abc',
      'https://x.test/trader/v1/orders/accounts',
    ])('leaves %s alone', (url) => {
      const span = beforeSendSpan!({ data: { 'url.full': url } }) as {
        data: Obj;
      };
      expect(span.data['url.full']).toBe(url);
    });

    it('does not throw on a span description that is not a string', () => {
      expect(() => beforeSendSpan!({ description: 5, data: {} })).not.toThrow();
      expect(() => beforeSendSpan!({ description: null })).not.toThrow();
    });
  });

  describe('referer span attribute', () => {
    const REFERER =
      'https://example.test/accounts/FAKE-ACCOUNT-HASH?token=FAKE-REFERER-TOKEN&view=compact';

    it('redacts the query and account path in http.request.header.referer', () => {
      const result = beforeSendSpan!({
        data: { 'http.request.header.referer': REFERER },
      }) as { data: Obj };
      expect(result.data['http.request.header.referer']).toBe(
        'https://example.test/accounts/[Filtered]?token=[Filtered]&view=compact',
      );
    });

    it('does the same on the root span and child spans of a transaction', () => {
      const result = beforeSendTransaction!({
        contexts: {
          trace: { data: { 'http.request.header.referer': REFERER } },
        },
        spans: [{ data: { 'http.request.header.referer': REFERER } }],
      }) as {
        contexts: { trace: { data: Obj } };
        spans: { data: Obj }[];
      };
      const expected =
        'https://example.test/accounts/[Filtered]?token=[Filtered]&view=compact';
      expect(result.contexts.trace.data['http.request.header.referer']).toBe(
        expected,
      );
      expect(result.spans[0]?.data['http.request.header.referer']).toBe(
        expected,
      );
    });
  });
});
