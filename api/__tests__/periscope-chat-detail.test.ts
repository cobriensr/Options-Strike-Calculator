// @vitest-environment node

/**
 * Tests for the new playbook fields added to /api/periscope-chat-detail.
 *
 * The legacy detail tests (405/400/404, image-url proxy rewrite, basic
 * row shape) live in periscope-chat-meta.test.ts. This file covers the
 * round-trip of the structured playbook fields — particularly
 * `futures_plan`, which is the field this commit adds to the detail
 * endpoint's projection. The tests assert each field surfaces with the
 * correct value AND that the response shape is preserved when fields
 * are null (legacy rows).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
  setCacheHeaders: vi.fn(),
  respondIfInvalid: vi
    .fn()
    .mockImplementation(
      (
        parsed: { success: boolean; error?: { issues: { message: string }[] } },
        res: { status: (n: number) => { json: (o: unknown) => void } },
      ) => {
        if (!parsed.success) {
          const msg =
            parsed.error?.issues[0]?.message ?? 'Invalid request body';
          res.status(400).json({ error: msg });
          return true;
        }
        return false;
      },
    ),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: {
    request: vi.fn(() => vi.fn()),
    increment: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import detailHandler from '../periscope-chat-detail.js';

beforeEach(() => {
  mockSql.mockReset();
});

describe('GET /api/periscope-chat-detail — playbook fields', () => {
  const playbookRow = {
    id: '42',
    trading_date: '2026-04-30',
    captured_at: '2026-04-30T13:30:00Z',
    read_time: '2026-04-30T13:30:00Z',
    spot_at_read_time: '7120',
    spot_source: 'db_exact',
    mode: 'intraday',
    parent_id: null,
    user_context: null,
    prose_text: 'Pin day at 7120.',
    spot: '7120',
    cone_lower: '7095',
    cone_upper: '7150',
    long_trigger: '7125',
    short_trigger: '7115',
    regime_tag: 'pin',
    bias: 'fade-only',
    trade_types_recommended: ['iron_condor', 'butterfly'],
    trade_types_avoided: ['naked_directional_long'],
    key_levels: {
      gamma_floor: 7100,
      gamma_ceiling: 7150,
      magnet: 7120,
      charm_zero: 7130,
    },
    expected_dealer_behavior: 'passive bid below 7100',
    confidence: 'medium',
    confidence_basis: 'twin-strike +γ floor',
    futures_plan:
      'LONG: above 7125 (NQ +γ ceiling at 7150)\n\nSHORT: below 7115 (NQ −γ floor at 7100)\n\nWAIT: 7115–7125 chop band',
    parse_ok: true,
    calibration_quality: null,
    image_urls: [],
    model: 'claude-opus-4-7',
    input_tokens: '1000',
    output_tokens: '500',
    cache_read_tokens: '800',
    cache_write_tokens: '0',
    duration_ms: '4500',
    created_at: '2026-04-30T13:30:05Z',
  };

  it('round-trips futures_plan through the response', async () => {
    mockSql.mockResolvedValueOnce([playbookRow]);
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();
    await detailHandler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as { futures_plan: string | null };
    expect(body.futures_plan).toContain('LONG: above 7125');
    expect(body.futures_plan).toContain('SHORT: below 7115');
    expect(body.futures_plan).toContain('WAIT:');
  });

  it('returns all playbook fields with the correct shape', async () => {
    mockSql.mockResolvedValueOnce([playbookRow]);
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();
    await detailHandler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as {
      bias: string | null;
      confidence: string | null;
      confidence_basis: string | null;
      trade_types_recommended: string[];
      trade_types_avoided: string[];
      key_levels: {
        gamma_floor: number | null;
        gamma_ceiling: number | null;
        magnet: number | null;
        charm_zero: number | null;
      } | null;
      expected_dealer_behavior: string | null;
      futures_plan: string | null;
    };
    expect(body.bias).toBe('fade-only');
    expect(body.confidence).toBe('medium');
    expect(body.confidence_basis).toBe('twin-strike +γ floor');
    expect(body.trade_types_recommended).toEqual(['iron_condor', 'butterfly']);
    expect(body.trade_types_avoided).toEqual(['naked_directional_long']);
    expect(body.key_levels?.gamma_floor).toBe(7100);
    expect(body.key_levels?.gamma_ceiling).toBe(7150);
    expect(body.key_levels?.magnet).toBe(7120);
    expect(body.key_levels?.charm_zero).toBe(7130);
    expect(body.expected_dealer_behavior).toBe('passive bid below 7100');
    expect(body.futures_plan).not.toBeNull();
  });

  it('returns null for futures_plan when DB column is null (legacy row)', async () => {
    mockSql.mockResolvedValueOnce([{ ...playbookRow, futures_plan: null }]);
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();
    await detailHandler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as { futures_plan: string | null };
    expect(body.futures_plan).toBeNull();
  });

  it('returns sane defaults when all playbook fields are null/empty (pre-Phase-2 row)', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...playbookRow,
        bias: null,
        trade_types_recommended: null,
        trade_types_avoided: null,
        key_levels: null,
        expected_dealer_behavior: null,
        confidence: null,
        confidence_basis: null,
        futures_plan: null,
      },
    ]);
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();
    await detailHandler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as {
      bias: string | null;
      confidence: string | null;
      trade_types_recommended: string[];
      trade_types_avoided: string[];
      key_levels: unknown;
      futures_plan: string | null;
    };
    expect(body.bias).toBeNull();
    expect(body.confidence).toBeNull();
    expect(body.trade_types_recommended).toEqual([]);
    expect(body.trade_types_avoided).toEqual([]);
    expect(body.key_levels).toBeNull();
    expect(body.futures_plan).toBeNull();
  });
});
