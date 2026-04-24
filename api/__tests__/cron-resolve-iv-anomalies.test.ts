// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
  metrics: { increment: vi.fn() },
}));

import handler from '../cron/resolve-iv-anomalies.js';

// 2026-04-23T21:05:00Z = 5 past 4pm ET close = cron firing time.
const CRON_FIRING = new Date('2026-04-23T21:05:00.000Z');

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

function makeAnomalyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    ticker: 'SPX',
    strike: '7000',
    side: 'put',
    expiry: '2026-04-23',
    spot_at_detect: '7100',
    iv_at_detect: '0.35',
    ts: '2026-04-23T14:30:00.000Z',
    ...overrides,
  };
}

function makeFollowOnRow(offsetMins: number, ivMid: number, spot: number) {
  const ms = Date.parse('2026-04-23T14:30:00.000Z') + offsetMins * 60_000;
  return {
    ts: new Date(ms).toISOString(),
    iv_mid: String(ivMid),
    spot: String(spot),
  };
}

describe('resolve-iv-anomalies handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(CRON_FIRING);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    mockSql.mockResolvedValue([]);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Auth guard ────────────────────────────────────────────

  it('returns 405 for non-GET requests', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 401 when CRON_SECRET header is missing', async () => {
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 401 when CRON_SECRET header is wrong', async () => {
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrong' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 401 when CRON_SECRET env is not set', async () => {
    delete process.env.CRON_SECRET;
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
  });

  // ── No-op path ───────────────────────────────────────────

  it('returns 0-resolved when there are no unresolved anomalies', async () => {
    mockSql.mockResolvedValueOnce([]); // loadUnresolvedAnomalies returns []

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'resolve-iv-anomalies',
      resolved: 0,
      skipped: 0,
      total: 0,
    });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  // ── Happy path ────────────────────────────────────────────

  it('resolves a single anomaly end-to-end with follow-on data', async () => {
    // Query sequence for one resolvable anomaly:
    //   1. loadUnresolvedAnomalies → 1 row
    //   2. loadFollowOnSamples
    //   3. loadAnomalySeries      } these four fire concurrently via
    //   4. loadCrossAssets (ES)    } Promise.all; our mock returns []
    //   5. loadCrossAssets (NQ)    } for every futures symbol.
    //   6. loadCrossAssets (ZN)
    //   7. loadCrossAssets (DX)
    //   8. loadDarkPrintsInWindow (SPX-only — this is SPX, so it fires)
    //   9. loadFlowAlertsInWindow
    //  10. UPDATE iv_anomalies
    mockSql.mockResolvedValueOnce([makeAnomalyRow()]); // 1
    mockSql.mockResolvedValueOnce([
      makeFollowOnRow(10, 0.45, 7050),
      makeFollowOnRow(30, 0.42, 7060),
      makeFollowOnRow(120, 0.38, 7075),
      makeFollowOnRow(300, 0.36, 7080), // ~4pm ET
    ]); // 2
    // Promise.all — futures + anomaly series + darkprints + flow alerts all empty
    mockSql.mockResolvedValue([]); // catches the Promise.all fan-out

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      resolved: number;
      skipped: number;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.resolved).toBe(1);
    expect(body.skipped).toBe(0);
  });

  it('labels an anomaly as flat when there is NO follow-on data but still writes a row', async () => {
    mockSql.mockResolvedValueOnce([makeAnomalyRow()]);
    mockSql.mockResolvedValue([]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as { resolved: number; skipped: number };
    // Missing follow-on is NOT a skip per our spec — we still write a row
    // with flat economics.
    expect(body.resolved).toBe(1);
    expect(body.skipped).toBe(0);

    // Inspect the UPDATE call: the JSONB payload should contain
    // outcome_class "flat" and all the catalysts scaffold fields.
    const updateCall = mockSql.mock.calls.at(-1);
    expect(updateCall).toBeDefined();
    const values = updateCall!.slice(1) as unknown[];
    const jsonPayload = values[0] as string;
    const parsed = JSON.parse(jsonPayload);
    expect(parsed.outcome_class).toBe('flat');
    expect(parsed.catalysts).toBeDefined();
    expect(parsed.catalysts.leading_assets).toEqual([]);
    expect(parsed.catalysts.likely_catalyst).toBe('unknown');
  });

  it('mixes resolved + skipped: only unresolved anomalies get touched', async () => {
    // Two anomalies from the unresolved query. The second has invalid
    // detect state (spot_at_detect = 0) → skipped without UPDATE.
    mockSql.mockResolvedValueOnce([
      makeAnomalyRow({ id: 1 }),
      makeAnomalyRow({ id: 2, spot_at_detect: '0' }),
    ]);
    // First anomaly: follow-on + context queries all empty → labelled flat.
    mockSql.mockResolvedValue([]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      resolved: number;
      skipped: number;
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.resolved).toBe(1);
    expect(body.skipped).toBe(1);
  });

  it('catches per-row exceptions and continues the batch', async () => {
    mockSql.mockResolvedValueOnce([
      makeAnomalyRow({ id: 1 }),
      makeAnomalyRow({ id: 2 }),
    ]);
    // First anomaly's follow-on query throws; second succeeds.
    mockSql.mockRejectedValueOnce(new Error('DB hiccup'));
    mockSql.mockResolvedValue([]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as { resolved: number; skipped: number };
    // One row failed, one should succeed
    expect(body.skipped).toBe(1);
    expect(body.resolved).toBe(1);
  });

  it('returns 500 when the initial unresolved query throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB connection lost'));

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });
});
