// @vitest-environment node

import { afterEach, describe, it, expect, vi } from 'vitest';

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  computeRangePos,
  fetchStockCandles1m,
  type UWStockCandle,
} from '../_lib/uw-stock-candles.js';

function bar(start: string, high: number, low: number): UWStockCandle {
  return {
    start_time: start,
    open: String(low),
    high: String(high),
    low: String(low),
    close: String(high),
  };
}

// The real uwFetch runs; only the network is stubbed, so these tests pin
// what a UW response actually turns into (max-pain.test.ts pattern).
function stubUwResponse(response: {
  ok: boolean;
  status?: number;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
}) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

describe('fetchStockCandles1m', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns the candles and sends the key as a Bearer header', async () => {
    const candles = [bar('2026-05-08T14:00:00Z', 110, 100)];
    stubUwResponse({ ok: true, json: async () => ({ data: candles }) });

    await expect(
      fetchStockCandles1m('uw-key', 'AAPL', '2026-05-08'),
    ).resolves.toEqual(candles);

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain('/stock/AAPL/ohlc/1m?date=2026-05-08');
    expect((init as RequestInit).headers).toEqual({
      Authorization: 'Bearer uw-key',
    });
  });

  it('returns [] when UW has no candles for the day', async () => {
    stubUwResponse({ ok: true, json: async () => ({ data: [] }) });

    await expect(
      fetchStockCandles1m('uw-key', 'AAPL', '2026-05-08'),
    ).resolves.toEqual([]);
  });

  it('returns [] for a null data (uwFetch coalesces it)', async () => {
    stubUwResponse({ ok: true, json: async () => ({ data: null }) });

    await expect(
      fetchStockCandles1m('uw-key', 'AAPL', '2026-05-08'),
    ).resolves.toEqual([]);
  });

  it.each([
    // An empty key still sends `Bearer `, so UW answers malformed_token
    // (missing_token is only for no Authorization header at all).
    [401, '{"code":"authentication_required","reason":"malformed_token"}'],
    [
      422,
      '{"code":"cboe_index_access_missing","message":"The CBOE index OHLC dataset requires provisioned access"}',
    ],
    [500, 'Internal Server Error'],
  ])(
    'rejects with the status and body on a UW %i instead of returning []',
    async (status, body) => {
      stubUwResponse({ ok: false, status, text: async () => body });

      await expect(
        fetchStockCandles1m('uw-key', 'AAPL', '2026-05-08'),
      ).rejects.toThrow(`UW API ${status}: ${body}`);
    },
  );

  it('rejects on a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('fetch failed')),
    );

    await expect(
      fetchStockCandles1m('uw-key', 'AAPL', '2026-05-08'),
    ).rejects.toThrow('fetch failed');
  });

  it('rejects when a 200 body is not JSON', async () => {
    stubUwResponse({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });

    await expect(
      fetchStockCandles1m('uw-key', 'AAPL', '2026-05-08'),
    ).rejects.toThrow(SyntaxError);
  });

  it('rejects when data is not an array', async () => {
    stubUwResponse({ ok: true, json: async () => ({ data: 'x' }) });

    await expect(
      fetchStockCandles1m('uw-key', 'AAPL', '2026-05-08'),
    ).rejects.toThrow('UW stock candles malformed: data is string');
  });

  it('rejects when a candle has no start_time', async () => {
    stubUwResponse({
      ok: true,
      json: async () => ({ data: [{ high: '110', low: '100' }] }),
    });

    await expect(
      fetchStockCandles1m('uw-key', 'AAPL', '2026-05-08'),
    ).rejects.toThrow('UW stock candles malformed: candle 0 has no start_time');
  });
});

describe('computeRangePos', () => {
  it('returns null on empty candles', () => {
    expect(computeRangePos([], '2026-05-08T14:30:00Z', 100)).toBeNull();
  });

  it('returns null when every candle is after the trigger time', () => {
    const candles = [bar('2026-05-08T14:31:00Z', 110, 100)];
    expect(computeRangePos(candles, '2026-05-08T14:30:00Z', 105)).toBeNull();
  });

  it('returns 0 when spot is exactly at session low', () => {
    const candles = [
      bar('2026-05-08T14:00:00Z', 110, 100),
      bar('2026-05-08T14:01:00Z', 112, 100),
    ];
    expect(computeRangePos(candles, '2026-05-08T14:02:00Z', 100)).toBe(0);
  });

  it('returns 1 when spot is exactly at session high', () => {
    const candles = [
      bar('2026-05-08T14:00:00Z', 110, 100),
      bar('2026-05-08T14:01:00Z', 112, 102),
    ];
    expect(computeRangePos(candles, '2026-05-08T14:02:00Z', 112)).toBe(1);
  });

  it('returns 0.5 for spot at midpoint of session range', () => {
    const candles = [
      bar('2026-05-08T14:00:00Z', 110, 100),
      bar('2026-05-08T14:01:00Z', 110, 100),
    ];
    expect(computeRangePos(candles, '2026-05-08T14:02:00Z', 105)).toBe(0.5);
  });

  it('clamps to 0 when spot is below session low (extreme spike print)', () => {
    const candles = [bar('2026-05-08T14:00:00Z', 110, 100)];
    expect(computeRangePos(candles, '2026-05-08T14:01:00Z', 95)).toBe(0);
  });

  it('clamps to 1 when spot is above session high', () => {
    const candles = [bar('2026-05-08T14:00:00Z', 110, 100)];
    expect(computeRangePos(candles, '2026-05-08T14:01:00Z', 115)).toBe(1);
  });

  it('only considers candles at or before the trigger time', () => {
    const candles = [
      bar('2026-05-08T14:00:00Z', 110, 100), // included
      bar('2026-05-08T14:30:00Z', 120, 90), // EXCLUDED (after trigger)
    ];
    // Trigger at 14:15 — only first candle counts; high=110, low=100.
    // Spot at 105 → 0.5
    expect(computeRangePos(candles, '2026-05-08T14:15:00Z', 105)).toBe(0.5);
  });

  it('returns null when high equals low (single flat bar)', () => {
    const candles = [bar('2026-05-08T14:00:00Z', 100, 100)];
    expect(computeRangePos(candles, '2026-05-08T14:01:00Z', 100)).toBeNull();
  });
});
