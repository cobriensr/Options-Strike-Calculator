// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockRequest, mockResponse } from './helpers';

const mockSql = Object.assign(vi.fn(), {
  unsafe: vi.fn((raw: string) => raw),
});

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureMessage: vi.fn(),
    captureException: vi.fn(),
    setTag: vi.fn(),
    withIsolationScope: vi.fn((cb: (scope: object) => unknown) =>
      cb({ setTransactionName: vi.fn() }),
    ),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn().mockResolvedValue(undefined),
}));

const { mockCronGuard } = vi.hoisted(() => ({ mockCronGuard: vi.fn() }));

vi.mock('../_lib/api-helpers.js', () => ({ cronGuard: mockCronGuard }));

vi.mock('../_lib/cron-instrumentation.js', () => ({
  withCronCheckin: (_name: string, fn: unknown) => fn,
}));

import handler from '../cron/audit-gexbot-health.js';
import { Sentry } from '../_lib/sentry.js';

/** One aggregate row matching the handler's SELECT shape. */
function healthRow(
  over: Partial<{
    rows_all: number;
    zg_null_all: number;
    sgo_null_all: number;
    drr_null_all: number;
    rows_spx: number;
    zg_null_spx: number;
  }> = {},
) {
  return {
    rows_all: 7000,
    zg_null_all: 0,
    sgo_null_all: 0,
    drr_null_all: 0,
    rows_spx: 440,
    zg_null_spx: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCronGuard.mockReturnValue({ apiKey: '' });
  process.env.CRON_SECRET = 'test-secret';
});

describe('audit-gexbot-health cron', () => {
  it('rejects requests when cronGuard returns null', async () => {
    mockCronGuard.mockImplementationOnce(
      (
        _req: unknown,
        res: { status: (code: number) => { json: (v: unknown) => unknown } },
      ) => {
        res.status(401).json({ error: 'Unauthorized' });
        return null;
      },
    );
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('does not alert when zero_gamma is populating (low NULL rate)', async () => {
    mockSql.mockResolvedValueOnce([healthRow()]);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ success: true, zgNullAllPct: 0 });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('alerts when the classic-basic merge regresses (overall zero_gamma all NULL)', async () => {
    mockSql.mockResolvedValueOnce([
      healthRow({ zg_null_all: 7000, zg_null_spx: 440 }),
    ]);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { level: string; tags: Record<string, string> }];
    expect(msg).toMatch(/zero_gamma NULL 100\.0% overall/);
    expect(opts.level).toBe('warning');
    expect(opts.tags['cron.anomaly']).toBe('gexbot-health');
  });

  it('alerts on an SPX-only break even when the overall rate stays low', async () => {
    // SPX fully NULL (440/440) but only 440/7000 overall = 6.3% — below the
    // overall threshold, so the SPX-specific check is what catches it.
    mockSql.mockResolvedValueOnce([
      healthRow({ zg_null_all: 440, zg_null_spx: 440 }),
    ]);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [msg] = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string];
    expect(msg).toMatch(/zero_gamma NULL 100\.0% for SPX/);
    expect(msg).not.toMatch(/overall/);
  });

  it('alerts on a capture outage (zero snapshots in the window)', async () => {
    mockSql.mockResolvedValueOnce([healthRow({ rows_all: 0, rows_spx: 0 })]);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [msg] = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string];
    expect(msg).toMatch(/no gexbot_snapshots in last 12h/);
  });
});
