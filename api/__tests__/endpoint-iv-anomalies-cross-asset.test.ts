// @vitest-environment node

/**
 * HTTP-level tests for POST /api/iv-anomalies-cross-asset.
 * Covers regime classification, tape alignment, DP cluster bucketing,
 * GEX position, and VIX direction over the bulk POST shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
  checkBot: vi.fn(async () => ({ isBot: false })),
  setCacheHeaders: vi.fn(),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn(
      (cb: (s: { setTag: (k: string, v: string) => void }) => unknown) =>
        cb({ setTag: vi.fn() }),
    ),
    captureException: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import handler from '../iv-anomalies-cross-asset.js';
import { rejectIfNotOwner, checkBot } from '../_lib/api-helpers.js';

const ALERT_TS = '2026-04-23T15:30:00Z';
const ALERT_DATE = '2026-04-23';
const SPXW_KEY = {
  ticker: 'SPXW' as const,
  strike: 7100,
  side: 'call' as const,
  expiry: '2026-04-23',
  alertTs: ALERT_TS,
};

function setupSqlSequence(rows: unknown[][]): void {
  mockSql.mockReset();
  for (const r of rows) {
    mockSql.mockResolvedValueOnce(r);
  }
}

interface CrossAssetCtxLite {
  regime?: string;
  tapeAlignment?: string;
  dpCluster?: string;
  gexZone?: string;
  vixDirection?: string;
}

/** Read the `contexts[key]` entry off a mock response without ceremony. */
function getCtx(
  res: { _json: unknown },
  key = 'SPXW:7100:call:2026-04-23',
): CrossAssetCtxLite | undefined {
  const body = res._json as { contexts?: Record<string, CrossAssetCtxLite> };
  return body.contexts?.[key];
}

describe('POST /api/iv-anomalies-cross-asset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(checkBot).mockResolvedValue({ isBot: false });
  });

  it('returns 405 for non-POST', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', body: { keys: [SPXW_KEY] } }),
      res,
    );
    expect(res._status).toBe(405);
  });

  it('returns 403 when bot detected', async () => {
    vi.mocked(checkBot).mockResolvedValue({ isBot: true });
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { keys: [SPXW_KEY] } }),
      res,
    );
    expect(res._status).toBe(403);
  });

  it('returns 401 when not owner', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Owner only' });
      return true;
    });
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { keys: [SPXW_KEY] } }),
      res,
    );
    expect(res._status).toBe(401);
  });

  it('rejects empty keys array', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: { keys: [] } }), res);
    expect(res._status).toBe(400);
  });

  it('rejects malformed key', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: {
          keys: [
            {
              ticker: 'XXX',
              strike: -1,
              side: 'call',
              expiry: 'bad',
              alertTs: 'bad',
            },
          ],
        },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('classifies mild_trend_up regime when last_spot is +0.6% over first_spot', async () => {
    setupSqlSequence([
      // spot pairs: SPXW first=7100, last=7142 → +0.59%
      [
        {
          ticker: 'SPXW',
          date: ALERT_DATE,
          first_spot: '7100',
          last_spot: '7142',
        },
      ],
      // futures bars (NQ/ES/RTY)
      [],
      // SPX 1m candles
      [],
      // dark pool levels
      [],
      // GEX strikes
      [],
      // VIX snapshots
      [],
      // underlying spot
      [],
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { keys: [SPXW_KEY] } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(getCtx(res)?.regime).toBe('mild_trend_up');
  });

  it('classifies chop regime under |0.25%|', async () => {
    setupSqlSequence([
      [
        {
          ticker: 'SPXW',
          date: ALERT_DATE,
          first_spot: '7100',
          last_spot: '7110',
        },
      ], // +0.14%
      [],
      [],
      [],
      [],
      [],
      [],
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { keys: [SPXW_KEY] } }),
      res,
    );
    expect(getCtx(res, 'SPXW:7100:call:2026-04-23')?.regime).toBe('chop');
  });

  it('marks aligned tape when SPX, NQ, ES, RTY all moved up over the prior 15min and side=call', async () => {
    const start = new Date('2026-04-23T15:15:00Z');
    const end = new Date('2026-04-23T15:30:00Z');
    setupSqlSequence([
      [
        {
          ticker: 'SPXW',
          date: ALERT_DATE,
          first_spot: '7100',
          last_spot: '7140',
        },
      ],
      [
        { symbol: 'NQ', ts: start, close: '20000' },
        { symbol: 'NQ', ts: end, close: '20100' },
        { symbol: 'ES', ts: start, close: '6800' },
        { symbol: 'ES', ts: end, close: '6850' },
        { symbol: 'RTY', ts: start, close: '2200' },
        { symbol: 'RTY', ts: end, close: '2210' },
      ],
      [
        { ts: start, close: '7100' },
        { ts: end, close: '7140' },
      ],
      [],
      [],
      [],
      [],
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { keys: [SPXW_KEY] } }),
      res,
    );
    expect(getCtx(res, 'SPXW:7100:call:2026-04-23')?.tapeAlignment).toBe(
      'aligned',
    );
  });

  it('marks contradicted tape when SPX, NQ, ES all moved DOWN and side=call', async () => {
    const start = new Date('2026-04-23T15:15:00Z');
    const end = new Date('2026-04-23T15:30:00Z');
    setupSqlSequence([
      [
        {
          ticker: 'SPXW',
          date: ALERT_DATE,
          first_spot: '7100',
          last_spot: '7100',
        },
      ],
      [
        { symbol: 'NQ', ts: start, close: '20100' },
        { symbol: 'NQ', ts: end, close: '20000' },
        { symbol: 'ES', ts: start, close: '6850' },
        { symbol: 'ES', ts: end, close: '6800' },
        { symbol: 'RTY', ts: start, close: '2210' },
        { symbol: 'RTY', ts: end, close: '2200' },
      ],
      [
        { ts: start, close: '7140' },
        { ts: end, close: '7100' },
      ],
      [],
      [],
      [],
      [],
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { keys: [SPXW_KEY] } }),
      res,
    );
    expect(getCtx(res, 'SPXW:7100:call:2026-04-23')?.tapeAlignment).toBe(
      'contradicted',
    );
  });

  it('classifies DP cluster as large when SPXW has $250M+ at strike', async () => {
    setupSqlSequence([
      [
        {
          ticker: 'SPXW',
          date: ALERT_DATE,
          first_spot: '7100',
          last_spot: '7100',
        },
      ],
      [],
      [],
      [{ date: ALERT_DATE, spx_approx: '7100', total_premium: '300000000' }],
      [],
      [],
      [],
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { keys: [SPXW_KEY] } }),
      res,
    );
    expect(getCtx(res, 'SPXW:7100:call:2026-04-23')?.dpCluster).toBe('large');
  });

  it('returns na DP cluster for non-SPXW tickers', async () => {
    setupSqlSequence([
      [
        {
          ticker: 'NVDA',
          date: ALERT_DATE,
          first_spot: '200',
          last_spot: '202',
        },
      ],
      [],
      [],
      [],
      [],
      [],
      [],
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: {
          keys: [{ ...SPXW_KEY, ticker: 'NVDA', strike: 200 }],
        },
      }),
      res,
    );
    expect(getCtx(res, 'NVDA:200:call:2026-04-23')?.dpCluster).toBe('na');
  });

  it('classifies GEX zone as below_spot when nearest top-3 GEX strike < spot', async () => {
    setupSqlSequence([
      [
        {
          ticker: 'SPXW',
          date: ALERT_DATE,
          first_spot: '7100',
          last_spot: '7150',
        },
      ],
      [],
      [],
      [],
      [
        {
          date: ALERT_DATE,
          expiry: '2026-04-23',
          strike: '7080',
          abs_gex: '1000000000',
        },
      ],
      [],
      [],
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { keys: [SPXW_KEY] } }),
      res,
    );
    expect(getCtx(res, 'SPXW:7100:call:2026-04-23')?.gexZone).toBe(
      'below_spot',
    );
  });

  it('marks vix_direction as falling when 30-min change is below -0.2', async () => {
    setupSqlSequence([
      [
        {
          ticker: 'SPXW',
          date: ALERT_DATE,
          first_spot: '7100',
          last_spot: '7100',
        },
      ],
      [],
      [],
      [],
      [],
      [
        { date: ALERT_DATE, entry_time: '10:00 AM CT', vix: '19.5' },
        { date: ALERT_DATE, entry_time: '10:30 AM CT', vix: '19.0' },
      ],
      [],
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { keys: [{ ...SPXW_KEY, alertTs: '2026-04-23T15:30:00Z' }] },
      }),
      res,
    );
    expect(getCtx(res, 'SPXW:7100:call:2026-04-23')?.vixDirection).toBe(
      'falling',
    );
  });

  it('returns unknown regime when no spot data exists', async () => {
    setupSqlSequence([[], [], [], [], [], [], []]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { keys: [SPXW_KEY] } }),
      res,
    );
    expect(getCtx(res, 'SPXW:7100:call:2026-04-23')?.regime).toBe('unknown');
  });

  it('returns 500 with logged error on db failure', async () => {
    mockSql.mockRejectedValue(new Error('pg down'));
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { keys: [SPXW_KEY] } }),
      res,
    );
    expect(res._status).toBe(500);
  });
});
