// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureMessage: vi.fn(),
    captureException: vi.fn(),
    setTag: vi.fn(),
    metrics: {
      distribution: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const { mockCronGuard } = vi.hoisted(() => ({
  mockCronGuard: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

import handler, {
  computeAuc,
  computeBrier,
  computeBuckets,
} from '../cron/audit-takeit-calibration.js';
import { Sentry } from '../_lib/sentry.js';

const GUARD = { apiKey: '', today: '2026-05-18' };

beforeEach(() => {
  vi.clearAllMocks();
  mockCronGuard.mockReturnValue(GUARD);
});

describe('computeBrier', () => {
  it('returns 0 when every prediction is perfect', () => {
    expect(
      computeBrier([
        { prob: 1, win: 1 },
        { prob: 0, win: 0 },
        { prob: 1, win: 1 },
      ]),
    ).toBe(0);
  });

  it('returns 1 when every prediction is maximally wrong', () => {
    expect(
      computeBrier([
        { prob: 1, win: 0 },
        { prob: 0, win: 1 },
      ]),
    ).toBe(1);
  });

  it('averages squared error correctly', () => {
    // (0.7-1)^2 + (0.3-0)^2 = 0.09 + 0.09 = 0.18 / 2 = 0.09
    expect(
      computeBrier([
        { prob: 0.7, win: 1 },
        { prob: 0.3, win: 0 },
      ]),
    ).toBeCloseTo(0.09, 10);
  });
});

describe('computeAuc', () => {
  it('returns 1.0 for perfect ranking', () => {
    expect(
      computeAuc([
        { prob: 0.9, win: 1 },
        { prob: 0.8, win: 1 },
        { prob: 0.2, win: 0 },
        { prob: 0.1, win: 0 },
      ]),
    ).toBe(1);
  });

  it('returns 0.0 for completely inverted ranking', () => {
    expect(
      computeAuc([
        { prob: 0.1, win: 1 },
        { prob: 0.2, win: 1 },
        { prob: 0.8, win: 0 },
        { prob: 0.9, win: 0 },
      ]),
    ).toBe(0);
  });

  it('returns 0.5 when all probs are tied (chance-level)', () => {
    expect(
      computeAuc([
        { prob: 0.5, win: 1 },
        { prob: 0.5, win: 1 },
        { prob: 0.5, win: 0 },
        { prob: 0.5, win: 0 },
      ]),
    ).toBe(0.5);
  });

  it('returns null when one class is empty', () => {
    expect(
      computeAuc([
        { prob: 0.9, win: 1 },
        { prob: 0.8, win: 1 },
      ]),
    ).toBeNull();
  });
});

describe('computeBuckets', () => {
  it('lays out 10 deciles regardless of input distribution', () => {
    const buckets = computeBuckets([{ prob: 0.5, win: 1 }]);
    expect(buckets).toHaveLength(10);
    expect(buckets[0]!.bucket_lo).toBe(0);
    expect(buckets[9]!.bucket_hi).toBeCloseTo(1, 10);
  });

  it('reports zero residual when calibration is perfect', () => {
    // 100 rows in the 0.5-0.6 decile, exactly 50% win => residual_abs = 0.05 (pred mean 0.55, observed 0.5).
    const rows = [];
    for (let i = 0; i < 50; i++) rows.push({ prob: 0.55, win: 1 as const });
    for (let i = 0; i < 50; i++) rows.push({ prob: 0.55, win: 0 as const });
    const buckets = computeBuckets(rows);
    const target = buckets.find((b) => b.n > 0)!;
    expect(target.n).toBe(100);
    expect(target.mean_pred).toBeCloseTo(0.55, 10);
    expect(target.observed_rate).toBeCloseTo(0.5, 10);
    expect(target.residual_abs).toBeCloseTo(0.05, 10);
  });

  it('includes the upper boundary in the last bucket', () => {
    const buckets = computeBuckets([{ prob: 1.0, win: 1 }]);
    expect(buckets[9]!.n).toBe(1);
  });

  it('emits NaN-shaped rows for empty buckets so chart x-axis remains stable', () => {
    const buckets = computeBuckets([{ prob: 0.05, win: 0 }]);
    expect(buckets[0]!.n).toBe(1);
    expect(buckets[5]!.n).toBe(0);
    expect(Number.isNaN(buckets[5]!.mean_pred)).toBe(true);
    expect(Number.isNaN(buckets[5]!.observed_rate)).toBe(true);
  });
});

describe('audit-takeit-calibration cron', () => {
  it('returns success with null metrics when both alert types have zero rows', async () => {
    // Both SELECTs return [].
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      lottery: { n: 0, brier: null, auc: null, brier_ok: true },
      silentboom: { n: 0, brier: null, auc: null, brier_ok: true },
    });
    expect(Sentry.metrics.distribution).not.toHaveBeenCalled();
  });

  it('emits Brier + AUC distributions for both alert types when rows exist', async () => {
    // Lottery: perfectly calibrated 4-row set.
    mockSql
      .mockResolvedValueOnce([
        { prob: 0.9, win: 1 },
        { prob: 0.8, win: 1 },
        { prob: 0.2, win: 0 },
        { prob: 0.1, win: 0 },
      ])
      // SilentBoom: 4-row set as well.
      .mockResolvedValueOnce([
        { prob: 0.85, win: 1 },
        { prob: 0.75, win: 1 },
        { prob: 0.25, win: 0 },
        { prob: 0.15, win: 0 },
      ]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 8,
      lottery: { n: 4, brier_ok: true, auc: 1 },
      silentboom: { n: 4, brier_ok: true, auc: 1 },
    });
    // Two Brier distributions (one per alert type)
    const distCalls = vi
      .mocked(Sentry.metrics.distribution)
      .mock.calls.map((c) => c[0]);
    expect(distCalls).toContain('takeit.brier');
    expect(distCalls).toContain('takeit.auc');
  });

  it('captureMessage + brier_breach count fire when brier exceeds threshold', async () => {
    // 4 maximally-wrong predictions on lottery; empty on silentboom.
    mockSql
      .mockResolvedValueOnce([
        { prob: 1, win: 0 },
        { prob: 1, win: 0 },
        { prob: 0, win: 1 },
        { prob: 0, win: 1 },
      ])
      .mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      lottery: { brier_ok: false, brier: 1 },
    });
    expect(Sentry.metrics.count).toHaveBeenCalledWith(
      'takeit.brier_breach',
      1,
      expect.objectContaining({
        attributes: expect.objectContaining({ alert_type: 'lottery' }),
      }),
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'takeit.brier above threshold',
      expect.objectContaining({ level: 'warning' }),
    );
  });
});
