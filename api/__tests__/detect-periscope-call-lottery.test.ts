// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
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

const mockDetectCallLottery = vi.hoisted(() => vi.fn());
const mockTodayExpiry = vi.hoisted(() => vi.fn(() => '2026-05-18'));
vi.mock('../_lib/periscope-lottery-finder.js', () => ({
  detectCallLottery: mockDetectCallLottery,
  todayExpiry: mockTodayExpiry,
}));

import handler from '../cron/detect-periscope-call-lottery.js';
import { mockRequest, mockResponse } from './helpers';

beforeEach(() => {
  mockSql.mockReset();
  mockDetectCallLottery.mockReset();
  mockCronGuard.mockReset();
  // Default cronGuard returns auth context — handler proceeds
  // cronGuard is synchronous (returns CronGuardResult | null), so use
  // mockReturnValue — see detect-silent-boom.test.ts:153 for the canonical
  // pattern. Tests pass today because the handler doesn't dereference
  // ctx.today, but the Promise-vs-value mismatch would bite the moment
  // a future handler reads from the guard result.
  mockCronGuard.mockReturnValue({ apiKey: '', today: '2026-05-18' });
});

const buildFire = (overrides: Record<string, unknown> = {}) => ({
  fireType: 'call_lottery' as const,
  fireTime: new Date('2026-05-18T18:43:12Z'),
  expiry: '2026-05-18',
  eventStrike: 7380,
  tradeStrike: 7430,
  spotAtEvent: 7362.14,
  strikeDist: 17.86,
  greekPost: -7403.4,
  greekDelta: -4513.3,
  greekLvlRank: 0.95,
  greekChgRank: 0.999,
  gexDollars: -974008661,
  callRatio: -3.58,
  qqqNetPremBalance30m: 0.6,
  entryPx: 0.1,
  vix: 18.31,
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

describe('detect-periscope-call-lottery cron', () => {
  it('returns success with rows=0 when detector finds no fires', async () => {
    mockDetectCallLottery.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(mockDetectCallLottery).toHaveBeenCalledWith('2026-05-18');
    expect(mockSql).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
    });
  });

  it('upserts each detected fire and counts successful inserts', async () => {
    const fires = [
      buildFire({ eventStrike: 7380 }),
      buildFire({
        eventStrike: 7400,
        fireTime: new Date('2026-05-18T18:53:12Z'),
      }),
    ];
    mockDetectCallLottery.mockResolvedValueOnce(fires);
    // Both inserts succeed (RETURNING id)
    mockSql.mockResolvedValueOnce([{ id: 1 }]);
    mockSql.mockResolvedValueOnce([{ id: 2 }]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(res._json).toMatchObject({ status: 'success', rows: 2 });
  });

  it('counts ON CONFLICT skips correctly (idempotent re-scan)', async () => {
    const fires = [
      buildFire({ eventStrike: 7380 }),
      buildFire({
        eventStrike: 7400,
        fireTime: new Date('2026-05-18T18:53:12Z'),
      }),
    ];
    mockDetectCallLottery.mockResolvedValueOnce(fires);
    // First insert succeeds, second hits ON CONFLICT (empty array returned)
    mockSql.mockResolvedValueOnce([{ id: 1 }]);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
  });

  it('surfaces v4Badge count in metadata for monitoring', async () => {
    const fires = [
      buildFire({ v4Badge: true }),
      buildFire({ eventStrike: 7400, v4Badge: false }),
      buildFire({ eventStrike: 7420, v4Badge: true }),
    ];
    mockDetectCallLottery.mockResolvedValueOnce(fires);
    mockSql.mockResolvedValue([{ id: 1 }]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ v4Badges: 2, candidates: 3 });
  });
});
