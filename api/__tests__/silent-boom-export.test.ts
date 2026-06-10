// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/auth-helpers.js', () => ({
  guardOwnerEndpoint: vi.fn().mockResolvedValue(false),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', async () => {
  // Keep the REAL withDbRetry so the retry path is genuinely exercised;
  // only the db handle is stubbed.
  const actual =
    await vi.importActual<typeof import('../_lib/db.js')>('../_lib/db.js');
  return {
    getDb: vi.fn(() => mockSql),
    withDbRetry: actual.withDbRetry,
    TransientDbError: actual.TransientDbError,
  };
});

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import handler from '../silent-boom-export.js';

interface ExportRow {
  id: number;
  date: Date;
  bucket_ct: Date;
  option_chain_id: string;
  underlying_symbol: string;
  option_type: 'C' | 'P';
  strike: string;
  expiry: Date;
  dte: number;
  spike_volume: number;
  baseline_volume: string;
  spike_ratio: string;
  ask_pct: string;
  vol_oi: string;
  entry_price: string;
  open_interest: number;
  score: number;
  score_tier: 'tier1' | 'tier2' | 'tier3';
  mkt_tide_diff?: string | null;
  zero_dte_diff?: string | null;
  spx_spot_gamma_oi?: string | null;
}

function makeRow(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    id: 1,
    date: new Date('2026-05-07T00:00:00Z'),
    bucket_ct: new Date('2026-05-07T13:30:00Z'),
    option_chain_id: 'SNDK260507C01175000',
    underlying_symbol: 'SNDK',
    option_type: 'C',
    strike: '1175',
    expiry: new Date('2026-05-07T00:00:00Z'),
    dte: 0,
    spike_volume: 2000,
    baseline_volume: '100',
    spike_ratio: '20',
    ask_pct: '0.95',
    vol_oi: '0.4',
    entry_price: '0.5',
    open_interest: 5000,
    score: 24,
    score_tier: 'tier1',
    ...overrides,
  };
}

describe('silent-boom-export handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects non-GET methods with 405', async () => {
    const req = mockRequest({ method: 'POST', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 200 + CSV with the expected filename and headers', async () => {
    mockSql.mockResolvedValueOnce([makeRow()]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('text/csv');
    expect(res._headers['Content-Disposition']).toContain(
      'silent-boom-2026-05-07.csv',
    );
    // Header row + data row.
    expect(res._body).toMatch(/^id,date,bucket_ct,/);
    expect(res._body).toContain('SNDK');
    expect(res._body).toContain('tier1');
  });

  it('returns JSON when format=json with normalized dates', async () => {
    mockSql.mockResolvedValueOnce([makeRow()]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', format: 'json' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      count: number;
      rows: { date: string; expiry: string; bucket_ct: string }[];
    };
    expect(body.count).toBe(1);
    // DATE columns → YYYY-MM-DD; TIMESTAMPTZ → full ISO.
    expect(body.rows[0]?.date).toBe('2026-05-07');
    expect(body.rows[0]?.expiry).toBe('2026-05-07');
    expect(body.rows[0]?.bucket_ct).toBe('2026-05-07T13:30:00.000Z');
  });

  it('returns empty CSV (status 200, empty body) on no matches', async () => {
    mockSql.mockResolvedValueOnce([]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._body).toBe('');
  });

  it('binds tod into the SQL when supplied (regression vs feed bug)', async () => {
    mockSql.mockResolvedValueOnce([]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', tod: 'AM_open' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).toHaveBeenCalledTimes(1);
    const strings = mockSql.mock.calls[0]![0] as TemplateStringsArray;
    const sqlText = strings.join(' ');
    expect(sqlText).toContain("AT TIME ZONE 'America/Chicago'");
  });

  it('applies minTakeitProb in the export SQL and binds the floor value (Fix 1)', async () => {
    // The export previously accepted minTakeitProb in its schema but
    // never applied it — the CSV was the full firehose while the
    // on-screen feed was TAKE-IT-floored. The predicate must mirror
    // the feed exactly.
    mockSql.mockResolvedValueOnce([makeRow()]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', minTakeitProb: '0.7' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(1);
    const call = mockSql.mock.calls[0] as unknown[];
    const sqlText = (call[0] as TemplateStringsArray).join(' ');
    // Exact predicate mirrors api/silent-boom-feed.ts.
    expect(sqlText).toContain('takeit_prob >=');
    // The floor value is threaded as a bind param.
    expect(call.slice(1)).toContain(0.7);
  });

  it('does NOT apply a takeit floor when minTakeitProb is absent (binds null)', async () => {
    mockSql.mockResolvedValueOnce([makeRow()]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const call = mockSql.mock.calls[0] as unknown[];
    // No 0.7 bind; the predicate short-circuits on a NULL bind.
    expect(call.slice(1)).not.toContain(0.7);
    expect(call.slice(1)).toContain(null);
  });

  it('echoes minTakeitProb in the JSON filters block (Fix 1 parity)', async () => {
    mockSql.mockResolvedValueOnce([makeRow()]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', format: 'json', minTakeitProb: '0.7' },
    });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { filters: { minTakeitProb: number | null } };
    expect(body.filters.minTakeitProb).toBe(0.7);
  });

  it('rejects invalid query params with 400', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: 'not-a-date' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('embeds the ticker in the filename when supplied', async () => {
    mockSql.mockResolvedValueOnce([makeRow()]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', ticker: 'SNDK' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._headers['Content-Disposition']).toContain(
      'silent-boom-2026-05-07-SNDK.csv',
    );
  });

  it('retries a transient DB blip on the first attempt and then succeeds', async () => {
    // First attempt: a retryable Neon blip (matches DB_RETRYABLE_RX).
    // Without withDbRetry wrapping the SELECT, this single rejection
    // would propagate and 500 the export. With the wrap, attempt 2
    // resolves and the CSV is served.
    mockSql
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce([makeRow()]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('text/csv');
    expect(res._body).toContain('SNDK');
  });

  it('does NOT retry a non-retryable DB error (single 500)', async () => {
    mockSql.mockRejectedValueOnce(new Error('syntax error at or near'));
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(500);
  });

  it('soft-degrades an exhausted transient blip to 503 + Retry-After', async () => {
    const { TransientDbError } = await import('../_lib/db.js');
    mockSql.mockRejectedValue(new TransientDbError(new Error('fetch failed')));
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(503);
    expect(res._json).toMatchObject({ transient: true });
    expect(res._headers['Retry-After']).toBe('5');
  });
});

// ============================================================
// Feed ↔ export filter-bucket PARITY.
//
// The export and the feed BOTH map the same UI chips (tod / dte / burst /
// askPctBand) to half-open numeric SQL bounds. They are independent code
// blocks (api/silent-boom-export.ts vs api/silent-boom-feed.ts) and have
// drifted before. These tests pin that the export binds the SAME numeric
// bounds the feed derives for every bucket arm. The bounds below are the
// SINGLE SOURCE OF TRUTH copied from the feed's range mappers
// (silent-boom-feed.ts:338-412); if the export ever diverges from the
// feed, the export run captured here binds a different value and the test
// fails. A failure here is a real feed↔export coherence bug, NOT a test
// that should be relaxed.
// ============================================================

/** Run the export handler for one query and return the captured neon
 *  tagged-template call: [TemplateStringsArray, ...bindParams]. */
async function captureExportSql(
  query: Record<string, string>,
): Promise<{ sqlText: string; binds: unknown[] }> {
  mockSql.mockResolvedValueOnce([]);
  const req = mockRequest({ method: 'GET', query });
  const res = mockResponse();
  await handler(req, res);
  expect(res._status).toBe(200);
  expect(mockSql).toHaveBeenCalledTimes(1);
  const call = mockSql.mock.calls[0] as unknown[];
  const sqlText = (call[0] as TemplateStringsArray).join(' ');
  return { sqlText, binds: call.slice(1) };
}

// Positional bind index map for the export SELECT (api/silent-boom-export.ts
// :152-173). The neon tagged-template pushes ONE positional bind per `${}`
// interpolation, in source order. Several predicates interpolate their value
// twice (an `IS NULL` short-circuit guard + the comparison), so the indices
// are NOT one-per-logical-filter — they are verified against the actual SQL:
//
//   0  targetDate
//   1  tickerUpper (guard)        2  tickerUpper (eq)
//   3  optionType (guard)         4  optionType (eq)
//   5  minVolOi
//   6  minSpikeRatio
//   7  minScore (guard)           8  minScore (cmp)
//   9  todLo (guard)             10  todLo (>=)
//  11  todHi (guard)             12  todHi (<)
//  13  dteLo (guard)             14  dteLo (BETWEEN lo)   15  dteHiBound (BETWEEN hi)
//  16  burstLo (guard)           17  burstLo (>=)         18  burstHiBound (<)
//  19  askPctLo (guard)          20  askPctLo (>=)        21  askPctHiBound (<)
//  22  minTakeitProb (guard)     23  minTakeitProb (>=)
//
// Asserting by POSITION (not set-membership) is load-bearing: the zero-valued
// bucket bounds (dte=0 → lo=0/hi=0, burst=grey → lo=0) collide with the
// default minVolOi/minSpikeRatio = 0 binds, so `binds.toContain(0)` would pass
// even if dteLo/burstLo had drifted. Positional pinning catches that drift.
const BIND_IDX = {
  todLo: 9,
  todHi: 11,
  dteLo: 13,
  dteHiBound: 15,
  burstLo: 16,
  burstHiBound: 18,
  askPctLo: 19,
  askPctHiBound: 21,
} as const;

describe('silent-boom-export ↔ feed filter-bucket parity', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // Feed's TOD → CT minute-of-day half-open [lo, hi). silent-boom-feed.ts:338.
  const TOD_BOUNDS: Record<string, { lo: number; hi: number }> = {
    AM_open: { lo: 0, hi: 10 * 60 },
    MID: { lo: 10 * 60, hi: 12 * 60 },
    LUNCH: { lo: 12 * 60, hi: 13 * 60 },
    PM: { lo: 13 * 60, hi: 15 * 60 },
    LATE: { lo: 15 * 60, hi: 24 * 60 },
  };

  for (const [tod, { lo, hi }] of Object.entries(TOD_BOUNDS)) {
    it(`tod=${tod} binds the feed's CT minute bounds [${lo}, ${hi})`, async () => {
      const { sqlText, binds } = await captureExportSql({
        date: '2026-05-07',
        tod,
      });
      expect(sqlText).toContain("AT TIME ZONE 'America/Chicago'");
      // Positional: todLo at index 9, todHi at index 11 (each value is also
      // re-bound in its comparison, but the guard position uniquely pins it).
      expect(binds[BIND_IDX.todLo]).toBe(lo);
      expect(binds[BIND_IDX.todHi]).toBe(hi);
    });
  }

  // Feed's DTE bucket → numeric [lo, hi]. silent-boom-feed.ts:353. The
  // export has no `minDte`, so only the enum buckets apply.
  const DTE_BOUNDS: Record<string, { lo: number; hi: number }> = {
    '0': { lo: 0, hi: 0 },
    '1-3': { lo: 1, hi: 3 },
    '4+': { lo: 4, hi: 100_000 },
  };

  for (const [dte, { lo, hi }] of Object.entries(DTE_BOUNDS)) {
    it(`dte=${dte} binds the feed's BETWEEN bounds [${lo}, ${hi}]`, async () => {
      const { sqlText, binds } = await captureExportSql({
        date: '2026-05-07',
        dte,
      });
      expect(sqlText).toContain('dte BETWEEN');
      // Positional: dteLo guard at 13, dteHiBound (BETWEEN upper) at 15. The
      // zero-valued dte=0 arm (lo=0,hi=0) would pass a set-membership check
      // against the default minVolOi/minSpikeRatio=0 binds; pin by position.
      expect(binds[BIND_IDX.dteLo]).toBe(lo);
      expect(binds[BIND_IDX.dteHiBound]).toBe(hi);
    });
  }

  // Feed's burst color → spike_ratio [lo, hi). silent-boom-feed.ts:390.
  const BURST_BOUNDS: Record<string, { lo: number; hi: number }> = {
    red: { lo: 50, hi: 1_000_000 },
    yellow: { lo: 20, hi: 50 },
    grey: { lo: 0, hi: 20 },
  };

  for (const [burst, { lo, hi }] of Object.entries(BURST_BOUNDS)) {
    it(`burst=${burst} binds the feed's spike_ratio bounds [${lo}, ${hi})`, async () => {
      const { sqlText, binds } = await captureExportSql({
        date: '2026-05-07',
        burst,
      });
      expect(sqlText).toContain('spike_ratio >=');
      // Positional: burstLo guard at 16, burstHiBound at 18. The burst=grey
      // arm (lo=0) collides with the default minVolOi/minSpikeRatio=0 binds
      // under set-membership; pin by position so a drift can't hide.
      expect(binds[BIND_IDX.burstLo]).toBe(lo);
      expect(binds[BIND_IDX.burstHiBound]).toBe(hi);
    });
  }

  // Feed's ask% band → ask_pct [lo, hi). silent-boom-feed.ts:403. The
  // '100' band is exact equality expressed as [1.0, 1.001).
  const ASK_BOUNDS: Record<string, { lo: number; hi: number }> = {
    '70-80': { lo: 0.7, hi: 0.8 },
    '80-90': { lo: 0.8, hi: 0.9 },
    '90-95': { lo: 0.9, hi: 0.95 },
    '95-99': { lo: 0.95, hi: 1.0 },
    '100': { lo: 1.0, hi: 1.001 },
  };

  for (const [askPctBand, { lo, hi }] of Object.entries(ASK_BOUNDS)) {
    it(`askPctBand=${askPctBand} binds the feed's ask_pct bounds [${lo}, ${hi})`, async () => {
      const { sqlText, binds } = await captureExportSql({
        date: '2026-05-07',
        askPctBand,
      });
      expect(sqlText).toContain('ask_pct >=');
      // Positional: askPctLo guard at 19, askPctHiBound at 21.
      expect(binds[BIND_IDX.askPctLo]).toBe(lo);
      expect(binds[BIND_IDX.askPctHiBound]).toBe(hi);
    });
  }

  it('binds NULL placeholders for every bucket when no chip is active', async () => {
    // With no tod/dte/burst/askPctBand, each range mapper returns null and
    // the predicate short-circuits on a NULL bind — the export dumps the
    // full firehose. Mirrors the feed's "no filter" path.
    const { binds } = await captureExportSql({ date: '2026-05-07' });
    // todLo, todHi, dteLo, burstLo, askPctLo all bind null.
    expect(binds.filter((b) => b === null).length).toBeGreaterThanOrEqual(5);
  });
});
