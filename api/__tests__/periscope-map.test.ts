// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockSentryCapture, TransientDbError, mockGetClosedAnchors } =
  vi.hoisted(() => {
    class TransientDbError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'TransientDbError';
      }
    }
    return {
      mockSql: vi.fn(),
      mockSentryCapture: vi.fn(),
      TransientDbError,
      mockGetClosedAnchors: vi.fn<(table: string) => Promise<unknown>>(),
    };
  });

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  TransientDbError,
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
  guardOwnerOrGuestEndpoint: vi.fn(async () => false),
}));

vi.mock('../_lib/api-helpers.js', async (orig) => {
  const actual = (await orig()) as object;
  return {
    ...actual,
    setCacheHeaders: vi.fn(),
    isMarketOpen: vi.fn(() => true),
  };
});

// The anchors reader is the one gexbot-queries name the closed read imports.
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

// The view builder is real; it is wrapped only so a test can read the slices
// handed to it (the prior slice's date stamp reaches no field of the reply).
vi.mock('../_lib/periscope-format.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../_lib/periscope-format.js')>();
  return {
    ...actual,
    computePeriscopeView: vi.fn(actual.computePeriscopeView),
  };
});

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

import handler from '../periscope-map.js';
import { setCacheHeaders, isMarketOpen } from '../_lib/api-helpers.js';
import { setClosedReadCache } from '../_lib/live-read-cache.js';
import { computePeriscopeView } from '../_lib/periscope-format.js';
import logger from '../_lib/logger.js';
import { STALENESS_CUTOFF_MS } from '../_lib/periscope-gexbot.js';
import type { ClosedAnchors } from '../_lib/gexbot-queries.js';
import { etWallClockToUtcIso, getETDateStr } from '../../src/utils/timezone.js';

const PAYLOAD = {
  mini_contracts: [
    [7510, 0, 0, 500_000, [], 0, null],
    [7520, 1, 1, 1_250_000, [], 0, null],
    [7505, 0, 0, -800_000, [], 0, null],
  ],
};

/** A `cone_levels` row, as the driver returns it (NUMERIC arrives as strings). */
const CONE_ROW = {
  cone_upper: '7600',
  cone_lower: '7400',
  cone_width: '200',
  asymmetry_pts: '0',
  spot_at_calc: '7500',
};

beforeEach(() => {
  vi.resetAllMocks();
  process.env.CRON_SECRET = 'test-secret';
  // The session is open unless a test says otherwise: without this every case
  // below would take the closed path.
  vi.mocked(isMarketOpen).mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

interface MapBody {
  marketOpen: boolean;
  asOf: string | null;
  data: {
    expiry: string;
    capturedAt: string;
    priorCapturedAt: string | null;
  } | null;
  reason?: string;
  ageSec?: number;
  priorAvailable?: boolean;
  availableSlots: string[];
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

/**
 * The date each of the four date-keyed reads was given, in the order the
 * handler reads them: the slot list, the spot, the cone and its breaches. A
 * read that never happened shows as `undefined`.
 */
function dateArgsOfEveryDateQuery(): unknown[] {
  const tables = [
    'periscope_snapshots',
    'index_candles_1m',
    'cone_levels',
    'cone_breach_events',
  ];
  return tables.map(
    (table) =>
      mockSql.mock.calls.find((c) =>
        (c[0] as readonly string[]).join('?').includes(table),
      )?.[1],
  );
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

/**
 * Queue the reads for a complete response. With `priorAndCone` it also queues
 * the prior slice and a cone, so the cone's breaches are read too; without it
 * every read after the spot returns no rows (no prior, no cone).
 */
function queueFullResponse(
  capturedAt: Date,
  opts: { priorAndCone?: boolean } = {},
): void {
  mockSql
    .mockResolvedValueOnce([]) // availableSlots
    .mockResolvedValueOnce([{ captured_at: capturedAt, raw_response: PAYLOAD }])
    .mockResolvedValueOnce([{ captured_at: capturedAt, raw_response: PAYLOAD }])
    .mockResolvedValueOnce([{ captured_at: capturedAt, raw_response: PAYLOAD }])
    .mockResolvedValueOnce([{ close: '7515' }]); // SPX spot
  if (opts.priorAndCone) {
    const priorAt = new Date(capturedAt.getTime() - 12 * 60_000);
    mockSql
      .mockResolvedValueOnce([{ captured_at: priorAt, raw_response: PAYLOAD }])
      .mockResolvedValueOnce([{ captured_at: priorAt, raw_response: PAYLOAD }])
      .mockResolvedValueOnce([{ captured_at: priorAt, raw_response: PAYLOAD }])
      .mockResolvedValueOnce([CONE_ROW]); // cone levels; breaches default to []
  }
  mockSql.mockResolvedValue([]);
}

/** Queue the reads for fresh panels but no SPX candle. */
function queueNoSpot(capturedAt: Date): void {
  mockSql
    .mockResolvedValueOnce([]) // availableSlots
    .mockResolvedValueOnce([{ captured_at: capturedAt, raw_response: PAYLOAD }])
    .mockResolvedValueOnce([{ captured_at: capturedAt, raw_response: PAYLOAD }])
    .mockResolvedValueOnce([{ captured_at: capturedAt, raw_response: PAYLOAD }])
    .mockResolvedValueOnce([]); // SPX spot
}

async function call() {
  const res = mockResponse();
  await handler(
    mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
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
const PANEL_CATEGORIES = ['gamma_zero', 'charm_zero', 'vanna_zero'];

function anchorsFor(
  byTicker: Array<[string, string]> = [['SPX', ANCHOR]],
): ClosedAnchors {
  return { sessionDate: SESSION, byTicker: new Map(byTicker) };
}

describe('/api/periscope-map', () => {
  it('returns reason:no_slot + empty data when no fresh gexbot row', async () => {
    // 1 SELECT per panel (gamma/charm/vanna) — all return []. Then a
    // SELECT for fetchAvailableSlots — returns []. ALL must be mocked
    // because handler returns early after panel-1 miss but the
    // availableSlots SELECT was already issued.
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
      availableSlots: [],
      // No capture backs a no_slot reply, so there is no capture time.
      asOf: null,
    });
  });

  it('returns reason:no_spot when fresh gexbot exists but no SPX candle', async () => {
    const capturedAt = new Date(Date.now() - 60_000);
    // mockSql is queried in this order:
    //   1) fetchAvailableSlots SELECT (returns [])
    //   2-4) latest gexbot per panel × 3
    //   5) fetchSpxSpot SELECT (returns [])
    mockSql
      .mockResolvedValueOnce([]) // availableSlots
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: PAYLOAD },
      ]) // gamma
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: PAYLOAD },
      ]) // charm
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: PAYLOAD },
      ]) // vanna
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

  it('returns populated data + ageSec + priorAvailable on a complete fetch', async () => {
    const latestAt = new Date(Date.now() - 30 * 1000); // 30s ago
    const priorAt = new Date(Date.now() - 12 * 60 * 1000); // 12 min ago
    mockSql
      .mockResolvedValueOnce([]) // availableSlots
      .mockResolvedValueOnce([{ captured_at: latestAt, raw_response: PAYLOAD }]) // gamma latest
      .mockResolvedValueOnce([{ captured_at: latestAt, raw_response: PAYLOAD }]) // charm latest
      .mockResolvedValueOnce([{ captured_at: latestAt, raw_response: PAYLOAD }]) // vanna latest
      .mockResolvedValueOnce([{ close: '7515' }]) // SPX spot
      .mockResolvedValueOnce([{ captured_at: priorAt, raw_response: PAYLOAD }]) // gamma prior
      .mockResolvedValueOnce([{ captured_at: priorAt, raw_response: PAYLOAD }]) // charm prior
      .mockResolvedValueOnce([{ captured_at: priorAt, raw_response: PAYLOAD }]) // vanna prior
      .mockResolvedValueOnce([]) // cone levels
      // no cone => no cone-breaches query issued
      .mockResolvedValueOnce([]); // (fallthrough for safety)
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.data).not.toBeNull();
    expect(typeof body.ageSec).toBe('number');
    expect(body.ageSec).toBeGreaterThanOrEqual(0);
    expect(body.priorAvailable).toBe(true);
    // The capture time, not the server clock.
    expect(body.asOf).toBe(latestAt.toISOString());
  });

  it("builds the gamma topology from GEXBot's own taker-side sign (no negation)", async () => {
    const latestAt = new Date(Date.now() - 30 * 1000);
    mockSql
      .mockResolvedValueOnce([]) // availableSlots
      .mockResolvedValueOnce([{ captured_at: latestAt, raw_response: PAYLOAD }])
      .mockResolvedValueOnce([{ captured_at: latestAt, raw_response: PAYLOAD }])
      .mockResolvedValueOnce([{ captured_at: latestAt, raw_response: PAYLOAD }])
      .mockResolvedValueOnce([{ close: '7515' }])
      .mockResolvedValue([]); // no prior, no cone
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    const view = (
      res._json as {
        data: {
          gamma: {
            ceiling: { strike: number; value: number } | null;
            floor: { strike: number; value: number } | null;
            accelTop: Array<{ strike: number; value: number }>;
          };
          charm: { topByAbs: Array<{ strike: number; value: number }> };
        };
      }
    ).data;

    // Taker gamma as GEXBot reports it (D1 revised: never negated):
    // 7510 +500K, 7520 +1.25M, 7505 −800K at spot 7515.
    expect(view.gamma.ceiling).toMatchObject({
      strike: 7520,
      value: 1_250_000,
    });
    expect(view.gamma.floor).toMatchObject({ strike: 7510, value: 500_000 });
    expect(view.gamma.accelTop.map((r) => [r.strike, r.value])).toEqual([
      [7505, -800_000],
    ]);
    expect(view.charm.topByAbs[0]).toEqual({ strike: 7520, value: 1_250_000 });
  });

  it('returns 503 + Retry-After on a transient DB error', async () => {
    mockSql.mockRejectedValue(new TransientDbError('db attempt timeout'));
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(503);
    expect(res._headers['Retry-After']).toBe('5');
    const body = res._json as { transient?: boolean };
    expect(body.transient).toBe(true);
  });

  it('returns 500 on a generic DB error', async () => {
    mockSql.mockRejectedValue(new Error('Neon pool exhausted'));
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
  });

  it('sets priorAvailable=false when no qualifying prior slice exists', async () => {
    const latestAt = new Date(Date.now() - 30 * 1000);
    mockSql
      .mockResolvedValueOnce([]) // availableSlots
      .mockResolvedValueOnce([{ captured_at: latestAt, raw_response: PAYLOAD }])
      .mockResolvedValueOnce([{ captured_at: latestAt, raw_response: PAYLOAD }])
      .mockResolvedValueOnce([{ captured_at: latestAt, raw_response: PAYLOAD }])
      .mockResolvedValueOnce([{ close: '7515' }])
      .mockResolvedValueOnce([]) // prior gamma — no row in 10-30 min window
      .mockResolvedValue([]); // every remaining call → []
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.priorAvailable).toBe(false);
  });
});

describe('/api/periscope-map cache headers', () => {
  // A live response that carries data, or any live response during the
  // session, is cached 10 s with no stale reuse. A response with the market
  // closed takes the closed-market rule (`setClosedReadCache`), whatever its
  // body. An error sets no cache header.
  const LIVE_SHORT: [number, number] = [10, 0];

  it('caches a live response that carries data for 10 s with no stale reuse (in session)', async () => {
    vi.mocked(isMarketOpen).mockReturnValue(true);
    queueFullResponse(new Date(Date.now() - 30_000));
    const res = await call();
    expect((res._json as { data: unknown }).data).not.toBeNull();
    expect(setCacheHeaders).toHaveBeenCalledTimes(1);
    expect(setCacheHeaders).toHaveBeenCalledWith(res, ...LIVE_SHORT);
    expect(setClosedReadCache).not.toHaveBeenCalled();
  });

  it.each(['no_slot', 'no_spot'] as const)(
    'caches a live %s response for 10 s during the session, so a recovering feed shows within seconds',
    async (reason) => {
      vi.mocked(isMarketOpen).mockReturnValue(true);
      if (reason === 'no_slot') mockSql.mockResolvedValue([]);
      else queueNoSpot(new Date(Date.now() - 60_000));
      const res = await call();
      expect(res._json).toMatchObject({ data: null, reason });
      expect(setCacheHeaders).toHaveBeenCalledTimes(1);
      expect(setCacheHeaders).toHaveBeenCalledWith(res, ...LIVE_SHORT);
      expect(setClosedReadCache).not.toHaveBeenCalled();
    },
  );

  describe('a response while the market is closed takes the closed-market cache rule', () => {
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

  it('sets no cache header on a transient DB error (503)', async () => {
    mockSql.mockRejectedValue(new TransientDbError('db attempt timeout'));
    const res = await call();
    expect(res._status).toBe(503);
    expect(setCacheHeaders).not.toHaveBeenCalled();
  });

  it('sets no cache header on a generic DB error (500)', async () => {
    mockSql.mockRejectedValue(new Error('Neon pool exhausted'));
    const res = await call();
    expect(res._status).toBe(500);
    expect(mockSentryCapture).toHaveBeenCalledTimes(1);
    expect(setCacheHeaders).not.toHaveBeenCalled();
  });

  it('sets no cache header when a later read fails after the panels loaded', async () => {
    const capturedAt = new Date(Date.now() - 60_000);
    mockSql
      .mockResolvedValueOnce([]) // availableSlots
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: PAYLOAD },
      ])
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: PAYLOAD },
      ])
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: PAYLOAD },
      ])
      .mockRejectedValueOnce(new Error('spot read failed'));
    const res = await call();
    expect(res._status).toBe(500);
    expect(setCacheHeaders).not.toHaveBeenCalled();
  });
});

describe('/api/periscope-map after the close', () => {
  beforeEach(() => {
    setNow(SATURDAY);
    vi.mocked(isMarketOpen).mockReturnValue(false);
    mockGetClosedAnchors.mockResolvedValue(anchorsFor());
  });

  it('on a Saturday uses the session date everywhere', async () => {
    queueFullResponse(new Date(ANCHOR), { priorAndCone: true });
    const res = await call();
    const body = res._json as MapBody;

    expect(res._status).toBe(200);
    expect(body.marketOpen).toBe(false);
    expect(body.data).not.toBeNull();
    // The map is stamped with the session's date, not Saturday's (the stubbed
    // `getETDateStr` would answer 2026-05-26 for any date use that fell back).
    expect(body.data!.expiry).toBe(SESSION);
    // The slot list, the spot, the cone and its breaches.
    expect(dateArgsOfEveryDateQuery()).toEqual([
      SESSION,
      SESSION,
      SESSION,
      SESSION,
    ]);
    expect(mockGetClosedAnchors).toHaveBeenCalledExactlyOnceWith(
      'gexbot_api_capture',
    );
  });

  it("stamps the latest and the prior slice with the session's date", async () => {
    queueFullResponse(new Date(ANCHOR), { priorAndCone: true });
    await call();
    // The prior slice's stamp reaches no field of the reply, so it is read at
    // the view builder, where both slices go in.
    expect(computePeriscopeView).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        latest: expect.objectContaining({ expiry: SESSION }),
        prior: expect.objectContaining({ expiry: SESSION }),
      }),
    );
  });

  it("serves the anchor's capture time as asOf, never the server clock", async () => {
    queueFullResponse(new Date(ANCHOR));
    const res = await call();
    const body = res._json as MapBody;
    expect(body.asOf).toBe(ANCHOR);
    expect(body.data!.capturedAt).toBe(ANCHOR);
  });

  it('bounds each panel read by the anchor and the ET midnight of the session', async () => {
    queueFullResponse(new Date(ANCHOR), { priorAndCone: true });
    await call();

    // Call 0 lists the session's slots; calls 1-3 are the panels, each bound
    // between ET midnight of the session and the anchor; call 4 is the spot,
    // on the session date and as of the capture.
    expect(callValues(0)).toEqual([SESSION]);
    PANEL_CATEGORIES.forEach((category, i) => {
      expect(callValues(i + 1)).toEqual([
        'SPX',
        category,
        SESSION_MIDNIGHT,
        ANCHOR,
      ]);
    });
    expect(callValues(4)).toEqual([SESSION, ANCHOR]);
    // The upper bound is the anchor itself; the lower bound keeps a
    // Thursday panel out from under Friday's label.
    expect(sqlValues()).toContain(ANCHOR);
    expect(sqlValues()).toContain(SESSION_MIDNIGHT);
  });

  it('measures the prior slice from the capture, not from the server clock', async () => {
    queueFullResponse(new Date(ANCHOR), { priorAndCone: true });
    await call();
    // Calls 5-7: the prior panels, 10 to 30 minutes before the anchor.
    PANEL_CATEGORIES.forEach((category, i) => {
      expect(callValues(i + 5)).toEqual([
        'SPX',
        category,
        '2026-11-20T20:50:49.000Z',
        '2026-11-20T20:30:49.000Z',
      ]);
    });
  });

  it("ends each panel read after the anchor's whole millisecond", async () => {
    // `captured_at` is `now()` and keeps microseconds; the anchor travels as a
    // millisecond ISO string. A plain `<= anchor` would drop the anchor row
    // itself in production (gex-landscape-pglite.test.ts proves it on real SQL
    // for the same predicate).
    queueFullResponse(new Date(ANCHOR));
    await call();
    expect(sqlText()).toContain(
      "captured_at < ?::timestamptz + INTERVAL '1 millisecond'",
    );
  });

  describe('with no SPX anchor', () => {
    const NO_SPX_ANCHOR_MESSAGE =
      'periscope-map: no SPX anchor for the closed market — returning no_slot';

    /** Reply `no_slot` with no capture time; the panels are never read. */
    function expectNoSlot(res: ReturnType<typeof mockResponse>): MapBody {
      const body = res._json as MapBody;
      expect(res._status).toBe(200);
      expect(body).toMatchObject({
        marketOpen: false,
        asOf: null,
        data: null,
        reason: 'no_slot',
      });
      return body;
    }

    it('an empty table returns no_slot and reads nothing', async () => {
      mockGetClosedAnchors.mockResolvedValue(null);
      const res = await call();
      const body = expectNoSlot(res);

      // Nothing is stored, so there is nothing to list or to read.
      expect(body.availableSlots).toEqual([]);
      expect(mockSql).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        { ticker: 'SPX', sessionDate: null },
        NO_SPX_ANCHOR_MESSAGE,
      );
    });

    it('a table with no anchored ticker lists the session and reads no panel', async () => {
      mockGetClosedAnchors.mockResolvedValue(anchorsFor([]));
      mockSql.mockResolvedValueOnce([{ captured_at: new Date(ANCHOR) }]);
      const res = await call();
      const body = expectNoSlot(res);

      // The session's slots are listed, so the panel can still step back.
      // The panels are not read: no anchor, no row to look for.
      expect(body.availableSlots).toEqual([ANCHOR]);
      expect(callValues(0)).toEqual([SESSION]);
      expect(mockSql).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        { ticker: 'SPX', sessionDate: SESSION },
        NO_SPX_ANCHOR_MESSAGE,
      );
    });

    it("another ticker's anchor is not SPX's: the session is listed and no panel is read", async () => {
      mockGetClosedAnchors.mockResolvedValue(
        anchorsFor([['NDX', '2026-11-20T21:00:50.000Z']]),
      );
      mockSql.mockResolvedValueOnce([{ captured_at: new Date(ANCHOR) }]);
      const res = await call();
      const body = expectNoSlot(res);

      expect(body.availableSlots).toEqual([ANCHOR]);
      expect(callValues(0)).toEqual([SESSION]);
      expect(mockSql).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        { ticker: 'SPX', sessionDate: SESSION },
        NO_SPX_ANCHOR_MESSAGE,
      );
    });
  });

  it('returns no_slot when one panel has no row on the session, never an older session', async () => {
    // The panel reads are bounded to the session, so a vanna row from the
    // day before is out of range and the read comes back empty.
    mockSql
      .mockResolvedValueOnce([]) // availableSlots
      .mockResolvedValueOnce([
        { captured_at: new Date(ANCHOR), raw_response: PAYLOAD },
      ])
      .mockResolvedValueOnce([
        { captured_at: new Date(ANCHOR), raw_response: PAYLOAD },
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
        new TransientDbError('db attempt timeout'),
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
      // Cannot happen for a date the database produced; if it ever does, the
      // reply must not fall back to an unbounded read.
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

describe('/api/periscope-map in the session', () => {
  it('keeps the staleness floor and today, and never asks for the closed anchors', async () => {
    const now = setNow('2026-11-23T16:06:00.000Z');
    await useRealEtDate();
    queueFullResponse(new Date('2026-11-23T16:05:49.000Z'), {
      priorAndCone: true,
    });
    const res = await call();
    const body = res._json as MapBody;

    expect(body.asOf).toBe('2026-11-23T16:05:49.000Z');
    expect(body.ageSec).toBe(11);
    expect(body.data!.expiry).toBe('2026-11-23');
    // Today's date everywhere; each panel bounded only by the staleness cutoff.
    expect(dateArgsOfEveryDateQuery()).toEqual([
      '2026-11-23',
      '2026-11-23',
      '2026-11-23',
      '2026-11-23',
    ]);
    const cutoff = new Date(now.getTime() - STALENESS_CUTOFF_MS).toISOString();
    PANEL_CATEGORIES.forEach((category, i) => {
      expect(callValues(i + 1)).toEqual(['SPX', category, cutoff]);
    });
    expect(mockGetClosedAnchors).not.toHaveBeenCalled();
    expect(setClosedReadCache).not.toHaveBeenCalled();
    expect(setCacheHeaders).toHaveBeenCalledExactlyOnceWith(res, 10, 0);
  });

  it('an in-session no_slot lists the days slots, with no capture time', async () => {
    setNow('2026-11-23T16:06:00.000Z');
    await useRealEtDate();
    // The feed stalled: slots up to 16:00:00Z are stored, no panel is fresh.
    mockSql
      .mockResolvedValueOnce([
        { captured_at: new Date('2026-11-23T15:50:00.000Z') },
        { captured_at: new Date('2026-11-23T16:00:00.000Z') },
      ])
      .mockResolvedValue([]);
    const res = await call();

    expect(res._json).toEqual({
      marketOpen: true,
      asOf: null,
      data: null,
      reason: 'no_slot',
      availableSlots: ['2026-11-23T15:50:00.000Z', '2026-11-23T16:00:00.000Z'],
    });
    expect(setCacheHeaders).toHaveBeenCalledExactlyOnceWith(res, 10, 0);
  });
});
