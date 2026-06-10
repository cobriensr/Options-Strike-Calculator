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
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  TransientDbError: class TransientDbError extends Error {
    constructor(cause?: unknown) {
      super('transient');
      this.name = 'TransientDbError';
      this.cause = cause;
    }
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: { increment: vi.fn() },
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
  takeit_prob?: string | null;
  inserted_at: string;
  fire_time_cum_ncp?: string | null;
  fire_time_cum_npp?: string | null;
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
    takeit_prob: null,
    inserted_at: '2026-05-07T13:30:30Z',
    // Ticker-level cum flow at bucket_ct (LATERAL on
    // ws_net_flow_per_ticker + history). Defaults set for the
    // happy-path test; individual tests override for null fall-through.
    fire_time_cum_ncp: '5500.00',
    fire_time_cum_npp: '-2200.00',
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
      .mockResolvedValueOnce([makeAlert()]) // list
      .mockResolvedValueOnce([]); // cluster-candidate query

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
      ])
      .mockResolvedValueOnce([]); // cluster-candidate query

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { alerts: { avgHoldMinutes: number }[] };
    expect(body.alerts[0]?.avgHoldMinutes).toBe(89);
  });

  it('applies round-trip score deduct and re-derives tier (-3 demotes tier2 → tier3)', async () => {
    // silent-boom tiers: tier1 ≥ 21, tier2 ≥ 8, else tier3.
    // score=10 + deduct -3 → effective 7 → tier3 (was tier2).
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([
        makeAlert({
          score: 10,
          score_tier: 'tier2',
          round_trip_net_pct: '-0.75',
          round_trip_score_deduct: -3,
        }),
      ])
      .mockResolvedValueOnce([]); // cluster-candidate query
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
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([
        makeAlert({
          score: 23,
          score_tier: 'tier1',
          round_trip_net_pct: '-0.60',
          round_trip_score_deduct: -3,
        }),
      ])
      .mockResolvedValueOnce([]); // cluster-candidate query
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as {
      alerts: { score: number | null; scoreTier: string | null }[];
    };
    expect(body.alerts[0]).toMatchObject({ score: 20, scoreTier: 'tier2' });
  });

  it('preserves tier1 when -1 deduct keeps score >= 21', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([
        makeAlert({
          score: 25,
          score_tier: 'tier1',
          round_trip_net_pct: '-0.20',
          round_trip_score_deduct: -1,
        }),
      ])
      .mockResolvedValueOnce([]); // cluster-candidate query
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as {
      alerts: { score: number | null; scoreTier: string | null }[];
    };
    expect(body.alerts[0]).toMatchObject({ score: 24, scoreTier: 'tier1' });
  });

  it('passes through deduct=0 cleanly when no round-trip evaluation yet', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([
        makeAlert({
          score: 24,
          round_trip_net_pct: null,
          round_trip_score_deduct: null,
        }),
      ])
      .mockResolvedValueOnce([]); // cluster-candidate query
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
      .mockResolvedValueOnce([makeAlert({ mkt_tide_diff: null })])
      .mockResolvedValueOnce([]); // cluster-candidate query

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
      ])
      .mockResolvedValueOnce([]); // cluster-candidate query

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
      .mockResolvedValueOnce([makeAlert({ multi_leg_share: '0.25' })])
      .mockResolvedValueOnce([]); // cluster-candidate query

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
      .mockResolvedValueOnce([makeAlert({ multi_leg_share: null })])
      .mockResolvedValueOnce([]); // cluster-candidate query

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      alerts: { multiLegShare: number | null }[];
    };
    expect(body.alerts[0]?.multiLegShare).toBeNull();
  });

  it('exposes fire-time ticker net flow via tickerCumNcp/NppAtFire', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([
        makeAlert({
          fire_time_cum_ncp: '4250.50',
          fire_time_cum_npp: '-1800.75',
        }),
      ])
      .mockResolvedValueOnce([]); // cluster-candidate query

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      alerts: {
        tickerCumNcpAtFire: number | null;
        tickerCumNppAtFire: number | null;
      }[];
    };
    expect(body.alerts[0]?.tickerCumNcpAtFire).toBe(4250.5);
    expect(body.alerts[0]?.tickerCumNppAtFire).toBe(-1800.75);
  });

  it('falls through to null tickerCumNcp/Npp when LATERAL has no rows', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([
        makeAlert({ fire_time_cum_ncp: null, fire_time_cum_npp: null }),
      ])
      .mockResolvedValueOnce([]); // cluster-candidate query

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      alerts: {
        tickerCumNcpAtFire: number | null;
        tickerCumNppAtFire: number | null;
      }[];
    };
    expect(body.alerts[0]?.tickerCumNcpAtFire).toBeNull();
    expect(body.alerts[0]?.tickerCumNppAtFire).toBeNull();
  });

  it('rows query reads cum_ncp/cum_npp from the snapshot column on the row', async () => {
    // Pin the post-LATERAL shape: migration #158 added cum_ncp_at_fire +
    // cum_npp_at_fire columns populated at detect time by
    // api/_lib/ticker-flow-snapshot.ts; the feed now reads them directly
    // and aliases them as fire_time_cum_ncp / fire_time_cum_npp. Spec:
    // docs/superpowers/specs/lottery-silentboom-feed-perf-2026-05-17.md.
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert()])
      .mockResolvedValueOnce([]); // cluster-candidate query

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    // The second SQL call is the rows query (count is first).
    const sqlText = (mockSql.mock.calls[1]![0] as TemplateStringsArray).join(
      ' ',
    );
    expect(sqlText).toContain('s.cum_ncp_at_fire AS fire_time_cum_ncp');
    expect(sqlText).toContain('s.cum_npp_at_fire AS fire_time_cum_npp');
    // No LATERAL — the per-row sub-aggregation was what made page loads ~30s.
    expect(sqlText).not.toContain('LEFT JOIN LATERAL');
    expect(sqlText).not.toContain('ws_net_flow_per_ticker');
    expect(sqlText).not.toContain('net_flow_per_ticker_history');
  });

  it('returns null underlyingPriceAtSpike for pre-#152 rows missing the spot snapshot', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert({ underlying_price_at_spike: null })])
      .mockResolvedValueOnce([]); // cluster-candidate query

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
      .mockResolvedValueOnce([makeAlert({ score: 25 })]) // list
      .mockResolvedValueOnce([]); // cluster-candidate query

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', minScore: '21' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(3);

    // Tagged-template helper passes the raw template strings array as
    // the first argument. We check the count + list calls (first two)
    // include the minScore filter literal so a regression that only
    // filters the count fails this test. The 3rd call is the cluster
    // candidate query which does not carry the minScore filter by design.
    // Fix 3: the predicate gates on the DISPLAYED effective score, so the
    // literal is the GREATEST(...) form, not the raw `score >=`.
    for (const call of mockSql.mock.calls.slice(0, 2)) {
      const strings = call[0] as TemplateStringsArray | undefined;
      const sqlText = (strings ?? []).join(' ');
      expect(sqlText).toContain(
        'GREATEST(0, score + COALESCE(round_trip_score_deduct, 0)) >=',
      );
    }
  });

  it('returns total=0 with no list call when count is zero — wait, actually still calls list', async () => {
    // The handler doesn't short-circuit on total=0; it still issues
    // the list query (which will return []). This is intentional —
    // the count and list both go through the same WHERE clause and
    // the small extra query keeps the code straightforward.
    mockSql
      .mockResolvedValueOnce([{ n: 0 }]) // count
      .mockResolvedValueOnce([]) // list
      .mockResolvedValueOnce([]); // cluster-candidate query

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { total: number; alerts: unknown[] };
    expect(body.total).toBe(0);
    expect(body.alerts).toEqual([]);
  });

  it('pagination coherence: total > limit → page length == limit, hasMore true, offset echoed', async () => {
    // total (count query) reports the full reachable set; the list query
    // returns at most `limit` rows. The handler derives hasMore as
    // `offset + alerts.length < total`. With total=50, limit=10, offset=0:
    // page length == 10, hasMore true. Pin the count/limit/offset/hasMore
    // coherence so a regression that decouples them (e.g. hasMore off the
    // page length alone) fails.
    const page = Array.from({ length: 10 }, (_, i) =>
      makeAlert({ id: i + 1, option_chain_id: `SNDK260507C0117500${i}` }),
    );
    mockSql
      .mockResolvedValueOnce([{ n: 50 }]) // count → total 50
      .mockResolvedValueOnce(page) // list → exactly `limit` rows
      .mockResolvedValueOnce([]); // cluster-candidate query

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', limit: '10', offset: '0' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      count: number;
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
      alerts: unknown[];
    };
    expect(body.total).toBe(50);
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);
    // count + returned page length both equal the limit.
    expect(body.count).toBe(10);
    expect(body.alerts).toHaveLength(10);
    // 0 + 10 < 50 → more pages remain.
    expect(body.hasMore).toBe(true);
  });

  it('pagination coherence: last page (offset + page length == total) → hasMore false', async () => {
    // Final slice: offset=40, limit=10, total=50, page returns the last 10.
    // 40 + 10 == 50 → NOT < total → hasMore false. Boundary guard so the
    // "next" control disables exactly when the user reaches the end.
    const page = Array.from({ length: 10 }, (_, i) =>
      makeAlert({ id: 40 + i + 1, option_chain_id: `SNDK260507C0118000${i}` }),
    );
    mockSql
      .mockResolvedValueOnce([{ n: 50 }]) // count → total 50
      .mockResolvedValueOnce(page) // list → last 10 rows
      .mockResolvedValueOnce([]); // cluster-candidate query

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', limit: '10', offset: '40' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      count: number;
      total: number;
      offset: number;
      hasMore: boolean;
    };
    expect(body.total).toBe(50);
    expect(body.offset).toBe(40);
    expect(body.count).toBe(10);
    // 40 + 10 == 50 (not <) → no further pages.
    expect(body.hasMore).toBe(false);
  });

  it('maps direction_gated + realized_trail30_10_pct into the response (Phase 4)', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([
        makeAlert({
          direction_gated: true,
          realized_trail30_10_pct: '47.5',
        }),
      ])
      .mockResolvedValueOnce([]); // cluster-candidate query

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
      .mockResolvedValueOnce([makeAlert()]) // both fields use fixture defaults
      .mockResolvedValueOnce([]); // cluster-candidate query

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
      .mockResolvedValueOnce([makeAlert()])
      .mockResolvedValueOnce([]); // cluster-candidate query

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', tod: 'AM_open' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(3);
    // Count and list queries (first two) must extract CT minute-of-day and
    // gate it. The 3rd call is the cluster-candidate query which doesn't
    // carry TOD filters by design.
    for (const call of mockSql.mock.calls.slice(0, 2)) {
      const strings = call[0] as TemplateStringsArray | undefined;
      const sqlText = (strings ?? []).join(' ');
      expect(sqlText).toContain("AT TIME ZONE 'America/Chicago'");
    }

    const body = res._json as { filters: { tod: string | null } };
    expect(body.filters.tod).toBe('AM_open');
  });

  it('binds dte into the SQL when supplied', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert()])
      .mockResolvedValueOnce([]); // cluster-candidate query

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', dte: '0' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Check only the count + list queries (first two) for dte BETWEEN.
    // The cluster-candidate query uses dte = 0 unconditionally.
    for (const call of mockSql.mock.calls.slice(0, 2)) {
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
      .mockResolvedValueOnce([makeAlert()])
      .mockResolvedValueOnce([]); // cluster-candidate query

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', burst: 'grey' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // The burst filter compiles to spike_ratio range bounds — check
    // BOTH count AND list query (first two calls) carry the gate so a
    // regression that only filters the count fails this test.
    for (const call of mockSql.mock.calls.slice(0, 2)) {
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
      .mockResolvedValueOnce([makeAlert()])
      .mockResolvedValueOnce([]); // cluster-candidate query

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', askPctBand: '100' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // The askPctBand filter compiles to ask_pct range bounds — check
    // BOTH count AND list query (first two calls) carry the gate.
    for (const call of mockSql.mock.calls.slice(0, 2)) {
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
    mockSql
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]); // cluster-candidate query
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
    mockSql
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]); // cluster-candidate query
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
    mockSql
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]); // cluster-candidate query
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

    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([
        {
          ...makeAlert(),
          // Override the timestamps with Date instances.
          bucket_ct: bucket as unknown as string,
          inserted_at: inserted as unknown as string,
          date: dateObj as unknown as string,
          enriched_at: null, // hits toIsoOrNull(null) → null branch
        },
      ])
      .mockResolvedValueOnce([]); // cluster-candidate query

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
      .mockResolvedValueOnce([makeAlert({ dte: 2 })])
      .mockResolvedValueOnce([]); // cluster-candidate query

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', dte: '1-3' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: { dte: string | null } };
    expect(body.filters.dte).toBe('1-3');
    // Check count + list only (first two calls); cluster query uses dte = 0.
    for (const call of mockSql.mock.calls.slice(0, 2)) {
      const strings = call[0] as TemplateStringsArray | undefined;
      const sqlText = (strings ?? []).join(' ');
      expect(sqlText).toContain('dte BETWEEN');
    }
  });

  it('binds dte 4+ range into SQL', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([makeAlert({ dte: 7 })])
      .mockResolvedValueOnce([]); // cluster-candidate query

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
      .mockResolvedValueOnce([makeAlert({ spike_ratio: '60' })])
      .mockResolvedValueOnce([]); // cluster-candidate query

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
      .mockResolvedValueOnce([makeAlert({ spike_ratio: '30' })])
      .mockResolvedValueOnce([]); // cluster-candidate query

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
      .mockResolvedValueOnce([makeAlert()])
      .mockResolvedValueOnce([]); // cluster-candidate query

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
      .mockResolvedValueOnce([makeAlert()])
      .mockResolvedValueOnce([]); // cluster-candidate query

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
      .mockResolvedValueOnce([makeAlert()])
      .mockResolvedValueOnce([]); // cluster-candidate query

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

  it('soft-degrades a transient DB blip to 503 + Retry-After (no Sentry)', async () => {
    const { TransientDbError } = await import('../_lib/db.js');
    mockSql.mockRejectedValueOnce(
      new TransientDbError(new Error('fetch failed')),
    );

    const sentryMod = await import('../_lib/sentry.js');

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(503);
    expect(res._json).toMatchObject({ transient: true });
    expect(res._headers['Retry-After']).toBe('5');
    expect(sentryMod.Sentry.captureException).not.toHaveBeenCalled();
  });

  it('defaults date to today (getETDateStr) when no date query param', async () => {
    // Exercises the `date = q.date ?? getETDateStr(new Date())` path
    // so the response echoes a YYYY-MM-DD calendar string.
    mockSql
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]); // cluster-candidate query
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { date: string };
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('binds MIN_ALERT_ENTRY_PRICE (0.10) into both count + list SQL templates', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]); // cluster-candidate query

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    // Two SQL calls: the count + the list. Both must bind 0.1 as a
    // parameter (the entry-price floor) so sub-$0.10 algo prints are
    // excluded from the rollup at the source. The 3rd call is the cluster
    // candidate query which does not bind the entry-price floor.
    const callsWithFloor = mockSql.mock.calls.filter((args) =>
      args.slice(1).some((v) => v === 0.1),
    );
    expect(callsWithFloor.length).toBe(2);
  });

  it('defaults aggressivePremium=false; binds false into both queries', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]); // cluster-candidate query
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as { filters: { aggressivePremium: boolean } };
    expect(body.filters.aggressivePremium).toBe(false);
    // Both queries see the boolean false bind so the OR-gated clause
    // short-circuits and matches every row. The 3rd call (cluster query)
    // does not bind the aggressivePremium boolean.
    const callsWithFalse = mockSql.mock.calls.filter((args) =>
      args.slice(1).some((v) => v === false),
    );
    expect(callsWithFalse.length).toBe(2);
  });

  it('echoes aggressivePremium=true and binds true into both queries', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]); // cluster-candidate query
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

  it('binds minTakeitProb to both count + rows queries and echoes it in filters', async () => {
    // Server-side push of the TAKE-IT chip. Prior client-side filter
    // stripped ~40 of 50 rows per page when default 0.70 was active
    // and produced 16+ mostly-empty pages. Mirrors the lottery fix.
    mockSql
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', minTakeitProb: '0.7' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as { filters: { minTakeitProb: number | null } };
    expect(body.filters.minTakeitProb).toBe(0.7);

    // Count + rows query both bind the floor value.
    const countCall = mockSql.mock.calls[0] as unknown[];
    const rowsCall = mockSql.mock.calls[1] as unknown[];
    expect(countCall.slice(1)).toContain(0.7);
    expect(rowsCall.slice(1)).toContain(0.7);

    // SQL text references the takeit_prob column.
    const countSql = (countCall[0] as TemplateStringsArray).join(' ');
    const rowsSql = (rowsCall[0] as TemplateStringsArray).join(' ');
    expect(countSql).toContain('takeit_prob >=');
    expect(rowsSql).toContain('takeit_prob >=');
  });

  it('omits minTakeitProb from filters echo when not provided', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as { filters: { minTakeitProb: number | null } };
    expect(body.filters.minTakeitProb).toBeNull();
  });

  // ------------------------------------------------------------------
  // Fix 3 — minScore gates on the DISPLAYED effective score.
  // ------------------------------------------------------------------

  it('minScore predicate gates on effectiveScore (GREATEST(0, score + deduct)) in count + all sort branches', async () => {
    // The displayed tier derives from effectiveScore = GREATEST(0, score +
    // round_trip_score_deduct). The minScore filter must gate on that same
    // value so total/rows agree with the rendered tier. Verify the count
    // query AND every sort-branch row query carry the byte-identical
    // effective-score predicate.
    for (const sort of ['newest', 'spike_ratio', 'vol_oi', 'peak'] as const) {
      mockSql
        .mockResolvedValueOnce([{ n: 1 }]) // count
        .mockResolvedValueOnce([makeAlert({ score: 25 })]) // rows
        .mockResolvedValueOnce([]); // cluster
      const req = mockRequest({
        method: 'GET',
        query: { date: '2026-05-07', minScore: '21', sort },
      });
      const res = mockResponse();
      await handler(req, res);
      expect(res._status).toBe(200);

      // Count (call 0) + rows (call 1) must both carry the effective-score
      // predicate. The cluster query (call 2) must NOT.
      for (const call of mockSql.mock.calls.slice(0, 2)) {
        const sqlText = (
          (call[0] as TemplateStringsArray | undefined) ?? []
        ).join(' ');
        expect(sqlText).toContain(
          'GREATEST(0, score + COALESCE(round_trip_score_deduct, 0)) >=',
        );
        // The raw-score predicate must be gone (drift = total/rows mismatch).
        expect(sqlText).not.toContain('OR score >=');
      }
      vi.clearAllMocks();
    }
  });

  it('excludes a row that raw-passes minScore but is effective-below-floor, and the displayed tier matches', async () => {
    // score=23 raw passes minScore=21, but a -3 round-trip deduct drops
    // the effective score to 20 → tier2. The SQL gate (which the DB
    // applies) would exclude it from a real query; here we assert the
    // read-time effective score + tier the handler computes for such a
    // row so the displayed value matches the gated predicate.
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([
        makeAlert({
          score: 23,
          score_tier: 'tier1',
          round_trip_score_deduct: -3,
          round_trip_net_pct: '-0.6',
        }),
      ])
      .mockResolvedValueOnce([]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', minScore: '21' },
    });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      alerts: { score: number | null; scoreTier: string | null }[];
    };
    // Effective = GREATEST(0, 23 + (-3)) = 20 → tier2 (below the 21 floor).
    expect(body.alerts[0]?.score).toBe(20);
    expect(body.alerts[0]?.scoreTier).toBe('tier2');
  });

  // ------------------------------------------------------------------
  // Fix 4 — direction-gate TAKE-IT exemption in the displayed tier.
  // ------------------------------------------------------------------

  it('gated row with takeit_prob >= 0.70 displays its pre-gate (score-derived) tier', async () => {
    // The detector stored a PRE-gate tier for gated-but-exempt rows. The
    // feed must honor that: gated + takeit_prob >= TAKEIT_GATE_EXEMPT_MIN_PROB
    // → score-derived tier, NOT a forced tier3. score=24 → tier1.
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([
        makeAlert({
          score: 24,
          score_tier: 'tier1',
          direction_gated: true,
          takeit_prob: '0.72',
        }),
      ])
      .mockResolvedValueOnce([]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      alerts: { scoreTier: string | null; directionGated: boolean }[];
    };
    // Exempt: pre-gate tier1 displayed.
    expect(body.alerts[0]?.scoreTier).toBe('tier1');
    // The "Gated" pill (direction_gated) is unchanged.
    expect(body.alerts[0]?.directionGated).toBe(true);
  });

  it('gated row with takeit_prob below 0.70 is forced to tier3', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([
        makeAlert({
          score: 24,
          score_tier: 'tier1',
          direction_gated: true,
          takeit_prob: '0.55',
        }),
      ])
      .mockResolvedValueOnce([]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      alerts: { scoreTier: string | null; directionGated: boolean }[];
    };
    // Not exempt → forced tier3, pill still on.
    expect(body.alerts[0]?.scoreTier).toBe('tier3');
    expect(body.alerts[0]?.directionGated).toBe(true);
  });

  it('gated row with NULL takeit_prob is forced to tier3 (no exemption)', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([
        makeAlert({
          score: 24,
          score_tier: 'tier1',
          direction_gated: true,
          takeit_prob: null,
        }),
      ])
      .mockResolvedValueOnce([]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { alerts: { scoreTier: string | null }[] };
    expect(body.alerts[0]?.scoreTier).toBe('tier3');
  });

  it('exactly 0.70 takeit_prob on a gated row is exempt (>= threshold, boundary)', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([
        makeAlert({
          score: 10,
          score_tier: 'tier2',
          direction_gated: true,
          takeit_prob: '0.70',
        }),
      ])
      .mockResolvedValueOnce([]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { alerts: { scoreTier: string | null }[] };
    // score=10 → tier2; exempt at the 0.70 boundary so the pre-gate tier shows.
    expect(body.alerts[0]?.scoreTier).toBe('tier2');
  });

  it('non-gated row ignores takeit_prob and uses the score-derived tier', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([
        makeAlert({
          score: 24,
          score_tier: 'tier1',
          direction_gated: false,
          takeit_prob: '0.10',
        }),
      ])
      .mockResolvedValueOnce([]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      alerts: { scoreTier: string | null; directionGated: boolean }[];
    };
    expect(body.alerts[0]?.scoreTier).toBe('tier1');
    expect(body.alerts[0]?.directionGated).toBe(false);
  });

  // ------------------------------------------------------------------
  // Suspicious-cluster detection tests.
  // ------------------------------------------------------------------

  it('stamps suspiciousCluster + clusterStrikeCount from the day cluster query', async () => {
    mockSql
      .mockResolvedValueOnce([{ n: 1 }]) // count
      .mockResolvedValueOnce([
        makeAlert({
          underlying_symbol: 'META',
          option_type: 'C',
          strike: '617.5',
        }),
      ]) // page
      .mockResolvedValueOnce([
        {
          underlying_symbol: 'META',
          option_type: 'C',
          strike: '617.5',
          dte: 0,
          entry_price: '0.34',
          underlying_price_at_spike: '613',
          ask_pct: '0.74',
        },
        {
          underlying_symbol: 'META',
          option_type: 'C',
          strike: '615',
          dte: 0,
          entry_price: '0.91',
          underlying_price_at_spike: '613',
          ask_pct: '0.75',
        },
        {
          underlying_symbol: 'META',
          option_type: 'C',
          strike: '622.5',
          dte: 0,
          entry_price: '1.25',
          underlying_price_at_spike: '613',
          ask_pct: '0.71',
        },
      ]); // cluster-candidate query

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-27' } });
    const res = mockResponse();
    await handler(req, res);

    const alert = (
      res._json as {
        alerts: Array<{
          suspiciousCluster: boolean;
          clusterStrikeCount: number;
        }>;
      }
    ).alerts[0];
    expect(alert?.suspiciousCluster).toBe(true);
    expect(alert?.clusterStrikeCount).toBe(3);
  });

  it('stamps suspiciousCluster=false and clusterStrikeCount=0 for a ticker with no cluster', async () => {
    // SNDK with only 1 cluster candidate — below MIN_CLUSTER_STRIKES=3
    mockSql
      .mockResolvedValueOnce([{ n: 1 }]) // count
      .mockResolvedValueOnce([makeAlert()]) // page (underlying_symbol='SNDK')
      .mockResolvedValueOnce([
        {
          underlying_symbol: 'SNDK',
          option_type: 'C',
          strike: '1175',
          dte: 0,
          entry_price: '0.40',
          underlying_price_at_spike: '1170',
          ask_pct: '0.90',
        },
      ]); // cluster-candidate query — only 1 strike, won't fire

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    const alert = (
      res._json as {
        alerts: Array<{
          suspiciousCluster: boolean;
          clusterStrikeCount: number;
        }>;
      }
    ).alerts[0];
    expect(alert?.suspiciousCluster).toBe(false);
    expect(alert?.clusterStrikeCount).toBe(0);
  });
});
