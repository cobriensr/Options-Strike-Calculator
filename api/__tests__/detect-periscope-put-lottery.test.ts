// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setTag: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const mockCronGuard = vi.hoisted(() => vi.fn());
vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

const mockDetectPutLottery = vi.hoisted(() => vi.fn());
const mockTodayExpiry = vi.hoisted(() => vi.fn(() => '2026-04-23'));
vi.mock('../_lib/periscope-lottery-finder.js', () => ({
  detectPutLottery: mockDetectPutLottery,
  todayExpiry: mockTodayExpiry,
}));

import handler from '../cron/detect-periscope-put-lottery.js';
import { mockRequest, mockResponse } from './helpers';

beforeEach(() => {
  mockSql.mockReset();
  mockDetectPutLottery.mockReset();
  mockCronGuard.mockReset();
  // cronGuard is synchronous — see detect-silent-boom.test.ts:153.
  mockCronGuard.mockReturnValue({ apiKey: '', today: '2026-04-23' });
});

const buildPutFire = (overrides: Record<string, unknown> = {}) => ({
  fireType: 'put_lottery' as const,
  fireTime: new Date('2026-04-23T15:00:00Z'),
  expiry: '2026-04-23',
  eventStrike: 7105,
  tradeStrike: 7055,
  spotAtEvent: 7142.45,
  strikeDist: 37.45,
  greekPost: -621000000,
  greekDelta: 2170000,
  greekLvlRank: 0.98,
  greekChgRank: 0.99,
  gexDollars: 500000000,
  callRatio: 0.8,
  qqqNetPremBalance30m: null, // not used for L
  entryPx: 0.42,
  vix: 20.5,
  v3StrictPass: true,
  v4Badge: true,
  peakPx: null,
  peakPct: null,
  peakTime: null,
  eodClosePx: null,
  realizedRPeak: null,
  realizedREod: null,
  outcomeLocked: false,
  ...overrides,
});

describe('detect-periscope-put-lottery cron', () => {
  it('returns success with rows=0 when detector finds no fires', async () => {
    mockDetectPutLottery.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(mockDetectPutLottery).toHaveBeenCalledWith('2026-04-23');
    expect(mockSql).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({ status: 'success', rows: 0 });
  });

  it('upserts the 4/23 7105 charm fire (57x reproduction)', async () => {
    mockDetectPutLottery.mockResolvedValueOnce([buildPutFire()]);
    mockSql.mockResolvedValueOnce([{ id: 1 }]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      expiry: '2026-04-23',
      candidates: 1,
      v4Badges: 1,
    });
  });

  it('binds null qqq_net_prem_balance_30m for put fires', async () => {
    const fire = buildPutFire({ qqqNetPremBalance30m: null });
    mockDetectPutLottery.mockResolvedValueOnce([fire]);
    mockSql.mockResolvedValueOnce([{ id: 1 }]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // mockSql.mock.calls[0]:
    //   [0]   = template-strings array (sql`...`)
    //   [1..] = bound parameter values in source order
    // INSERT VALUES order from detect-periscope-put-lottery.ts:
    //   1  fire_type
    //   2  fire_time
    //   3  expiry
    //   4  event_strike
    //   5  trade_strike
    //   6  spot_at_event
    //   7  strike_dist
    //   8  greek_post
    //   9  greek_delta
    //   10 greek_lvl_rank
    //   11 greek_chg_rank
    //   12 gex_dollars
    //   13 call_ratio
    //   14 qqq_net_prem_balance_30m   ← pin this slot
    //   15 entry_px
    //   16 vix
    //   17 v3_strict_pass
    //   18 v4_badge
    const callArgs = mockSql.mock.calls[0];
    expect(callArgs).toBeDefined();
    // QQQ at position 14 in args (after the template strings at index 0)
    expect(callArgs?.[14]).toBeNull();
    // Also verify entry_px right after is the fixture value (sanity check
    // that we're indexing into the right slot)
    expect(callArgs?.[15]).toBe(0.42);
  });

  it('counts ON CONFLICT skips correctly', async () => {
    const fires = [
      buildPutFire({ eventStrike: 7105 }),
      buildPutFire({
        eventStrike: 7100,
        fireTime: new Date('2026-04-23T15:10:00Z'),
      }),
    ];
    mockDetectPutLottery.mockResolvedValueOnce(fires);
    mockSql.mockResolvedValueOnce([{ id: 1 }]);
    mockSql.mockResolvedValueOnce([]); // ON CONFLICT skip

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
  });
});
