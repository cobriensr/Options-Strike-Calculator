// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
  rejectIfRateLimited: vi.fn(),
  schwabTraderFetch: vi.fn(),
  checkBot: vi.fn().mockResolvedValue({ isBot: false }),
}));

vi.mock('../_lib/db.js', () => ({
  savePositions: vi.fn(),
  getDb: vi.fn(() => {
    const fn = async () => [];
    // Tagged template support for sql``
    fn.call = fn;
    return fn;
  }),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import handler, {
  parsePaperMoneyCSV,
  parseTosExpiration,
  parseTosMarkValue,
} from '../positions.js';
import { rejectIfNotOwner, rejectIfRateLimited } from '../_lib/api-helpers.js';
import { savePositions } from '../_lib/db.js';

// ── Sample CSV matching the real paperMoney export format ─────────
const SAMPLE_CSV = `\ufeffThis document was exported from the paperMoney platform.

Account Statement for D-70001650 (ira) since 3/16/26 through 3/16/26

Cash Balance
DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE
3/17/26,00:00:00,BAL,,Cash balance at the start of business day,,,,202146.08

Futures Statements
Trade Date,Exec Date,Exec Time,Type,Ref #,Description,Misc Fees,Commissions & Fees,Amount,Balance

Options
Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price,Mark,Mark Value
SPX,SPXW260317P6660,17 MAR 26,6660,PUT,+20,.925,.225,$450.00
SPX,SPXW260317P6665,17 MAR 26,6665,PUT,+20,.85,.225,$450.00
SPX,SPXW260317P6670,17 MAR 26,6670,PUT,+20,.975,.275,$550.00
SPX,SPXW260317P6675,17 MAR 26,6675,PUT,+20,1.15,.275,$550.00
SPX,SPXW260317P6680,17 MAR 26,6680,PUT,-20,1.575,.325,($650.00)
SPX,SPXW260317P6685,17 MAR 26,6685,PUT,-20,1.525,.375,($750.00)
SPX,SPXW260317P6690,17 MAR 26,6690,PUT,-20,1.775,.425,($850.00)
SPX,SPXW260317P6695,17 MAR 26,6695,PUT,-20,2.30,.525,"($1,050.00)"
,OVERALL TOTALS,,,,,,,"($1,300.00)"

Profits and Losses
Symbol,Description,P/L Open
`;

const MINIMAL_CSV = `Options
Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price,Mark,Mark Value
SPX,SPXW260317P5800,17 MAR 26,5800,PUT,-5,1.50,.50,($250.00)
SPX,SPXW260317P5780,17 MAR 26,5780,PUT,+5,.60,.20,$100.00
,OVERALL TOTALS,,,,,,,"($150.00)"
`;

describe('parseTosExpiration', () => {
  it('parses "17 MAR 26" → "2026-03-17"', () => {
    expect(parseTosExpiration('17 MAR 26')).toBe('2026-03-17');
  });

  it('parses "5 JAN 27" → "2027-01-05"', () => {
    expect(parseTosExpiration('5 JAN 27')).toBe('2027-01-05');
  });

  it('handles 4-digit year', () => {
    expect(parseTosExpiration('17 MAR 2026')).toBe('2026-03-17');
  });

  it('returns raw input for unparseable dates', () => {
    expect(parseTosExpiration('bad')).toBe('bad');
  });
});

describe('parseTosMarkValue', () => {
  it('parses "$450.00" → 450', () => {
    expect(parseTosMarkValue('$450.00')).toBe(450);
  });

  it('parses "($1,050.00)" → -1050', () => {
    expect(parseTosMarkValue('($1,050.00)')).toBe(-1050);
  });

  it('parses "($650.00)" → -650', () => {
    expect(parseTosMarkValue('($650.00)')).toBe(-650);
  });

  it('parses "$550.00" → 550', () => {
    expect(parseTosMarkValue('$550.00')).toBe(550);
  });
});

describe('parsePaperMoneyCSV', () => {
  it('extracts all 8 SPX legs from the sample CSV', () => {
    const legs = parsePaperMoneyCSV(SAMPLE_CSV);
    expect(legs).toHaveLength(8);
  });

  it('correctly parses short legs (negative quantity)', () => {
    const legs = parsePaperMoneyCSV(SAMPLE_CSV);
    const shorts = legs.filter((l) => l.quantity < 0);
    expect(shorts).toHaveLength(4);
    expect(shorts.map((l) => l.strike).sort((a, b) => a - b)).toEqual([
      6680, 6685, 6690, 6695,
    ]);
    // All short legs have quantity -20
    for (const leg of shorts) {
      expect(leg.quantity).toBe(-20);
    }
  });

  it('correctly parses long legs (positive quantity)', () => {
    const legs = parsePaperMoneyCSV(SAMPLE_CSV);
    const longs = legs.filter((l) => l.quantity > 0);
    expect(longs).toHaveLength(4);
    expect(longs.map((l) => l.strike).sort((a, b) => a - b)).toEqual([
      6660, 6665, 6670, 6675,
    ]);
  });

  it('sets putCall to PUT for all legs', () => {
    const legs = parsePaperMoneyCSV(SAMPLE_CSV);
    for (const leg of legs) {
      expect(leg.putCall).toBe('PUT');
    }
  });

  it('parses expiration dates correctly', () => {
    const legs = parsePaperMoneyCSV(SAMPLE_CSV);
    for (const leg of legs) {
      expect(leg.expiration).toBe('2026-03-17');
    }
  });

  it('parses averagePrice (Trade Price) correctly', () => {
    const legs = parsePaperMoneyCSV(SAMPLE_CSV);
    const leg6695 = legs.find((l) => l.strike === 6695);
    expect(leg6695?.averagePrice).toBe(2.3);
  });

  it('parses marketValue (Mark Value) correctly including negatives', () => {
    const legs = parsePaperMoneyCSV(SAMPLE_CSV);
    const long6660 = legs.find((l) => l.strike === 6660 && l.quantity > 0);
    expect(long6660?.marketValue).toBe(450);

    const short6695 = legs.find((l) => l.strike === 6695 && l.quantity < 0);
    expect(short6695?.marketValue).toBe(-1050);
  });

  it('sets symbol from Option Code column', () => {
    const legs = parsePaperMoneyCSV(SAMPLE_CSV);
    const leg = legs.find((l) => l.strike === 6660);
    expect(leg?.symbol).toBe('SPXW260317P6660');
  });

  it('ignores non-SPX rows', () => {
    const csvWithNonSPX = `Options
Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price,Mark,Mark Value
AAPL,AAPL260317C150,17 MAR 26,150,CALL,+10,2.00,2.50,$2500.00
SPX,SPXW260317P6680,17 MAR 26,6680,PUT,-20,1.575,.325,($650.00)
,OVERALL TOTALS,,,,,,,$1850.00
`;
    const legs = parsePaperMoneyCSV(csvWithNonSPX);
    expect(legs).toHaveLength(1);
    expect(legs[0]?.strike).toBe(6680);
  });

  it('returns empty array if no Options section found', () => {
    const noOptions = 'Cash Balance\nDATE,TIME,AMOUNT\n3/17/26,00:00:00,1000';
    expect(parsePaperMoneyCSV(noOptions)).toEqual([]);
  });

  it('stops parsing at OVERALL TOTALS row', () => {
    const legs = parsePaperMoneyCSV(SAMPLE_CSV);
    // Should not include the OVERALL TOTALS or anything after
    expect(legs).toHaveLength(8);
  });
});

describe('POST /api/positions (CSV upload)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(rejectIfRateLimited).mockResolvedValue(undefined as never);
    vi.mocked(savePositions).mockResolvedValue(1);
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: SAMPLE_CSV }), res);
    expect(res._status).toBe(401);
  });

  it('returns 405 for unsupported methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'PUT' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 400 for empty body', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: '' }), res);
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toMatch(/empty/i);
  });

  it('returns 400 for CSV without Options section', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: 'no options here' }),
      res,
    );
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toMatch(/no spx options/i);
  });

  it('returns 400 for non-string body without csv field', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: { notCsv: true } }), res);
    expect(res._status).toBe(400);
  });

  it('accepts JSON body with csv field', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { csv: MINIMAL_CSV } }),
      res,
    );
    expect(res._status).toBe(200);
    const data = res._json as {
      positions: { stats: { totalSpreads: number } };
      source: string;
    };
    expect(data.positions.stats.totalSpreads).toBe(1);
    expect(data.source).toBe('paperMoney');
  });

  it('parses full CSV and returns correct spread count', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: SAMPLE_CSV }), res);
    expect(res._status).toBe(200);
    const data = res._json as {
      positions: {
        legs: unknown[];
        spreads: unknown[];
        stats: {
          totalSpreads: number;
          putSpreads: number;
          callSpreads: number;
        };
        summary: string;
      };
      source: string;
    };
    expect(data.positions.legs).toHaveLength(8);
    expect(data.positions.stats.putSpreads).toBe(4);
    expect(data.positions.stats.callSpreads).toBe(0);
    expect(data.positions.summary).toContain('PUT CREDIT SPREADS');
    expect(data.source).toBe('paperMoney');
  });

  it('saves positions to DB with accountHash "paperMoney"', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: MINIMAL_CSV }), res);
    expect(savePositions).toHaveBeenCalledTimes(1);
    const call = vi.mocked(savePositions).mock.calls[0]![0];
    expect(call.accountHash).toBe('paperMoney');
    expect(call.legs).toHaveLength(2);
  });

  it('returns saved: true when DB save succeeds', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: MINIMAL_CSV }), res);
    expect((res._json as { saved: boolean }).saved).toBe(true);
  });

  it('returns saved: false when DB save fails', async () => {
    vi.mocked(savePositions).mockRejectedValueOnce(new Error('DB down'));
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: MINIMAL_CSV }), res);
    expect(res._status).toBe(200); // Still returns positions even if save fails
    expect((res._json as { saved: boolean }).saved).toBe(false);
  });

  it('passes SPX price from query param', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: MINIMAL_CSV,
        query: { spx: '5850' },
      }),
      res,
    );
    const data = res._json as { positions: { summary: string } };
    expect(data.positions.summary).toContain('SPX at fetch time: 5850');
  });
});
