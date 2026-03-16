// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
  rejectIfRateLimited: vi.fn(),
  schwabTraderFetch: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  savePositions: vi.fn(),
  getDb: vi.fn(),
}));

import handler from '../positions.js';
import {
  rejectIfNotOwner,
  rejectIfRateLimited,
  schwabTraderFetch,
} from '../_lib/api-helpers.js';
import { savePositions, getDb } from '../_lib/db.js';

describe('GET /api/positions', () => {
  const mockSql = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
    vi.mocked(getDb).mockReturnValue(mockSql as never);
    mockSql.mockResolvedValue([]);
    vi.mocked(savePositions).mockResolvedValue(1);
  });

  it('returns 405 for non-GET methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
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
      error: 'Unauthorized',
      status: 401,
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Unauthorized' });
  });

  it('returns 404 when no linked accounts', async () => {
    vi.mocked(schwabTraderFetch).mockResolvedValueOnce({ data: [] });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(404);
    expect(res._json).toEqual({ error: 'No linked accounts found' });
  });

  it('returns error when positions fetch fails', async () => {
    vi.mocked(schwabTraderFetch)
      .mockResolvedValueOnce({
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
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
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
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
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
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

  it('uses query date param when provided', async () => {
    vi.mocked(schwabTraderFetch)
      .mockResolvedValueOnce({
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
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
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
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
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
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

  it('returns 500 on unexpected error', async () => {
    vi.mocked(schwabTraderFetch).mockRejectedValueOnce(
      new Error('Network failure'),
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Network failure' });
  });

  it('returns generic error for non-Error throws', async () => {
    vi.mocked(schwabTraderFetch).mockRejectedValueOnce('string error');

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Failed to fetch positions' });
  });

  it('groups call credit spreads correctly', async () => {
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });

    vi.mocked(schwabTraderFetch)
      .mockResolvedValueOnce({
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
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
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
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
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
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
        data: [{ accountNumber: '123', hashValue: 'hash1' }],
      })
      .mockResolvedValueOnce({
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
