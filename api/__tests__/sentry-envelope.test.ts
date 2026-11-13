// @vitest-environment node

/**
 * End-to-end check of the Sentry scrub through the real @sentry/node SDK.
 *
 * sentry.test.ts calls the hooks directly against a mocked SDK. This file
 * keeps the real SDK, swaps only the transport for an in-memory sink, and
 * searches the WHOLE serialized envelope for the fake secrets, so a field
 * nobody thought of still fails the test. It also proves the SDK calls the
 * hooks and where it puts request data on each event type.
 *
 * Every secret is an obviously fake placeholder, built at run time: the SDK
 * attaches source lines around an error's stack frames, so a secret written
 * out as a literal near a frame would show up in the envelope as test source,
 * not as a leak.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { sentEnvelopes } = vi.hoisted(() => ({
  sentEnvelopes: [] as string[],
}));

// Mock at the module boundary: the real SDK, with only the transport
// replaced so nothing leaves the process.
vi.mock('@sentry/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/node')>();
  return {
    ...actual,
    init: (options: Parameters<typeof actual.init>[0]) =>
      actual.init({
        ...options,
        transport: () => ({
          send: async (envelope: unknown) => {
            sentEnvelopes.push(JSON.stringify(envelope));
            return {};
          },
          flush: async () => true,
        }),
      }),
  };
});

const fake = (label: string) => `FAKE-${label}-VALUE`;
const OWNER = fake('owner-cookie');
const GUEST = fake('guest-cookie');
const BEARER = fake('bearer');
const API_KEY = fake('api-key');
const CRON = fake('cron-secret');
const SET_COOKIE = fake('set-cookie');
const RESPONSE_AUTH = fake('response-authorization');
const NOTIFY = fake('notify-secret');
const BODY_KEY = fake('body-key');
const REQUEST_QUERY_TOKEN = fake('request-query-token');
const QUERY_API_KEY = fake('query-api-key');
const QUERY_TOKEN = fake('query-token');
const SOURCE_BODY_KEY = fake('source-body-key');
// A cookie whose name no list of secret-looking names would have.
const UNLISTED_COOKIE = fake('unlisted-cookie');
const TAKEIT_AUTH = fake('takeit-auth');
const BYPASS = fake('protection-bypass');
const OAUTH_CODE = fake('oauth-code');
const OAUTH_STATE = fake('oauth-state');
const ACCOUNT_HASH = fake('account-hash');
const REFERER_TOKEN = fake('referer-token');
const FAKE_SECRETS = [
  OWNER,
  GUEST,
  BEARER,
  API_KEY,
  CRON,
  SET_COOKIE,
  RESPONSE_AUTH,
  NOTIFY,
  BODY_KEY,
  REQUEST_QUERY_TOKEN,
  QUERY_API_KEY,
  QUERY_TOKEN,
  SOURCE_BODY_KEY,
  UNLISTED_COOKIE,
  TAKEIT_AUTH,
  BYPASS,
  OAUTH_CODE,
  OAUTH_STATE,
  ACCOUNT_HASH,
  REFERER_TOKEN,
];

// A page URL the client sends as its referer, with a secret query parameter.
const REFERER = `https://example.test/page?token=${REFERER_TOKEN}&view=compact`;

// Attribute shapes the SDK emits for request and response headers, plus the
// request body it copies onto the root span.
const CREDENTIAL_ATTRIBUTES = {
  'http.request.header.cookie': `sc-owner=${OWNER}`,
  'http.request.header.cookie.sc_owner': OWNER,
  'http.request.header.cookie.sc_guest': GUEST,
  'http.request.header.authorization': `Bearer ${BEARER}`,
  'http.request.header.x_api_key': API_KEY,
  'http.request.header.x-cron-secret': CRON,
  'http.request.header.x-internal-notify-secret': NOTIFY,
  'http.request.header.x-takeit-auth': TAKEIT_AUTH,
  'http.request.header.x_vercel_protection_bypass': BYPASS,
  'http.request.header.referer': REFERER,
  'http.response.header.set_cookie': [SET_COOKIE],
  'http.response.header.set_cookie.sc_owner': SET_COOKIE,
  'http.response.header.authorization': RESPONSE_AUTH,
  'http.request.body.data': JSON.stringify({ key: BODY_KEY }),
};

// An outgoing call whose URL carries two secret parameters and one harmless
// one. The attribute names are the ones the SDK records for a fetch span and
// for an http breadcrumb.
const UPSTREAM_QUERY = `api_key=${QUERY_API_KEY}&from=2026-01-01&token=${QUERY_TOKEN}`;
const UPSTREAM_URL = `https://upstream.example.test/v1/data?${UPSTREAM_QUERY}`;
const FETCH_SPAN_ATTRIBUTES = {
  'url.full': UPSTREAM_URL,
  'http.url': UPSTREAM_URL,
  'url.query': UPSTREAM_QUERY,
  'http.query': `?${UPSTREAM_QUERY}`,
  'http.target': `/v1/data?${UPSTREAM_QUERY}`,
};

// An outgoing call whose path carries an account identifier. The SDK records
// the path in these attributes, and `GET <url>` as the span description.
const ACCOUNT_PATH = `/trader/v1/accounts/${ACCOUNT_HASH}/orders`;
const ACCOUNT_URL = `https://upstream.example.test${ACCOUNT_PATH}`;
const ACCOUNT_SPAN_ATTRIBUTES = {
  'url.full': ACCOUNT_URL,
  'http.url': ACCOUNT_URL,
  'url.path': ACCOUNT_PATH,
  url: ACCOUNT_URL,
};
// What must stay readable once the identifier is redacted.
const READABLE_ACCOUNT_PATH = '/trader/v1/accounts/[Filtered]/orders';

const HARMLESS_MARKER = 'harmless-marker-value';
// The harmless parameter that must stay readable in a redacted URL.
const READABLE_PARAM = 'from=2026-01-01';

type SentryModule = typeof import('../_lib/sentry.js');
let Sentry: SentryModule['Sentry'];

beforeAll(async () => {
  // Pin the sampling branch: tracesSampleRate is 1 outside production, 0.25
  // under NODE_ENV=production, which would sample the transaction out.
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('VERCEL_ENV', 'production');
  vi.stubEnv('SENTRY_DSN', 'https://public@o0.ingest.example.test/0');
  ({ Sentry } = await import('../_lib/sentry.js'));
});

afterAll(async () => {
  await Sentry.close(2000);
  vi.unstubAllEnvs();
});

/** Run `work` inside a request scope that carries fake credentials. */
async function withFakeRequest(work: () => void | Promise<void>) {
  await Sentry.withIsolationScope(async (scope) => {
    scope.setSDKProcessingMetadata({
      normalizedRequest: {
        // An OAuth callback request: single-use code and state parameters.
        url: `https://example.test/api/auth/callback?code=${OAUTH_CODE}&state=${OAUTH_STATE}&token=${REQUEST_QUERY_TOKEN}&date=2026-01-01`,
        method: 'POST',
        query_string: `code=${OAUTH_CODE}&state=${OAUTH_STATE}&token=${REQUEST_QUERY_TOKEN}&date=2026-01-01`,
        headers: {
          cookie: `sc-owner=${OWNER}; sc-guest=${GUEST}; theme=dark`,
          authorization: `Bearer ${BEARER}`,
          'x-api-key': API_KEY,
          'x-cron-secret': CRON,
          'x-internal-notify-secret': NOTIFY,
          'x-takeit-auth': TAKEIT_AUTH,
          'x-vercel-protection-bypass': BYPASS,
          referer: REFERER,
          accept: HARMLESS_MARKER,
        },
        cookies: {
          'sc-owner': OWNER,
          'sc-guest': GUEST,
          'unlisted-name': UNLISTED_COOKIE,
          theme: 'dark',
        },
        data: { key: BODY_KEY },
      },
    });
    await work();
  });
}

function expectNoFakeSecret(envelopes: string[]) {
  expect(envelopes.length).toBeGreaterThan(0);
  const everything = envelopes.join('\n');
  const leaked = FAKE_SECRETS.filter((secret) => everything.includes(secret));
  expect(leaked, 'fake secrets that reached the envelope').toEqual([]);
}

describe('Sentry scrub through the real SDK', () => {
  it('sends a transaction and its spans with no credential values', async () => {
    sentEnvelopes.length = 0;

    await withFakeRequest(async () => {
      await Sentry.startSpan(
        {
          name: 'GET /api/thing',
          op: 'http.server',
          attributes: {
            ...CREDENTIAL_ATTRIBUTES,
            'http.request.header.accept': HARMLESS_MARKER,
          },
        },
        async () => {
          await Sentry.startSpan(
            { name: 'child work', attributes: { ...CREDENTIAL_ATTRIBUTES } },
            async () => {},
          );
          await Sentry.startSpan(
            {
              name: 'GET https://upstream.example.test/v1/data',
              op: 'http.client',
              attributes: { ...FETCH_SPAN_ATTRIBUTES },
            },
            async () => {},
          );
          await Sentry.startSpan(
            {
              name: `GET ${ACCOUNT_URL}`,
              op: 'http.client',
              attributes: { ...ACCOUNT_SPAN_ATTRIBUTES },
            },
            async () => {},
          );
        },
      );
    });
    await Sentry.flush(2000);

    const transactions = sentEnvelopes.filter((e) =>
      e.includes('"type":"transaction"'),
    );
    expect(transactions).toHaveLength(1);
    expectNoFakeSecret(transactions);
    // Not vacuous: the transaction arrived with its request data, the
    // filtered markers, and the unrelated attribute intact.
    expect(transactions[0]).toContain('[Filtered]');
    expect(transactions[0]).toContain('"request"');
    expect(transactions[0]).toContain(HARMLESS_MARKER);
    expect(transactions[0]).toContain('child work');
    // The fetch span and the request URL keep their readable parts.
    expect(transactions[0]).toContain('upstream.example.test/v1/data');
    expect(transactions[0]).toContain(READABLE_PARAM);
    expect(transactions[0]).toContain('date=2026-01-01');
    expect(transactions[0]).toContain(READABLE_ACCOUNT_PATH);
    expect(transactions[0]).toContain('view=compact');
  });

  it('sends an error event with no credential values', async () => {
    sentEnvelopes.length = 0;

    await withFakeRequest(() => {
      Sentry.addBreadcrumb({
        category: 'http',
        type: 'http',
        level: 'info',
        data: {
          url: UPSTREAM_URL,
          'http.method': 'GET',
          'http.query': `?${UPSTREAM_QUERY}`,
          status_code: 200,
        },
      });
      Sentry.addBreadcrumb({
        category: 'http',
        type: 'http',
        level: 'info',
        data: { url: ACCOUNT_URL, 'http.method': 'GET', status_code: 200 },
      });
      Sentry.captureException(new Error('probe failure'));
    });
    await Sentry.flush(2000);

    const errors = sentEnvelopes.filter((e) => e.includes('probe failure'));
    expect(errors).toHaveLength(1);
    expectNoFakeSecret(errors);
    expect(errors[0]).toContain('[Filtered]');
    expect(errors[0]).toContain('"request"');
    // The breadcrumb arrived, with its harmless parameter still readable.
    expect(errors[0]).toContain('"breadcrumbs"');
    expect(errors[0]).toContain('upstream.example.test/v1/data');
    expect(errors[0]).toContain(READABLE_PARAM);
    expect(errors[0]).toContain(READABLE_ACCOUNT_PATH);
    expect(errors[0]).toContain('view=compact');
  });

  // A real loopback server, so the SDK's own http integration sees a real
  // request. The handler reads the body the way a Vercel handler does
  // (`req.on('data')`), which is the path the SDK taps to capture it.
  it('does not capture the incoming request body at the source', async () => {
    sentEnvelopes.length = 0;

    let finished: () => void = () => {};
    const responded = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const server = createServer((req, res) => {
      res.on('finish', finished);
      req.on('data', () => {});
      req.on('end', () => {
        Sentry.captureException(new Error('body probe'));
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/thing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: SOURCE_BODY_KEY }),
      });
      await response.text();
      await responded;
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await Sentry.flush(2000);

    const errors = sentEnvelopes.filter((e) => e.includes('body probe'));
    expect(errors).toHaveLength(1);
    const [, items] = JSON.parse(errors[0] ?? '[]') as [
      unknown,
      [unknown, { request?: { data?: unknown } }][],
    ];
    const event = items[0]?.[1];
    // The request was captured, but with no body at all (not even a filtered
    // marker), so the source option is what keeps the body out.
    expect(event?.request).toBeDefined();
    expect(event?.request?.data).toBeUndefined();
    expectNoFakeSecret(sentEnvelopes);
    expect(sentEnvelopes.join('\n')).not.toContain('http.request.body.data');
  });
});
