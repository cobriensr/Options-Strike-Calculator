// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// MOCKS - declared before module under test
// ============================================================

const mockSql = vi.fn(async (): Promise<Record<string, unknown>[]> => []);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
}));

const mockMessagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mockMessagesCreate };
  }
  return { default: MockAnthropic };
});

// ============================================================
// IMPORTS (after mocks)
// ============================================================

import {
  cosineSimilarity,
  dedupCandidatesInBatch,
  extractCandidatesViaRegex,
  extractCandidatesViaLLM,
  findSimilarLesson,
  upsertLesson,
  formatLessonsBlock,
  fetchActiveLessons,
  fetchUnprocessedDebriefs,
  type PeriscopeLessonRow,
} from '../_lib/periscope-lessons.js';

// ============================================================
// HELPERS
// ============================================================

function row(overrides: Partial<PeriscopeLessonRow> = {}): PeriscopeLessonRow {
  return {
    id: 1,
    lesson_text: 'Sample lesson',
    source_ids: [42],
    status: 'active',
    citation_count: 1,
    created_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

function vec(seed: number): number[] {
  // Deterministic 2000-dim embedding for test inputs.
  return Array.from({ length: 2000 }, (_, i) => Math.sin((i + 1) * seed) * 0.5);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockReset().mockImplementation(async () => []);
  mockMessagesCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
});

// ============================================================
// extractCandidatesViaRegex
// ============================================================

describe('extractCandidatesViaRegex', () => {
  it('extracts bullets when the heading is present', () => {
    const prose = `# Debrief 2026-05-01

Today the chart called the open well.

## What to add to the model

- When +gamma cluster sits 30 pts above spot, charm tally always wins by 2pm.
- Asymmetric cone (lower 2x further than upper) reliably skews intraday flow.
- Avoid naked longs into +gamma ceiling within 10 pts.

## Closing notes

Done for the day.`;

    const out = extractCandidatesViaRegex(prose);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('+gamma cluster sits 30 pts above spot');
    expect(out[1]).toContain('Asymmetric cone');
    expect(out[2]).toContain('Avoid naked longs');
  });

  it('returns empty array when the heading is absent', () => {
    const prose = `# Debrief

This is a free-form recap with no lesson section at all.

## Closing notes

Nothing to add.`;
    expect(extractCandidatesViaRegex(prose)).toEqual([]);
  });

  it('returns empty array on empty input', () => {
    expect(extractCandidatesViaRegex('')).toEqual([]);
  });

  it('handles bullets with continuation lines', () => {
    const prose = `## What to add to the model

- First lesson that wraps onto
  a continuation line in the source.
- Second lesson, single line.`;

    const out = extractCandidatesViaRegex(prose);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('First lesson that wraps onto');
    expect(out[0]).toContain('continuation line');
    expect(out[1]).toBe('Second lesson, single line.');
  });

  it('matches the heading case-insensitively', () => {
    const prose = `## WHAT TO ADD TO THE MODEL

- Lesson A
- Lesson B`;
    const out = extractCandidatesViaRegex(prose);
    expect(out).toEqual(['Lesson A', 'Lesson B']);
  });

  it('stops at the next heading', () => {
    const prose = `## What to add to the model

- Lesson 1
- Lesson 2

## Next section

- This bullet should NOT appear.`;
    const out = extractCandidatesViaRegex(prose);
    expect(out).toEqual(['Lesson 1', 'Lesson 2']);
  });
});

// ============================================================
// extractCandidatesViaLLM
// ============================================================

describe('extractCandidatesViaLLM', () => {
  it('returns parsed JSON array on success', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '["lesson 1", "lesson 2"]' }],
    });

    const out = await extractCandidatesViaLLM('some prose');
    expect(out).toEqual(['lesson 1', 'lesson 2']);
    expect(mockMessagesCreate).toHaveBeenCalledOnce();
  });

  it('strips markdown fences when Sonnet adds them', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: '```json\n["fenced lesson"]\n```',
        },
      ],
    });

    const out = await extractCandidatesViaLLM('prose');
    expect(out).toEqual(['fenced lesson']);
  });

  it('returns empty array on malformed response', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not json at all' }],
    });
    const out = await extractCandidatesViaLLM('prose');
    expect(out).toEqual([]);
  });

  it('returns empty array on non-array JSON', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"not":"an array"}' }],
    });
    const out = await extractCandidatesViaLLM('prose');
    expect(out).toEqual([]);
  });

  it('returns empty array when API throws', async () => {
    mockMessagesCreate.mockRejectedValueOnce(new Error('rate limited'));
    const out = await extractCandidatesViaLLM('prose');
    expect(out).toEqual([]);
  });

  it('skips when prose is empty', async () => {
    const out = await extractCandidatesViaLLM('');
    expect(out).toEqual([]);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it('skips when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const out = await extractCandidatesViaLLM('prose');
    expect(out).toEqual([]);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it('filters out non-string array entries', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [
        { type: 'text', text: '["good lesson", 42, null, "another good"]' },
      ],
    });
    const out = await extractCandidatesViaLLM('prose');
    expect(out).toEqual(['good lesson', 'another good']);
  });
});

// ============================================================
// findSimilarLesson
// ============================================================

describe('findSimilarLesson', () => {
  it('returns null when the table is empty', async () => {
    mockSql.mockResolvedValueOnce([]);
    const out = await findSimilarLesson(vec(1), 0.8);
    expect(out).toBeNull();
  });

  it('returns the id when similarity >= threshold', async () => {
    mockSql.mockResolvedValueOnce([{ id: 7, similarity: 0.85 }]);
    const out = await findSimilarLesson(vec(1), 0.8);
    expect(out).toBe(7);
  });

  it('returns null when similarity is below threshold', async () => {
    mockSql.mockResolvedValueOnce([{ id: 7, similarity: 0.65 }]);
    const out = await findSimilarLesson(vec(1), 0.8);
    expect(out).toBeNull();
  });

  it('returns null on empty embedding without hitting the DB', async () => {
    const out = await findSimilarLesson([], 0.8);
    expect(out).toBeNull();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('throws on non-finite embedding values', async () => {
    await expect(findSimilarLesson([NaN, 1, 2], 0.8)).rejects.toThrow(
      'Invalid embedding',
    );
  });
});

// ============================================================
// upsertLesson
// ============================================================

describe('upsertLesson', () => {
  it('inserts a new row when no similar lesson exists', async () => {
    // Call 1: findSimilarLesson SELECT - empty
    // Call 2: INSERT RETURNING id
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 99 }]);

    const result = await upsertLesson({
      lessonText: 'New lesson',
      embedding: vec(2),
      sourceIds: [11],
    });

    expect(result).toEqual({ inserted: true, lessonId: 99 });
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('merges into existing row when similarity >= 0.8', async () => {
    // Call 1: findSimilarLesson SELECT - hit
    // Call 2: UPDATE merge
    mockSql
      .mockResolvedValueOnce([{ id: 5, similarity: 0.92 }])
      .mockResolvedValueOnce([]);

    const result = await upsertLesson({
      lessonText: 'Duplicate-ish lesson',
      embedding: vec(3),
      sourceIds: [22],
    });

    expect(result).toEqual({ inserted: false, lessonId: 5 });
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('inserts when top match is below 0.8 threshold', async () => {
    // Call 1: findSimilarLesson - low similarity rejected
    // Call 2: INSERT RETURNING id
    mockSql
      .mockResolvedValueOnce([{ id: 5, similarity: 0.5 }])
      .mockResolvedValueOnce([{ id: 100 }]);

    const result = await upsertLesson({
      lessonText: 'Distinct lesson',
      embedding: vec(4),
      sourceIds: [33],
    });

    expect(result).toEqual({ inserted: true, lessonId: 100 });
  });

  it('throws when INSERT returns no id', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await expect(
      upsertLesson({
        lessonText: 'X',
        embedding: vec(5),
        sourceIds: [1],
      }),
    ).rejects.toThrow('did not return an id');
  });

  it('inserts with full sourceIds + matching citation_count when survivor folded multiple debriefs', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 200 }]);
    const result = await upsertLesson({
      lessonText: 'Folded survivor',
      embedding: vec(7),
      sourceIds: [10, 20, 30],
    });
    expect(result).toEqual({ inserted: true, lessonId: 200 });
    // Bind values include the full sourceIds array as bigint[] strings.
    const insertCall = mockSql.mock.calls[1]!;
    expect(insertCall).toContainEqual(['10', '20', '30']);
    expect(insertCall).toContain(3); // citation_count = sourceIds.length
  });

  it('rejects empty sourceIds array', async () => {
    await expect(
      upsertLesson({ lessonText: 'X', embedding: vec(8), sourceIds: [] }),
    ).rejects.toThrow('sourceIds must not be empty');
  });
});

// ============================================================
// cosineSimilarity
// ============================================================

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1.0, 6);
  });

  it('returns -1.0 for opposite vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1.0, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('returns 0 for zero-magnitude inputs (degenerate, no NaN)', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('returns 0 for length-mismatched inputs', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('returns 0 for empty inputs', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

// ============================================================
// dedupCandidatesInBatch
// ============================================================

describe('dedupCandidatesInBatch', () => {
  it('passes through distinct candidates unchanged (low similarity)', () => {
    const result = dedupCandidatesInBatch([
      { debriefId: 1, lessonText: 'A', embedding: [1, 0, 0] },
      { debriefId: 2, lessonText: 'B', embedding: [0, 1, 0] },
      { debriefId: 3, lessonText: 'C', embedding: [0, 0, 1] },
    ]);
    expect(result).toHaveLength(3);
    expect(result.map((g) => g.sourceIds)).toEqual([[1], [2], [3]]);
  });

  it('folds near-duplicates above threshold into one survivor', () => {
    // Two near-identical (cos ~0.99) plus one orthogonal.
    const result = dedupCandidatesInBatch(
      [
        { debriefId: 1, lessonText: 'A', embedding: [1, 0, 0] },
        { debriefId: 2, lessonText: 'A-dup', embedding: [0.99, 0.01, 0.01] },
        { debriefId: 3, lessonText: 'B', embedding: [0, 1, 0] },
      ],
      0.8,
    );
    expect(result).toHaveLength(2);
    const folded = result.find((g) => g.sourceIds.length === 2)!;
    expect(folded.sourceIds.sort()).toEqual([1, 2]);
    expect(folded.lessonText).toBe('A'); // first-seen wins
  });

  it('does not duplicate same debriefId within a survivor (idempotent)', () => {
    const result = dedupCandidatesInBatch(
      [
        { debriefId: 1, lessonText: 'A', embedding: [1, 0, 0] },
        { debriefId: 1, lessonText: 'A-again', embedding: [1, 0, 0] },
      ],
      0.8,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.sourceIds).toEqual([1]);
  });

  it('returns empty array for empty input', () => {
    expect(dedupCandidatesInBatch([])).toEqual([]);
  });

  it('respects threshold (lower threshold = more aggressive folding)', () => {
    const candidates = [
      { debriefId: 1, lessonText: 'A', embedding: [1, 0, 0] },
      { debriefId: 2, lessonText: 'B', embedding: [0.7, 0.7, 0] }, // cos ~0.707
    ];
    expect(dedupCandidatesInBatch(candidates, 0.5)).toHaveLength(1); // folded
    expect(dedupCandidatesInBatch(candidates, 0.8)).toHaveLength(2); // distinct
  });
});

// ============================================================
// formatLessonsBlock
// ============================================================

describe('formatLessonsBlock', () => {
  it('returns empty string when no active lessons', () => {
    expect(formatLessonsBlock([])).toBe('');
  });

  it('omits archived rows', () => {
    const lessons: PeriscopeLessonRow[] = [
      row({ id: 1, lesson_text: 'Active A', status: 'active' }),
      row({ id: 2, lesson_text: 'Archived B', status: 'archived' }),
      row({ id: 3, lesson_text: 'Active C', status: 'active' }),
    ];
    const out = formatLessonsBlock(lessons);
    expect(out).toContain('Active A');
    expect(out).toContain('Active C');
    expect(out).not.toContain('Archived B');
  });

  it('omits proposed rows', () => {
    const lessons: PeriscopeLessonRow[] = [
      row({ id: 1, lesson_text: 'Promoted', status: 'active' }),
      row({ id: 2, lesson_text: 'Pending', status: 'proposed' }),
    ];
    const out = formatLessonsBlock(lessons);
    expect(out).toContain('Promoted');
    expect(out).not.toContain('Pending');
  });

  it('returns empty string when ALL rows are non-active', () => {
    const lessons: PeriscopeLessonRow[] = [
      row({ id: 1, lesson_text: 'Pending', status: 'proposed' }),
      row({ id: 2, lesson_text: 'Archived', status: 'archived' }),
    ];
    expect(formatLessonsBlock(lessons)).toBe('');
  });

  it('sorts by citation_count DESC', () => {
    const lessons: PeriscopeLessonRow[] = [
      row({ id: 1, lesson_text: 'Low cite', citation_count: 1 }),
      row({ id: 2, lesson_text: 'High cite', citation_count: 5 }),
      row({ id: 3, lesson_text: 'Mid cite', citation_count: 3 }),
    ];
    const out = formatLessonsBlock(lessons);
    const highIdx = out.indexOf('High cite');
    const midIdx = out.indexOf('Mid cite');
    const lowIdx = out.indexOf('Low cite');
    expect(highIdx).toBeGreaterThanOrEqual(0);
    expect(highIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lowIdx);
  });

  it('annotates citation count when > 1', () => {
    const lessons: PeriscopeLessonRow[] = [
      row({ id: 1, lesson_text: 'Repeat', citation_count: 4 }),
    ];
    const out = formatLessonsBlock(lessons);
    expect(out).toContain('cited 4x');
  });

  it('does not annotate when citation count is 1', () => {
    const lessons: PeriscopeLessonRow[] = [
      row({ id: 1, lesson_text: 'Single', citation_count: 1 }),
    ];
    const out = formatLessonsBlock(lessons);
    // The header explanation contains the word "cited" — assert on the
    // specific Nx annotation pattern that appears next to the bullet.
    expect(out).not.toMatch(/cited \d+x/);
  });

  it('does not mutate the caller array', () => {
    const lessons: PeriscopeLessonRow[] = [
      row({ id: 1, lesson_text: 'A', citation_count: 1 }),
      row({ id: 2, lesson_text: 'B', citation_count: 5 }),
    ];
    const before = lessons.map((l) => l.id);
    formatLessonsBlock(lessons);
    const after = lessons.map((l) => l.id);
    expect(after).toEqual(before);
  });
});

// ============================================================
// fetchActiveLessons / fetchUnprocessedDebriefs (smoke)
// ============================================================

describe('fetchActiveLessons', () => {
  it('returns mapped rows', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 1,
        lesson_text: 'L1',
        source_ids: [10, 20],
        status: 'active',
        citation_count: 2,
        created_at: '2026-05-01T00:00:00.000Z',
      },
    ]);
    const out = await fetchActiveLessons(15);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 1,
      lesson_text: 'L1',
      source_ids: [10, 20],
      status: 'active',
      citation_count: 2,
    });
  });
});

describe('fetchUnprocessedDebriefs', () => {
  it('returns mapped rows', async () => {
    mockSql.mockResolvedValueOnce([
      { id: 7, prose_text: 'debrief one' },
      { id: 8, prose_text: 'debrief two' },
    ]);
    const out = await fetchUnprocessedDebriefs('2026-05-01T00:00:00.000Z');
    expect(out).toEqual([
      { id: 7, prose_text: 'debrief one' },
      { id: 8, prose_text: 'debrief two' },
    ]);
  });

  it('treats null prose_text as empty string', async () => {
    mockSql.mockResolvedValueOnce([{ id: 9, prose_text: null }]);
    const out = await fetchUnprocessedDebriefs('2026-05-01T00:00:00.000Z');
    expect(out).toEqual([{ id: 9, prose_text: '' }]);
  });
});
