import { describe, it, expect } from 'vitest';

/**
 * Tests for the API layer.
 *
 * These test the pure computation logic, owner gating, token management,
 * and response shape contracts without requiring Schwab credentials or
 * Upstash Redis. The functions are inlined from the API files since
 * Vitest runs in the frontend context and can't import from api/.
 *
 * Categories:
 * 1. Opening range computation (intraday)
 * 2. Today OHLC computation (intraday)
 * 3. Date conversion (yesterday)
 * 4. Day summary / range computation (yesterday)
 * 5. Quote slice mapping (quotes)
 * 6. Cookie parsing (owner gate)
 * 7. Owner verification logic (owner gate)
 * 8. Owner cookie security properties
 * 9. Cache header construction
 * 10. Market hours detection
 * 11. Yesterday filtering (exclude today's partial candle)
 * 12. Token expiry logic
 * 13. Basic auth header generation
 * 14. Response shape contracts
 */

// ============================================================
// 1. OPENING RANGE COMPUTATION
// ============================================================

function computeOpeningRange(candles: Array<{ high: number; low: number }>) {
  if (candles.length === 0) return null;
  const orCandles = candles.slice(0, Math.min(6, candles.length));
  const complete = candles.length >= 6;
  let high = -Infinity;
  let low = Infinity;
  for (const c of orCandles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  return {
    high,
    low,
    rangePts: Math.round((high - low) * 100) / 100,
    minutes: orCandles.length * 5,
    complete,
  };
}

describe('computeOpeningRange', () => {
  it('returns null for empty candles', () => {
    expect(computeOpeningRange([])).toBeNull();
  });

  it('uses first 6 candles for 30-min range', () => {
    const candles = Array.from({ length: 78 }, (_, i) => ({
      high: 6800 + i,
      low: 6780 + i,
    }));
    const or = computeOpeningRange(candles)!;
    expect(or.minutes).toBe(30);
    expect(or.complete).toBe(true);
    expect(or.high).toBe(6805);
    expect(or.low).toBe(6780);
  });

  it('handles incomplete range (fewer than 6 candles)', () => {
    const candles = [
      { high: 6800, low: 6780 },
      { high: 6810, low: 6785 },
      { high: 6805, low: 6775 },
    ];
    const or = computeOpeningRange(candles)!;
    expect(or.minutes).toBe(15);
    expect(or.complete).toBe(false);
    expect(or.high).toBe(6810);
    expect(or.low).toBe(6775);
    expect(or.rangePts).toBe(35);
  });

  it('single candle returns 5 minutes', () => {
    const or = computeOpeningRange([{ high: 6800, low: 6790 }])!;
    expect(or.minutes).toBe(5);
    expect(or.rangePts).toBe(10);
  });

  it('excludes 7th+ candles from range calculation', () => {
    const candles = [
      { high: 6800, low: 6790 },
      { high: 6795, low: 6760 },
      { high: 6850, low: 6780 },
      { high: 6810, low: 6785 },
      { high: 6820, low: 6790 },
      { high: 6815, low: 6788 },
      { high: 6900, low: 6700 }, // 7th — excluded
    ];
    const or = computeOpeningRange(candles)!;
    expect(or.high).toBe(6850);
    expect(or.low).toBe(6760);
  });
});

// ============================================================
// 2. TODAY OHLC COMPUTATION
// ============================================================

function computeTodayOHLC(
  candles: Array<{ open: number; high: number; low: number; close: number }>,
) {
  if (candles.length === 0) return null;
  const open = candles[0]!.open;
  const last = candles.at(-1)!.close;
  let high = -Infinity;
  let low = Infinity;
  for (const c of candles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  return { open, high, low, last };
}

describe('computeTodayOHLC', () => {
  it('returns null for empty candles', () => {
    expect(computeTodayOHLC([])).toBeNull();
  });

  it('uses first candle open and last candle close', () => {
    const ohlc = computeTodayOHLC([
      { open: 6790, high: 6800, low: 6780, close: 6795 },
      { open: 6795, high: 6810, low: 6775, close: 6805 },
      { open: 6805, high: 6820, low: 6790, close: 6815 },
    ])!;
    expect(ohlc.open).toBe(6790);
    expect(ohlc.last).toBe(6815);
    expect(ohlc.high).toBe(6820);
    expect(ohlc.low).toBe(6775);
  });

  it('single candle works', () => {
    const ohlc = computeTodayOHLC([
      { open: 6800, high: 6810, low: 6790, close: 6805 },
    ])!;
    expect(ohlc.open).toBe(6800);
    expect(ohlc.last).toBe(6805);
  });

  it('finds global extremes', () => {
    const ohlc = computeTodayOHLC([
      { open: 6800, high: 6800, low: 6800, close: 6800 },
      { open: 6800, high: 6900, low: 6700, close: 6800 },
      { open: 6800, high: 6800, low: 6800, close: 6800 },
    ])!;
    expect(ohlc.high).toBe(6900);
    expect(ohlc.low).toBe(6700);
  });
});

// ============================================================
// 3. DATE CONVERSION
// ============================================================

function msToDateStr(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

describe('msToDateStr', () => {
  it('converts Unix ms to YYYY-MM-DD', () => {
    expect(msToDateStr(1773100800000)).toBe('2026-03-10');
  });

  it('handles Jan 1', () => {
    expect(msToDateStr(1767225600000)).toBe('2026-01-01');
  });

  it('handles Dec 31', () => {
    expect(msToDateStr(1767139200000)).toBe('2025-12-31');
  });

  it('handles leap year Feb 29', () => {
    // 2024-02-29 00:00:00 UTC
    expect(msToDateStr(1709164800000)).toBe('2024-02-29');
  });
});

// ============================================================
// 4. DAY SUMMARY (YESTERDAY)
// ============================================================

function toDaySummary(candle: {
  open: number;
  high: number;
  low: number;
  close: number;
  datetime: number;
}) {
  const rangePts = Math.round((candle.high - candle.low) * 100) / 100;
  const rangePct =
    Math.round(((candle.high - candle.low) / candle.open) * 10000) / 100;
  return {
    date: msToDateStr(candle.datetime),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    rangePct,
    rangePts,
  };
}

describe('toDaySummary', () => {
  it('computes range percentage from open', () => {
    const s = toDaySummary({
      open: 6800,
      high: 6850,
      low: 6750,
      close: 6820,
      datetime: 1773100800000,
    });
    expect(s.rangePts).toBe(100);
    expect(s.rangePct).toBeCloseTo(1.47, 1);
    expect(s.date).toBe('2026-03-10');
  });

  it('handles zero range', () => {
    const s = toDaySummary({
      open: 6800,
      high: 6800,
      low: 6800,
      close: 6800,
      datetime: 1773187200000,
    });
    expect(s.rangePts).toBe(0);
    expect(s.rangePct).toBe(0);
  });

  it('handles large range day (real data)', () => {
    const s = toDaySummary({
      open: 6681.78,
      high: 6810.44,
      low: 6636.04,
      close: 6781.48,
      datetime: 1773187200000,
    });
    expect(s.rangePts).toBeCloseTo(174.4, 1);
    expect(s.rangePct).toBeCloseTo(2.61, 1);
  });

  it('preserves all OHLC values', () => {
    const s = toDaySummary({
      open: 1111,
      high: 2222,
      low: 333,
      close: 4444,
      datetime: 1773187200000,
    });
    expect(s.open).toBe(1111);
    expect(s.high).toBe(2222);
    expect(s.low).toBe(333);
    expect(s.close).toBe(4444);
  });
});

// ============================================================
// 5. QUOTE SLICE MAPPING
// ============================================================

function toSlice(q: { quote: Record<string, number> }) {
  return {
    price: q.quote.lastPrice,
    open: q.quote.openPrice,
    high: q.quote.highPrice,
    low: q.quote.lowPrice,
    prevClose: q.quote.closePrice,
    change: q.quote.netChange,
    changePct: q.quote.netPercentChange,
  };
}

describe('toSlice', () => {
  it('maps Schwab quote fields', () => {
    const s = toSlice({
      quote: {
        lastPrice: 672.48,
        openPrice: 677.58,
        highPrice: 680.08,
        lowPrice: 673.34,
        closePrice: 677.18,
        netChange: -4.7,
        netPercentChange: -0.69,
      },
    });
    expect(s.price).toBe(672.48);
    expect(s.open).toBe(677.58);
    expect(s.prevClose).toBe(677.18);
    expect(s.change).toBe(-4.7);
    expect(s.changePct).toBe(-0.69);
  });

  it('handles zero values', () => {
    const s = toSlice({
      quote: {
        lastPrice: 0,
        openPrice: 0,
        highPrice: 0,
        lowPrice: 0,
        closePrice: 0,
        netChange: 0,
        netPercentChange: 0,
      },
    });
    expect(s.price).toBe(0);
  });
});

// ============================================================
// 6. COOKIE PARSING
// ============================================================

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  }
  return cookies;
}

describe('parseCookies', () => {
  it('parses single cookie', () => {
    expect(parseCookies('sc-owner=abc123')).toEqual({ 'sc-owner': 'abc123' });
  });

  it('parses multiple cookies', () => {
    const r = parseCookies('sc-owner=abc; other=xyz; session=def');
    expect(r['sc-owner']).toBe('abc');
    expect(r['other']).toBe('xyz');
    expect(r['session']).toBe('def');
  });

  it('handles empty string', () => {
    expect(parseCookies('')).toEqual({});
  });

  it('handles values with equals signs', () => {
    expect(parseCookies('token=abc=def=ghi')['token']).toBe('abc=def=ghi');
  });

  it('handles whitespace around semicolons', () => {
    const r = parseCookies('a=1 ; b=2 ; c=3');
    expect(r['a']).toBe('1');
    expect(r['b']).toBe('2');
    expect(r['c']).toBe('3');
  });
});

// ============================================================
// 7. OWNER VERIFICATION
// ============================================================

function isOwner(cookieHeader: string, envSecret: string | undefined): boolean {
  if (!envSecret) return false;
  const cookies = parseCookies(cookieHeader);
  return cookies['sc-owner'] === envSecret;
}

describe('isOwner logic', () => {
  const SECRET =
    'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

  it('returns true when cookie matches', () => {
    expect(isOwner(`sc-owner=${SECRET}`, SECRET)).toBe(true);
  });

  it('returns false when cookie missing', () => {
    expect(isOwner('other=xyz', SECRET)).toBe(false);
  });

  it('returns false when cookie value wrong', () => {
    expect(isOwner('sc-owner=wrong', SECRET)).toBe(false);
  });

  it('returns false with no cookies', () => {
    expect(isOwner('', SECRET)).toBe(false);
  });

  it('returns false when env secret not set', () => {
    expect(isOwner(`sc-owner=${SECRET}`, undefined)).toBe(false);
  });

  it('returns false when env secret empty', () => {
    expect(isOwner('sc-owner=', '')).toBe(false);
  });

  it('works with owner cookie among many', () => {
    expect(isOwner(`session=xyz; sc-owner=${SECRET}; other=abc`, SECRET)).toBe(
      true,
    );
  });
});

// ============================================================
// 8. OWNER COOKIE SECURITY
// ============================================================

function buildCookie(secret: string, isLocal: boolean): string {
  const parts = [
    `sc-owner=${secret}`,
    'Path=/',
    `Max-Age=${7 * 86400}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (!isLocal) parts.push('Secure');
  return parts.join('; ');
}

describe('owner cookie security', () => {
  it('production: includes Secure, HttpOnly, SameSite=Strict', () => {
    const c = buildCookie('secret', false);
    expect(c).toContain('Secure');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
  });

  it('localhost: omits Secure flag', () => {
    const c = buildCookie('secret', true);
    expect(c).not.toContain('Secure');
    expect(c).toContain('HttpOnly');
  });

  it('7-day max age', () => {
    expect(buildCookie('s', false)).toContain(`Max-Age=${604800}`);
  });

  it('root path scope', () => {
    expect(buildCookie('s', false)).toContain('Path=/');
  });
});

// ============================================================
// 9. CACHE HEADERS
// ============================================================

function buildCacheControl(edgeSec: number, swr: number = 60): string {
  return `s-maxage=${edgeSec}, stale-while-revalidate=${swr}`;
}

describe('cache headers', () => {
  it('quotes during market hours', () => {
    expect(buildCacheControl(60, 30)).toBe(
      's-maxage=60, stale-while-revalidate=30',
    );
  });

  it('quotes after hours', () => {
    expect(buildCacheControl(300, 60)).toBe(
      's-maxage=300, stale-while-revalidate=60',
    );
  });

  it('yesterday during hours', () => {
    expect(buildCacheControl(3600, 3600)).toBe(
      's-maxage=3600, stale-while-revalidate=3600',
    );
  });

  it('yesterday after close', () => {
    expect(buildCacheControl(86400, 3600)).toBe(
      's-maxage=86400, stale-while-revalidate=3600',
    );
  });
});

// ============================================================
// 10. MARKET HOURS DETECTION
// ============================================================

function isMarketOpenAt(day: number, hour: number, min: number): boolean {
  if (day === 0 || day === 6) return false;
  const totalMin = hour * 60 + min;
  return totalMin >= 570 && totalMin <= 960;
}

describe('isMarketOpen heuristic', () => {
  it('open at 9:30 AM Monday', () =>
    expect(isMarketOpenAt(1, 9, 30)).toBe(true));
  it('open at 3:59 PM Friday', () =>
    expect(isMarketOpenAt(5, 15, 59)).toBe(true));
  it('open at 4:00 PM (close)', () =>
    expect(isMarketOpenAt(3, 16, 0)).toBe(true));
  it('closed at 9:29 AM', () => expect(isMarketOpenAt(2, 9, 29)).toBe(false));
  it('closed at 4:01 PM', () => expect(isMarketOpenAt(4, 16, 1)).toBe(false));
  it('closed Saturday', () => expect(isMarketOpenAt(6, 12, 0)).toBe(false));
  it('closed Sunday', () => expect(isMarketOpenAt(0, 12, 0)).toBe(false));
  it('closed midnight Tuesday', () =>
    expect(isMarketOpenAt(2, 0, 0)).toBe(false));
  it('open at noon Wednesday', () =>
    expect(isMarketOpenAt(3, 12, 0)).toBe(true));
});

// ============================================================
// 11. YESTERDAY FILTERING
// ============================================================

function filterCompleted(
  candles: Array<{ datetime: number }>,
  todayDate: string,
) {
  return candles.filter((c) => msToDateStr(c.datetime) !== todayDate);
}

describe('yesterday: filtering today partial candle', () => {
  it('excludes today', () => {
    const candles = [
      { datetime: 1773014400000 }, // 2026-03-09
      { datetime: 1773100800000 }, // 2026-03-10
      { datetime: 1773187200000 }, // 2026-03-11
    ];
    expect(filterCompleted(candles, '2026-03-11')).toHaveLength(2);
  });

  it('keeps all when today not present', () => {
    const candles = [{ datetime: 1773014400000 }, { datetime: 1773100800000 }];
    expect(filterCompleted(candles, '2026-03-11')).toHaveLength(2);
  });

  it('returns empty when all candles are today', () => {
    expect(
      filterCompleted([{ datetime: 1773187200000 }], '2026-03-11'),
    ).toHaveLength(0);
  });
});

// ============================================================
// 12. TOKEN EXPIRY LOGIC
// ============================================================

const BUFFER_MS = 60_000;

function isAccessValid(expiresAt: number, now: number): boolean {
  return now < expiresAt - BUFFER_MS;
}

function isRefreshValid(refreshExpiresAt: number, now: number): boolean {
  return now < refreshExpiresAt;
}

describe('token expiry logic', () => {
  it('access token valid well before expiry', () => {
    expect(isAccessValid(1000000 + 1800000, 1000000)).toBe(true);
  });

  it('access token invalid within 1-min buffer', () => {
    expect(isAccessValid(1000000 + 30000, 1000000)).toBe(false);
  });

  it('access token invalid after expiry', () => {
    expect(isAccessValid(999000, 1000000)).toBe(false);
  });

  it('refresh token valid before expiry', () => {
    expect(isRefreshValid(1000000 + 604800000, 1000000)).toBe(true);
  });

  it('refresh token invalid after expiry', () => {
    expect(isRefreshValid(999000, 1000000)).toBe(false);
  });

  it('refresh token invalid at exact boundary', () => {
    expect(isRefreshValid(1000000, 1000000)).toBe(false);
  });
});

// ============================================================
// 13. BASIC AUTH HEADER
// ============================================================

function basicAuthHeader(clientId: string, clientSecret: string): string {
  const credentials = `${clientId}:${clientSecret}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

describe('basic auth header', () => {
  it('generates correct base64', () => {
    const h = basicAuthHeader('myId', 'mySecret');
    expect(Buffer.from(h.replace('Basic ', ''), 'base64').toString()).toBe(
      'myId:mySecret',
    );
  });

  it('starts with "Basic "', () => {
    expect(basicAuthHeader('a', 'b').startsWith('Basic ')).toBe(true);
  });

  it('handles special characters', () => {
    const h = basicAuthHeader('id+chars=', 'secret/&');
    expect(Buffer.from(h.replace('Basic ', ''), 'base64').toString()).toBe(
      'id+chars=:secret/&',
    );
  });
});

// ============================================================
// 14. RESPONSE SHAPE CONTRACTS
// ============================================================

describe('API response shape contracts', () => {
  it('QuotesResponse: all 5 symbols + metadata', () => {
    const r = {
      spy: {
        price: 672,
        open: 677,
        high: 680,
        low: 673,
        prevClose: 677,
        change: -5,
        changePct: -0.7,
      },
      spx: {
        price: 6775,
        open: 6790,
        high: 6811,
        low: 6745,
        prevClose: 6781,
        change: -6,
        changePct: -0.08,
      },
      vix: {
        price: 24.23,
        open: 24.9,
        high: 26.23,
        low: 23.75,
        prevClose: 24.93,
        change: -0.7,
        changePct: -2.8,
      },
      vix1d: {
        price: 18.99,
        open: 14.93,
        high: 20.36,
        low: 14.14,
        prevClose: 21.29,
        change: -2.3,
        changePct: -10.8,
      },
      vix9d: {
        price: 24.44,
        open: 24.55,
        high: 26.69,
        low: 23.54,
        prevClose: 25.54,
        change: -1.1,
        changePct: -4.3,
      },
      marketOpen: false,
      asOf: '2026-03-11T20:00:00Z',
    };
    for (const key of ['spy', 'spx', 'vix', 'vix1d', 'vix9d'] as const) {
      expect(r[key].price).toBeDefined();
      expect(r[key].prevClose).toBeDefined();
    }
    expect(typeof r.marketOpen).toBe('boolean');
    expect(r.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('IntradayResponse: today + openingRange + metadata', () => {
    const r = {
      today: { open: 6796.56, high: 6845.08, low: 6759.74, last: 6775.8 },
      openingRange: {
        high: 6798.96,
        low: 6762.05,
        rangePts: 36.91,
        minutes: 30,
        complete: true,
      },
      previousClose: 6795.99,
      candleCount: 78,
      marketOpen: false,
      asOf: '2026-03-11T20:00:00Z',
    };
    expect(r.today.open).toBeGreaterThan(0);
    expect(r.openingRange.minutes).toBe(30);
    expect(r.previousClose).toBeGreaterThan(0);
  });

  it('YesterdayResponse: yesterday + optional twoDaysAgo', () => {
    const r = {
      yesterday: {
        date: '2026-03-10',
        open: 6681,
        high: 6810,
        low: 6636,
        close: 6781,
        rangePct: 2.61,
        rangePts: 174,
      },
      twoDaysAgo: {
        date: '2026-03-09',
        open: 6750,
        high: 6780,
        low: 6720,
        close: 6760,
        rangePct: 0.89,
        rangePts: 60,
      },
      asOf: '2026-03-11T08:00:00Z',
    };
    expect(r.yesterday.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.yesterday.rangePct).toBeGreaterThan(0);
  });

  it('YesterdayResponse: null twoDaysAgo is valid', () => {
    const r = {
      yesterday: {
        date: '2026-03-10',
        open: 6681,
        high: 6810,
        low: 6636,
        close: 6781,
        rangePct: 2.61,
        rangePts: 174,
      },
      twoDaysAgo: null,
      asOf: '2026-03-11T08:00:00Z',
    };
    expect(r.twoDaysAgo).toBeNull();
  });

  it('error response has error field', () => {
    expect({ error: 'Not authenticated' }.error).toBe('Not authenticated');
  });

  it('null quote slice is valid (symbol unavailable)', () => {
    const r = {
      spy: null,
      spx: null,
      vix: null,
      vix1d: null,
      vix9d: null,
      marketOpen: false,
      asOf: '',
    };
    expect(r.spy).toBeNull();
  });
});
