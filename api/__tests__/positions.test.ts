// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerEndpoint: vi.fn().mockResolvedValue(false),
  rejectIfRateLimited: vi.fn(),
  schwabTraderFetch: vi.fn(),
}));

vi.mock('../_lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/db.js')>();
  return {
    savePositions: vi.fn(),
    getLatestCsvPositions: vi.fn(),
    getDb: vi.fn(),
    withDbRetry: async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        if (actual.isRetryableDbError(err)) {
          throw new actual.TransientDbError(err);
        }
        throw err;
      }
    },
    safeDb: actual.safeDb,
    TransientDbError: actual.TransientDbError,
    isRetryableDbError: actual.isRetryableDbError,
  };
});

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: {
    request: vi.fn(() => vi.fn()),
    dbSave: vi.fn(),
    increment: vi.fn(),
  },
}));

vi.mock('../_lib/csv-parser.js', () => ({
  parseFullCSV: vi.fn(),
  buildFullSummary: vi.fn(() => 'summary'),
  parseTosExpiration: vi.fn(),
}));

import handler from '../positions.js';
import { parseFullCSV } from '../_lib/csv-parser.js';
import {
  guardOwnerEndpoint,
  rejectIfRateLimited,
  schwabTraderFetch,
} from '../_lib/api-helpers.js';
import {
  savePositions,
  getLatestCsvPositions,
  getDb,
  type PositionLeg,
} from '../_lib/db.js';
import { TransientDbError } from '../_lib/transient-db-error.js';
import { Sentry, metrics } from '../_lib/sentry.js';

describe('GET /api/positions', () => {
  const mockSql = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(guardOwnerEndpoint).mockResolvedValue(false);
    vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
    vi.mocked(getDb).mockReturnValue(mockSql as never);
    mockSql.mockResolvedValue([]);
    vi.mocked(savePositions).mockResolvedValue(1);
    vi.mocked(Sentry.captureException).mockClear();
    // Silence expected console.error from error-path tests
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns 405 for unsupported methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'PUT' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET or POST only' });
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(guardOwnerEndpoint).mockImplementation(async (_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
  });

  it('returns early when rate limited', async () => {
    vi.mocked(rejectIfRateLimited).mockImplementation(async (_req, res) => {
      res.status(429).json({ error: 'Rate limited' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(429);
  });

  it('returns error when account numbers fetch fails', async () => {
    vi.mocked(schwabTraderFetch).mockResolvedValueOnce({
      ok: false,
      error: 'Unauthorized',
      status: 401,
      code: 'SCHWAB_API_REJECTED',
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Unauthorized' });
  });

  it('returns 404 when no linked accounts', async () => {
    vi.mocked(schwabTraderFetch).mockResolvedValueOnce({ ok: true, data: [] });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(404);
    expect(res._json).toEqual({ error: 'No linked accounts found' });
  });

  it('returns error when positions fetch fails', async () => {
    vi.mocked(schwabTraderFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
        ok: false,
        error: 'Server error',
        status: 502,
        code: 'SCHWAB_API_502',
      });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(502);
  });

  it('returns empty positions when no SPX 0DTE options', async () => {
    vi.mocked(schwabTraderFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          securitiesAccount: {
            accountNumber: '123',
            type: 'MARGIN',
            positions: [
              {
                shortQuantity: 100,
                longQuantity: 0,
                averagePrice: 150,
                currentDayProfitLoss: 0,
                currentDayProfitLossPercentage: 0,
                marketValue: 15000,
                instrument: {
                  assetType: 'EQUITY',
                  symbol: 'AAPL',
                },
              },
            ],
          },
        },
      });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    const json = res._json as {
      positions: { legs: unknown[]; spreads: unknown[] };
    };
    expect(json.positions.legs).toHaveLength(0);
    expect(json.positions.spreads).toHaveLength(0);
  });

  it('filters for SPX 0DTE options and groups into spreads', async () => {
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });

    vi.mocked(schwabTraderFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          securitiesAccount: {
            accountNumber: '123',
            type: 'MARGIN',
            positions: [
              // Short put (sold)
              {
                shortQuantity: 1,
                longQuantity: 0,
                averagePrice: 2.5,
                currentDayProfitLoss: 50,
                currentDayProfitLossPercentage: 20,
                marketValue: 200,
                instrument: {
                  assetType: 'OPTION',
                  symbol: `SPXW${today.replaceAll('-', '')}P05600`,
                  putCall: 'PUT',
                  underlyingSymbol: '$SPX',
                  strikePrice: 5600,
                  expirationDate: `${today}T00:00:00.000+00:00`,
                },
              },
              // Long put (bought)
              {
                shortQuantity: 0,
                longQuantity: 1,
                averagePrice: 1.0,
                currentDayProfitLoss: -20,
                currentDayProfitLossPercentage: -20,
                marketValue: 80,
                instrument: {
                  assetType: 'OPTION',
                  symbol: `SPXW${today.replaceAll('-', '')}P05575`,
                  putCall: 'PUT',
                  underlyingSymbol: '$SPX',
                  strikePrice: 5575,
                  expirationDate: `${today}T00:00:00.000+00:00`,
                },
              },
              // Non-SPX option — should be excluded
              {
                shortQuantity: 1,
                longQuantity: 0,
                averagePrice: 1.0,
                currentDayProfitLoss: 0,
                currentDayProfitLossPercentage: 0,
                marketValue: 100,
                instrument: {
                  assetType: 'OPTION',
                  symbol: 'AAPL260316P00150',
                  putCall: 'PUT',
                  underlyingSymbol: 'AAPL',
                  strikePrice: 150,
                  expirationDate: `${today}T00:00:00.000+00:00`,
                },
              },
              // Zero quantity (closed) — should be excluded
              {
                shortQuantity: 1,
                longQuantity: 1,
                averagePrice: 3.0,
                currentDayProfitLoss: 0,
                currentDayProfitLossPercentage: 0,
                marketValue: 0,
                instrument: {
                  assetType: 'OPTION',
                  symbol: `SPXW${today.replaceAll('-', '')}P05500`,
                  putCall: 'PUT',
                  underlyingSymbol: '$SPX',
                  strikePrice: 5500,
                  expirationDate: `${today}T00:00:00.000+00:00`,
                },
              },
            ],
          },
        },
      });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { spx: '5700' } }), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      positions: {
        legs: unknown[];
        spreads: {
          type: string;
          shortLeg: { strike: number };
          longLeg: { strike: number };
          width: number;
        }[];
        summary: string;
        stats: {
          totalSpreads: number;
          putSpreads: number;
          callSpreads: number;
        };
      };
      saved: boolean;
    };
    expect(json.positions.legs).toHaveLength(2);
    expect(json.positions.spreads).toHaveLength(1);
    expect(json.positions.spreads[0]!.type).toBe('PUT CREDIT SPREAD');
    expect(json.positions.spreads[0]!.shortLeg.strike).toBe(5600);
    expect(json.positions.spreads[0]!.longLeg.strike).toBe(5575);
    expect(json.positions.spreads[0]!.width).toBe(25);
    expect(json.positions.stats.totalSpreads).toBe(1);
    expect(json.positions.stats.putSpreads).toBe(1);
    expect(json.positions.stats.callSpreads).toBe(0);
    expect(json.positions.summary).toContain('PUT CREDIT SPREADS');
    expect(json.positions.summary).toContain('Cushion:');
    expect(json.saved).toBe(true);
  });

  it('ignores a non-finite ?spx= param (no SPX cushion in summary)', async () => {
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });

    vi.mocked(schwabTraderFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          securitiesAccount: {
            accountNumber: '123',
            type: 'MARGIN',
            positions: [
              {
                shortQuantity: 1,
                longQuantity: 0,
                averagePrice: 2.5,
                currentDayProfitLoss: 50,
                currentDayProfitLossPercentage: 20,
                marketValue: 200,
                instrument: {
                  assetType: 'OPTION',
                  symbol: `SPXW${today.replaceAll('-', '')}P05600`,
                  putCall: 'PUT',
                  underlyingSymbol: '$SPX',
                  strikePrice: 5600,
                  expirationDate: `${today}T00:00:00.000+00:00`,
                },
              },
              {
                shortQuantity: 0,
                longQuantity: 1,
                averagePrice: 1.0,
                currentDayProfitLoss: -20,
                currentDayProfitLossPercentage: -20,
                marketValue: 80,
                instrument: {
                  assetType: 'OPTION',
                  symbol: `SPXW${today.replaceAll('-', '')}P05575`,
                  putCall: 'PUT',
                  underlyingSymbol: '$SPX',
                  strikePrice: 5575,
                  expirationDate: `${today}T00:00:00.000+00:00`,
                },
              },
            ],
          },
        },
      });

    const res = mockResponse();
    // ?spx=abc parses to NaN — must be treated as absent, not poisoned.
    await handler(mockRequest({ method: 'GET', query: { spx: 'abc' } }), res);

    expect(res._status).toBe(200);
    const json = res._json as { positions: { summary: string } };
    // No spxPrice → buildSummary omits the "SPX at fetch time" + Cushion lines.
    expect(json.positions.summary).not.toContain('SPX at fetch time');
    expect(json.positions.summary).not.toContain('Cushion:');
  });

  it('uses query date param when provided', async () => {
    vi.mocked(schwabTraderFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          securitiesAccount: {
            accountNumber: '123',
            type: 'MARGIN',
            positions: [],
          },
        },
      });

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-03-15' } }),
      res,
    );

    expect(res._status).toBe(200);
    // savePositions should be called with the provided date
    expect(savePositions).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-03-15' }),
    );
  });

  it('links snapshot when one exists for the date', async () => {
    mockSql.mockResolvedValueOnce([{ id: 42 }]); // snapshot lookup

    vi.mocked(schwabTraderFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          securitiesAccount: {
            accountNumber: '123',
            type: 'MARGIN',
            positions: [],
          },
        },
      });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    expect(savePositions).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: 42 }),
    );
  });

  it('still returns 200 when DB save fails', async () => {
    vi.mocked(savePositions).mockRejectedValue(new Error('DB error'));

    vi.mocked(schwabTraderFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          securitiesAccount: {
            accountNumber: '123',
            type: 'MARGIN',
            positions: [],
          },
        },
      });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    expect((res._json as { saved: boolean }).saved).toBe(false);
  });

  it('returns 500 with an OPAQUE message on unexpected error (no internal leak)', async () => {
    vi.mocked(schwabTraderFetch).mockRejectedValueOnce(
      new Error('Network failure: secret-host.internal:5432 refused'),
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    // The internal error text must NOT leak to the client.
    expect(res._json).toEqual({ error: 'Failed to fetch positions' });
    expect(JSON.stringify(res._json)).not.toContain('secret-host.internal');
    // ...but it IS captured server-side for debugging.
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Network failure: secret-host.internal:5432 refused',
      }),
    );
  });

  it('returns the same opaque error for non-Error throws', async () => {
    vi.mocked(schwabTraderFetch).mockRejectedValueOnce('string error');

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Failed to fetch positions' });
    expect(Sentry.captureException).toHaveBeenCalledWith('string error');
  });

  it('AUD-M6: a transient db failure on the OPTIONAL snapshot lookup must NOT fail the read — succeeds 200 with snapshotId null', async () => {
    // Schwab succeeds; the in-handler snapshot SELECT (via withDbRetry inside
    // safeDb) hits a transient timeout. The lookup is incidental FK enrichment,
    // so it must soft-degrade to null and the position read must still succeed.
    vi.mocked(schwabTraderFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          securitiesAccount: {
            accountNumber: '123',
            type: 'MARGIN',
            positions: [],
          },
        },
      });
    mockSql.mockRejectedValueOnce(new Error('db attempt timeout'));

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    expect((res._json as { saved: boolean }).saved).toBe(true);
    // The optional FK degraded to null; the position row still saved.
    expect(savePositions).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: null }),
    );
    // A soft-degraded optional lookup is not a Sentry-worthy event.
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('rejects a malformed ?date with 400 (no DB / Schwab call)', async () => {
    vi.mocked(schwabTraderFetch).mockClear();
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: 'garbage' } }),
      res,
    );

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'date must be YYYY-MM-DD' });
    expect(schwabTraderFetch).not.toHaveBeenCalled();
  });

  it('rejects an empty ?date= with 400', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { date: '' } }), res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'date must be YYYY-MM-DD' });
  });

  it('accepts a valid ?date=2026-06-08', async () => {
    vi.mocked(schwabTraderFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          securitiesAccount: {
            accountNumber: '123',
            type: 'MARGIN',
            positions: [],
          },
        },
      });

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-06-08' } }),
      res,
    );

    expect(res._status).toBe(200);
    expect(savePositions).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-06-08' }),
    );
  });

  it('groups call credit spreads correctly', async () => {
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });

    vi.mocked(schwabTraderFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          securitiesAccount: {
            accountNumber: '123',
            type: 'MARGIN',
            positions: [
              // Short call
              {
                shortQuantity: 2,
                longQuantity: 0,
                averagePrice: 3.0,
                currentDayProfitLoss: 0,
                currentDayProfitLossPercentage: 0,
                marketValue: 400,
                instrument: {
                  assetType: 'OPTION',
                  symbol: `SPXW${today.replaceAll('-', '')}C05800`,
                  putCall: 'CALL',
                  underlyingSymbol: '$SPX',
                  strikePrice: 5800,
                  expirationDate: today,
                },
              },
              // Long call
              {
                shortQuantity: 0,
                longQuantity: 2,
                averagePrice: 1.0,
                currentDayProfitLoss: 0,
                currentDayProfitLossPercentage: 0,
                marketValue: 120,
                instrument: {
                  assetType: 'OPTION',
                  symbol: `SPXW${today.replaceAll('-', '')}C05825`,
                  putCall: 'CALL',
                  underlyingSymbol: '$SPX',
                  strikePrice: 5825,
                  expirationDate: today,
                },
              },
            ],
          },
        },
      });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { spx: '5700' } }), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      positions: {
        spreads: { type: string; width: number }[];
        summary: string;
        stats: { callSpreads: number };
      };
    };
    expect(json.positions.spreads).toHaveLength(1);
    expect(json.positions.spreads[0]!.type).toBe('CALL CREDIT SPREAD');
    expect(json.positions.spreads[0]!.width).toBe(25);
    expect(json.positions.stats.callSpreads).toBe(1);
    expect(json.positions.summary).toContain('CALL CREDIT SPREADS');
    expect(json.positions.summary).toContain('above SPX');
  });

  it('handles unpaired short legs as SINGLE spreads', async () => {
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });

    vi.mocked(schwabTraderFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          securitiesAccount: {
            accountNumber: '123',
            type: 'MARGIN',
            positions: [
              // Naked short put (no matching long)
              {
                shortQuantity: 1,
                longQuantity: 0,
                averagePrice: 4.0,
                currentDayProfitLoss: 0,
                currentDayProfitLossPercentage: 0,
                marketValue: 300,
                instrument: {
                  assetType: 'OPTION',
                  symbol: `SPXW${today.replaceAll('-', '')}P05600`,
                  putCall: 'PUT',
                  underlyingSymbol: '$SPX',
                  strikePrice: 5600,
                  expirationDate: today,
                },
              },
            ],
          },
        },
      });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const json = res._json as {
      positions: { spreads: { type: string }[] };
    };
    expect(json.positions.spreads).toHaveLength(1);
    expect(json.positions.spreads[0]!.type).toBe('SINGLE');
  });

  it('builds summary without SPX price when not provided', async () => {
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });

    vi.mocked(schwabTraderFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          securitiesAccount: {
            accountNumber: '123',
            type: 'MARGIN',
            positions: [
              {
                shortQuantity: 1,
                longQuantity: 0,
                averagePrice: 2.5,
                currentDayProfitLoss: 0,
                currentDayProfitLossPercentage: 0,
                marketValue: 200,
                instrument: {
                  assetType: 'OPTION',
                  symbol: `SPXW${today.replaceAll('-', '')}P05600`,
                  putCall: 'PUT',
                  underlyingSymbol: '$SPX',
                  strikePrice: 5600,
                  expirationDate: today,
                },
              },
              {
                shortQuantity: 0,
                longQuantity: 1,
                averagePrice: 1.0,
                currentDayProfitLoss: 0,
                currentDayProfitLossPercentage: 0,
                marketValue: 80,
                instrument: {
                  assetType: 'OPTION',
                  symbol: `SPXW${today.replaceAll('-', '')}P05575`,
                  putCall: 'PUT',
                  underlyingSymbol: '$SPX',
                  strikePrice: 5575,
                  expirationDate: today,
                },
              },
            ],
          },
        },
      });

    const res = mockResponse();
    // No spx query param
    await handler(mockRequest({ method: 'GET' }), res);

    const json = res._json as { positions: { summary: string } };
    expect(json.positions.summary).not.toContain('Cushion:');
    expect(json.positions.summary).not.toContain('SPX at fetch time');
  });

  it('handles account with no positions array', async () => {
    vi.mocked(schwabTraderFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          securitiesAccount: {
            accountNumber: '123',
            type: 'MARGIN',
            // No positions field at all
          },
        },
      });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      positions: { summary: string; legs: unknown[] };
    };
    expect(json.positions.legs).toHaveLength(0);
    expect(json.positions.summary).toContain('No open SPX 0DTE positions');
  });
});

describe('POST /api/positions — CSV parse error', () => {
  const mockSql = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(guardOwnerEndpoint).mockResolvedValue(false);
    vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
    vi.mocked(getDb).mockReturnValue(mockSql as never);
    mockSql.mockResolvedValue([]);
    vi.mocked(savePositions).mockResolvedValue(1);
    vi.mocked(Sentry.captureException).mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns 500 with an OPAQUE message and captures the real error', async () => {
    vi.mocked(parseFullCSV).mockImplementation(() => {
      throw new Error('CSV row 5: unexpected token in /internal/path.ts:42');
    });

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: 'Account Trade History\nSPX,...,...\n',
      }),
      res,
    );

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Failed to parse CSV' });
    // Internal parser detail must not leak.
    expect(JSON.stringify(res._json)).not.toContain('/internal/path.ts');
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'CSV row 5: unexpected token in /internal/path.ts:42',
      }),
    );
  });

  it('AUD-M6: a transient db failure on the snapshot lookup must NOT surface as the misleading "Failed to parse CSV" 500 — succeeds 200 with snapshotId null', async () => {
    // A real CSV parses fine; only the OPTIONAL snapshot FK lookup trips a
    // transient db timeout. Before the fix this lookup sat outside the try and
    // bubbled into the CSV catch → a misleading 'Failed to parse CSV' 500.
    vi.mocked(parseFullCSV).mockReturnValue({
      openLegs: [
        {
          putCall: 'PUT',
          symbol: 'SPXW.P05600',
          strike: 5600,
          expiration: '2026-06-11',
          quantity: -1,
          averagePrice: 2.5,
          marketValue: 200,
          delta: undefined,
          theta: undefined,
          gamma: undefined,
        },
      ],
      closedSpreads: [],
      allTrades: [],
      dayPnl: null,
      ytdPnl: null,
      netLiquidatingValue: null,
      startingBalance: null,
      hasOptionsSection: true,
    });
    mockSql.mockRejectedValueOnce(new Error('db attempt timeout'));

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: 'Options\nSPXW,...,...\n',
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).not.toEqual({ error: 'Failed to parse CSV' });
    expect((res._json as { saved: boolean }).saved).toBe(true);
    expect(savePositions).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: null }),
    );
    // The transient optional lookup is soft-degraded, not Sentry-reported.
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

// ============================================================
// Read-only mode: GET /api/positions?readonly=1 (ladder phase 4a)
// ============================================================

const DAY = '2026-06-08';
const OTHER_DAY = '2026-06-09';

function csvLeg(over: Partial<PositionLeg> = {}): PositionLeg {
  return {
    putCall: 'CALL',
    symbol: 'SPXW  260608C06900000',
    strike: 6900,
    expiration: DAY,
    quantity: -1,
    averagePrice: 2,
    marketValue: -150,
    ...over,
  };
}

/** A call credit spread: short 6900, long 6925. */
const CSV_CALL_SPREAD: PositionLeg[] = [
  csvLeg(),
  csvLeg({
    symbol: 'SPXW  260608C06925000',
    strike: 6925,
    quantity: 1,
    averagePrice: 1,
    marketValue: 60,
  }),
];

function schwabOption(args: {
  putCall: 'PUT' | 'CALL';
  strike: number;
  short?: number;
  long?: number;
  expiration?: string;
}) {
  const { putCall, strike, short = 0, long = 0, expiration = DAY } = args;
  return {
    shortQuantity: short,
    longQuantity: long,
    averagePrice: 2,
    currentDayProfitLoss: 0,
    currentDayProfitLossPercentage: 0,
    marketValue: 100,
    instrument: {
      assetType: 'OPTION',
      symbol: `SPXW${expiration.replaceAll('-', '')}${putCall[0]}${strike}`,
      putCall,
      underlyingSymbol: '$SPX',
      strikePrice: strike,
      expirationDate: `${expiration}T00:00:00.000+00:00`,
    },
  };
}

/** Queue Schwab's two answers: the account list, then the positions. */
function queueSchwabPositions(positions: unknown[]) {
  vi.mocked(schwabTraderFetch)
    .mockResolvedValueOnce({
      ok: true,
      data: [{ accountNumber: '123', hashValue: 'hash1' }],
    })
    .mockResolvedValueOnce({
      ok: true,
      data: {
        securitiesAccount: {
          accountNumber: '123',
          type: 'MARGIN',
          positions,
        },
      },
    });
}

interface PositionsBody {
  positions: {
    summary: string;
    legs: PositionLeg[];
    spreads: { type: string; shortLeg: { strike: number } }[];
    stats: {
      totalSpreads: number;
      callSpreads: number;
      putSpreads: number;
    };
  };
  saved: boolean;
  fetchTime: string;
  source?: string;
}

function resetPositionMocks(mockSql: ReturnType<typeof vi.fn>) {
  vi.restoreAllMocks();
  vi.mocked(guardOwnerEndpoint).mockResolvedValue(false);
  vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
  vi.mocked(getDb).mockReset();
  vi.mocked(getDb).mockReturnValue(mockSql as never);
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  vi.mocked(schwabTraderFetch).mockReset();
  vi.mocked(getLatestCsvPositions).mockReset();
  vi.mocked(savePositions).mockReset();
  vi.mocked(savePositions).mockResolvedValue(1);
  vi.mocked(parseFullCSV).mockReset();
  vi.mocked(Sentry.captureException).mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('GET /api/positions?readonly=1', () => {
  const mockSql = vi.fn();
  const readonlyReq = (query: Record<string, string> = {}) =>
    mockRequest({
      method: 'GET',
      query: { readonly: '1', date: DAY, ...query },
    });

  beforeEach(() => {
    resetPositionMocks(mockSql);
  });

  // ── CSV first ────────────────────────────────────────────────

  it('answers from the date’s newest CSV row: its legs, source and fetchTime, with no Schwab request and no save', async () => {
    vi.mocked(getLatestCsvPositions).mockResolvedValueOnce({
      legs: CSV_CALL_SPREAD,
      fetchTime: '10:15',
    });

    const res = mockResponse();
    await handler(readonlyReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as PositionsBody;
    expect(json.source).toBe('paperMoney');
    expect(json.fetchTime).toBe('10:15');
    expect(json.saved).toBe(false);
    expect(json.positions.legs).toEqual(CSV_CALL_SPREAD);
    expect(json.positions.spreads).toHaveLength(1);
    expect(json.positions.spreads[0]!.shortLeg.strike).toBe(6900);
    expect(json.positions.stats).toMatchObject({
      totalSpreads: 1,
      callSpreads: 1,
      putSpreads: 0,
    });
    // The plain GET's body shape, not the CSV upload's.
    expect(json.positions).not.toHaveProperty('closedToday');
    expect(getLatestCsvPositions).toHaveBeenCalledWith(DAY);
    expect(schwabTraderFetch).not.toHaveBeenCalled();
    expect(savePositions).not.toHaveBeenCalled();
    // No snapshot lookup either: nothing is saved, so nothing links.
    expect(getDb).not.toHaveBeenCalled();
  });

  it('a CSV row with no open legs still governs: empty answer, no Schwab fallback', async () => {
    vi.mocked(getLatestCsvPositions).mockResolvedValueOnce({
      legs: [],
      fetchTime: '11:02',
    });

    const res = mockResponse();
    await handler(readonlyReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as PositionsBody;
    expect(json.source).toBe('paperMoney');
    expect(json.fetchTime).toBe('11:02');
    expect(json.positions.legs).toEqual([]);
    expect(json.positions.spreads).toEqual([]);
    expect(schwabTraderFetch).not.toHaveBeenCalled();
    expect(savePositions).not.toHaveBeenCalled();
  });

  it('drops CSV legs that do not expire on the requested date', async () => {
    const todayShort = csvLeg();
    const todayLong = CSV_CALL_SPREAD[1]!;
    vi.mocked(getLatestCsvPositions).mockResolvedValueOnce({
      legs: [
        todayShort,
        todayLong,
        // A short put expiring tomorrow: not today's, so it must not reach
        // the ladder as an open short strike.
        csvLeg({
          putCall: 'PUT',
          strike: 6700,
          expiration: OTHER_DAY,
          quantity: -2,
        }),
        // A paperMoney expiration the parser could not read (it returns the
        // raw text), which is not a date.
        csvLeg({ putCall: 'PUT', strike: 6650, expiration: '9 JUN 26x' }),
      ],
      fetchTime: '10:15',
    });

    const res = mockResponse();
    await handler(readonlyReq(), res);

    const json = res._json as PositionsBody;
    expect(json.positions.legs).toEqual([todayShort, todayLong]);
    expect(json.positions.stats.putSpreads).toBe(0);
    expect(json.positions.stats.totalSpreads).toBe(1);
  });

  it('a CSV whose legs all expire another day answers empty and still governs', async () => {
    vi.mocked(getLatestCsvPositions).mockResolvedValueOnce({
      legs: [csvLeg({ expiration: OTHER_DAY })],
      fetchTime: '10:15',
    });

    const res = mockResponse();
    await handler(readonlyReq(), res);

    const json = res._json as PositionsBody;
    expect(json.source).toBe('paperMoney');
    expect(json.positions.legs).toEqual([]);
    expect(schwabTraderFetch).not.toHaveBeenCalled();
  });

  it('ignores ?spx= on the CSV path (built with no spx)', async () => {
    vi.mocked(getLatestCsvPositions).mockResolvedValueOnce({
      legs: CSV_CALL_SPREAD,
      fetchTime: '10:15',
    });

    const res = mockResponse();
    await handler(readonlyReq({ spx: '6800' }), res);

    const json = res._json as PositionsBody;
    expect(json.positions.summary).toContain('CALL CREDIT SPREADS');
    expect(json.positions.summary).not.toContain('Cushion:');
    expect(json.positions.summary).not.toContain('SPX at fetch time');
    expect(json.positions.summary).not.toContain('above SPX');
  });

  it('looks the CSV up by the ET date when no ?date= is given', async () => {
    const todayET = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });
    vi.mocked(getLatestCsvPositions).mockResolvedValueOnce(null);
    queueSchwabPositions([]);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { readonly: '1' } }),
      res,
    );

    expect(res._status).toBe(200);
    expect(getLatestCsvPositions).toHaveBeenCalledWith(todayET);
  });

  // ── Schwab when there is no CSV ──────────────────────────────

  it('with no CSV row, answers from Schwab: its legs, source schwab, saved false, no save', async () => {
    vi.mocked(getLatestCsvPositions).mockResolvedValueOnce(null);
    queueSchwabPositions([
      schwabOption({ putCall: 'PUT', strike: 6700, short: 2 }),
      schwabOption({ putCall: 'PUT', strike: 6675, long: 2 }),
      // Expires another day: the Schwab filter drops it.
      schwabOption({
        putCall: 'PUT',
        strike: 6600,
        short: 1,
        expiration: OTHER_DAY,
      }),
    ]);

    const res = mockResponse();
    await handler(readonlyReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as PositionsBody;
    expect(json.source).toBe('schwab');
    expect(json.saved).toBe(false);
    expect(typeof json.fetchTime).toBe('string');
    expect(json.positions.legs.map((l) => [l.strike, l.quantity])).toEqual([
      [6700, -2],
      [6675, 2],
    ]);
    expect(json.positions.spreads).toHaveLength(1);
    expect(json.positions.spreads[0]!.type).toBe('PUT CREDIT SPREAD');
    expect(json.positions.stats.putSpreads).toBe(1);
    expect(schwabTraderFetch).toHaveBeenCalledTimes(2);
    expect(savePositions).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });

  it('ignores ?spx= on the Schwab path too (no cushion lines)', async () => {
    vi.mocked(getLatestCsvPositions).mockResolvedValueOnce(null);
    queueSchwabPositions([
      schwabOption({ putCall: 'PUT', strike: 6700, short: 1 }),
      schwabOption({ putCall: 'PUT', strike: 6675, long: 1 }),
    ]);

    const res = mockResponse();
    await handler(readonlyReq({ spx: '6800' }), res);

    const json = res._json as PositionsBody;
    expect(json.positions.summary).toContain('PUT CREDIT SPREADS');
    expect(json.positions.summary).not.toContain('Cushion:');
    expect(json.positions.summary).not.toContain('SPX at fetch time');
  });

  it('a Schwab account with no positions array answers empty, saved false', async () => {
    vi.mocked(getLatestCsvPositions).mockResolvedValueOnce(null);
    vi.mocked(schwabTraderFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { securitiesAccount: { accountNumber: '123', type: 'MARGIN' } },
      });

    const res = mockResponse();
    await handler(readonlyReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as PositionsBody;
    expect(json.source).toBe('schwab');
    expect(json.saved).toBe(false);
    expect(json.positions.legs).toEqual([]);
  });

  // ── Failure modes, each surfaced by name ─────────────────────

  it('a transient CSV read failure answers 503 with Retry-After, no Schwab fallback, no Sentry event', async () => {
    const doneSpy = vi.fn();
    vi.mocked(metrics.request).mockReturnValueOnce(doneSpy);
    vi.mocked(getLatestCsvPositions).mockRejectedValueOnce(
      new TransientDbError(new Error('fetch failed')),
    );

    const res = mockResponse();
    await handler(readonlyReq(), res);

    expect(res._status).toBe(503);
    expect(res._headers['Retry-After']).toBe('5');
    expect(res._json).toEqual({
      error: 'temporarily unavailable',
      transient: true,
    });
    // The request metric records the 503 that was sent, not a guessed 500.
    expect(doneSpy).toHaveBeenCalledTimes(1);
    expect(doneSpy).toHaveBeenCalledWith({ status: 503 });
    expect(schwabTraderFetch).not.toHaveBeenCalled();
    expect(savePositions).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('a genuine CSV read failure answers an opaque 500 and is captured, with no Schwab fallback', async () => {
    const doneSpy = vi.fn();
    vi.mocked(metrics.request).mockReturnValueOnce(doneSpy);
    vi.mocked(getLatestCsvPositions).mockRejectedValueOnce(
      new Error('relation "positions" does not exist'),
    );

    const res = mockResponse();
    await handler(readonlyReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Failed to fetch positions' });
    expect(JSON.stringify(res._json)).not.toContain('relation');
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'relation "positions" does not exist',
      }),
    );
    expect(doneSpy).toHaveBeenCalledTimes(1);
    expect(doneSpy).toHaveBeenCalledWith({ status: 500 });
    expect(schwabTraderFetch).not.toHaveBeenCalled();
    expect(savePositions).not.toHaveBeenCalled();
  });

  it('passes Schwab’s 401 (logged out) through, with no save', async () => {
    vi.mocked(getLatestCsvPositions).mockResolvedValueOnce(null);
    vi.mocked(schwabTraderFetch).mockResolvedValueOnce({
      ok: false,
      error: 'Unauthorized',
      status: 401,
      code: 'SCHWAB_API_REJECTED',
    });

    const res = mockResponse();
    await handler(readonlyReq(), res);

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Unauthorized' });
    expect(savePositions).not.toHaveBeenCalled();
  });

  it('passes a Schwab positions-call failure through (502), with no save', async () => {
    vi.mocked(getLatestCsvPositions).mockResolvedValueOnce(null);
    vi.mocked(schwabTraderFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
        ok: false,
        error: 'Server error',
        status: 502,
        code: 'SCHWAB_API_502',
      });

    const res = mockResponse();
    await handler(readonlyReq(), res);

    expect(res._status).toBe(502);
    expect(res._json).toEqual({ error: 'Server error' });
    expect(savePositions).not.toHaveBeenCalled();
  });

  it('answers 404 when Schwab lists no linked account, with no save', async () => {
    vi.mocked(getLatestCsvPositions).mockResolvedValueOnce(null);
    vi.mocked(schwabTraderFetch).mockResolvedValueOnce({ ok: true, data: [] });

    const res = mockResponse();
    await handler(readonlyReq(), res);

    expect(res._status).toBe(404);
    expect(res._json).toEqual({ error: 'No linked accounts found' });
    expect(savePositions).not.toHaveBeenCalled();
  });

  it('a Schwab call that throws answers an opaque 500 and is captured, with no save', async () => {
    vi.mocked(getLatestCsvPositions).mockResolvedValueOnce(null);
    vi.mocked(schwabTraderFetch).mockRejectedValueOnce(
      new Error('Network failure: secret-host.internal:5432 refused'),
    );

    const res = mockResponse();
    await handler(readonlyReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Failed to fetch positions' });
    expect(JSON.stringify(res._json)).not.toContain('secret-host.internal');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(savePositions).not.toHaveBeenCalled();
  });

  // ── The flag and the unchanged gates ─────────────────────────

  it.each([['yes'], ['0'], ['true'], ['']])(
    'readonly=%j is a 400, with no CSV read, no Schwab request and no save',
    async (value) => {
      const res = mockResponse();
      await handler(readonlyReq({ readonly: value }), res);

      expect(res._status).toBe(400);
      expect(res._json).toEqual({ error: 'readonly must be 1' });
      expect(getLatestCsvPositions).not.toHaveBeenCalled();
      expect(schwabTraderFetch).not.toHaveBeenCalled();
      expect(savePositions).not.toHaveBeenCalled();
    },
  );

  it('a repeated readonly (an array) is a 400', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { readonly: ['1', '1'], date: DAY },
      }),
      res,
    );

    expect(res._status).toBe(400);
    expect(getLatestCsvPositions).not.toHaveBeenCalled();
  });

  it('the ?date= check still applies: a malformed date is a 400 before any read', async () => {
    const res = mockResponse();
    await handler(readonlyReq({ date: 'garbage' }), res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'date must be YYYY-MM-DD' });
    expect(getLatestCsvPositions).not.toHaveBeenCalled();
    expect(schwabTraderFetch).not.toHaveBeenCalled();
  });

  it('a non-owner gets the guard’s 401 and nothing is read', async () => {
    vi.mocked(guardOwnerEndpoint).mockImplementation(async (_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });

    const res = mockResponse();
    await handler(readonlyReq(), res);

    expect(res._status).toBe(401);
    expect(getLatestCsvPositions).not.toHaveBeenCalled();
    expect(schwabTraderFetch).not.toHaveBeenCalled();
  });

  it('keeps the 20-a-minute limit: a limited call gets 429 and nothing is read', async () => {
    vi.mocked(rejectIfRateLimited).mockImplementation(async (_req, res) => {
      res.status(429).json({ error: 'Rate limited' });
      return true;
    });

    const res = mockResponse();
    await handler(readonlyReq(), res);

    expect(res._status).toBe(429);
    expect(rejectIfRateLimited).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'positions',
      20,
    );
    expect(getLatestCsvPositions).not.toHaveBeenCalled();
    expect(schwabTraderFetch).not.toHaveBeenCalled();
  });
});

// ============================================================
// The plain GET and POST keep saving
// ============================================================

describe('GET /api/positions without the flag (plain read) and POST', () => {
  const mockSql = vi.fn();

  beforeEach(() => {
    resetPositionMocks(mockSql);
  });

  // The plain GET shares its catch with the read-only mode, so the request
  // metric must record the status actually sent here too.
  it('a transient error records 503 in the request metric and answers 503', async () => {
    const doneSpy = vi.fn();
    vi.mocked(metrics.request).mockReturnValueOnce(doneSpy);
    vi.mocked(schwabTraderFetch).mockRejectedValueOnce(
      new TransientDbError(new Error('fetch failed')),
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { date: DAY } }), res);

    expect(res._status).toBe(503);
    expect(res._headers['Retry-After']).toBe('5');
    expect(doneSpy).toHaveBeenCalledTimes(1);
    expect(doneSpy).toHaveBeenCalledWith({ status: 503 });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('a genuine error records 500 in the request metric and answers an opaque 500', async () => {
    const doneSpy = vi.fn();
    vi.mocked(metrics.request).mockReturnValueOnce(doneSpy);
    vi.mocked(schwabTraderFetch).mockRejectedValueOnce(
      new Error('Network failure: secret-host.internal:5432 refused'),
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { date: DAY } }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Failed to fetch positions' });
    expect(doneSpy).toHaveBeenCalledTimes(1);
    expect(doneSpy).toHaveBeenCalledWith({ status: 500 });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('still saves, never reads the CSV row, and adds no source field', async () => {
    queueSchwabPositions([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { date: DAY } }), res);

    expect(res._status).toBe(200);
    const json = res._json as PositionsBody;
    expect(json.saved).toBe(true);
    expect(json).not.toHaveProperty('source');
    expect(savePositions).toHaveBeenCalledWith(
      expect.objectContaining({ date: DAY, accountHash: 'hash1' }),
    );
    expect(getLatestCsvPositions).not.toHaveBeenCalled();
  });

  it('reports saved:false when the conflict guard skips the write (savePositions → null)', async () => {
    vi.mocked(savePositions).mockResolvedValue(null);
    queueSchwabPositions([
      schwabOption({ putCall: 'PUT', strike: 6700, short: 1 }),
    ]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { date: DAY } }), res);

    expect(res._status).toBe(200);
    const json = res._json as PositionsBody;
    expect(json.saved).toBe(false);
    // The read itself is unharmed: the trader still sees their legs.
    expect(json.positions.legs).toHaveLength(1);
    expect(savePositions).toHaveBeenCalledTimes(1);
  });

  it.each([['1'], ['yes']])(
    'POST ignores readonly=%s: a CSV upload always saves, as paperMoney',
    async (value) => {
      vi.mocked(parseFullCSV).mockReturnValue({
        openLegs: CSV_CALL_SPREAD,
        closedSpreads: [],
        allTrades: [],
        dayPnl: null,
        ytdPnl: null,
        netLiquidatingValue: null,
        startingBalance: null,
        hasOptionsSection: true,
      });

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'POST',
          body: 'Options\nSPXW,...,...\n',
          query: { readonly: value, date: DAY },
        }),
        res,
      );

      expect(res._status).toBe(200);
      const json = res._json as PositionsBody;
      expect(json.saved).toBe(true);
      expect(json.source).toBe('paperMoney');
      expect(savePositions).toHaveBeenCalledWith(
        expect.objectContaining({ date: DAY, accountHash: 'paperMoney' }),
      );
      expect(getLatestCsvPositions).not.toHaveBeenCalled();
    },
  );
});
