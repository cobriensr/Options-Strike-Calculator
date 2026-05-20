// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureMessage: vi.fn(),
    captureException: vi.fn(),
    setTag: vi.fn(),
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

import handler from '../cron/takeit-fill-shap.js';
import { Sentry } from '../_lib/sentry.js';

const GUARD = { apiKey: '', today: '2026-05-16' };

beforeEach(() => {
  vi.clearAllMocks();
  mockCronGuard.mockReturnValue(GUARD);
  // Clear sidecar env for each test; opt-in via per-test setEnv.
  delete process.env.SIDECAR_TAKEIT_URL;
  delete process.env.SIDECAR_TAKEIT_SECRET;
});

describe('takeit-fill-shap cron', () => {
  it('returns disabled when SIDECAR_TAKEIT_URL is not set', async () => {
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
      lottery: expect.objectContaining({ reason: 'sidecar_disabled' }),
      silentboom: expect.objectContaining({ reason: 'sidecar_disabled' }),
    });
    // No DB calls at all when disabled — the guard short-circuits per
    // alert type.
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('POSTs to the sidecar and UPDATEs rows when results return', async () => {
    process.env.SIDECAR_TAKEIT_URL = 'http://sidecar.test:8123';
    process.env.SIDECAR_TAKEIT_SECRET = 'shh';

    // Lottery: 1 row needing flags, with the bundle-shaped features dict
    // persisted by the detect cron at fire time. SilentBoom: empty.
    mockSql
      .mockResolvedValueOnce([
        {
          id: 42,
          takeit_features: {
            session_phase: 2,
            is_itm_at_fire: 0,
            ticker_bucket_SPY: 1,
            option_type_C: 1,
          },
        },
      ]) // SELECT lottery
      .mockResolvedValueOnce([{}]) // UPDATE lottery
      .mockResolvedValueOnce([]); // SELECT silentboom (empty)

    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            {
              alert_id: 42,
              top_positive: [
                { name: 'session_phase', shap_value: 0.3, feature_value: 1 },
              ],
              top_negative: [
                { name: 'is_itm_at_fire', shap_value: -0.2, feature_value: 1 },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      lottery: { scanned: 1, updated: 1, failed: 0 },
      silentboom: { scanned: 0, updated: 0, failed: 0 },
    });
    // fetch call shape — verify the body forwards the persisted features
    // dict unchanged, not the raw SQL row.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://sidecar.test:8123/takeit/explain');
    expect((opts as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer shh',
    });
    const body = JSON.parse(((opts as RequestInit).body as string) ?? '{}');
    expect(body).toMatchObject({
      alert_type: 'lottery',
      rows: [
        {
          alert_id: 42,
          features: {
            session_phase: 2,
            is_itm_at_fire: 0,
            ticker_bucket_SPY: 1,
            option_type_C: 1,
          },
        },
      ],
    });
    fetchSpy.mockRestore();
  });

  it('returns sidecar_unreachable + Sentry warn on fetch failure', async () => {
    process.env.SIDECAR_TAKEIT_URL = 'http://sidecar.test:8123';
    process.env.SIDECAR_TAKEIT_SECRET = 'shh';
    mockSql
      .mockResolvedValueOnce([{ id: 1, takeit_features: { session_phase: 2 } }])
      .mockResolvedValueOnce([]);
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      lottery: { reason: 'sidecar_unreachable', updated: 0, failed: 1 },
    });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'takeit.shap_fill.sidecar_unreachable',
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('returns sidecar_5xx + Sentry warn on server-side error', async () => {
    process.env.SIDECAR_TAKEIT_URL = 'http://sidecar.test:8123';
    process.env.SIDECAR_TAKEIT_SECRET = 'shh';
    mockSql
      .mockResolvedValueOnce([{ id: 1, takeit_features: { session_phase: 2 } }])
      .mockResolvedValueOnce([]);
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('boom', { status: 503 }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      lottery: { reason: 'sidecar_503' },
    });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'takeit.shap_fill.sidecar_non_2xx',
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('returns sidecar_4xx + Sentry ERROR (not warning) when sidecar rejects auth', async () => {
    // 4xx is a config/auth bug — should page as `error`, not the transient
    // `warning` we use for 5xx. Regression guard for the level-by-status
    // branch in takeit-fill-shap.ts.
    process.env.SIDECAR_TAKEIT_URL = 'http://sidecar.test:8123';
    process.env.SIDECAR_TAKEIT_SECRET = 'shh';
    mockSql
      .mockResolvedValueOnce([{ id: 1, takeit_features: { session_phase: 2 } }])
      .mockResolvedValueOnce([]);
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('unauthorized', { status: 401 }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      lottery: { reason: 'sidecar_401' },
    });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'takeit.shap_fill.sidecar_non_2xx',
      expect.objectContaining({ level: 'error' }),
    );
  });
});
