/**
 * Tests for api/_lib/market-data-adapters.ts — the UW + Theta-sidecar
 * assemblers that rebuild exact Schwab response shapes behind the
 * schwabFetch facade (Phase 2 of schwab-replacement-2026-08-16).
 *
 * The assertions here ARE the compatibility contract: every field path
 * asserted below is consumed by a live schwabFetch call site (see the
 * recon's fields_consumed inventory). Golden outputs are asserted
 * verbatim — a shape drift that would silently NaN a consumer fails
 * loudly here instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../_lib/uw-fetch.js', () => ({
  uwFetch: vi.fn(),
  parseUwHttpStatus: (message: string) => {
    const m = /^UW API (\d+):/.exec(message);
    return m ? Number.parseInt(m[1]!, 10) : null;
  },
  // Real worker-pool semantics (a copy of uw-fetch's implementation) so
  // the per-branch fan-out ceiling is observable from the fetch mocks.
  mapWithConcurrency: async <T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T, idx: number) => Promise<R>,
  ): Promise<R[]> => {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const runner = async (): Promise<void> => {
      while (cursor < items.length) {
        const idx = cursor;
        cursor += 1;
        results[idx] = await worker(items[idx]!, idx);
      }
    };
    const runners = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: runners }, runner));
    return results;
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { uwFetch } from '../_lib/uw-fetch.js';
import {
  chainAdapter,
  historyAdapter,
  moversAdapter,
  quotesAdapter,
  sourceUnavailable,
} from '../_lib/market-data-adapters.js';

const uwFetchMock = vi.mocked(uwFetch);

// ── Test scaffolding ─────────────────────────────────────────

const SIDECAR = 'https://sidecar.example';

function jsonRes(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * The sidecar's load-shed answer when a /theta/index/* request waited
 * out its Terminal-slot budget (health.py `_send_theta_busy`): 503 +
 * `Retry-After: 1` + `{"error":"theta_busy"}`. Distinct from
 * `theta_unavailable` (Terminal down), which must NOT be retried.
 */
function thetaBusyRes(retryAfter: string | null = '1'): Response {
  return jsonRes(
    { error: 'theta_busy' },
    503,
    retryAfter == null ? {} : { 'Retry-After': retryAfter },
  );
}

/** A fetch mock that records its peak in-flight count. */
function concurrencyProbe(respond: (url: string) => Response): {
  spy: ReturnType<typeof vi.spyOn>;
  peak: () => number;
} {
  let inFlight = 0;
  let peak = 0;
  const spy = vi.spyOn(globalThis, 'fetch');
  spy.mockImplementation(async (input) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    // Hold the slot across a real macrotask so siblings can pile up.
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    return respond(String(input));
  });
  return { spy, peak: () => peak };
}

/**
 * Re-install fake timers with `setTimeout` faked too (the suite default
 * fakes only `Date`), keeping the suite's pinned clock, so a retry
 * backoff can be driven deterministically with advanceTimersByTimeAsync.
 */
function fakeRetryTimers(): void {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-08-14T15:00:00Z'));
}

/**
 * Install a fetch impl that dispatches on URL substring. Unmatched URLs
 * get a 404 (the sidecar's "no data for this date" shape).
 */
function mockSidecar(
  routes: Record<string, unknown>,
): ReturnType<typeof vi.spyOn> {
  const spy = vi.spyOn(globalThis, 'fetch');
  spy.mockImplementation(async (input) => {
    const url = String(input);
    for (const [needle, body] of Object.entries(routes)) {
      if (url.includes(needle)) return jsonRes(body);
    }
    return jsonRes({ error: 'no data' }, 404);
  });
  return spy;
}

/**
 * UW stock-screener path the adapters use for index spot (recon
 * 2026-08-18): index rows only carry close/high/low when an equity
 * ticker rides along in the same request, so the adapter always pairs
 * the root with SPY.
 */
function screenerPath(root: string): string {
  return `/screener/stocks?ticker=SPY%2C${root}`;
}

const SPY_SCREENER_ROW = {
  ticker: 'SPY',
  close: '644.4',
  prev_close: '642.2',
  high: '646',
  low: '640.9',
};

/** Screener response body: SPY companion row + the index row. */
function screenerRows(
  root: string,
  row: Record<string, unknown>,
): Record<string, unknown>[] {
  return [SPY_SCREENER_ROW, { ticker: root, ...row }];
}

/**
 * UW spot-exposures strike row the adapter reads the strike-grid-rounded
 * live index spot from when the screener has no close (prod 2026-08-19:
 * "UW screener: no price for index NDX" on every RTH minute, while the
 * same row carried the prior close pre-open and today's close after the
 * bell — the screener's index `close` is the last OFFICIAL close). Same
 * always-live preflight fetch-gex-0dte uses for SPX.
 */
function spotBucketPath(root: string): string {
  return `/stock/${root}/spot-exposures/strike?limit=1`;
}

/** Real shape (trimmed): `price` is the spot bucket, `strike` the row's. */
function spotBucketRows(price: string): Record<string, unknown>[] {
  return [
    {
      ticker: 'NDX',
      date: '2026-08-14',
      time: '2026-08-14T15:00:07.653000Z',
      price,
      strike: '4000',
      call_gamma_oi: '210.9',
      put_delta_oi: '-2541958.59',
    },
  ];
}

/**
 * NDX screener row with the intraday shape: no close, prev close / high
 * / low present (values from the 2026-08-19 after-hours row). The
 * 08-19 warn line could not tell a NULL close from a missing row, so
 * the row-absent variant is covered separately.
 */
const NDX_RTH_SCREENER_ROW = {
  close: null,
  prev_close: '29490.957',
  high: '29652.2949',
  low: '29288.7539',
};

const ENV_KEYS = ['UW_API_KEY', 'SIDECAR_URL', 'SIDECAR_TAKEIT_SECRET'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.UW_API_KEY = 'test-key';
  process.env.SIDECAR_URL = SIDECAR;
  process.env.SIDECAR_TAKEIT_SECRET = 'shh';
  // Friday 2026-08-14, 11:00 ET (EDT, UTC-4).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-14T15:00:00Z'));
  uwFetchMock.mockReset();
  uwFetchMock.mockResolvedValue([]);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── sourceUnavailable ────────────────────────────────────────

describe('sourceUnavailable', () => {
  it('returns a 501 SOURCE_UNAVAILABLE ApiResult', () => {
    const r = sourceUnavailable('/pricehistory?symbol=%24TICK&x=1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(501);
    expect(r.code).toBe('SOURCE_UNAVAILABLE');
    expect(r.error).toContain('[SOURCE_UNAVAILABLE]');
    expect(r.error).toContain('/pricehistory');
    // Query string is stripped from the message.
    expect(r.error).not.toContain('x=1');
  });
});

// ── chainAdapter ─────────────────────────────────────────────

describe('chainAdapter', () => {
  const SPX_0DTE_PATH =
    `/chains?symbol=$SPX&contractType=ALL&includeUnderlyingQuote=true` +
    `&strategy=SINGLE&range=ALL&fromDate=2026-08-14&toDate=2026-08-14` +
    `&strikeCount=80`;

  // Real sidecar price contract: {root, price, prev_close, ts} — the
  // route never sends open/high/low (health.py _handle_theta_index_price).
  function mockSpxSpot(): ReturnType<typeof vi.spyOn> {
    return mockSidecar({
      '/theta/index/price?root=SPX': {
        root: 'SPX',
        price: 6465.25,
        prev_close: 6450.25,
        ts: '2026-08-14T15:00:00Z',
      },
    });
  }

  it('rebuilds the exact Schwab chain shape for a $SPX 0DTE request', async () => {
    mockSpxSpot();
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path.includes('/option-contracts')) {
        return [
          {
            option_symbol: 'SPXW260814C06500000',
            implied_volatility: '0.255',
            delta: '0.12',
            gamma: '0.0021',
            theta: '-0.85',
            vega: '0.35',
            open_interest: 1234,
            volume: '567',
            nbbo_bid: '1.2',
            nbbo_ask: '1.4',
            last_price: '1.3',
          },
          {
            option_symbol: 'SPXW260814P06400000',
            implied_volatility: 0.31,
            delta: -0.08,
            gamma: 0.0018,
            theta: -0.7,
            vega: 0.3,
            open_interest: 999,
            volume: 100,
            nbbo_bid: 0.8,
            nbbo_ask: 1,
            last_price: 0.9,
          },
          // SPX monthly at the same strike as the SPXW call — must land
          // in the SAME strike array so consumers' OSI-root filters see it.
          {
            option_symbol: 'SPX260814C06500000',
            implied_volatility: 0.25,
            delta: 0.11,
            gamma: 0.002,
            theta: -0.8,
            vega: 0.34,
            open_interest: 50,
            volume: 5,
            nbbo_bid: 1.1,
            nbbo_ask: 1.5,
            last_price: 1.2,
          },
        ];
      }
      return [];
    });

    const result = await chainAdapter(SPX_0DTE_PATH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const chain = result.data as {
      symbol: string;
      underlying: { symbol: string; last: number; close: number };
      callExpDateMap: Record<string, Record<string, unknown[]>>;
      putExpDateMap: Record<string, Record<string, unknown[]>>;
    };

    // underlying.{symbol,last,close} — api/chain.ts + fetch-strike-iv +
    // compute-cone contract.
    expect(chain.underlying).toMatchObject({
      symbol: '$SPX',
      last: 6465.25,
      close: 6450.25,
    });

    // ExpDateMap keys are 'YYYY-MM-DD:DTE'.
    expect(Object.keys(chain.callExpDateMap)).toEqual(['2026-08-14:0']);
    expect(Object.keys(chain.putExpDateMap)).toEqual(['2026-08-14:0']);

    // Both roots at strike 6500 share one strike array (Schwab behavior
    // that fetch-strike-iv's `contracts.find(matchesRoot)` relies on).
    const callStrikes = chain.callExpDateMap['2026-08-14:0']!;
    expect(Object.keys(callStrikes)).toEqual(['6500.0']);
    expect(callStrikes['6500.0']).toHaveLength(2);

    // Golden SPXW call contract — every consumed field path.
    expect(callStrikes['6500.0']![0]).toEqual({
      putCall: 'CALL',
      symbol: 'SPXW  260814C06500000', // OSI root padded to 6 chars
      description: 'SPXW 2026-08-14 6500 CALL',
      bid: 1.2,
      ask: 1.4,
      last: 1.3,
      mark: 1.3, // (bid+ask)/2, rounded to 4dp
      totalVolume: 567,
      openInterest: 1234,
      strikePrice: 6500,
      delta: 0.12,
      gamma: 0.0021,
      theta: -0.85,
      vega: 0.35,
      volatility: 25.5, // UW decimal 0.255 → Schwab PERCENT
      daysToExpiration: 0,
      inTheMoney: false, // call strike 6500 > spot 6465.25
      theoreticalValue: 0,
      expirationDate: '2026-08-14',
    });
    // The SPX monthly keeps its own (unpadded-root→padded) OSI symbol.
    expect(callStrikes['6500.0']![1]).toMatchObject({
      symbol: 'SPX   260814C06500000',
    });

    const putStrikes = chain.putExpDateMap['2026-08-14:0']!;
    expect(putStrikes['6400.0']![0]).toMatchObject({
      putCall: 'PUT',
      strikePrice: 6400,
      volatility: 31,
      inTheMoney: false, // put strike 6400 < spot
      delta: -0.08,
    });

    // Exactly one UW chain page + zero extra expiries.
    const chainCalls = uwFetchMock.mock.calls.filter(([, p]) =>
      p.includes('/option-contracts'),
    );
    expect(chainCalls).toEqual([
      [
        'test-key',
        '/stock/SPX/option-contracts?expiry=2026-08-14&limit=500&page=0',
      ],
    ]);
  });

  it('fans out one UW call per expiry (today + Fridays) for ranged requests', async () => {
    mockSpxSpot();
    const result = await chainAdapter(
      `/chains?symbol=$SPX&contractType=ALL&includeUnderlyingQuote=true` +
        `&strategy=SINGLE&range=ALL&fromDate=2026-08-14&toDate=2026-08-28` +
        `&strikeCount=500`,
    );
    expect(result.ok).toBe(true);
    const paths = uwFetchMock.mock.calls
      .map(([, p]) => p)
      .filter((p) => p.includes('/option-contracts'));
    expect(paths).toEqual([
      '/stock/SPX/option-contracts?expiry=2026-08-14&limit=500&page=0',
      '/stock/SPX/option-contracts?expiry=2026-08-21&limit=500&page=0',
      '/stock/SPX/option-contracts?expiry=2026-08-28&limit=500&page=0',
    ]);
  });

  it('maps range=OTM to UW maybe_otm_only (fetch-strike-iv budget path)', async () => {
    mockSpxSpot();
    const result = await chainAdapter(
      `/chains?symbol=$SPX&contractType=ALL&includeUnderlyingQuote=true` +
        `&strategy=SINGLE&range=OTM&fromDate=2026-08-14&toDate=2026-08-14` +
        `&strikeCount=500`,
    );
    expect(result.ok).toBe(true);
    const paths = uwFetchMock.mock.calls
      .map(([, p]) => p)
      .filter((p) => p.includes('/option-contracts'));
    expect(paths).toEqual([
      '/stock/SPX/option-contracts?expiry=2026-08-14&limit=500&page=0&maybe_otm_only=true',
    ]);
  });

  it('does NOT apply maybe_otm_only for range=ALL (full-ladder consumers)', async () => {
    mockSpxSpot();
    await chainAdapter(SPX_0DTE_PATH);
    const paths = uwFetchMock.mock.calls
      .map(([, p]) => p)
      .filter((p) => p.includes('/option-contracts'));
    expect(paths.every((p) => !p.includes('maybe_otm_only'))).toBe(true);
  });

  it('routes $NDX chain spot straight to the UW screener (sidecar allowlist excludes NDX; UW has no index stock-state)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path === screenerPath('NDX')) {
        return screenerRows('NDX', {
          close: '23985.5',
          prev_close: '23900.1',
          high: '24010.5',
          low: '23880',
        });
      }
      return [];
    });
    const result = await chainAdapter(
      `/chains?symbol=$NDX&contractType=ALL&fromDate=2026-08-14` +
        `&toDate=2026-08-14&strikeCount=500`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const chain = result.data as {
      underlying: { symbol: string; last: number; close: number };
    };
    expect(chain.underlying).toMatchObject({
      symbol: '$NDX',
      last: 23985.5,
      close: 23900.1,
    });
    // No sidecar call — it would 400 (NDX not in _THETA_INDEX_ROOTS).
    expect(fetchSpy).not.toHaveBeenCalled();
    // UW stock-state 422s deterministically for index roots — must
    // never be requested for one.
    expect(
      uwFetchMock.mock.calls.some(([, p]) => p.includes('/stock-state')),
    ).toBe(false);
    // The screener carried a close — the spot-exposures bucket is a
    // fallback only, never an extra call on the happy path.
    expect(
      uwFetchMock.mock.calls.some(([, p]) => p.includes('/spot-exposures')),
    ).toBe(false);
  });

  it('falls back to the UW spot-exposures strike bucket for $NDX when the screener row has no close (the 2026-08-19 RTH blank)', async () => {
    // Prod 2026-08-19: every fetch-strike-iv NDXP chain and every
    // fetch-spx-candles-1m NDX leg failed 13:30→16:00 ET with
    // "UW screener: no price for index NDX" — the screener's index
    // `close` is the last OFFICIAL close (prior close pre-open, today's
    // after the bell) and missing intraday. The strike-grid-rounded spot
    // on /spot-exposures/strike (5-pt grid, ±2.5 on ~29,400 = ±0.0085%)
    // is the live source that keeps the chain (and the candle ratio)
    // alive through the session.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path === screenerPath('NDX')) {
        return screenerRows('NDX', NDX_RTH_SCREENER_ROW);
      }
      if (path === spotBucketPath('NDX')) return spotBucketRows('29425');
      return [];
    });
    const result = await chainAdapter(
      `/chains?symbol=$NDX&contractType=ALL&fromDate=2026-08-14` +
        `&toDate=2026-08-14&strikeCount=500`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const chain = result.data as {
      underlying: { symbol: string; last: number; close: number };
    };
    expect(chain.underlying).toEqual({
      symbol: '$NDX',
      last: 29425,
      close: 29490.957,
      change: -65.957,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    // Screener first (prev close / high / low), bucket second, then the
    // chain's own option-contracts page.
    expect(uwFetchMock.mock.calls.map(([, p]) => p)).toEqual([
      screenerPath('NDX'),
      spotBucketPath('NDX'),
      expect.stringContaining('/stock/NDX/option-contracts'),
    ]);
  });

  it('keeps the $NDX chain spot alive from the bucket even when the screener row is absent entirely', async () => {
    uwFetchMock.mockImplementation(async (_key, path) => {
      // Companion SPY row only — no NDX row at all.
      if (path === screenerPath('NDX')) return [SPY_SCREENER_ROW];
      if (path === spotBucketPath('NDX')) return spotBucketRows('29425');
      return [];
    });
    const result = await chainAdapter(
      `/chains?symbol=$NDX&contractType=ALL&fromDate=2026-08-14` +
        `&toDate=2026-08-14&strikeCount=500`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const chain = result.data as {
      underlying: { symbol: string; last: number; close: number };
    };
    // No prev close to be had → 0, exactly like the screener's own
    // missing-field degrade; `last` is the load-bearing field.
    expect(chain.underlying).toMatchObject({ last: 29425, close: 0 });
  });

  it('is still a 502 naming the root when both the screener close and the bucket are empty for $NDX', async () => {
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path === screenerPath('NDX')) {
        return screenerRows('NDX', NDX_RTH_SCREENER_ROW);
      }
      return [];
    });
    const result = await chainAdapter(
      `/chains?symbol=$NDX&contractType=ALL&fromDate=2026-08-14` +
        `&toDate=2026-08-14&strikeCount=500`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(result.code).toBeUndefined();
    expect(result.error).toContain('NDX');
    expect(uwFetchMock.mock.calls.map(([, p]) => p)).toEqual([
      screenerPath('NDX'),
      spotBucketPath('NDX'),
    ]);
  });

  it('returns 501 SOURCE_UNAVAILABLE (not 502) for $RUT — no UW index price exists', async () => {
    // Recon 2026-08-18: UW screener/max-pain/iv-rank all carry NULL for
    // RUT and stock-state 422s. Report the honest no-source code so the
    // schwab-fetch passthrough can serve it when Schwab is configured,
    // instead of the old deterministic 502 [SCHWAB_API_422].
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const path =
      `/chains?symbol=$RUT&contractType=ALL&fromDate=2026-08-14` +
      `&toDate=2026-08-14&strikeCount=500`;
    const result = await chainAdapter(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(501);
    expect(result.code).toBe('SOURCE_UNAVAILABLE');
    expect(result.error).toContain('/chains');
    // Known-unavailable roots must not burn sidecar or UW budget.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(uwFetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the midpoint weekday when a ranged window has no Friday (14-DTE on a Monday)', async () => {
    // Monday 2026-08-17, 11:00 ET. The 14-DTE analyze block requests
    // fromDate=today+12 (Sat 2026-08-29) .. toDate=today+16 (Wed
    // 2026-09-02) — a window with NO Friday. The adapter must fall back
    // to the weekday closest to the window midpoint (Mon 2026-08-31 —
    // exactly 14 DTE) instead of returning an empty chain.
    vi.setSystemTime(new Date('2026-08-17T15:00:00Z'));
    mockSpxSpot();
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path.includes('/option-contracts')) {
        return [
          {
            option_symbol: 'SPXW260831C06600000',
            implied_volatility: 0.19,
            delta: 0.45,
            gamma: 0.002,
            theta: -0.9,
            vega: 1.2,
            open_interest: 321,
            volume: 42,
            nbbo_bid: 38.1,
            nbbo_ask: 39.5,
            last_price: 38.8,
          },
        ];
      }
      return [];
    });
    const result = await chainAdapter(
      `/chains?symbol=$SPX&contractType=CALL&includeUnderlyingQuote=true` +
        `&strategy=SINGLE&range=NTM&fromDate=2026-08-29&toDate=2026-09-02` +
        `&strikeCount=20`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = uwFetchMock.mock.calls
      .map(([, p]) => p)
      .filter((p) => p.includes('/option-contracts'));
    expect(paths).toEqual([
      '/stock/SPX/option-contracts?expiry=2026-08-31&limit=500&page=0&option_type=call',
    ]);
    const chain = result.data as {
      callExpDateMap: Record<string, Record<string, unknown[]>>;
    };
    // 2026-08-31 is 14 days from Monday 2026-08-17.
    expect(Object.keys(chain.callExpDateMap)).toEqual(['2026-08-31:14']);
  });

  it('falls back to the midpoint weekday on a Tuesday window too', async () => {
    // Tuesday 2026-08-18: window Sun 2026-08-30 .. Thu 2026-09-03,
    // midpoint Tue 2026-09-01 (exactly 14 DTE) — no Friday in window.
    vi.setSystemTime(new Date('2026-08-18T15:00:00Z'));
    mockSpxSpot();
    const result = await chainAdapter(
      `/chains?symbol=$SPX&contractType=PUT&range=NTM` +
        `&fromDate=2026-08-30&toDate=2026-09-03&strikeCount=20`,
    );
    expect(result.ok).toBe(true);
    const paths = uwFetchMock.mock.calls
      .map(([, p]) => p)
      .filter((p) => p.includes('/option-contracts'));
    expect(paths).toEqual([
      '/stock/SPX/option-contracts?expiry=2026-09-01&limit=500&page=0&option_type=put',
    ]);
  });

  it('assigns DTE per expiry in the map keys', async () => {
    mockSpxSpot();
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path.includes('expiry=2026-08-21')) {
        return [
          {
            option_symbol: 'SPXW260821C06600000',
            implied_volatility: 0.2,
            delta: 0.1,
            gamma: 0.001,
            theta: -0.5,
            vega: 0.4,
            open_interest: 10,
            volume: 1,
            nbbo_bid: 2,
            nbbo_ask: 2.2,
            last_price: 2.1,
          },
        ];
      }
      return [];
    });
    const result = await chainAdapter(
      `/chains?symbol=$SPX&contractType=ALL&fromDate=2026-08-14` +
        `&toDate=2026-08-28&strikeCount=500`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const chain = result.data as {
      callExpDateMap: Record<
        string,
        Record<string, { daysToExpiration: number }[]>
      >;
    };
    expect(Object.keys(chain.callExpDateMap)).toEqual(['2026-08-21:7']);
    expect(
      chain.callExpDateMap['2026-08-21:7']!['6600.0']![0]!.daysToExpiration,
    ).toBe(7);
  });

  it('paginates within an expiry until a short page (max 3 pages)', async () => {
    mockSpxSpot();
    const fullPage = Array.from({ length: 500 }, (_, i) => ({
      option_symbol: `SPXW260814C0${String(6000000 + i * 5000).padStart(7, '0')}`,
      implied_volatility: 0.2,
      delta: 0.1,
      gamma: 0.001,
      theta: -0.5,
      vega: 0.3,
      open_interest: 1,
      volume: 1,
      nbbo_bid: 1,
      nbbo_ask: 1.2,
      last_price: 1.1,
    }));
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (!path.includes('/option-contracts')) return [];
      return path.includes('page=0') ? fullPage : fullPage.slice(0, 10);
    });
    await chainAdapter(SPX_0DTE_PATH);
    const paths = uwFetchMock.mock.calls
      .map(([, p]) => p)
      .filter((p) => p.includes('/option-contracts'));
    expect(paths).toEqual([
      '/stock/SPX/option-contracts?expiry=2026-08-14&limit=500&page=0',
      '/stock/SPX/option-contracts?expiry=2026-08-14&limit=500&page=1',
    ]);
  });

  it('passes option_type for one-sided requests and returns an empty other map', async () => {
    mockSpxSpot();
    const result = await chainAdapter(
      `/chains?symbol=$SPX&contractType=CALL&includeUnderlyingQuote=true` +
        `&strategy=SINGLE&range=NTM&fromDate=2026-08-26&toDate=2026-08-30` +
        `&strikeCount=20`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = uwFetchMock.mock.calls
      .map(([, p]) => p)
      .filter((p) => p.includes('/option-contracts'));
    // The 5-day window 08-26..08-30 contains exactly one Friday (08-28).
    expect(paths).toEqual([
      '/stock/SPX/option-contracts?expiry=2026-08-28&limit=500&page=0&option_type=call',
    ]);
    const chain = result.data as { putExpDateMap: object };
    expect(chain.putExpDateMap).toEqual({});
  });

  it('uses UW stock-state for equity underlyings', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path.includes('/stock-state')) {
        return [{ close: '644.4', prev_close: '642.2' }];
      }
      return [];
    });
    const result = await chainAdapter(
      `/chains?symbol=SPY&contractType=ALL&fromDate=2026-08-14` +
        `&toDate=2026-08-14&strikeCount=500`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const chain = result.data as {
      underlying: { symbol: string; last: number; close: number };
    };
    expect(chain.underlying).toMatchObject({
      symbol: 'SPY',
      last: 644.4,
      close: 642.2,
    });
    expect(fetchSpy).not.toHaveBeenCalled(); // no sidecar for equities
    expect(
      uwFetchMock.mock.calls.some(([, p]) => p === '/stock/SPY/stock-state'),
    ).toBe(true);
  });

  it('falls back to the UW screener when the sidecar spot times out', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
    );
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path === screenerPath('SPX')) {
        return screenerRows('SPX', { close: 6465.25, prev_close: 6450.25 });
      }
      return [];
    });
    const result = await chainAdapter(SPX_0DTE_PATH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const chain = result.data as {
      underlying: { last: number; close: number };
    };
    expect(chain.underlying).toMatchObject({ last: 6465.25, close: 6450.25 });
    expect(
      uwFetchMock.mock.calls.some(([, p]) => p.includes('/stock-state')),
    ).toBe(false);
  });

  it('falls back to the UW screener on a sidecar 503 theta_unavailable (the 2026-08-18 prod blip)', async () => {
    // Prod on 08-18: sidecar Theta blipped 503 → the old UW stock-state
    // fallback 422'd deterministically → /api/chain 502 [SCHWAB_API_422]
    // ×7. The screener fallback must turn that into an ok chain.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonRes({ error: 'theta_unavailable' }, 503));
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path === screenerPath('SPX')) {
        return screenerRows('SPX', {
          close: '7691.76',
          prev_close: '7745.06',
          high: '7713.95',
          low: '7688.63',
        });
      }
      return [];
    });
    const result = await chainAdapter(SPX_0DTE_PATH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const chain = result.data as {
      underlying: { symbol: string; last: number; close: number };
    };
    expect(chain.underlying).toEqual({
      symbol: '$SPX',
      last: 7691.76,
      close: 7745.06,
      change: -53.3,
    });
    // Terminal down is NOT retried — one sidecar call, straight to UW.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry the chain spot on a 503 theta_busy shed for a UW-carried root — it falls straight to the screener', async () => {
    // A shed means the Terminal slots are saturated (history burst). For
    // SPX the screener carries a live close, so the ≥6s a retry would
    // cost (Retry-After + a second slot wait) buys nothing the screener
    // doesn't already give us — one sidecar call, then UW. Real timers
    // on purpose: a regression that sleeps the backoff shows up as a
    // second sidecar call, not as a hung test.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(thetaBusyRes('1'));
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path === screenerPath('SPX')) {
        return screenerRows('SPX', {
          close: '7713.45',
          prev_close: '7691.76',
          high: '7743.93',
          low: '7700.07',
        });
      }
      return [];
    });
    const result = await chainAdapter(SPX_0DTE_PATH);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const chain = result.data as {
      underlying: { last: number; close: number };
    };
    expect(chain.underlying).toMatchObject({ last: 7713.45, close: 7691.76 });
    expect(
      uwFetchMock.mock.calls.some(([, p]) => p === screenerPath('SPX')),
    ).toBe(true);
  });

  it('is a 502 (transient), never 501, when the sidecar is down and the screener row has no price', async () => {
    // A UW-carried root that momentarily comes back without a close is
    // a transient upstream failure, not "no source" — it must NOT be
    // reported as SOURCE_UNAVAILABLE (that code triggers the Schwab
    // passthrough, which is reserved for genuinely uncovered symbols).
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({}, 500));
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path === screenerPath('SPX')) {
        return screenerRows('SPX', { close: null, prev_close: '7745.06' });
      }
      return [];
    });
    const result = await chainAdapter(SPX_0DTE_PATH);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(result.code).toBeUndefined();
    expect(result.error).toContain('[SCHWAB_API_502]');
    expect(result.error).toContain('SPX');
    // The spot-exposures bucket is an NDX-only fallback: a 5-pt grid is
    // ±0.03% on SPX — too coarse for the 0DTE spot /api/chain shows —
    // and the screener carries a live SPX close intraday anyway.
    expect(
      uwFetchMock.mock.calls.some(([, p]) => p.includes('/spot-exposures')),
    ).toBe(false);
  });

  it('maps UW 429s to status 429 with a [SCHWAB_API_429] prefix', async () => {
    mockSpxSpot();
    uwFetchMock.mockRejectedValue(
      new Error('UW API 429: {"message":"rate limit of 120 in 60 seconds"}'),
    );
    const result = await chainAdapter(SPX_0DTE_PATH);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(429);
    expect(result.error.startsWith('[SCHWAB_API_429]')).toBe(true);
  });

  it('fails closed when spot is unavailable from both sources', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({}, 500));
    uwFetchMock.mockRejectedValue(new Error('UW API 500: boom'));
    const result = await chainAdapter(SPX_0DTE_PATH);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(result.error).toContain('[SCHWAB_API_500]');
  });
});

// ── historyAdapter ───────────────────────────────────────────

describe('historyAdapter', () => {
  it('serves index 5-min candles from the sidecar with RTH filtering, aggregation, and previousClose', async () => {
    const d13 = (h: number, m: number) => Date.UTC(2026, 7, 13, h, m);
    const d14 = (h: number, m: number) => Date.UTC(2026, 7, 14, h, m);
    const fetchSpy = mockSidecar({
      'date=2026-08-13': {
        root: 'SPX',
        date: '2026-08-13',
        candles: [
          // 9:29 ET — pre-open, must be dropped.
          {
            ts_ms: d13(13, 29),
            open: 6390,
            high: 6391,
            low: 6389,
            close: 6390,
          },
          {
            ts_ms: d13(13, 30),
            open: 6400,
            high: 6402,
            low: 6399,
            close: 6401,
          },
          {
            ts_ms: d13(13, 31),
            open: 6401,
            high: 6403,
            low: 6400,
            close: 6402,
          },
          {
            ts_ms: d13(13, 34),
            open: 6402,
            high: 6405,
            low: 6401,
            close: 6404,
          },
          {
            ts_ms: d13(13, 35),
            open: 6404,
            high: 6406,
            low: 6403,
            close: 6405,
          },
          {
            ts_ms: d13(19, 59),
            open: 6449,
            high: 6451,
            low: 6448,
            close: 6450.1,
          },
          // 16:00 ET — post-close, must be dropped.
          { ts_ms: d13(20, 0), open: 6450, high: 6450, low: 6450, close: 6450 },
        ],
      },
      'date=2026-08-14': {
        root: 'SPX',
        date: '2026-08-14',
        candles: [
          {
            ts_ms: d14(13, 30),
            open: 6460,
            high: 6461,
            low: 6459,
            close: 6460.5,
          },
          {
            ts_ms: d14(13, 31),
            open: 6460.5,
            high: 6462,
            low: 6460,
            close: 6461,
          },
        ],
      },
    });

    const startMs = Date.UTC(2026, 7, 13, 15, 0);
    const endMs = Date.UTC(2026, 7, 14, 15, 0);
    const result = await historyAdapter(
      `/pricehistory?symbol=%24SPX&periodType=day&frequencyType=minute` +
        `&frequency=5&startDate=${startMs}&endDate=${endMs}` +
        `&needExtendedHoursData=false&needPreviousClose=true`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as {
      symbol: string;
      empty: boolean;
      previousClose: number;
      candles: {
        datetime: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      }[];
    };

    expect(data.symbol).toBe('$SPX');
    expect(data.empty).toBe(false);
    expect(data.candles).toEqual([
      {
        datetime: d13(13, 30),
        open: 6400,
        high: 6405,
        low: 6399,
        close: 6404,
        volume: 0,
      },
      {
        datetime: d13(13, 35),
        open: 6404,
        high: 6406,
        low: 6403,
        close: 6405,
        volume: 0,
      },
      {
        datetime: d13(19, 55),
        open: 6449,
        high: 6451,
        low: 6448,
        close: 6450.1,
        volume: 0,
      },
      {
        datetime: d14(13, 30),
        open: 6460,
        high: 6462,
        low: 6459,
        close: 6461,
        volume: 0,
      },
    ]);
    // previousClose = last RTH close of the session before the latest one.
    expect(data.previousClose).toBe(6450.1);

    // Sidecar auth header + timeout signal on every call.
    for (const call of fetchSpy.mock.calls) {
      const [url, init] = call as [string, RequestInit];
      expect(
        url.startsWith(`${SIDECAR}/theta/index/history?root=SPX&date=`),
      ).toBe(true);
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer shh',
      );
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('serves equity 1-min candles from UW ohlc/1m with volume preserved', async () => {
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path === '/stock/NVDA/ohlc/1m?date=2026-08-13') {
        return [
          {
            start_time: '2026-08-13T19:59:00Z',
            open: '180.5',
            high: '181.5',
            low: '180.4',
            close: '181.2',
            volume: 500,
            market_time: 'r',
          },
          {
            start_time: '2026-08-13T20:05:00Z',
            open: '181.3',
            high: '181.4',
            low: '181.1',
            close: '181.15',
            volume: 50,
            market_time: 'po', // post-market — dropped
          },
        ];
      }
      if (path === '/stock/NVDA/ohlc/1m?date=2026-08-14') {
        return [
          {
            start_time: '2026-08-14T13:30:00Z',
            open: '182',
            high: '182.5',
            low: '181.8',
            close: '182.2',
            volume: 100,
            market_time: 'r',
          },
          {
            start_time: '2026-08-14T13:31:00Z',
            open: '182.2',
            high: '182.6',
            low: '182.1',
            close: '182.4',
            volume: 200,
            market_time: 'r',
          },
        ];
      }
      return [];
    });

    const endMs = Date.UTC(2026, 7, 14, 15, 0);
    const startMs = endMs - 5 * 24 * 60 * 60 * 1000;
    const result = await historyAdapter(
      `/pricehistory?symbol=NVDA&periodType=day&period=1&frequencyType=minute` +
        `&frequency=1&startDate=${startMs}&endDate=${endMs}` +
        `&needExtendedHoursData=false&needPreviousClose=true`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as {
      previousClose: number;
      candles: { datetime: number; close: number; volume: number }[];
    };
    expect(data.candles).toEqual([
      {
        datetime: Date.parse('2026-08-13T19:59:00Z'),
        open: 180.5,
        high: 181.5,
        low: 180.4,
        close: 181.2,
        volume: 500,
      },
      {
        datetime: Date.parse('2026-08-14T13:30:00Z'),
        open: 182,
        high: 182.5,
        low: 181.8,
        close: 182.2,
        volume: 100,
      },
      {
        datetime: Date.parse('2026-08-14T13:31:00Z'),
        open: 182.2,
        high: 182.6,
        low: 182.1,
        close: 182.4,
        volume: 200,
      },
    ]);
    expect(data.previousClose).toBe(181.2);
    // No sidecar traffic for equities; UW hit weekdays only.
    const paths = uwFetchMock.mock.calls.map(([, p]) => p);
    expect(paths).toContain('/stock/NVDA/ohlc/1m?date=2026-08-10');
    expect(paths).not.toContain('/stock/NVDA/ohlc/1m?date=2026-08-09'); // Sunday
  });

  it('aggregates daily candles with UTC+ET-safe datetimes for periodType=month', async () => {
    mockSidecar({
      'date=2026-08-13': {
        candles: [
          {
            ts_ms: Date.UTC(2026, 7, 13, 13, 30),
            open: 6400,
            high: 6402,
            low: 6399,
            close: 6401,
          },
          {
            ts_ms: Date.UTC(2026, 7, 13, 19, 59),
            open: 6449,
            high: 6451,
            low: 6448,
            close: 6450.1,
          },
        ],
      },
      'date=2026-08-14': {
        candles: [
          {
            ts_ms: Date.UTC(2026, 7, 14, 13, 30),
            open: 6460,
            high: 6461,
            low: 6459,
            close: 6460.5,
          },
        ],
      },
    });

    const result = await historyAdapter(
      '/pricehistory?symbol=%24SPX&periodType=month&period=1&frequencyType=daily&frequency=1',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as {
      candles: {
        datetime: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      }[];
    };
    expect(data.candles).toEqual([
      {
        datetime: Date.UTC(2026, 7, 13, 12, 0),
        open: 6400,
        high: 6451,
        low: 6399,
        close: 6450.1,
        volume: 0,
      },
      {
        datetime: Date.UTC(2026, 7, 14, 12, 0),
        open: 6460,
        high: 6461,
        low: 6459,
        close: 6460.5,
        volume: 0,
      },
    ]);
    // Consumers derive the date via UTC parts (yesterday.ts) AND via ET
    // (fetch-outcomes backfill) — both must resolve to the trading date.
    const first = new Date(data.candles[0]!.datetime);
    expect(first.toISOString().slice(0, 10)).toBe('2026-08-13');
  });

  it('returns 501 SOURCE_UNAVAILABLE for NYSE internals symbols', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const sym of ['%24TICK', '%24TRIN']) {
      const result = await historyAdapter(
        `/pricehistory?symbol=${sym}&periodType=day&frequencyType=minute&frequency=1`,
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.status).toBe(501);
      expect(result.code).toBe('SOURCE_UNAVAILABLE');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(uwFetchMock).not.toHaveBeenCalled();
  });

  it('fails the whole call on a sidecar 5xx (no partial long-cache poisoning)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ err: 'x' }, 500));
    const startMs = Date.UTC(2026, 7, 13, 15, 0);
    const endMs = Date.UTC(2026, 7, 14, 15, 0);
    const result = await historyAdapter(
      `/pricehistory?symbol=%24VIX&periodType=day&frequencyType=minute` +
        `&frequency=5&startDate=${startMs}&endDate=${endMs}`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(result.error).toContain('[SCHWAB_API_500]');
  });

  it('maps sidecar timeouts to 504 [SCHWAB_API_NETWORK]', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('The operation timed out'), {
        name: 'TimeoutError',
      }),
    );
    const result = await historyAdapter(
      `/pricehistory?symbol=%24SPX&periodType=day&period=1&frequencyType=minute&frequency=5`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(504);
    expect(result.error.startsWith('[SCHWAB_API_NETWORK]')).toBe(true);
  });

  it('treats all-404 sidecar days as an empty (ok) result', async () => {
    const fetchSpy = mockSidecar({}); // everything 404s
    const result = await historyAdapter(
      `/pricehistory?symbol=%24SPX&periodType=day&period=1&frequencyType=minute&frequency=5`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { empty: boolean; candles: unknown[] };
    expect(data.empty).toBe(true);
    expect(data.candles).toEqual([]);
    // 404 is an authoritative "no data" — exactly one call for the one
    // trading date, never a retry.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // ── Sidecar fan-out + theta_busy shed handling ──────────────
  //
  // The sidecar serialises /theta/index/* to cap 2 with a 5s wait
  // budget and sheds `503 theta_busy` + `Retry-After: 1` past it
  // (sidecar/src/health.py theta_index_slot). /api/history fans ~4-5
  // trading dates × 5 symbols (in pairs) through this adapter, so the
  // per-date client concurrency is the only knob that keeps arrivals
  // inside that budget, and a single shed date must not blank the
  // symbol.

  const SEVEN_DATES = {
    // Thu 2026-08-06 → Fri 2026-08-14 (today) = 7 trading dates.
    startMs: Date.UTC(2026, 7, 6, 15, 0),
    endMs: Date.UTC(2026, 7, 14, 15, 0),
  };

  function indexHistoryPath(symbol = '%24VIX1D'): string {
    return (
      `/pricehistory?symbol=${symbol}&periodType=day&frequencyType=minute` +
      `&frequency=5&startDate=${SEVEN_DATES.startMs}&endDate=${SEVEN_DATES.endMs}`
    );
  }

  const ONE_BAR = (date: string) => ({
    root: 'VIX1D',
    date,
    candles: [
      {
        ts_ms: Date.parse(`${date}T13:30:00Z`),
        open: 13.1,
        high: 13.2,
        low: 13,
        close: 13.15,
      },
    ],
  });

  function dateOf(url: string): string {
    return /date=(\d{4}-\d{2}-\d{2})/.exec(url)?.[1] ?? '';
  }

  it('maps a [D-5d noon, D noon] window to exactly the trading dates through D, with previousClose from the session before D', async () => {
    // /api/history's window contract: Mon 2026-08-17 → Wed 08-12, Thu
    // 08-13, Fri 08-14, Mon 08-17 — no weekend, no look-ahead past D, and
    // D is the LAST session in range so `previousClose` is Friday's close
    // (the old +2d look-ahead made it TOMORROW's close for a backtest of D).
    vi.setSystemTime(new Date('2026-08-18T15:00:00Z'));
    const targetMs = Date.UTC(2026, 7, 17, 12, 0);
    const startMs = targetMs - 5 * 24 * 60 * 60 * 1000;
    const bar = (date: string, close: number) => ({
      root: 'SPX',
      date,
      candles: [
        {
          ts_ms: Date.parse(`${date}T13:30:00Z`),
          open: close - 1,
          high: close + 1,
          low: close - 2,
          close,
        },
      ],
    });
    const fetchSpy = mockSidecar({
      'date=2026-08-11': bar('2026-08-11', 6300),
      'date=2026-08-12': bar('2026-08-12', 6310),
      'date=2026-08-13': bar('2026-08-13', 6320),
      'date=2026-08-14': bar('2026-08-14', 6330),
      'date=2026-08-17': bar('2026-08-17', 6340),
      'date=2026-08-18': bar('2026-08-18', 6350),
    });

    const result = await historyAdapter(
      `/pricehistory?symbol=%24SPX&periodType=day&frequencyType=minute` +
        `&frequency=5&startDate=${startMs}&endDate=${targetMs}`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fetched = (fetchSpy.mock.calls as unknown[][])
      .map((c) => dateOf(String(c[0])))
      .sort((a, b) => a.localeCompare(b));
    expect(fetched).toEqual([
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
      '2026-08-17',
    ]);

    const data = result.data as {
      candles: { datetime: number; close: number }[];
      previousClose: number;
    };
    expect(data.candles).toHaveLength(4);
    expect(data.candles.at(-1)?.close).toBe(6340);
    expect(data.previousClose).toBe(6330);
  });

  it('fans an index root out at most 3 dates wide (INDEX_HISTORY_CONCURRENCY), not 6', async () => {
    const probe = concurrencyProbe((url) => jsonRes(ONE_BAR(dateOf(url))));
    const result = await historyAdapter(indexHistoryPath());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { candles: unknown[] };
    expect(data.candles).toHaveLength(7);
    expect(probe.spy).toHaveBeenCalledTimes(7);
    expect(probe.peak()).toBe(3);
  });

  it('keeps the UW equity fan-out at 6 wide (HISTORY_CONCURRENCY; UW has its own semaphore)', async () => {
    let inFlight = 0;
    let peak = 0;
    uwFetchMock.mockImplementation(async (_key, path) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      const date = dateOf(path);
      return [
        {
          start_time: `${date}T13:30:00Z`,
          open: '180',
          high: '181',
          low: '179',
          close: '180.5',
          volume: 100,
          market_time: 'r',
        },
      ];
    });
    const result = await historyAdapter(indexHistoryPath('NVDA'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { candles: unknown[] };
    expect(data.candles).toHaveLength(7);
    expect(uwFetchMock).toHaveBeenCalledTimes(7);
    expect(peak).toBe(6);
  });

  it('retries a shed date once after Retry-After (503 theta_busy) and keeps the symbol', async () => {
    fakeRetryTimers();
    let shed = 0;
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockImplementation(async (input) => {
      const url = String(input);
      // The first arrival for 08-12 loses the Terminal-slot race.
      if (url.includes('date=2026-08-12') && shed === 0) {
        shed += 1;
        return thetaBusyRes('1');
      }
      return jsonRes(ONE_BAR(dateOf(url)));
    });

    const pending = historyAdapter(indexHistoryPath());
    // Every date has been tried once; the shed one is parked on its
    // backoff and has NOT been re-sent before Retry-After elapses.
    await vi.advanceTimersByTimeAsync(999);
    expect(spy).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(spy).toHaveBeenCalledTimes(8);
    expect(
      spy.mock.calls.filter(([u]) => String(u).includes('date=2026-08-12')),
    ).toHaveLength(2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { empty: boolean; candles: unknown[] };
    expect(data.empty).toBe(false);
    // All seven sessions present — the shed date came back on retry.
    expect(data.candles).toHaveLength(7);
  });

  it('waits ~1s by default when the theta_busy 503 has no Retry-After, and caps a long one at 2s', async () => {
    fakeRetryTimers();
    const spy = vi.spyOn(globalThis, 'fetch');
    let calls = 0;
    spy.mockImplementation(async (input) => {
      calls += 1;
      // 1st call: busy, no header → default backoff. 2nd: data.
      // 3rd call (second adapter call): busy, Retry-After: 30 → capped.
      if (calls === 1) return thetaBusyRes(null);
      if (calls === 3) return thetaBusyRes('30');
      return jsonRes(ONE_BAR(dateOf(String(input))));
    });
    const oneDay =
      `/pricehistory?symbol=%24VIX1D&periodType=day&period=1` +
      `&frequencyType=minute&frequency=5`;

    const first = historyAdapter(oneDay);
    await vi.advanceTimersByTimeAsync(999);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await first).ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);

    const second = historyAdapter(oneDay);
    await vi.advanceTimersByTimeAsync(1999);
    expect(spy).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect((await second).ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('gives up after ONE retry when the sidecar sheds twice — the original 503 surfaces, no loop', async () => {
    fakeRetryTimers();
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockImplementation(async () => thetaBusyRes('1'));
    const pending = historyAdapter(
      `/pricehistory?symbol=%24VIX1D&periodType=day&period=1&frequencyType=minute&frequency=5`,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    // One date → first try + exactly one retry.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(result.error).toContain('[SCHWAB_API_503]');
    expect(result.error).toContain('theta_busy');
  });

  it('does NOT retry a 503 theta_unavailable (Terminal down — a second call cannot help)', async () => {
    fakeRetryTimers();
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockImplementation(async () =>
      jsonRes({ error: 'theta_unavailable' }, 503, { 'Retry-After': '1' }),
    );
    const pending = historyAdapter(
      `/pricehistory?symbol=%24VIX1D&periodType=day&period=1&frequencyType=minute&frequency=5`,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(result.error).toContain('[SCHWAB_API_503]');
    expect(result.error).toContain('theta_unavailable');
  });

  it('lets a retry that answers 404 stand as "no data" instead of re-raising the shed', async () => {
    fakeRetryTimers();
    const spy = vi.spyOn(globalThis, 'fetch');
    let calls = 0;
    spy.mockImplementation(async () => {
      calls += 1;
      return calls === 1
        ? thetaBusyRes('1')
        : jsonRes({ error: 'no_data' }, 404);
    });
    const pending = historyAdapter(
      `/pricehistory?symbol=%24VIX1D&periodType=day&period=1&frequencyType=minute&frequency=5`,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { empty: boolean }).empty).toBe(true);
  });

  // ── Zero-price sanitizing (Theta "no print this minute") ────
  //
  // Real payload, 2026-08-19: GET /theta/index/history?root=VIX
  // returned 312 one-minute bars, 70 of them all-zero (the session's
  // FIRST bar among them) plus PARTIAL bars like
  // `{open:0, high:15.13, low:0, close:15.12}`. A `0` is Theta's
  // "no print" marker for index roots, never a price — letting one
  // through poisons every downstream min/range (VIX session low, the
  // running OHLC low, term structure).

  it('drops all-zero index bars and rebuilds partial ones from the fields that are present', async () => {
    const d14 = (h: number, m: number) => Date.UTC(2026, 7, 14, h, m);
    mockSidecar({
      'date=2026-08-14': {
        root: 'VIX',
        date: '2026-08-14',
        candles: [
          // No print this minute — dropped entirely.
          { ts_ms: d14(13, 30), open: 0, high: 0, low: 0, close: 0 },
          // Partial — survives with open=close=low=15.12 / high=15.13.
          { ts_ms: d14(13, 31), open: 0, high: 15.13, low: 0, close: 15.12 },
          // Normal — untouched (regression).
          {
            ts_ms: d14(13, 32),
            open: 15.12,
            high: 15.2,
            low: 15.05,
            close: 15.18,
          },
        ],
      },
    });

    const startMs = Date.UTC(2026, 7, 14, 13, 0);
    const endMs = Date.UTC(2026, 7, 14, 15, 0);
    const result = await historyAdapter(
      `/pricehistory?symbol=%24VIX&periodType=day&frequencyType=minute` +
        `&frequency=1&startDate=${startMs}&endDate=${endMs}`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as {
      candles: {
        datetime: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      }[];
    };
    expect(data.candles).toEqual([
      // A no-print open is best approximated by the bar's close (not
      // its high): {open:0, high:15.13, low:0, close:15.12} → open 15.12.
      {
        datetime: d14(13, 31),
        open: 15.12,
        high: 15.13,
        low: 15.12,
        close: 15.12,
        volume: 0,
      },
      {
        datetime: d14(13, 32),
        open: 15.12,
        high: 15.2,
        low: 15.05,
        close: 15.18,
        volume: 0,
      },
    ]);
  });

  it('drops an all-zero 5-minute bucket and takes the minimum POSITIVE low in a mixed one', async () => {
    const d14 = (h: number, m: number) => Date.UTC(2026, 7, 14, h, m);
    mockSidecar({
      'date=2026-08-14': {
        root: 'VIX',
        date: '2026-08-14',
        candles: [
          // 9:30–9:34 ET: nothing printed all window → no bucket.
          { ts_ms: d14(13, 30), open: 0, high: 0, low: 0, close: 0 },
          { ts_ms: d14(13, 31), open: 0, high: 0, low: 0, close: 0 },
          { ts_ms: d14(13, 34), open: 0, high: 0, low: 0, close: 0 },
          // 9:35–9:39 ET: partial + no-print + normal.
          { ts_ms: d14(13, 35), open: 0, high: 15.13, low: 0, close: 15.12 },
          { ts_ms: d14(13, 36), open: 0, high: 0, low: 0, close: 0 },
          {
            ts_ms: d14(13, 37),
            open: 15.12,
            high: 15.3,
            low: 15.02,
            close: 15.28,
          },
        ],
      },
    });

    const startMs = Date.UTC(2026, 7, 14, 13, 0);
    const endMs = Date.UTC(2026, 7, 14, 15, 0);
    const result = await historyAdapter(
      `/pricehistory?symbol=%24VIX&periodType=day&frequencyType=minute` +
        `&frequency=5&startDate=${startMs}&endDate=${endMs}`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as {
      candles: {
        datetime: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      }[];
    };
    expect(data.candles).toEqual([
      {
        datetime: d14(13, 35),
        // Bucket opens on the partial bar's reconstructed open (= its close).
        open: 15.12,
        high: 15.3,
        low: 15.02,
        close: 15.28,
        volume: 0,
      },
    ]);
  });

  it('keeps previousClose on the last REAL close when the prior session ends on a no-print minute', async () => {
    const d13 = (h: number, m: number) => Date.UTC(2026, 7, 13, h, m);
    const d14 = (h: number, m: number) => Date.UTC(2026, 7, 14, h, m);
    mockSidecar({
      'date=2026-08-13': {
        root: 'VIX',
        date: '2026-08-13',
        candles: [
          {
            ts_ms: d13(19, 58),
            open: 15.4,
            high: 15.46,
            low: 15.38,
            close: 15.44,
          },
          // 15:59 ET — no print; must not become previousClose 0.
          { ts_ms: d13(19, 59), open: 0, high: 0, low: 0, close: 0 },
        ],
      },
      'date=2026-08-14': {
        root: 'VIX',
        date: '2026-08-14',
        candles: [
          {
            ts_ms: d14(13, 30),
            open: 15.5,
            high: 15.55,
            low: 15.45,
            close: 15.52,
          },
        ],
      },
    });

    const startMs = Date.UTC(2026, 7, 13, 15, 0);
    const endMs = Date.UTC(2026, 7, 14, 15, 0);
    const result = await historyAdapter(
      `/pricehistory?symbol=%24VIX&periodType=day&frequencyType=minute` +
        `&frequency=5&startDate=${startMs}&endDate=${endMs}`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { previousClose: number };
    expect(data.previousClose).toBe(15.44);
  });

  it('applies the same zero guard to UW equity 1-min bars (volume preserved)', async () => {
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path === '/stock/NVDA/ohlc/1m?date=2026-08-14') {
        return [
          {
            start_time: '2026-08-14T13:30:00Z',
            open: '0',
            high: '0',
            low: '0',
            close: '0',
            volume: 0,
            market_time: 'r',
          },
          {
            start_time: '2026-08-14T13:31:00Z',
            open: '0',
            high: '181.5',
            low: '0',
            close: '181.2',
            volume: 300,
            market_time: 'r',
          },
        ];
      }
      return [];
    });

    const startMs = Date.UTC(2026, 7, 14, 13, 0);
    const endMs = Date.UTC(2026, 7, 14, 15, 0);
    const result = await historyAdapter(
      `/pricehistory?symbol=NVDA&periodType=day&frequencyType=minute` +
        `&frequency=1&startDate=${startMs}&endDate=${endMs}`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as {
      candles: {
        datetime: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      }[];
    };
    expect(data.candles).toEqual([
      {
        datetime: Date.parse('2026-08-14T13:31:00Z'),
        open: 181.2,
        high: 181.5,
        low: 181.2,
        close: 181.2,
        volume: 300,
      },
    ]);
  });

  it('omits an all-no-print session from the daily rollup and keeps the positive low', async () => {
    mockSidecar({
      'date=2026-08-13': {
        root: 'VIX',
        date: '2026-08-13',
        candles: [
          {
            ts_ms: Date.UTC(2026, 7, 13, 13, 30),
            open: 0,
            high: 0,
            low: 0,
            close: 0,
          },
          {
            ts_ms: Date.UTC(2026, 7, 13, 19, 59),
            open: 0,
            high: 0,
            low: 0,
            close: 0,
          },
        ],
      },
      'date=2026-08-14': {
        root: 'VIX',
        date: '2026-08-14',
        candles: [
          {
            ts_ms: Date.UTC(2026, 7, 14, 13, 30),
            open: 0,
            high: 15.13,
            low: 0,
            close: 15.12,
          },
          {
            ts_ms: Date.UTC(2026, 7, 14, 13, 31),
            open: 15.12,
            high: 15.3,
            low: 15.02,
            close: 15.28,
          },
        ],
      },
    });

    const startMs = Date.UTC(2026, 7, 13, 15, 0);
    const endMs = Date.UTC(2026, 7, 14, 15, 0);
    const result = await historyAdapter(
      `/pricehistory?symbol=%24VIX&periodType=day&frequencyType=daily` +
        `&frequency=1&startDate=${startMs}&endDate=${endMs}`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as {
      candles: {
        datetime: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      }[];
    };
    expect(data.candles).toEqual([
      {
        datetime: Date.UTC(2026, 7, 14, 12, 0),
        open: 15.12,
        high: 15.3,
        low: 15.02,
        close: 15.28,
        volume: 0,
      },
    ]);
  });
});

// ── quotesAdapter ────────────────────────────────────────────

describe('quotesAdapter', () => {
  it('assembles the Schwab quote map across sidecar indices and UW equities', async () => {
    // Real sidecar price contract carries NO open/high/low — the
    // adapter derives them from today's RTH history candles. $VIX1D
    // has no history route mocked (404 = pre-open) → OHL stay 0.
    mockSidecar({
      '/theta/index/price?root=SPX': {
        root: 'SPX',
        price: 6465.25,
        prev_close: 6450.25,
        ts: '2026-08-14T15:00:00Z',
      },
      '/theta/index/history?root=SPX': {
        root: 'SPX',
        date: '2026-08-14',
        candles: [
          // 9:29 ET — pre-open, must NOT contaminate the derived OHL.
          {
            ts_ms: Date.UTC(2026, 7, 14, 13, 29),
            open: 6300,
            high: 6600,
            low: 6200,
            close: 6400,
          },
          {
            ts_ms: Date.UTC(2026, 7, 14, 13, 30),
            open: 6455,
            high: 6460,
            low: 6448,
            close: 6458,
          },
          {
            ts_ms: Date.UTC(2026, 7, 14, 14, 0),
            open: 6458,
            high: 6470,
            low: 6440,
            close: 6465.25,
          },
        ],
      },
      '/theta/index/price?root=VIX1D': {
        root: 'VIX1D',
        price: 13.4,
        prev_close: 12.9,
        ts: '2026-08-14T15:00:00Z',
      },
    });
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path === '/stock/SPY/stock-state') {
        return [
          {
            open: '645.1',
            high: '646',
            low: '640.9',
            close: '644.4',
            prev_close: '642.2',
          },
        ];
      }
      return [];
    });

    const result = await quotesAdapter(
      '/quotes?symbols=SPY%2C%24SPX%2C%24VIX1D&fields=quote',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<
      string,
      { quote: Record<string, number> }
    >;

    expect(Object.keys(data).sort()).toEqual(['$SPX', '$VIX1D', 'SPY']);
    expect(data['$SPX']!.quote).toMatchObject({
      lastPrice: 6465.25,
      openPrice: 6455,
      highPrice: 6470,
      lowPrice: 6440,
      closePrice: 6450.25,
      netChange: 15,
    });
    expect(data['$SPX']!.quote.netPercentChange).toBeCloseTo(0.2326, 3);
    expect(data['$VIX1D']!.quote).toMatchObject({
      lastPrice: 13.4,
      closePrice: 12.9,
      netChange: 0.5,
      openPrice: 0,
      highPrice: 0,
      lowPrice: 0,
    });
    expect(data.SPY!.quote).toMatchObject({
      lastPrice: 644.4,
      openPrice: 645.1,
      highPrice: 646,
      lowPrice: 640.9,
      closePrice: 642.2,
      netChange: 2.2,
    });
  });

  it('returns 501 SOURCE_UNAVAILABLE when only internals are requested', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await quotesAdapter(
      '/quotes?symbols=%24ADD,%24VOLD&fields=quote',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(501);
    expect(result.code).toBe('SOURCE_UNAVAILABLE');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('omits failed symbols but keeps the response ok when others succeed', async () => {
    mockSidecar({
      'root=SPX': { price: 6465.25, prev_close: 6450.25 },
      // root=VVIX unmatched → 404
    });
    const result = await quotesAdapter(
      '/quotes?symbols=%24SPX%2C%24VVIX&fields=quote',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(['$SPX']);
  });

  it('fails when every requested symbol fails', async () => {
    // VVIX/VIX9D are sidecar-only (no UW fallback), so a sidecar
    // timeout is terminal and must surface as 504 [SCHWAB_API_NETWORK].
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('boom timed out'), { name: 'TimeoutError' }),
    );
    const result = await quotesAdapter(
      '/quotes?symbols=%24VVIX%2C%24VIX9D&fields=quote',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(504);
    expect(result.error.startsWith('[SCHWAB_API_NETWORK]')).toBe(true);
  });

  it('serves $NDX from the UW screener without touching the sidecar; $RUT (no UW price) is omitted', async () => {
    // NDX is NOT in the sidecar Theta allowlist — a sidecar call would
    // 400 every time, and quotesAdapter has no per-symbol retry. It
    // routes straight to the UW screener. UW has no RUT index price at
    // all (recon 2026-08-18), so $RUT is a per-symbol failure that is
    // omitted from an otherwise-ok mixed response.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path === screenerPath('NDX')) {
        return screenerRows('NDX', {
          close: '23985.5',
          prev_close: '23900.1',
          high: '24010.5',
          low: '23880',
        });
      }
      return [];
    });

    const result = await quotesAdapter(
      '/quotes?symbols=%24NDX%2C%24RUT&fields=quote',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<
      string,
      { quote: Record<string, number> }
    >;
    // fetch-spx-candles-1m reads data['$NDX'].quote.lastPrice every
    // minute — this path must keep working (it was permanently dead
    // on the 422ing stock-state route).
    expect(Object.keys(data)).toEqual(['$NDX']);
    expect(data['$NDX']!.quote).toMatchObject({
      lastPrice: 23985.5,
      // The screener carries no open — 0 like the sidecar's pre-open
      // degrade; lastPrice is the load-bearing field.
      openPrice: 0,
      highPrice: 24010.5,
      lowPrice: 23880,
      closePrice: 23900.1,
      netChange: 85.4,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      uwFetchMock.mock.calls.some(([, p]) => p.includes('/stock-state')),
    ).toBe(false);
    // RUT is known-unavailable — no UW call is spent on it.
    expect(uwFetchMock.mock.calls.some(([, p]) => p.includes('RUT'))).toBe(
      false,
    );
    // Screener close present → the bucket is never consulted.
    expect(
      uwFetchMock.mock.calls.some(([, p]) => p.includes('/spot-exposures')),
    ).toBe(false);
  });

  it('serves the $NDX quote from the spot-exposures bucket when the screener close is missing intraday (fetch-spx-candles-1m RTH ratio)', async () => {
    // The exact production failure of 2026-08-19: pre-open the NDX
    // screener row carried the prior close (so the 13:25–13:29Z cron
    // runs stored candles), then from the 13:30Z open every run logged
    // "UW screener: no price for index NDX" and NDX candles stopped
    // while SPX (sidecar-priced) ran to the bell. The quotes map must
    // keep a `$NDX` entry all session: lastPrice from the live bucket,
    // prev close / high / low from the screener row.
    const fetchSpy = mockSidecar({
      '/theta/index/price?root=SPX': {
        root: 'SPX',
        price: 7721.82,
        prev_close: 7691.76,
        ts: '2026-08-14T15:00:00Z',
      },
    });
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path === screenerPath('NDX')) {
        return screenerRows('NDX', NDX_RTH_SCREENER_ROW);
      }
      if (path === spotBucketPath('NDX')) return spotBucketRows('29425');
      if (path === '/stock/SPY/stock-state') {
        return [{ close: '770.19', prev_close: '767.45' }];
      }
      if (path === '/stock/QQQ/stock-state') {
        return [{ close: '718.61', prev_close: '716.9' }];
      }
      return [];
    });
    // The cron's exact request (fetchSchwabRatios).
    const result = await quotesAdapter(
      '/quotes?symbols=SPY%2C%24SPX%2CQQQ%2C%24NDX&fields=quote',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<
      string,
      { quote: Record<string, number> }
    >;
    expect(Object.keys(data).sort()).toEqual(['$NDX', '$SPX', 'QQQ', 'SPY']);
    expect(data['$NDX']!.quote).toEqual({
      lastPrice: 29425,
      openPrice: 0,
      highPrice: 29652.2949,
      lowPrice: 29288.7539,
      closePrice: 29490.957,
      netChange: -65.957,
      netPercentChange: -0.2237,
      tradeTime: 0,
    });
    // NDX never touches the sidecar (not on its allowlist); the bucket
    // is the second and last NDX call.
    expect(
      fetchSpy.mock.calls.some(([input]: unknown[]) =>
        String(input).includes('NDX'),
      ),
    ).toBe(false);
    expect(
      uwFetchMock.mock.calls
        .filter(([, p]) => p.includes('NDX'))
        .map(([, p]) => p),
    ).toEqual([screenerPath('NDX'), spotBucketPath('NDX')]);
  });

  it('omits $NDX (no throw, no extra calls) when the screener AND the bucket come back empty', async () => {
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path === screenerPath('NDX')) return [SPY_SCREENER_ROW];
      if (path === '/stock/QQQ/stock-state') {
        return [{ close: '718.61', prev_close: '716.9' }];
      }
      return [];
    });
    const result = await quotesAdapter(
      '/quotes?symbols=QQQ%2C%24NDX&fields=quote',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // fetch-spx-candles-1m reads data['$NDX']?.quote?.lastPrice and
    // turns the missing key into its "ratio unavailable" skip — the
    // per-symbol failure must stay an omission, never a whole-call 502.
    expect(Object.keys(result.data as object)).toEqual(['QQQ']);
    expect(
      uwFetchMock.mock.calls
        .filter(([, p]) => p.includes('NDX'))
        .map(([, p]) => p),
    ).toEqual([screenerPath('NDX'), spotBucketPath('NDX')]);
  });

  it('returns 501 SOURCE_UNAVAILABLE (not 502) when only no-source index symbols are requested', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await quotesAdapter('/quotes?symbols=%24RUT&fields=quote');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(501);
    expect(result.code).toBe('SOURCE_UNAVAILABLE');
    expect(result.error).toContain('/quotes');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(uwFetchMock).not.toHaveBeenCalled();
  });

  it('lets a transient failure win over a no-source symbol in an all-failed mixed request', async () => {
    // $RUT has no source (would be 501); $VVIX is sidecar-only and the
    // sidecar timed out (504). The transient must surface — 501 is
    // reserved for "every failure is a genuine no-source".
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('sidecar timed out'), { name: 'TimeoutError' }),
    );
    const result = await quotesAdapter(
      '/quotes?symbols=%24RUT%2C%24VVIX&fields=quote',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(504);
    expect(result.error.startsWith('[SCHWAB_API_NETWORK]')).toBe(true);
  });

  it('falls back to the UW screener when the sidecar quote fails for a UW-carried root', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('sidecar timed out'), { name: 'TimeoutError' }),
    );
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path === screenerPath('SPX')) {
        return screenerRows('SPX', {
          close: 6465.25,
          prev_close: 6450.25,
          high: 6470,
          low: 6440,
        });
      }
      return [];
    });
    const result = await quotesAdapter('/quotes?symbols=%24SPX&fields=quote');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<
      string,
      { quote: Record<string, number> }
    >;
    expect(data['$SPX']!.quote).toMatchObject({
      lastPrice: 6465.25,
      openPrice: 0,
      highPrice: 6470,
      lowPrice: 6440,
      closePrice: 6450.25,
      netChange: 15,
    });
    expect(
      uwFetchMock.mock.calls.some(([, p]) => p.includes('/stock-state')),
    ).toBe(false);
  });

  it('falls back to the UW screener for $VIX on a sidecar 503 (fetch-outcomes path)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonRes({ error: 'theta_unavailable' }, 503));
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path === screenerPath('VIX')) {
        return screenerRows('VIX', {
          close: '15.84',
          prev_close: '15.19',
          high: '16.09',
          low: '15.6',
        });
      }
      return [];
    });
    // $VIX1D is sidecar-only → omitted; $VIX survives via the screener.
    const result = await quotesAdapter(
      '/quotes?symbols=$VIX,$VIX1D&fields=quote',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<
      string,
      { quote: Record<string, number> }
    >;
    expect(Object.keys(data)).toEqual(['$VIX']);
    expect(data['$VIX']!.quote).toMatchObject({
      lastPrice: 15.84,
      closePrice: 15.19,
      netChange: 0.65,
    });
    // theta_unavailable is never retried: one price call per symbol.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries /theta/index/price once on a 503 theta_busy shed (sidecar-only root)', async () => {
    fakeRetryTimers();
    let priceCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/theta/index/price?root=VIX1D')) {
        priceCalls += 1;
        return priceCalls === 1
          ? thetaBusyRes('1')
          : jsonRes({
              root: 'VIX1D',
              price: 13.4,
              prev_close: 12.9,
              ts: '2026-08-14T15:00:00Z',
            });
      }
      // History (OHL derivation) — pre-open style 404, OHL stay 0.
      return jsonRes({ error: 'no_data' }, 404);
    });
    const pending = quotesAdapter('/quotes?symbols=%24VIX1D&fields=quote');
    await vi.advanceTimersByTimeAsync(999);
    expect(priceCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(priceCalls).toBe(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<
      string,
      { quote: Record<string, number> }
    >;
    expect(data['$VIX1D']!.quote).toMatchObject({
      lastPrice: 13.4,
      closePrice: 12.9,
      netChange: 0.5,
    });
  });

  it('keeps the quote alive (OHL=0) when the history derivation fails', async () => {
    // Price route works; history route 500s. lastPrice is the
    // load-bearing field — the quote must survive with zeroed OHL.
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/theta/index/price?root=SPX')) {
        return jsonRes({
          root: 'SPX',
          price: 6465.25,
          prev_close: 6450.25,
          ts: '2026-08-14T15:00:00Z',
        });
      }
      return jsonRes({ err: 'boom' }, 500);
    });
    const result = await quotesAdapter('/quotes?symbols=%24SPX&fields=quote');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<
      string,
      { quote: Record<string, number> }
    >;
    expect(data['$SPX']!.quote).toMatchObject({
      lastPrice: 6465.25,
      openPrice: 0,
      highPrice: 0,
      lowPrice: 0,
      closePrice: 6450.25,
    });
  });

  // ── /api/quotes shed budget ───────────────────────────────
  //
  // The UI aborts /api/quotes at FETCH_TIMEOUT_MS = 10s
  // (useMarketData.fetchers.ts) and the adapter runs 5–6 symbols via
  // Promise.allSettled, so the SLOWEST symbol's sidecar work bounds the
  // whole response. A theta_busy shed arrives after the sidecar's 5s
  // slot wait; the old unconditional retry (5s + 1s + ≤5s = 11s) blew
  // the UI budget by itself. New contract per symbol:
  //   - UW-carried roots (SPX/VIX): no retry, straight to the screener
  //     → shed 5.3s + UW ≈ 6s;
  //   - sidecar-only roots (VIX1D/VIX9D/VVIX): one retry, but every
  //     sidecar call is clipped to an 8.5s per-symbol budget → ≤ 8.5s;
  //   - the OHL derivation never retries and is skipped when the budget
  //     is spent (lastPrice is the load-bearing field).

  it('$SPX: a theta_busy shed on /theta/index/price is NOT retried — the quote falls straight to the screener with one sidecar call', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(thetaBusyRes('1'));
    uwFetchMock.mockImplementation(async (_key, path) => {
      if (path === screenerPath('SPX')) {
        return screenerRows('SPX', {
          close: '7713.45',
          prev_close: '7691.76',
          high: '7743.93',
          low: '7700.07',
        });
      }
      return [];
    });
    const result = await quotesAdapter('/quotes?symbols=%24SPX&fields=quote');
    // One price call — no retry, and no history call either (the
    // screener carries high/low).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<
      string,
      { quote: Record<string, number> }
    >;
    expect(data['$SPX']!.quote).toMatchObject({
      lastPrice: 7713.45,
      highPrice: 7743.93,
      lowPrice: 7700.07,
      closePrice: 7691.76,
      netChange: 21.69,
    });
  });

  it('sidecar-only root: the theta_busy retry is skipped when the first attempt already spent the quote budget — the original shed surfaces after ONE call', async () => {
    fakeRetryTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(async () => {
      // A slot wait that ran the full 8s client timeout's worth before
      // the sidecar shed it: 8s + 1s backoff would leave nothing of the
      // 8.5s per-symbol budget for a second attempt.
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      return thetaBusyRes('1');
    });
    const pending = quotesAdapter('/quotes?symbols=%24VIX1D&fields=quote');
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await pending;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(result.error).toContain('[SCHWAB_API_503]');
    expect(result.error).toContain('theta_busy');
  });

  it('sidecar-only root: the retry still runs when the budget has room after the backoff', async () => {
    fakeRetryTimers();
    let priceCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/theta/index/price?root=VVIX')) {
        priceCalls += 1;
        if (priceCalls === 1) {
          // Shed at 6s: 6s + 1s backoff = 7s, 1.5s of the 8.5s budget
          // left — above the floor, so the retry is attempted.
          await new Promise((resolve) => setTimeout(resolve, 6_000));
          return thetaBusyRes('1');
        }
        return jsonRes({
          root: 'VVIX',
          price: 98.7,
          prev_close: 97.2,
          ts: '2026-08-14T15:00:00Z',
        });
      }
      return jsonRes({ error: 'no_data' }, 404);
    });
    const pending = quotesAdapter('/quotes?symbols=%24VVIX&fields=quote');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(priceCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(priceCalls).toBe(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<
      string,
      { quote: Record<string, number> }
    >;
    expect(data['$VVIX']!.quote).toMatchObject({
      lastPrice: 98.7,
      closePrice: 97.2,
      netChange: 1.5,
    });
  });

  it('does not retry the OHL derivation on a shed — the quote keeps lastPrice with OHL 0s after exactly two sidecar calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/theta/index/price?root=VIX9D')) {
        return jsonRes({
          root: 'VIX9D',
          price: 16.1,
          prev_close: 15.8,
          ts: '2026-08-14T15:00:00Z',
        });
      }
      return thetaBusyRes('1');
    });
    const result = await quotesAdapter('/quotes?symbols=%24VIX9D&fields=quote');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<
      string,
      { quote: Record<string, number> }
    >;
    expect(data['$VIX9D']!.quote).toMatchObject({
      lastPrice: 16.1,
      openPrice: 0,
      highPrice: 0,
      lowPrice: 0,
      closePrice: 15.8,
    });
  });

  it('skips the OHL derivation entirely when the price call used up the quote budget (one sidecar call)', async () => {
    fakeRetryTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(async () => {
      // Price answered at 7.8s (a long slot wait that did NOT shed):
      // 0.7s of budget left is below the 1s floor — a history call
      // now would only be aborted client-side while still burning a
      // Terminal slot server-side.
      await new Promise((resolve) => setTimeout(resolve, 7_800));
      return jsonRes({
        root: 'VIX1D',
        price: 13.4,
        prev_close: 12.9,
        ts: '2026-08-14T15:00:00Z',
      });
    });
    const pending = quotesAdapter('/quotes?symbols=%24VIX1D&fields=quote');
    await vi.advanceTimersByTimeAsync(7_800);
    const result = await pending;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<
      string,
      { quote: Record<string, number> }
    >;
    expect(data['$VIX1D']!.quote).toMatchObject({
      lastPrice: 13.4,
      openPrice: 0,
      highPrice: 0,
      lowPrice: 0,
      closePrice: 12.9,
    });
  });
});

// ── moversAdapter ────────────────────────────────────────────

describe('moversAdapter', () => {
  const UP_ROWS = [
    {
      ticker: 'AAPL',
      full_name: 'Apple',
      close: '230',
      prev_close: '228',
      stock_volume: 2_000_000,
    },
    {
      ticker: 'NVDA',
      full_name: 'NVIDIA',
      close: '190',
      prev_close: '180',
      stock_volume: '1000000',
    },
  ];

  it('derives percent change and sorts descending for percent_change_up', async () => {
    uwFetchMock.mockResolvedValue(UP_ROWS);
    const result = await moversAdapter(
      '/movers/$SPX?sort=percent_change_up&frequency=0',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(uwFetchMock).toHaveBeenCalledWith(
      'test-key',
      '/screener/stocks?is_s_p_500=true&order=perc_change&order_direction=desc&limit=10',
    );
    const data = result.data as { screeners: Record<string, unknown>[] };
    expect(data.screeners).toEqual([
      {
        symbol: 'NVDA',
        description: 'NVIDIA',
        change: 5.56, // (190-180)/180 → 5.56%
        direction: 'up',
        last: 190,
        totalVolume: 1_000_000,
      },
      {
        symbol: 'AAPL',
        description: 'Apple',
        change: 0.88,
        direction: 'up',
        last: 230,
        totalVolume: 2_000_000,
      },
    ]);
  });

  it('sorts ascending (most negative first) for percent_change_down', async () => {
    uwFetchMock.mockResolvedValue([
      {
        ticker: 'INTC',
        full_name: 'Intel',
        close: '30',
        prev_close: '31',
        stock_volume: 10,
      },
      {
        ticker: 'BA',
        full_name: 'Boeing',
        close: '170',
        prev_close: '180',
        stock_volume: 20,
      },
    ]);
    const result = await moversAdapter(
      '/movers/$SPX?sort=percent_change_down&frequency=0',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(uwFetchMock).toHaveBeenCalledWith(
      'test-key',
      '/screener/stocks?is_s_p_500=true&order=perc_change&order_direction=asc&limit=10',
    );
    const data = result.data as {
      screeners: { symbol: string; change: number; direction: string }[];
    };
    expect(data.screeners.map((s) => s.symbol)).toEqual(['BA', 'INTC']);
    expect(data.screeners[0]!.change).toBeCloseTo(-5.56, 2);
    expect(data.screeners[0]!.direction).toBe('down');
  });

  it('maps UW HTTP failures through the Schwab error scheme', async () => {
    uwFetchMock.mockRejectedValue(new Error('UW API 500: upstream broke'));
    const result = await moversAdapter(
      '/movers/$SPX?sort=percent_change_up&frequency=0',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(result.error.startsWith('[SCHWAB_API_500]')).toBe(true);
  });

  it('returns a config error when UW_API_KEY is missing', async () => {
    delete process.env.UW_API_KEY;
    const result = await moversAdapter(
      '/movers/$SPX?sort=percent_change_up&frequency=0',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);
    expect(result.error.startsWith('[SCHWAB_TOKEN_ERROR]')).toBe(true);
  });
});
