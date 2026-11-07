// @vitest-environment node

/**
 * End-to-end check that an upstream Schwab error body never reaches the
 * places fetch-market-internals puts `result.error`: the thrown SettleFailure
 * (and so Sentry and the log line), and the per-symbol `error` field in the
 * response and the Axiom event.
 *
 * fetch-market-internals.test.ts mocks schwabFetch, so it cannot see the
 * redaction, which lives in schwabFetch itself (api/_lib/schwab-fetch.ts).
 * This file keeps schwabFetch REAL and stubs only the network (`fetch`), the
 * token source and the DB, so a regression in the shared helper fails here as
 * a leak in this cron.
 *
 * A 403 is used on purpose: schwabFetch retries only 5xx and network errors,
 * so the answer comes back at once with no backoff to wait out.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockTransaction = vi.fn();
const mockSql = vi.fn().mockResolvedValue([]) as ReturnType<typeof vi.fn> & {
  transaction: typeof mockTransaction;
};
mockSql.transaction = mockTransaction;

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
  metrics: {
    increment: vi.fn(),
    schwabCall: vi.fn(() => vi.fn()),
    tokenRefresh: vi.fn(),
  },
}));

vi.mock('../_lib/schwab.js', () => ({
  getAccessToken: vi.fn(async () => ({ token: 'access-token' })),
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

import handler from '../cron/fetch-market-internals.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';
import { reportCronRun } from '../_lib/axiom.js';

// Friday 17:30 ET (EST), after the close: inside the settle's time gate.
const SETTLE_TIME = new Date('2026-11-06T22:30:00.000Z');

// A 40-character token-like run, as an echoed credential would look.
const TOKEN = 'T0kenLikeRun'.repeat(4).slice(0, 40);
const BODY = `{"error":"forbidden","echo":"${TOKEN}"}`;

describe('fetch-market-internals: Schwab error body redaction', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(SETTLE_TIME);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    mockSql.mockResolvedValue([]);
    mockSql.transaction = mockTransaction;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => BODY,
      }),
    );
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('masks the token in the response, the Axiom event, the log and the Sentry capture', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    // Every symbol failed on the 403, so the per-symbol errors are present
    // and the run did not report success.
    expect((res._json as { status: string }).status).toBe('error');
    const body = res._json as {
      results: { symbol: string; error?: string }[];
    };
    const errors = body.results.map((r) => r.error);
    expect(errors).toHaveLength(4);
    for (const error of errors) {
      expect(error).toContain('Schwab API error (403)');
      expect(error).toContain('[redacted]');
      expect(error).not.toContain(TOKEN);
    }

    // The response is what the Axiom event is built from.
    expect(JSON.stringify(res._json)).not.toContain(TOKEN);
    expect(reportCronRun).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(reportCronRun).mock.calls)).not.toContain(
      TOKEN,
    );
    // An Error's message is non-enumerable, so JSON.stringify would miss it:
    // read it explicitly from the per-symbol warn lines.
    const warnedMessages = vi
      .mocked(logger.warn)
      .mock.calls.map(([fields]) => (fields as { err?: Error }).err?.message);
    expect(warnedMessages.length).toBeGreaterThan(0);
    for (const message of warnedMessages) {
      expect(message).not.toContain(TOKEN);
    }

    // Each failed symbol is captured as an Error.
    const captured = vi.mocked(Sentry.captureException).mock.calls;
    expect(captured.length).toBeGreaterThan(0);
    for (const [err] of captured) {
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });
});
