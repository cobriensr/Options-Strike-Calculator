// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks (vi.mock is hoisted; use vi.hoisted for the fns) ───────

const { mockSql, mockSendPushToAll } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockSendPushToAll: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: vi.fn(),
}));

vi.mock('../_lib/web-push-client.js', () => ({
  sendPushToAll: mockSendPushToAll,
}));

import handler from '../cron/monitor-regime-events.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

// Mock the system clock to a deterministic CT afternoon time so
// `classifySessionPhase` returns `AFTERNOON` (the engine fires
// PHASE_TRANSITION on first-render only for actionable phases).
//
// 2026-04-21 19:30:00 UTC = 14:30:00 CT — POWER phase
const FIXED_TIME = new Date('2026-04-21T19:30:00.000Z');

function makeReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe('monitor-regime-events handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: 'test-secret' };
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TIME);
    mockSql.mockResolvedValue([]);
    mockSendPushToAll.mockResolvedValue({
      delivered: 0,
      errors: 0,
      deliveredEndpoints: [],
    });
    vi.mocked(cronGuard).mockReturnValue({
      apiKey: '',
      today: '2026-04-21',
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Cron guard ───────────────────────────────────────────────

  it('returns early when cronGuard rejects (non-CRON_SECRET caller)', async () => {
    vi.mocked(cronGuard).mockReturnValue(null);

    const res = mockResponse();
    await handler(makeReq(), res);

    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSendPushToAll).not.toHaveBeenCalled();
  });

  it('returns early when cronGuard rejects due to outside market hours', async () => {
    // The real cronGuard sends a 200 + skipped reason then returns null.
    // We mimic that by returning null from the mock — the handler should
    // not reach DB / push delivery code.
    vi.mocked(cronGuard).mockReturnValue(null);

    const res = mockResponse();
    await handler(makeReq(), res);

    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSendPushToAll).not.toHaveBeenCalled();
  });

  // ── First run (no prev state) ────────────────────────────────

  it('emits PHASE_TRANSITION on first run when phase is actionable', async () => {
    // Sequence of DB calls:
    // 1. loadPrevState (regime_monitor_state SELECT) → empty
    // 2. loadSpotExposure (spot_exposures SELECT) → row
    // 3. loadGexStrikes (gex_strike_0dte SELECT) → empty (no walls)
    // 4. loadMaxPain (oi_per_strike SELECT) → empty
    // 5. loadEsBasis (futures_snapshots SELECT) → row
    // 6. insertRegimeEvent (INSERT regime_events) for PHASE_TRANSITION
    // 7. savePrevState (UPSERT regime_monitor_state)
    mockSql
      .mockResolvedValueOnce([]) // loadPrevState
      .mockResolvedValueOnce([
        {
          timestamp: '2026-04-21T19:25:00Z',
          price: '5800.50',
          gamma_oi: '50000000000',
        },
      ]) // loadSpotExposure
      .mockResolvedValueOnce([]) // loadGexStrikes
      .mockResolvedValueOnce([]) // loadMaxPain
      .mockResolvedValueOnce([{ symbol: 'ES', price: '5825.50' }]) // loadEsBasis
      .mockResolvedValueOnce([]) // loadRecentSpotPrices
      .mockResolvedValueOnce([]) // insertRegimeEvent
      .mockResolvedValueOnce([]); // savePrevState

    mockSendPushToAll.mockResolvedValue({
      delivered: 2,
      errors: 0,
      deliveredEndpoints: ['a', 'b'],
    });

    const res = mockResponse();
    await handler(makeReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ok: true,
      edges: 1,
      delivered: 2,
      errors: 0,
    });
    // Push delivery was called once with a PHASE_TRANSITION event.
    expect(mockSendPushToAll).toHaveBeenCalledTimes(1);
    const calledEvent = mockSendPushToAll.mock.calls[0]![0];
    expect(calledEvent.type).toBe('PHASE_TRANSITION');
  });

  // ── Regime flip detection ────────────────────────────────────

  it('detects a regime flip (POSITIVE → NEGATIVE) and inserts + delivers', async () => {
    // prev state has POSITIVE, next reads NEGATIVE because gamma_oi is negative.
    // Spot must sit OUTSIDE ±0.5% of zeroGamma so classifyRegime returns
    // a definite regime instead of TRANSITIONING.
    const prevState = {
      state: {
        regime: 'POSITIVE',
        phase: 'POWER',
        levels: [],
        firedTriggers: [],
        esPrice: 5700,
      },
      cooldowns: {},
    };

    // Build strikes such that zeroGamma ≈ 5800 but spot is 5700 (well outside
    // the ±0.5% band → 29 pts wide). Net OI gamma negative → NEGATIVE regime.
    mockSql
      .mockResolvedValueOnce([{ prev_state: prevState }]) // loadPrevState
      .mockResolvedValueOnce([
        {
          timestamp: '2026-04-21T19:25:00Z',
          price: '5700.00',
          gamma_oi: '-50000000000',
        },
      ]) // loadSpotExposure
      .mockResolvedValueOnce([
        { strike: '5790', call_gamma_oi: '-1000000', put_gamma_oi: '0' },
        { strike: '5810', call_gamma_oi: '1000000', put_gamma_oi: '0' },
      ]) // loadGexStrikes (zeroGamma crossing ≈ 5810)
      .mockResolvedValueOnce([]) // loadMaxPain
      .mockResolvedValueOnce([{ symbol: 'ES', price: '5725.00' }]) // loadEsBasis
      .mockResolvedValueOnce([]) // loadRecentSpotPrices
      .mockResolvedValueOnce([]) // insertRegimeEvent for REGIME_FLIP
      .mockResolvedValueOnce([]); // savePrevState

    mockSendPushToAll.mockResolvedValue({
      delivered: 1,
      errors: 0,
      deliveredEndpoints: ['endpoint-a'],
    });

    const res = mockResponse();
    await handler(makeReq(), res);

    expect(res._status).toBe(200);
    // At minimum a REGIME_FLIP edge fires; PHASE_TRANSITION is suppressed
    // because the prev state's `phase: 'POWER'` matches the current phase
    // so the engine skips it.
    const body = res._json as { edges: number };
    expect(body.edges).toBeGreaterThanOrEqual(1);
    expect(mockSendPushToAll).toHaveBeenCalled();
    const eventTypes = mockSendPushToAll.mock.calls.map(
      (call) => (call[0] as { type: string }).type,
    );
    expect(eventTypes).toContain('REGIME_FLIP');
  });

  // ── Cooldown enforcement ─────────────────────────────────────

  it('suppresses an edge when its cooldown is still active', async () => {
    // Prev state has POSITIVE + a recent REGIME_FLIP cooldown (0ms ago in sim time),
    // so the regime flip to NEGATIVE on this tick must be suppressed.
    const recentMs = FIXED_TIME.getTime() - 30_000; // 30s ago < 90s window
    const prevState = {
      state: {
        regime: 'POSITIVE',
        phase: 'POWER',
        levels: [],
        firedTriggers: [],
        esPrice: 5800,
      },
      cooldowns: {
        'REGIME_FLIP:': recentMs,
      },
    };

    mockSql
      .mockResolvedValueOnce([{ prev_state: prevState }]) // loadPrevState
      .mockResolvedValueOnce([
        {
          timestamp: '2026-04-21T19:25:00Z',
          price: '5800.50',
          gamma_oi: '-50000000000',
        },
      ]) // loadSpotExposure
      .mockResolvedValueOnce([
        { strike: '5790', call_gamma_oi: '-1000000', put_gamma_oi: '0' },
        { strike: '5810', call_gamma_oi: '1000000', put_gamma_oi: '0' },
      ]) // loadGexStrikes
      .mockResolvedValueOnce([]) // loadMaxPain
      .mockResolvedValueOnce([{ symbol: 'ES', price: '5825.50' }]) // loadEsBasis
      .mockResolvedValueOnce([]) // loadRecentSpotPrices
      .mockResolvedValueOnce([]); // savePrevState

    const res = mockResponse();
    await handler(makeReq(), res);

    expect(res._status).toBe(200);
    // sendPushToAll never called because cooldown blocked the edge
    const regimeFlipCalls = mockSendPushToAll.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'REGIME_FLIP',
    );
    expect(regimeFlipCalls.length).toBe(0);
  });

  // ── DB error handling ────────────────────────────────────────

  it('returns 500 and captures to Sentry when savePrevState fails (handler-level catch)', async () => {
    mockSql
      .mockResolvedValueOnce([]) // loadPrevState
      .mockResolvedValueOnce([]) // loadSpotExposure
      .mockResolvedValueOnce([]) // loadGexStrikes
      .mockResolvedValueOnce([]) // loadMaxPain
      .mockResolvedValueOnce([]) // loadEsBasis
      .mockResolvedValueOnce([]) // loadRecentSpotPrices
      // PHASE_TRANSITION fires (no prev state → first render)
      .mockResolvedValueOnce([]) // insertRegimeEvent
      .mockRejectedValueOnce(new Error('DB connection lost')); // savePrevState

    const res = mockResponse();
    await handler(makeReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalled();
    expect(vi.mocked(Sentry.setTag)).toHaveBeenCalledWith(
      'cron.job',
      'monitor-regime-events',
    );
  });

  it('continues when an individual edge insert fails (logged, not fatal)', async () => {
    // First-render PHASE_TRANSITION fires; the insertRegimeEvent throws
    // but the handler catches it per-edge and continues to savePrevState.
    mockSql
      .mockResolvedValueOnce([]) // loadPrevState
      .mockResolvedValueOnce([]) // loadSpotExposure
      .mockResolvedValueOnce([]) // loadGexStrikes
      .mockResolvedValueOnce([]) // loadMaxPain
      .mockResolvedValueOnce([]) // loadEsBasis
      .mockResolvedValueOnce([]) // loadRecentSpotPrices
      .mockRejectedValueOnce(new Error('insert failed')) // insertRegimeEvent
      .mockResolvedValueOnce([]); // savePrevState

    const res = mockResponse();
    await handler(makeReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ok: true,
      errors: 1,
    });
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalled();
  });

  // ── Drift-override parity (server ↔ client) ──────────────────────
  //
  // Regression for the parity gap documented in
  // docs/superpowers/specs/futures-playbook-server-drift-override-2026-04-21.md.
  // Without server-side priceTrend, the cron fired TRIGGER_FIRE push
  // alerts for fade/lift rules the client UI had suppressed under
  // drift-override — a user-facing divergence.

  it('does not fire TRIGGER_FIRE for fade-call-wall when price is drifting up in POSITIVE regime', async () => {
    // Prior state: already in POSITIVE + POWER, with fade-call-wall NOT
    // previously fired (so a transition to ACTIVE would fire a push).
    const prevState = {
      state: {
        regime: 'POSITIVE',
        phase: 'POWER',
        levels: [
          {
            kind: 'CALL_WALL',
            spxStrike: 5818,
            esPrice: 5822,
            distanceEsPoints: 2,
            status: 'IDLE',
          },
        ],
        firedTriggers: [],
        esPrice: 5818,
      },
      cooldowns: {},
    };

    // 5 min of up-drift in spot_exposures (prices rising 1pt/min).
    const driftRows = [
      { timestamp: '2026-04-21T19:25:00Z', price: '5816.00' },
      { timestamp: '2026-04-21T19:26:00Z', price: '5817.00' },
      { timestamp: '2026-04-21T19:27:00Z', price: '5818.00' },
      { timestamp: '2026-04-21T19:28:00Z', price: '5819.00' },
      { timestamp: '2026-04-21T19:29:00Z', price: '5820.00' },
    ];

    // Wall structure: call wall at 5818 (spot 5820 → inside proximity),
    // put wall at 5780. POSITIVE regime via positive net gamma.
    mockSql
      .mockResolvedValueOnce([{ prev_state: prevState }]) // loadPrevState
      .mockResolvedValueOnce([
        {
          timestamp: '2026-04-21T19:29:00Z',
          price: '5820.00',
          gamma_oi: '50000000000',
        },
      ]) // loadSpotExposure
      .mockResolvedValueOnce([
        // Small put wall + big call wall so zero-gamma interpolates to
        // ~5780 (well outside the ±0.5% transition band from spot=5820)
        // and classifyRegime returns POSITIVE.
        { strike: '5780', call_gamma_oi: '0', put_gamma_oi: '-10000' },
        { strike: '5818', call_gamma_oi: '1000000', put_gamma_oi: '0' },
      ]) // loadGexStrikes
      .mockResolvedValueOnce([]) // loadMaxPain
      .mockResolvedValueOnce([{ symbol: 'ES', price: '5824.00' }]) // loadEsBasis
      .mockResolvedValueOnce(driftRows) // loadRecentSpotPrices — strong up-drift
      .mockResolvedValueOnce([]) // savePrevState (no edges → no insert between)
      .mockResolvedValueOnce([]); // safety margin

    const res = mockResponse();
    await handler(makeReq(), res);

    expect(res._status).toBe(200);
    // The critical assertion: no fade-call-wall TRIGGER_FIRE push
    // despite price being within proximity of the call wall. Client UI
    // suppresses it under drift-override; server must agree.
    const fadeCallFires = mockSendPushToAll.mock.calls.filter((c) => {
      const event = c[0] as { type: string; id: string };
      // TRIGGER_FIRE events encode the trigger id in the `id` field as
      // `TRIGGER_FIRE:<triggerId>:<iso>` (see alerts.ts buildTriggerFireEvent).
      return (
        event.type === 'TRIGGER_FIRE' && event.id.includes(':fade-call-wall:')
      );
    });
    expect(fadeCallFires.length).toBe(0);
  });

  it('DOES fire TRIGGER_FIRE for fade-call-wall when price is NOT drifting (parity with client)', async () => {
    // Same setup as above but with flat price history — drift-override
    // does not engage, so fade-call-wall fires normally.
    const prevState = {
      state: {
        regime: 'POSITIVE',
        phase: 'POWER',
        levels: [
          {
            kind: 'CALL_WALL',
            spxStrike: 5818,
            esPrice: 5822,
            distanceEsPoints: 2,
            status: 'IDLE',
          },
        ],
        firedTriggers: [],
        esPrice: 5818,
      },
      cooldowns: {},
    };

    const flatRows = [
      { timestamp: '2026-04-21T19:25:00Z', price: '5820.00' },
      { timestamp: '2026-04-21T19:26:00Z', price: '5820.10' },
      { timestamp: '2026-04-21T19:27:00Z', price: '5819.90' },
      { timestamp: '2026-04-21T19:28:00Z', price: '5820.05' },
      { timestamp: '2026-04-21T19:29:00Z', price: '5820.00' },
    ];

    mockSql
      .mockResolvedValueOnce([{ prev_state: prevState }]) // loadPrevState
      .mockResolvedValueOnce([
        {
          timestamp: '2026-04-21T19:29:00Z',
          price: '5820.00',
          gamma_oi: '50000000000',
        },
      ]) // loadSpotExposure
      .mockResolvedValueOnce([
        // Small put wall + big call wall so zero-gamma interpolates to
        // ~5780 (well outside the ±0.5% transition band from spot=5820)
        // and classifyRegime returns POSITIVE.
        { strike: '5780', call_gamma_oi: '0', put_gamma_oi: '-10000' },
        { strike: '5818', call_gamma_oi: '1000000', put_gamma_oi: '0' },
      ]) // loadGexStrikes
      .mockResolvedValueOnce([]) // loadMaxPain
      .mockResolvedValueOnce([{ symbol: 'ES', price: '5824.00' }]) // loadEsBasis
      .mockResolvedValueOnce(flatRows) // loadRecentSpotPrices — flat
      .mockResolvedValueOnce([]) // insertRegimeEvent for TRIGGER_FIRE
      .mockResolvedValueOnce([]); // savePrevState

    const res = mockResponse();
    await handler(makeReq(), res);

    expect(res._status).toBe(200);
    const fadeCallFires = mockSendPushToAll.mock.calls.filter((c) => {
      const event = c[0] as { type: string; id: string };
      // TRIGGER_FIRE events encode the trigger id in the `id` field as
      // `TRIGGER_FIRE:<triggerId>:<iso>` (see alerts.ts buildTriggerFireEvent).
      return (
        event.type === 'TRIGGER_FIRE' && event.id.includes(':fade-call-wall:')
      );
    });
    expect(fadeCallFires.length).toBe(1);
  });
});
