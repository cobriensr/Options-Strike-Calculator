// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockCapture, mockException, mockReport, mockError, eod } = vi.hoisted(
  () => ({
    mockCapture: vi.fn(),
    mockException: vi.fn(),
    mockReport: vi.fn(),
    mockError: vi.fn(),
    eod: {
      fetchEodTickers: vi.fn(),
      latestEligibleReportDate: vi.fn(),
      listStoredTickers: vi.fn(),
    },
  }),
);

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: mockError },
}));
vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: mockException,
    captureMessage: mockCapture,
  },
  metrics: { uwRateLimit: vi.fn() },
}));
vi.mock('../_lib/axiom.js', () => ({ reportCronRun: mockReport }));
vi.mock('../_lib/gexbot-eod.js', () => eod);

import handler from '../cron/audit-gexbot-eod.js';

const AUTH = { authorization: 'Bearer test-secret' };
const DATE = '2026-10-28';
const NOW = new Date('2026-10-29T19:45:00.000Z');

type Json = Record<string, any>;

async function run() {
  const res = mockResponse();
  await handler(mockRequest({ method: 'GET', headers: AUTH }), res);
  return res;
}

function setTickers(tickers: string[], rejected: string[] = []) {
  eod.fetchEodTickers.mockResolvedValue({ tickers, rejected });
}

describe('audit-gexbot-eod', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    eod.latestEligibleReportDate.mockReturnValue(DATE);
    eod.listStoredTickers.mockResolvedValue(new Set(['SPX', 'NDX']));
    setTickers(['SPX', 'NDX']);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  it('rejects a request without the cron secret', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
    expect(eod.fetchEodTickers).not.toHaveBeenCalled();
  });

  it('reports success and sends no Sentry message when nothing is missing', async () => {
    const res = await run();
    const body = res._json as Json;
    expect(res._status).toBe(200);
    expect(body).toMatchObject({
      status: 'success',
      date: DATE,
      tickers: 2,
      missing: [],
    });
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });

  it('derives the date from latestEligibleReportDate(now)', async () => {
    await run();
    expect(eod.latestEligibleReportDate).toHaveBeenCalledWith(NOW);
    expect(eod.listStoredTickers).toHaveBeenCalledWith(DATE);
  });

  it.each([
    ['2026-10-29T19:45:00.000Z', '2026-10-28'],
    ['2026-11-02T19:45:00.000Z', '2026-10-30'],
  ])(
    'audits the real previous trading day at %s (EDT and EST)',
    async (now, expected) => {
      const actual = await vi.importActual<
        typeof import('../_lib/gexbot-eod.js')
      >('../_lib/gexbot-eod.js');
      vi.setSystemTime(new Date(now));
      eod.latestEligibleReportDate.mockImplementation(
        actual.latestEligibleReportDate,
      );
      await run();
      expect(eod.listStoredTickers).toHaveBeenCalledWith(expected);
    },
  );

  it('returns error and alerts once when tickers are missing', async () => {
    eod.listStoredTickers.mockResolvedValue(new Set(['SPX']));
    setTickers(['SPX', 'NDX', 'QQQ']);
    const res = await run();
    const body = res._json as Json;
    expect(body.status).toBe('error');
    expect(body.missing).toEqual(['NDX', 'QQQ']);
    expect(body.message).toContain(DATE);
    expect(mockReport).toHaveBeenCalledWith(
      'audit-gexbot-eod',
      expect.objectContaining({ status: 'error' }),
    );
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(
      `GEXBot EOD reports missing for ${DATE}: 2 tickers`,
      {
        level: 'error',
        fingerprint: ['gexbot-eod', 'missed-window'],
        extra: { date: DATE, missing: ['NDX', 'QQQ'] },
      },
    );
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ date: DATE, missing: ['NDX', 'QQQ'] }),
      expect.any(String),
    );
  });

  it('keeps /tickers priority order in missing', async () => {
    setTickers(['Z', 'SPX', 'A', 'NDX']);
    eod.listStoredTickers.mockResolvedValue(new Set(['SPX']));
    const res = await run();
    expect((res._json as Json).missing).toEqual(['Z', 'A', 'NDX']);
  });

  it('stays success with rejected tickers reported as information only', async () => {
    setTickers(['SPX', 'NDX'], ['bad/ticker']);
    const res = await run();
    const body = res._json as Json;
    expect(body.status).toBe('success');
    expect(body.rejectedTickers).toEqual(['bad/ticker']);
    expect(body.missing).toEqual([]);
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(
      'GEXBot EOD tickers rejected by the charset: bad/ticker',
      {
        level: 'warning',
        fingerprint: ['gexbot-eod', 'rejected-tickers'],
        extra: { date: DATE, rejected: ['bad/ticker'] },
      },
    );
  });

  it('sends both the rejected-tickers warning and the missed-window error', async () => {
    setTickers(['SPX', 'NDX'], ['a b', 'c d']);
    eod.listStoredTickers.mockResolvedValue(new Set(['SPX']));
    const res = await run();
    expect((res._json as Json).status).toBe('error');
    const fingerprints = mockCapture.mock.calls.map(
      ([, o]) => (o as { fingerprint: string[] }).fingerprint[1],
    );
    expect(fingerprints).toEqual(['rejected-tickers', 'missed-window']);
  });

  it('surfaces a /tickers failure as a thrown error', async () => {
    eod.fetchEodTickers.mockRejectedValue(
      new Error('gexbot_tickers_failed: HTTP 503'),
    );
    const res = await run();
    expect(res._status).toBe(500);
    expect(mockException).toHaveBeenCalledTimes(1);
    expect(mockReport).toHaveBeenCalledWith(
      'audit-gexbot-eod',
      expect.objectContaining({ status: 'error' }),
    );
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('surfaces a DB rejection as a thrown error', async () => {
    eod.listStoredTickers.mockRejectedValue(new Error('connection lost'));
    const res = await run();
    expect(res._status).toBe(500);
    expect(mockException).toHaveBeenCalledTimes(1);
    expect(mockReport).toHaveBeenCalledWith(
      'audit-gexbot-eod',
      expect.objectContaining({ status: 'error' }),
    );
  });
});
