// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { mockRequest, mockResponse } from './helpers';

type GuardFn = (
  req: VercelRequest,
  res: VercelResponse,
  done: (opts: { status: number }) => void,
) => Promise<boolean>;

const { mockSql, mockSentryCapture, mockGuardOwnerOrGuest } = vi.hoisted(
  () => ({
    mockSql: vi.fn(),
    mockSentryCapture: vi.fn(),
    mockGuardOwnerOrGuest: vi.fn<GuardFn>(),
  }),
);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: mockSentryCapture,
    captureMessage: vi.fn(),
    withScope: (fn: (s: { setTransactionName: () => void }) => unknown) =>
      fn({ setTransactionName: vi.fn() }),
  },
  metrics: {
    request: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../_lib/guest-auth.js', () => ({
  guardOwnerOrGuestEndpoint: mockGuardOwnerOrGuest,
}));

vi.mock('../_lib/api-helpers.js', async (orig) => {
  const actual = (await orig()) as object;
  return {
    ...actual,
    setCacheHeaders: vi.fn(),
    isMarketOpen: vi.fn(() => true),
  };
});

vi.mock('../../src/utils/timezone.js', () => ({
  getETDateStr: vi.fn(() => '2026-05-26'),
}));

import handler from '../gex-landscape.js';

/**
 * A full row in GEXBot mini_contracts shape — `value` populates
 * position-3, `prev` populates position-4 ([t-1m,t-5m,t-10m]).
 */
function row(strike: number, value: number, prev: unknown[] = []): unknown[] {
  return [strike, 0, 0, value, prev, 0, null];
}

const GAMMA_PAYLOAD = {
  mini_contracts: [
    row(5950, -1234, [-1200, -1100, -1000]),
    row(5960, 700, [650, 600, 580]),
  ],
};
const CHARM_PAYLOAD = {
  mini_contracts: [
    row(5950, 12, [11.9, 10.5, 9.8]),
    row(5960, -5, [-4.8, -4.2, -3.9]),
  ],
};
const VANNA_PAYLOAD = {
  mini_contracts: [
    row(5950, 0.45, [0.44, 0.42, 0.4]),
    row(5960, -0.2, [-0.19, -0.18, -0.17]),
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  // resetAllMocks clears the implementation we set on `mockGuardOwnerOrGuest`.
  mockGuardOwnerOrGuest.mockImplementation(async () => false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('/api/gex-landscape', () => {
  it('rejects when guard fails (no auth cookie)', async () => {
    // Simulate the guard sending a 401 itself.
    mockGuardOwnerOrGuest.mockImplementationOnce(async (_req, res, done) => {
      done({ status: 401 });
      (res as unknown as { status: (n: number) => unknown }).status(401);
      (res as unknown as { json: (b: unknown) => unknown }).json({
        error: 'Not authenticated',
      });
      return true;
    });
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Not authenticated' });
  });

  it('returns data:null + reason:no_slot when any panel is stale', async () => {
    // 1) availableMinutes → empty
    // 2-4) panel slots (gamma/charm/vanna in PANELS order) — first is empty
    mockSql.mockResolvedValue([]); // catches every call
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      data: null,
      reason: 'no_slot',
      availableMinutes: [],
    });
  });

  it('returns data:null + reason:no_spot when spot lookup yields nothing', async () => {
    const capturedAt = new Date(Date.now() - 60_000);
    // Order:
    //   1) fetchAvailableMinutes
    //   2-4) gamma/charm/vanna panel slots (Promise.all preserves order)
    //   5) fetchSpxSpot → empty
    mockSql
      .mockResolvedValueOnce([]) // availableMinutes
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: GAMMA_PAYLOAD },
      ])
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: CHARM_PAYLOAD },
      ])
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: VANNA_PAYLOAD },
      ])
      .mockResolvedValueOnce([]); // SPX spot
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ data: null, reason: 'no_spot' });
  });

  it('returns joined per-strike rows with prev fields on a complete fetch', async () => {
    const capturedAt = new Date(Date.now() - 30 * 1000);
    mockSql
      .mockResolvedValueOnce([{ minute: capturedAt }]) // availableMinutes
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: GAMMA_PAYLOAD },
      ])
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: CHARM_PAYLOAD },
      ])
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: VANNA_PAYLOAD },
      ])
      .mockResolvedValueOnce([{ close: '5947.12' }]); // SPX spot
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as {
      marketOpen: boolean;
      asOf: string;
      data: {
        strikes: Array<Record<string, number | null>>;
        spot: number;
      };
      ageSec: number;
      availableMinutes: string[];
    };
    expect(body.data).not.toBeNull();
    expect(body.data.spot).toBeCloseTo(5947.12);
    expect(body.data.strikes).toHaveLength(2);
    expect(body.data.strikes[0]).toMatchObject({
      strike: 5950,
      gamma: -1234,
      charm: 12,
      vanna: 0.45,
      gammaPrev1m: -1200,
      gammaPrev5m: -1100,
      gammaPrev10m: -1000,
      charmPrev1m: 11.9,
      charmPrev5m: 10.5,
      charmPrev10m: 9.8,
      vannaPrev1m: 0.44,
      vannaPrev5m: 0.42,
      vannaPrev10m: 0.4,
    });
    // Second-row assertion locks the per-row prev wiring so a regression
    // that drops the join past the first strike fails the test.
    expect(body.data.strikes[1]).toMatchObject({
      strike: 5960,
      gamma: 700,
      charm: -5,
      vanna: -0.2,
      gammaPrev1m: 650,
      gammaPrev5m: 600,
      gammaPrev10m: 580,
      charmPrev1m: -4.8,
      charmPrev5m: -4.2,
      charmPrev10m: -3.9,
      vannaPrev1m: -0.19,
      vannaPrev5m: -0.18,
      vannaPrev10m: -0.17,
    });
    expect(typeof body.ageSec).toBe('number');
    expect(body.ageSec).toBeGreaterThanOrEqual(0);
    expect(body.availableMinutes).toHaveLength(1);
  });

  it('zero-fills scalar values for strikes only present in one panel, leaves prev fields null', async () => {
    const capturedAt = new Date(Date.now() - 30 * 1000);
    // Gamma has 5950, charm/vanna do not. The joined row keeps gamma's
    // value + history, and charm/vanna scalars default to 0 / prev null.
    const gammaOnly = {
      mini_contracts: [row(5950, -1000, [-900, -800, -700])],
    };
    const charmOther = {
      mini_contracts: [row(5970, 5, [4, 3, 2])],
    };
    const vannaOther = {
      mini_contracts: [row(5970, 0.1, [0.09, 0.08, 0.07])],
    };
    mockSql
      .mockResolvedValueOnce([{ minute: capturedAt }]) // availableMinutes
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: gammaOnly },
      ])
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: charmOther },
      ])
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: vannaOther },
      ])
      .mockResolvedValueOnce([{ close: '5960' }]);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as {
      data: { strikes: Array<Record<string, number | null>> };
    };
    const at5950 = body.data.strikes.find((s) => s['strike'] === 5950);
    expect(at5950).toMatchObject({
      strike: 5950,
      gamma: -1000,
      charm: 0,
      vanna: 0,
      gammaPrev1m: -900,
      charmPrev1m: null,
      vannaPrev1m: null,
    });
    const at5970 = body.data.strikes.find((s) => s['strike'] === 5970);
    expect(at5970).toMatchObject({
      strike: 5970,
      gamma: 0,
      charm: 5,
      vanna: 0.1,
      gammaPrev1m: null,
      charmPrev1m: 4,
      vannaPrev1m: 0.09,
    });
  });

  it('?at=ISO resolves to a capture at-or-before the requested minute', async () => {
    // Scrub timestamp 5 minutes before "now"
    const scrubTarget = '2026-05-26T19:30:00.000Z';
    const slotAt = new Date('2026-05-26T19:29:00.000Z');
    mockSql
      .mockResolvedValueOnce([{ minute: slotAt }]) // availableMinutes
      .mockResolvedValueOnce([
        { captured_at: slotAt, raw_response: GAMMA_PAYLOAD },
      ])
      .mockResolvedValueOnce([
        { captured_at: slotAt, raw_response: CHARM_PAYLOAD },
      ])
      .mockResolvedValueOnce([
        { captured_at: slotAt, raw_response: VANNA_PAYLOAD },
      ])
      .mockResolvedValueOnce([{ close: '5945' }]);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
      query: { at: scrubTarget },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as {
      asOf: string;
      data: { strikes: Array<Record<string, number | null>>; spot: number };
    };
    // asOf reflects the captured timestamp, not "now"
    expect(body.asOf).toBe(slotAt.toISOString());
    expect(body.data.spot).toBe(5945);
    expect(body.data.strikes).toHaveLength(2);
  });

  it('?at=garbage falls back to latest (no 400)', async () => {
    const slotAt = new Date(Date.now() - 60_000);
    mockSql
      .mockResolvedValueOnce([]) // availableMinutes
      .mockResolvedValueOnce([
        { captured_at: slotAt, raw_response: GAMMA_PAYLOAD },
      ])
      .mockResolvedValueOnce([
        { captured_at: slotAt, raw_response: CHARM_PAYLOAD },
      ])
      .mockResolvedValueOnce([
        { captured_at: slotAt, raw_response: VANNA_PAYLOAD },
      ])
      .mockResolvedValueOnce([{ close: '5945' }]);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
      query: { at: 'not-a-date' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as { data: unknown };
    expect(body.data).not.toBeNull();
  });
});
