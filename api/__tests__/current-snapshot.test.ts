import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../_lib/db.js';
import {
  fetchCurrentSnapshot,
  upsertCurrentSnapshot,
} from '../_lib/current-snapshot.js';

const mockedGetDb = vi.mocked(getDb);

function mockSql(result: unknown) {
  const sql = vi.fn().mockResolvedValue(result);
  mockedGetDb.mockReturnValue(sql as unknown as ReturnType<typeof getDb>);
  return sql;
}

const VALID = Array.from({ length: 60 }, (_, i) => i * 0.001);
const SHORT = [0.1, 0.2];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('upsertCurrentSnapshot', () => {
  it('accepts a 60-dim finite vector', async () => {
    const sql = mockSql([]);
    const ok = await upsertCurrentSnapshot({
      date: '2026-04-18',
      symbol: 'ESM6',
      summary: '2026-04-18 ESM6 | ...',
      features: VALID,
    });
    expect(ok).toBe(true);
    expect(sql).toHaveBeenCalledOnce();
  });

  it('rejects wrong-dim vectors', async () => {
    const sql = mockSql([]);
    const ok = await upsertCurrentSnapshot({
      date: '2026-04-18',
      symbol: 'ESM6',
      summary: 'x',
      features: SHORT,
    });
    expect(ok).toBe(false);
    expect(sql).not.toHaveBeenCalled();
  });

  it('rejects non-finite values', async () => {
    const sql = mockSql([]);
    const bad = [...VALID.slice(1), Number.NaN];
    const ok = await upsertCurrentSnapshot({
      date: '2026-04-18',
      symbol: 'ESM6',
      summary: 'x',
      features: bad,
    });
    expect(ok).toBe(false);
    expect(sql).not.toHaveBeenCalled();
  });

  it('returns false on SQL error', async () => {
    const sql = vi.fn().mockRejectedValueOnce(new Error('pg down'));
    mockedGetDb.mockReturnValue(sql as unknown as ReturnType<typeof getDb>);
    const ok = await upsertCurrentSnapshot({
      date: '2026-04-18',
      symbol: 'ESM6',
      summary: 'x',
      features: VALID,
    });
    expect(ok).toBe(false);
  });
});

describe('fetchCurrentSnapshot', () => {
  it('returns null when no row exists', async () => {
    mockSql([]);
    expect(await fetchCurrentSnapshot('2026-04-18')).toBeNull();
  });

  it('parses vector text and returns the row', async () => {
    const computedAt = new Date(Date.now() - 60_000); // 1 min old
    const featuresText = `[${VALID.join(',')}]`;
    mockSql([
      {
        date: new Date('2026-04-18'),
        symbol: 'ESM6',
        summary: 'summary',
        features_text: featuresText,
        computed_at: computedAt,
      },
    ]);

    const snap = await fetchCurrentSnapshot('2026-04-18');
    expect(snap).not.toBeNull();
    expect(snap?.date).toBe('2026-04-18');
    expect(snap?.symbol).toBe('ESM6');
    expect(snap?.summary).toBe('summary');
    expect(snap?.features).toHaveLength(60);
    expect(snap?.features[0]).toBe(0);
    expect(snap?.features[59]).toBeCloseTo(0.059, 5);
    expect(snap?.ageMs).toBeGreaterThanOrEqual(60_000);
  });

  it('returns null when row is older than maxAgeMs', async () => {
    const oldComputedAt = new Date(Date.now() - 60 * 60_000); // 60 min old
    const featuresText = `[${VALID.join(',')}]`;
    mockSql([
      {
        date: new Date('2026-04-18'),
        symbol: 'ESM6',
        summary: 'summary',
        features_text: featuresText,
        computed_at: oldComputedAt,
      },
    ]);

    // Default maxAgeMs is 30 min — 60 min is stale.
    expect(await fetchCurrentSnapshot('2026-04-18')).toBeNull();
  });

  it('returns null on unparseable vector text', async () => {
    const computedAt = new Date();
    mockSql([
      {
        date: new Date('2026-04-18'),
        symbol: 'ESM6',
        summary: 'x',
        features_text: 'not-a-vector',
        computed_at: computedAt,
      },
    ]);
    expect(await fetchCurrentSnapshot('2026-04-18')).toBeNull();
  });

  it('returns null on SQL error', async () => {
    const sql = vi.fn().mockRejectedValueOnce(new Error('pg down'));
    mockedGetDb.mockReturnValue(sql as unknown as ReturnType<typeof getDb>);
    expect(await fetchCurrentSnapshot('2026-04-18')).toBeNull();
  });
});
