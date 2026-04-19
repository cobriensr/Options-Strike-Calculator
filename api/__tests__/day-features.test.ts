import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../_lib/db.js';
import {
  DAY_FEATURES_DIM,
  findSimilarDaysByFeatures,
  upsertDayFeatures,
} from '../_lib/day-features.js';

const mockedGetDb = vi.mocked(getDb);

function mockSql(result: unknown) {
  const sql = vi.fn().mockResolvedValue(result);
  mockedGetDb.mockReturnValue(sql as unknown as ReturnType<typeof getDb>);
  return sql;
}

const VALID_VEC = Array.from(
  { length: DAY_FEATURES_DIM },
  (_, i) => i * 0.0001,
);
const SHORT_VEC = [0.1, 0.2, 0.3];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('upsertDayFeatures', () => {
  it('accepts a 60-dim finite vector', async () => {
    const sql = mockSql([]);
    const ok = await upsertDayFeatures({
      date: '2024-08-05',
      symbol: 'ESU4',
      features: VALID_VEC,
    });
    expect(ok).toBe(true);
    expect(sql).toHaveBeenCalledOnce();
  });

  it('rejects wrong-dim vectors', async () => {
    const sql = mockSql([]);
    const ok = await upsertDayFeatures({
      date: '2024-08-05',
      symbol: 'ESU4',
      features: SHORT_VEC,
    });
    expect(ok).toBe(false);
    expect(sql).not.toHaveBeenCalled();
  });

  it('rejects non-finite values', async () => {
    const sql = mockSql([]);
    const ok = await upsertDayFeatures({
      date: '2024-08-05',
      symbol: 'ESU4',
      features: [...VALID_VEC.slice(1), Number.POSITIVE_INFINITY],
    });
    expect(ok).toBe(false);
    expect(sql).not.toHaveBeenCalled();
  });

  it('returns false on SQL error', async () => {
    const sql = vi.fn().mockRejectedValueOnce(new Error('pg down'));
    mockedGetDb.mockReturnValue(sql as unknown as ReturnType<typeof getDb>);
    const ok = await upsertDayFeatures({
      date: '2024-08-05',
      symbol: 'ESU4',
      features: VALID_VEC,
    });
    expect(ok).toBe(false);
  });
});

describe('findSimilarDaysByFeatures', () => {
  it('maps rows into SimilarDayByFeatures[]', async () => {
    mockSql([
      { date: new Date('2024-08-05'), symbol: 'ESU4', distance: 0.05 },
      { date: '2022-05-31', symbol: 'ESM2', distance: 0.07 },
    ]);

    const out = await findSimilarDaysByFeatures(VALID_VEC, 5, '2024-08-06');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ date: '2024-08-05', symbol: 'ESU4' });
    expect(out[1]).toMatchObject({ date: '2022-05-31', distance: 0.07 });
  });

  it('returns [] on wrong-dim input', async () => {
    const sql = mockSql([]);
    const out = await findSimilarDaysByFeatures(SHORT_VEC, 5, '2024-08-06');
    expect(out).toEqual([]);
    expect(sql).not.toHaveBeenCalled();
  });

  it('returns [] on SQL error', async () => {
    const sql = vi.fn().mockRejectedValueOnce(new Error('pg down'));
    mockedGetDb.mockReturnValue(sql as unknown as ReturnType<typeof getDb>);
    const out = await findSimilarDaysByFeatures(VALID_VEC, 5, '2024-08-06');
    expect(out).toEqual([]);
  });
});
