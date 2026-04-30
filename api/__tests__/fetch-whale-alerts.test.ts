// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockUwFetch, mockCronGuard } = vi.hoisted(() => ({
  mockUwFetch: vi.fn(),
  mockCronGuard: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  cronGuard: mockCronGuard,
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

import handler, {
  WHALE_TICKERS,
  type UwFlowAlert,
} from '../cron/fetch-whale-alerts.js';

const TICKER_COUNT = WHALE_TICKERS.length;

// ── Fixtures ─────────────────────────────────────────────────

const SAMPLE_ALERT: UwFlowAlert = {
  alert_rule: 'RepeatedHitsAscendingFill',
  all_opening_trades: false,
  created_at: '2026-04-14T19:45:00.000000Z', // 14:45 CT (CDT, UTC-5)
  expiry: '2026-04-15',
  expiry_count: 1,
  has_floor: false,
  has_multileg: false,
  has_singleleg: true,
  has_sweep: true,
  issue_type: 'Index',
  open_interest: 1000,
  option_chain: 'SPXW260415C06900000',
  price: '4.05',
  strike: '6900',
  ticker: 'SPXW',
  total_ask_side_prem: '1518750',
  total_bid_side_prem: '4050',
  total_premium: '1522800',
  total_size: 461,
  trade_count: 32,
  type: 'call',
  underlying_price: '6850',
  volume: 2442,
  volume_oi_ratio: '0.308',
};

const makeAlert = (overrides: Partial<UwFlowAlert> = {}): UwFlowAlert => ({
  ...SAMPLE_ALERT,
  ...overrides,
});

const GUARD = { apiKey: 'test-uw-key', today: '2026-04-14' };

/**
 * Fill the uwFetch mock with N empty responses + one specific non-empty
 * response for a given ticker. Other tickers return [].
 */
function mockUwFetchByTicker(byTicker: Record<string, UwFlowAlert[]>) {
  // The handler calls uwFetch in WHALE_TICKERS order. For each call we
  // pop the matching ticker's response (default []).
  for (const { ticker } of WHALE_TICKERS) {
    mockUwFetch.mockResolvedValueOnce(byTicker[ticker] ?? []);
  }
}

function callValuesFor(needle: string): unknown[] | null {
  for (let i = mockSql.mock.calls.length - 1; i >= 0; i--) {
    const call = mockSql.mock.calls[i]!;
    const strings = call[0] as unknown;
    if (
      Array.isArray(strings) &&
      strings.some((s) => String(s).includes(needle))
    ) {
      return call.slice(1);
    }
  }
  return null;
}

describe('fetch-whale-alerts handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCronGuard.mockReturnValue(GUARD);
    // Default: cursor SELECT returns no rows (first run).
    mockSql.mockResolvedValue([]);
  });

  // ── Multi-ticker behavior ──────────────────────────────────

  it('queries all 7 whale tickers per run', async () => {
    mockSql.mockResolvedValueOnce([]); // cursor SELECT
    mockUwFetchByTicker({});

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockUwFetch).toHaveBeenCalledTimes(TICKER_COUNT);
    const tickersHit = mockUwFetch.mock.calls.map((c) => {
      const path = c[1] as string;
      const m = path.match(/ticker_symbol=([A-Z]+)/);
      return m ? m[1] : null;
    });
    expect(new Set(tickersHit)).toEqual(
      new Set(WHALE_TICKERS.map((t) => t.ticker)),
    );
  });

  it('uses correct issue_type per ticker (Index vs ETF)', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockUwFetchByTicker({});

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    const pathByTicker = new Map<string, string>();
    for (const call of mockUwFetch.mock.calls) {
      const path = call[1] as string;
      const m = path.match(/ticker_symbol=([A-Z]+)/);
      if (m) pathByTicker.set(m[1]!, path);
    }
    expect(pathByTicker.get('SPXW')).toContain(encodeURIComponent('Index'));
    expect(pathByTicker.get('NDX')).toContain(encodeURIComponent('Index'));
    expect(pathByTicker.get('NDXP')).toContain(encodeURIComponent('Index'));
    expect(pathByTicker.get('SPX')).toContain(encodeURIComponent('Index'));
    expect(pathByTicker.get('QQQ')).toContain(encodeURIComponent('ETF'));
    expect(pathByTicker.get('SPY')).toContain(encodeURIComponent('ETF'));
    expect(pathByTicker.get('IWM')).toContain(encodeURIComponent('ETF'));
  });

  // ── Happy path ─────────────────────────────────────────────

  it('inserts alerts from one ticker and returns 200', async () => {
    const alerts = [
      makeAlert({
        option_chain: 'SPXW260415C06900000',
        ticker: 'SPXW',
        created_at: '2026-04-14T19:45:00.000000Z',
      }),
      makeAlert({
        option_chain: 'SPY260420P00700000',
        ticker: 'SPY',
        issue_type: 'ETF',
        underlying_price: '705',
        strike: '700',
        type: 'put',
        created_at: '2026-04-14T19:46:00.000000Z',
      }),
      makeAlert({
        option_chain: 'QQQ260420C00660000',
        ticker: 'QQQ',
        issue_type: 'ETF',
        underlying_price: '658',
        strike: '660',
        created_at: '2026-04-14T19:47:00.000000Z',
      }),
    ];
    mockSql.mockResolvedValueOnce([]); // cursor SELECT empty
    mockUwFetchByTicker({
      SPXW: [alerts[0]!],
      SPY: [alerts[1]!],
      QQQ: [alerts[2]!],
    });
    mockSql
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 2 }])
      .mockResolvedValueOnce([{ id: 3 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-whale-alerts',
      fetched: 3,
      inserted: 3,
    });
  });

  // ── Empty UW response ──────────────────────────────────────

  it('returns 200 with inserted:0 when no ticker has new alerts', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockUwFetchByTicker({});

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-whale-alerts',
      fetched: 0,
      inserted: 0,
    });
    // Only the cursor SELECT — no INSERTs because nothing was fetched.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  // ── Steady-state: per-ticker newer_than ────────────────────

  it('passes per-ticker newer_than to UW when DB has prior rows for that ticker', async () => {
    const spxwLastSeen = '2026-04-14T19:40:00.000Z';
    const spyLastSeen = '2026-04-14T19:30:00.000Z';
    mockSql.mockResolvedValueOnce([
      { ticker: 'SPXW', max_created_at: spxwLastSeen },
      { ticker: 'SPY', max_created_at: spyLastSeen },
    ]);
    mockUwFetchByTicker({});

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockUwFetch).toHaveBeenCalledTimes(TICKER_COUNT);
    const pathByTicker = new Map<string, string>();
    for (const call of mockUwFetch.mock.calls) {
      const path = call[1] as string;
      const m = path.match(/ticker_symbol=([A-Z]+)/);
      if (m) pathByTicker.set(m[1]!, path);
    }
    expect(pathByTicker.get('SPXW')).toContain(
      encodeURIComponent(spxwLastSeen),
    );
    expect(pathByTicker.get('SPY')).toContain(encodeURIComponent(spyLastSeen));
    // Tickers without a cursor row should NOT pass newer_than.
    expect(pathByTicker.get('NDX')).not.toContain('newer_than=');
    expect(pathByTicker.get('IWM')).not.toContain('newer_than=');
  });

  // ── First-run: newer_than omitted everywhere ───────────────

  it('omits newer_than on first run and sets whale filter params on every ticker', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockUwFetchByTicker({});

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockUwFetch).toHaveBeenCalledTimes(TICKER_COUNT);
    for (const call of mockUwFetch.mock.calls) {
      const path = call[1] as string;
      expect(path).not.toContain('newer_than=');
      expect(path).not.toContain('older_than=');
      expect(path).toContain('min_dte=0');
      expect(path).toContain('max_dte=14');
      expect(path).toContain('min_premium=500000');
      expect(path).toContain('limit=200');
      expect(path).not.toContain('rule_name');
    }
  });

  // ── Pagination on a single ticker ──────────────────────────

  it('paginates with older_than within a single ticker when first page returns 200 rows', async () => {
    const firstPage = Array.from({ length: 200 }, (_, i) => {
      const secondsFromBase = 60 * i;
      const baseMs = Date.parse('2026-04-14T19:45:00.000Z');
      const iso = new Date(baseMs - secondsFromBase * 1000).toISOString();
      return makeAlert({
        option_chain: `SPXW260415C0690${String(i).padStart(4, '0')}`,
        created_at: iso,
      });
    });
    const oldestCreatedAt = firstPage.at(-1)!.created_at;

    const secondPage = [
      makeAlert({
        option_chain: 'SPXW260415C06999999',
        created_at: '2026-04-14T16:00:00.000Z',
      }),
    ];

    mockSql.mockResolvedValueOnce([]); // cursor SELECT
    // SPXW is first in WHALE_TICKERS — 2-page response.
    mockUwFetch
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
    // Remaining 6 tickers each return [].
    for (let i = 0; i < TICKER_COUNT - 1; i++) {
      mockUwFetch.mockResolvedValueOnce([]);
    }
    for (let i = 0; i < 201; i++) {
      mockSql.mockResolvedValueOnce([{ id: i + 1 }]);
    }

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockUwFetch).toHaveBeenCalledTimes(TICKER_COUNT + 1); // 2 SPXW pages + 6 other tickers
    const secondCallPath = mockUwFetch.mock.calls[1]![1] as string;
    expect(secondCallPath).toContain('older_than=');
    const expectedOlderThan = new Date(
      new Date(oldestCreatedAt).getTime() - 1,
    ).toISOString();
    expect(secondCallPath).toContain(encodeURIComponent(expectedOlderThan));
    expect(secondCallPath).not.toContain(encodeURIComponent(oldestCreatedAt));
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ fetched: 201, inserted: 201 });
  });

  // ── Derived field spot-check via INSERT values ─────────────

  it('computes derived fields correctly and passes them to INSERT', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockUwFetchByTicker({ SPXW: [SAMPLE_ALERT] });
    mockSql.mockResolvedValueOnce([{ id: 1 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);

    const values = callValuesFor('INSERT INTO whale_alerts');
    expect(values).not.toBeNull();
    const vals = values!;

    const totalPrem = 1522800;
    const expectedAskRatio = 1518750 / totalPrem;
    const expectedBidRatio = 4050 / totalPrem;
    const expectedNetPrem = 1518750 - 4050;

    const approxEqual = (v: unknown, expected: number, eps = 1e-9) =>
      typeof v === 'number' && Math.abs(v - expected) < eps;

    expect(vals.some((v) => approxEqual(v, expectedAskRatio))).toBe(true);
    expect(vals.some((v) => approxEqual(v, expectedBidRatio))).toBe(true);
    expect(vals).toContain(expectedNetPrem);

    // dte_at_alert = 1, distance_from_spot = 50
    expect(vals).toContain(1);
    expect(vals).toContain(50);
    expect(vals.some((v) => approxEqual(v, 50 / 6850))).toBe(true);
    expect(vals.some((v) => approxEqual(v, 6850 / 6900))).toBe(true);
    expect(vals).toContain(false); // is_itm (call, strike 6900 > spot 6850)
    expect(vals).toContain(885); // minute_of_day (14:45 CT)
    expect(vals).toContain(375); // session_elapsed_min
  });

  // ── age_minutes_at_ingest ─────────────────────────────────

  describe('age_minutes_at_ingest', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('computes age_minutes_at_ingest as floor((now - created_at) / 60_000)', async () => {
      const alertCreatedMs = Date.parse('2026-04-14T19:45:00.000Z');
      const fakeNowMs = alertCreatedMs + 7 * 60_000 + 30_000;
      vi.useFakeTimers();
      vi.setSystemTime(new Date(fakeNowMs));

      mockSql.mockResolvedValueOnce([]);
      mockUwFetchByTicker({ SPXW: [SAMPLE_ALERT] });
      mockSql.mockResolvedValueOnce([{ id: 1 }]);

      const req = mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      });
      const res = mockResponse();
      await handler(req, res);

      expect(res._status).toBe(200);
      const values = callValuesFor('INSERT INTO whale_alerts');
      expect(values).not.toBeNull();
      expect(values!).toContain(7);
    });
  });

  // ── Dedupe: ON CONFLICT DO NOTHING returns empty rows ──────

  it('does not increment inserted when ON CONFLICT returns no row', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockUwFetchByTicker({
      SPXW: [
        makeAlert({ option_chain: 'SPXW260415C06900000' }),
        makeAlert({ option_chain: 'SPXW260415C06910000' }),
      ],
    });
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 2 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ fetched: 2, inserted: 1 });
  });

  // ── cronGuard rejection ────────────────────────────────────

  it('bails without calling uwFetch or getDb when cronGuard returns null', async () => {
    mockCronGuard.mockReturnValueOnce(null);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrong' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockCronGuard).toHaveBeenCalledOnce();
    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── URL assertions ─────────────────────────────────────────

  it('never includes rule_name in any UW path and always sets min_premium + max_dte=14', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockUwFetchByTicker({});

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockUwFetch).toHaveBeenCalledTimes(TICKER_COUNT);
    for (const call of mockUwFetch.mock.calls) {
      const path = call[1] as string;
      expect(path).not.toContain('rule_name');
      expect(path).toContain('min_premium=500000');
      expect(path).toContain('max_dte=14');
    }
  });

  // ── Per-ticker fetched count ───────────────────────────────

  it('returns fetchedByTicker breakdown in response body', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockUwFetchByTicker({
      SPXW: [makeAlert({ option_chain: 'SPXW260415C06900000' })],
      SPY: [
        makeAlert({
          option_chain: 'SPY260420C00710000',
          ticker: 'SPY',
          issue_type: 'ETF',
          strike: '710',
          underlying_price: '705',
        }),
        makeAlert({
          option_chain: 'SPY260420P00700000',
          ticker: 'SPY',
          issue_type: 'ETF',
          strike: '700',
          underlying_price: '705',
          type: 'put',
        }),
      ],
    });
    mockSql
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 2 }])
      .mockResolvedValueOnce([{ id: 3 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      fetched: 3,
      inserted: 3,
      fetchedByTicker: {
        SPXW: 1,
        SPY: 2,
        QQQ: 0,
        NDXP: 0,
        IWM: 0,
        SPX: 0,
        NDX: 0,
      },
    });
  });
});
