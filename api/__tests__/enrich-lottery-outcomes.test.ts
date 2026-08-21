// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';
import { KEPT_RETENTION_DAYS } from '../_lib/constants.js';

const {
  mockSql,
  mockCronGuard,
  mockFetchIntraday,
  mockSimulateInversion,
  mockMetricsIncrement,
} = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockCronGuard: vi.fn(),
  mockFetchIntraday: vi.fn(),
  mockSimulateInversion: vi.fn(),
  mockMetricsIncrement: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  // Real best-effort semantics: run the op, swallow any throw (so a prune
  // failure can never fail the cron). Mirrors the real safeDbVoid in db.ts.
  safeDbVoid: async (op: () => Promise<void>): Promise<void> => {
    try {
      await op();
    } catch {
      /* swallowed — db.error metric in the real impl */
    }
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
  metrics: { increment: mockMetricsIncrement },
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

vi.mock('../_lib/option-intraday.js', () => ({
  fetchAndCacheOptionIntraday: mockFetchIntraday,
}));

vi.mock('../_lib/flow-inversion.js', () => ({
  simulateFlowInversion: mockSimulateInversion,
}));

import handler, {
  ENRICH_WALL_BUDGET_MS,
} from '../cron/enrich-lottery-outcomes.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const GUARD = { apiKey: 'test-key', today: '2026-05-02' };

/**
 * The tagged-template mock receives the SQL string fragments as its first
 * arg (a TemplateStringsArray). Join them to match against the query text.
 */
function queryText(call: unknown[]): string {
  const strings = call[0];
  return Array.isArray(strings) ? strings.join('') : '';
}

/**
 * Find the retention-prune DELETE among all mockSql calls.
 *
 * NOTE: the neon tagged-template mock receives the SQL string fragments as
 * `call[0]` (a TemplateStringsArray) and each interpolated value as the
 * following positional args. The prune binds `KEPT_RETENTION_DAYS` as a
 * param, so the joined string text holds the structure (DELETE, the strict
 * `<` cutoff, the NY-date anchor, the `::int` cast on the param) while the
 * retention-days value lives in `call[1]`. We assert both sides here.
 *
 * This is the realistic binding under the mock harness — there is no real
 * Postgres, so we verify the generated SQL *shape* + the bound constant
 * rather than executing the DELETE. A future tightening of the cutoff
 * (strict `<` → `<=`, or KEPT_RETENTION_DAYS → 0) changes the asserted
 * shape/value and fails `asserts the strict-< retention cutoff` below.
 */
function findPruneCall(calls: unknown[][]): unknown[] | undefined {
  return calls.find((c) => {
    const text = queryText(c);
    return (
      text.includes('DELETE FROM lottery_kept_tickers') &&
      text.includes('trade_date') &&
      // Strict `<` cutoff is load-bearing: today's rows must survive so the
      // lottery-finder diff-skip can never drop a same-day kept ticker.
      text.includes('<') &&
      !text.includes('<=') &&
      text.includes("AT TIME ZONE 'America/New_York'") &&
      // date − integer (cast param) stays a date; no INTERVAL double-cast.
      text.includes('::int')
    );
  });
}

const baseFire = {
  id: 1,
  optionChainId: 'SPY260502C00500000',
  underlyingSymbol: 'SPY',
  optionType: 'C' as const,
  date: new Date('2026-05-02T00:00:00Z'),
  triggerTimeCt: new Date('2026-05-02T14:29:00Z'),
  entryTimeCt: new Date('2026-05-02T14:30:00Z'),
  entryPrice: 1.5,
  expiry: new Date('2026-05-02'),
};

describe('enrich-lottery-outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';
    mockCronGuard.mockReturnValue(GUARD);
    mockFetchIntraday.mockResolvedValue([]);
    mockSimulateInversion.mockReturnValue({
      exitPct: null,
      exitTs: null,
      status: 'no_post_trigger_prices',
    });
  });

  it('enriches fires with post-entry ticks and writes flow_inversion when computable', async () => {
    mockSql.mockResolvedValueOnce([baseFire]); // SELECT fires
    // ONE batched LATERAL read of ALL fires' ticks (keyed by fireId).
    mockSql.mockResolvedValueOnce([
      {
        fireId: 1,
        executedAt: new Date('2026-05-02T14:31:00Z'),
        price: 1.6,
      },
      {
        fireId: 1,
        executedAt: new Date('2026-05-02T14:32:00Z'),
        price: 1.8,
      },
      {
        fireId: 1,
        executedAt: new Date('2026-05-02T14:33:00Z'),
        price: 1.7,
      },
      {
        fireId: 1,
        executedAt: new Date('2026-05-02T14:40:00Z'),
        price: 1.9,
      },
    ]); // batched tick read
    mockSql.mockResolvedValueOnce([
      {
        ts: new Date('2026-05-02T14:35:00Z'),
        netCallPrem: '100',
        netPutPrem: '0',
      },
      {
        ts: new Date('2026-05-02T14:36:00Z'),
        netCallPrem: '-50',
        netPutPrem: '0',
      },
    ]); // loadMatchedFlow SELECT
    mockSql.mockResolvedValueOnce([]); // batched enriched UPDATE
    mockSql.mockResolvedValueOnce([]); // prune DELETE

    mockFetchIntraday.mockResolvedValueOnce([
      { ts: new Date('2026-05-02T14:31:00Z'), mid: 1.55 },
    ]);
    mockSimulateInversion.mockReturnValueOnce({
      exitPct: 12.5,
      exitTs: new Date('2026-05-02T14:45:00Z'),
      status: 'inversion',
    });

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      message: expect.stringContaining('flow_inversion populated 1'),
    });
    expect(mockFetchIntraday).toHaveBeenCalledWith(
      'test-key',
      'SPY260502C00500000',
      '2026-05-02',
    );
    expect(mockSimulateInversion).toHaveBeenCalled();
    // SELECT fires + batched tick read + loadMatchedFlow SELECT +
    // batched enriched UPDATE + retention-prune DELETE.
    expect(mockSql).toHaveBeenCalledTimes(5);

    // The retention prune ran, and ran AFTER the main work (it is the last
    // mockSql call — the batched UPDATE that lands enrichment is call index 3).
    const calls = mockSql.mock.calls;
    const pruneCall = findPruneCall(calls);
    expect(pruneCall).toBeDefined();
    expect(calls.indexOf(pruneCall!)).toBe(calls.length - 1);

    // Shape-assert the batched read (call index 1): ONE unnest + JOIN LATERAL,
    // keyed by fire id, ordered so each fire's ticks stay chronological. A
    // malformed batch (e.g. LEFT JOIN, missing ORDER BY, or a per-fire loop)
    // changes this text and fails here even when bind values look right.
    const readText = queryText(calls[1]!);
    expect(readText).toContain('unnest(');
    expect(readText).toContain('JOIN LATERAL');
    expect(readText).not.toContain('LEFT JOIN LATERAL');
    expect(readText).toContain('ON TRUE');
    expect(readText).toContain('ORDER BY u.fire_id');

    // Shape-assert the batched enriched UPDATE (call index 3): UPDATE ... FROM
    // unnest of the typed arrays, keyed by f.id = u.id — the gold-standard
    // batched-write form from evaluate-round-trip.ts.
    const updateText = queryText(calls[3]!);
    expect(updateText).toContain('UPDATE lottery_finder_fires');
    expect(updateText).toContain('FROM unnest(');
    expect(updateText).toContain('f.id = u.id');
    expect(updateText).toContain('realized_flow_inversion_pct = u.inv');
  });

  it('enriches when the driver returns fire.id as a STRING and unnest returns fireId as a NUMBER', async () => {
    // PRODUCTION REGRESSION (2026-08-17): the Neon driver returns
    // lottery_finder_fires.id (bigint) as a STRING ("601"), while the batched
    // read's `u.fire_id` comes from `unnest(...::int[])` and arrives as a
    // NUMBER (601). The tick Map is built from row.fireId but looked up by
    // fire.id, so `map.get("601")` missed `601` and EVERY fire was recorded
    // as "no post-entry ticks" — then terminally stamped, permanently voiding
    // its outcome labels. 600 fires were written off before this was caught.
    // Every other test in this file mocks BOTH sides as numbers, which is why
    // the batched-read refactor shipped green. Mirror production types here.
    const stringIdFire = { ...baseFire, id: '1' as unknown as number };
    mockSql.mockResolvedValueOnce([stringIdFire]); // SELECT fires
    mockSql.mockResolvedValueOnce([
      { fireId: 1, executedAt: new Date('2026-05-02T14:31:00Z'), price: 1.6 },
      { fireId: 1, executedAt: new Date('2026-05-02T14:33:00Z'), price: 3.0 },
    ]); // batched tick read — numeric fireId, as unnest ::int[] yields
    // No loadMatchedFlow SELECT: mockFetchIntraday returns [] (beforeEach), so
    // the flow-inversion path short-circuits before touching the DB. Queueing
    // an extra value here would leak into later tests — vi.clearAllMocks()
    // does not drain the mockResolvedValueOnce queue.
    mockSql.mockResolvedValueOnce([]); // batched enriched UPDATE
    mockSql.mockResolvedValueOnce([]); // prune DELETE

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    // The fire must be ENRICHED, not skipped as tickless.
    expect(res._json).toMatchObject({
      status: 'success',
      message: expect.stringContaining('Enriched 1'),
    });
    // Belt-and-braces: the old code produced "skipped 1 (no post-entry ticks)".
    expect(res._json).toMatchObject({
      message: expect.not.stringContaining('skipped 1'),
    });
  });

  it('chunks the tick read so one run never issues a single mega-query', async () => {
    // A busy fire carries ~2,900 post-entry ticks, so reading 300 fires in ONE
    // query returned ~880k rows (~80 MB), blew the 30s per-attempt budget,
    // exhausted withDbRetry (~93s) and 500ed the run. The read is chunked at
    // TICK_READ_CHUNK=30 fires. 70 fires must therefore issue 3 reads, not 1.
    const many = Array.from({ length: 70 }, (_, i) => ({
      ...baseFire,
      id: String(i + 1) as unknown as number, // driver returns bigint as string
      optionChainId: `SPY260502C0050${String(i).padStart(4, '0')}`,
    }));
    mockSql.mockResolvedValueOnce(many); // SELECT fires
    mockSql.mockResolvedValueOnce([]); // chunk 1 read (fires 1-30)
    mockSql.mockResolvedValueOnce([]); // chunk 2 read (fires 31-60)
    mockSql.mockResolvedValueOnce([]); // chunk 3 read (fires 61-70)
    mockSql.mockResolvedValueOnce([]); // no-tick terminal UPDATE
    mockSql.mockResolvedValueOnce([]); // prune DELETE

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    const reads = mockSql.mock.calls.filter((c) =>
      queryText(c).includes('JOIN LATERAL'),
    );
    expect(reads).toHaveLength(3);
  });

  it('batches a mixed run: one enriched fire + one no-tick fire → both writes fire, fires grouped by id', async () => {
    // The whole point of the N+1 collapse: process MANY fires in one batched
    // read + one enriched UPDATE + one no-tick UPDATE. Fire 1 has ticks (gets
    // enriched), fire 3 has none (gets the terminal stamp). The batched read
    // returns only fire 1's rows (JOIN LATERAL drops no-tick fires), so the
    // grouping must split correctly and BOTH writes must fire.
    const fire1 = { ...baseFire, id: 1, entryPrice: 1.0 };
    const fire3 = {
      ...baseFire,
      id: 3,
      optionChainId: 'SPY260502P00495000',
      optionType: 'P' as const,
      entryTimeCt: new Date('2026-05-02T20:59:00Z'),
      entryPrice: 0.5,
    };
    mockSql.mockResolvedValueOnce([fire1, fire3]); // SELECT fires (2)
    // Batched read: ONLY fire 1 appears (fire 3 has no post-entry ticks).
    mockSql.mockResolvedValueOnce([
      { fireId: 1, executedAt: new Date('2026-05-02T14:31:00Z'), price: 1.5 },
      { fireId: 1, executedAt: new Date('2026-05-02T14:33:00Z'), price: 2.0 },
    ]); // batched tick read

    let enrichedValues: unknown[] = [];
    mockSql.mockImplementationOnce((...args: unknown[]) => {
      enrichedValues = args.slice(1);
      return Promise.resolve([]);
    }); // batched enriched UPDATE
    let noTickValues: unknown[] = [];
    mockSql.mockImplementationOnce((...args: unknown[]) => {
      noTickValues = args.slice(1);
      return Promise.resolve([]);
    }); // no-tick UPDATE
    mockSql.mockResolvedValueOnce([]); // prune DELETE

    // fire 1's intraday returns no minutes → inversion skipped (no
    // loadMatchedFlow SELECT). Keeps the call sequence to exactly 5.
    mockFetchIntraday.mockResolvedValue([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      message: expect.stringMatching(/Enriched 1.*skipped 1/),
    });

    // SELECT fires + batched tick read + enriched UPDATE + no-tick UPDATE +
    // prune DELETE = 5 calls (NOT 1 read + 2 writes PER fire).
    expect(mockSql).toHaveBeenCalledTimes(5);

    // Enriched UPDATE arrays carry ONLY fire 1 (fire 3 is no-tick). ids[]
    // (index 0) → [1]; peak[] (index 6) element 0 → max 2.0 from entry 1.0 =
    // +100%; mtp[] (index 7) element 0 → 2.0 tick is 3 min after 14:30 entry.
    expect(enrichedValues[0]).toEqual([1]);
    expect((enrichedValues[6] as number[])[0]).toBeCloseTo(100, 5);
    expect((enrichedValues[7] as number[])[0]).toBeCloseTo(3, 5);

    // No-tick UPDATE binds fire 3's id as the int[] for ANY(...).
    expect(noTickValues).toEqual([[3]]);

    // The enriched fire's UW intraday was fetched; the no-tick fire's was NOT
    // (it short-circuits before the inversion step).
    expect(mockFetchIntraday).toHaveBeenCalledTimes(1);
    expect(mockFetchIntraday).toHaveBeenCalledWith(
      'test-key',
      'SPY260502C00500000',
      '2026-05-02',
    );
  });

  it('stamps a terminal enriched_at (NULL outcomes) on a no-tick fire so it exits the candidate set', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...baseFire,
        id: 2,
        optionChainId: 'SPY260502P00495000',
        optionType: 'P',
        entryTimeCt: new Date('2026-05-02T20:59:00Z'),
        entryPrice: 0.5,
      },
    ]);
    mockSql.mockResolvedValueOnce([]); // batched tick read — no fires appear

    // Capture the no-tick batched terminal UPDATE bind shape.
    let noTickUpdate: { text: string; values: unknown[] } | null = null;
    mockSql.mockImplementationOnce((...args: unknown[]) => {
      noTickUpdate = { text: queryText(args), values: args.slice(1) };
      return Promise.resolve([]);
    }); // no-tick UPDATE
    mockSql.mockResolvedValueOnce([]); // prune DELETE

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
    // SELECT fires + batched tick read + no-tick UPDATE + retention-prune DELETE.
    expect(mockSql).toHaveBeenCalledTimes(4);

    // The no-tick UPDATE stamps enriched_at = NOW() and touches NO realized
    // or peak columns (they stay NULL — a no-tick fire is NOT a 0% outcome).
    expect(noTickUpdate).not.toBeNull();
    const update = noTickUpdate!;
    expect(update.text).toContain('UPDATE lottery_finder_fires');
    expect(update.text).toContain('enriched_at = NOW()');
    expect(update.text).not.toContain('realized_');
    expect(update.text).not.toContain('peak_ceiling_pct');
    expect(update.text).not.toContain('minutes_to_peak');
    // The no-tick ids are bound as a single int[] array for the ANY(...)
    // WHERE clause — one no-tick fire → [[2]].
    expect(update.values).toEqual([[2]]);

    expect(findPruneCall(mockSql.mock.calls)).toBeDefined();
    expect(mockFetchIntraday).not.toHaveBeenCalled();
  });

  it('coerces string prices (un-cast NUMERIC) to a numerically correct peak', async () => {
    // Belt-and-suspenders for the SQL ::float8 cast: even if a future SELECT
    // drops the cast and Neon hands back NUMERIC-as-string, the function-level
    // Number() guard in peakCeiling/minutesToPeak must still pick the numeric
    // max. Tape: "9.50","10.50","8.00" — lexicographic max is "9.50"; the
    // numeric max is 10.50. Entry 1.0 → peak +950%, NOT +850%.
    mockSql.mockResolvedValueOnce([{ ...baseFire, entryPrice: 1.0 }]); // SELECT fires
    mockSql.mockResolvedValueOnce([
      {
        fireId: 1,
        executedAt: new Date('2026-05-02T14:31:00Z'),
        price: '9.50',
      },
      {
        fireId: 1,
        executedAt: new Date('2026-05-02T14:32:00Z'),
        price: '10.50',
      },
      {
        fireId: 1,
        executedAt: new Date('2026-05-02T14:33:00Z'),
        price: '8.00',
      },
    ]); // batched tick read (strings, as un-cast Neon returns)

    let updateValues: unknown[] = [];
    mockSql.mockImplementationOnce((...args: unknown[]) => {
      updateValues = args.slice(1);
      return Promise.resolve([]);
    }); // batched enriched UPDATE
    mockSql.mockResolvedValueOnce([]); // prune DELETE

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    // Batched UPDATE bind order (each bind is an ARRAY, one element per fire):
    //   ids[], trail[], hard[], tier[], eod[], inv[], peak[], mtp[]
    // peak[] is the 7th bind (index 6); element 0 → numeric max 10.50 → +950%.
    expect((updateValues[6] as number[])[0]).toBeCloseTo(950, 5);
    // mtp[] (index 7), element 0: the 10.50 tick is 2 min after the 14:30 entry.
    expect((updateValues[7] as number[])[0]).toBeCloseTo(2, 5);
  });

  it('returns early when no unenriched fires exist, but still prunes', async () => {
    mockSql.mockResolvedValueOnce([]); // SELECT fires (empty)
    mockSql.mockResolvedValueOnce([]); // prune DELETE

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

    // Even on the no-work early return, the retention prune still runs.
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(findPruneCall(mockSql.mock.calls)).toBeDefined();
  });

  it('still succeeds when the retention prune throws (best-effort)', async () => {
    mockSql.mockResolvedValueOnce([]); // SELECT fires (empty) → early return path
    // The prune DELETE rejects; safeDbVoid must swallow it so the handler
    // still returns success.
    mockSql.mockRejectedValueOnce(new Error('neon: connection reset'));

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
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(findPruneCall(mockSql.mock.calls)).toBeDefined();
  });

  // ── Never-vanish ↔ retention coupling (round-4 #1/#3/#5/#6) ──────────────
  // These bind the cross-file invariant that makes the lottery-finder
  // diff-skip safe: the retention floor is >= 1 trading day AND the prune
  // uses a strict `<` cutoff referencing KEPT_RETENTION_DAYS, so today's
  // rows always survive. A tightening to `<=`, to today, or to 0 fails here.

  it('keeps KEPT_RETENTION_DAYS >= 1 (never-vanish current-day floor)', () => {
    expect(KEPT_RETENTION_DAYS).toBeGreaterThanOrEqual(1);
  });

  it('prunes with a strict-< cutoff that binds KEPT_RETENTION_DAYS as the day count', async () => {
    mockSql.mockResolvedValueOnce([]); // SELECT fires (empty) → prune path
    mockSql.mockResolvedValueOnce([]); // prune DELETE

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    const pruneCall = findPruneCall(mockSql.mock.calls);
    expect(pruneCall).toBeDefined();

    // findPruneCall already asserts `<` present and `<=` absent in the SQL
    // string. The retention-days value is bound as the first interpolated
    // param (call[1]) — assert it equals the constant, so a future change to
    // the constant flows through here and a `<=`/today tightening fails above.
    expect(pruneCall![1]).toBe(KEPT_RETENTION_DAYS);
  });

  it('emits the lottery.kept_prune heartbeat metric on a successful prune', async () => {
    mockSql.mockResolvedValueOnce([]); // SELECT fires (empty) → prune path
    mockSql.mockResolvedValueOnce([]); // prune DELETE succeeds

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(mockMetricsIncrement).toHaveBeenCalledWith('lottery.kept_prune');
  });

  it('soft-degrades when simulateFlowInversion throws: still UPDATEs other realized fields with flowInversion null', async () => {
    // The flow-inversion step is wrapped in try/catch (enrich-lottery-outcomes.ts
    // :268-297). A throw there must NOT abort the fire's enrichment — the
    // realized_* and peak columns still land, only realized_flow_inversion_pct
    // stays NULL. Verify the UPDATE bind shape: index 4 (flowInversion) is null,
    // the other realized binds + peak are real numbers, enriched_at stamped.
    mockSql.mockResolvedValueOnce([{ ...baseFire, entryPrice: 1.0 }]); // SELECT fires
    mockSql.mockResolvedValueOnce([
      { fireId: 1, executedAt: new Date('2026-05-02T14:31:00Z'), price: 1.5 },
      { fireId: 1, executedAt: new Date('2026-05-02T14:33:00Z'), price: 2.0 },
      { fireId: 1, executedAt: new Date('2026-05-02T14:40:00Z'), price: 1.7 },
    ]); // batched tick read
    mockSql.mockResolvedValueOnce([
      {
        ts: new Date('2026-05-02T14:35:00Z'),
        netCallPrem: '100',
        netPutPrem: '0',
      },
    ]); // loadMatchedFlow SELECT (minutes.length>0 enters the inversion path)

    let updateValues: unknown[] = [];
    mockSql.mockImplementationOnce((...args: unknown[]) => {
      updateValues = args.slice(1);
      return Promise.resolve([]);
    }); // batched enriched UPDATE
    mockSql.mockResolvedValueOnce([]); // prune DELETE

    // Intraday returns minutes (so the inversion path is entered), then the
    // simulator throws — the catch swallows it and the column stays null.
    mockFetchIntraday.mockResolvedValueOnce([
      { ts: new Date('2026-05-02T14:31:00Z'), mid: 1.55 },
    ]);
    mockSimulateInversion.mockImplementationOnce(() => {
      throw new Error('flow-inversion: matched-flow alignment failed');
    });

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    // Enrichment still landed (1 enriched), flow_inversion populated 0.
    expect(res._json).toMatchObject({
      status: 'success',
      message: expect.stringContaining('flow_inversion populated 0'),
    });
    expect(mockSimulateInversion).toHaveBeenCalled();

    // Batched UPDATE bind order (each bind is an ARRAY, one element per fire):
    //   ids[], trail[], hard[], tier[], eod[], inv[], peak[], mtp[]
    // inv[] (index 5), element 0 MUST be null — the throw degraded only it.
    // unnest passes the null element straight through to the column.
    expect((updateValues[5] as (number | null)[])[0]).toBeNull();
    // The other realized fields + peak are real numbers (enrichment landed).
    // peak[] (index 6), element 0: max tick 2.0 from entry 1.0 → +100%.
    expect((updateValues[6] as number[])[0]).toBeCloseTo(100, 5);
    // mtp[] (index 7), element 0: the 2.0 tick is 3 min after the 14:30 entry.
    expect((updateValues[7] as number[])[0]).toBeCloseTo(3, 5);
    // ids[] (index 0), element 0 is the fire id targeted by the WHERE clause.
    expect((updateValues[0] as number[])[0]).toBe(baseFire.id);
  });

  // ── dateToIso parity: Date object vs YYYY-MM-DD string ────────────────────
  // Neon returns DATE columns as a Date when the SELECT has no explicit cast;
  // a backfill or test fixture might pass a 'YYYY-MM-DD' string. dateToIso
  // (enrich-lottery-outcomes.ts:74) must normalize BOTH to the same ISO date,
  // since the result is fed to fetchAndCacheOptionIntraday. dateToIso is
  // private, so we observe it through the mocked fetchAndCacheOptionIntraday
  // call's 3rd arg.
  it('dateToIso normalizes a Date column input to the same ISO as a string input', async () => {
    async function captureDateStrFor(dateCol: Date | string): Promise<string> {
      mockSql.mockResolvedValueOnce([{ ...baseFire, date: dateCol }]); // SELECT fires
      mockSql.mockResolvedValueOnce([
        { fireId: 1, executedAt: new Date('2026-05-02T14:31:00Z'), price: 1.6 },
      ]); // batched tick read
      mockSql.mockResolvedValueOnce([]); // batched enriched UPDATE
      mockSql.mockResolvedValueOnce([]); // prune DELETE
      mockFetchIntraday.mockResolvedValueOnce([]); // no minutes → inversion skipped

      const req = mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      });
      const res = mockResponse();
      await handler(req, res);
      expect(res._status).toBe(200);
      const [, , dateStr] = mockFetchIntraday.mock.calls.at(-1) as [
        string,
        string,
        string,
      ];
      return dateStr;
    }

    // Neon-returns-DATE-as-Date: UTC midnight Date for 2026-05-02.
    const fromDate = await captureDateStrFor(new Date('2026-05-02T00:00:00Z'));
    vi.clearAllMocks();
    mockCronGuard.mockReturnValue(GUARD);
    // Backfill / fixture string path.
    const fromString = await captureDateStrFor('2026-05-02');

    expect(fromDate).toBe('2026-05-02');
    expect(fromString).toBe('2026-05-02');
    expect(fromDate).toBe(fromString);
  });

  it('does NOT emit the heartbeat when the prune DELETE throws', async () => {
    mockSql.mockResolvedValueOnce([]); // SELECT fires (empty) → prune path
    mockSql.mockRejectedValueOnce(new Error('neon: connection reset'));

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    // safeDbVoid swallows the throw before the metric line runs, so the
    // heartbeat correctly stays flat — exactly the missing-prune signal.
    expect(res._status).toBe(200);
    expect(mockMetricsIncrement).not.toHaveBeenCalledWith('lottery.kept_prune');
  });

  // ── Loop-until-budget (readiness-loose-ends-2026-08-18, phase A) ──────────
  // Fires/day are 3.6k–5.3k since the uw-stream universe expansion. One run
  // now drains batches of 300 (oldest first) until the SELECT comes back short
  // or empty, OR the wall budget (ENRICH_WALL_BUDGET_MS, under the 300s
  // maxDuration) is exceeded — leftovers roll to the next 5-min run.
  describe('loop-until-budget', () => {
    beforeEach(() => {
      // These tests queue long mockResolvedValueOnce sequences. Reset the
      // SQL mock's once-queue so a value left over from an earlier failure
      // can't be consumed as this test's first SELECT and cascade.
      mockSql.mockReset();
    });

    /** N unenriched fires with driver-realistic STRING ids + unique chains. */
    function makeFires(from: number, count: number) {
      return Array.from({ length: count }, (_, i) => ({
        ...baseFire,
        id: String(from + i) as unknown as number,
        optionChainId: `SPY260502C${String(from + i).padStart(8, '0')}`,
      }));
    }

    /** The per-batch candidate SELECTs (enriched_at IS NULL ... LIMIT). */
    function selectCalls(): unknown[][] {
      return mockSql.mock.calls.filter((c) => {
        const t = queryText(c);
        return (
          t.includes('FROM lottery_finder_fires') &&
          t.includes('enriched_at IS NULL')
        );
      });
    }

    /** The batched tick reads (one per 30-fire chunk). */
    function tickReadCalls(): unknown[][] {
      return mockSql.mock.calls.filter((c) =>
        queryText(c).includes('JOIN LATERAL'),
      );
    }

    /** The no-tick terminal-stamp UPDATEs (one per batch, when any). */
    function noTickUpdateCalls(): unknown[][] {
      return mockSql.mock.calls.filter((c) => {
        const t = queryText(c);
        return t.includes('SET enriched_at = NOW()') && t.includes('ANY(');
      });
    }

    function run() {
      const req = mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      });
      const res = mockResponse();
      return handler(req, res).then(() => res);
    }

    /**
     * Inject a controllable clock. The handler reads Date.now() for the
     * wall budget; tests advance `nowMs` from inside a mocked DB/UW call
     * to simulate a slow batch without sleeping. Restored per test.
     */
    function fakeClock() {
      const state = { nowMs: 1_700_000_000_000 };
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => state.nowMs);
      return {
        state,
        advancePastBudget: () => {
          state.nowMs += ENRICH_WALL_BUDGET_MS + 1;
        },
        restore: () => spy.mockRestore(),
      };
    }

    it('pins the wall budget under the Vercel maxDuration for this function', () => {
      expect(ENRICH_WALL_BUDGET_MS).toBe(240_000);
      const cfg = JSON.parse(
        readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'),
      ) as {
        functions?: Record<string, { maxDuration?: number }>;
        crons?: { path: string; schedule: string }[];
      };
      const maxDuration =
        cfg.functions?.['api/cron/enrich-lottery-outcomes.ts']?.maxDuration;
      expect(maxDuration).toBeDefined();
      // Leave headroom for one in-flight fire + the two flush writes + prune.
      expect(ENRICH_WALL_BUDGET_MS).toBeLessThanOrEqual(
        maxDuration! * 1000 - 60_000,
      );
      // Post-close every-5-min cadence: 21:40–21:55 then 22:00–23:55 UTC.
      const windows = (cfg.crons ?? [])
        .filter((c) => c.path === '/api/cron/enrich-lottery-outcomes')
        .map((c) => c.schedule);
      expect(windows).toEqual(['40-59/5 21 * * 1-5', '*/5 22-23 * * 1-5']);
    });

    it('drains multiple batches: a full batch of 300 triggers a second SELECT; a short batch ends the loop', async () => {
      mockSql.mockResolvedValueOnce(makeFires(1, 300)); // batch 1 SELECT (full)
      for (let i = 0; i < 10; i++) mockSql.mockResolvedValueOnce([]); // 10 chunk reads
      mockSql.mockResolvedValueOnce([]); // batch 1 no-tick UPDATE
      mockSql.mockResolvedValueOnce(makeFires(301, 2)); // batch 2 SELECT (short → last)
      mockSql.mockResolvedValueOnce([]); // batch 2 chunk read
      mockSql.mockResolvedValueOnce([]); // batch 2 no-tick UPDATE
      mockSql.mockResolvedValueOnce([]); // prune DELETE

      const res = await run();

      expect(res._status).toBe(200);
      expect(selectCalls()).toHaveLength(2);
      expect(tickReadCalls()).toHaveLength(11);
      expect(noTickUpdateCalls()).toHaveLength(2);
      // 2 SELECTs + 11 chunk reads + 2 no-tick UPDATEs + prune = 16, and no
      // third SELECT: the 2-row batch (< 300) is the last one.
      expect(mockSql).toHaveBeenCalledTimes(16);
      expect(res._json).toMatchObject({
        status: 'success',
        batches: 2,
        enriched: 0,
        skipped: 302,
        inversionFilled: 0,
        budgetHit: false,
        message: expect.stringMatching(/2 batches/),
      });
      expect(res._json).toMatchObject({
        message: expect.stringContaining('skipped 302'),
      });
      // Batch 2's terminal stamp binds ONLY its own two fires.
      const [, second] = noTickUpdateCalls();
      expect((second![1] as unknown[]).map(Number)).toEqual([301, 302]);
      // The prune still runs exactly once, last.
      const calls = mockSql.mock.calls;
      const pruneCall = findPruneCall(calls);
      expect(pruneCall).toBeDefined();
      expect(calls.indexOf(pruneCall!)).toBe(calls.length - 1);
    });

    it('stops when the SELECT after a full batch comes back empty', async () => {
      mockSql.mockResolvedValueOnce(makeFires(1, 300)); // batch 1 SELECT (full)
      for (let i = 0; i < 10; i++) mockSql.mockResolvedValueOnce([]); // 10 chunk reads
      mockSql.mockResolvedValueOnce([]); // batch 1 no-tick UPDATE
      mockSql.mockResolvedValueOnce([]); // batch 2 SELECT (empty → done)
      mockSql.mockResolvedValueOnce([]); // prune DELETE

      const res = await run();

      expect(res._status).toBe(200);
      expect(selectCalls()).toHaveLength(2);
      expect(mockSql).toHaveBeenCalledTimes(14);
      expect(res._json).toMatchObject({
        status: 'success',
        batches: 1,
        skipped: 300,
        budgetHit: false,
        message: expect.stringMatching(/1 batch\b/),
      });
    });

    it('stops between batches once the wall budget is exceeded (no further SELECT)', async () => {
      const clock = fakeClock();
      try {
        mockSql.mockResolvedValueOnce(makeFires(1, 300)); // batch 1 SELECT (full)
        for (let i = 0; i < 10; i++) mockSql.mockResolvedValueOnce([]); // 10 chunk reads
        // The batch-1 flush is "slow": the clock jumps past the budget.
        mockSql.mockImplementationOnce(() => {
          clock.advancePastBudget();
          return Promise.resolve([]);
        }); // batch 1 no-tick UPDATE
        mockSql.mockResolvedValueOnce([]); // prune DELETE

        const res = await run();

        expect(res._status).toBe(200);
        // A full batch would normally trigger another SELECT — the budget
        // check at the top of the loop must stop it.
        expect(selectCalls()).toHaveLength(1);
        expect(mockSql).toHaveBeenCalledTimes(13);
        expect(res._json).toMatchObject({
          status: 'success',
          batches: 1,
          skipped: 300,
          budgetHit: true,
          message: expect.stringContaining('wall budget'),
        });
        expect(findPruneCall(mockSql.mock.calls)).toBeDefined();
      } finally {
        clock.restore();
      }
    });

    it('stops mid-batch once the wall budget is exceeded, flushing only the fires already processed', async () => {
      const clock = fakeClock();
      try {
        const fire1 = { ...baseFire, id: 1, entryPrice: 1.0 };
        const fire2 = {
          ...baseFire,
          id: 2,
          optionChainId: 'SPY260502C00505000',
          entryPrice: 1.0,
        };
        mockSql.mockResolvedValueOnce([fire1, fire2]); // SELECT fires
        mockSql.mockResolvedValueOnce([
          {
            fireId: 1,
            executedAt: new Date('2026-05-02T14:31:00Z'),
            price: 1.5,
          },
          {
            fireId: 2,
            executedAt: new Date('2026-05-02T14:31:00Z'),
            price: 1.2,
          },
        ]); // batched tick read (both fires have ticks)
        let updateIds: unknown[] = [];
        mockSql.mockImplementationOnce((...args: unknown[]) => {
          updateIds = args[1] as unknown[];
          return Promise.resolve([]);
        }); // batched enriched UPDATE
        mockSql.mockResolvedValueOnce([]); // prune DELETE

        // Fire 1's UW intraday call is "slow": the clock jumps past the
        // budget while it is in flight. Fire 2 must NOT be started.
        mockFetchIntraday.mockImplementationOnce(() => {
          clock.advancePastBudget();
          return Promise.resolve([]);
        });

        const res = await run();

        expect(res._status).toBe(200);
        expect(mockFetchIntraday).toHaveBeenCalledTimes(1);
        expect(updateIds).toEqual([1]);
        // Fire 2 is neither enriched nor stamped no-tick — it stays
        // enriched_at IS NULL and rolls to the next run.
        expect(noTickUpdateCalls()).toHaveLength(0);
        expect(mockSql).toHaveBeenCalledTimes(4);
        expect(res._json).toMatchObject({
          status: 'success',
          batches: 1,
          enriched: 1,
          skipped: 0,
          budgetHit: true,
          message: expect.stringContaining('wall budget'),
        });
      } finally {
        clock.restore();
      }
    });

    it('stops between tick-read chunks once the wall budget is exceeded: no further reads, nothing stamped', async () => {
      const clock = fakeClock();
      try {
        mockSql.mockResolvedValueOnce(makeFires(1, 70)); // SELECT fires (3 chunks)
        // Chunk 1 read is "slow": the clock jumps past the budget. Chunks 2
        // and 3 must not be read. Fires 31-70 were never looked at, so they
        // must NOT be stamped no-tick (that would permanently void their
        // labels) — and once the budget has tripped, no fire is processed:
        // the whole batch rolls to the next run. Only the prune follows.
        mockSql.mockImplementationOnce(() => {
          clock.advancePastBudget();
          return Promise.resolve([]);
        }); // chunk 1 read (fires 1-30, no ticks)
        mockSql.mockResolvedValueOnce([]); // prune DELETE

        const res = await run();

        expect(res._status).toBe(200);
        expect(tickReadCalls()).toHaveLength(1);
        expect(noTickUpdateCalls()).toHaveLength(0);
        expect(mockFetchIntraday).not.toHaveBeenCalled();
        // SELECT + chunk 1 read + prune — no UPDATE of any kind.
        expect(mockSql).toHaveBeenCalledTimes(3);
        expect(findPruneCall(mockSql.mock.calls)).toBeDefined();
        expect(res._json).toMatchObject({
          status: 'success',
          batches: 1,
          enriched: 0,
          skipped: 0,
          budgetHit: true,
          message: expect.stringContaining('wall budget'),
        });
      } finally {
        clock.restore();
      }
    });

    it('does not spin when a batch re-selects fires already processed this run', async () => {
      // Every fire in a batch is either enriched or stamped no-tick, so a
      // second SELECT can only return the same rows if the stamp did not
      // land. Guard: a batch with no unseen fires ends the loop (no third
      // SELECT, no second UPDATE) instead of looping forever.
      const same = makeFires(1, 300);
      mockSql.mockResolvedValueOnce(same); // batch 1 SELECT (full)
      for (let i = 0; i < 10; i++) mockSql.mockResolvedValueOnce([]); // 10 chunk reads
      mockSql.mockResolvedValueOnce([]); // batch 1 no-tick UPDATE
      mockSql.mockResolvedValueOnce(same); // batch 2 SELECT → all already seen
      mockSql.mockResolvedValueOnce([]); // prune DELETE

      const res = await run();

      expect(res._status).toBe(200);
      expect(selectCalls()).toHaveLength(2);
      expect(tickReadCalls()).toHaveLength(10);
      expect(noTickUpdateCalls()).toHaveLength(1);
      expect(mockSql).toHaveBeenCalledTimes(14);
      expect(res._json).toMatchObject({
        status: 'success',
        batches: 1,
        skipped: 300,
      });
    });
  });
});
