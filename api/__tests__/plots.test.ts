// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ─────────────────────────────────────────────────────
const mockDbFn = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockDbFn),
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

import handler from '../ml/plots.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

// ── Helpers ───────────────────────────────────────────────────
function makePlotRow(overrides: Record<string, unknown> = {}) {
  return {
    plot_name: 'correlations',
    blob_url:
      'https://blob.vercel-storage.com/ml-plots/latest/correlations.png',
    analysis: {
      what_it_means: 'Strong correlation between VIX and range',
      how_to_apply: 'Use VIX as primary indicator',
      watch_out_for: 'Correlation breaks down in low vol',
    },
    model: 'claude-sonnet-4-6',
    pipeline_date: new Date('2026-04-03T00:00:00Z'),
    updated_at: new Date('2026-04-03T08:00:00Z'),
    ...overrides,
  };
}

function makeFindingsRow(
  findings: Record<string, unknown> = { eda: { key: 'value' } },
) {
  return { findings };
}

// ── Tests ─────────────────────────────────────────────────────
describe('GET /api/ml/plots', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockDbFn.mockReset();
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

  it('returns plots and findings on success', async () => {
    const plotRow = makePlotRow();
    const findingsRow = makeFindingsRow({ eda: { correlations: 0.85 } });

    // Promise.all fires two parallel queries — both use the same tagged template
    mockDbFn.mockResolvedValueOnce([plotRow]); // plot analyses
    mockDbFn.mockResolvedValueOnce([findingsRow]); // findings

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as {
      plots: Array<{
        name: string;
        imageUrl: string;
        analysis: Record<string, string> | null;
        model: string;
        pipelineDate: string;
        updatedAt: string;
      }>;
      findings: Record<string, unknown> | null;
      pipelineDate: string | null;
    };

    expect(json.plots).toHaveLength(1);
    expect(json.plots[0]!.name).toBe('correlations');
    expect(json.plots[0]!.imageUrl).toBe(
      '/api/ml/plot-image?name=correlations',
    );
    expect(json.plots[0]!.analysis).toEqual(plotRow.analysis);
    expect(json.plots[0]!.model).toBe('claude-sonnet-4-6');
    expect(json.plots[0]!.pipelineDate).toBe('2026-04-03');
    expect(json.plots[0]!.updatedAt).toBe('2026-04-03T08:00:00.000Z');
    expect(json.findings).toEqual({ eda: { correlations: 0.85 } });
    expect(json.pipelineDate).toBe('2026-04-03');
  });

  it('returns null findings when no findings rows exist', async () => {
    mockDbFn.mockResolvedValueOnce([makePlotRow()]);
    mockDbFn.mockResolvedValueOnce([]); // no findings

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as { findings: unknown; pipelineDate: string };
    expect(json.findings).toBeNull();
  });

  it('returns null pipelineDate when no plots exist', async () => {
    mockDbFn.mockResolvedValueOnce([]); // no plots
    mockDbFn.mockResolvedValueOnce([makeFindingsRow()]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as {
      plots: unknown[];
      pipelineDate: string | null;
    };
    expect(json.plots).toHaveLength(0);
    expect(json.pipelineDate).toBeNull();
  });

  it('handles string pipeline_date (not Date object)', async () => {
    const plotRow = makePlotRow({
      pipeline_date: '2026-04-02',
      updated_at: '2026-04-02T12:00:00Z',
    });
    mockDbFn.mockResolvedValueOnce([plotRow]);
    mockDbFn.mockResolvedValueOnce([makeFindingsRow()]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as {
      plots: Array<{ pipelineDate: string; updatedAt: string }>;
      pipelineDate: string;
    };
    expect(json.plots[0]!.pipelineDate).toBe('2026-04-02');
    expect(json.plots[0]!.updatedAt).toBe('2026-04-02T12:00:00Z');
    expect(json.pipelineDate).toBe('2026-04-02');
  });

  it('handles null analysis in plot row', async () => {
    const plotRow = makePlotRow({ analysis: null });
    mockDbFn.mockResolvedValueOnce([plotRow]);
    mockDbFn.mockResolvedValueOnce([makeFindingsRow()]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as {
      plots: Array<{ analysis: unknown }>;
    };
    expect(json.plots[0]!.analysis).toBeNull();
  });

  it('sets cache-control headers', async () => {
    mockDbFn.mockResolvedValueOnce([]);
    mockDbFn.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._headers['Cache-Control']).toBe(
      'public, s-maxage=3600, stale-while-revalidate=86400',
    );
  });

  it('returns 500 when DB query throws', async () => {
    mockDbFn.mockRejectedValueOnce(new Error('connection refused'));

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Failed to fetch plot data' });
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(
      expect.any(Error),
    );
  });

  it('encodes special characters in plot name for imageUrl', async () => {
    const plotRow = makePlotRow({ plot_name: 'feature_importance_comparison' });
    mockDbFn.mockResolvedValueOnce([plotRow]);
    mockDbFn.mockResolvedValueOnce([makeFindingsRow()]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as {
      plots: Array<{ imageUrl: string }>;
    };
    expect(json.plots[0]!.imageUrl).toBe(
      '/api/ml/plot-image?name=feature_importance_comparison',
    );
  });

  it('returns multiple plots in order', async () => {
    const rows = [
      makePlotRow({ plot_name: 'clusters_pca' }),
      makePlotRow({ plot_name: 'correlations' }),
      makePlotRow({ plot_name: 'timeline' }),
    ];
    mockDbFn.mockResolvedValueOnce(rows);
    mockDbFn.mockResolvedValueOnce([makeFindingsRow()]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as {
      plots: Array<{ name: string }>;
    };
    expect(json.plots).toHaveLength(3);
    expect(json.plots.map((p) => p.name)).toEqual([
      'clusters_pca',
      'correlations',
      'timeline',
    ]);
  });
});
