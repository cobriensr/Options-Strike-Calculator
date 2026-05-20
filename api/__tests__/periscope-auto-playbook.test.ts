// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _resetEnvCache } from '../_lib/env.js';
import { mockRequest, mockResponse } from './helpers';

// ============================================================
// Module mocks (hoisted)
// ============================================================

const { waitUntilCalls } = vi.hoisted(() => ({
  waitUntilCalls: [] as Promise<unknown>[],
}));

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    waitUntilCalls.push(p);
  }),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
    setTag: vi.fn(),
  },
  metrics: {
    request: vi.fn().mockReturnValue(vi.fn()),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockSql = vi.fn(async (): Promise<unknown[]> => []);
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/auth-helpers.js', () => ({
  // Rate limiter is its own tested unit — keep it out of the endpoint
  // tests. Always returns false (not limited). A dedicated test below
  // verifies the wiring with the real spy.
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
}));

vi.mock('../_lib/spx-candles.js', () => ({
  ctWallClockToUtcMs: vi.fn((date: string, time: string) =>
    // Stable epoch for any (date, time) — sufficient for endpoint tests.
    new Date(`${date}T${time}:00.000Z`).getTime(),
  ),
  fetchSPXSpotAtTimestamp: vi
    .fn()
    .mockResolvedValue({ price: 5800, source: 'db_exact' }),
}));

vi.mock('../_lib/periscope-db.js', () => ({
  savePeriscopeAnalysis: vi.fn().mockResolvedValue(42),
  completePeriscopeAnalysis: vi.fn().mockResolvedValue(true),
}));

vi.mock('../_lib/periscope-chat-runner.js', () => ({
  runPeriscopeAutoPlaybook: vi.fn().mockResolvedValue({
    status: 'complete',
    prose: 'mock prose',
    structured: {
      spot: 5800,
      cone_lower: 5780,
      cone_upper: 5820,
      long_trigger: 5810,
      short_trigger: 5790,
      regime_tag: 'drift-and-cap',
      bias: 'two-sided',
      trade_types_recommended: [],
      trade_types_avoided: [],
      key_levels: null,
      expected_dealer_behavior: null,
      confidence: 'medium',
      confidence_basis: null,
      futures_plan: null,
    },
    parseOk: true,
    fullResponse: { text: 'mock' },
    embedding: null,
    panelPayload: { spot: 5800, regime: 'drift-and-cap' },
    failureReason: null,
    modelUsed: 'claude-opus-4-7',
    durationMs: 1234,
    inputTokens: 10000,
    outputTokens: 2000,
    cacheReadTokens: 8000,
    cacheWriteTokens: 0,
  }),
}));

// ============================================================
// Imports (after mocks)
// ============================================================

import handler from '../periscope-auto-playbook.js';
import { savePeriscopeAnalysis } from '../_lib/periscope-db.js';
import { fetchSPXSpotAtTimestamp } from '../_lib/spx-candles.js';
import { runPeriscopeAutoPlaybook } from '../_lib/periscope-chat-runner.js';
import { rejectIfRateLimited } from '../_lib/auth-helpers.js';

const mockSavePeriscopeAnalysis = vi.mocked(savePeriscopeAnalysis);
const mockFetchSpot = vi.mocked(fetchSPXSpotAtTimestamp);
const mockRunner = vi.mocked(runPeriscopeAutoPlaybook);
const mockRejectIfRateLimited = vi.mocked(rejectIfRateLimited);

// ============================================================
// Fixtures
// ============================================================

const VALID_BODY = {
  tradingDate: '2026-05-12',
  capturedAt: '2026-05-12T13:30:00.000Z',
  slotKey: '08:30 - 08:40',
};

function authHeaders(secret = 'test-webhook-secret'): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

function postReq(
  opts: {
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    method?: string;
  } = {},
) {
  return mockRequest({
    method: opts.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...opts.headers },
    body: opts.body ?? VALID_BODY,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  waitUntilCalls.length = 0;
  _resetEnvCache();
  process.env.PERISCOPE_WEBHOOK_SECRET = 'test-webhook-secret';
  process.env.AUTO_PLAYBOOK_ENABLED = 'true';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  // Default DB SELECTs return empty (no existing row, no parent)
  mockSql.mockResolvedValue([]);
  mockSavePeriscopeAnalysis.mockResolvedValue(42);
});

// ============================================================
// Auth & method
// ============================================================

describe('periscope-auto-playbook handler — auth + method', () => {
  it('returns 405 on non-POST', async () => {
    const req = postReq({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  it('returns 401 with no Authorization header', async () => {
    const req = postReq({ headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 401 with wrong bearer token', async () => {
    const req = postReq({ headers: authHeaders('wrong-secret') });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 401 when PERISCOPE_WEBHOOK_SECRET is unset', async () => {
    delete process.env.PERISCOPE_WEBHOOK_SECRET;
    _resetEnvCache();
    const req = postReq({ headers: authHeaders() });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('passes auth with the correct bearer token', async () => {
    const req = postReq({ headers: authHeaders() });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(202);
  });
});

// ============================================================
// Kill switch
// ============================================================

describe('periscope-auto-playbook handler — kill switch', () => {
  it('returns 503 when AUTO_PLAYBOOK_ENABLED=false', async () => {
    process.env.AUTO_PLAYBOOK_ENABLED = 'false';
    _resetEnvCache();
    const req = postReq({ headers: authHeaders() });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(503);
    expect(res._json).toMatchObject({ killSwitch: true });
  });

  it('returns 503 when AUTO_PLAYBOOK_ENABLED=False (case-insensitive)', async () => {
    process.env.AUTO_PLAYBOOK_ENABLED = 'False';
    _resetEnvCache();
    const req = postReq({ headers: authHeaders() });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(503);
  });

  it('proceeds when AUTO_PLAYBOOK_ENABLED is unset (default true)', async () => {
    delete process.env.AUTO_PLAYBOOK_ENABLED;
    _resetEnvCache();
    const req = postReq({ headers: authHeaders() });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(202);
  });
});

// ============================================================
// Body validation
// ============================================================

describe('periscope-auto-playbook handler — body validation', () => {
  it('returns 400 on missing tradingDate', async () => {
    const req = postReq({
      headers: authHeaders(),
      body: {
        capturedAt: '2026-05-12T13:30:00.000Z',
        slotKey: '08:30 - 08:40',
      },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 on malformed slotKey', async () => {
    const req = postReq({
      headers: authHeaders(),
      body: { ...VALID_BODY, slotKey: '8:30-8:40' }, // missing zero-pad + spaces
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 on bad capturedAt', async () => {
    const req = postReq({
      headers: authHeaders(),
      body: { ...VALID_BODY, capturedAt: 'not-iso' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });
});

// ============================================================
// Mode derivation
// ============================================================

// ============================================================
// RTH guard — prevent the 2026-05-10 stale-scrape regression
// ============================================================

describe('periscope-auto-playbook handler — RTH guard', () => {
  it('returns 422 when capturedAt CT is pre-market (03:30 CDT)', async () => {
    // 08:30 UTC = 03:30 CDT — the exact buggy scenario from 5/4-5/7.
    const req = postReq({
      body: {
        ...VALID_BODY,
        capturedAt: '2026-05-12T08:30:00.000Z',
      },
      headers: authHeaders(),
    });
    const res = mockResponse();
    await handler(req as never, res as never);
    expect(res._status).toBe(422);
    expect(res._json).toMatchObject({
      error: expect.stringContaining('outside RTH'),
    });
  });

  it('returns 422 when capturedAt CT is post-close (15:30 CDT)', async () => {
    // 20:30 UTC = 15:30 CDT.
    const req = postReq({
      body: {
        ...VALID_BODY,
        capturedAt: '2026-05-12T20:30:00.000Z',
        slotKey: '15:20 - 15:30',
      },
      headers: authHeaders(),
    });
    const res = mockResponse();
    await handler(req as never, res as never);
    expect(res._status).toBe(422);
  });

  it('returns 422 on weekend captures (Saturday noon)', async () => {
    const req = postReq({
      body: {
        ...VALID_BODY,
        tradingDate: '2026-05-09',
        capturedAt: '2026-05-09T17:00:00.000Z', // Sat 12:00 CDT
      },
      headers: authHeaders(),
    });
    const res = mockResponse();
    await handler(req as never, res as never);
    expect(res._status).toBe(422);
  });

  it('returns 422 when slot label disagrees with capturedAt by >10min', async () => {
    // The exact bug: scraper grabbed UW panel at 08:30 CT but UW was
    // still showing the "13:20-13:30" label from previous day's data.
    const req = postReq({
      body: {
        ...VALID_BODY,
        capturedAt: '2026-05-12T13:30:00.000Z', // 08:30 CDT
        slotKey: '13:20 - 13:30',
      },
      headers: authHeaders(),
    });
    const res = mockResponse();
    await handler(req as never, res as never);
    expect(res._status).toBe(422);
    expect(res._json).toMatchObject({
      error: expect.stringContaining('stale scrape rejected'),
    });
  });

  it('passes when capturedAt CT is exactly 08:30 (open boundary)', async () => {
    // 13:30 UTC = 08:30 CDT — RTH open.
    const req = postReq({
      body: {
        ...VALID_BODY,
        capturedAt: '2026-05-12T13:30:00.000Z',
        slotKey: '08:20 - 08:30',
      },
      headers: authHeaders(),
    });
    const res = mockResponse();
    await handler(req as never, res as never);
    expect(res._status).not.toBe(422);
  });

  it('passes when capturedAt CT is exactly 15:00 (close boundary)', async () => {
    const req = postReq({
      body: {
        ...VALID_BODY,
        capturedAt: '2026-05-12T20:00:00.000Z', // 15:00 CDT
        slotKey: '14:50 - 15:00',
      },
      headers: authHeaders(),
    });
    const res = mockResponse();
    await handler(req as never, res as never);
    expect(res._status).not.toBe(422);
  });

  it('passes for 14:50-15:00 debrief captured at 15:10 CT (natural lag)', async () => {
    // The LAST_ANALYZABLE_SLOT ("14:50 - 15:00") only gets labeled by
    // UW once the boundary has passed, so the scraper's first capture
    // of it is the 15:10 tick. The pre-2026-05-13 strict 15:00 ceiling
    // rejected this and zeroed out 3 consecutive trading days of
    // debriefs (5/8, 5/11, 5/12). The bound is now 15:15.
    const req = postReq({
      body: {
        ...VALID_BODY,
        capturedAt: '2026-05-12T20:10:00.000Z', // 15:10 CDT
        slotKey: '14:50 - 15:00',
      },
      headers: authHeaders(),
    });
    const res = mockResponse();
    await handler(req as never, res as never);
    expect(res._status).not.toBe(422);
  });

  it('still rejects at 15:16 CT (just past the widened ceiling)', async () => {
    const req = postReq({
      body: {
        ...VALID_BODY,
        capturedAt: '2026-05-12T20:16:00.000Z', // 15:16 CDT
        slotKey: '14:50 - 15:00',
      },
      headers: authHeaders(),
    });
    const res = mockResponse();
    await handler(req as never, res as never);
    expect(res._status).toBe(422);
  });
});

describe('periscope-auto-playbook handler — mode derivation', () => {
  it('classifies 08:20 - 08:30 as pre_trade', async () => {
    const req = postReq({
      headers: authHeaders(),
      body: { ...VALID_BODY, slotKey: '08:20 - 08:30' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(202);
    expect(res._json).toMatchObject({ mode: 'pre_trade' });
  });

  it('classifies 14:50 - 15:00 as debrief', async () => {
    const req = postReq({
      headers: authHeaders(),
      body: {
        ...VALID_BODY,
        slotKey: '14:50 - 15:00',
        capturedAt: '2026-05-12T20:00:00.000Z', // 15:00 CDT
      },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(202);
    expect(res._json).toMatchObject({ mode: 'debrief' });
  });

  it('anchors readTimeCt to END of timeframe (not START) for pre_trade', async () => {
    // Regression: previously deriveMode used the START of the
    // timeframe label as the spot-lookup anchor. For pre_trade that's
    // 08:20 CT — pre-market — and fetchSPXSpotAtTimestamp filters to
    // regular-hours candles only, so the lookup returned null and the
    // endpoint 422'd. Anchoring at the END (08:30, market open)
    // lands on the first regular-hours candle.
    const req = postReq({
      headers: authHeaders(),
      body: { ...VALID_BODY, slotKey: '08:20 - 08:30' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(202);
    // fetchSPXSpotAtTimestamp was called with time='08:30' (END), not '08:20'.
    expect(mockFetchSpot).toHaveBeenCalledWith(
      expect.objectContaining({ time: '08:30' }),
    );
  });

  it('anchors readTimeCt to END for debrief (15:00, not 14:50)', async () => {
    const req = postReq({
      headers: authHeaders(),
      body: {
        ...VALID_BODY,
        slotKey: '14:50 - 15:00',
        capturedAt: '2026-05-12T20:00:00.000Z', // 15:00 CDT
      },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(202);
    expect(mockFetchSpot).toHaveBeenCalledWith(
      expect.objectContaining({ time: '15:00' }),
    );
  });

  it('classifies 11:30 - 11:40 as intraday', async () => {
    const req = postReq({
      headers: authHeaders(),
      body: {
        ...VALID_BODY,
        slotKey: '11:30 - 11:40',
        capturedAt: '2026-05-12T16:40:00.000Z', // 11:40 CDT
      },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(202);
    expect(res._json).toMatchObject({ mode: 'intraday' });
  });

  it('returns 422 on pre-market 06:00 - 06:10 slot', async () => {
    const req = postReq({
      headers: authHeaders(),
      body: { ...VALID_BODY, slotKey: '06:00 - 06:10' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(422);
  });

  it('returns 422 on the 08:10 - 08:20 slot one-before pre_trade boundary', async () => {
    const req = postReq({
      headers: authHeaders(),
      body: { ...VALID_BODY, slotKey: '08:10 - 08:20' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(422);
  });

  it('returns 422 on post-close 15:00 - 15:10 slot', async () => {
    const req = postReq({
      headers: authHeaders(),
      body: { ...VALID_BODY, slotKey: '15:00 - 15:10' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(422);
  });
});

// ============================================================
// Idempotency
// ============================================================

describe('periscope-auto-playbook handler — idempotency', () => {
  it('returns 200 with idempotent: true when row already exists', async () => {
    // First DB call (findExistingRowId) returns an existing row.
    mockSql.mockResolvedValueOnce([{ id: '777' }]);
    const req = postReq({ headers: authHeaders() });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ rowId: 777, idempotent: true });
    // No insert should have happened
    expect(mockSavePeriscopeAnalysis).not.toHaveBeenCalled();
  });

  it('handles unique-constraint race: returns 200 when INSERT collides with concurrent winner', async () => {
    // findExistingRowId returns none initially
    mockSql.mockResolvedValueOnce([]); // findExistingRowId
    mockSql.mockResolvedValueOnce([]); // resolveParentId
    // savePeriscopeAnalysis returns null (collision)
    mockSavePeriscopeAnalysis.mockResolvedValueOnce(null);
    // Race recovery: findExistingRowId now returns the winner
    mockSql.mockResolvedValueOnce([{ id: '888' }]);
    const req = postReq({ headers: authHeaders() });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ rowId: 888, raceLoser: true });
  });
});

// ============================================================
// Spot lookup failure
// ============================================================

describe('periscope-auto-playbook handler — spot lookup', () => {
  it('returns 422 when no SPX candle exists for the slot', async () => {
    mockFetchSpot.mockResolvedValueOnce(null);
    const req = postReq({ headers: authHeaders() });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(422);
  });
});

// ============================================================
// Happy path + waitUntil
// ============================================================

describe('periscope-auto-playbook handler — happy path', () => {
  it('inserts in_progress row + returns 202 + kicks off waitUntil', async () => {
    const req = postReq({ headers: authHeaders() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(202);
    expect(res._json).toMatchObject({
      rowId: 42,
      status: 'in_progress',
      mode: 'intraday',
    });

    // savePeriscopeAnalysis was called with the right shape
    expect(mockSavePeriscopeAnalysis).toHaveBeenCalledTimes(1);
    const insertArgs = mockSavePeriscopeAnalysis.mock.calls[0]![0];
    expect(insertArgs).toMatchObject({
      autoGenerated: true,
      slotCapturedAt: VALID_BODY.capturedAt,
      status: 'in_progress',
      mode: 'intraday',
      tradingDate: VALID_BODY.tradingDate,
      spotAtReadTime: 5800,
      spotSource: 'db_exact',
    });

    // waitUntil received the runner promise
    expect(waitUntilCalls.length).toBe(1);

    // Wait for the kicked-off promise to settle so the runner mock fires
    await waitUntilCalls[0];
    expect(mockRunner).toHaveBeenCalledTimes(1);
  });

  it('rate-limit guard is invoked with endpoint key and 30/min limit', async () => {
    const req = postReq({ headers: authHeaders(), body: VALID_BODY });
    const res = mockResponse();
    await handler(req, res);
    expect(mockRejectIfRateLimited).toHaveBeenCalledWith(
      req,
      res,
      'periscope-auto-playbook',
      30,
    );
  });

  it('returns 429 short-circuit when rate-limit guard rejects', async () => {
    // Simulate the guard having already sent a 429 response.
    mockRejectIfRateLimited.mockImplementationOnce(async (_req, res) => {
      res.setHeader('Retry-After', '60');
      res.status(429).json({ error: 'Too many requests' });
      return true;
    });
    const req = postReq({ headers: authHeaders(), body: VALID_BODY });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(429);
    // The handler must not reach the runner or insert when rate-limited.
    expect(mockSavePeriscopeAnalysis).not.toHaveBeenCalled();
    expect(mockRunner).not.toHaveBeenCalled();
  });

  it('returns 500 when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    _resetEnvCache();
    const req = postReq({ headers: authHeaders() });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
  });
});
