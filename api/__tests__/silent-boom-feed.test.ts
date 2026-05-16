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
  realized_trail30_10_pct: string | null;
  enriched_at: string | null;
  score: number | null;
  score_tier: 'tier1' | 'tier2' | 'tier3' | null;
  direction_gated: boolean;
  mkt_tide_diff: string | null;
  zero_dte_diff: string | null;
  spx_spot_gamma_oi: string | null;
  underlying_price_at_spike: string | null;
  multi_leg_share: string | null;
  round_trip_net_pct: string | null;
  round_trip_score_deduct: number | null;
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
    realized_trail30_10_pct: null,
    enriched_at: '2026-05-07T16:00:00Z',
    score: 24,
    score_tier: 'tier1',
    direction_gated: false,
    mkt_tide_diff: '5000',
    zero_dte_diff: '300',
    spx_spot_gamma_oi: '12345',
    underlying_price_at_spike: '1170.25',
    multi_leg_share: '0.05',
    round_trip_net_pct: null,
    round_trip_score_deduct: 0,
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
        avgHoldMinutes: number;
      }[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.alerts[0]).toMatchObject({
      score: 24,
      scoreTier: 'tier1',
      mktTideDiff: 5000,
      // SNDK has no override → tier1 default of 144
      avgHoldMinutes: 144,
    });
  });

  it('uses the per-ticker avg-hold-minutes override on QQQ tier1', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([
        makeAlert({ underlying_symbol: 'QQQ', score_tier: 'tier1' }),
      ]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { alerts: { avgHoldMinutes: number }[] };
    expect(body.alerts[0]?.avgHoldMinutes).toBe(89);
  });

  it('applies round-trip score deduct and re-derives tier (-3 demotes tier2 → tier3)', async () => {
    // silent-boom tiers: tier1 ≥ 21, tier2 ≥ 8, else tier3.
    // score=10 + deduct -3 → effective 7 → tier3 (was tier2).
    mockSql.mockResolvedValueOnce([{ n: 1 }]).mockResolvedValueOnce([
      makeAlert({
        score: 10,
        score_tier: 'tier2',
        round_trip_net_pct: '-0.75',
        round_trip_score_deduct: -3,
      }),
    ]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as {
      alerts: {
        score: number | null;
        rawScore: number | null;
        roundTripNetPct: number | null;
        roundTripScoreDeduct: number;
        scoreTier: string | null;
      }[];
    };
    expect(body.alerts[0]).toMatchObject({
      score: 7,
      rawScore: 10,
      roundTripNetPct: -0.75,
      roundTripScoreDeduct: -3,
      scoreTier: 'tier3',
    });
  });

  it('demotes tier1 → tier2 when -3 deduct drops score below 21', async () => {
    mockSql.mockResolvedValueOnce([{ n: 1 }]).mockResolvedValueOnce([
      makeAlert({
        score: 23,
        score_tier: 'tier1',
        round_trip_net_pct: '-0.60',
        round_trip_score_deduct: -3,
      }),
    ]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as {
      alerts: { score: number | null; scoreTier: string | null }[];
    };
    expect(body.alerts[0]).toMatchObject({ score: 20, scoreTier: 'tier2' });
  });

  it('preserves tier1 when -1 deduct keeps score >= 21', async () => {
    mockSql.mockResolvedValueOnce([{ n: 1 }]).mockResolvedValueOnce([
      makeAlert({
        score: 25,
        score_tier: 'tier1',
        round_trip_net_pct: '-0.20',
        round_trip_score_deduct: -1,
      }),
    ]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as {
      alerts: { score: number | null; scoreTier: string | null }[];
    };
    expect(body.alerts[0]).toMatchObject({ score: 24, scoreTier: 'tier1' });
  });

  it('passes through deduct=0 cleanly when no round-trip evaluation yet', async () => {
    mockSql.mockResolvedValueOnce([{ n: 1 }]).mockResolvedValueOnce([
      makeAlert({
        score: 24,
        round_trip_net_pct: null,
        round_trip_score_deduct: null,
      }),
    ]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as {
      alerts: {
        score: number | null;
        rawScore: number | null;
        roundTripScoreDeduct: number;
        roundTripNetPct: number | null;
      }[];
    };
    expect(body.alerts[0]).toMatchObject({
      score: 24,
      rawScore: 24,
      roundTripScoreDeduct: 0,
      roundTripNetPct: null,
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

  it('passes through underlying_price_at_spike as underlyingPriceAtSpike', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([
        makeAlert({ underlying_price_at_spike: '1170.25' }),
      ]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      alerts: { underlyingPriceAtSpike: number | null }[];
    };
    expect(body.alerts[0]?.underlyingPriceAtSpike).toBe(1170.25);
  });

  it('passes through multi_leg_share as multiLegShare', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert({ multi_leg_share: '0.25' })]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      alerts: { multiLegShare: number | null }[];
    };
    expect(body.alerts[0]?.multiLegShare).toBe(0.25);
  });

  it('returns null multiLegShare for pre-#146 rows missing the attribution', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert({ multi_leg_share: null })]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      alerts: { multiLegShare: number | null }[];
    };
    expect(body.alerts[0]?.multiLegShare).toBeNull();
  });

  it('returns null underlyingPriceAtSpike for pre-#152 rows missing the spot snapshot', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert({ underlying_price_at_spike: null })]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      alerts: { underlyingPriceAtSpike: number | null }[];
    };
    expect(body.alerts[0]?.underlyingPriceAtSpike).toBeNull();
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

  it('maps direction_gated + realized_trail30_10_pct into the response (Phase 4)', async () => {
    mockSql.mockResolvedValueOnce([{ n: 1 }]).mockResolvedValueOnce([
      makeAlert({
        direction_gated: true,
        realized_trail30_10_pct: '47.5',
      }),
    ]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      alerts: Array<{
        directionGated: boolean;
        outcomes: { realizedTrail3010Pct: number | null };
      }>;
    };
    expect(body.alerts[0]?.directionGated).toBe(true);
    expect(body.alerts[0]?.outcomes.realizedTrail3010Pct).toBe(47.5);
  });

  it('defaults directionGated=false and trail=null when the DB columns are unset', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert()]); // both fields use fixture defaults

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      alerts: Array<{
        directionGated: boolean;
        outcomes: { realizedTrail3010Pct: number | null };
      }>;
    };
    expect(body.alerts[0]?.directionGated).toBe(false);
    expect(body.alerts[0]?.outcomes.realizedTrail3010Pct).toBeNull();
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

  it('binds askPctBand into the SQL when supplied', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert()]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', askPctBand: '100' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // The askPctBand filter compiles to ask_pct range bounds — check
    // BOTH count AND list query carry the gate.
    for (const call of mockSql.mock.calls) {
      const strings = call[0] as TemplateStringsArray | undefined;
      const sqlText = (strings ?? []).join(' ');
      expect(sqlText).toContain('ask_pct >=');
      expect(sqlText).toContain('ask_pct <');
    }
    const body = res._json as { filters: { askPctBand: string | null } };
    expect(body.filters.askPctBand).toBe('100');
  });

  it('rejects an invalid askPctBand value with 400', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', askPctBand: '60-70' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('omits askPctBand (null) from filters when not supplied', async () => {
    mockSql.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { filters: { askPctBand: string | null } };
    expect(body.filters.askPctBand).toBeNull();
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

  // ------------------------------------------------------------------
  // Coverage-fill tests for uncovered branches.
  // ------------------------------------------------------------------

  it('returns early when the owner/guest guard rejects (172-173)', async () => {
    // The guard returns true when the response has already been sent
    // (bot or auth rejection). The handler must short-circuit and
    // never touch the DB.
    const apiHelpers = await import('../_lib/api-helpers.js');
    vi.mocked(apiHelpers.guardOwnerOrGuestEndpoint).mockResolvedValueOnce(true);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    // No DB call when guarded; handler returned before parsing.
    expect(mockSql).not.toHaveBeenCalled();
    // res._status stays at default 200 (init) because the mocked guard
    // didn't actually write to res — the contract is "guard already
    // sent the response," and we only assert the handler returned.
  });

  it('coerces Date-instance bucket_ct / inserted_at / enriched_at / date via toIso paths (137-138, 143, 160-163)', async () => {
    // Pass Date objects (mirrors what neon returns for TIMESTAMP /
    // DATE columns) instead of strings. This exercises the
    // `v instanceof Date` branches in toIso and toDateIso plus the
    // null branch in toIsoOrNull.
    const bucket = new Date('2026-05-07T13:30:00Z');
    const inserted = new Date('2026-05-07T13:30:30Z');
    const dateObj = new Date('2026-05-07T00:00:00Z');

    mockSql.mockResolvedValueOnce([{ n: 1 }]).mockResolvedValueOnce([
      {
        ...makeAlert(),
        // Override the timestamps with Date instances.
        bucket_ct: bucket as unknown as string,
        inserted_at: inserted as unknown as string,
        date: dateObj as unknown as string,
        enriched_at: null, // hits toIsoOrNull(null) → null branch
      },
    ]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      alerts: {
        bucketCt: string;
        insertedAt: string;
        date: string;
        outcomes: { enrichedAt: string | null };
      }[];
    };
    // toIso(Date) → ISO string
    expect(body.alerts[0]?.bucketCt).toBe('2026-05-07T13:30:00.000Z');
    expect(body.alerts[0]?.insertedAt).toBe('2026-05-07T13:30:30.000Z');
    // toDateIso(Date) → YYYY-MM-DD constructed from UTC components
    expect(body.alerts[0]?.date).toBe('2026-05-07');
    // toIsoOrNull(null) → null
    expect(body.alerts[0]?.outcomes.enrichedAt).toBeNull();
  });

  it('binds dte 1-3 BETWEEN range into SQL (line 209)', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert({ dte: 2 })]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', dte: '1-3' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: { dte: string | null } };
    expect(body.filters.dte).toBe('1-3');
    for (const call of mockSql.mock.calls) {
      const strings = call[0] as TemplateStringsArray | undefined;
      const sqlText = (strings ?? []).join(' ');
      expect(sqlText).toContain('dte BETWEEN');
    }
  });

  it('binds dte 4+ range into SQL', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert({ dte: 7 })]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', dte: '4+' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: { dte: string | null } };
    expect(body.filters.dte).toBe('4+');
  });

  it('binds burst red range into SQL (line 221)', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert({ spike_ratio: '60' })]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', burst: 'red' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: { burst: string | null } };
    expect(body.filters.burst).toBe('red');
  });

  it('binds burst yellow range into SQL (line 222)', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert({ spike_ratio: '30' })]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', burst: 'yellow' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: { burst: string | null } };
    expect(body.filters.burst).toBe('yellow');
  });

  it('uses spike_ratio sort branch (line 266)', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert()]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', sort: 'spike_ratio' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: { sort: string } };
    expect(body.filters.sort).toBe('spike_ratio');
    // The list query (2nd call) is the sort-specific branch — check
    // the ORDER BY clause matches.
    const listCall = mockSql.mock.calls[1];
    const sqlText = (
      (listCall?.[0] as TemplateStringsArray | undefined) ?? []
    ).join(' ');
    expect(sqlText).toContain('ORDER BY spike_ratio DESC');
  });

  it('uses vol_oi sort branch (line 289)', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert()]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', sort: 'vol_oi' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: { sort: string } };
    expect(body.filters.sort).toBe('vol_oi');
    const listCall = mockSql.mock.calls[1];
    const sqlText = (
      (listCall?.[0] as TemplateStringsArray | undefined) ?? []
    ).join(' ');
    expect(sqlText).toContain('ORDER BY vol_oi DESC');
  });

  it('uses peak sort branch (line 312)', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert()]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', sort: 'peak' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: { sort: string } };
    expect(body.filters.sort).toBe('peak');
    const listCall = mockSql.mock.calls[1];
    const sqlText = (
      (listCall?.[0] as TemplateStringsArray | undefined) ?? []
    ).join(' ');
    expect(sqlText).toContain('ORDER BY peak_ceiling_pct DESC');
  });

  it('captures DB errors via Sentry and returns 500 (422-424)', async () => {
    const dbErr = new Error('boom');
    mockSql.mockRejectedValueOnce(dbErr);

    const sentryMod = await import('../_lib/sentry.js');
    const loggerMod = await import('../_lib/logger.js');

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(sentryMod.Sentry.captureException).toHaveBeenCalledWith(dbErr);
    expect(loggerMod.default.error).toHaveBeenCalled();
  });

  it('defaults date to today (getETDateStr) when no date query param', async () => {
    // Exercises the `date = q.date ?? getETDateStr(new Date())` path
    // so the response echoes a YYYY-MM-DD calendar string.
    mockSql.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([]);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { date: string };
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('binds MIN_ALERT_ENTRY_PRICE (0.10) into both count + list SQL templates', async () => {
    mockSql.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    // Two SQL calls: the count + the list. Both must bind 0.1 as a
    // parameter (the entry-price floor) so sub-$0.10 algo prints are
    // excluded from the rollup at the source.
    const callsWithFloor = mockSql.mock.calls.filter((args) =>
      args.slice(1).some((v) => v === 0.1),
    );
    expect(callsWithFloor.length).toBe(2);
  });

  it('defaults aggressivePremium=false; binds false into both queries', async () => {
    mockSql.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as { filters: { aggressivePremium: boolean } };
    expect(body.filters.aggressivePremium).toBe(false);
    // Both queries see the boolean false bind so the OR-gated clause
    // short-circuits and matches every row.
    const callsWithFalse = mockSql.mock.calls.filter((args) =>
      args.slice(1).some((v) => v === false),
    );
    expect(callsWithFalse.length).toBe(2);
  });

  it('echoes aggressivePremium=true and binds true into both queries', async () => {
    mockSql.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', aggressivePremium: 'true' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as { filters: { aggressivePremium: boolean } };
    expect(body.filters.aggressivePremium).toBe(true);
    const callsWithTrue = mockSql.mock.calls.filter((args) =>
      args.slice(1).some((v) => v === true),
    );
    expect(callsWithTrue.length).toBe(2);
  });
});
