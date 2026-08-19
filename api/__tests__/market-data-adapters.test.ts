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
  mapWithConcurrency: async <T, R>(
    items: readonly T[],
    _limit: number,
    worker: (item: T, idx: number) => Promise<R>,
  ) => Promise.all(items.map((it, i) => worker(it, i))),
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

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes({ error: 'theta_unavailable' }, 503),
    );
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
    mockSidecar({}); // everything 404s
    const result = await historyAdapter(
      `/pricehistory?symbol=%24SPX&periodType=day&period=1&frequencyType=minute&frequency=5`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { empty: boolean; candles: unknown[] };
    expect(data.empty).toBe(true);
    expect(data.candles).toEqual([]);
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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes({ error: 'theta_unavailable' }, 503),
    );
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
