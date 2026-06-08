// @vitest-environment node

/**
 * Tests for db-positions.ts. Mocks the Neon SQL tagged template through
 * getDb and the withDbRetry passthrough, then verifies the query
 * functions still return correct data through the retry wrapper (H7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

import { savePositions, getLatestPositions } from '../_lib/db-positions.js';
import type { PositionInput } from '../_lib/db-positions.js';
import { getDb } from '../_lib/db.js';

function mockSqlReturning(rows: unknown[]) {
  const tag = vi.fn().mockResolvedValueOnce(rows);
  vi.mocked(getDb).mockReturnValue(tag as unknown as ReturnType<typeof getDb>);
  return tag;
}

const baseInput: PositionInput = {
  date: '2026-06-07',
  fetchTime: '10:00 AM',
  accountHash: 'abc',
  summary: '1 put spread',
  legs: [
    {
      putCall: 'PUT',
      symbol: 'SPXW',
      strike: 6800,
      expiration: '2026-06-07',
      quantity: -1,
      averagePrice: 1.2,
      marketValue: -120,
    },
  ],
};

describe('savePositions', () => {
  beforeEach(() => {
    vi.mocked(getDb).mockReset();
  });

  it('returns the inserted id through the withDbRetry wrapper', async () => {
    const tag = mockSqlReturning([{ id: 42 }]);
    const id = await savePositions(baseInput);
    expect(id).toBe(42);
    expect(tag).toHaveBeenCalledTimes(1);
  });

  it('returns null when the insert yields no rows', async () => {
    mockSqlReturning([]);
    const id = await savePositions(baseInput);
    expect(id).toBeNull();
  });
});

describe('getLatestPositions', () => {
  beforeEach(() => {
    vi.mocked(getDb).mockReset();
  });

  it('returns null when no rows exist', async () => {
    mockSqlReturning([]);
    const out = await getLatestPositions('2026-06-07');
    expect(out).toBeNull();
  });

  it('maps the latest row through the withDbRetry wrapper', async () => {
    mockSqlReturning([
      {
        summary: '2 put spreads',
        legs: JSON.stringify([
          {
            putCall: 'PUT',
            symbol: 'SPXW',
            strike: 6800,
            expiration: '2026-06-07',
            quantity: -2,
            averagePrice: 1.5,
            marketValue: -300,
          },
        ]),
        fetch_time: '2:00 PM',
        total_spreads: 2,
        call_spreads: 0,
        put_spreads: 2,
        net_delta: -0.3,
        net_theta: 1.1,
        unrealized_pnl: 50,
      },
    ]);
    const out = await getLatestPositions('2026-06-07');
    expect(out).not.toBeNull();
    expect(out?.summary).toBe('2 put spreads');
    expect(out?.fetchTime).toBe('2:00 PM');
    expect(out?.legs).toHaveLength(1);
    expect(out?.legs[0]?.strike).toBe(6800);
    expect(out?.stats).toEqual({
      totalSpreads: 2,
      callSpreads: 0,
      putSpreads: 2,
      netDelta: -0.3,
      netTheta: 1.1,
      unrealizedPnl: 50,
    });
  });

  it('handles legs already parsed as an array', async () => {
    mockSqlReturning([
      {
        summary: 'flat',
        legs: [
          {
            putCall: 'CALL',
            symbol: 'SPXW',
            strike: 6950,
            expiration: '2026-06-07',
            quantity: 1,
            averagePrice: 0.8,
            marketValue: 80,
          },
        ],
        fetch_time: '9:35 AM',
        total_spreads: 0,
        call_spreads: 0,
        put_spreads: 0,
        net_delta: null,
        net_theta: null,
        unrealized_pnl: null,
      },
    ]);
    const out = await getLatestPositions('2026-06-07');
    expect(out?.legs[0]?.putCall).toBe('CALL');
    expect(out?.stats.netDelta).toBeNull();
  });
});
