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
const FAKE_SECRETS = [
  OWNER,
  GUEST,
  BEARER,
  API_KEY,
  CRON,
  SET_COOKIE,
  RESPONSE_AUTH,
];

// Attribute shapes the SDK emits for request and response headers.
const CREDENTIAL_ATTRIBUTES = {
  'http.request.header.cookie': `sc-owner=${OWNER}`,
  'http.request.header.cookie.sc_owner': OWNER,
  'http.request.header.cookie.sc_guest': GUEST,
  'http.request.header.authorization': `Bearer ${BEARER}`,
  'http.request.header.x_api_key': API_KEY,
  'http.request.header.x-cron-secret': CRON,
  'http.response.header.set_cookie': [SET_COOKIE],
  'http.response.header.set_cookie.sc_owner': SET_COOKIE,
  'http.response.header.authorization': RESPONSE_AUTH,
};

const HARMLESS_MARKER = 'harmless-marker-value';

type SentryModule = typeof import('../_lib/sentry.js');
let Sentry: SentryModule['Sentry'];

beforeAll(async () => {
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
        url: 'https://example.test/api/thing',
        method: 'GET',
        headers: {
          cookie: `sc-owner=${OWNER}; sc-guest=${GUEST}; theme=dark`,
          authorization: `Bearer ${BEARER}`,
          'x-api-key': API_KEY,
          'x-cron-secret': CRON,
          accept: HARMLESS_MARKER,
        },
        cookies: { 'sc-owner': OWNER, 'sc-guest': GUEST, theme: 'dark' },
      },
    });
    await work();
  });
}

function expectNoFakeSecret(envelopes: string[]) {
  expect(envelopes.length).toBeGreaterThan(0);
  const everything = envelopes.join('\n');
  for (const secret of FAKE_SECRETS) {
    expect(everything, `${secret} reached the envelope`).not.toContain(secret);
  }
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
  });

  it('sends an error event with no credential values', async () => {
    sentEnvelopes.length = 0;

    await withFakeRequest(() => {
      Sentry.captureException(new Error('probe failure'));
    });
    await Sentry.flush(2000);

    const errors = sentEnvelopes.filter((e) => e.includes('probe failure'));
    expect(errors).toHaveLength(1);
    expectNoFakeSecret(errors);
    expect(errors[0]).toContain('[Filtered]');
    expect(errors[0]).toContain('"request"');
  });
});
