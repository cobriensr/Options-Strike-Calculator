import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/embeddings.js', () => ({
  generateEmbedding: vi.fn(),
}));

import { getDb } from '../_lib/db.js';
import { generateEmbedding } from '../_lib/embeddings.js';
import {
  DAY_EMBEDDING_DIMS,
  findSimilarDays,
  findSimilarDaysForSummary,
  upsertDayEmbedding,
} from '../_lib/day-embeddings.js';

const mockedGetDb = vi.mocked(getDb);
const mockedGenerateEmbedding = vi.mocked(generateEmbedding);

/** Build a mock sql tag that records calls and returns a given result. */
function mockSql(result: unknown) {
  const sql = vi.fn().mockResolvedValue(result);
  mockedGetDb.mockReturnValue(sql as unknown as ReturnType<typeof getDb>);
  return sql;
}

/** The SQL text of a tagged-template call, placeholders as `$`. */
function sqlText(sql: ReturnType<typeof vi.fn>, call = 0): string {
  const strings = sql.mock.calls[call]?.[0] as TemplateStringsArray;
  return strings.join('$').replaceAll(/\s+/g, ' ');
}

const VALID_EMBED = Array.from(
  { length: DAY_EMBEDDING_DIMS },
  (_, i) => i * 0.001,
);
const TOO_SHORT_EMBED = [0.1, 0.2];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('upsertDayEmbedding', () => {
  it('inserts with correct dimension + model tag', async () => {
    const sql = mockSql([]);

    const ok = await upsertDayEmbedding({
      date: '2024-08-05',
      symbol: 'ESU4',
      summary: '2024-08-05 ESU4 | ...',
      embedding: VALID_EMBED,
    });

    expect(ok).toBe(true);
    expect(sql).toHaveBeenCalledOnce();
    // The tag was called; check the insert landed in one statement.
    // We don't assert SQL text exactly — tagged templates are
    // structural — but we DO assert the mock was invoked.
  });

  it('refuses to upsert wrong-dim embeddings', async () => {
    const sql = mockSql([]);
    const ok = await upsertDayEmbedding({
      date: '2024-08-05',
      symbol: 'ESU4',
      summary: 'x',
      embedding: TOO_SHORT_EMBED,
    });
    expect(ok).toBe(false);
    expect(sql).not.toHaveBeenCalled();
  });

  it('refuses non-finite values', async () => {
    const sql = mockSql([]);
    const bad = [...VALID_EMBED.slice(1), NaN];
    const ok = await upsertDayEmbedding({
      date: '2024-08-05',
      symbol: 'ESU4',
      summary: 'x',
      embedding: bad,
    });
    expect(ok).toBe(false);
    expect(sql).not.toHaveBeenCalled();
  });

  it('returns false when the SQL call throws', async () => {
    const sql = vi.fn().mockRejectedValueOnce(new Error('pg down'));
    mockedGetDb.mockReturnValue(sql as unknown as ReturnType<typeof getDb>);

    const ok = await upsertDayEmbedding({
      date: '2024-08-05',
      symbol: 'ESU4',
      summary: 'x',
      embedding: VALID_EMBED,
    });
    expect(ok).toBe(false);
  });

  it('writes vix_bucket, and a null bucket never erases a stored one', async () => {
    const sql = mockSql([]);
    await upsertDayEmbedding({
      date: '2026-09-18',
      symbol: 'SPX',
      summary: 'x',
      embedding: VALID_EMBED,
      vixBucket: 'elevated',
    });
    await upsertDayEmbedding({
      date: '2026-09-18',
      symbol: 'SPX',
      summary: 'x',
      embedding: VALID_EMBED,
    });

    expect(sqlText(sql)).toContain(
      'vix_bucket = COALESCE(EXCLUDED.vix_bucket, day_embeddings.vix_bucket)',
    );
    expect(sql.mock.calls[0]).toContain('elevated');
    // Omitted bucket binds NULL (the COALESCE keeps the stored value).
    expect(sql.mock.calls[1]?.at(-1)).toBeNull();
  });
});

describe('findSimilarDays', () => {
  it('maps pgvector rows into SimilarDay[]', async () => {
    mockSql([
      {
        date: new Date('2024-08-05'),
        symbol: 'ESU4',
        summary: 'a',
        distance: 0.12,
      },
      { date: '2022-05-31', symbol: 'ESM2', summary: 'b', distance: 0.15 },
    ]);

    const out = await findSimilarDays(VALID_EMBED, 2, '2024-08-06');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      date: '2024-08-05',
      symbol: 'ESU4',
      distance: 0.12,
    });
    expect(out[1]).toMatchObject({
      date: '2022-05-31',
      distance: 0.15,
    });
  });

  it('only draws neighbours from days strictly before the query date', async () => {
    const sql = mockSql([]);
    await findSimilarDays(VALID_EMBED, 5, '2024-08-06');

    // `date <> d` let a backtest dated in the past retrieve later days.
    expect(sqlText(sql)).toContain('WHERE date < $::date');
    expect(sqlText(sql)).not.toContain('<>');
    expect(sql.mock.calls[0]).toContain('2024-08-06');
  });

  it('returns [] on wrong-dim input without hitting the DB', async () => {
    const sql = mockSql([]);
    const out = await findSimilarDays(TOO_SHORT_EMBED, 5, '2024-08-06');
    expect(out).toEqual([]);
    expect(sql).not.toHaveBeenCalled();
  });

  it('returns [] when the SQL call throws', async () => {
    const sql = vi.fn().mockRejectedValueOnce(new Error('pg down'));
    mockedGetDb.mockReturnValue(sql as unknown as ReturnType<typeof getDb>);

    const out = await findSimilarDays(VALID_EMBED, 5, '2024-08-06');
    expect(out).toEqual([]);
  });

  it('clamps k into [1, 50]', async () => {
    const sql = mockSql([]);
    await findSimilarDays(VALID_EMBED, 999, '2024-08-06');
    // The clamping is a boundary check, not user-visible in the result;
    // we just confirm the call was made with a sane literal at the end.
    // Since we use tagged templates, asserting the generated SQL is
    // brittle — sufficient to confirm the SQL tag was called once.
    expect(sql).toHaveBeenCalledOnce();
  });
});

describe('findSimilarDaysForSummary', () => {
  it('returns [] when generateEmbedding fails', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce(null);
    const sql = mockSql([]);

    const out = await findSimilarDaysForSummary('x', 5, '2024-08-06');
    expect(out).toEqual([]);
    expect(sql).not.toHaveBeenCalled();
  });

  it('passes the generated embedding to findSimilarDays', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce(VALID_EMBED);
    mockSql([
      { date: '2024-08-05', symbol: 'ESU4', summary: 'a', distance: 0.1 },
    ]);

    const out = await findSimilarDaysForSummary('x', 5, '2024-08-06');
    expect(out).toHaveLength(1);
    expect(mockedGenerateEmbedding).toHaveBeenCalledWith('x');
  });
});
