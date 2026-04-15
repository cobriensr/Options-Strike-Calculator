// @vitest-environment node

/**
 * Tests for getRecentVixSnapshots in db-snapshots.ts. Mocks the Neon SQL
 * tagged template through getDb and verifies the row-mapping, filtering,
 * sorting, and numeric-coercion behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(),
}));

import { getRecentVixSnapshots } from '../_lib/db-snapshots.js';
import { getDb } from '../_lib/db.js';

interface RawRow {
  entry_time: string;
  vix: string;
  vix1d: string | null;
  vix9d: string | null;
  spx: string | null;
}

function mockSqlReturning(rows: RawRow[]) {
  const tag = vi.fn().mockResolvedValueOnce(rows);
  vi.mocked(getDb).mockReturnValue(tag as unknown as ReturnType<typeof getDb>);
}

describe('getRecentVixSnapshots', () => {
  beforeEach(() => {
    vi.mocked(getDb).mockReset();
  });

  it('parses string columns into numbers and preserves nulls', async () => {
    mockSqlReturning([
      {
        entry_time: '9:35 AM',
        vix: '17.20',
        vix1d: '11.03',
        vix9d: '15.40',
        spx: '6970.50',
      },
    ]);
    const out = await getRecentVixSnapshots('2026-04-14');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      entryTime: '9:35 AM',
      vix: 17.2,
      vix1d: 11.03,
      vix9d: 15.4,
      spx: 6970.5,
    });
  });

  it('keeps nulls for vix1d / vix9d / spx when the column is null', async () => {
    mockSqlReturning([
      {
        entry_time: '10:00 AM',
        vix: '17.5',
        vix1d: null,
        vix9d: '15.0',
        spx: null,
      },
    ]);
    const [row] = await getRecentVixSnapshots('2026-04-14');
    expect(row?.vix1d).toBeNull();
    expect(row?.vix9d).toBe(15);
    expect(row?.spx).toBeNull();
  });

  it('drops rows with NaN vix or non-positive vix', async () => {
    mockSqlReturning([
      {
        entry_time: '9:30 AM',
        vix: 'not-a-number',
        vix1d: null,
        vix9d: '15',
        spx: null,
      },
      { entry_time: '9:31 AM', vix: '0', vix1d: null, vix9d: '15', spx: null },
      {
        entry_time: '9:32 AM',
        vix: '17.2',
        vix1d: null,
        vix9d: '15',
        spx: null,
      },
    ]);
    const out = await getRecentVixSnapshots('2026-04-14');
    expect(out).toHaveLength(1);
    expect(out[0]?.entryTime).toBe('9:32 AM');
  });

  it('sorts rows ascending by parsed entry_time minutes', async () => {
    mockSqlReturning([
      { entry_time: '2:30 PM', vix: '17', vix1d: null, vix9d: '15', spx: null },
      { entry_time: '9:30 AM', vix: '17', vix1d: null, vix9d: '15', spx: null },
      {
        entry_time: '12:00 PM',
        vix: '17',
        vix1d: null,
        vix9d: '15',
        spx: null,
      },
    ]);
    const out = await getRecentVixSnapshots('2026-04-14');
    expect(out.map((r) => r.entryTime)).toEqual([
      '9:30 AM',
      '12:00 PM',
      '2:30 PM',
    ]);
  });

  it('drops rows with unparseable entry_time', async () => {
    mockSqlReturning([
      { entry_time: 'lunch', vix: '17', vix1d: null, vix9d: '15', spx: null },
      {
        entry_time: '11:00 AM',
        vix: '17',
        vix1d: null,
        vix9d: '15',
        spx: null,
      },
    ]);
    const out = await getRecentVixSnapshots('2026-04-14');
    expect(out).toHaveLength(1);
    expect(out[0]?.entryTime).toBe('11:00 AM');
  });

  it('coerces NaN vix1d / vix9d / spx to null', async () => {
    mockSqlReturning([
      {
        entry_time: '9:30 AM',
        vix: '17.0',
        vix1d: 'oops',
        vix9d: 'nope',
        spx: 'not-a-num',
      },
    ]);
    const [row] = await getRecentVixSnapshots('2026-04-14');
    expect(row?.vix1d).toBeNull();
    expect(row?.vix9d).toBeNull();
    expect(row?.spx).toBeNull();
  });

  it('returns an empty array when the query produces no rows', async () => {
    mockSqlReturning([]);
    const out = await getRecentVixSnapshots('2026-04-14');
    expect(out).toEqual([]);
  });
});
