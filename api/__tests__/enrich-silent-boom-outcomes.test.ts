// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';
import { WS_OPTION_TRADES_RETENTION_DAYS } from '../_lib/constants.js';

const {
  mockSql,
  mockCronGuard,
  mockCaptureMessage,
  mockCaptureException,
  mockFetchSeries,
} = vi.hoisted(() => ({
  mockSql: Object.assign(vi.fn(), { query: vi.fn() }),
  mockCronGuard: vi.fn(),
  mockCaptureMessage: vi.fn(),
  mockCaptureException: vi.fn(),
  mockFetchSeries: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  isRetryableDbError: () => false,
  TransientDbError: class TransientDbError extends Error {},
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: mockCaptureException,
    captureMessage: mockCaptureMessage,
    setTag: vi.fn(),
  },
}));

// The flow repair step reads the series through this module. The SQL it runs
// is covered by fire-flow-repair-pglite.test.ts; here it is the module boundary.
vi.mock('../_lib/ticker-flow-snapshot.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_lib/ticker-flow-snapshot.js')>()),
  fetchTickerFlowSeries: mockFetchSeries,
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
import { AXIOM_TOP_LEVEL_KEYS } from '../_lib/axiom-fields.js';

const GUARD = { apiKey: '', today: '2026-10-01' };

/** 21:45 UTC on 2026-10-01 (EDT): past the 20:20Z settle instant. */
const RUN_AT = '2026-10-01T21:45:00Z';

type Row = Record<string, unknown>;

/** A candidate alert as the driver returns it (int8 id as a string). */
function alert(id: number, chain = 'AMD261002C00607500') {
  return {
    id: String(id),
    chain,
    ticker: chain.slice(0, 3),
    date: '2026-10-01',
    entry: new Date('2026-10-01T13:50:00Z'), // bucket_ct
    entryPx: 2,
  };
}

/** A priced aggregate (entry 2.00): peak 3.00, last 2.40, no 30-min print. */
function agg(id: number, o: Row = {}): Row {
  return {
    window_id: String(id),
    tape_live: true,
    ticks: 25,
    peak_px: 3,
    peak_minutes: 47.25,
    last_px: 2.4,
    h30_px: null,
    h60_px: 2.6,
    h120_px: 2.2,
    tier1_px: 3,
    trail_exit_px: 2.7,
    ...o,
  };
}

interface Router {
  candidates?: Row[];
  aggregate?: (ids: number[]) => Row[] | Promise<Row[]>;
  lockReturns?: (ids: number[]) => number[] | Promise<number[]>;
  /** Empty 5-min buckets the continuity probe reports. */
  gaps?: Row[];
  /** The flow repair step: ticker-days with a NULL-flow alert. */
  flowGroups?: () => Promise<Row[]> | Row[];
  /** The flow repair step: one ticker-day's NULL-flow alerts. */
  flowAlerts?: Row[];
  /** The flow repair step: the write's RETURNING (default: every id). */
  flowWrite?: (ids: string[]) => Promise<string[]> | string[];
}

const text = (call: unknown[]): string =>
  Array.isArray(call[0]) ? (call[0] as string[]).join(' ') : '';

function route(r: Router): void {
  mockSql.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sqlText = strings.join(' ');
      // The flow repair step's statements, before the outcome pass's own
      // `FROM silent_boom_alerts` and `UPDATE silent_boom_alerts` matches.
      if (sqlText.includes('GROUP BY f.underlying_symbol')) {
        return r.flowGroups ? r.flowGroups() : [];
      }
      if (sqlText.includes('cum_ncp_at_fire = u.ncp')) {
        const ids = (values[0] as string[]) ?? [];
        const written = await (r.flowWrite ?? ((x) => x))(ids);
        return written.map((id) => ({ id }));
      }
      if (sqlText.includes('id = ANY(')) return [];
      if (sqlText.includes('f.cum_ncp_at_fire IS NULL')) {
        return r.flowAlerts ?? [];
      }
      if (sqlText.includes('UPDATE silent_boom_alerts')) {
        const ids = values[0] as number[];
        const locked = await (r.lockReturns ?? ((x) => x))(ids);
        return locked.map((id) => ({ id: String(id) }));
      }
      if (sqlText.includes('FROM silent_boom_alerts')) {
        return r.candidates ?? [];
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

/** The per-alert aggregate statements (not the continuity probe). */
const aggregateCalls = (): Array<[string, unknown[]]> =>
  (mockSql.query.mock.calls as Array<[string, unknown[]]>).filter(
    (c) => !c[0].includes('generate_series'),
  );

/** The outcome UPDATEs (not the flow repair's UPDATE of the same table). */
const lockCalls = () =>
  mockSql.mock.calls.filter((c) => text(c).includes('enriched_at = NOW()'));

async function run() {
  const res = mockResponse();
  await handler(mockRequest({ method: 'GET' }), res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockReset();
  mockSql.query.mockReset();
  mockFetchSeries.mockReset();
  mockCronGuard.mockReturnValue(GUARD);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(RUN_AT));
  route({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('enrich-silent-boom-outcomes', () => {
  it('returns 401 when CRON_SECRET is missing/wrong (cronGuard returns null)', async () => {
    mockCronGuard.mockReturnValueOnce(null);

    await run();

    // cronGuard handles the 401 itself; the handler body never runs.
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('succeeds with nothing to do when no alert is unenriched', async () => {
    const res = await run();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', candidates: 0 });
    expect(mockSql.query).not.toHaveBeenCalled();
  });

  it('selects only alerts inside the retention window, newest first', async () => {
    await run();

    const [call] = mockSql.mock.calls;
    const sqlText = text(call!).replaceAll(/\s+/g, ' ');
    expect(sqlText).toContain('WHERE enriched_at IS NULL');
    expect(sqlText).toContain(
      'bucket_ct >= NOW() - make_interval(days => ::int)',
    );
    expect(sqlText).toContain('ORDER BY bucket_ct DESC');
    expect(sqlText).not.toContain('ASC');
    expect(sqlText).not.toContain('inserted_at');
    expect(call!.slice(1)).toEqual([
      WS_OPTION_TRADES_RETENTION_DAYS,
      WS_OPTION_TRADES_RETENTION_DAYS,
    ]);
  });

  it('locks an alert with every outcome, keeping a NULL horizon as NULL', async () => {
    route({ candidates: [alert(1)], aggregate: () => [agg(1)] });

    const res = await run();

    expect(res._json).toMatchObject({ status: 'success', rows: 1, updated: 1 });
    const [lock] = lockCalls();
    const [ids, peak, mtp, r30, r60, r120, eod, trail] = lock!.slice(
      1,
    ) as number[][];
    expect(ids).toEqual([1]);
    expect(peak![0]).toBeCloseTo(50, 9);
    expect(mtp).toEqual([47.25]);
    expect(r30).toEqual([null]); // nothing printed in the first 30 min
    expect(r60![0]).toBeCloseTo(30, 9);
    expect(r120![0]).toBeCloseTo(10, 9);
    expect(eod![0]).toBeCloseTo(20, 9);
    expect(trail![0]).toBeCloseTo(35, 9);
    const lockText = text(lock!);
    expect(lockText).toContain('AND s.enriched_at IS NULL');
    expect(lockText).toContain('RETURNING s.id');
  });

  it('tags the lock as a provisional feed write: outcome_source ws_cron, outcome_version 1', async () => {
    route({ candidates: [alert(1)], aggregate: () => [agg(1)] });

    await run();

    const lockText = text(lockCalls()[0]!).replaceAll(/\s+/g, ' ');
    expect(lockText).toContain("outcome_source = 'ws_cron'");
    expect(lockText).toContain('outcome_version = 1');
  });

  it('reads the tape from bucket_ct to an explicit close + 15 min upper bound', async () => {
    route({ candidates: [alert(1)], aggregate: () => [agg(1)] });

    await run();

    const [sqlText, params] = aggregateCalls()[0] as [string, unknown[]];
    expect(sqlText).toContain('t.executed_at <= u.tape_end');
    expect(params[3]).toEqual(['2026-10-01T13:50:00.000Z']);
    expect(params[5]).toEqual(['2026-10-01T20:15:00.000Z']);
  });

  it('matches aggregates to alerts when int8 ids arrive as strings (06-12 regression)', async () => {
    // Since dd2b68ff every alert was looked up with its STRING id in a map
    // keyed by int4 numbers, so each looked tick-less and was stamped NULL.
    route({ candidates: [alert(74369)], aggregate: () => [agg(74369)] });

    await run();

    expect(lockCalls()[0]![1]).toEqual([74369]);
  });

  it('does not read alerts before their session settles', async () => {
    vi.setSystemTime(new Date('2026-10-01T20:10:00Z'));
    route({ candidates: [alert(1)], aggregate: () => [agg(1)] });

    const res = await run();

    expect(mockSql.query).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({ status: 'success', inFlight: 1 });
  });

  it('never stamps an alert whose ticker tape went quiet at the close (tapeGap → error + Sentry)', async () => {
    route({
      candidates: [alert(1), alert(2, 'TLT261002C00076000')],
      aggregate: () => [agg(1), agg(2, { tape_live: false })],
    });

    const res = await run();

    expect(lockCalls()[0]![1]).toEqual([1]);
    expect(res._json).toMatchObject({ status: 'error', tapeGap: 1 });
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage.mock.calls[0]![1]).toMatchObject({
      fingerprint: ['enrich-silent-boom-outcomes', 'missing-tape'],
    });
  });

  it('never stamps an alert with no contract print or an unreadable aggregate (partial)', async () => {
    route({
      candidates: [alert(1), alert(2), alert(3)],
      aggregate: () => [
        agg(1, {
          ticks: 0,
          peak_px: null,
          peak_minutes: null,
          last_px: null,
          h60_px: null,
          h120_px: null,
          tier1_px: null,
          trail_exit_px: null,
        }),
        agg(2, { peak_px: 'garbage' }),
        agg(3),
      ],
    });

    const res = await run();

    expect(lockCalls()[0]![1]).toEqual([3]);
    expect(res._json).toMatchObject({
      status: 'partial',
      noPrints: 1,
      unreadable: 1,
    });
  });

  it('never stamps an alert whose ticker went silent mid-session after its spike (continuity gap)', async () => {
    route({
      candidates: [alert(1), alert(2, 'TLT261002C00076000')],
      gaps: [
        {
          ticker: 'AMD',
          date: '2026-10-01',
          gap_start: '2026-10-01T15:30:00Z',
        },
      ],
      aggregate: (ids) => ids.map((id) => agg(id)),
    });

    const res = await run();

    expect(aggregateCalls()[0]![1][0]).toEqual([2]);
    expect(lockCalls()[0]![1]).toEqual([2]);
    expect(res._json).toMatchObject({ status: 'error', tapeGap: 1 });
  });

  it('reports an unreadable aggregate to Sentry under its own fingerprint', async () => {
    route({ candidates: [alert(1)], aggregate: () => [] });

    const res = await run();

    expect(lockCalls()).toHaveLength(0);
    expect(res._json).toMatchObject({ status: 'partial', unreadable: 1 });
    expect(mockCaptureMessage.mock.calls[0]![1]).toMatchObject({
      fingerprint: ['enrich-silent-boom-outcomes', 'unreadable-aggregate'],
    });
  });

  it('surfaces a DB reject on the aggregate read instead of reporting success', async () => {
    route({
      candidates: [alert(1)],
      aggregate: () => Promise.reject(new Error('neon: connection reset')),
    });

    const res = await run();

    expect(res._status).toBe(500);
    expect(lockCalls()).toHaveLength(0);
  });

  it('surfaces a failed outcome UPDATE instead of reporting success', async () => {
    route({
      candidates: [alert(1)],
      aggregate: () => [agg(1)],
      lockReturns: () => Promise.reject(new Error('neon: write timeout')),
    });

    const res = await run();

    expect(res._status).toBe(500);
  });
});

// ── The flow repair step (api/_lib/fire-flow-repair.ts) ───────────────────────

/** One ticker-day with a NULL-flow alert, as the selection returns it. */
const FLOW_GROUP = { ticker: 'AAA', date: '2026-10-01', n_rows: 1 };

/** A NULL-flow alert whose bucket starts at 14:35Z (`bucket_ct`). */
const flowAlert = (id: number, at = '2026-10-01T14:35:00Z'): Row => ({
  id: String(id),
  at: new Date(at),
});

/** AAA's cumulative flow: call premium over put premium from 14:31Z on. */
const SERIES = {
  ts: [Date.parse('2026-10-01T14:31:00Z')],
  cumNcp: [500],
  cumNpp: [50],
};

const flowWrites = () =>
  mockSql.mock.calls.filter((c) => text(c).includes('cum_ncp_at_fire = u.ncp'));

/** The residual alarm messages sent, by their fixed fingerprint. */
const residualAlarms = () =>
  mockCaptureMessage.mock.calls.filter(
    ([, ctx]) => ctx?.fingerprint?.[0] === 'fire-flow-repair-residual',
  );

/** Run as the slot that starts at `hhmm` UTC on 2026-10-01. */
async function runAt(hhmm: string) {
  vi.setSystemTime(new Date(`2026-10-01T${hhmm}:00Z`));
  return run();
}

describe('enrich-silent-boom-outcomes: flow repair step', () => {
  beforeEach(() => {
    mockFetchSeries.mockResolvedValue(SERIES);
  });

  it('repairs a NULL-flow alert after the outcome pass, with its counts under metadata.flowRepair', async () => {
    route({
      candidates: [alert(1)],
      aggregate: () => [agg(1)],
      flowGroups: () => [FLOW_GROUP],
      flowAlerts: [flowAlert(11)],
    });

    const res = await run();

    const [lock] = lockCalls();
    const [flow] = flowWrites();
    expect(mockSql.mock.calls.indexOf(lock!)).toBeLessThan(
      mockSql.mock.calls.indexOf(flow!),
    );
    // Silent boom carries no flow-derived score: ids, call flow, put flow.
    expect(flow!.slice(1)).toEqual([['11'], [500], [50]]);
    expect(mockFetchSeries).toHaveBeenCalledWith(mockSql, 'AAA', '2026-10-01');
    expect(AXIOM_TOP_LEVEL_KEYS.has('flowRepair')).toBe(false);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      updated: 1,
      flowRepair: { groups: 1, groupsDone: 1, written: 1, scored: 0 },
    });
    expect(res._json).not.toHaveProperty('written');
  });

  it('a rejected flow write is never a success: partial, captured, and the outcome result still lands', async () => {
    route({
      candidates: [alert(1)],
      aggregate: () => [agg(1)],
      flowGroups: () => [FLOW_GROUP],
      flowAlerts: [flowAlert(11)],
      flowWrite: () => Promise.reject(new Error('permission denied')),
    });

    const res = await run();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      updated: 1,
      message: expect.stringContaining('1 ticker-day(s) failed to write'),
      flowRepair: { groupsWriteFailed: 1, written: 0, notWritten: 1 },
    });
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'permission denied' }),
      expect.objectContaining({
        tags: expect.objectContaining({ table: 'silentboom', kind: 'write' }),
      }),
    );
  });

  it('a failed series read makes the run partial and is captured', async () => {
    route({ flowGroups: () => [FLOW_GROUP], flowAlerts: [flowAlert(11)] });
    mockFetchSeries.mockRejectedValue(new Error('relation does not exist'));

    const res = await run();

    expect(res._json).toMatchObject({
      status: 'partial',
      flowRepair: { groupsReadFailed: 1, written: 0 },
    });
    expect(flowWrites()).toHaveLength(0);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('does not soften an outcome-pass error: a clean repair leaves the status error', async () => {
    route({
      // A ticker whose tape went quiet at the close is the pass's error case.
      candidates: [alert(1), alert(2, 'TLT261002C00076000')],
      aggregate: () => [agg(1), agg(2, { tape_live: false })],
      flowGroups: () => [FLOW_GROUP],
      flowAlerts: [flowAlert(11)],
    });

    const res = await run();

    expect(res._json).toMatchObject({
      status: 'error',
      flowRepair: { written: 1 },
    });
  });

  it('the residual alarm stays quiet in the first slot and fires once in the last, with a fixed fingerprint', async () => {
    route({ flowGroups: () => [FLOW_GROUP], flowAlerts: [flowAlert(11)] });
    mockFetchSeries.mockRejectedValue(new Error('boom'));

    await runAt('21:45');
    expect(residualAlarms()).toHaveLength(0);

    const last = await runAt('23:45');

    expect(last._json).toMatchObject({
      status: 'partial',
      flowRepair: { lastSlot: true, residualFires: 1 },
    });
    expect(residualAlarms()).toHaveLength(1);
    expect(residualAlarms()[0]![1]).toMatchObject({
      level: 'error',
      fingerprint: ['fire-flow-repair-residual', 'silentboom'],
      tags: { job: 'enrich-silent-boom-outcomes', table: 'silentboom' },
    });
  });

  it('does not count an alert before the first WS tick: nothing to write is not a residual', async () => {
    route({
      flowGroups: () => [FLOW_GROUP],
      flowAlerts: [flowAlert(11, '2026-10-01T14:30:30Z')],
    });

    const res = await runAt('23:45');

    expect(res._json).toMatchObject({
      status: 'success',
      flowRepair: { noValue: 1, written: 0, residualFires: 0 },
    });
    expect(flowWrites()).toHaveLength(0);
    expect(residualAlarms()).toHaveLength(0);
  });
});
