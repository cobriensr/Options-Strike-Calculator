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

import {
  savePositions,
  getLatestPositions,
  getLatestCsvPositions,
} from '../_lib/db-positions.js';
import type { PositionInput } from '../_lib/db-positions.js';
import { getDb } from '../_lib/db.js';

function mockSqlReturning(rows: unknown[]) {
  const tag = vi.fn().mockResolvedValueOnce(rows);
  vi.mocked(getDb).mockReturnValue(tag as unknown as ReturnType<typeof getDb>);
  return tag;
}

/**
 * The text of the tagged-template call (each `${}` shown as `?`) and its
 * bound values, so a test can pin the clauses the real SQL must carry. The
 * clauses themselves run against Postgres in positions-upsert-pglite.test.ts.
 */
function firstCall(tag: ReturnType<typeof vi.fn>): {
  text: string;
  values: unknown[];
} {
  const [strings, ...values] = tag.mock.calls[0] as [
    TemplateStringsArray,
    ...unknown[],
  ];
  return { text: strings.join('?'), values };
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

  it('returns null when the conflict guard skips the upsert (no RETURNING row)', async () => {
    // The guard (see the next test) makes Postgres skip the DO UPDATE, so
    // RETURNING yields nothing; the caller reads null as "not saved".
    const tag = mockSqlReturning([]);
    const id = await savePositions({ ...baseInput, accountHash: 'hash1' });
    expect(id).toBeNull();
    expect(tag).toHaveBeenCalledTimes(1);
  });

  it('guards the upsert so a Schwab save never replaces a paperMoney row', async () => {
    const tag = mockSqlReturning([{ id: 7 }]);
    await savePositions(baseInput);
    const { text, values } = firstCall(tag);

    expect(text).toMatch(/ON CONFLICT \(date, fetch_time\) DO UPDATE SET/);
    // WHERE sits after the SET list and before RETURNING.
    expect(text).toMatch(
      /unrealized_pnl = EXCLUDED\.unrealized_pnl\s+WHERE positions\.account_hash <> \?\s+OR EXCLUDED\.account_hash = \?\s+RETURNING id/,
    );
    // Both comparands are the CSV marker, bound after the 16 insert values.
    expect(values.slice(-2)).toEqual(['paperMoney', 'paperMoney']);
  });
});

describe('getLatestCsvPositions', () => {
  beforeEach(() => {
    vi.mocked(getDb).mockReset();
  });

  it('reads the date’s newest paperMoney row, newest first', async () => {
    const tag = mockSqlReturning([]);
    await getLatestCsvPositions('2026-06-07');

    expect(tag).toHaveBeenCalledTimes(1);
    const { text, values } = firstCall(tag);
    expect(values).toEqual(['2026-06-07', 'paperMoney']);
    expect(text).toMatch(/FROM positions\s+WHERE date = \?/);
    expect(text).toMatch(/AND account_hash = \?/);
    expect(text).toMatch(/ORDER BY created_at DESC\s+LIMIT 1/);
  });

  it('returns null when the date has no paperMoney row', async () => {
    mockSqlReturning([]);
    expect(await getLatestCsvPositions('2026-06-07')).toBeNull();
  });

  it('parses legs stored as a JSON string and returns the row’s fetch_time', async () => {
    mockSqlReturning([
      {
        legs: JSON.stringify([
          {
            putCall: 'CALL',
            symbol: 'SPXW',
            strike: 6900,
            expiration: '2026-06-07',
            quantity: -1,
            averagePrice: 2,
            marketValue: -150,
          },
        ]),
        fetch_time: '10:15',
      },
    ]);
    const out = await getLatestCsvPositions('2026-06-07');
    expect(out).toEqual({
      fetchTime: '10:15',
      legs: [
        {
          putCall: 'CALL',
          symbol: 'SPXW',
          strike: 6900,
          expiration: '2026-06-07',
          quantity: -1,
          averagePrice: 2,
          marketValue: -150,
        },
      ],
    });
  });

  it('passes legs already parsed as an array through unchanged', async () => {
    const legs = [
      {
        putCall: 'PUT',
        symbol: 'SPXW',
        strike: 6700,
        expiration: '2026-06-07',
        quantity: 1,
        averagePrice: 1,
        marketValue: 90,
      },
    ];
    mockSqlReturning([{ legs, fetch_time: '09:40' }]);
    const out = await getLatestCsvPositions('2026-06-07');
    expect(out?.legs).toEqual(legs);
    expect(out?.fetchTime).toBe('09:40');
  });

  it('returns an empty legs array for a CSV row with no open legs (it still counts as a row)', async () => {
    mockSqlReturning([{ legs: '[]', fetch_time: '11:02' }]);
    expect(await getLatestCsvPositions('2026-06-07')).toEqual({
      legs: [],
      fetchTime: '11:02',
    });
  });

  it('lets a database error through (the endpoint maps it to 503 or 500)', async () => {
    const tag = vi.fn().mockRejectedValueOnce(new Error('connection lost'));
    vi.mocked(getDb).mockReturnValue(
      tag as unknown as ReturnType<typeof getDb>,
    );
    await expect(getLatestCsvPositions('2026-06-07')).rejects.toThrow(
      'connection lost',
    );
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
