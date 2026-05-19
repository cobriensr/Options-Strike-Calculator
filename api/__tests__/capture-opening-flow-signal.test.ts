// @vitest-environment node

/**
 * Tests for the daily Opening Flow Signal capture cron.
 *
 * Mocks the shared `evaluateOpeningFlow` lib so each case can pin the
 * windowStatus + per-ticker payloads independently of any DB fixture.
 * The cron's only DB write is the UPSERT into `opening_flow_signals`,
 * so assertions focus on (a) the per-ticker UPSERT count, (b) the
 * JSONB serialization of slice1/slice2/signal, and (c) the
 * `InvalidTradingDateError` swallow path.
 *
 * Phase 3 of docs/superpowers/specs/opening-flow-signal-historical-persistence-2026-05-19.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),

}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setTag: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const mockCronGuard = vi.hoisted(() => vi.fn());
vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

const mockEvaluateOpeningFlow = vi.hoisted(() => vi.fn());
vi.mock('../_lib/opening-flow-evaluator.js', () => {
  class InvalidTradingDateError extends Error {
    constructor(date: string) {
      super(`invalid trading date: ${date}`);
      this.name = 'InvalidTradingDateError';
    }
  }
  return {
    evaluateOpeningFlow: mockEvaluateOpeningFlow,
    InvalidTradingDateError,
  };
});

vi.mock('../../src/utils/timezone.js', () => ({
  getETDateStr: vi.fn(() => '2026-05-19'),
}));

import handler from '../cron/capture-opening-flow-signal.js';
import { Sentry } from '../_lib/sentry.js';
import { InvalidTradingDateError } from '../_lib/opening-flow-evaluator.js';
import { mockRequest, mockResponse } from './helpers';

const DATE = '2026-05-19';
const AS_OF_UTC = '2026-05-19T13:50:00.000Z';
const OPEN_UTC = '2026-05-19T13:30:00.000Z';
const SLICE1_END_UTC = '2026-05-19T13:35:00.000Z';
const SLICE2_END_UTC = '2026-05-19T13:40:00.000Z';

function makeEvaluation(
  overrides: {
    windowStatus?: 'before_open' | 'closed';
    spy?: {
      slice1: Record<string, unknown> | null;
      slice2: Record<string, unknown> | null;
      signal: Record<string, unknown> | null;
    };
    qqq?: {
      slice1: Record<string, unknown> | null;
      slice2: Record<string, unknown> | null;
      signal: Record<string, unknown> | null;
    };
  } = {},
) {
  return {
    date: DATE,
    windowStatus: overrides.windowStatus ?? 'closed',
    openUtc: OPEN_UTC,
    slice1EndUtc: SLICE1_END_UTC,
    slice2EndUtc: SLICE2_END_UTC,
    asOfUtc: AS_OF_UTC,
    stopPct: 0.5,
    exitMinutesFromEntry: 25,
    tickers: {
      SPY: overrides.spy ?? {
        slice1: { dominantSide: 'ask', askPct: 0.71 },
        slice2: { dominantSide: 'ask', askPct: 0.73 },
        signal: { fired: true, bias: 'long', conviction: 'medium' },
      },
      QQQ: overrides.qqq ?? {
        slice1: { dominantSide: 'ask', askPct: 0.68 },
        slice2: { dominantSide: 'ask', askPct: 0.7 },
        signal: { fired: false, bias: 'neutral', conviction: 'low' },
      },
    },
  };
}

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockCronGuard.mockReset();
  mockCronGuard.mockReturnValue({ apiKey: '', today: DATE });
  mockEvaluateOpeningFlow.mockReset();
  vi.mocked(Sentry.captureException).mockReset();
});

describe('capture-opening-flow-signal cron', () => {
  it('UPSERTs one row per ticker when the evaluator returns SPY + QQQ payloads', async () => {
    mockEvaluateOpeningFlow.mockResolvedValueOnce(makeEvaluation());

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // Two UPSERTs, one per ticker
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 2,
    });
  });

  it('binds slice1/slice2/signal as JSON-stringified JSONB (not raw objects)', async () => {
    const slice1Obj = { dominantSide: 'ask', askPct: 0.71 };
    const slice2Obj = { dominantSide: 'ask', askPct: 0.73 };
    const signalObj = { fired: true, bias: 'long', conviction: 'medium' };
    mockEvaluateOpeningFlow.mockResolvedValueOnce(
      makeEvaluation({
        spy: { slice1: slice1Obj, slice2: slice2Obj, signal: signalObj },
        qqq: { slice1: null, slice2: null, signal: null },
      }),
    );

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // First UPSERT = SPY
    const spyArgs = mockSql.mock.calls[0];
    expect(spyArgs).toBeDefined();
    const spyParams = (spyArgs ?? []).slice(1);
    // Param order matches the INSERT VALUES clause:
    //   [date, ticker, windowStatus,
    //    slice1, slice2, signal,
    //    asOfUtc, stopPct, exitMinutesFromEntry]
    expect(spyParams[0]).toBe(DATE);
    expect(spyParams[1]).toBe('SPY');
    expect(spyParams[2]).toBe('closed');
    expect(spyParams[3]).toBe(JSON.stringify(slice1Obj));
    expect(spyParams[4]).toBe(JSON.stringify(slice2Obj));
    expect(spyParams[5]).toBe(JSON.stringify(signalObj));
    expect(spyParams[6]).toBe(AS_OF_UTC);
    expect(spyParams[7]).toBe(0.5);
    expect(spyParams[8]).toBe(25);

    // Second UPSERT = QQQ with all-null payloads (bind as null, not 'null' string)
    const qqqArgs = mockSql.mock.calls[1];
    const qqqParams = (qqqArgs ?? []).slice(1);
    expect(qqqParams[1]).toBe('QQQ');
    expect(qqqParams[3]).toBeNull();
    expect(qqqParams[4]).toBeNull();
    expect(qqqParams[5]).toBeNull();
  });

  it('returns rows=0 + metadata.reason=invalid_date when the evaluator throws InvalidTradingDateError', async () => {
    mockEvaluateOpeningFlow.mockRejectedValueOnce(
      new InvalidTradingDateError('garbage'),
    );

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // No DB writes — the cron returns before touching sql
    expect(mockSql).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      reason: 'invalid_date',
    });
    // Sentry breadcrumb for visibility
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('still writes 2 rows on a pre-open day (before_open windowStatus, null per-ticker payloads)', async () => {
    mockEvaluateOpeningFlow.mockResolvedValueOnce(
      makeEvaluation({
        windowStatus: 'before_open',
        spy: { slice1: null, slice2: null, signal: null },
        qqq: { slice1: null, slice2: null, signal: null },
      }),
    );

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // Both rows still get written — UI renders "Market closed" for these.
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 2,
      windowStatus: 'before_open',
    });

    // Each row has null slice1/slice2/signal bindings
    for (const call of mockSql.mock.calls) {
      const params = call.slice(1);
      expect(params[2]).toBe('before_open');
      expect(params[3]).toBeNull();
      expect(params[4]).toBeNull();
      expect(params[5]).toBeNull();
    }
  });

  it('threads asOfUtc, stopPct, and exitMinutesFromEntry from the evaluator result into every row binding', async () => {
    mockEvaluateOpeningFlow.mockResolvedValueOnce({
      ...makeEvaluation(),
      asOfUtc: '2026-05-19T14:00:00.000Z',
      stopPct: 0.4,
      exitMinutesFromEntry: 30,
    });

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    for (const call of mockSql.mock.calls) {
      const params = call.slice(1);
      expect(params[6]).toBe('2026-05-19T14:00:00.000Z');
      expect(params[7]).toBe(0.4);
      expect(params[8]).toBe(30);
    }
  });
});
