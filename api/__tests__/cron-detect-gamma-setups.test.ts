// @vitest-environment node

/**
 * Tests for the real-time detector cron at /api/cron/detect-gamma-setups.
 *
 * Verifies the auth guard, the weekend short-circuit (dow_label = null),
 * the no-data short-circuit (empty bars or empty nodes), the happy paths
 * for E1 / E5 / PCS detector fires, and the metadata decoration with
 * nearest +γ floor/ceiling. withCronInstrumentation spreads
 * CronResult.metadata into the response body, so assertions look at
 * `body.reason`, `body.dow`, etc. — not a nested `metadata` key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockSentryCapture, mockSentryTag } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockSentryCapture: vi.fn(),
  mockSentryTag: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: mockSentryTag,
    captureMessage: vi.fn(),
    captureException: mockSentryCapture,
  },
  metrics: { uwRateLimit: vi.fn(), request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/gamma-detector.js', () => ({
  loadDayContext: vi.fn(),
  loadRecentBars: vi.fn(),
  loadPositiveGammaNodes: vi.fn(),
  computeEsBasisChange5m: vi.fn(),
  detectE1: vi.fn(),
  detectE5: vi.fn(),
  detectPcsMonday: vi.fn(),
  findNearestCeilingAbove: vi.fn(),
  findNearestFloorBelow: vi.fn(),
  getConfidenceTier: vi.fn(),
  insertFire: vi.fn(),
}));

import handler from '../cron/detect-gamma-setups.js';
import {
  loadDayContext,
  loadRecentBars,
  loadPositiveGammaNodes,
  computeEsBasisChange5m,
  detectE1,
  detectE5,
  detectPcsMonday,
  findNearestCeilingAbove,
  findNearestFloorBelow,
  getConfidenceTier,
  insertFire,
  type Bar,
  type DayContext,
  type DowLabel,
  type GammaNode,
} from '../_lib/gamma-detector.js';

// Anchor wall-clock inside US RTH so cronGuard's marketHours gate lets the
// handler through without needing ?force=1. 2026-05-21 = a Thursday at
// 14:30 UTC (10:30 ET), well inside the 13-21 UTC market window.
const MARKET_TIME = new Date('2026-05-21T14:30:00.000Z');

function authedReq(query: Record<string, string> = {}) {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
    query,
  });
}

function makeDayCtx(overrides: Partial<DayContext> = {}): DayContext {
  return {
    today: '2026-05-18', // Monday
    dow_label: 'Monday' as DowLabel,
    day_open: 5800,
    prior_close: 5790,
    open_gap_pct: 0.17,
    prior_5d_ret: -0.012,
    prior_iv_rank: 30,
    pre_day_filter_fires: true,
    is_fomc_day: false,
    is_dom_1_5: false,
    is_dom_16_20: true,
    ...overrides,
  };
}

function makeBar(overrides: Partial<Bar> = {}): Bar {
  return {
    timestamp: new Date('2026-05-18T14:30:00.000Z'),
    open: 5800,
    high: 5805,
    low: 5798,
    close: 5803,
    ...overrides,
  };
}

function makeNode(strike: number, value = 100_000): GammaNode {
  return { strike, value };
}

describe('cron detect-gamma-setups', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_TIME);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    mockSql.mockResolvedValue([]);
    // Sensible defaults so happy-path tests only override what they care about.
    vi.mocked(getConfidenceTier).mockReturnValue('MAXIMUM');
    vi.mocked(detectE1).mockReturnValue(null);
    vi.mocked(detectE5).mockReturnValue(null);
    vi.mocked(detectPcsMonday).mockReturnValue(null);
    vi.mocked(insertFire).mockResolvedValue(true);
    vi.mocked(findNearestCeilingAbove).mockReturnValue(null);
    vi.mocked(findNearestFloorBelow).mockReturnValue(null);
    vi.mocked(computeEsBasisChange5m).mockResolvedValue(0.7);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Auth guards ──────────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
    expect(loadDayContext).not.toHaveBeenCalled();
  });

  it('returns 401 when CRON_SECRET header is wrong', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer wrong-secret' },
      }),
      res,
    );
    expect(res._status).toBe(401);
    expect(loadDayContext).not.toHaveBeenCalled();
  });

  // ── Weekend short-circuit ───────────────────────────────────

  it('weekend short-circuit: dow_label=null skips with reason="weekend"', async () => {
    vi.mocked(loadDayContext).mockResolvedValueOnce(
      makeDayCtx({
        today: '2026-05-23',
        dow_label: null,
      }),
    );

    const res = mockResponse();
    // Use ?force=1 so cronGuard's marketHours gate doesn't reject the
    // weekend wall-clock before the handler's own dow_label check runs.
    await handler(authedReq({ force: '1' }), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.rows).toBe(0);
    expect(body.reason).toBe('weekend');
    // Critical: the parallel loaders sit behind the early return and
    // must NOT have been called when dow_label is null.
    expect(loadRecentBars).not.toHaveBeenCalled();
    expect(loadPositiveGammaNodes).not.toHaveBeenCalled();
    expect(computeEsBasisChange5m).not.toHaveBeenCalled();
  });

  // ── No-data short-circuits ──────────────────────────────────

  it('no data: empty bars → reason="no_data" with bars=0 nodes=N', async () => {
    vi.mocked(loadDayContext).mockResolvedValueOnce(makeDayCtx());
    vi.mocked(loadRecentBars).mockResolvedValueOnce([]);
    vi.mocked(loadPositiveGammaNodes).mockResolvedValueOnce([
      makeNode(5800),
      makeNode(5810),
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.rows).toBe(0);
    expect(body.reason).toBe('no_data');
    expect(body.bars).toBe(0);
    expect(body.nodes).toBe(2);
    expect(detectE1).not.toHaveBeenCalled();
    expect(detectPcsMonday).not.toHaveBeenCalled();
  });

  it('no data: empty nodes → reason="no_data" with bars=N nodes=0', async () => {
    vi.mocked(loadDayContext).mockResolvedValueOnce(makeDayCtx());
    vi.mocked(loadRecentBars).mockResolvedValueOnce([makeBar(), makeBar()]);
    vi.mocked(loadPositiveGammaNodes).mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.rows).toBe(0);
    expect(body.reason).toBe('no_data');
    expect(body.bars).toBe(2);
    expect(body.nodes).toBe(0);
    expect(detectE1).not.toHaveBeenCalled();
    expect(insertFire).not.toHaveBeenCalled();
  });

  // Note: the `no_current_bar` branch (bars.at(-1) returning null after the
  // bars.length === 0 check) is unreachable with a non-empty array — defensive
  // belt-and-suspenders only. Skipped; would require a sparse-array mock.

  // ── Happy paths: E1 / PCS fires ─────────────────────────────

  it('happy path: E1 fire only → inserts once, rows=1, candidates=1', async () => {
    const dayCtx = makeDayCtx({ dow_label: 'Monday' as DowLabel });
    const bars = [
      makeBar({ timestamp: new Date('2026-05-18T14:26:00.000Z'), close: 5803 }),
      makeBar({ timestamp: new Date('2026-05-18T14:27:00.000Z'), close: 5806 }),
      makeBar({ timestamp: new Date('2026-05-18T14:28:00.000Z'), close: 5808 }),
      makeBar({ timestamp: new Date('2026-05-18T14:29:00.000Z'), close: 5810 }),
      makeBar({ timestamp: new Date('2026-05-18T14:30:00.000Z'), close: 5812 }),
    ];
    const node = makeNode(5805, 250_000);
    const breakBar = bars[1]!;
    const holdBar = bars.at(-1)!;

    vi.mocked(loadDayContext).mockResolvedValueOnce(dayCtx);
    vi.mocked(loadRecentBars).mockResolvedValueOnce(bars);
    vi.mocked(loadPositiveGammaNodes).mockResolvedValueOnce([node]);
    vi.mocked(detectE1).mockReturnValueOnce({ breakBar, holdBar, node });
    vi.mocked(getConfidenceTier).mockReturnValueOnce('MAXIMUM');

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.rows).toBe(1);
    expect(body.candidates).toBe(1);
    expect(body.dow).toBe('Monday');
    expect(body.confidence_tier).toBe('MAXIMUM');
    expect(body.bars_loaded).toBe(5);
    expect(body.nodes_loaded).toBe(1);

    expect(insertFire).toHaveBeenCalledTimes(1);
    const fireArg = vi.mocked(insertFire).mock.calls[0]![1];
    expect(fireArg.signal_type).toBe('e1_long_call');
    expect(fireArg.node_strike).toBe(5805);
    expect(fireArg.node_gex).toBe(250_000);
    expect(fireArg.spot_at_fire).toBe(holdBar.close);
    expect(fireArg.confidence_tier).toBe('MAXIMUM');
    expect(fireArg.dow_label).toBe('Monday');
    expect(fireArg.es_basis_change_5m).toBe(0.7);
    expect(fireArg.pre_day_filter_fires).toBe(true);
  });

  it('happy path: all three detectors hit → 3 inserts, candidates=3', async () => {
    const dayCtx = makeDayCtx({ dow_label: 'Monday' as DowLabel });
    const bars = [
      makeBar({ timestamp: new Date('2026-05-18T14:26:00.000Z') }),
      makeBar({ timestamp: new Date('2026-05-18T14:27:00.000Z') }),
      makeBar({ timestamp: new Date('2026-05-18T14:28:00.000Z') }),
      makeBar({ timestamp: new Date('2026-05-18T14:29:00.000Z') }),
      makeBar({ timestamp: new Date('2026-05-18T14:30:00.000Z') }),
    ];
    const nodeE1 = makeNode(5805, 250_000);
    const nodeE5 = makeNode(5790, 180_000);
    const nodePcs = makeNode(5800, 400_000);
    const breakBar = bars[1]!;
    const holdBar = bars.at(-1)!;
    const wickBar = bars.at(-1)!;

    vi.mocked(loadDayContext).mockResolvedValueOnce(dayCtx);
    vi.mocked(loadRecentBars).mockResolvedValueOnce(bars);
    vi.mocked(loadPositiveGammaNodes).mockResolvedValueOnce([
      nodeE1,
      nodeE5,
      nodePcs,
    ]);
    vi.mocked(detectE1).mockReturnValueOnce({
      breakBar,
      holdBar,
      node: nodeE1,
    });
    vi.mocked(detectE5).mockReturnValueOnce({
      wickBar: bars[2]!,
      breakBar: bars[3]!,
      node: nodeE5,
    });
    vi.mocked(detectPcsMonday).mockReturnValueOnce({
      wickBar,
      node: nodePcs,
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.rows).toBe(3);
    expect(body.candidates).toBe(3);
    expect(insertFire).toHaveBeenCalledTimes(3);

    const signalTypes = vi
      .mocked(insertFire)
      .mock.calls.map((c) => c[1].signal_type)
      .sort();
    expect(signalTypes).toEqual(['e1_long_call', 'e5_long_put', 'pcs_monday']);
  });

  it('insertFire returning false (UNIQUE conflict) → rows=0 with candidates=1', async () => {
    const dayCtx = makeDayCtx({ dow_label: 'Monday' as DowLabel });
    const bars = [
      makeBar({ timestamp: new Date('2026-05-18T14:26:00.000Z') }),
      makeBar({ timestamp: new Date('2026-05-18T14:27:00.000Z') }),
      makeBar({ timestamp: new Date('2026-05-18T14:28:00.000Z') }),
      makeBar({ timestamp: new Date('2026-05-18T14:29:00.000Z') }),
      makeBar({ timestamp: new Date('2026-05-18T14:30:00.000Z') }),
    ];
    const node = makeNode(5805);
    const breakBar = bars[1]!;
    const holdBar = bars.at(-1)!;

    vi.mocked(loadDayContext).mockResolvedValueOnce(dayCtx);
    vi.mocked(loadRecentBars).mockResolvedValueOnce(bars);
    vi.mocked(loadPositiveGammaNodes).mockResolvedValueOnce([node]);
    vi.mocked(detectE1).mockReturnValueOnce({ breakBar, holdBar, node });
    vi.mocked(insertFire).mockResolvedValueOnce(false);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.rows).toBe(0);
    expect(body.candidates).toBe(1);
    expect(insertFire).toHaveBeenCalledTimes(1);
  });

  // ── nearest floor / ceiling decoration ─────────────────────

  it('decorates metadata with nearest +γ floor and ceiling when present', async () => {
    const dayCtx = makeDayCtx();
    const currentClose = 5803;
    const bars = [makeBar({ close: currentClose })];
    const nodes = [makeNode(5800), makeNode(5810)];
    const ceilingNode = makeNode(5810);
    const floorNode = makeNode(5800);

    vi.mocked(loadDayContext).mockResolvedValueOnce(dayCtx);
    vi.mocked(loadRecentBars).mockResolvedValueOnce(bars);
    vi.mocked(loadPositiveGammaNodes).mockResolvedValueOnce(nodes);
    vi.mocked(findNearestCeilingAbove).mockReturnValueOnce(ceilingNode);
    vi.mocked(findNearestFloorBelow).mockReturnValueOnce(floorNode);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.nearest_ceiling).toBe(5810);
    expect(body.nearest_floor).toBe(5800);

    // Both helpers must be called with the current bar's close price.
    expect(findNearestCeilingAbove).toHaveBeenCalledWith(nodes, currentClose);
    expect(findNearestFloorBelow).toHaveBeenCalledWith(nodes, currentClose);
  });

  it('decorates metadata with null floor/ceiling when helpers return null', async () => {
    const dayCtx = makeDayCtx();
    const bars = [makeBar()];
    const nodes = [makeNode(5800)];

    vi.mocked(loadDayContext).mockResolvedValueOnce(dayCtx);
    vi.mocked(loadRecentBars).mockResolvedValueOnce(bars);
    vi.mocked(loadPositiveGammaNodes).mockResolvedValueOnce(nodes);
    // findNearest* default to null in beforeEach.

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.nearest_ceiling).toBeNull();
    expect(body.nearest_floor).toBeNull();
  });
});
