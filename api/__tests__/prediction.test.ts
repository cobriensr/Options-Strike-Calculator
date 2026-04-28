// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ─────────────────────────────────────────────────────
const mockDbFn = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockDbFn),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: {
    request: vi.fn(() => vi.fn()),
  },
}));

import handler from '../ml/prediction.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

// ── Helpers ───────────────────────────────────────────────────
function makePredictionRow(overrides: Record<string, unknown> = {}) {
  return {
    date: new Date('2026-03-29T00:00:00Z'),
    ccs_prob: '0.35',
    pcs_prob: '0.25',
    ic_prob: '0.30',
    sit_out_prob: '0.10',
    predicted_class: 'ccs',
    model_version: 'v2.1.0',
    feature_count: 42,
    top_features: ['vix_level', 'put_call_ratio', 'gex_flip'],
    created_at: '2026-03-29T08:00:00Z',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────
describe('GET /api/ml/prediction', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    mockDbFn.mockReset();
  });

  it('returns prediction for a valid date parameter', async () => {
    mockDbFn.mockResolvedValueOnce([makePredictionRow()]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-03-29' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as {
      prediction: {
        date: string;
        probabilities: {
          ccs: number;
          pcs: number;
          ic: number;
          sit_out: number;
        };
        predicted_class: string;
        model_version: string;
        feature_count: number;
        top_features: string[];
        created_at: string;
      };
    };
    expect(json.prediction).not.toBeNull();
    expect(json.prediction.date).toBe('2026-03-29');
    expect(json.prediction.probabilities).toEqual({
      ccs: 0.35,
      pcs: 0.25,
      ic: 0.3,
      sit_out: 0.1,
    });
    expect(json.prediction.predicted_class).toBe('ccs');
    expect(json.prediction.model_version).toBe('v2.1.0');
    expect(json.prediction.feature_count).toBe(42);
    expect(json.prediction.top_features).toEqual([
      'vix_level',
      'put_call_ratio',
      'gex_flip',
    ]);
    expect(json.prediction.created_at).toBe('2026-03-29T08:00:00Z');
  });

  it('returns most recent prediction when no date provided', async () => {
    mockDbFn.mockResolvedValueOnce([makePredictionRow()]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as { prediction: { date: string } };
    expect(json.prediction).not.toBeNull();
    expect(json.prediction.date).toBe('2026-03-29');
  });

  it('returns 400 for invalid date format', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: 'March 29' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'date must be YYYY-MM-DD' });
    // DB should not be called
    expect(mockDbFn).not.toHaveBeenCalled();
  });

  it('returns 400 for partial date format', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-3-29' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'date must be YYYY-MM-DD' });
  });

  it('returns 405 for non-GET methods', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 405 for PUT method', async () => {
    const req = mockRequest({ method: 'PUT' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 401 when not owner (via guard)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(mockDbFn).not.toHaveBeenCalled();
  });

  it('returns 403 when bot detected (via guard)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(403).json({ error: 'Access denied' });
        return true;
      },
    );

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
    expect(mockDbFn).not.toHaveBeenCalled();
  });

  it('returns 200 with null prediction when no rows found', async () => {
    mockDbFn.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      prediction: null,
      message: 'No predictions available yet. Model training in progress.',
    });
  });

  it('returns 200 with null prediction when rows is undefined', async () => {
    mockDbFn.mockResolvedValueOnce(undefined);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      prediction: null,
      message: 'No predictions available yet. Model training in progress.',
    });
  });

  it('returns 500 when DB query throws', async () => {
    mockDbFn.mockRejectedValueOnce(new Error('connection refused'));

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Failed to fetch prediction' });
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(
      expect.any(Error),
    );
  });

  it('converts string probability values to numbers', async () => {
    mockDbFn.mockResolvedValueOnce([
      makePredictionRow({
        ccs_prob: '0.4123',
        pcs_prob: '0.2567',
        ic_prob: '0.1890',
        sit_out_prob: '0.1420',
      }),
    ]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as {
      prediction: {
        probabilities: {
          ccs: number;
          pcs: number;
          ic: number;
          sit_out: number;
        };
      };
    };
    expect(json.prediction.probabilities.ccs).toBe(0.4123);
    expect(json.prediction.probabilities.pcs).toBe(0.2567);
    expect(json.prediction.probabilities.ic).toBe(0.189);
    expect(json.prediction.probabilities.sit_out).toBe(0.142);
    // Verify they are actual numbers, not strings
    expect(typeof json.prediction.probabilities.ccs).toBe('number');
    expect(typeof json.prediction.probabilities.pcs).toBe('number');
  });

  it('formats Date object to YYYY-MM-DD string', async () => {
    mockDbFn.mockResolvedValueOnce([
      makePredictionRow({
        date: new Date('2026-01-15T00:00:00Z'),
      }),
    ]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as { prediction: { date: string } };
    expect(json.prediction.date).toBe('2026-01-15');
  });

  it('passes through date as-is when it is a string', async () => {
    mockDbFn.mockResolvedValueOnce([makePredictionRow({ date: '2026-02-20' })]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as { prediction: { date: string } };
    expect(json.prediction.date).toBe('2026-02-20');
  });

  it('handles numeric probability values already as numbers', async () => {
    mockDbFn.mockResolvedValueOnce([
      makePredictionRow({
        ccs_prob: 0.5,
        pcs_prob: 0.2,
        ic_prob: 0.2,
        sit_out_prob: 0.1,
      }),
    ]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as {
      prediction: {
        probabilities: {
          ccs: number;
          pcs: number;
          ic: number;
          sit_out: number;
        };
      };
    };
    expect(json.prediction.probabilities).toEqual({
      ccs: 0.5,
      pcs: 0.2,
      ic: 0.2,
      sit_out: 0.1,
    });
  });
});
