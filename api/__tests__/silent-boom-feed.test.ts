// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  setCacheHeaders: vi.fn(),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import handler from '../silent-boom-feed.js';

interface AlertFixture {
  id: number;
  date: string;
  bucket_ct: string;
  option_chain_id: string;
  underlying_symbol: string;
  option_type: 'C' | 'P';
  strike: string;
  expiry: string;
  dte: number;
  spike_volume: number;
  baseline_volume: string;
  spike_ratio: string;
  ask_pct: string;
  vol_oi: string;
  entry_price: string;
  open_interest: number;
  peak_ceiling_pct: string | null;
  minutes_to_peak: string | null;
  realized_30m_pct: string | null;
  realized_60m_pct: string | null;
  realized_120m_pct: string | null;
  realized_eod_pct: string | null;
  enriched_at: string | null;
  score: number | null;
  score_tier: 'tier1' | 'tier2' | 'tier3' | null;
  mkt_tide_diff: string | null;
  inserted_at: string;
}

function makeAlert(overrides: Partial<AlertFixture> = {}): AlertFixture {
  return {
    id: 1,
    date: '2026-05-07',
    bucket_ct: '2026-05-07T13:30:00Z',
    option_chain_id: 'SNDK260507C01175000',
    underlying_symbol: 'SNDK',
    option_type: 'C',
    strike: '1175',
    expiry: '2026-05-07',
    dte: 0,
    spike_volume: 2000,
    baseline_volume: '100',
    spike_ratio: '20',
    ask_pct: '0.95',
    vol_oi: '0.4',
    entry_price: '0.5',
    open_interest: 5000,
    peak_ceiling_pct: '120',
    minutes_to_peak: '15',
    realized_30m_pct: '60',
    realized_60m_pct: '40',
    realized_120m_pct: '20',
    realized_eod_pct: '5',
    enriched_at: '2026-05-07T16:00:00Z',
    score: 24,
    score_tier: 'tier1',
    mkt_tide_diff: '5000',
    inserted_at: '2026-05-07T13:30:30Z',
    ...overrides,
  };
}

describe('silent-boom-feed handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns alerts with the new score + scoreTier + mktTideDiff fields', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }]) // count
      .mockResolvedValueOnce([makeAlert()]); // list

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      alerts: {
        score: number | null;
        scoreTier: string | null;
        mktTideDiff: number | null;
      }[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.alerts[0]).toMatchObject({
      score: 24,
      scoreTier: 'tier1',
      mktTideDiff: 5000,
    });
  });

  it('returns null mktTideDiff for rows lacking a market_tide tick', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert({ mkt_tide_diff: null })]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      alerts: { mktTideDiff: number | null }[];
    };
    expect(body.alerts[0]?.mktTideDiff).toBeNull();
  });

  it('binds minScore into BOTH the count AND the list query (regression)', async () => {
    // Regression for the bug where the COUNT had the minScore clause
    // but the list queries didn't — symptom was tier3 rows leaking
    // into the rendered list while `total` reflected the filtered count.
    mockSql
      .mockResolvedValueOnce([{ n: 1 }]) // count
      .mockResolvedValueOnce([makeAlert({ score: 25 })]); // list

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', minScore: '21' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(2);

    // Tagged-template helper passes the raw template strings array as
    // the first argument. We check both calls (count + list) include
    // the minScore filter literal so a regression that only filters
    // the count fails this test.
    for (const call of mockSql.mock.calls) {
      const strings = call[0] as TemplateStringsArray | undefined;
      const sqlText = (strings ?? []).join(' ');
      expect(sqlText).toContain('score >=');
    }
  });

  it('returns total=0 with no list call when count is zero — wait, actually still calls list', async () => {
    // The handler doesn't short-circuit on total=0; it still issues
    // the list query (which will return []). This is intentional —
    // the count and list both go through the same WHERE clause and
    // the small extra query keeps the code straightforward.
    mockSql
      .mockResolvedValueOnce([{ n: 0 }]) // count
      .mockResolvedValueOnce([]); // list

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { total: number; alerts: unknown[] };
    expect(body.total).toBe(0);
    expect(body.alerts).toEqual([]);
  });

  it('rejects invalid query params with 400', async () => {
    mockSql.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([]);
    const req = mockRequest({
      method: 'GET',
      query: { date: 'not-a-date' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'Invalid query' });
    // Validation fails before any DB call.
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('binds tod into BOTH the count AND the list query', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert()]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', tod: 'AM_open' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(2);
    for (const call of mockSql.mock.calls) {
      const strings = call[0] as TemplateStringsArray | undefined;
      const sqlText = (strings ?? []).join(' ');
      // Both queries must extract CT minute-of-day and gate it.
      expect(sqlText).toContain("AT TIME ZONE 'America/Chicago'");
    }

    const body = res._json as { filters: { tod: string | null } };
    expect(body.filters.tod).toBe('AM_open');
  });

  it('binds dte into the SQL when supplied', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert()]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', dte: '0' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    for (const call of mockSql.mock.calls) {
      const strings = call[0] as TemplateStringsArray | undefined;
      const sqlText = (strings ?? []).join(' ');
      expect(sqlText).toContain('dte BETWEEN');
    }
    const body = res._json as { filters: { dte: string | null } };
    expect(body.filters.dte).toBe('0');
  });

  it('binds burst into the SQL when supplied', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert()]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', burst: 'grey' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // The burst filter compiles to spike_ratio range bounds — check
    // BOTH count AND list query carry the gate so a regression that
    // only filters the count fails this test.
    for (const call of mockSql.mock.calls) {
      const strings = call[0] as TemplateStringsArray | undefined;
      const sqlText = (strings ?? []).join(' ');
      expect(sqlText).toContain('spike_ratio >=');
      expect(sqlText).toContain('spike_ratio <');
    }
    const body = res._json as { filters: { burst: string | null } };
    expect(body.filters.burst).toBe('grey');
  });

  it('rejects an invalid dte value with 400', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', dte: '7' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects an invalid burst value with 400', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', burst: 'green' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects an invalid tod value with 400', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', tod: 'OVERNIGHT' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('echoes minScore in the filters block of the response', async () => {
    mockSql.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', minScore: '8' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: { minScore: number | null } };
    expect(body.filters.minScore).toBe(8);
  });

  it('omits minScore (null) from filters when not supplied', async () => {
    mockSql.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      filters: { minScore: number | null; tod: string | null };
    };
    expect(body.filters.minScore).toBeNull();
    expect(body.filters.tod).toBeNull();
  });
});
