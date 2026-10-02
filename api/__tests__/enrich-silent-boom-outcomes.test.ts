// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';
import { WS_OPTION_TRADES_RETENTION_DAYS } from '../_lib/constants.js';

const { mockSql, mockCronGuard, mockCaptureMessage } = vi.hoisted(() => ({
  mockSql: Object.assign(vi.fn(), { query: vi.fn() }),
  mockCronGuard: vi.fn(),
  mockCaptureMessage: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  TransientDbError: class TransientDbError extends Error {},
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: mockCaptureMessage,
    setTag: vi.fn(),
  },
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
}

const text = (call: unknown[]): string =>
  Array.isArray(call[0]) ? (call[0] as string[]).join(' ') : '';

function route(r: Router): void {
  mockSql.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sqlText = strings.join(' ');
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

const lockCalls = () =>
  mockSql.mock.calls.filter((c) =>
    text(c).includes('UPDATE silent_boom_alerts'),
  );

async function run() {
  const res = mockResponse();
  await handler(mockRequest({ method: 'GET' }), res);
  return res;
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
