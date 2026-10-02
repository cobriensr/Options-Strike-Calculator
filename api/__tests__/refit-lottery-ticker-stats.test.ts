// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockCronGuard, mockAddBreadcrumb } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockCronGuard: vi.fn(),
  mockAddBreadcrumb: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    addBreadcrumb: mockAddBreadcrumb,
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

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

import handler from '../cron/refit-lottery-ticker-stats.js';
import logger from '../_lib/logger.js';

type Row = Record<string, unknown>;

const text = (call: unknown[]): string =>
  Array.isArray(call[0]) ? (call[0] as string[]).join(' ') : '';

/** Route the two reads by SQL text; anything else is a write and fails. */
function route(counts: Row[] | Error, live: Row[] | Error): void {
  mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
    const sqlText = strings.join(' ');
    if (sqlText.includes('FROM lottery_finder_fires')) {
      if (counts instanceof Error) throw counts;
      return counts;
    }
    if (sqlText.includes('FROM lottery_ticker_stats')) {
      if (live instanceof Error) throw live;
      return live;
    }
    throw new Error(`unexpected SQL: ${sqlText.slice(0, 80)}`);
  });
}

async function run() {
  const res = mockResponse();
  await handler(mockRequest({ method: 'GET' }), res);
  return res;
}

const LIVE: Row[] = [
  { ticker: 'AMD', quintile: 2, blend: 0.1, updatedAt: '2026-06-17T03:30:00Z' },
  {
    ticker: 'TSLA',
    quintile: 4,
    blend: 0.3,
    updatedAt: '2026-06-17T03:30:00Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockReset();
  mockCronGuard.mockReturnValue({ apiKey: '', today: '2026-10-01' });
});

describe('refit-lottery-ticker-stats (shadow)', () => {
  it('computes the refit, reports coverage + diff, and never writes lottery_ticker_stats', async () => {
    route(
      [
        { ticker: 'TSLA', n21d: 10, w21d: 7, n90d: 120, w90d: 33 },
        { ticker: 'AMD', n21d: 3, w21d: 1, n90d: 47, w90d: 1 },
      ],
      LIVE,
    );

    const res = await run();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      mode: 'shadow',
      tickersSeen: 2,
      tickersWithBlend: 2,
      diff: { changed: 2, unchanged: 0 },
      changes: [
        { ticker: 'AMD', live: 2, shadow: 1 },
        { ticker: 'TSLA', live: 4, shadow: 5 },
      ],
    });
    // Shadow mode: only the two SELECTs ran — no UPDATE/INSERT/DELETE.
    expect(mockSql).toHaveBeenCalledTimes(2);
    for (const call of mockSql.mock.calls) {
      expect(text(call)).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
    }
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'lottery.refit',
        data: expect.objectContaining({ tickersWithBlend: 2 }),
      }),
    );
    // The full per-ticker would-be stats go to the structured log line.
    const [logged] = vi.mocked(logger.info).mock.calls.at(-1)!;
    expect(logged).toMatchObject({
      mode: 'shadow',
      stats: [
        expect.objectContaining({ ticker: 'AMD', quintile: 1 }),
        expect.objectContaining({ ticker: 'TSLA', quintile: 5 }),
      ],
    });
  });

  it('reports zero coverage when no ticker has enough resolved fires (still no write)', async () => {
    route(
      [
        { ticker: 'TSLA', n21d: 0, w21d: 0, n90d: 6, w90d: 1 },
        { ticker: 'AMD', n21d: 0, w21d: 0, n90d: 0, w90d: 0 },
      ],
      LIVE,
    );

    const res = await run();

    expect(res._json).toMatchObject({
      status: 'success',
      mode: 'shadow',
      tickersWithBlend: 0,
      diff: { wouldClear: 2 },
    });
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('fails the run (500) when the window counts read is rejected', async () => {
    route(new Error('neon: connection reset'), LIVE);

    const res = await run();

    expect(res._status).toBe(500);
  });

  it('fails the run (500) when the live stats read is rejected', async () => {
    route([], new Error('neon: connection reset'));

    const res = await run();

    expect(res._status).toBe(500);
  });

  it('fails the run (500) instead of fitting on a malformed counts row', async () => {
    route([{ ticker: 'TSLA', n21d: 'x', w21d: 0, n90d: 1, w90d: 0 }], LIVE);

    const res = await run();

    expect(res._status).toBe(500);
    expect(mockAddBreadcrumb).not.toHaveBeenCalled();
  });
});
