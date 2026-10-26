// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StrikeExposureRow } from '../_lib/db-strike-helpers.js';
import { mockRequest, mockResponse } from './helpers';

// BotID's verdict is mocked at its package boundary; checkBot only consults
// it on Vercel (process.env.VERCEL set) for non-owner requests.
const { checkBotIdMock } = vi.hoisted(() => ({
  checkBotIdMock: vi.fn<() => Promise<{ isBot: boolean }>>(async () => ({
    isBot: false,
  })),
}));
vi.mock('botid/server', () => ({
  checkBotId: checkBotIdMock,
}));

// The guard is mocked at the module boundary, but it wraps the real
// implementation: bot, owner, guest and anonymous requests all run through
// the real checks, and the spy shows the handler called it.
vi.mock('../_lib/api-helpers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../_lib/api-helpers.js')>();
  return {
    ...actual,
    guardOwnerOrGuestEndpoint: vi.fn(actual.guardOwnerOrGuestEndpoint),
  };
});

vi.mock('../_lib/db-strike-helpers.js', () => ({
  getStrikeExposuresByExpiry: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
  metrics: {
    request: vi.fn(() => vi.fn()),
  },
}));

import handler, {
  computeProxCentroid,
  computeCharmCentroid,
} from '../bwb-anchor.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { getStrikeExposuresByExpiry } from '../_lib/db-strike-helpers.js';
import { Sentry } from '../_lib/sentry.js';

/** Build a minimal StrikeExposureRow for testing. */
function strike(
  s: number,
  price: number,
  netGamma: number,
  netCharm: number = 0,
): StrikeExposureRow {
  return {
    strike: s,
    price,
    timestamp: '2026-04-06T18:00:00Z',
    netGamma,
    netCharm,
    netDelta: 0,
    callGammaOi: netGamma > 0 ? netGamma : 0,
    putGammaOi: netGamma < 0 ? netGamma : 0,
    callCharmOi: netCharm > 0 ? netCharm : 0,
    putCharmOi: netCharm < 0 ? netCharm : 0,
    dirGamma: 0,
    dirCharm: 0,
  };
}

describe('computeProxCentroid', () => {
  it('weights closer strikes more heavily', () => {
    const price = 5700;
    const strikes = [
      strike(5690, price, 1000), // 10 pts away
      strike(5750, price, 1000), // 50 pts away
    ];
    const { centroid } = computeProxCentroid(strikes);
    // Closer strike should pull centroid toward it
    expect(centroid).toBeLessThan(price);
  });

  it('returns price when all gamma is zero', () => {
    const price = 5700;
    const strikes = [strike(5690, price, 0), strike(5710, price, 0)];
    const { centroid } = computeProxCentroid(strikes);
    expect(centroid).toBe(price);
  });

  it('computes top-3 concentration correctly', () => {
    const price = 5700;
    const strikes = [
      strike(5690, price, 100),
      strike(5695, price, 200),
      strike(5700, price, 300),
      strike(5705, price, 50),
      strike(5710, price, -350), // negative gamma, abs = 350
    ];
    // Total |gamma| = 100 + 200 + 300 + 50 + 350 = 1000
    // Top 3: 350 + 300 + 200 = 850
    const { concentration } = computeProxCentroid(strikes);
    expect(concentration).toBeCloseTo(0.85, 2);
  });
});

describe('computeCharmCentroid — gamma/charm interaction matrix', () => {
  it('+γ +charm gets 1.5× boost (wall strengthening)', () => {
    const price = 5700;
    // Two strikes with equal gamma and distance, different charm
    const withCharm = [
      strike(5690, price, 1000, 500), // +γ +charm
      strike(5710, price, 1000, 0), // +γ, no charm
    ];
    const withoutCharm = [
      strike(5690, price, 1000, 0),
      strike(5710, price, 1000, 0),
    ];
    const boosted = computeCharmCentroid(withCharm);
    const neutral = computeCharmCentroid(withoutCharm);
    // With charm boost on 5690, centroid should pull toward 5690
    expect(boosted).toBeLessThan(neutral);
  });

  it('+γ -charm gets 0.75× dampen (wall decaying)', () => {
    const price = 5700;
    const decaying = [
      strike(5690, price, 1000, -500), // +γ -charm → 0.75×
      strike(5710, price, 1000, 0), // +γ, no charm → 1×
    ];
    const neutral = [
      strike(5690, price, 1000, 0),
      strike(5710, price, 1000, 0),
    ];
    const dampened = computeCharmCentroid(decaying);
    const base = computeCharmCentroid(neutral);
    // Dampened 5690 pulls less → centroid moves toward 5710
    expect(dampened).toBeGreaterThan(base);
  });

  it('-γ +charm gets 0.5× discount (acceleration intensifying)', () => {
    const price = 5700;
    const accelerating = [
      strike(5690, price, -1000, 500), // -γ +charm → 0.5×
      strike(5710, price, 1000, 0), // +γ, no charm → 1×
    ];
    const neutral = [
      strike(5690, price, -1000, 0), // -γ, no charm → 1×
      strike(5710, price, 1000, 0),
    ];
    const discounted = computeCharmCentroid(accelerating);
    const base = computeCharmCentroid(neutral);
    // Discounted -γ strike pulls less → centroid moves toward 5710
    expect(discounted).toBeGreaterThan(base);
  });

  it('-γ -charm stays at 1× (acceleration weakening)', () => {
    const price = 5700;
    // Both strikes equidistant, equal |gamma|
    const weakening = [
      strike(5690, price, -1000, -500), // -γ -charm → 1×
      strike(5710, price, -1000, -500), // -γ -charm → 1×
    ];
    const neutral = [
      strike(5690, price, -1000, 0),
      strike(5710, price, -1000, 0),
    ];
    const result = computeCharmCentroid(weakening);
    const base = computeCharmCentroid(neutral);
    // Both have equal distance and same multiplier → same centroid
    expect(result).toBeCloseTo(base, 4);
  });

  it('centroid pulls away from -γ +charm zones toward +γ +charm zones', () => {
    const price = 5700;
    const strikes = [
      strike(5680, price, -2000, 800), // acceleration intensifying → 0.5×
      strike(5700, price, 1000, 600), // wall strengthening → 1.5×
      strike(5720, price, -500, 0), // neutral acceleration → 1×
    ];
    const centroid = computeCharmCentroid(strikes);
    // Should pull toward 5700 (boosted wall), away from 5680 (discounted)
    expect(centroid).toBeGreaterThan(5690);
    expect(centroid).toBeLessThan(5710);
  });

  it('returns price when all gamma is zero (no weight to average)', () => {
    const price = 5700;
    const strikes = [strike(5690, price, 0, 500), strike(5710, price, 0, -500)];
    expect(computeCharmCentroid(strikes)).toBe(price);
  });
});

// ── Handler ──────────────────────────────────────────────────

const OWNER_SECRET = 'test-owner-secret';
const GUEST_KEY = 'test-guest-key-1234';

/**
 * Symmetric book around spot: every centroid lands on 5700, top-3 share is
 * 1.0, so the expected response is exact.
 */
function symmetricBook(): StrikeExposureRow[] {
  return [
    strike(5690, 5700, 1000),
    strike(5700, 5700, 3000),
    strike(5710, 5700, 1000),
  ];
}

/**
 * Spread-out 0DTE book: ten strikes at equal |γ| (short γ below spot, long
 * above), so the top-3 share is 3000 / 10000 = 0.3, under the 0.40 regime
 * cutoff. Mirror-image distances put the centroid on spot (5700).
 */
function flatBook(): StrikeExposureRow[] {
  return [5675, 5680, 5685, 5690, 5695, 5705, 5710, 5715, 5720, 5725].map((s) =>
    strike(s, 5700, s < 5700 ? -1000 : 1000),
  );
}

/**
 * 1DTE wall pair above spot. γ = 10·d² gives each strike a proximity weight
 * of exactly γ / d² = 10, so the centroid is the midpoint of the two strikes.
 */
function wallPair(near: number, far: number): StrikeExposureRow[] {
  return [near, far].map((s) => strike(s, 5700, 10 * (s - 5700) ** 2));
}

/** Serve a different book per expiry mode. */
function mockBooks(
  book0dte: StrikeExposureRow[],
  book1dte: StrikeExposureRow[],
) {
  vi.mocked(getStrikeExposuresByExpiry).mockImplementation(
    async (_date, expiryMode) => (expiryMode === '0dte' ? book0dte : book1dte),
  );
}

const EXPECTED_ANCHOR_BODY = {
  anchor: 5700,
  centroid0dte: 5700,
  centroid1dte: 5700,
  concentration: 1,
  disagreement: 0,
  confidence: 'HIGH',
  regime: '0dte',
  charmAdjusted: 5700,
  price: 5700,
  distFromPrice: 0,
  strikesUsed: 3,
  timestamp: '2026-04-06T18:00:00Z',
  method: 'prox_weighted_gamma_centroid_dual_dte',
};

describe('GET /api/bwb-anchor handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    // Off Vercel, checkBot short-circuits to "not a bot", so only the
    // owner-or-guest check decides.
    delete process.env.VERCEL;
    process.env.OWNER_SECRET = OWNER_SECRET;
    process.env.GUEST_ACCESS_KEYS = GUEST_KEY;
    vi.mocked(getStrikeExposuresByExpiry).mockResolvedValue(symmetricBook());
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  /** Authenticated (guest) GET with the given query. */
  async function getAnchor(query: Record<string, string>) {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: `sc-guest=${GUEST_KEY}` },
        query,
      }),
      res,
    );
    return res;
  }

  it('rejects an anonymous request with 401 and never queries strike exposures', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-04-06' } }),
      res,
    );

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Not authenticated' });
    expect(res._headers['Cache-Control']).toBe('no-store');
    expect(getStrikeExposuresByExpiry).not.toHaveBeenCalled();
  });

  it('rejects a forged guest cookie with 401 and never queries strike exposures', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: 'sc-guest=not-a-real-guest-key' },
        query: { date: '2026-04-06' },
      }),
      res,
    );

    expect(res._status).toBe(401);
    expect(getStrikeExposuresByExpiry).not.toHaveBeenCalled();
  });

  it('rejects a cookieless bot with 403 before the auth check, never querying strike exposures', async () => {
    // On Vercel, a non-owner request goes to BotID first. A 403 (not the
    // 401 an anonymous human gets) proves the bot check runs first.
    process.env.VERCEL = '1';
    checkBotIdMock.mockResolvedValueOnce({ isBot: true });
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-04-06' } }),
      res,
    );

    expect(checkBotIdMock).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
    // Set by the shared guard (committed separately, before this test).
    expect(res._headers['Cache-Control']).toBe('no-store');
    expect(getStrikeExposuresByExpiry).not.toHaveBeenCalled();
  });

  it('serves the anchor to the owner with the existing response shape', async () => {
    const req = mockRequest({
      method: 'GET',
      headers: { cookie: `sc-owner=${OWNER_SECRET}` },
      query: { date: '2026-04-06' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(guardOwnerOrGuestEndpoint).toHaveBeenCalledWith(
      req,
      res,
      expect.any(Function),
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual(EXPECTED_ANCHOR_BODY);
    expect(getStrikeExposuresByExpiry).toHaveBeenCalledWith(
      '2026-04-06',
      '0dte',
    );
    expect(getStrikeExposuresByExpiry).toHaveBeenCalledWith(
      '2026-04-06',
      '1dte',
    );
  });

  it('serves the anchor to a guest with the existing response shape', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: `sc-guest=${GUEST_KEY}` },
        query: { date: '2026-04-06' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toEqual(EXPECTED_ANCHOR_BODY);
  });

  it('returns anchor: null when there is no 0DTE exposure for the date', async () => {
    vi.mocked(getStrikeExposuresByExpiry).mockResolvedValue([]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: `sc-guest=${GUEST_KEY}` },
        query: { date: '2026-04-06' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      anchor: null,
      reason: 'No strike exposure data for 2026-04-06',
    });
  });

  // Guarded UW data: a shared-cache directive would let Vercel's CDN serve
  // the response to an anonymous visitor without running the guard.
  it.each([
    ['an anchor', 'private, max-age=60', symmetricBook()],
    ['no 0DTE exposure', 'private, max-age=30', []],
  ])(
    'caches a 200 with %s in the browser only (%s)',
    async (_label, cacheControl, book) => {
      vi.mocked(getStrikeExposuresByExpiry).mockResolvedValue(book);
      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          headers: { cookie: `sc-guest=${GUEST_KEY}` },
          query: { date: '2026-04-06' },
        }),
        res,
      );

      expect(res._status).toBe(200);
      expect(res._headers['Cache-Control']).toBe(cacheControl);
      expect(Object.values(res._headers).join('\n')).not.toContain('s-maxage');
    },
  );

  // ── Regime switching ──

  it('anchors on the 1DTE centroid when 0DTE gamma is spread out', async () => {
    // 0DTE concentration 0.3 < 0.40 and 1DTE data exists → 1DTE regime.
    // 1DTE midpoint of 5710/5720 = 5715; |5700 − 5715| = 15 → MEDIUM.
    mockBooks(flatBook(), wallPair(5710, 5720));
    const res = await getAnchor({ date: '2026-04-06' });

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      anchor: 5715,
      centroid0dte: 5700,
      centroid1dte: 5715,
      concentration: 0.3,
      disagreement: 15,
      confidence: 'MEDIUM',
      regime: '1dte',
      charmAdjusted: 5700, // charm stays on the 0DTE book
      price: 5700,
      distFromPrice: 15,
      strikesUsed: 10,
      timestamp: '2026-04-06T18:00:00Z',
      method: 'prox_weighted_gamma_centroid_dual_dte',
    });
  });

  it('keeps the 0DTE anchor when gamma is spread out but there is no 1DTE data', async () => {
    // Low concentration alone doesn't switch: the 1DTE fallback needs data.
    mockBooks(flatBook(), []);
    const res = await getAnchor({ date: '2026-04-06' });

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      anchor: 5700,
      centroid0dte: 5700,
      centroid1dte: null,
      concentration: 0.3,
      disagreement: 0,
      confidence: 'HIGH',
      regime: '0dte',
      charmAdjusted: 5700,
      price: 5700,
      distFromPrice: 0,
      strikesUsed: 10,
      timestamp: '2026-04-06T18:00:00Z',
      method: 'prox_weighted_gamma_centroid_dual_dte',
    });
  });

  // ── Confidence from 0DTE/1DTE disagreement ──

  it.each([
    // [label, confidence, 1DTE near, 1DTE far, 1DTE centroid, disagreement]
    ['10 pts (HIGH boundary)', 'HIGH', 5705, 5715, 5710, 10],
    ['15 pts', 'MEDIUM', 5710, 5720, 5715, 15],
    ['20 pts (MEDIUM boundary)', 'MEDIUM', 5715, 5725, 5720, 20],
    ['30 pts', 'LOW', 5720, 5740, 5730, 30],
  ] as const)(
    'rates a %s disagreement as %s',
    async (_label, confidence, near, far, centroid1dte, disagreement) => {
      // Concentrated 0DTE book (share 1.0) keeps the 0DTE regime at 5700.
      mockBooks(symmetricBook(), wallPair(near, far));
      const res = await getAnchor({ date: '2026-04-06' });

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        anchor: 5700,
        regime: '0dte',
        centroid0dte: 5700,
        centroid1dte,
        disagreement,
        confidence,
      });
    },
  );

  // ── Date parameter ──

  it.each([
    ['no ?date=', {}],
    ['a malformed ?date=', { date: "04/07/2026' OR 1=1" }],
  ])(
    'falls back to today (ET) for %s',
    async (_label, query: Record<string, string>) => {
      // Noon ET on 2026-04-07, a different day from the fixtures' timestamp.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-04-07T16:00:00Z'));
      const res = await getAnchor(query);

      expect(res._status).toBe(200);
      expect(getStrikeExposuresByExpiry).toHaveBeenCalledTimes(2);
      expect(getStrikeExposuresByExpiry).toHaveBeenCalledWith(
        '2026-04-07',
        '0dte',
      );
      expect(getStrikeExposuresByExpiry).toHaveBeenCalledWith(
        '2026-04-07',
        '1dte',
      );
    },
  );

  it('returns 500 and reports to Sentry when the strike-exposure query rejects', async () => {
    const dbError = new Error('db attempt timeout');
    vi.mocked(getStrikeExposuresByExpiry).mockRejectedValue(dbError);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: `sc-owner=${OWNER_SECRET}` },
        query: { date: '2026-04-06' },
      }),
      res,
    );

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal server error' });
    expect(res._headers['Cache-Control']).toBe('no-store');
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
  });
});
