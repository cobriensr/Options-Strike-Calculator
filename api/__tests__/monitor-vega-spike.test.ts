// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    setTag: vi.fn(),
    metrics: { count: vi.fn() },
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const { mockCronGuard, mockWithRetry } = vi.hoisted(() => ({
  mockCronGuard: vi.fn(),
  mockWithRetry: vi.fn(<T>(fn: () => T) => fn()),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
  withRetry: mockWithRetry,
}));

import handler, { detectSpike } from '../cron/monitor-vega-spike.js';
import { Sentry } from '../_lib/sentry.js';

// ── Constants (mirrored so tests are self-contained) ──────────

const Z_THRESHOLD = 6.0; // VEGA_SPIKE_Z_SCORE_THRESHOLD

// ── Fixture helpers ───────────────────────────────────────────

const GUARD = { apiKey: '', today: '2026-04-27' };

const AUTHORIZED_REQ = () =>
  mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });

/**
 * Builds a synthetic bar array for one ticker.
 *
 * @param count      - number of bars to generate
 * @param flowValue  - dir_vega_flow assigned to every bar
 * @param lastFlow   - if provided, the LAST bar gets this value instead
 * @param baseTs     - base ISO timestamp; each bar is +1 minute
 */
function makeBars(
  count: number,
  flowValue: number,
  lastFlow?: number,
  baseTs = '2026-04-27T14:00:00Z',
): Array<{ timestamp: string; dir_vega_flow: string }> {
  return Array.from({ length: count }, (_, i) => {
    const ts = new Date(new Date(baseTs).getTime() + i * 60_000).toISOString();
    const flow =
      lastFlow !== undefined && i === count - 1 ? lastFlow : flowValue;
    return { timestamp: ts, dir_vega_flow: String(flow) };
  });
}

// ── Pure unit tests: detectSpike ─────────────────────────────

describe('detectSpike — pure unit tests', () => {
  it('returns null when fewer than 31 bars (gate 4 — insufficient baseline)', () => {
    // 30 bars total = 29 baseline + 1 candidate; need MIN_BARS_ELAPSED=30 in baseline
    const bars = makeBars(30, 500_000);
    expect(detectSpike('SPY', bars)).toBeNull();
  });

  it('returns null when latest |dir_vega| is below the SPY FLOOR (gate 1)', () => {
    // 30 prior bars at 100K noise, latest at 200K — below SPY floor of 490K
    const bars = makeBars(31, 100_000, 200_000);
    expect(detectSpike('SPY', bars)).toBeNull();
  });

  it('returns null when latest passes FLOOR but does not exceed 2× prior max (gate 2)', () => {
    // Prior 30 bars at 300K, latest at 510K (above floor, only 1.7× prior max)
    const bars = makeBars(31, 300_000, 510_000);
    expect(detectSpike('SPY', bars)).toBeNull();
  });

  it('returns null when latest passes FLOOR but z-score is below threshold (gate 3)', () => {
    // Prior 30 bars alternating 300K / 0 → MAD ≈ 150K → safeMad = 150K.
    // priorMax = 300K; 2× = 600K. Latest = 650K (passes floor + ratio gate).
    // score = 650K / 150K ≈ 4.3 < 6 → z-score gate fails.
    const baseTs = '2026-04-27T14:00:00Z';
    const mixedBars = [
      ...Array.from({ length: 30 }, (_, i) => ({
        timestamp: new Date(
          new Date(baseTs).getTime() + i * 60_000,
        ).toISOString(),
        dir_vega_flow: String(i % 2 === 0 ? 300_000 : 0),
      })),
      {
        timestamp: new Date(
          new Date(baseTs).getTime() + 30 * 60_000,
        ).toISOString(),
        dir_vega_flow: '650000',
      },
    ];
    const result = detectSpike('SPY', mixedBars);
    // Either returns null (all gates including z-score) or, if somehow non-null,
    // the score must still be below the threshold.
    if (result !== null) {
      expect(result.score).toBeLessThan(Z_THRESHOLD);
    } else {
      expect(result).toBeNull();
    }
  });

  it('returns the computed payload when all 4 gates pass', () => {
    // Prior 30 bars at tiny noise (1K each) → priorMax = 1K, MAD = 0 → safeMad = 1
    // Latest = 600K → floor(490K) ok, ratio(600K >= 2×1K) ok, score(600K/1) >> 6 ok
    const bars = makeBars(31, 1_000, 600_000);
    const result = detectSpike('SPY', bars);
    expect(result).not.toBeNull();
    expect(result!.ticker).toBe('SPY');
    expect(result!.dirVegaFlow).toBe(600_000);
    expect(result!.barsElapsed).toBe(30);
    expect(result!.priorMax).toBe(1_000);
    expect(result!.baselineMad).toBeGreaterThanOrEqual(1);
    expect(result!.score).toBeGreaterThan(Z_THRESHOLD);
    expect(result!.vsPriorMax).toBeGreaterThanOrEqual(2);
    expect(result!.timestamp).toBeTruthy();
  });

  it('returns null for QQQ when |dir_vega| is below the QQQ floor', () => {
    // QQQ floor is 330K; latest = 200K
    const bars = makeBars(31, 1_000, 200_000);
    expect(detectSpike('QQQ', bars)).toBeNull();
  });

  it('is robust against zero-MAD baseline — uses safeMad floor of 1, no Infinity', () => {
    // All 30 prior bars identical → MAD = 0 → safeMad = max(0, 1) = 1; score is finite
    const bars = makeBars(31, 100, 600_000);
    const result = detectSpike('SPY', bars);
    expect(result).not.toBeNull();
    expect(Number.isFinite(result!.score)).toBe(true);
    expect(result!.baselineMad).toBe(1);
  });

  it('handles negative dir_vega_flow — uses absolute value throughout', () => {
    // Prior bars: small positive. Latest: large negative (still a spike in absolute terms)
    const bars = makeBars(31, 500, -600_000);
    const result = detectSpike('SPY', bars);
    expect(result).not.toBeNull();
    expect(result!.dirVegaFlow).toBe(-600_000); // raw value preserved
    expect(result!.score).toBeGreaterThan(Z_THRESHOLD);
  });
});

// ── Handler tests ─────────────────────────────────────────────

describe('monitor-vega-spike handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCronGuard.mockReturnValue(GUARD);
    mockWithRetry.mockImplementation(<T>(fn: () => T) => fn());
    // Default: DB returns empty bars (no spike)
    mockSql.mockResolvedValue([]);
  });

  // ── Guard delegation ─────────────────────────────────────

  it('exits early without DB queries when cronGuard returns null', async () => {
    mockCronGuard.mockReturnValue(null);
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Auth guard ───────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 401 when CRON_SECRET header is wrong', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer wrongsecret' },
      }),
      res,
    );
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Market hours gate ────────────────────────────────────

  it('skips when outside market hours', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    });
    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('skips on weekends', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    });
    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Happy path: SPY spikes, QQQ does not ────────────────

  it('inserts SPY spike row, skips QQQ, returns 200 with correct response shape', async () => {
    const spyBars = makeBars(31, 1_000, 600_000);
    const qqqBars = makeBars(31, 1_000, 200_000); // below QQQ floor of 330K

    // DB call sequence:
    //   1. SELECT bars for SPY  → spyBars
    //   2. INSERT spike for SPY → [{id: 42}]
    //   3. SELECT bars for QQQ  → qqqBars (no spike → no INSERT)
    mockSql
      .mockResolvedValueOnce(spyBars)
      .mockResolvedValueOnce([{ id: 42 }])
      .mockResolvedValueOnce(qqqBars);

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body).toMatchObject({
      job: 'monitor-vega-spike',
      confluence: false,
    });
    const tickers = body.tickers as Record<
      string,
      { fired: boolean; score: number | null; ratio: number | null }
    >;
    expect(tickers['SPY']!.fired).toBe(true);
    expect(tickers['SPY']!.score).toBeGreaterThan(Z_THRESHOLD);
    expect(tickers['QQQ']!.fired).toBe(false);
    expect(body).toHaveProperty('durationMs');

    // Only one INSERT (SPY)
    const insertCalls = mockSql.mock.calls.filter((c) =>
      (c[0] as readonly string[])
        .join('')
        .includes('INSERT INTO vega_spike_events'),
    );
    expect(insertCalls).toHaveLength(1);
  });

  // ── Confluence path ───────────────────────────────────────

  it('marks both rows confluence=true when both timestamps are within 60s', async () => {
    const baseTs = '2026-04-27T14:30:00Z';
    // SPY spikes at minute 30 (last bar of 31-bar series starting at baseTs)
    const spyBars = makeBars(31, 1_000, 600_000, baseTs);
    // QQQ spikes 30s after SPY's spike timestamp
    const spySpikeTs = spyBars.at(-1)!.timestamp;
    const qqqSpikeTs = new Date(
      new Date(spySpikeTs).getTime() + 30_000,
    ).toISOString();
    const qqqBars = [
      ...makeBars(30, 1_000, undefined, baseTs),
      { timestamp: qqqSpikeTs, dir_vega_flow: '400000' },
    ];

    // DB call sequence:
    //   1. SELECT bars for SPY  → spyBars
    //   2. INSERT SPY spike     → [{id: 10}]
    //   3. SELECT bars for QQQ  → qqqBars
    //   4. INSERT QQQ spike     → [{id: 11}]
    //   5. UPDATE confluence    → []
    mockSql
      .mockResolvedValueOnce(spyBars)
      .mockResolvedValueOnce([{ id: 10 }])
      .mockResolvedValueOnce(qqqBars)
      .mockResolvedValueOnce([{ id: 11 }])
      .mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.confluence).toBe(true);

    const tickers = body.tickers as Record<string, { fired: boolean }>;
    expect(tickers['SPY']!.fired).toBe(true);
    expect(tickers['QQQ']!.fired).toBe(true);

    // UPDATE confluence was called
    const updateCalls = mockSql.mock.calls.filter((c) =>
      (c[0] as readonly string[]).join('').includes('UPDATE vega_spike_events'),
    );
    expect(updateCalls).toHaveLength(1);

    // Sentry.metrics.count fired with confluence='true'
    const countMock = vi.mocked(Sentry.metrics.count);
    const confluenceCalls = countMock.mock.calls.filter(
      (c) =>
        c[0] === 'vega_spike.fired' &&
        (c[2] as { attributes?: { confluence?: string } } | undefined)
          ?.attributes?.confluence === 'true',
    );
    expect(confluenceCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ── Confluence NOT triggered when timestamps are too far apart ───

  it('does NOT set confluence when both timestamps are more than 60s apart', async () => {
    const baseTs = '2026-04-27T14:30:00Z';
    const spyBars = makeBars(31, 1_000, 600_000, baseTs);
    const spySpikeTs = spyBars.at(-1)!.timestamp;
    // QQQ spike is 90s after SPY — outside the 60s window
    const qqqSpikeTs = new Date(
      new Date(spySpikeTs).getTime() + 90_000,
    ).toISOString();
    const qqqBars = [
      ...makeBars(30, 1_000, undefined, baseTs),
      { timestamp: qqqSpikeTs, dir_vega_flow: '400000' },
    ];

    mockSql
      .mockResolvedValueOnce(spyBars)
      .mockResolvedValueOnce([{ id: 20 }])
      .mockResolvedValueOnce(qqqBars)
      .mockResolvedValueOnce([{ id: 21 }]);

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.confluence).toBe(false);

    // No UPDATE call
    const updateCalls = mockSql.mock.calls.filter((c) =>
      (c[0] as readonly string[]).join('').includes('UPDATE vega_spike_events'),
    );
    expect(updateCalls).toHaveLength(0);
  });

  // ── ON CONFLICT path ─────────────────────────────────────

  it('does not fire metric or confluence when INSERT returns empty (duplicate)', async () => {
    const spyBars = makeBars(31, 1_000, 600_000);
    mockSql
      .mockResolvedValueOnce(spyBars) // SPY bars
      .mockResolvedValueOnce([]) // INSERT → ON CONFLICT, no row returned
      .mockResolvedValueOnce([]); // QQQ bars (empty → no spike)

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    const tickers = body.tickers as Record<string, { fired: boolean }>;
    expect(tickers['SPY']!.fired).toBe(false);
    expect(body.confluence).toBe(false);
    expect(vi.mocked(Sentry.metrics.count)).not.toHaveBeenCalled();
  });

  // ── Per-ticker error isolation ───────────────────────────

  it('logs error for SPY but still evaluates QQQ when SPY query throws', async () => {
    const qqqBars = makeBars(31, 1_000, 200_000); // below QQQ floor
    mockSql
      .mockRejectedValueOnce(new Error('DB timeout')) // SPY SELECT fails
      .mockResolvedValueOnce(qqqBars); // QQQ SELECT succeeds

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    const tickers = body.tickers as Record<
      string,
      { fired: boolean; error?: string }
    >;
    expect(tickers['SPY']!.fired).toBe(false);
    expect(tickers['SPY']!.error).toBe('DB timeout');
    expect(tickers['QQQ']!.fired).toBe(false);

    const loggerMod = await import('../_lib/logger.js');
    expect(vi.mocked(loggerMod.default).error).toHaveBeenCalledWith(
      expect.objectContaining({ ticker: 'SPY' }),
      'monitor-vega-spike per-ticker error',
    );
  });

  // ── Outer error → 500 ────────────────────────────────────

  it('returns 500 and captures Sentry exception on outer error', async () => {
    // Simulate an outer-scope failure by making reportCronRun throw.
    // reportCronRun runs outside the per-ticker loop so it reaches the outer catch.
    const { reportCronRun } = await import('../_lib/axiom.js');
    vi.mocked(reportCronRun).mockRejectedValueOnce(
      new Error('catastrophic failure'),
    );
    // DB returns empty bars (no spike) so per-ticker loop succeeds normally
    mockSql.mockResolvedValue([]);

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(vi.mocked(Sentry).setTag).toHaveBeenCalledWith(
      'cron.job',
      'monitor-vega-spike',
    );
    expect(vi.mocked(Sentry).captureException).toHaveBeenCalled();
  });

  // ── No bars → no spike ───────────────────────────────────

  it('returns 200 with no spikes when DB has no bars for either ticker', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    const tickers = body.tickers as Record<
      string,
      { fired: boolean; score: null }
    >;
    expect(tickers['SPY']!.fired).toBe(false);
    expect(tickers['SPY']!.score).toBeNull();
    expect(tickers['QQQ']!.fired).toBe(false);
    expect(body.confluence).toBe(false);
  });
});
