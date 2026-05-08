// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const { mockCronGuard } = vi.hoisted(() => ({
  mockCronGuard: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

import handler from '../cron/detect-silent-boom.js';

const GUARD = { apiKey: '', today: '2026-05-07' };

// ============================================================
// Fixture builders — generate ws_option_trades-shaped tick rows that
// produce a silent-boom-eligible 5-min bucket sequence on a single
// chain. Detector spec: 4 silent baseline buckets (≤500 vol each)
// followed by a spike bucket with size ≥1000, ratio ≥5×, ask% ≥0.7,
// vol/OI ≥0.25, OI ≥100.
// ============================================================

interface TickOverrides {
  price?: number;
  size?: number;
  side?: 'ask' | 'bid' | 'mid' | 'no_side';
  open_interest?: number | null;
}

function tick(
  optionChain: string,
  ticker: string,
  optionType: 'C' | 'P',
  strike: number,
  expiry: string,
  executedAtIso: string,
  overrides: TickOverrides = {},
) {
  return {
    ticker,
    option_chain: optionChain,
    option_type: optionType,
    strike,
    expiry,
    executed_at: executedAtIso,
    price: overrides.price ?? 0.5,
    size: overrides.size ?? 50,
    side: overrides.side ?? 'ask',
    open_interest: overrides.open_interest ?? 5000,
  };
}

/**
 * 5 buckets on chain SNDK260507C01175000:
 *   - 4 silent baseline buckets at 13:00, 13:05, 13:10, 13:15 — 100
 *     contracts each (well under baselineMedianMax=500).
 *   - 1 spike bucket at 13:20 — 2000 contracts, all ask-side, OI=5000
 *     so vol/OI = 0.4 (above 0.25 floor).
 *
 * The spike's ratio vs baseline median (100) is 20×, well above 5×.
 */
function fireableSilentBoomStream() {
  const chain = 'SNDK260507C01175000';
  const ticker = 'SNDK';
  const opt = 'C' as const;
  const strike = 1175;
  const exp = '2026-05-07';

  const rows: ReturnType<typeof tick>[] = [];
  // Baseline buckets — one tick of size 100 each.
  for (let b = 0; b < 4; b += 1) {
    const minute = b * 5;
    const iso = `2026-05-07T13:${String(minute).padStart(2, '0')}:00Z`;
    rows.push(tick(chain, ticker, opt, strike, exp, iso, { size: 100 }));
  }
  // Spike bucket — multiple ask-side ticks summing to 2000.
  const spikeIso = '2026-05-07T13:20:00Z';
  rows.push(tick(chain, ticker, opt, strike, exp, spikeIso, { size: 1000 }));
  rows.push(
    tick(chain, ticker, opt, strike, exp, '2026-05-07T13:21:00Z', {
      size: 1000,
    }),
  );
  return rows;
}

describe('detect-silent-boom handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCronGuard.mockReturnValue(GUARD);
    mockSql.mockResolvedValue([]);
    process.env.CRON_SECRET = 'test-secret';
  });

  it('returns skipped when no ticks are in the scan window', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'skipped',
      message: 'no ticks in scan window',
    });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('inserts an alert when the silent-boom pattern matches', async () => {
    // Sequence: SELECT ticks → SELECT prior fires (empty) →
    // SELECT market_tide ticks (empty) → INSERT.
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // tide ticks
      .mockResolvedValueOnce([{ id: 42 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      // withCronInstrumentation spreads metadata flat into the response.
      chains: 1,
      totalFires: 1,
      inserted: 1,
    });
  });

  it('skips chains with fewer than baselineBuckets+1 buckets', async () => {
    // Only 3 buckets — below the 5-bucket detector minimum. Handler
    // bails with skippedShort before any prior-fires lookup or insert.
    const shortStream = fireableSilentBoomStream().slice(0, 3);
    mockSql.mockResolvedValueOnce(shortStream);
    mockSql.mockResolvedValueOnce([]); // tide ticks (always queried)

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      skippedShort: 1,
      totalFires: 0,
      inserted: 0,
    });
    // ticks SELECT + tide ticks SELECT (no eligible chains so the
    // prior-fires query is skipped, but tide ticks always queries).
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('skips chains whose max OI is below the minOi floor', async () => {
    // Same shape as the fireable stream but with OI=50 on every tick
    // — below MIN_OI=100. Handler bails with skippedNoOi.
    const lowOiStream = fireableSilentBoomStream().map((t) => ({
      ...t,
      open_interest: 50,
    }));
    mockSql
      .mockResolvedValueOnce(lowOiStream) // ticks
      .mockResolvedValueOnce([]) // prior fires (chain passed bucket-count gate)
      .mockResolvedValueOnce([]); // tide ticks

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      skippedNoOi: 1,
      totalFires: 0,
      inserted: 0,
    });
  });

  it('honors ON CONFLICT (returns 0 inserted when DB returns no rows)', async () => {
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // tide ticks
      .mockResolvedValueOnce([]); // insert returns no rows = ON CONFLICT hit

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      totalFires: 1,
      inserted: 0,
    });
  });

  it('seeds detector cooldown from prior-fire SELECT — no duplicate fire when within 60-min cooldown', async () => {
    // Spike bucket is at 13:20:00Z. Seed prior fire at 12:30:00Z
    // (50 min before). Cooldown is 60 min, so the detector must
    // suppress the new fire.
    const priorMs = Date.parse('2026-05-07T12:30:00Z');
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream()) // ticks
      .mockResolvedValueOnce([
        {
          option_chain_id: 'SNDK260507C01175000',
          last_ms: String(priorMs),
        },
      ]) // prior fire — cooldown active
      .mockResolvedValueOnce([]); // tide ticks

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      totalFires: 0,
      inserted: 0,
      priorSeeds: 1,
    });
    // Three SQL calls — ticks SELECT, prior-fires lookup, tide ticks
    // SELECT. No insert because the cooldown gate suppressed the fire
    // entirely.
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('binds the latest market_tide tick (NCP - NPP) to the INSERT', async () => {
    // Spike bucket at 13:20:00Z. Seed a market_tide tick at 13:18Z
    // (2 min before, inside the 30-min staleness window) with
    // NCP=8000, NPP=2000 — diff +6000.
    const tickMs = Date.parse('2026-05-07T13:18:00Z');
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([
        { ts_ms: String(tickMs), ncp: '8000', npp: '2000' },
      ]) // tide ticks
      .mockResolvedValueOnce([{ id: 1 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(4);
    // The INSERT is the last call. Tide diff is the last bound value.
    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    const tideDiff = insertCall.at(-1);
    expect(tideDiff).toBe(6000);
  });

  it('binds null tide diff when the latest tick is older than 30 minutes', async () => {
    // Spike bucket at 13:20:00Z. Tide tick at 12:00Z — 80 min before,
    // outside the 30-min staleness window, so tide diff should be null.
    const staleTickMs = Date.parse('2026-05-07T12:00:00Z');
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { ts_ms: String(staleTickMs), ncp: '8000', npp: '2000' },
      ])
      .mockResolvedValueOnce([{ id: 2 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    expect(insertCall.at(-1)).toBeNull();
  });

  it('still fires when prior-fire is older than the 60-min cooldown', async () => {
    // Spike at 13:20:00Z, prior at 12:00:00Z (80 min before — outside
    // the 60-min cooldown). The detector lets the new fire through.
    const priorMs = Date.parse('2026-05-07T12:00:00Z');
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream())
      .mockResolvedValueOnce([
        {
          option_chain_id: 'SNDK260507C01175000',
          last_ms: String(priorMs),
        },
      ])
      .mockResolvedValueOnce([]) // tide ticks
      .mockResolvedValueOnce([{ id: 99 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      totalFires: 1,
      inserted: 1,
      priorSeeds: 1,
    });
  });
});
