// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
  uwFetch: vi.fn(),
}));

import handler, { classifyTrack } from '../cron/fetch-spxw-blocks.js';
import { cronGuard, uwFetch } from '../_lib/api-helpers.js';

// ── Helpers ───────────────────────────────────────────────

function makeReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

function makeContract(overrides: Record<string, unknown> = {}) {
  return {
    option_symbol: 'SPXW261218C08150000',
    strike: '8150',
    option_type: 'call' as const,
    expiry: '2026-12-18',
    volume: 1000,
    open_interest: 5000,
    ...overrides,
  };
}

function makeTrade(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trade-1',
    executed_at: '2026-04-23T19:45:00Z',
    option_chain_id: 'SPXW261218C08150000',
    strike: '8150',
    option_type: 'call' as const,
    expiry: '2026-12-18',
    size: 30000,
    price: '55.85',
    premium: '167550000',
    underlying_price: '7044.27',
    upstream_condition_detail: 'mfsl',
    tags: ['ask_side'],
    canceled: false,
    ...overrides,
  };
}

// ── classifyTrack unit tests ──────────────────────────────

describe('classifyTrack', () => {
  it('classifies 260 DTE call at 15% OTM as ceiling', () => {
    expect(classifyTrack(260, 0.15, '2026-04-23T15:00:00Z')).toBe('ceiling');
  });

  it('classifies 0 DTE near-ATM in opening window as opening_atm', () => {
    // 13:45 UTC = 08:45 CT, inside open window
    expect(classifyTrack(0, 0.001, '2026-04-23T13:45:00Z')).toBe('opening_atm');
  });

  it('classifies 0 DTE near-ATM OUTSIDE opening window as other', () => {
    // 18:00 UTC = 13:00 CT, outside 08:30-09:30 CT window
    expect(classifyTrack(0, 0.001, '2026-04-23T18:00:00Z')).toBe('other');
  });

  it('classifies 30 DTE at 1% OTM (neither pass) as other', () => {
    expect(classifyTrack(30, 0.01, '2026-04-23T15:00:00Z')).toBe('other');
  });

  it('classifies negative moneyness correctly (OTM put)', () => {
    // 260 DTE put 10% below spot — should still be 'ceiling' (|mny| = 0.10)
    expect(classifyTrack(260, -0.10, '2026-04-23T15:00:00Z')).toBe('ceiling');
  });
});

// ── Handler integration ───────────────────────────────────

describe('fetch-spxw-blocks handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockResolvedValue([]);
    process.env.CRON_SECRET = 'test-secret';
    process.env.UW_API_KEY = 'test-uw-key';
    // cronGuard: return { apiKey, today } on success.
    vi.mocked(cronGuard).mockReturnValue({
      apiKey: 'test-uw-key',
      today: '2026-04-23',
    } as never);
  });

  it('filters to mfsl/cbmo/slft and upserts blocks', async () => {
    // 1st uwFetch call: contract enumeration (for BOTH passes)
    vi.mocked(uwFetch).mockResolvedValueOnce([
      makeContract({ option_symbol: 'SPXW261218C08150000' }),
    ] as never[]);
    // 2nd uwFetch call: flow for the SPXW261218C08150000 contract
    vi.mocked(uwFetch).mockResolvedValueOnce([
      makeTrade(), // mfsl, size 30000 — KEEP
      makeTrade({
        id: 'trade-2-small',
        size: 20, // below MIN_BLOCK_SIZE (50) — DROP
        upstream_condition_detail: 'mfsl',
      }),
      makeTrade({
        id: 'trade-3-auto',
        upstream_condition_detail: 'auto', // wrong cond — DROP
      }),
      makeTrade({
        id: 'trade-4-canceled',
        canceled: true, // DROP
      }),
    ] as never[]);

    const req = makeReq();
    const res = mockResponse();

    await handler(req as never, res as never);

    expect(res._status).toBe(200);
    // Only trade-1 (mfsl + size 30000) should have been inserted.
    const insertCalls = mockSql.mock.calls.filter((c) =>
      String(c[0]?.[0] ?? '').includes('INSERT INTO institutional_blocks'),
    );
    expect(insertCalls.length).toBe(1);
  });

  it('skips contracts whose moneyness is outside the pass window', async () => {
    // Contract at spot-equivalent strike (mny=0) — ceiling pass mny_min is 0.05
    // so this should be skipped. But opening_atm accepts up to 0.03, and at
    // dte 260 it's way out of opening_atm's 0-7 window too.
    vi.mocked(uwFetch).mockResolvedValueOnce([
      makeContract({
        strike: '7040',
        option_symbol: 'SPXW261218C07040000',
      }),
    ] as never[]);
    vi.mocked(uwFetch).mockResolvedValueOnce([
      makeTrade({
        strike: '7040',
        option_chain_id: 'SPXW261218C07040000',
        underlying_price: '7044.27',
      }),
    ] as never[]);

    const req = makeReq();
    const res = mockResponse();

    await handler(req as never, res as never);

    expect(res._status).toBe(200);
    // Moneyness is ~0.06% — below ceiling's 5% min, skipped.
    const insertCalls = mockSql.mock.calls.filter((c) =>
      String(c[0]?.[0] ?? '').includes('INSERT INTO institutional_blocks'),
    );
    expect(insertCalls.length).toBe(0);
  });

  it('returns early when cronGuard rejects', async () => {
    vi.mocked(cronGuard).mockReturnValue(null as never);
    const req = makeReq();
    const res = mockResponse();
    await handler(req as never, res as never);
    expect(uwFetch).not.toHaveBeenCalled();
  });

  it('returns 200 with zero blocks when UW returns empty contract list', async () => {
    vi.mocked(uwFetch).mockResolvedValueOnce([] as never[]);
    const req = makeReq();
    const res = mockResponse();
    await handler(req as never, res as never);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ok: true,
      contracts: 0,
      blocks: 0,
    });
  });
});
