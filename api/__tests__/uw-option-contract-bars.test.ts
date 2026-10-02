// @vitest-environment node

/**
 * Unit tests for api/_lib/uw-option-contract-bars.ts. The global `fetch`
 * is the module boundary; the real `withRetry` runs (on fake timers for
 * the retried statuses), so 429/5xx handling is exercised end to end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), captureMessage: vi.fn() },
  metrics: { uwRateLimit: vi.fn(), uwBudget: vi.fn() },
}));
const mockAcquire = vi.hoisted(() => vi.fn());
const mockRelease = vi.hoisted(() => vi.fn());
vi.mock('../_lib/uw-concurrency.js', () => ({
  acquireConcurrencySlot: mockAcquire,
  releaseConcurrencySlot: mockRelease,
}));

import {
  UW_BACKFILL_USER_AGENT,
  fetchContractDayBars,
  parseIntradayBars,
  uwOptionSymbol,
} from '../_lib/uw-option-contract-bars.js';

/** A row in the live (2026-10-02) shape: strings, newest first, no symbol. */
function uwRow(
  startTime: string,
  [open, high, low, close]: [string, string, string, string],
): Record<string, unknown> {
  return {
    start_time: startTime,
    open,
    high,
    low,
    close,
    trading_hours: 'rth',
    avg_price: close,
    volume_ask_side: 3,
    volume_bid_side: 0,
    premium_ask_side: 9,
  };
}

const DAY = '2026-09-30';
const ROWS = [
  uwRow('2026-09-30T19:59:00Z', ['0.03', '0.05', '0.03', '0.05']),
  uwRow('2026-09-30T13:53:00Z', ['0.32', '0.35', '0.30', '0.30']),
];

function response(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('uwOptionSymbol', () => {
  it('is the OCC symbol without root padding', () => {
    expect(uwOptionSymbol('SPXW', '2026-09-30', 'P', 7580)).toBe(
      'SPXW260930P07580000',
    );
    expect(uwOptionSymbol('SPXW', '2026-06-12', 'C', 7505)).toBe(
      'SPXW260612C07505000',
    );
  });
});

describe('parseIntradayBars', () => {
  it('parses decimal strings and sorts the newest-first rows ascending', () => {
    const out = parseIntradayBars({ data: ROWS }, DAY);
    expect(out).toEqual({
      kind: 'ok',
      data: [
        {
          start: new Date('2026-09-30T13:53:00Z'),
          open: 0.32,
          high: 0.35,
          low: 0.3,
          close: 0.3,
        },
        {
          start: new Date('2026-09-30T19:59:00Z'),
          open: 0.03,
          high: 0.05,
          low: 0.03,
          close: 0.05,
        },
      ],
    });
  });

  it('accepts numeric prices', () => {
    const out = parseIntradayBars(
      {
        data: [
          {
            start_time: '2026-09-30T14:00:00Z',
            open: 1,
            high: 1.2,
            low: 0.9,
            close: 1.1,
          },
        ],
      },
      DAY,
    );
    expect(out.kind).toBe('ok');
  });

  it('reports an empty array as empty, not as an error', () => {
    expect(parseIntradayBars({ data: [] }, DAY)).toEqual({ kind: 'empty' });
  });

  it.each([
    ['null body', null],
    ['array body', []],
    ['no data key', { rows: ROWS }],
    ['data not an array', { data: { start_time: 'x' } }],
  ])('rejects a malformed shape: %s', (_name, body) => {
    expect(parseIntradayBars(body, DAY)).toEqual({
      kind: 'error',
      reason: 'malformed_shape',
    });
  });

  it.each([
    ['non-numeric high', { high: 'abc' }],
    ['empty-string close', { close: '' }],
    ['zero low', { low: '0' }],
    ['missing open', { open: undefined }],
    ['unparseable start_time', { start_time: 'not-a-time' }],
    ['high below low', { high: '0.20', low: '0.30' }],
    ['close above high', { close: '0.50' }],
  ])('fails the whole contract-day on one bad bar: %s', (_name, patch) => {
    const bad = {
      ...uwRow('2026-09-30T14:00:00Z', ['0.30', '0.35', '0.28', '0.32']),
      ...patch,
    };
    expect(parseIntradayBars({ data: [...ROWS, bad] }, DAY)).toEqual({
      kind: 'error',
      reason: 'malformed_bar',
    });
  });

  it('rejects duplicate minutes', () => {
    expect(parseIntradayBars({ data: [...ROWS, ROWS[0]] }, DAY)).toEqual({
      kind: 'error',
      reason: 'duplicate_bar',
    });
  });

  it('rejects a bar that does not start on a minute boundary', () => {
    const offMinute = uwRow('2026-09-30T14:00:30Z', [
      '0.30',
      '0.35',
      '0.28',
      '0.32',
    ]);
    expect(parseIntradayBars({ data: [...ROWS, offMinute] }, DAY)).toEqual({
      kind: 'error',
      reason: 'misaligned_bar',
    });
  });

  it('rejects bars from a different day (UW ignoring the date param)', () => {
    expect(parseIntradayBars({ data: ROWS }, '2026-09-29')).toEqual({
      kind: 'error',
      reason: 'wrong_day',
    });
  });
});

describe('fetchContractDayBars', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    mockAcquire.mockReset().mockResolvedValue('slot-1');
    mockRelease.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('GETs the intraday endpoint with bearer auth and an explicit User-Agent', async () => {
    fetchMock.mockResolvedValueOnce(
      response(200, JSON.stringify({ data: ROWS })),
    );

    const out = await fetchContractDayBars(
      'key-123',
      'SPXW260930P07580000',
      DAY,
    );

    expect(out.kind).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://api.unusualwhales.com/api/option-contract/SPXW260930P07580000/intraday?date=2026-09-30',
    );
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer key-123',
      'User-Agent': UW_BACKFILL_USER_AGENT,
    });
  });

  it('reports a non-retryable non-200 as http_<status> without retrying', async () => {
    fetchMock.mockResolvedValueOnce(
      response(403, JSON.stringify({ reason: 'route_not_permitted' })),
    );

    const out = await fetchContractDayBars('k', 'SPXW260930P07580000', DAY);

    expect(out).toEqual({ kind: 'error', reason: 'http_403' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('holds a shared UW in-flight slot per request and releases it on success and failure', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, JSON.stringify({ data: ROWS })))
      .mockResolvedValueOnce(response(403, '{}'));

    await fetchContractDayBars('k', 'SPXW260930P07580000', DAY);
    await fetchContractDayBars('k', 'SPXW260930P07580000', DAY);

    expect(mockAcquire).toHaveBeenCalledTimes(2);
    expect(mockRelease).toHaveBeenCalledTimes(2);
    expect(mockRelease).toHaveBeenNthCalledWith(1, 'slot-1');
    expect(mockRelease).toHaveBeenNthCalledWith(2, 'slot-1');
  });

  it('retries a 5xx and reports http_500 once retries are exhausted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    fetchMock.mockImplementation(() =>
      Promise.resolve(response(500, 'Something went wrong')),
    );

    const pending = fetchContractDayBars('k', 'SPXW260930P07580000', DAY);
    await vi.runAllTimersAsync();

    expect(await pending).toEqual({ kind: 'error', reason: 'http_500' });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it('recovers when a retried 429 is followed by a 200', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    fetchMock
      .mockResolvedValueOnce(
        response(429, 'You have exceeded 3 concurrent requests'),
      )
      .mockResolvedValueOnce(response(200, JSON.stringify({ data: ROWS })));

    const pending = fetchContractDayBars('k', 'SPXW260930P07580000', DAY);
    await vi.runAllTimersAsync();

    expect((await pending).kind).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a network failure as an error, never as an empty day', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('boom'));

    const out = await fetchContractDayBars('k', 'SPXW260930P07580000', DAY);

    expect(out).toEqual({ kind: 'error', reason: 'network: boom' });
  });

  it('retries a timed-out request and reports the timeout once retries are exhausted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    fetchMock.mockRejectedValue(
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ),
    );

    const pending = fetchContractDayBars('k', 'SPXW260930P07580000', DAY);
    await vi.runAllTimersAsync();

    expect(await pending).toEqual({
      kind: 'error',
      reason: expect.stringMatching(/^network: .*timeout/),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it('reports malformed JSON as malformed_json', async () => {
    fetchMock.mockResolvedValueOnce(response(200, '{"data": [ truncated'));

    const out = await fetchContractDayBars('k', 'SPXW260930P07580000', DAY);

    expect(out).toEqual({ kind: 'error', reason: 'malformed_json' });
  });

  it('reports an empty data array as empty', async () => {
    fetchMock.mockResolvedValueOnce(
      response(200, JSON.stringify({ data: [] })),
    );

    const out = await fetchContractDayBars('k', 'SPXW260930P07580000', DAY);

    expect(out).toEqual({ kind: 'empty' });
  });

  it('passes a malformed 200 body through the parser', async () => {
    fetchMock.mockResolvedValueOnce(
      response(200, JSON.stringify({ rows: [] })),
    );

    const out = await fetchContractDayBars('k', 'SPXW260930P07580000', DAY);

    expect(out).toEqual({ kind: 'error', reason: 'malformed_shape' });
  });
});
