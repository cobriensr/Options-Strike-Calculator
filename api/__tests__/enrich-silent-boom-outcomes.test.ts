// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockCronGuard } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockCronGuard: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

import handler from '../cron/enrich-silent-boom-outcomes.js';

const GUARD = { apiKey: 'test-key', today: '2026-05-13' };

/**
 * The tagged-template mock receives the SQL string fragments as its first
 * arg (a TemplateStringsArray). Join them to match against the query text.
 */
function queryText(call: unknown[]): string {
  const strings = call[0];
  return Array.isArray(strings) ? strings.join('') : '';
}

const baseAlert = {
  id: 1,
  optionChainId: 'SPY260513C00500000',
  bucketCt: new Date('2026-05-13T14:30:00Z'),
  entryPrice: 1.0,
};

describe('enrich-silent-boom-outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';
    mockCronGuard.mockReturnValue(GUARD);
  });

  it('returns 401 when CRON_SECRET is missing/wrong (cronGuard returns null)', async () => {
    mockCronGuard.mockReturnValueOnce(null);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrong-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    // cronGuard handles the 401 itself; the wrapper short-circuits and
    // never runs the handler body, so no SELECT was issued.
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns early when no unenriched fires exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      message: 'No unenriched fires',
    });

    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('enriches a fire with post-entry ticks and lands trail-30/10 in the right UPDATE array slot', async () => {
    // Tape: entry $1.00, peak $1.50 (+50%) at t=2min, gives back 10pp to
    // $1.40 at t=3min → trail-30/10 exits at +40%; EoD price $1.20 (+20%).
    mockSql.mockResolvedValueOnce([baseAlert]); // SELECT alerts
    // Batched ticks read — each row carries the joining alertId.
    mockSql.mockResolvedValueOnce([
      { alertId: 1, executedAt: new Date('2026-05-13T14:31:00Z'), price: 1.2 },
      { alertId: 1, executedAt: new Date('2026-05-13T14:32:00Z'), price: 1.5 },
      { alertId: 1, executedAt: new Date('2026-05-13T14:33:00Z'), price: 1.4 },
      { alertId: 1, executedAt: new Date('2026-05-13T14:40:00Z'), price: 1.2 },
    ]); // SELECT ticks (JOIN LATERAL)

    // Capture the batched enriched UPDATE bind shape. The tagged-template
    // call invokes mockSql with (stringsArray, ...arrayValues); each bound
    // value is now an ARRAY (one element per enriched alert).
    let updateValues: unknown[] = [];
    mockSql.mockImplementationOnce((..._args: unknown[]) => {
      updateValues = _args.slice(1);
      return Promise.resolve([]);
    }); // enriched UPDATE

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      message: expect.stringContaining('Enriched 1 fires'),
    });
    // SELECT alerts + batched ticks read + ONE batched enriched UPDATE
    // (no no-tick alerts → no second write).
    expect(mockSql).toHaveBeenCalledTimes(3);

    // Batched UPDATE unnest array order from the handler:
    //   ids, peak, minToPeak, r30, r60, r120, eod, trail30
    // Each bind is an array of one (single enriched alert).
    expect(updateValues).toHaveLength(8);
    const [ids, peak, , , , , , trail30] = updateValues as number[][];
    expect(ids).toEqual([1]); // id array
    expect(peak![0]).toBeCloseTo(50, 5); // peak ceiling %
    expect(trail30![0]).toBeCloseTo(40, 5); // trail-30/10 %
  });

  it('stamps a terminal enriched_at (NULL outcomes) on a no-tick alert so it exits the candidate set', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...baseAlert,
        id: 2,
        optionChainId: 'SPY260513P00495000',
        bucketCt: new Date('2026-05-13T20:59:00Z'),
        entryPrice: 0.5,
      },
    ]); // SELECT alerts
    mockSql.mockResolvedValueOnce([]); // batched ticks read returns no rows

    let noTickUpdate: { text: string; values: unknown[] } | null = null;
    mockSql.mockImplementationOnce((...args: unknown[]) => {
      noTickUpdate = { text: queryText(args), values: args.slice(1) };
      return Promise.resolve([]);
    }); // terminal no-tick UPDATE

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      message: expect.stringContaining('skipped 1'),
    });
    // SELECT alerts + batched ticks read + terminal no-tick UPDATE
    // (no enriched alerts → no enriched write).
    expect(mockSql).toHaveBeenCalledTimes(3);

    // The terminal UPDATE stamps enriched_at = NOW() and touches NO realized
    // or peak columns (they stay NULL — a no-tick alert is NOT a 0% outcome).
    expect(noTickUpdate).not.toBeNull();
    const update = noTickUpdate!;
    expect(update.text).toContain('UPDATE silent_boom_alerts');
    expect(update.text).toContain('enriched_at = NOW()');
    expect(update.text).not.toContain('realized_');
    expect(update.text).not.toContain('peak_ceiling_pct');
    expect(update.text).not.toContain('minutes_to_peak');
    // The no-tick UPDATE binds the id array for the WHERE id = ANY(...) clause.
    expect(update.values).toEqual([[2]]);
  });

  it('batches enriched and no-tick alerts into separate writes in the same run', async () => {
    // Alert 1 has ticks → enriched UPDATE; alert 2 has none → terminal UPDATE.
    mockSql.mockResolvedValueOnce([
      baseAlert,
      {
        ...baseAlert,
        id: 2,
        optionChainId: 'SPY260513P00495000',
        bucketCt: new Date('2026-05-13T20:59:00Z'),
        entryPrice: 0.5,
      },
    ]); // SELECT alerts
    // Only alert 1 has post-entry ticks. Rows arrive ordered by alert id.
    mockSql.mockResolvedValueOnce([
      { alertId: 1, executedAt: new Date('2026-05-13T14:31:00Z'), price: 1.2 },
      { alertId: 1, executedAt: new Date('2026-05-13T14:32:00Z'), price: 1.5 },
    ]); // SELECT ticks (JOIN LATERAL)

    let enrichedUpdate: { text: string; values: unknown[] } | null = null;
    let noTickUpdate: { text: string; values: unknown[] } | null = null;
    mockSql.mockImplementationOnce((...args: unknown[]) => {
      enrichedUpdate = { text: queryText(args), values: args.slice(1) };
      return Promise.resolve([]);
    }); // enriched UPDATE (first — updates.length > 0 branch runs before no-tick)
    mockSql.mockImplementationOnce((...args: unknown[]) => {
      noTickUpdate = { text: queryText(args), values: args.slice(1) };
      return Promise.resolve([]);
    }); // terminal no-tick UPDATE

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      message: expect.stringMatching(/Enriched 1 fires, skipped 1/),
    });
    // SELECT + ticks + enriched UPDATE + no-tick UPDATE = 4 calls.
    expect(mockSql).toHaveBeenCalledTimes(4);

    expect(enrichedUpdate).not.toBeNull();
    const enr = enrichedUpdate!;
    expect(enr.text).toContain('peak_ceiling_pct = u.peak');
    expect(enr.text).toContain('realized_trail30_10_pct = u.trail30');
    // First bound array is the enriched id list (alert 1 only).
    expect(enr.values[0] as number[]).toEqual([1]);

    expect(noTickUpdate).not.toBeNull();
    const noT = noTickUpdate!;
    expect(noT.text).toContain('id = ANY');
    expect(noT.values).toEqual([[2]]);
  });

  it('coerces string prices (un-cast NUMERIC) to a numerically correct peak', async () => {
    // Belt-and-suspenders for the SQL ::float8 cast: if a future SELECT drops
    // the cast and Neon returns NUMERIC-as-string, the function-level Number()
    // guard in peakCeiling/minutesToPeak must still pick the numeric max.
    // Tape: "9.50","10.50","8.00" — lexicographic max is "9.50"; numeric max
    // is 10.50. Entry 1.0 → peak +950%, NOT +850%.
    mockSql.mockResolvedValueOnce([{ ...baseAlert, entryPrice: 1.0 }]); // SELECT alerts
    mockSql.mockResolvedValueOnce([
      {
        alertId: 1,
        executedAt: new Date('2026-05-13T14:31:00Z'),
        price: '9.50',
      },
      {
        alertId: 1,
        executedAt: new Date('2026-05-13T14:32:00Z'),
        price: '10.50',
      },
      {
        alertId: 1,
        executedAt: new Date('2026-05-13T14:33:00Z'),
        price: '8.00',
      },
    ]); // SELECT ticks (strings, as un-cast Neon returns)

    let updateValues: unknown[] = [];
    mockSql.mockImplementationOnce((...args: unknown[]) => {
      updateValues = args.slice(1);
      return Promise.resolve([]);
    }); // enriched UPDATE

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    // Batched UPDATE array order:
    //   ids, peak, minToPeak, r30, r60, r120, eod, trail30
    const [, peak, minToPeak] = updateValues as number[][];
    // peak array element 0: numeric max 10.50 → +950% (not lexicographic 9.50).
    expect(peak![0]).toBeCloseTo(950, 5);
    // minToPeak array element 0: the 10.50 tick is 2 min after the 14:30 entry.
    expect(minToPeak![0]).toBeCloseTo(2, 5);
  });
});
