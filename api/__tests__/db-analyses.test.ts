// @vitest-environment node

/**
 * Tests for db-analyses.ts. Mocks the Neon SQL tagged template through
 * getDb and the withDbRetry passthrough, then verifies that the query
 * functions still return correct data through the retry wrapper (H7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

import { getPreviousRecommendation } from '../_lib/db-analyses.js';
import { getDb } from '../_lib/db.js';

function mockSqlReturning(rows: unknown[]) {
  const tag = vi.fn().mockResolvedValueOnce(rows);
  vi.mocked(getDb).mockReturnValue(tag as unknown as ReturnType<typeof getDb>);
  return tag;
}

describe('getPreviousRecommendation', () => {
  beforeEach(() => {
    vi.mocked(getDb).mockReset();
  });

  it('returns null for entry mode without querying the DB', async () => {
    const out = await getPreviousRecommendation('2026-06-07', 'entry');
    expect(out).toBeNull();
    expect(getDb).not.toHaveBeenCalled();
  });

  it('returns null for an unknown mode', async () => {
    const out = await getPreviousRecommendation('2026-06-07', 'bogus');
    expect(out).toBeNull();
  });

  it('returns null when midday mode finds no prior analysis', async () => {
    mockSqlReturning([]);
    const out = await getPreviousRecommendation('2026-06-07', 'midday');
    expect(out).toBeNull();
  });

  it('formats the prior recommendation through the withDbRetry wrapper (midday)', async () => {
    mockSqlReturning([
      {
        mode: 'entry',
        entry_time: '9:35 AM',
        structure: 'iron_condor',
        confidence: 'HIGH',
        suggested_delta: 12,
        hedge: 'none',
        spx: 6900,
        vix: 14.2,
        vix1d: 11.0,
        full_response: JSON.stringify({
          reasoning: 'Range-bound tape',
          observations: ['obs1', 'obs2'],
        }),
        created_at: '2026-06-07T13:40:00Z',
      },
    ]);
    const out = await getPreviousRecommendation('2026-06-07', 'midday');
    expect(out).toContain('=== Previous ENTRY Analysis (9:35 AM) ===');
    expect(out).toContain('Structure: iron_condor');
    expect(out).toContain('Reasoning: Range-bound tape');
    expect(out).toContain('- obs1');
  });

  it('handles an already-parsed full_response object (review)', async () => {
    mockSqlReturning([
      {
        mode: 'midday',
        entry_time: '12:00 PM',
        structure: 'put_spread',
        confidence: 'MEDIUM',
        suggested_delta: 20,
        hedge: null,
        spx: 6850,
        vix: 15.0,
        vix1d: 12.0,
        full_response: { reasoning: 'Trend down' },
        created_at: '2026-06-07T17:00:00Z',
      },
    ]);
    const out = await getPreviousRecommendation('2026-06-07', 'review');
    expect(out).toContain('=== Previous MIDDAY Analysis (12:00 PM) ===');
    expect(out).toContain('Reasoning: Trend down');
    expect(out).toContain('Hedge: N/A');
  });
});
