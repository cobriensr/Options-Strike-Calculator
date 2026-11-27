// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { mockRequest, mockResponse } from './helpers';

type GuardFn = (
  req: VercelRequest,
  res: VercelResponse,
  done: (opts: { status: number }) => void,
) => Promise<boolean>;

const {
  mockSql,
  mockSentryCapture,
  mockGuardOwnerOrGuest,
  mockGetClosedAnchors,
} = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockSentryCapture: vi.fn(),
  mockGuardOwnerOrGuest: vi.fn<GuardFn>(),
  mockGetClosedAnchors: vi.fn<(table: string) => Promise<unknown>>(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  TransientDbError: class TransientDbError extends Error {
    constructor(cause: unknown) {
      super(cause instanceof Error ? cause.message : String(cause));
      this.name = 'TransientDbError';
      this.cause = cause;
    }
  },
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
    increment: vi.fn(),
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

// The anchors reader is the one gexbot-queries name the handler imports.
vi.mock('../_lib/gexbot-queries.js', () => ({
  getClosedAnchors: mockGetClosedAnchors,
}));

// The closed cache rule has its own tests (live-read-cache.test.ts); here only
// the call is observed. The live rule stays real, over the mocked
// `setCacheHeaders`.
vi.mock('../_lib/live-read-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_lib/live-read-cache.js')>()),
  setClosedReadCache: vi.fn(),
}));

// Only `getETDateStr` is stubbed (one fixed date); the closed path needs the
// real `etWallClockToUtcIso`. A test that needs the real `getETDateStr` swaps
// it in with `useRealEtDate()`.
vi.mock('../../src/utils/timezone.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/utils/timezone.js')>();
  return {
    ...actual,
    getETDateStr: vi.fn(() => '2026-05-26'),
    etWallClockToUtcIso: vi.fn(actual.etWallClockToUtcIso),
  };
});

import handler from '../gex-landscape.js';
import { TransientDbError } from '../_lib/db.js';
import { setCacheHeaders, isMarketOpen } from '../_lib/api-helpers.js';
import { setClosedReadCache } from '../_lib/live-read-cache.js';
import { STALENESS_CUTOFF_MS } from '../_lib/periscope-gexbot.js';
import type { ClosedAnchors } from '../_lib/gexbot-queries.js';
import { etWallClockToUtcIso, getETDateStr } from '../../src/utils/timezone.js';

/**
 * A full row in GEXBot mini_contracts shape — `value` populates
 * position-3, `prev` populates position-4 ([t-5m,t-15m,t-30m]).
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
  // The session is open unless a test says otherwise: without this every
  // case below would take the closed path.
  vi.mocked(isMarketOpen).mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

interface LandscapeBody {
  marketOpen: boolean;
  asOf: string | null;
  data: {
    strikes: Array<Record<string, number | null>>;
    spot: number;
  } | null;
  reason?: string;
  ageSec?: number;
  availableMinutes: string[];
  lastMinuteAgeSec?: number;
}

/** The values bound into the `i`th SQL call, in placeholder order. */
function callValues(i: number): unknown[] {
  return mockSql.mock.calls[i]!.slice(1);
}

/** Every value bound into any SQL call. */
function sqlValues(): unknown[] {
  return mockSql.mock.calls.flatMap((c) => c.slice(1));
}

/** The text of every SQL call, placeholders shown as `?`. */
function sqlText(): string {
  return mockSql.mock.calls
    .map((c) => (c[0] as readonly string[]).join('?'))
    .join('\n');
}

/** Swap the stubbed one-date `getETDateStr` for the real ET formatter. */
async function useRealEtDate(): Promise<void> {
  const actual = await vi.importActual<
    typeof import('../../src/utils/timezone.js')
  >('../../src/utils/timezone.js');
  vi.mocked(getETDateStr).mockImplementation(actual.getETDateStr);
}

/** Pin `new Date()` (and so the handler's one clock reading) to `iso`. */
function setNow(iso: string): Date {
  vi.useFakeTimers({ toFake: ['Date'] });
  const now = new Date(iso);
  vi.setSystemTime(now);
  return now;
}

/** Queue the DB reads for a complete live-or-scrubbed response. */
function queueFullResponse(capturedAt: Date): void {
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
}

/** Queue the DB reads for a response with all three slots but no spot. */
function queueNoSpot(capturedAt: Date): void {
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
}

async function call(query: Record<string, string> = {}) {
  const res = mockResponse();
  await handler(
    mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
      query,
    }),
    res,
  );
  return res;
}

/** The closed-market anchors of the 2026-11-20 session (a Friday, EST). */
const SESSION = '2026-11-20';
const ANCHOR = '2026-11-20T21:00:49.000Z';
const SESSION_MIDNIGHT = '2026-11-20T05:00:00.000Z';
/** Saturday 10:00 ET: the market is closed and the session is Friday's. */
const SATURDAY = '2026-11-21T15:00:00.000Z';

function anchorsFor(
  byTicker: Array<[string, string]> = [['SPX', ANCHOR]],
): ClosedAnchors {
  return { sessionDate: SESSION, byTicker: new Map(byTicker) };
}

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
      // No capture backs a no_slot reply, so there is no capture time.
      asOf: null,
    });
    // No minute is listed, so there is no minute to measure an age from.
    expect(res._json).not.toHaveProperty('lastMinuteAgeSec');
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
    expect(res._json).toMatchObject({
      data: null,
      reason: 'no_spot',
      // The panels loaded, so the reply carries their capture time.
      asOf: capturedAt.toISOString(),
    });
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
    expect(body.asOf).toBe(capturedAt.toISOString());
    expect(body.data).not.toBeNull();
    expect(body.data.spot).toBeCloseTo(5947.12);
    expect(body.data.strikes).toHaveLength(2);
    expect(body.data.strikes[0]).toMatchObject({
      strike: 5950,
      gamma: -1234,
      charm: 12,
      vanna: 0.45,
      gammaPrev5m: -1200,
      gammaPrev15m: -1100,
      gammaPrev30m: -1000,
      charmPrev5m: 11.9,
      charmPrev15m: 10.5,
      charmPrev30m: 9.8,
      vannaPrev5m: 0.44,
      vannaPrev15m: 0.42,
      vannaPrev30m: 0.4,
    });
    // Second-row assertion locks the per-row prev wiring so a regression
    // that drops the join past the first strike fails the test.
    expect(body.data.strikes[1]).toMatchObject({
      strike: 5960,
      gamma: 700,
      charm: -5,
      vanna: -0.2,
      gammaPrev5m: 650,
      gammaPrev15m: 600,
      gammaPrev30m: 580,
      charmPrev5m: -4.8,
      charmPrev15m: -4.2,
      charmPrev30m: -3.9,
      vannaPrev5m: -0.19,
      vannaPrev15m: -0.18,
      vannaPrev30m: -0.17,
    });
    expect(typeof body.ageSec).toBe('number');
    expect(body.ageSec).toBeGreaterThanOrEqual(0);
    expect(body.availableMinutes).toHaveLength(1);
  });

  it("serves gamma, its priors, charm and vanna in GEXBot's own taker-side sign (no negation)", async () => {
    const capturedAt = new Date(Date.now() - 30 * 1000);
    mockSql
      .mockResolvedValueOnce([{ minute: capturedAt }])
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: GAMMA_PAYLOAD },
      ])
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: CHARM_PAYLOAD },
      ])
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: VANNA_PAYLOAD },
      ])
      .mockResolvedValueOnce([{ close: '5955' }]);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    const strikes = (
      res._json as { data: { strikes: Array<Record<string, number>> } }
    ).data.strikes;

    // Owner decision D1 revised (2026-10-29): GEXBot is a taker-flow
    // measure, not a market-maker position, so it is never negated.
    // The chain's taker gamma sums to -534 (-1234 + 700): net taker-short.
    const total = strikes.reduce((sum, s) => sum + s['gamma']!, 0);
    expect(total).toBe(-534);
    // 5950 went -1200 → -1234 over 5 min and -1000 → -1234 over 30 min.
    const at5950 = strikes.find((s) => s['strike'] === 5950)!;
    expect(at5950['gamma']! - at5950['gammaPrev5m']!).toBe(-34);
    expect(at5950['gamma']! - at5950['gammaPrev30m']!).toBe(-234);
    expect(at5950['charm']! - at5950['charmPrev30m']!).toBeCloseTo(2.2);
    expect(at5950['vanna']! - at5950['vannaPrev30m']!).toBeCloseTo(0.05);
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
      gammaPrev5m: -900,
      charmPrev5m: null,
      vannaPrev5m: null,
    });
    const at5970 = body.data.strikes.find((s) => s['strike'] === 5970);
    expect(at5970).toMatchObject({
      strike: 5970,
      gamma: 0,
      charm: 5,
      vanna: 0.1,
      gammaPrev5m: null,
      charmPrev5m: 4,
      vannaPrev5m: 0.09,
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

  it('returns 500 and captures the exception on a generic DB error', async () => {
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValue(dbError);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal server error' });
    expect(mockSentryCapture).toHaveBeenCalledWith(dbError);
  });

  it('returns 503 with Retry-After (and skips Sentry) on a transient DB error', async () => {
    mockSql.mockRejectedValue(
      new TransientDbError(new Error('db attempt timeout')),
    );
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(503);
    expect(res._headers['Retry-After']).toBe('5');
    expect(res._json).toEqual({
      error: 'temporarily unavailable',
      transient: true,
    });
    expect(mockSentryCapture).not.toHaveBeenCalled();
  });

  it('soft-degrades to 503 when the fetchAvailableMinutes read is transient', async () => {
    // fetchAvailableMinutes is the FIRST sql call; it is now wrapped in
    // withDbRetry so a transient blip there surfaces as a TransientDbError
    // (→ 503) instead of a raw NeonDbError that would hard-500.
    mockSql.mockRejectedValueOnce(
      new TransientDbError(new Error('db attempt timeout')),
    );
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(503);
    expect(res._headers['Retry-After']).toBe('5');
    expect(mockSentryCapture).not.toHaveBeenCalled();
  });
});

describe('/api/gex-landscape cache headers', () => {
  // A live response that carries data is cached for 10 s with no stale
  // reuse, so healthy data never sits at the edge for a minute (the panel's
  // 3-minute DELAYED threshold counts on that). A response with no data, a
  // closed market or a scrubbed minute keeps the long 300 s + 60 s window.
  const LIVE_SHORT: [number, number] = [10, 0];
  const LONG: [number, number] = [300, 60];

  it('caches a live response that carries data for 10 s with no stale reuse (in session)', async () => {
    vi.mocked(isMarketOpen).mockReturnValue(true);
    queueFullResponse(new Date(Date.now() - 30_000));
    const res = await call();
    expect((res._json as { data: unknown }).data).not.toBeNull();
    expect(setCacheHeaders).toHaveBeenCalledTimes(1);
    expect(setCacheHeaders).toHaveBeenCalledWith(res, ...LIVE_SHORT);
    expect(setClosedReadCache).not.toHaveBeenCalled();
  });

  it('caches a live no_slot response for 10 s during the session, so a recovering feed shows within seconds', async () => {
    vi.mocked(isMarketOpen).mockReturnValue(true);
    mockSql.mockResolvedValue([]);
    const res = await call();
    expect(res._json).toMatchObject({ data: null, reason: 'no_slot' });
    expect(setCacheHeaders).toHaveBeenCalledTimes(1);
    expect(setCacheHeaders).toHaveBeenCalledWith(res, ...LIVE_SHORT);
  });

  it('caches a live no_spot response for 10 s during the session', async () => {
    vi.mocked(isMarketOpen).mockReturnValue(true);
    queueNoSpot(new Date(Date.now() - 60_000));
    const res = await call();
    expect(res._json).toMatchObject({ data: null, reason: 'no_spot' });
    expect(setCacheHeaders).toHaveBeenCalledTimes(1);
    expect(setCacheHeaders).toHaveBeenCalledWith(res, ...LIVE_SHORT);
  });

  describe('a live response while the market is closed takes the closed-market cache rule', () => {
    // One clock reading per request goes into the rule, so its close and open
    // checks see a single instant. The rule itself is tested in
    // live-read-cache.test.ts.
    let now: Date;
    beforeEach(() => {
      now = setNow(SATURDAY);
      vi.mocked(isMarketOpen).mockReturnValue(false);
      mockGetClosedAnchors.mockResolvedValue(anchorsFor());
    });

    it('with data', async () => {
      queueFullResponse(new Date(ANCHOR));
      const res = await call();
      expect((res._json as { data: unknown }).data).not.toBeNull();
      expect(setClosedReadCache).toHaveBeenCalledExactlyOnceWith(res, now);
      expect(setCacheHeaders).not.toHaveBeenCalled();
    });

    it("hands the rule the request's own clock reading, not a later one", async () => {
      // The clock moves while the anchors are read. The rule must still see
      // the instant the request started at, the one `isMarketOpen()` decided on.
      mockGetClosedAnchors.mockImplementation(async () => {
        vi.setSystemTime(new Date(now.getTime() + 5_000));
        return anchorsFor();
      });
      queueFullResponse(new Date(ANCHOR));
      const res = await call();
      expect(setClosedReadCache).toHaveBeenCalledExactlyOnceWith(res, now);
    });

    it('as a no_slot (a panel has no row)', async () => {
      mockSql.mockResolvedValue([]);
      const res = await call();
      expect(res._json).toMatchObject({ data: null, reason: 'no_slot' });
      expect(setClosedReadCache).toHaveBeenCalledExactlyOnceWith(res, now);
      expect(setCacheHeaders).not.toHaveBeenCalled();
    });

    it('as a no_slot (no SPX anchor)', async () => {
      mockGetClosedAnchors.mockResolvedValue(anchorsFor([]));
      mockSql.mockResolvedValue([]);
      const res = await call();
      expect(res._json).toMatchObject({ data: null, reason: 'no_slot' });
      expect(setClosedReadCache).toHaveBeenCalledExactlyOnceWith(res, now);
      expect(setCacheHeaders).not.toHaveBeenCalled();
    });

    it('as a no_slot (an empty table)', async () => {
      mockGetClosedAnchors.mockResolvedValue(null);
      const res = await call();
      expect(res._json).toMatchObject({ data: null, reason: 'no_slot' });
      expect(setClosedReadCache).toHaveBeenCalledExactlyOnceWith(res, now);
      expect(setCacheHeaders).not.toHaveBeenCalled();
    });

    it('as a no_spot', async () => {
      queueNoSpot(new Date(ANCHOR));
      const res = await call();
      expect(res._json).toMatchObject({ data: null, reason: 'no_spot' });
      expect(setClosedReadCache).toHaveBeenCalledExactlyOnceWith(res, now);
      expect(setCacheHeaders).not.toHaveBeenCalled();
    });
  });

  it('keeps 300 s + 60 s for a scrubbed response, even in session, because a past minute never changes', async () => {
    vi.mocked(isMarketOpen).mockReturnValue(true);
    queueFullResponse(new Date('2026-05-26T19:29:00.000Z'));
    const res = await call({ at: '2026-05-26T19:30:00.000Z' });
    expect((res._json as { data: unknown }).data).not.toBeNull();
    expect(setCacheHeaders).toHaveBeenCalledTimes(1);
    expect(setCacheHeaders).toHaveBeenCalledWith(res, ...LONG);
  });

  it('keeps 300 s + 60 s for a scrubbed no_slot response in session (scrubbed beats the session rule)', async () => {
    vi.mocked(isMarketOpen).mockReturnValue(true);
    mockSql.mockResolvedValue([]);
    const res = await call({ at: '2026-05-26T08:00:00.000Z' });
    expect(res._json).toMatchObject({ data: null, reason: 'no_slot' });
    expect(setCacheHeaders).toHaveBeenCalledTimes(1);
    expect(setCacheHeaders).toHaveBeenCalledWith(res, ...LONG);
  });

  it('keeps 300 s + 60 s for a scrubbed no_spot response in session (scrubbed beats the session rule)', async () => {
    vi.mocked(isMarketOpen).mockReturnValue(true);
    queueNoSpot(new Date('2026-05-26T19:29:00.000Z'));
    const res = await call({ at: '2026-05-26T19:30:00.000Z' });
    expect(res._json).toMatchObject({ data: null, reason: 'no_spot' });
    expect(setCacheHeaders).toHaveBeenCalledTimes(1);
    expect(setCacheHeaders).toHaveBeenCalledWith(res, ...LONG);
  });

  it('treats a malformed ?at as a live request: 10 s for a response with data', async () => {
    vi.mocked(isMarketOpen).mockReturnValue(true);
    queueFullResponse(new Date(Date.now() - 60_000));
    const res = await call({ at: 'not-a-date' });
    expect((res._json as { data: unknown }).data).not.toBeNull();
    expect(setCacheHeaders).toHaveBeenCalledTimes(1);
    expect(setCacheHeaders).toHaveBeenCalledWith(res, ...LIVE_SHORT);
  });

  it('sets no cache header on a generic DB error (500)', async () => {
    mockSql.mockRejectedValue(new Error('connection refused'));
    const res = await call();
    expect(res._status).toBe(500);
    expect(mockSentryCapture).toHaveBeenCalledTimes(1);
    expect(setCacheHeaders).not.toHaveBeenCalled();
  });

  it('sets no cache header on a transient DB error (503)', async () => {
    mockSql.mockRejectedValue(
      new TransientDbError(new Error('db attempt timeout')),
    );
    const res = await call();
    expect(res._status).toBe(503);
    expect(setCacheHeaders).not.toHaveBeenCalled();
  });

  it('sets no cache header when the spot read fails after the panels loaded', async () => {
    const capturedAt = new Date(Date.now() - 60_000);
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
      .mockRejectedValueOnce(new Error('spot read failed'));
    const res = await call();
    expect(res._status).toBe(500);
    expect(setCacheHeaders).not.toHaveBeenCalled();
  });
});

describe('/api/gex-landscape after the close', () => {
  // The panel's lower bound is ET midnight of the session date, as an instant.
  const PANEL_CATEGORIES = ['gamma_zero', 'charm_zero', 'vanna_zero'];

  beforeEach(() => {
    setNow(SATURDAY);
    vi.mocked(isMarketOpen).mockReturnValue(false);
    mockGetClosedAnchors.mockResolvedValue(anchorsFor());
  });

  it("reads each panel at or before the SPX anchor, on the anchor's session date", async () => {
    queueFullResponse(new Date(ANCHOR));
    const res = await call();
    const body = res._json as LandscapeBody;

    expect(res._status).toBe(200);
    expect(body.marketOpen).toBe(false);
    // The capture time, not the server clock.
    expect(body.asOf).toBe(ANCHOR);
    expect(body.data).not.toBeNull();
    expect(body.data!.spot).toBeCloseTo(5947.12);
    expect(body.data!.strikes).toHaveLength(2);
    expect(mockGetClosedAnchors).toHaveBeenCalledExactlyOnceWith(
      'gexbot_api_capture',
    );

    // Call 0 lists the session's minutes; calls 1-3 are the panels, each
    // bound between ET midnight of the session and the anchor; call 4 is the
    // spot, on the session date and as of the capture.
    expect(callValues(0)).toEqual(['SPX', SESSION]);
    PANEL_CATEGORIES.forEach((category, i) => {
      expect(callValues(i + 1)).toEqual([
        'SPX',
        category,
        SESSION_MIDNIGHT,
        ANCHOR,
      ]);
    });
    expect(callValues(4)).toEqual([SESSION, ANCHOR]);
    expect(mockSql).toHaveBeenCalledTimes(5);
  });

  it("ends each panel read after the anchor's whole millisecond", async () => {
    // `captured_at` is `now()` and keeps microseconds; the anchor travels as a
    // millisecond ISO string. A plain `<= anchor` would drop the anchor row
    // itself in production (gex-landscape-pglite.test.ts proves it on real SQL).
    queueFullResponse(new Date(ANCHOR));
    await call();
    expect(sqlText()).toContain(
      "captured_at < ?::timestamptz + INTERVAL '1 millisecond'",
    );
  });

  it.each([
    ['an empty table', null],
    ['a table with no anchored ticker', anchorsFor([])],
    ['no SPX anchor', anchorsFor([['NDX', '2026-11-20T21:00:50.000Z']])],
  ])('%s returns no_slot with asOf null', async (_label, anchors) => {
    mockGetClosedAnchors.mockResolvedValue(anchors);
    // Only a table with a session date can list that session's minutes.
    if (anchors !== null) {
      mockSql.mockResolvedValueOnce([{ minute: new Date(ANCHOR) }]);
    }
    const res = await call();
    const body = res._json as LandscapeBody;

    expect(res._status).toBe(200);
    expect(body).toMatchObject({
      marketOpen: false,
      asOf: null,
      data: null,
      reason: 'no_slot',
    });
    if (anchors === null) {
      // Nothing is stored, so there is nothing to list or to read.
      expect(body.availableMinutes).toEqual([]);
      expect(body).not.toHaveProperty('lastMinuteAgeSec');
      expect(mockSql).not.toHaveBeenCalled();
    } else {
      // The session's minutes are listed, so the panel can still step back.
      // The panels are not read: no anchor, no row to look for.
      expect(body.availableMinutes).toEqual([ANCHOR]);
      expect(callValues(0)).toEqual(['SPX', SESSION]);
      expect(mockSql).toHaveBeenCalledTimes(1);
    }
  });

  it('returns no_slot when one panel has no row on the session, never an older session', async () => {
    // The panel reads are bounded to the session, so a vanna row from the
    // day before is out of range and the read comes back empty.
    mockSql
      .mockResolvedValueOnce([{ minute: new Date(ANCHOR) }])
      .mockResolvedValueOnce([
        { captured_at: new Date(ANCHOR), raw_response: GAMMA_PAYLOAD },
      ])
      .mockResolvedValueOnce([
        { captured_at: new Date(ANCHOR), raw_response: CHARM_PAYLOAD },
      ])
      .mockResolvedValueOnce([]);
    const res = await call();
    expect(res._json).toMatchObject({
      marketOpen: false,
      asOf: null,
      data: null,
      reason: 'no_slot',
    });
    // The spot is never read for a reply with no slot.
    expect(mockSql).toHaveBeenCalledTimes(4);
  });

  it('carries the capture time on a no_spot reply', async () => {
    queueNoSpot(new Date(ANCHOR));
    const res = await call();
    expect(res._json).toMatchObject({
      data: null,
      reason: 'no_spot',
      asOf: ANCHOR,
    });
    // The spot was looked up on the session date, as of the capture.
    expect(callValues(4)).toEqual([SESSION, ANCHOR]);
  });

  it('measures the age of the last listed minute on the server clock', async () => {
    mockGetClosedAnchors.mockResolvedValue(anchorsFor([]));
    mockSql.mockResolvedValueOnce([
      { minute: new Date('2026-11-20T20:59:00.000Z') },
      { minute: new Date('2026-11-20T21:00:00.000Z') },
    ]);
    const res = await call();
    // Friday 21:00:00Z to Saturday 15:00:00Z: 18 hours.
    expect((res._json as LandscapeBody).lastMinuteAgeSec).toBe(18 * 3600);
  });

  describe('failures surface by name', () => {
    it('answers 500 and captures the exception when the anchors read rejects', async () => {
      const error = new Error('anchors read failed');
      mockGetClosedAnchors.mockRejectedValue(error);
      const res = await call();
      expect(res._status).toBe(500);
      expect(res._json).toEqual({ error: 'Internal server error' });
      expect(mockSentryCapture).toHaveBeenCalledExactlyOnceWith(error);
      expect(mockSql).not.toHaveBeenCalled();
      // An error reply sets no cache header of either kind.
      expect(setClosedReadCache).not.toHaveBeenCalled();
      expect(setCacheHeaders).not.toHaveBeenCalled();
    });

    it('answers 503 and skips Sentry when the anchors read is transient', async () => {
      mockGetClosedAnchors.mockRejectedValue(
        new TransientDbError(new Error('db attempt timeout')),
      );
      const res = await call();
      expect(res._status).toBe(503);
      expect(res._headers['Retry-After']).toBe('5');
      expect(mockSentryCapture).not.toHaveBeenCalled();
      expect(setClosedReadCache).not.toHaveBeenCalled();
    });

    it('answers 500 and captures the exception when a panel read rejects', async () => {
      const error = new Error('panel read failed');
      mockSql
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(error)
        .mockResolvedValue([]);
      const res = await call();
      expect(res._status).toBe(500);
      expect(mockSentryCapture).toHaveBeenCalledExactlyOnceWith(error);
      expect(setClosedReadCache).not.toHaveBeenCalled();
    });

    it('answers 500 and captures the exception when the session has no ET midnight', async () => {
      // Cannot happen for a date the formatter or the database produced; if it
      // ever does, the reply must not fall back to an unbounded read.
      vi.mocked(etWallClockToUtcIso).mockReturnValueOnce(null);
      const res = await call();
      expect(res._status).toBe(500);
      expect(mockSentryCapture).toHaveBeenCalledTimes(1);
      expect(String(mockSentryCapture.mock.calls[0]![0])).toContain(SESSION);
      // Nothing was read.
      expect(mockSql).not.toHaveBeenCalled();
      expect(setClosedReadCache).not.toHaveBeenCalled();
    });
  });
});

describe('/api/gex-landscape ?at= scrub stays inside its own session', () => {
  // The session date is the ET date of `at`, not the date of the row found:
  // scrub options are whole minutes and captures land about 49 s into the
  // minute, so a session's first option finds the previous session's last row.
  beforeEach(async () => {
    await useRealEtDate();
  });

  it.each([
    // [label, open, at, ET date of at, ET midnight as an instant]
    [
      "a session's first minute (EST)",
      true,
      '2026-11-23T14:30:00.000Z',
      '2026-11-23',
      '2026-11-23T05:00:00.000Z',
    ],
    [
      "a session's first minute (EDT)",
      true,
      '2026-06-15T13:30:00.000Z',
      '2026-06-15',
      '2026-06-15T04:00:00.000Z',
    ],
    [
      'an evening ET minute that is already the next UTC date',
      true,
      '2026-11-24T01:30:00.000Z',
      '2026-11-23',
      '2026-11-23T05:00:00.000Z',
    ],
    [
      'a scrub with the market closed (the scrub wins over the closed rule)',
      false,
      '2026-11-23T14:30:00.000Z',
      '2026-11-23',
      '2026-11-23T05:00:00.000Z',
    ],
  ])(
    'reads no_slot (not the prior session) at %s',
    async (_label, open, at, etDate, midnight) => {
      vi.mocked(isMarketOpen).mockReturnValue(open);
      // The bounded panel reads find nothing: the only rows are the prior
      // session's, which the bound keeps out.
      mockSql.mockResolvedValue([]);
      const res = await call({ at });
      const body = res._json as LandscapeBody;

      expect(res._status).toBe(200);
      expect(body).toMatchObject({ data: null, reason: 'no_slot', asOf: null });
      // Minutes and each panel use the date of `at`.
      expect(callValues(0)).toEqual(['SPX', etDate]);
      ['gamma_zero', 'charm_zero', 'vanna_zero'].forEach((category, i) => {
        expect(callValues(i + 1)).toEqual(['SPX', category, midnight, at]);
      });
      expect(sqlValues()).toContain(midnight);
      // A scrub never asks for the closed anchors, and keeps the scrub cache.
      expect(mockGetClosedAnchors).not.toHaveBeenCalled();
      expect(setClosedReadCache).not.toHaveBeenCalled();
      expect(setCacheHeaders).toHaveBeenCalledExactlyOnceWith(res, 300, 60);
    },
  );

  it('serves the scrubbed capture, with the spot on the scrub date, as of the capture', async () => {
    const at = '2026-11-23T14:31:00.000Z';
    const slotAt = new Date('2026-11-23T14:30:49.000Z');
    queueFullResponse(slotAt);
    const res = await call({ at });
    const body = res._json as LandscapeBody;

    expect(body.asOf).toBe(slotAt.toISOString());
    expect(body.data).not.toBeNull();
    expect(callValues(1)).toEqual([
      'SPX',
      'gamma_zero',
      '2026-11-23T05:00:00.000Z',
      at,
    ]);
    expect(callValues(4)).toEqual(['2026-11-23', slotAt.toISOString()]);
  });

  it('carries the capture time on a scrubbed no_spot reply', async () => {
    const slotAt = new Date('2026-11-23T14:30:49.000Z');
    queueNoSpot(slotAt);
    const res = await call({ at: '2026-11-23T14:31:00.000Z' });
    expect(res._json).toMatchObject({
      data: null,
      reason: 'no_spot',
      asOf: slotAt.toISOString(),
    });
  });
});

describe('/api/gex-landscape in the session', () => {
  it('keeps the staleness floor and today, and never asks for the closed anchors', async () => {
    const now = setNow('2026-11-23T16:06:00.000Z');
    await useRealEtDate();
    queueFullResponse(new Date('2026-11-23T16:05:49.000Z'));
    const res = await call();
    const body = res._json as LandscapeBody;

    expect(body.asOf).toBe('2026-11-23T16:05:49.000Z');
    expect(body.ageSec).toBe(11);
    // Today's minutes; each panel bounded only by the staleness cutoff.
    expect(callValues(0)).toEqual(['SPX', '2026-11-23']);
    const cutoff = new Date(now.getTime() - STALENESS_CUTOFF_MS).toISOString();
    ['gamma_zero', 'charm_zero', 'vanna_zero'].forEach((category, i) => {
      expect(callValues(i + 1)).toEqual(['SPX', category, cutoff]);
    });
    expect(callValues(4)).toEqual(['2026-11-23', '2026-11-23T16:05:49.000Z']);
    expect(mockGetClosedAnchors).not.toHaveBeenCalled();
    expect(setClosedReadCache).not.toHaveBeenCalled();
    expect(setCacheHeaders).toHaveBeenCalledExactlyOnceWith(res, 10, 0);
  });

  it("an in-session no_slot lists the day's minutes and their server-measured age", async () => {
    setNow('2026-11-23T16:06:00.000Z');
    await useRealEtDate();
    // The feed stalled: minutes up to 16:00:00Z are stored, no panel is fresh.
    mockSql
      .mockResolvedValueOnce([
        { minute: new Date('2026-11-23T15:59:00.000Z') },
        { minute: new Date('2026-11-23T16:00:00.000Z') },
      ])
      .mockResolvedValue([]);
    const res = await call();

    expect(res._json).toEqual({
      marketOpen: true,
      asOf: null,
      data: null,
      reason: 'no_slot',
      availableMinutes: [
        '2026-11-23T15:59:00.000Z',
        '2026-11-23T16:00:00.000Z',
      ],
      lastMinuteAgeSec: 360,
    });
    expect(setCacheHeaders).toHaveBeenCalledExactlyOnceWith(res, 10, 0);
  });
});
