// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  applyResidualCorrection,
  listCalibrationRows,
  ttcBucketFor,
  _resetCalibrationCache,
  MIN_SAMPLES_FOR_CALIBRATION,
} from '../_lib/trace-live-residuals.js';

describe('ttcBucketFor', () => {
  it('returns 0-15min for last quarter hour', () => {
    expect(ttcBucketFor(0)).toBe('0-15min');
    expect(ttcBucketFor(8)).toBe('0-15min');
    expect(ttcBucketFor(15)).toBe('0-15min');
  });
  it('returns 15-60min for late session', () => {
    expect(ttcBucketFor(16)).toBe('15-60min');
    expect(ttcBucketFor(45)).toBe('15-60min');
    expect(ttcBucketFor(60)).toBe('15-60min');
  });
  it('returns 60-180min for mid session', () => {
    expect(ttcBucketFor(61)).toBe('60-180min');
    expect(ttcBucketFor(120)).toBe('60-180min');
    expect(ttcBucketFor(180)).toBe('60-180min');
  });
  it('returns >180min for early session', () => {
    expect(ttcBucketFor(181)).toBe('>180min');
    expect(ttcBucketFor(390)).toBe('>180min');
  });
});

describe('applyResidualCorrection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    _resetCalibrationCache();
  });

  it('returns null when calibration table is empty', async () => {
    mockSql.mockResolvedValueOnce([]);
    const out = await applyResidualCorrection({
      regime: 'trending_negative_gamma',
      predictedClose: 7125,
      minutesToClose: 8,
    });
    expect(out).toBeNull();
  });

  it('returns null when no row matches the (regime, ttc_bucket) key', async () => {
    mockSql.mockResolvedValueOnce([
      {
        regime: 'range_bound_positive_gamma',
        ttc_bucket: '0-15min',
        n: 30,
        residual_median: 0.5,
        residual_mean: 0.4,
        residual_p25: -2,
        residual_p75: 3,
        updated_at: '2026-04-30T02:00:00Z',
      },
    ]);
    const out = await applyResidualCorrection({
      regime: 'trending_negative_gamma',
      predictedClose: 7125,
      minutesToClose: 8,
    });
    expect(out).toBeNull();
  });

  it('returns null when n is below MIN_SAMPLES_FOR_CALIBRATION', async () => {
    mockSql.mockResolvedValueOnce([
      {
        regime: 'trending_negative_gamma',
        ttc_bucket: '0-15min',
        n: MIN_SAMPLES_FOR_CALIBRATION - 1,
        residual_median: 12.5,
        residual_mean: 11,
        residual_p25: 5,
        residual_p75: 20,
        updated_at: '2026-04-30T02:00:00Z',
      },
    ]);
    const out = await applyResidualCorrection({
      regime: 'trending_negative_gamma',
      predictedClose: 7125,
      minutesToClose: 8,
    });
    expect(out).toBeNull();
  });

  it('applies the residual_median correction when n is sufficient', async () => {
    mockSql.mockResolvedValueOnce([
      {
        regime: 'trending_negative_gamma',
        ttc_bucket: '0-15min',
        n: 32,
        residual_median: 12.5,
        residual_mean: 11.2,
        residual_p25: 5,
        residual_p75: 20,
        updated_at: '2026-04-30T02:00:00Z',
      },
    ]);
    const out = await applyResidualCorrection({
      regime: 'trending_negative_gamma',
      predictedClose: 7125,
      minutesToClose: 8,
    });
    expect(out).not.toBeNull();
    expect(out?.calibratedClose).toBe(7137.5);
    expect(out?.residualMedian).toBe(12.5);
    expect(out?.n).toBe(32);
    expect(out?.ttcBucket).toBe('0-15min');
  });

  it('caches the table read across multiple calls', async () => {
    mockSql.mockResolvedValueOnce([
      {
        regime: 'trending_negative_gamma',
        ttc_bucket: '0-15min',
        n: 32,
        residual_median: 12.5,
        residual_mean: 11.2,
        residual_p25: 5,
        residual_p75: 20,
        updated_at: '2026-04-30T02:00:00Z',
      },
    ]);
    await applyResidualCorrection({
      regime: 'trending_negative_gamma',
      predictedClose: 7125,
      minutesToClose: 8,
    });
    await applyResidualCorrection({
      regime: 'trending_negative_gamma',
      predictedClose: 7130,
      minutesToClose: 10,
    });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('returns null gracefully when the DB query throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('pg down'));
    const out = await applyResidualCorrection({
      regime: 'trending_negative_gamma',
      predictedClose: 7125,
      minutesToClose: 8,
    });
    expect(out).toBeNull();
  });

  it('returns null when residual_median is null even with sufficient n', async () => {
    mockSql.mockResolvedValueOnce([
      {
        regime: 'trending_negative_gamma',
        ttc_bucket: '0-15min',
        n: 30,
        residual_median: null, // computation failed for this bucket
        residual_mean: 12.0,
        residual_p25: 5,
        residual_p75: 20,
        updated_at: '2026-04-30T02:00:00Z',
      },
    ]);
    const out = await applyResidualCorrection({
      regime: 'trending_negative_gamma',
      predictedClose: 7125,
      minutesToClose: 8,
    });
    expect(out).toBeNull();
  });
});

describe('listCalibrationRows', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    _resetCalibrationCache();
  });

  it('returns all rows from the calibration table', async () => {
    mockSql.mockResolvedValueOnce([
      {
        regime: 'trending_negative_gamma',
        ttc_bucket: '0-15min',
        n: 32,
        residual_median: 12.5,
        residual_mean: 11.2,
        residual_p25: 5,
        residual_p75: 20,
        updated_at: '2026-04-30T02:00:00Z',
      },
      {
        regime: 'range_bound_positive_gamma',
        ttc_bucket: '15-60min',
        n: 18,
        residual_median: -1.2,
        residual_mean: -0.8,
        residual_p25: -3,
        residual_p75: 2,
        updated_at: '2026-04-30T02:00:00Z',
      },
    ]);
    const rows = await listCalibrationRows();
    expect(rows).toHaveLength(2);
  });
});
