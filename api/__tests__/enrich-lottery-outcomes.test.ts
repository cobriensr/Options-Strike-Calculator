// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';
import {
  KEPT_RETENTION_DAYS,
  WS_OPTION_TRADES_RETENTION_DAYS,
} from '../_lib/constants.js';
import { READ_CHUNK_SIZE } from '../_lib/option-outcome-aggregate.js';

const {
  mockSql,
  mockCronGuard,
  mockMetricsIncrement,
  mockCaptureMessage,
  mockCaptureException,
} = vi.hoisted(() => {
  const tagged = vi.fn();
  return {
    mockSql: Object.assign(tagged, { query: vi.fn() }),
    mockCronGuard: vi.fn(),
    mockMetricsIncrement: vi.fn(),
    mockCaptureMessage: vi.fn(),
    mockCaptureException: vi.fn(),
  };
});

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  TransientDbError: class TransientDbError extends Error {},
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
  Sentry: {
    captureException: mockCaptureException,
    captureMessage: mockCaptureMessage,
    setTag: vi.fn(),
  },
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

import handler from '../cron/enrich-lottery-outcomes.js';
import { TransientDbError } from '../_lib/db.js';

const GUARD = { apiKey: 'test-key', today: '2026-10-01' };

/** 21:40 UTC on 2026-10-01 (EDT): past the 20:20Z settle instant. */
const RUN_AT = '2026-10-01T21:40:00Z';

type Row = Record<string, unknown>;

/** A tape candidate as the driver returns it (int8 id as a string). */
function fire(id: number, chain = `AAA261002C${String(id).padStart(8, '0')}`) {
  return {
    id: String(id),
    chain,
    ticker: chain.slice(0, 3),
    date: '2026-10-01',
    entry: new Date('2026-10-01T14:00:00Z'),
    entryPx: 1,
  };
}

/** A healthy priced aggregate for fire `id` (entry 1.00). */
function agg(id: number, o: Row = {}): Row {
  return {
    window_id: String(id),
    tape_live: true,
    ticks: 40,
    peak_px: 2,
    peak_minutes: 12.5,
    last_px: 1.2,
    h30_px: 1.5,
    h60_px: 1.4,
    h120_px: 1.3,
    tier1_px: 1.6,
    trail_exit_px: 1.4,
    ...o,
  };
}

interface Router {
  tapeCandidates?: Row[];
  /** Rows the aggregate query returns, or a function of its window ids. */
  aggregate?: (ids: number[]) => Row[] | Promise<Row[]>;
  /** Ids an outcome UPDATE reports as locked (default: all of them). */
  lockReturns?: (ids: number[]) => number[] | Promise<number[]>;
  prune?: () => Promise<Row[]>;
  /** Empty 5-min buckets the continuity probe reports. */
  gaps?: Row[];
  /** Override the candidate SELECT (e.g. to reject). */
  tapeSelect?: () => Promise<Row[]>;
}

const text = (call: unknown[]): string => {
  const strings = call[0];
  return Array.isArray(strings) ? strings.join(' ') : '';
};

/** Route every tagged query by its SQL text (order-independent). */
function route(r: Router): void {
  mockSql.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sqlText = strings.join(' ');
      if (sqlText.includes('DELETE FROM lottery_kept_tickers')) {
        return r.prune ? r.prune() : [];
      }
      if (sqlText.includes('UPDATE lottery_finder_fires')) {
        const ids = (values[0] as number[]) ?? [];
        const locked = await (r.lockReturns ?? ((x) => x))(ids);
        return locked.map((id) => ({ id: String(id) }));
      }
      if (sqlText.includes('WHERE enriched_at IS NULL')) {
        return r.tapeSelect ? r.tapeSelect() : (r.tapeCandidates ?? []);
      }
      throw new Error(`unrouted SQL: ${sqlText.slice(0, 80)}`);
    },
  );
  mockSql.query.mockImplementation(
    async (sqlText: string, params: unknown[]) =>
      sqlText.includes('generate_series')
        ? (r.gaps ?? [])
        : (r.aggregate ?? (() => []))(params[0] as number[]),
  );
}

/** The per-fire aggregate statements (not the continuity probe). */
const aggregateCalls = (): Array<[string, unknown[]]> =>
  (mockSql.query.mock.calls as Array<[string, unknown[]]>).filter(
    (c) => !c[0].includes('generate_series'),
  );

const callsMatching = (needle: string): unknown[][] =>
  mockSql.mock.calls.filter((c) => text(c).includes(needle));

/** The outcome UPDATE's unnest arrays: ids, trail, hard, tier, eod, peak, mtp. */
const lockCalls = () => callsMatching('enriched_at = NOW()');

async function run() {
  const res = mockResponse();
  await handler(mockRequest({ method: 'GET' }), res);
  return res;
}

function findPruneCall(calls: unknown[][]): unknown[] | undefined {
  return calls.find((c) => {
    const t = text(c);
    return (
      t.includes('DELETE FROM lottery_kept_tickers') &&
      t.includes('trade_date') &&
      // Strict `<` cutoff is load-bearing: today's rows must survive so the
      // lottery-finder diff-skip can never drop a same-day kept ticker.
      t.includes('<') &&
      !t.includes('<=') &&
      t.includes("AT TIME ZONE 'America/New_York'") &&
      t.includes('::int')
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockReset();
  mockSql.query.mockReset();
  mockCronGuard.mockReturnValue(GUARD);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(RUN_AT));
  route({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('enrich-lottery-outcomes: tape pass', () => {
  it('selects only fires inside the retention window, newest first, with an index-friendly ET date bound', async () => {
    await run();

    const [call] = callsMatching('WHERE enriched_at IS NULL');
    const sqlText = text(call!).replaceAll(/\s+/g, ' ');
    expect(sqlText).toContain(
      'trigger_time_ct >= NOW() - make_interval(days => ::int)',
    );
    expect(sqlText).toContain(
      "date >= ((NOW() - make_interval(days => ::int)) AT TIME ZONE 'America/New_York')::date",
    );
    expect(sqlText).toContain('ORDER BY trigger_time_ct DESC');
    expect(sqlText).not.toContain('ASC');
    expect(sqlText).not.toContain('inserted_at');
    expect(call!.slice(1)).toEqual([
      WS_OPTION_TRADES_RETENTION_DAYS,
      WS_OPTION_TRADES_RETENTION_DAYS,
    ]);
  });

  it('locks a settled fire with every exit policy computed from its aggregate', async () => {
    route({ tapeCandidates: [fire(1)], aggregate: () => [agg(1)] });

    const res = await run();

    expect(res._json).toMatchObject({ status: 'success', rows: 1, updated: 1 });
    const [lock] = lockCalls();
    const [ids, trail, hard, tier, eod, peak, mtp] = lock!.slice(
      1,
    ) as number[][];
    expect(ids).toEqual([1]);
    expect(trail![0]).toBeCloseTo(40, 9); // trail exit 1.40
    expect(hard![0]).toBeCloseTo(50, 9); // last print <= +30 min
    expect(tier![0]).toBeCloseTo((60 + 20) / 2, 9);
    expect(eod![0]).toBeCloseTo(20, 9);
    expect(peak![0]).toBeCloseTo(100, 9);
    expect(mtp![0]).toBe(12.5);
    // Conditional, bigint-typed write: an overlapping run cannot re-lock.
    const lockText = text(lock!);
    expect(lockText).toContain('AND f.enriched_at IS NULL');
    expect(lockText).toContain('RETURNING f.id');
    expect(lock![0] as string[]).toSatisfy((s: string[]) =>
      s[1]!.startsWith('::bigint[]'),
    );
  });

  it('tags the lock as a provisional feed write: outcome_source ws_cron, outcome_version 1', async () => {
    route({ tapeCandidates: [fire(1)], aggregate: () => [agg(1)] });

    await run();

    const lockText = text(lockCalls()[0]!).replaceAll(/\s+/g, ' ');
    expect(lockText).toContain("outcome_source = 'ws_cron'");
    expect(lockText).toContain('outcome_version = 1');
  });

  it('writes no flow inversion and reports no inversion metadata (the nightly tape pass owns the column)', async () => {
    route({ tapeCandidates: [fire(1)], aggregate: () => [agg(1)] });

    const res = await run();

    const statements = [
      ...mockSql.mock.calls.map(text),
      ...(mockSql.query.mock.calls as Array<[string, unknown[]]>).map(
        (c) => c[0],
      ),
    ];
    expect(statements.length).toBeGreaterThan(0);
    expect(
      statements.filter((s) =>
        /realized_flow_inversion_pct|option_intraday|net_flow_per_ticker_history/.test(
          s,
        ),
      ),
    ).toEqual([]);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      updated: 1,
    });
    expect(res._json).not.toHaveProperty('inversion');
  });

  it('needs no UW key: it only reads and writes the database', async () => {
    await run();

    expect(mockCronGuard).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ marketHours: false, requireApiKey: false }),
    );
  });

  it('reads the tape with an explicit upper bound at close + 15 min and a close-tail liveness window', async () => {
    route({ tapeCandidates: [fire(1)], aggregate: () => [agg(1)] });

    await run();

    const [sqlText, params] = aggregateCalls()[0] as [string, unknown[]];
    expect(sqlText).toContain('t.executed_at <= u.tape_end');
    expect(params[3]).toEqual(['2026-10-01T14:00:00.000Z']); // entry
    expect(params[5]).toEqual(['2026-10-01T20:15:00.000Z']); // tape end
    expect(params[6]).toEqual(['2026-10-01T19:50:00.000Z']); // tail start
  });

  it('leaves fires whose session has not settled unread (settle gate)', async () => {
    // 20:10Z: the 16:00 ET close has passed but late ETF prints and the
    // ingest grace have not; nothing may be read or locked yet.
    vi.setSystemTime(new Date('2026-10-01T20:10:00Z'));
    route({ tapeCandidates: [fire(1)], aggregate: () => [agg(1)] });

    const res = await run();

    expect(mockSql.query).not.toHaveBeenCalled();
    expect(lockCalls()).toHaveLength(0);
    expect(res._json).toMatchObject({ status: 'success', inFlight: 1 });
  });

  it('never stamps a fire whose ticker tape went quiet at the close: tapeGap → error + Sentry', async () => {
    route({
      tapeCandidates: [fire(1), fire(2)],
      aggregate: () => [agg(1, { tape_live: false }), agg(2)],
    });

    const res = await run();

    const [lock] = lockCalls();
    expect(lock![1]).toEqual([2]); // only the healthy fire is locked
    expect(res._json).toMatchObject({
      status: 'error',
      rows: 1,
      tapeGap: 1,
    });
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage.mock.calls[0]![1]).toMatchObject({
      level: 'warning',
      fingerprint: ['enrich-lottery-outcomes', 'missing-tape'],
      extra: { tapeGapIds: [1], noPrintsIds: [] },
    });
  });

  it('never stamps a fire with no print on its contract: noPrints → partial + Sentry', async () => {
    route({
      tapeCandidates: [fire(3)],
      aggregate: () => [
        agg(3, {
          ticks: 0,
          peak_px: null,
          peak_minutes: null,
          last_px: null,
          h30_px: null,
          h60_px: null,
          h120_px: null,
          tier1_px: null,
          trail_exit_px: null,
        }),
      ],
    });

    const res = await run();

    expect(lockCalls()).toHaveLength(0);
    expect(res._json).toMatchObject({ status: 'partial', noPrints: 1 });
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it('does not lock a missing or malformed aggregate row (unreadable → partial)', async () => {
    route({
      tapeCandidates: [fire(1), fire(2), fire(3)],
      // fire 2: last print NULL despite ticks; fire 3: no row at all.
      aggregate: () => [agg(1), agg(2, { last_px: null })],
    });

    const res = await run();

    expect(lockCalls()[0]![1]).toEqual([1]);
    expect(res._json).toMatchObject({ status: 'partial', unreadable: 2 });
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage.mock.calls[0]![1]).toMatchObject({
      fingerprint: ['enrich-lottery-outcomes', 'unreadable-aggregate'],
      extra: { unreadableIds: [2, 3] },
    });
  });

  it('matches aggregates to fires when the driver returns int8 ids as strings (06-12 regression)', async () => {
    // The old cron keyed ticks by an int4 number and looked them up with the
    // bigint STRING id, so every fire looked tick-less and was stamped NULL.
    route({ tapeCandidates: [fire(969642)], aggregate: () => [agg(969642)] });

    const res = await run();

    expect(lockCalls()[0]![1]).toEqual([969642]);
    expect(res._json).toMatchObject({ status: 'success', updated: 1 });
  });

  it('reads a chain’s fires in one aggregate statement and writes them in one UPDATE', async () => {
    const chainA = 'AAA261002C00100000';
    const chainB = 'BBB261002C00050000';
    route({
      tapeCandidates: [fire(1, chainA), fire(2, chainB), fire(3, chainA)],
      aggregate: (ids) => ids.map((id) => agg(id)),
    });

    await run();

    expect(aggregateCalls()).toHaveLength(1);
    const params = aggregateCalls()[0]![1];
    // Chain-grouped (newest group first), so chain A's two fires sit together.
    expect(params[0]).toEqual([1, 3, 2]);
    expect(params[1]).toEqual([chainA, chainA, chainB]);
    expect(lockCalls()).toHaveLength(1);
    expect(lockCalls()[0]![1]).toEqual([1, 3, 2]);
  });

  it('splits work into READ_CHUNK_SIZE statements', async () => {
    const fires = Array.from({ length: READ_CHUNK_SIZE + 20 }, (_, i) =>
      fire(i + 1),
    );
    route({
      tapeCandidates: fires,
      aggregate: (ids) => ids.map((id) => agg(id)),
    });

    const res = await run();

    expect(aggregateCalls()).toHaveLength(2);
    expect((aggregateCalls()[0]![1] as unknown[][])[0]).toHaveLength(
      READ_CHUNK_SIZE,
    );
    expect(res._json).toMatchObject({ updated: READ_CHUNK_SIZE + 20 });
  });

  it('starts no chunk after the tape budget and defers the rest to the next run', async () => {
    const fires = Array.from({ length: READ_CHUNK_SIZE + 5 }, (_, i) =>
      fire(i + 1),
    );
    route({
      tapeCandidates: fires,
      aggregate: (ids) => {
        // The first chunk is slow: 190 s of the run are gone afterwards.
        vi.setSystemTime(new Date(Date.parse(RUN_AT) + 190_000));
        return ids.map((id) => agg(id));
      },
    });

    const res = await run();

    expect(aggregateCalls()).toHaveLength(1);
    expect(res._json).toMatchObject({
      status: 'success',
      updated: READ_CHUNK_SIZE,
      deferred: 5,
    });
  });

  it('counts fires an overlapping run already locked without failing', async () => {
    route({
      tapeCandidates: [fire(1), fire(2)],
      aggregate: (ids) => ids.map((id) => agg(id)),
      lockReturns: () => [1],
    });

    const res = await run();

    expect(res._json).toMatchObject({
      status: 'success',
      updated: 1,
      alreadyLocked: 1,
    });
  });

  it('surfaces a DB reject on the aggregate read (500) and still reports earlier missing-tape fires', async () => {
    const chainA = 'AAA261002C00100000';
    const fires = [
      fire(1, chainA),
      ...Array.from({ length: READ_CHUNK_SIZE }, (_, i) => fire(i + 2)),
    ];
    let reads = 0;
    route({
      tapeCandidates: fires,
      aggregate: (ids) => {
        reads += 1;
        if (reads === 2) throw new Error('neon: connection reset');
        return ids.map((id) => agg(id, { tape_live: id !== 1 }));
      },
    });

    const res = await run();

    expect(res._status).toBe(500);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1); // fire 1, chunk 1
    expect(lockCalls()).toHaveLength(1); // chunk 1's healthy fires landed
  });

  it('surfaces a failed outcome UPDATE instead of reporting success', async () => {
    route({
      tapeCandidates: [fire(1)],
      aggregate: () => [agg(1)],
      lockReturns: () => Promise.reject(new Error('neon: write timeout')),
    });

    const res = await run();

    expect(res._status).toBe(500);
    expect(res._json).not.toMatchObject({ status: 'success' });
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'neon: write timeout' }),
    );
  });

  it('skips fires with an unusable entry price without reading them', async () => {
    route({ tapeCandidates: [{ ...fire(1), entryPx: 0 }] });

    const res = await run();

    expect(mockSql.query).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({ status: 'success', skipped: 1 });
  });
});

describe('enrich-lottery-outcomes: kept-tickers retention prune', () => {
  it('prunes even when there is nothing to enrich', async () => {
    const res = await run();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', candidates: 0 });
    expect(findPruneCall(mockSql.mock.calls)).toBeDefined();
  });

  it('still succeeds when the retention prune throws (best-effort)', async () => {
    route({ prune: () => Promise.reject(new Error('neon: connection reset')) });

    const res = await run();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success' });
    expect(findPruneCall(mockSql.mock.calls)).toBeDefined();
  });

  // ── Never-vanish ↔ retention coupling ────────────────────────────────────
  // These bind the cross-file invariant that makes the lottery-finder
  // diff-skip safe: the retention floor is >= 1 trading day AND the prune
  // uses a strict `<` cutoff referencing KEPT_RETENTION_DAYS, so today's
  // rows always survive. A tightening to `<=`, to today, or to 0 fails here.

  it('keeps KEPT_RETENTION_DAYS >= 1 (never-vanish current-day floor)', () => {
    expect(KEPT_RETENTION_DAYS).toBeGreaterThanOrEqual(1);
  });

  it('prunes with a strict-< cutoff that binds KEPT_RETENTION_DAYS as the day count', async () => {
    await run();

    const pruneCall = findPruneCall(mockSql.mock.calls);
    expect(pruneCall).toBeDefined();
    expect(pruneCall![1]).toBe(KEPT_RETENTION_DAYS);
  });

  it('emits the lottery.kept_prune heartbeat metric on a successful prune', async () => {
    await run();

    expect(mockMetricsIncrement).toHaveBeenCalledWith('lottery.kept_prune');
  });

  it('does NOT emit the heartbeat when the prune DELETE throws', async () => {
    route({ prune: () => Promise.reject(new Error('neon: connection reset')) });

    const res = await run();

    // safeDbVoid swallows the throw before the metric line runs, so the
    // heartbeat correctly stays flat — exactly the missing-prune signal.
    expect(res._status).toBe(200);
    expect(mockMetricsIncrement).not.toHaveBeenCalledWith('lottery.kept_prune');
  });
});

describe('enrich-lottery-outcomes: failure paths and feed gaps', () => {
  it('never stamps a fire whose ticker went silent mid-session after its entry (continuity gap)', async () => {
    // uw-stream died 16:00-16:05Z and was redeployed before the close: the
    // close tail is live, but fire 1's path is missing five minutes.
    route({
      tapeCandidates: [fire(1), fire(2, 'BBB261002C00010000')],
      gaps: [
        {
          ticker: 'AAA',
          date: '2026-10-01',
          gap_start: '2026-10-01T16:00:00Z',
        },
      ],
      aggregate: (ids) => ids.map((id) => agg(id)),
    });

    const res = await run();

    expect(aggregateCalls()[0]![1][0]).toEqual([2]); // fire 1 never read
    expect(lockCalls()[0]![1]).toEqual([2]);
    expect(res._json).toMatchObject({ status: 'error', tapeGap: 1 });
    expect(mockCaptureMessage.mock.calls[0]![1]).toMatchObject({
      fingerprint: ['enrich-lottery-outcomes', 'missing-tape'],
      extra: { tapeGapIds: [1] },
    });
  });

  it('skips and reports a poison fire whose tape read keeps timing out, writing the rest (error)', async () => {
    route({
      tapeCandidates: [fire(1), fire(2), fire(3)],
      aggregate: (ids) => {
        if (ids.includes(2)) {
          throw new TransientDbError(new Error('db attempt timeout'));
        }
        return ids.map((id) => agg(id));
      },
    });

    const res = await run();

    expect(lockCalls().flatMap((c) => c[1] as number[])).toEqual([1, 3]);
    expect(res._json).toMatchObject({
      status: 'error',
      updated: 2,
      readFailed: 1,
      unreadable: 0,
    });
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        fingerprint: ['enrich-lottery-outcomes', 'read-failed'],
        extra: { readFailed: 1, readFailedIds: [2] },
      }),
    );
  });

  it('fails the run (500) when the tape candidate SELECT is rejected', async () => {
    route({ tapeSelect: () => Promise.reject(new Error('neon: timeout')) });

    const res = await run();

    expect(res._status).toBe(500);
    expect(lockCalls()).toHaveLength(0);
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'neon: timeout' }),
    );
  });
});
