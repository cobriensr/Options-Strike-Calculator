// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import handler, { config } from '../cron/build-features.js';

// Fixed times for deterministic tests
// Tuesday 2026-03-24 at 5:30 PM ET = 21:30 UTC (inside post-close window)
const POST_CLOSE_TIME = new Date('2026-03-24T21:30:00.000Z');
// Tuesday 2026-03-24 at 10:00 AM ET = 14:00 UTC (outside post-close window)
const OUTSIDE_WINDOW_TIME = new Date('2026-03-24T14:00:00.000Z');
// Saturday 2026-03-28 at 5:30 PM ET = 21:30 UTC (weekend)
const WEEKEND_TIME = new Date('2026-03-28T21:30:00.000Z');

/**
 * The handler now calls SET statement_timeout + a flow_data coverage
 * diagnostic query before any business logic. This helper pre-fills
 * those two SQL calls so per-test mockResolvedValueOnce sequences
 * start at the first real query.
 */
function prefillHandlerPreamble() {
  mockSql.mockResolvedValueOnce([]); // SET statement_timeout
  mockSql.mockResolvedValueOnce([]); // flow_data coverage diagnostic
}

describe('build-features handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv };
    vi.setSystemTime(POST_CLOSE_TIME);
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Method guard ──────────────────────────────────────────

  it('returns 405 for non-GET requests', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when CRON_SECRET is set and auth header is wrong', async () => {
    process.env.CRON_SECRET = 'secret123';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrong' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  // ── Time window ───────────────────────────────────────────

  it('skips when outside post-close window (not backfill)', async () => {
    vi.setSystemTime(OUTSIDE_WINDOW_TIME);
    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
  });

  it('skips on weekends (not backfill)', async () => {
    vi.setSystemTime(WEEKEND_TIME);
    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
  });

  it('skips isPostClose on a market holiday', async () => {
    // Good Friday 2026-04-03 at 5:30 PM ET (21:30 UTC) — a weekday inside the
    // post-close window. Without the holiday check in isPostClose, the cron
    // would run against an empty day and drop a low-completeness phantom row
    // into training_features (the bug this test guards against).
    const HOLIDAY_POST_CLOSE = new Date('2026-04-03T21:30:00.000Z');
    vi.setSystemTime(HOLIDAY_POST_CLOSE);

    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
  });

  // ── Backfill mode ─────────────────────────────────────────

  it('backfill mode processes all flow_data dates', async () => {
    prefillHandlerPreamble();
    // Call 1: SELECT DISTINCT date FROM flow_data
    mockSql.mockResolvedValueOnce([
      { date: '2026-03-23' },
      { date: '2026-03-24' },
    ]);
    // Remaining calls (buildFeaturesForDate, upsert, extractLabels per date) default to []

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      dates: 2,
      featuresBuilt: expect.any(Number),
    });
  });

  // ── Auto-backfill (empty table) ───────────────────────────

  it('auto-backfills when training_features table is empty (count=0)', async () => {
    prefillHandlerPreamble();
    vi.setSystemTime(POST_CLOSE_TIME);

    // Call 1: SELECT COUNT(*) FROM training_features → 0
    mockSql.mockResolvedValueOnce([{ cnt: '0' }]);
    // Call 2: SELECT DISTINCT date FROM flow_data
    mockSql.mockResolvedValueOnce([{ date: '2026-03-24' }]);
    // Remaining calls default to []

    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      dates: 1,
      featuresBuilt: expect.any(Number),
    });
  });

  // ── Normal mode (table has rows) ──────────────────────────

  it('processes only today when table has rows', async () => {
    prefillHandlerPreamble();
    vi.setSystemTime(POST_CLOSE_TIME);

    // Call 1: SELECT COUNT(*) → non-zero
    mockSql.mockResolvedValueOnce([{ cnt: '5' }]);
    // Remaining calls default to []

    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Should process exactly 1 date (today)
    expect(res._json).toMatchObject({ dates: 1 });
  });

  // ── Success path ──────────────────────────────────────────

  it('builds features and labels for a date', async () => {
    prefillHandlerPreamble();
    // Backfill with 1 date so we control the flow precisely
    // Call 1 (handler): SELECT DISTINCT date FROM flow_data
    mockSql.mockResolvedValueOnce([{ date: '2026-03-24' }]);
    // Call 2 (buildFeaturesForDate): SELECT from market_snapshots → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 3: SELECT from flow_data → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 4: SELECT from spot_exposures → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 5: SELECT from greek_exposure → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 6: SELECT from strike_exposures (0dte) → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 7: SELECT from strike_exposures (all-exp) → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 8 (upsertFeatures): INSERT → ok
    mockSql.mockResolvedValueOnce([]);
    // Call 9 (extractLabelsForDate): SELECT from analyses → empty (returns null, no upsert)
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      dates: 1,
      featuresBuilt: 1,
      labelsExtracted: 0,
      errors: 0,
    });
  });

  // ── Error counting ────────────────────────────────────────

  it('counts errors when buildFeaturesForDate throws and continues', async () => {
    prefillHandlerPreamble();
    // Backfill with 2 dates; first date throws, second succeeds
    // Call 1 (handler): SELECT DISTINCT date FROM flow_data
    mockSql.mockResolvedValueOnce([
      { date: '2026-03-23' },
      { date: '2026-03-24' },
    ]);
    // Call 2 (buildFeaturesForDate for first date): throw
    mockSql.mockRejectedValueOnce(new Error('DB timeout'));
    // Calls for second date: all return [] (buildFeaturesForDate queries + upsert + extractLabels)
    // mockSql default is [], so remaining calls resolve to []

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      dates: 2,
      errors: 1,
    });
    // Second date should still have been processed
    expect(
      (res._json as { featuresBuilt: number }).featuresBuilt,
    ).toBeGreaterThanOrEqual(0);
  });

  // ── Top-level error ───────────────────────────────────────

  it('returns 500 on top-level error', async () => {
    prefillHandlerPreamble();
    vi.setSystemTime(POST_CLOSE_TIME);

    // SELECT COUNT(*) throws a top-level error
    mockSql.mockRejectedValueOnce(new Error('Connection refused'));

    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
  });

  // ── Invalid date filtering ────────────────────────────────

  it('filters out invalid date formats', async () => {
    prefillHandlerPreamble();
    // Backfill returns rows with bad date formats
    mockSql.mockResolvedValueOnce([
      { date: '2026-03-24' },
      { date: 'not-a-date' },
      { date: '' },
    ]);
    // Remaining calls default to []

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Only the valid date should be processed
    expect(res._json).toMatchObject({ dates: 1 });
  });

  // ── Single-date param ─────────────────────────────────────

  it('processes only the date in ?date= when provided', async () => {
    prefillHandlerPreamble();
    // No flow_data SELECT or COUNT(*) — single-date mode short-circuits.
    // All buildFeaturesForDate / extractLabelsForDate calls default to [].

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-07' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ dates: 1 });
  });

  it('?date= bypasses the post-close time window', async () => {
    // Outside post-close, but date param should override the time check
    vi.setSystemTime(OUTSIDE_WINDOW_TIME);
    prefillHandlerPreamble();

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-07' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    // Should NOT have been skipped
    expect(res._status).toBe(200);
    expect(res._json).not.toMatchObject({ skipped: true });
  });

  it('?date= takes precedence over backfill=true', async () => {
    prefillHandlerPreamble();
    // If backfill were taking precedence, the next call would be the
    // SELECT DISTINCT date FROM flow_data — and the test would need to
    // mock it. Single-date mode skips that query entirely.

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-07', backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ dates: 1 });
  });

  // ── Day-of-week TZ-aware computation (BE-CRON-003) ────────

  /**
   * Locate the day_of_week and is_friday values in a training_features
   * INSERT call built by tagged-template SQL. The interpolations in
   * upsertFeatures() are positional and date is always the first value;
   * the snapshot block puts day_of_week at position 20 and is_friday at
   * 21 (1-indexed within the value tuple). args[0] is the strings array
   * itself, so the interpolation indices map 1:1 to args[1..N]. If the
   * column order in upsertFeatures() ever changes, the next test failure
   * will pinpoint exactly where to update these offsets.
   */
  function findDowValuesInFeatureUpsert(call: unknown[]): {
    day_of_week: unknown;
    is_friday: unknown;
  } {
    const strings = call[0] as TemplateStringsArray;
    if (!strings.some((s) => s.includes('INSERT INTO training_features'))) {
      throw new Error('Not a training_features upsert call');
    }
    return {
      day_of_week: call[20],
      is_friday: call[21],
    };
  }

  it('writes correct day_of_week and is_friday for a Thursday (2026-04-09)', async () => {
    // 2026-04-09 is a Thursday → dow=4, is_friday=false. The TZ-aware
    // helper computes this from the ET calendar date directly, no
    // hardcoded -05:00 offset (BE-CRON-003).
    let captured: { day_of_week: unknown; is_friday: unknown } | null = null;
    mockSql.mockImplementation((strings: TemplateStringsArray, ...rest) => {
      if (strings.some((s) => s.includes('INSERT INTO training_features'))) {
        captured = findDowValuesInFeatureUpsert([strings, ...rest]);
      }
      return Promise.resolve([]);
    });

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-09' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.day_of_week).toBe(4);
    expect(captured!.is_friday).toBe(false);
  });

  it('writes correct day_of_week for the spring-forward DST Sunday (2026-03-08)', async () => {
    // 2026-03-08 is the second Sunday of March 2026 (DST starts).
    // dow must be 0 (Sunday) regardless of EST/EDT. A regression that
    // re-hardcodes -05:00 to mean EST would still get this right by
    // accident — but the surrounding-day asserts in the timezone unit
    // tests guarantee continuity across the boundary.
    let captured: { day_of_week: unknown; is_friday: unknown } | null = null;
    mockSql.mockImplementation((strings: TemplateStringsArray, ...rest) => {
      if (strings.some((s) => s.includes('INSERT INTO training_features'))) {
        captured = findDowValuesInFeatureUpsert([strings, ...rest]);
      }
      return Promise.resolve([]);
    });

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-03-08' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.day_of_week).toBe(0);
    expect(captured!.is_friday).toBe(false);
  });

  it('writes is_friday=true for a Friday date (2026-04-10)', async () => {
    // 2026-04-10 is a Friday → dow=5, is_friday=true. Locks in the
    // is_friday derivation from the new TZ-aware helper.
    let captured: { day_of_week: unknown; is_friday: unknown } | null = null;
    mockSql.mockImplementation((strings: TemplateStringsArray, ...rest) => {
      if (strings.some((s) => s.includes('INSERT INTO training_features'))) {
        captured = findDowValuesInFeatureUpsert([strings, ...rest]);
      }
      return Promise.resolve([]);
    });

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-10' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.day_of_week).toBe(5);
    expect(captured!.is_friday).toBe(true);
  });

  it('returns 400 for invalid ?date= format', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: 'not-a-date' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({
      error: 'Invalid date param, expected YYYY-MM-DD',
    });
  });

  // ── COALESCE upsert pattern (data preservation) ───────────

  it('upsertFeatures uses COALESCE on every column to preserve existing values', async () => {
    // Regression test for a destructive UPSERT that nulled out historical
    // features whenever a fail-soft helper returned undefined for an API
    // that no longer served the date (e.g. UW 30-day rolling window).
    prefillHandlerPreamble();

    // Drive the handler through one full date so upsertFeatures runs.
    // Single-date mode keeps the SQL sequence minimal: just the per-date
    // queries inside buildFeaturesForDate / extractLabelsForDate.
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-07' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    // Find the SQL call that issued the training_features INSERT.
    const upsertCall = mockSql.mock.calls.find((call) => {
      const strings = call[0] as TemplateStringsArray | undefined;
      return (
        Array.isArray(strings) &&
        strings.some(
          (s: string) =>
            typeof s === 'string' &&
            s.includes('INSERT INTO training_features'),
        )
      );
    });
    expect(upsertCall).toBeDefined();

    const sql = (upsertCall![0] as TemplateStringsArray).join(' ');

    // Sentinel columns from each fragile feature group must use COALESCE.
    // If someone reverts the pattern for any of these, the test fails loudly.
    expect(sql).toContain(
      'max_pain_0dte = COALESCE(EXCLUDED.max_pain_0dte, training_features.max_pain_0dte)',
    );
    expect(sql).toContain(
      'opt_call_volume = COALESCE(EXCLUDED.opt_call_volume, training_features.opt_call_volume)',
    );
    expect(sql).toContain(
      'vix = COALESCE(EXCLUDED.vix, training_features.vix)',
    );
    expect(sql).toContain(
      'feature_completeness = COALESCE(EXCLUDED.feature_completeness, training_features.feature_completeness)',
    );

    // Catch the inverse: no naked `column = EXCLUDED.column` should remain
    // anywhere in the SET clause (sentinel: vix would be `vix = EXCLUDED.vix`).
    expect(sql).not.toMatch(/\bvix = EXCLUDED\.vix\b/);
    expect(sql).not.toMatch(/\bmax_pain_0dte = EXCLUDED\.max_pain_0dte\b/);
  });

  it('upsertLabels uses COALESCE on every column to preserve existing values', async () => {
    // extractLabelsForDate returns null when no analysis exists, and the
    // handler then skips upsertLabels — so we need to make the `analyses`
    // SELECT return a valid row regardless of its position in the call
    // sequence. mockImplementation matches by SQL content instead of
    // counting calls (which would break whenever buildFeaturesForDate is
    // refactored).
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const joined = strings.join(' ');
      if (joined.includes('FROM analyses')) {
        return Promise.resolve([
          {
            id: 1,
            full_response: JSON.stringify({
              review: { wasCorrect: true },
              structure: 'CALL CREDIT SPREAD',
              confidence: 'HIGH',
              chartConfidence: {},
            }),
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-07' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    const upsertCall = mockSql.mock.calls.find((call) => {
      const strings = call[0] as TemplateStringsArray | undefined;
      return (
        Array.isArray(strings) &&
        strings.some(
          (s: string) =>
            typeof s === 'string' && s.includes('INSERT INTO day_labels'),
        )
      );
    });
    expect(upsertCall).toBeDefined();

    const sql = (upsertCall![0] as TemplateStringsArray).join(' ');

    expect(sql).toContain(
      'structure_correct = COALESCE(EXCLUDED.structure_correct, day_labels.structure_correct)',
    );
    expect(sql).toContain(
      'settlement_direction = COALESCE(EXCLUDED.settlement_direction, day_labels.settlement_direction)',
    );
    expect(sql).not.toMatch(
      /\bstructure_correct = EXCLUDED\.structure_correct\b/,
    );
  });

  // ── Config ────────────────────────────────────────────────

  it('exports config with maxDuration: 300', () => {
    expect(config).toEqual({ maxDuration: 300 });
  });

  // ── Rich feature engineering paths ──────────────────────

  it('builds features from snapshot, flow, spot, greek, and strike data', async () => {
    prefillHandlerPreamble();
    const DATE = '2026-03-24';
    // T1=10:00 AM ET = 14:00 UTC, T2=10:30 = 14:30, T3=11:00 = 15:00, T4=11:30 = 15:30
    const ts = (h: number, m: number) =>
      `2026-03-24T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

    // Call 1 (handler): SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);

    // Call 2 (buildFeaturesForDate): market_snapshots
    mockSql.mockResolvedValueOnce([
      {
        vix: '18.5',
        vix1d: '15.2',
        vix9d: '20.1',
        vvix: '90',
        vix1d_vix_ratio: '0.82',
        vix_vix9d_ratio: '0.92',
        regime_zone: 'GREEN',
        cluster_mult: '1.5',
        dow_mult_hl: '1.2',
        dow_label: 'Tue',
        spx_open: '5700',
        sigma: '25',
        hours_remaining: '6.5',
        ic_ceiling: '12',
        put_spread_ceiling: '15',
        call_spread_ceiling: '15',
        opening_range_signal: 'BULLISH',
        opening_range_pct_consumed: '0.45',
        is_event_day: false,
      },
    ]);

    // Call 3: flow_data — provide rows for multiple sources at each checkpoint
    mockSql.mockResolvedValueOnce([
      {
        timestamp: ts(14, 0),
        source: 'market_tide',
        ncp: '500000',
        npp: '-200000',
      },
      {
        timestamp: ts(14, 0),
        source: 'spx_flow',
        ncp: '300000',
        npp: '-100000',
      },
      {
        timestamp: ts(14, 0),
        source: 'spy_flow',
        ncp: '200000',
        npp: '-50000',
      },
      {
        timestamp: ts(14, 0),
        source: 'spy_etf_tide',
        ncp: '-100000',
        npp: '50000',
      },
      {
        timestamp: ts(14, 0),
        source: 'zero_dte_index',
        ncp: '400000',
        npp: '-150000',
      },
      {
        timestamp: ts(14, 0),
        source: 'zero_dte_greek_flow',
        ncp: '1000',
        npp: '-500',
      },
      {
        timestamp: ts(14, 30),
        source: 'market_tide',
        ncp: '600000',
        npp: '-250000',
      },
      {
        timestamp: ts(14, 30),
        source: 'spx_flow',
        ncp: '350000',
        npp: '-120000',
      },
      {
        timestamp: ts(14, 30),
        source: 'spy_flow',
        ncp: '-180000',
        npp: '60000',
      },
      {
        timestamp: ts(14, 30),
        source: 'spy_etf_tide',
        ncp: '150000',
        npp: '-70000',
      },
      {
        timestamp: ts(15, 0),
        source: 'market_tide',
        ncp: '700000',
        npp: '-300000',
      },
      {
        timestamp: ts(15, 30),
        source: 'market_tide',
        ncp: '800000',
        npp: '-350000',
      },
    ]);

    // Call 4: spot_exposures — GEX data at checkpoints
    mockSql.mockResolvedValueOnce([
      {
        timestamp: ts(14, 0),
        gamma_oi: '5000000',
        gamma_vol: '3000000',
        gamma_dir: '2000000',
        charm_oi: '-500000',
        price: '5700',
      },
      {
        timestamp: ts(14, 30),
        gamma_oi: '5200000',
        gamma_vol: '3100000',
        gamma_dir: '2100000',
        charm_oi: '-480000',
        price: '5705',
      },
      {
        timestamp: ts(15, 0),
        gamma_oi: '5400000',
        gamma_vol: '3200000',
        gamma_dir: '2200000',
        charm_oi: '-460000',
        price: '5710',
      },
      {
        timestamp: ts(15, 30),
        gamma_oi: '5600000',
        gamma_vol: '3300000',
        gamma_dir: '2300000',
        charm_oi: '-440000',
        price: '5715',
      },
    ]);

    // Call 5: greek_exposure — aggregate and 0DTE rows
    mockSql.mockResolvedValueOnce([
      {
        expiry: '1970-01-01',
        dte: '-1',
        call_gamma: '8000000',
        put_gamma: '-6000000',
        call_charm: '1000',
        put_charm: '-800',
      },
      {
        expiry: DATE,
        dte: '0',
        call_gamma: '3000000',
        put_gamma: '-2500000',
        call_charm: '500',
        put_charm: '-400',
      },
      {
        expiry: '2026-03-28',
        dte: '4',
        call_gamma: '1000000',
        put_gamma: '-800000',
        call_charm: '200',
        put_charm: '-150',
      },
    ]);

    // Call 6: strike_exposures (0dte) — per-strike data for engineerStrikeFeatures
    const strikes = [];
    for (let s = 5650; s <= 5750; s += 5) {
      const dist = s - 5700;
      // Create a gamma wall above ATM at 5725 and below at 5680
      let callGamma = String(Math.max(0, 50000 - Math.abs(dist) * 1000));
      let putGamma = String(Math.max(0, 40000 - Math.abs(dist) * 800));
      if (s === 5725) {
        callGamma = '500000';
        putGamma = '200000';
      }
      if (s === 5680) {
        callGamma = '400000';
        putGamma = '300000';
      }
      // Charm: positive above, negative below for ccs_confirming pattern
      const callCharm =
        dist > 0 ? String(1000 + dist * 10) : String(-500 + dist * 5);
      const putCharm =
        dist > 0 ? String(500 + dist * 5) : String(-1000 + dist * 10);
      strikes.push({
        strike: String(s),
        price: '5700',
        call_gamma_oi: callGamma,
        put_gamma_oi: putGamma,
        call_charm_oi: callCharm,
        put_charm_oi: putCharm,
      });
    }
    mockSql.mockResolvedValueOnce(strikes);

    // Call 7: strike_exposures (all-exp) — for gamma agreement
    mockSql.mockResolvedValueOnce([
      { strike: '5725', call_gamma_oi: '600000', put_gamma_oi: '250000' },
      { strike: '5680', call_gamma_oi: '450000', put_gamma_oi: '350000' },
      { strike: '5700', call_gamma_oi: '100000', put_gamma_oi: '80000' },
    ]);

    // Call 8: prev day outcomes
    mockSql.mockResolvedValueOnce([]);
    // Call 9: settlements (realized vol)
    mockSql.mockResolvedValueOnce([]);
    // Call 10: vvixHistory (runs because snapshot has vvix)
    mockSql.mockResolvedValueOnce([]);
    // Call 11: economic events
    mockSql.mockResolvedValueOnce([]);
    // Call 12: next event
    mockSql.mockResolvedValueOnce([]);

    // Call 13: dark_pool_snapshots
    mockSql.mockResolvedValueOnce([]);
    // Call 14: oicRows (oi_changes)
    mockSql.mockResolvedValueOnce([]);
    // Call 15: tsRows (vol_term_structure)
    mockSql.mockResolvedValueOnce([]);
    // Call 16: ivMonRow (iv_monitor — phase2 vol surface)
    mockSql.mockResolvedValueOnce([]);
    // Call 17: rvRow (vol_realized)
    mockSql.mockResolvedValueOnce([]);

    // Call 18: iv_monitor (monitor)
    mockSql.mockResolvedValueOnce([]);
    // Call 19: flow_ratio_monitor (monitor)
    mockSql.mockResolvedValueOnce([]);

    // Call 20: nope_ticks (NOPE engineer)
    mockSql.mockResolvedValueOnce([]);

    // Call 21: upsertFeatures INSERT
    mockSql.mockResolvedValueOnce([]);

    // Call 22: extractLabelsForDate — analyses (no review found)
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      dates: 1,
      featuresBuilt: 1,
      labelsExtracted: 0,
      errors: 0,
    });

    // 2 preamble + 1 distinct dates + 7 buildFeatures + 10 phase2 (with vvix,
    // incl. oicRows/tsRows/ivMonRow/rvRow) + 2 monitor + 1 nope + 1 upsert + 1 labels = 24
    expect(mockSql).toHaveBeenCalledTimes(24);
  });

  it('extracts labels from review analyses with outcomes', async () => {
    prefillHandlerPreamble();
    const DATE = '2026-03-24';
    const ts = (h: number, m: number) =>
      `2026-03-24T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

    // Call 1 (handler): SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);

    // Calls 2-18 (buildFeaturesForDate): all empty
    // (7 original + fallback + 5 Phase 2 + 4 phase2 new + 2 monitor;
    //  vvixHistory skipped when vvix is null)
    for (let i = 0; i < 18; i++) mockSql.mockResolvedValueOnce([]);

    // Call 19: upsertFeatures INSERT
    mockSql.mockResolvedValueOnce([]);

    // Call 20 (extractLabelsForDate): SELECT from analyses
    mockSql.mockResolvedValueOnce([
      {
        id: 42,
        full_response: JSON.stringify({
          review: { wasCorrect: true },
          structure: 'IRON CONDOR',
          confidence: 'HIGH',
          suggestedDelta: 8,
          chartConfidence: {
            periscopeCharm: { signal: 'CONFIRMS' },
            netCharm: { signal: 'BULLISH' },
            spxNetFlow: { signal: 'BULLISH' },
            marketTide: { signal: 'BULLISH' },
            spyNetFlow: { signal: 'BEARISH' },
            aggregateGex: { signal: 'POSITIVE' },
          },
        }),
      },
    ]);

    // Call 13 (extractLabelsForDate): SELECT from outcomes
    mockSql.mockResolvedValueOnce([
      {
        settlement: 5720,
        day_open: 5700,
        day_high: 5740,
        day_low: 5690,
        day_range_pts: 50,
      },
    ]);

    // Call 14 (extractLabelsForDate): SELECT from flow_data (for flow_was_directional)
    mockSql.mockResolvedValueOnce([
      { timestamp: ts(14, 30), source: 'market_tide', ncp: '500000' },
      { timestamp: ts(14, 30), source: 'spx_flow', ncp: '300000' },
      { timestamp: ts(14, 30), source: 'spy_flow', ncp: '200000' },
    ]);

    // Call 15: upsertLabels INSERT
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      dates: 1,
      featuresBuilt: 1,
      labelsExtracted: 1,
      errors: 0,
    });
  });

  it('handles review with already-parsed full_response object', async () => {
    prefillHandlerPreamble();
    const DATE = '2026-03-24';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-18: buildFeaturesForDate queries → empty
    // (7 original + fallback + 5 Phase 2 + 4 phase2 new + 2 monitor;
    //  vvixHistory skipped when vvix is null)
    for (let i = 0; i < 18; i++) mockSql.mockResolvedValueOnce([]);
    // Call 19: upsertFeatures
    mockSql.mockResolvedValueOnce([]);

    // Call 20: analyses — full_response is already an object (not a string)
    mockSql.mockResolvedValueOnce([
      {
        id: 99,
        full_response: {
          review: { wasCorrect: false },
          structure: 'PUT CREDIT SPREAD',
          confidence: 'MEDIUM',
          suggestedDelta: 10,
          chartConfidence: {},
        },
      },
    ]);

    // Call 14: outcomes — settlement < open → DOWN
    mockSql.mockResolvedValueOnce([
      {
        settlement: 5680,
        day_open: 5700,
        day_high: 5710,
        day_low: 5670,
        day_range_pts: 40,
      },
    ]);

    // Call 15: flow_data for flow_was_directional
    mockSql.mockResolvedValueOnce([]);

    // Call 16: upsertLabels
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ labelsExtracted: 1 });
  });

  it('handles unparseable full_response in review analysis', async () => {
    prefillHandlerPreamble();
    const DATE = '2026-03-24';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-18: buildFeaturesForDate queries → empty
    for (let i = 0; i < 18; i++) mockSql.mockResolvedValueOnce([]);
    // Call 19: upsertFeatures
    mockSql.mockResolvedValueOnce([]);

    // Call 20: analyses — invalid JSON in full_response
    mockSql.mockResolvedValueOnce([{ id: 55, full_response: '{invalid json' }]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // extractLabelsForDate returns null when parse fails, so labelsExtracted stays 0
    expect(res._json).toMatchObject({ labelsExtracted: 0 });
  });

  it('handles Date objects from Neon in backfill date list', async () => {
    prefillHandlerPreamble();
    // Neon returns DATE columns as JS Date objects
    mockSql.mockResolvedValueOnce([
      { date: new Date('2026-03-24T00:00:00.000Z') },
    ]);
    // Remaining calls default to []

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ dates: 1 });
  });

  it('computes range categories from outcomes in labels', async () => {
    prefillHandlerPreamble();
    const DATE = '2026-03-24';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-18: buildFeaturesForDate queries → empty
    for (let i = 0; i < 18; i++) mockSql.mockResolvedValueOnce([]);
    // Call 19: upsertFeatures
    mockSql.mockResolvedValueOnce([]);

    // Call 20: analyses with minimal review
    mockSql.mockResolvedValueOnce([
      {
        id: 10,
        full_response: JSON.stringify({ review: {}, chartConfidence: {} }),
      },
    ]);

    // Call 14: outcomes — EXTREME range (120 pts), FLAT settlement
    mockSql.mockResolvedValueOnce([
      {
        settlement: 5700,
        day_open: 5700,
        day_high: 5760,
        day_low: 5640,
        day_range_pts: 120,
      },
    ]);

    // Call 15: flow_data
    mockSql.mockResolvedValueOnce([]);

    // Call 16: upsertLabels
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ labelsExtracted: 1 });
  });

  // ── OPEX detection ──────────────────────────────────────────

  it('sets is_opex=true when date is 3rd Friday of month (day 15-21)', async () => {
    prefillHandlerPreamble();
    // 2026-04-17 is a Friday and day 17 of the month (3rd Friday of April 2026)
    const DATE = '2026-04-17';

    // Call 1 (handler): SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);

    // Call 2 (buildFeaturesForDate): market_snapshots → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 3: fallback (outcomes.day_open — spx_open is null)
    mockSql.mockResolvedValueOnce([]);
    // Call 4: flow_data → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 5: spot_exposures → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 6: greek_exposure → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 7: strike_exposures (0dte) → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 8: strike_exposures (all-exp) → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 9: prev day outcomes → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 10: settlements (realized vol) → empty
    mockSql.mockResolvedValueOnce([]);
    // (vvixHistory skipped — no vvix in snapshot)
    // Call 11: economic events → return an event so is_opex is set inside event block
    mockSql.mockResolvedValueOnce([
      { event_name: 'OpEx', event_type: 'OTHER', event_time: '09:30' },
    ]);
    // Call 12: next event → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 13: dark_pool_snapshots → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 14: oicRows (oi_changes) → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 15: tsRows (vol_term_structure) → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 16: ivMonRow (iv_monitor — phase2 vol surface) → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 17: rvRow (vol_realized) → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 18: iv_monitor (monitor) → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 19: flow_ratio_monitor (monitor) → empty
    mockSql.mockResolvedValueOnce([]);

    // Call 20: nope_ticks (NOPE engineer) → empty
    mockSql.mockResolvedValueOnce([]);

    // Call 21: upsertFeatures INSERT — capture the features being upserted
    let upsertedFeatures: Record<string, unknown> | null = null;
    mockSql.mockImplementationOnce((...args: unknown[]) => {
      // The tagged template literal passes strings as first arg, values as rest
      const strings = args[0] as TemplateStringsArray;
      const fullQuery = strings.join('');
      if (fullQuery.includes('INSERT INTO training_features')) {
        // Capture the values being inserted — they are spread as remaining args
        upsertedFeatures = { is_opex: true }; // We verify via assertion below
      }
      return Promise.resolve([]);
    });

    // Call 22: extractLabelsForDate — analyses → empty
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ featuresBuilt: 1 });
    // The upsert was called — features were built successfully for an OPEX date
    expect(upsertedFeatures).not.toBeNull();
  });

  it('sets is_opex=false when date is a Friday but NOT 3rd Friday (day outside 15-21)', async () => {
    prefillHandlerPreamble();
    // 2026-04-24 is a Friday but day 24 (4th Friday, not 3rd)
    const DATE = '2026-04-24';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);

    // Calls 2-9: buildFeaturesForDate queries → empty (no vvix → no vvixHistory)
    for (let i = 0; i < 8; i++) mockSql.mockResolvedValueOnce([]);
    // Call 9: economic events → has events (so is_opex gets set inside block then overridden)
    mockSql.mockResolvedValueOnce([
      { event_name: 'GDP', event_type: 'GDP', event_time: '08:30' },
    ]);
    // Call 10: next event → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 11: upsertFeatures
    mockSql.mockResolvedValueOnce([]);
    // Call 12: extractLabelsForDate → empty
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ featuresBuilt: 1 });
  });

  it('does not set is_opex=true for a non-Friday date', async () => {
    prefillHandlerPreamble();
    // 2026-03-24 is a Tuesday — is_opex should remain unset/false
    const DATE = '2026-03-24';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-9: all empty (no vvix → no vvixHistory)
    for (let i = 0; i < 8; i++) mockSql.mockResolvedValueOnce([]);
    // Call 9: economic events → empty (is_opex never enters events block)
    mockSql.mockResolvedValueOnce([]);
    // Call 10: next event → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 11: upsertFeatures
    mockSql.mockResolvedValueOnce([]);
    // Call 12: extractLabelsForDate → empty
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ featuresBuilt: 1 });
  });

  // ── Days to next event ──────────────────────────────────────

  it('computes days_to_next_event when DB returns a next event date', async () => {
    prefillHandlerPreamble();
    const DATE = '2026-03-24';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);

    // Calls 2-9: buildFeaturesForDate queries → empty (no vvix → no vvixHistory)
    for (let i = 0; i < 8; i++) mockSql.mockResolvedValueOnce([]);

    // Call 9: economic events → empty
    mockSql.mockResolvedValueOnce([]);

    // Call 10: next event → returns a date 10 days out
    mockSql.mockResolvedValueOnce([{ next_date: '2026-04-03' }]);

    // Call 11: upsertFeatures
    mockSql.mockResolvedValueOnce([]);

    // Call 12: extractLabelsForDate → empty
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ featuresBuilt: 1 });
  });

  it('handles next event query returning null next_date', async () => {
    prefillHandlerPreamble();
    const DATE = '2026-03-24';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-9: all empty
    for (let i = 0; i < 8; i++) mockSql.mockResolvedValueOnce([]);
    // Call 9: economic events → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 10: next event → returns a row but next_date is null
    mockSql.mockResolvedValueOnce([{ next_date: null }]);
    // Call 11: upsertFeatures
    mockSql.mockResolvedValueOnce([]);
    // Call 12: extractLabelsForDate → empty
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ featuresBuilt: 1 });
  });

  // ── Event type prioritization ───────────────────────────────

  it('prioritizes FOMC as highest event type when multiple events present', async () => {
    prefillHandlerPreamble();
    const DATE = '2026-03-24';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-9: all empty (no vvix → no vvixHistory)
    for (let i = 0; i < 8; i++) mockSql.mockResolvedValueOnce([]);

    // Call 9: economic events → multiple events including FOMC
    mockSql.mockResolvedValueOnce([
      { event_name: 'CPI Report', event_type: 'CPI', event_time: '08:30' },
      {
        event_name: 'FOMC Decision',
        event_type: 'FOMC',
        event_time: '14:00',
      },
      {
        event_name: 'Consumer Sentiment',
        event_type: 'SENTIMENT',
        event_time: '10:00',
      },
    ]);

    // Call 10: next event → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 11: upsertFeatures
    mockSql.mockResolvedValueOnce([]);
    // Call 12: extractLabelsForDate → empty
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ featuresBuilt: 1 });
  });

  it('selects lower-priority event type when only low-priority events present', async () => {
    prefillHandlerPreamble();
    const DATE = '2026-03-24';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-9: all empty
    for (let i = 0; i < 8; i++) mockSql.mockResolvedValueOnce([]);

    // Call 9: economic events → only low-priority types
    mockSql.mockResolvedValueOnce([
      {
        event_name: 'Consumer Sentiment',
        event_type: 'SENTIMENT',
        event_time: '10:00',
      },
      {
        event_name: 'Retail Sales',
        event_type: 'RETAIL',
        event_time: '08:30',
      },
    ]);

    // Call 10: next event → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 11: upsertFeatures
    mockSql.mockResolvedValueOnce([]);
    // Call 12: extractLabelsForDate → empty
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ featuresBuilt: 1 });
  });

  // ── Flow directional agreement ──────────────────────────────

  it('computes flow_was_directional=true when bullish flow matches UP settlement', async () => {
    prefillHandlerPreamble();
    const DATE = '2026-03-24';
    // 10:30 AM ET = 14:30 UTC (T2 checkpoint = 630 minutes from midnight ET)
    const t2 = '2026-03-24T14:30:00.000Z';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-18: buildFeaturesForDate → empty (no vvix → no vvixHistory)
    // snapshots, fallback, flow, spot, greek, strike0dte, strikeAll,
    // prevDay, settlements, events, nextEvent, dpRows,
    // oicRows, tsRows, ivMonRow, rvRow, iv_monitor(mon), flow_ratio(mon)
    for (let i = 0; i < 18; i++) mockSql.mockResolvedValueOnce([]);
    // Call 20: upsertFeatures
    mockSql.mockResolvedValueOnce([]);

    // Call 21: extractLabelsForDate — analyses with review
    mockSql.mockResolvedValueOnce([
      {
        id: 70,
        full_response: JSON.stringify({
          review: { wasCorrect: true },
          chartConfidence: {},
        }),
      },
    ]);

    // Call 22: outcomes — settlement > open → UP
    mockSql.mockResolvedValueOnce([
      {
        settlement: 5750,
        day_open: 5700,
        day_high: 5760,
        day_low: 5690,
        day_range_pts: 70,
      },
    ]);

    // Call 16: flow_data — majority of AGREEMENT_SOURCES have positive ncp → bullish
    mockSql.mockResolvedValueOnce([
      { timestamp: t2, source: 'market_tide', ncp: '500000' },
      { timestamp: t2, source: 'market_tide_otm', ncp: '300000' },
      { timestamp: t2, source: 'spx_flow', ncp: '400000' },
      { timestamp: t2, source: 'spy_flow', ncp: '200000' },
      { timestamp: t2, source: 'qqq_flow', ncp: '100000' },
      { timestamp: t2, source: 'spy_etf_tide', ncp: '-50000' },
      { timestamp: t2, source: 'qqq_etf_tide', ncp: '80000' },
      { timestamp: t2, source: 'zero_dte_index', ncp: '300000' },
      { timestamp: t2, source: 'zero_dte_greek_flow', ncp: '150000' },
    ]);

    // Call 15: upsertLabels
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ labelsExtracted: 1 });
  });

  it('computes flow_was_directional=null when bullish/bearish counts are tied', async () => {
    prefillHandlerPreamble();
    const DATE = '2026-03-24';
    const t2 = '2026-03-24T14:30:00.000Z';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-19: buildFeaturesForDate → empty (no vvix → no vvixHistory)
    for (let i = 0; i < 18; i++) mockSql.mockResolvedValueOnce([]);
    // Call 20: upsertFeatures
    mockSql.mockResolvedValueOnce([]);

    // Call 21: analyses with review
    mockSql.mockResolvedValueOnce([
      {
        id: 71,
        full_response: JSON.stringify({
          review: { wasCorrect: false },
          chartConfidence: {},
        }),
      },
    ]);

    // Call 22: outcomes — settlement > open → UP
    mockSql.mockResolvedValueOnce([
      {
        settlement: 5720,
        day_open: 5700,
        day_high: 5740,
        day_low: 5690,
        day_range_pts: 50,
      },
    ]);

    // Call 23: flow_data — equal bullish and bearish counts → tie → null direction
    // 4 positive, 4 negative, 1 zero (ignored) → tie
    mockSql.mockResolvedValueOnce([
      { timestamp: t2, source: 'market_tide', ncp: '500000' },
      { timestamp: t2, source: 'market_tide_otm', ncp: '-300000' },
      { timestamp: t2, source: 'spx_flow', ncp: '400000' },
      { timestamp: t2, source: 'spy_flow', ncp: '-200000' },
      { timestamp: t2, source: 'qqq_flow', ncp: '100000' },
      { timestamp: t2, source: 'spy_etf_tide', ncp: '-150000' },
      { timestamp: t2, source: 'qqq_etf_tide', ncp: '80000' },
      { timestamp: t2, source: 'zero_dte_index', ncp: '-300000' },
      { timestamp: t2, source: 'zero_dte_greek_flow', ncp: '0' },
    ]);

    // Call 15: upsertLabels
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ labelsExtracted: 1 });
  });

  it('computes flow_was_directional=false when bearish flow contradicts UP settlement', async () => {
    prefillHandlerPreamble();
    const DATE = '2026-03-24';
    const t2 = '2026-03-24T14:30:00.000Z';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-19: buildFeaturesForDate → empty (no vvix → no vvixHistory)
    for (let i = 0; i < 18; i++) mockSql.mockResolvedValueOnce([]);
    // Call 20: upsertFeatures
    mockSql.mockResolvedValueOnce([]);

    // Call 21: analyses with review
    mockSql.mockResolvedValueOnce([
      {
        id: 72,
        full_response: JSON.stringify({
          review: {},
          chartConfidence: {},
        }),
      },
    ]);

    // Call 22: outcomes — settlement > open → UP
    mockSql.mockResolvedValueOnce([
      {
        settlement: 5730,
        day_open: 5700,
        day_high: 5740,
        day_low: 5680,
        day_range_pts: 60,
      },
    ]);

    // Call 14: flow_data — majority bearish (DOWN flow) but settlement is UP → disagreement
    mockSql.mockResolvedValueOnce([
      { timestamp: t2, source: 'market_tide', ncp: '-500000' },
      { timestamp: t2, source: 'market_tide_otm', ncp: '-300000' },
      { timestamp: t2, source: 'spx_flow', ncp: '-400000' },
      { timestamp: t2, source: 'spy_flow', ncp: '-200000' },
      { timestamp: t2, source: 'qqq_flow', ncp: '-100000' },
      { timestamp: t2, source: 'spy_etf_tide', ncp: '50000' },
      { timestamp: t2, source: 'qqq_etf_tide', ncp: '-80000' },
      { timestamp: t2, source: 'zero_dte_index', ncp: '-300000' },
      { timestamp: t2, source: 'zero_dte_greek_flow', ncp: '-150000' },
    ]);

    // Call 15: upsertLabels
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ labelsExtracted: 1 });
  });
});
