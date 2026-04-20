// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSql = vi.fn();
vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => mockSql),
}));

const mockCreate = vi.fn();
vi.mock('openai', () => ({
  default: class MockOpenAI {
    embeddings = { create: mockCreate };
  },
}));

import { neon } from '@neondatabase/serverless';
import { _resetDb } from '../_lib/db.js';
import { _resetClient } from '../_lib/embeddings.js';
import {
  formatRangeForecast,
  getRangeForecast,
} from '../_lib/analog-range-forecast.js';

describe('analog-range-forecast.ts', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DATABASE_URL: 'postgres://test',
      OPENAI_API_KEY: 'test-key',
    };
    vi.restoreAllMocks();
    mockSql.mockReset();
    mockCreate.mockReset();
    vi.mocked(neon).mockReturnValue(mockSql as never);
    _resetDb();
    _resetClient();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function mockEmbedding() {
    const vec = Array.from({ length: 2000 }, () => 0.001);
    mockCreate.mockResolvedValueOnce({ data: [{ embedding: vec }] });
  }

  it('returns null when embedding generation fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('openai down'));
    const out = await getRangeForecast('2026-04-19', 'some summary');
    expect(out).toBeNull();
  });

  it('returns null when no analog rows exist', async () => {
    mockEmbedding();
    mockSql.mockResolvedValueOnce([]);
    const out = await getRangeForecast('2026-04-19', 'some summary');
    expect(out).toBeNull();
  });

  it('computes quantiles + asymmetric strike hints from cohort rows', async () => {
    mockEmbedding();
    const rows = Array.from({ length: 15 }, (_, i) => ({
      date: `2024-01-${String(i + 1).padStart(2, '0')}`,
      range_pt: 10 + i,
      up_exc: 5 + i,
      down_exc: 8 + i,
    }));
    mockSql.mockResolvedValueOnce(rows);

    const out = await getRangeForecast('2026-04-19', 'morning summary');

    expect(out).not.toBeNull();
    if (!out) throw new Error('unreachable');
    expect(out.cohort.n).toBe(15);
    expect(out.targetDate).toBe('2026-04-19');
    expect(out.cohort.range[0.5]).toBeCloseTo(17, 2);
    expect(out.cohort.range[0.85]).toBeCloseTo(21.9, 1);
    expect(out.cohort.range[0.95]).toBeCloseTo(23.3, 1);
    expect(out.cohort.downExc[0.85]).toBeGreaterThan(out.cohort.upExc[0.85]);
    expect(out.strikes.condor30d.up).toBeCloseTo(out.cohort.upExc[0.85], 4);
    expect(out.strikes.condor12d.down).toBeCloseTo(out.cohort.downExc[0.95], 4);
    // Without a vixBucket, regime-matched should be null and strikes
    // should source from the unstratified cohort.
    expect(out.regimeMatched).toBeNull();
    expect(out.strikes.source).toBe('unstratified');
  });

  it('uses regime-matched cohort when vixBucket is supplied and subset is healthy', async () => {
    mockEmbedding();
    const unstratRows = Array.from({ length: 15 }, (_, i) => ({
      date: `2024-01-${String(i + 1).padStart(2, '0')}`,
      range_pt: 10 + i,
      up_exc: 5 + i,
      down_exc: 8 + i,
    }));
    // Regime-matched cohort: deliberately wider (20..34) to confirm
    // strikes come from THIS cohort, not the unstratified one.
    const regimeRows = Array.from({ length: 15 }, (_, i) => ({
      date: `2024-02-${String(i + 1).padStart(2, '0')}`,
      range_pt: 20 + i,
      up_exc: 12 + i,
      down_exc: 15 + i,
    }));
    mockSql
      .mockResolvedValueOnce(unstratRows)
      .mockResolvedValueOnce(regimeRows);

    const out = await getRangeForecast('2026-04-19', 'summary', 'elevated');
    if (!out) throw new Error('unreachable');
    expect(out.regimeMatched).not.toBeNull();
    expect(out.regimeMatched?.vixBucket).toBe('elevated');
    expect(out.regimeMatched?.n).toBe(15);
    // Strikes should source from regime-matched (wider cohort).
    expect(out.strikes.source).toBe('regime-matched');
    expect(out.strikes.condor30d.up).toBeCloseTo(
      out.regimeMatched?.upExc[0.85] ?? 0,
      4,
    );
    // Confirm strikes DON'T come from the narrower unstratified cohort.
    expect(out.strikes.condor30d.up).toBeGreaterThan(out.cohort.upExc[0.85]);
  });

  it('falls back to unstratified when regime-matched subset is too thin', async () => {
    mockEmbedding();
    const unstratRows = Array.from({ length: 15 }, (_, i) => ({
      date: `2024-01-${String(i + 1).padStart(2, '0')}`,
      range_pt: 10 + i,
      up_exc: 5 + i,
      down_exc: 8 + i,
    }));
    // Only 3 regime-matched rows — below MIN_REGIME_COHORT (8)
    const regimeRows = Array.from({ length: 3 }, (_, i) => ({
      date: `2024-02-${String(i + 1).padStart(2, '0')}`,
      range_pt: 100,
      up_exc: 50,
      down_exc: 50,
    }));
    mockSql
      .mockResolvedValueOnce(unstratRows)
      .mockResolvedValueOnce(regimeRows);

    const out = await getRangeForecast('2026-04-19', 'summary', 'crisis');
    if (!out) throw new Error('unreachable');
    expect(out.regimeMatched).toBeNull();
    expect(out.strikes.source).toBe('unstratified');
  });

  it('applies the temporal leakage guard via SQL WHERE clause', async () => {
    mockEmbedding();
    mockSql.mockResolvedValueOnce([
      { date: '2024-01-01', range_pt: 20, up_exc: 10, down_exc: 12 },
    ]);
    await getRangeForecast('2026-04-19', 'morning summary');
    // Validate that Neon was called with templated SQL containing both
    // the date guard and the NULL filters. The tagged-template call
    // passes strings + params to the mock; inspect the strings.
    expect(mockSql).toHaveBeenCalledTimes(1);
    const call = mockSql.mock.calls[0];
    if (!call) throw new Error('expected mockSql call');
    const strings: readonly string[] = call[0] as readonly string[];
    const joined = strings.join('');
    expect(joined).toContain('date <');
    expect(joined).toContain('range_pt IS NOT NULL');
    expect(joined).toContain('up_exc IS NOT NULL');
    expect(joined).toContain('down_exc IS NOT NULL');
    expect(joined).toContain('ORDER BY embedding <=>');
  });

  it('formatRangeForecast returns null for null input (fail-open)', () => {
    expect(formatRangeForecast(null)).toBeNull();
  });

  it('formatRangeForecast emits a multi-line prompt block', () => {
    const block = formatRangeForecast({
      targetDate: '2026-04-19',
      cohort: {
        n: 15,
        range: { 0.5: 20, 0.85: 35, 0.9: 40, 0.95: 48 },
        upExc: { 0.5: 10, 0.85: 18, 0.9: 22, 0.95: 28 },
        downExc: { 0.5: 11, 0.85: 22, 0.9: 26, 0.95: 32 },
      },
      regimeMatched: null,
      strikes: {
        condor30d: { up: 18, down: 22 },
        condor12d: { up: 28, down: 32 },
        source: 'unstratified',
      },
    });
    expect(block).toContain('n=15');
    expect(block).toContain('2026-04-19');
    expect(block).toContain('30Δ condor: call 18pt up / put 22pt down');
    expect(block).toContain('12Δ condor: call 28pt up / put 32pt down');
    expect(block).toContain('unstratified cohort');
  });

  it('formatRangeForecast includes the regime-matched block when present', () => {
    const block = formatRangeForecast({
      targetDate: '2026-04-19',
      cohort: {
        n: 15,
        range: { 0.5: 20, 0.85: 35, 0.9: 40, 0.95: 48 },
        upExc: { 0.5: 10, 0.85: 18, 0.9: 22, 0.95: 28 },
        downExc: { 0.5: 11, 0.85: 22, 0.9: 26, 0.95: 32 },
      },
      regimeMatched: {
        n: 12,
        vixBucket: 'elevated',
        range: { 0.5: 40, 0.85: 75, 0.9: 85, 0.95: 100 },
        upExc: { 0.5: 18, 0.85: 35, 0.9: 42, 0.95: 50 },
        downExc: { 0.5: 22, 0.85: 45, 0.9: 52, 0.95: 62 },
      },
      strikes: {
        condor30d: { up: 35, down: 45 },
        condor12d: { up: 50, down: 62 },
        source: 'regime-matched',
      },
    });
    expect(block).toContain(
      'Regime-matched cohort (n=12 same-VIX-bucket [elevated]',
    );
    expect(block).toContain('regime-matched cohort');
  });
});
