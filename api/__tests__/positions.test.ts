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
import { savePositions, getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';

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
