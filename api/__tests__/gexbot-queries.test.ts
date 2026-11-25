// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

import {
  FIRE_TIME_MAX_AGE_SECONDS,
  getConvexityTrend,
  getExpectedMove,
  getLatestGexbotSnapshotAt,
  getLatestSnapshots,
  getMaxchangeWinners,
  getSiblingConfirmation,
  getVelocityTape,
  siblingVerdict,
  mapToGexbotTicker,
  SIBLING_GROUPS,
} from '../_lib/gexbot-queries.js';

describe('gexbot-queries', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── getLatestSnapshots ───────────────────────────────────

  describe('getLatestSnapshots', () => {
    it('returns [] when the source table is empty', async () => {
      mockSql.mockResolvedValueOnce([]);
      const result = await getLatestSnapshots();
      expect(result).toEqual([]);
    });

    it('coerces NUMERIC-as-string to number', async () => {
      mockSql.mockResolvedValueOnce([
        {
          ticker: 'SPX',
          captured_at: new Date('2026-05-19T14:00:00Z'),
          spot: '5985.20',
          zero_gamma: '5990',
          z_mlgamma: '5950',
          z_msgamma: '6020',
          zcvr: '1.25',
          zgr: '0.83',
          zvanna: null,
          zcharm: '47000000',
          o_mlgamma: '5800',
          o_msgamma: '6100',
          ocvr: '1.1',
          ogr: '0.9',
          ovanna: null,
          ocharm: null,
          one_dexoflow: null,
          one_gexoflow: null,
          one_cvroflow: null,
          min_dte: 2,
        },
      ]);
      const [row] = await getLatestSnapshots();
      expect(row!.minDte).toBe(2);
      expect(row).not.toHaveProperty('deltaRiskReversal');
      // The vendor's 1-2 s step fields for the nearest expiry are unread.
      expect(row).not.toHaveProperty('dexoflow');
      expect(row).not.toHaveProperty('gexoflow');
      expect(row).not.toHaveProperty('cvroflow');
      expect(row!.spot).toBe(5985.2);
      expect(row!.zcvr).toBe(1.25);
      expect(row!.zvanna).toBeNull();
      expect(row!.capturedAt).toBe('2026-05-19T14:00:00.000Z');
    });
  });

  // ── getVelocityTape (row mapping; the SQL is proven in the pglite test) ──

  describe('getVelocityTape', () => {
    it('coerces NUMERIC-as-string deltas and keeps nulls as null', async () => {
      mockSql.mockResolvedValueOnce([
        {
          ticker: 'SPX',
          captured_at: new Date('2026-10-29T14:04:00Z'),
          min_dte: 0,
          d_agg_dex: '-1250000.5',
          d_zgr: '0.25',
          d_zcvr: null,
          typical_abs_d_agg_dex: '800000',
        },
        {
          ticker: 'VIX',
          captured_at: new Date('2026-10-29T14:04:00Z'),
          min_dte: null,
          d_agg_dex: null,
          d_zgr: null,
          d_zcvr: null,
          typical_abs_d_agg_dex: null,
        },
      ]);
      const rows = await getVelocityTape();
      expect(rows[0]).toEqual({
        ticker: 'SPX',
        capturedAt: '2026-10-29T14:04:00.000Z',
        minDte: 0,
        dAggDex: -1250000.5,
        dZgr: 0.25,
        dZcvr: null,
        typicalAbsDAggDex: 800000,
      });
      expect(rows[1]).toMatchObject({
        ticker: 'VIX',
        minDte: null,
        dAggDex: null,
        typicalAbsDAggDex: null,
      });
    });

    it('propagates a DB failure', async () => {
      mockSql.mockRejectedValueOnce(new Error('connection lost'));
      await expect(getVelocityTape()).rejects.toThrow('connection lost');
    });
  });

  // ── getConvexityTrend ────────────────────────────────────

  describe('getConvexityTrend', () => {
    it('returns [] when no rows', async () => {
      mockSql.mockResolvedValueOnce([]);
      expect(await getConvexityTrend()).toEqual([]);
    });

    it('groups by ticker preserving chronological order', async () => {
      mockSql.mockResolvedValueOnce([
        { ticker: 'SPX', captured_at: '2026-05-19T13:00:00Z', zcvr: '1.0' },
        { ticker: 'SPX', captured_at: '2026-05-19T13:01:00Z', zcvr: '1.1' },
        { ticker: 'QQQ', captured_at: '2026-05-19T13:00:00Z', zcvr: '0.9' },
      ]);
      const result = await getConvexityTrend();
      expect(result.length).toBe(2);
      const spx = result.find((r) => r.ticker === 'SPX')!;
      expect(spx.series.length).toBe(2);
      expect(spx.series[0]![1]).toBe(1);
      expect(spx.series[1]![1]).toBe(1.1);
      expect(spx.minDte).toBeNull();
    });

    it('carries the latest min_dte per ticker', async () => {
      mockSql.mockResolvedValueOnce([
        {
          ticker: 'HYG',
          captured_at: '2026-05-19T13:00:00Z',
          zcvr: '-5',
          min_dte: 3,
        },
        {
          ticker: 'HYG',
          captured_at: '2026-05-19T13:01:00Z',
          zcvr: '-6',
          min_dte: 2,
        },
        { ticker: 'SPX', captured_at: '2026-05-19T13:00:00Z', zcvr: '1' },
      ]);
      const result = await getConvexityTrend();
      expect(result.find((r) => r.ticker === 'HYG')!.minDte).toBe(2);
      expect(result.find((r) => r.ticker === 'SPX')!.minDte).toBeNull();
    });

    it('keeps the last non-null min_dte when the newest row lacks one', async () => {
      mockSql.mockResolvedValueOnce([
        {
          ticker: 'HYG',
          captured_at: '2026-05-19T13:00:00Z',
          zcvr: '-5',
          min_dte: 2,
        },
        {
          ticker: 'HYG',
          captured_at: '2026-05-19T13:01:00Z',
          zcvr: '-6',
          min_dte: null,
        },
      ]);
      const result = await getConvexityTrend();
      expect(result[0]!.minDte).toBe(2);
    });

    it('skips NaN zcvr rows', async () => {
      mockSql.mockResolvedValueOnce([
        {
          ticker: 'SPX',
          captured_at: '2026-05-19T13:00:00Z',
          zcvr: 'not-a-number',
        },
        { ticker: 'SPX', captured_at: '2026-05-19T13:01:00Z', zcvr: '1.1' },
      ]);
      const result = await getConvexityTrend();
      expect(result[0]!.series.length).toBe(1);
    });
  });

  // ── getMaxchangeWinners ──────────────────────────────────

  describe('getMaxchangeWinners', () => {
    it('returns [] when no rows', async () => {
      mockSql.mockResolvedValueOnce([]);
      expect(await getMaxchangeWinners()).toEqual([]);
    });

    it('extracts strike/change tuples per window', async () => {
      mockSql.mockResolvedValueOnce([
        {
          ticker: 'SPX',
          endpoint: 'classic',
          category: 'gex_zero/maxchange',
          captured_at: new Date('2026-05-19T14:00:00Z'),
          raw_response: {
            current: [5950, 1.2],
            one: [5955, 0.8],
            five: [5960, 2.4],
            ten: null,
            fifteen: [5950, 4.1],
            thirty: [5945, 5.0],
          },
        },
      ]);
      const [row] = await getMaxchangeWinners();
      expect(row!.windows.current).toEqual([5950, 1.2]);
      expect(row!.windows.ten).toBeNull();
      expect(row!.windows.thirty).toEqual([5945, 5.0]);
    });

    it('drops the INT32 sentinel (-2147483.648) from any window', async () => {
      mockSql.mockResolvedValueOnce([
        {
          ticker: 'SPX',
          endpoint: 'state',
          category: 'gex_zero/maxchange',
          captured_at: '2026-05-19T19:59:50Z',
          raw_response: {
            current: [5950, -2147483.648],
            one: [-2147483.648, 12],
            five: [5960, -2147483],
            ten: [5955, -2147482],
            fifteen: [5950, 4.1],
          },
        },
      ]);
      const [row] = await getMaxchangeWinners();
      expect(row!.windows.current).toBeNull();
      expect(row!.windows.one).toBeNull();
      expect(row!.windows.five).toBeNull();
      // Just above the sentinel floor is a real (if huge) value.
      expect(row!.windows.ten).toEqual([5955, -2147482]);
      expect(row!.windows.fifteen).toEqual([5950, 4.1]);
    });

    it('returns null for malformed window entries', async () => {
      mockSql.mockResolvedValueOnce([
        {
          ticker: 'SPX',
          endpoint: 'classic',
          category: 'gex_zero/maxchange',
          captured_at: '2026-05-19T14:00:00Z',
          raw_response: {
            current: 'not-an-array',
            one: [5955],
          },
        },
      ]);
      const [row] = await getMaxchangeWinners();
      expect(row!.windows.current).toBeNull();
      expect(row!.windows.one).toBeNull();
    });
  });

  // ── siblingVerdict ───────────────────────────────────────

  describe('siblingVerdict', () => {
    it.each([
      ['call', 1_500_000, 'agree'],
      ['call', -1_500_000, 'disagree'],
      ['put', 1_500_000, 'disagree'],
      ['put', -1_500_000, 'agree'],
      ['call', 0, 'none'],
      ['put', 0, 'none'],
      ['call', null, 'none'],
      ['put', null, 'none'],
    ] as const)('%s alert with net_dex %s reads %s', (side, netDex, want) => {
      expect(siblingVerdict(side, netDex)).toBe(want);
    });

    it.each([1, -1, 0.0001, -0.0001, 0, null])(
      'is never agree for both sides (net_dex %s)',
      (netDex) => {
        const both =
          siblingVerdict('call', netDex) === 'agree' &&
          siblingVerdict('put', netDex) === 'agree';
        expect(both).toBe(false);
      },
    );
  });

  // ── getSiblingConfirmation ───────────────────────────────

  describe('getSiblingConfirmation', () => {
    const FIRE = new Date('2026-10-29T14:00:10.000Z');

    it('reads agree for a call when the sibling net_dex is positive', async () => {
      mockSql.mockResolvedValueOnce([
        {
          ticker: 'QQQ',
          captured_at: new Date('2026-10-29T14:00:00Z'),
          net_dex: '1500000',
          zgr: '0.83',
        },
      ]);
      const rows = await getSiblingConfirmation('SPY', 'call', FIRE);
      const qqq = rows.find((r) => r.ticker === 'QQQ');
      expect(qqq).toEqual({
        ticker: 'QQQ',
        netDex: 1_500_000,
        zgr: 0.83,
        capturedAt: '2026-10-29T14:00:00.000Z',
        verdict: 'agree',
      });
    });

    it('reads disagree for a put when the sibling net_dex is positive', async () => {
      mockSql.mockResolvedValueOnce([
        {
          ticker: 'QQQ',
          captured_at: new Date('2026-10-29T14:00:00Z'),
          net_dex: '1500000',
          zgr: null,
        },
      ]);
      const rows = await getSiblingConfirmation('SPY', 'put', FIRE);
      expect(rows.find((r) => r.ticker === 'QQQ')?.verdict).toBe('disagree');
    });

    it('reads none for zero or null net_dex', async () => {
      mockSql.mockResolvedValueOnce([
        {
          ticker: 'QQQ',
          captured_at: new Date('2026-10-29T14:00:00Z'),
          net_dex: '0',
          zgr: '1.2',
        },
        {
          ticker: 'IWM',
          captured_at: new Date('2026-10-29T14:00:00Z'),
          net_dex: null,
          zgr: '1.2',
        },
      ]);
      const rows = await getSiblingConfirmation('SPY', 'call', FIRE);
      expect(rows.find((r) => r.ticker === 'QQQ')?.verdict).toBe('none');
      expect(rows.find((r) => r.ticker === 'IWM')?.verdict).toBe('none');
    });

    it('returns a no-data row for every sibling that has no snapshot', async () => {
      mockSql.mockResolvedValueOnce([]);
      const rows = await getSiblingConfirmation('SPY', 'call', FIRE);
      expect(rows.map((r) => r.ticker).sort()).toEqual([
        'IWM',
        'NDX',
        'QQQ',
        'SPX',
      ]);
      for (const r of rows) {
        expect(r).toMatchObject({
          netDex: null,
          zgr: null,
          capturedAt: null,
          verdict: 'none',
        });
      }
    });

    it('bounds the lookup to [fire - 180 s, fire]', async () => {
      mockSql.mockResolvedValueOnce([]);
      await getSiblingConfirmation('SPY', 'call', FIRE);
      const args = (mockSql.mock.calls[0] as unknown[]).slice(1);
      expect(args).toContain('2026-10-29T14:00:10.000Z');
      expect(args).toContain('2026-10-29T13:57:10.000Z');
    });

    it('shares one freshness window with getLatestGexbotSnapshotAt', async () => {
      expect(FIRE_TIME_MAX_AGE_SECONDS).toBe(180);
      mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await getSiblingConfirmation('SPY', 'call', FIRE);
      await getLatestGexbotSnapshotAt('SPY', FIRE);
      const lower = '2026-10-29T13:57:10.000Z';
      expect((mockSql.mock.calls[0] as unknown[]).slice(1)).toContain(lower);
      expect((mockSql.mock.calls[1] as unknown[]).slice(1)).toContain(lower);
    });

    it('requires the vendor timestamp (Unix seconds) to sit in the window', async () => {
      mockSql.mockResolvedValueOnce([]);
      await getSiblingConfirmation('SPY', 'call', FIRE);
      const text = (mockSql.mock.calls[0]?.[0] as string[]).join('?');
      expect(text).toMatch(/source_timestamp IS NULL/);
      expect(text).toMatch(/source_timestamp >= extract\(epoch FROM/);
    });

    it('does not read zcvr or delta_risk_reversal', async () => {
      mockSql.mockResolvedValueOnce([]);
      await getSiblingConfirmation('SPY', 'call', FIRE);
      const text = (mockSql.mock.calls[0]?.[0] as string[]).join('?');
      expect(text).toContain('net_dex');
      expect(text).not.toMatch(/zcvr|delta_risk_reversal/);
    });

    it('propagates a DB failure', async () => {
      mockSql.mockRejectedValueOnce(new Error('connection lost'));
      await expect(getSiblingConfirmation('SPY', 'call', FIRE)).rejects.toThrow(
        'connection lost',
      );
    });

    // ── Group resolution matrix ────────────────────────────

    /**
     * Helper: pull the ticker array that was passed to the SQL query.
     * The `sql` tagged-template call interleaves args with strings;
     * the only array in `dynamicArgs` should be the siblings list.
     */
    function siblingsPassedTo(call: unknown[]): string[] {
      const dynamicArgs = call.slice(1);
      const arr = dynamicArgs.find(
        (a): a is string[] =>
          Array.isArray(a) && a.every((x) => typeof x === 'string'),
      );
      if (!arr) throw new Error('no siblings array found in sql call args');
      return arr;
    }

    it('resolves vol-group siblings for a VIX call (UVXY only)', async () => {
      mockSql.mockResolvedValueOnce([]);
      await getSiblingConfirmation('VIX', 'call', FIRE);
      const siblings = siblingsPassedTo(mockSql.mock.calls[0] as unknown[]);
      expect(siblings).toEqual(['UVXY']);
    });

    it('resolves bonds-group siblings for a TLT put (HYG only)', async () => {
      mockSql.mockResolvedValueOnce([]);
      await getSiblingConfirmation('TLT', 'put', FIRE);
      const siblings = siblingsPassedTo(mockSql.mock.calls[0] as unknown[]);
      expect(siblings).toEqual(['HYG']);
    });

    it('resolves metals-group siblings for a GLD call (SLV only)', async () => {
      mockSql.mockResolvedValueOnce([]);
      await getSiblingConfirmation('GLD', 'call', FIRE);
      const siblings = siblingsPassedTo(mockSql.mock.calls[0] as unknown[]);
      expect(siblings).toEqual(['SLV']);
    });

    it('returns [] without sql call for energy-group USO (no siblings)', async () => {
      const result = await getSiblingConfirmation('USO', 'put', FIRE);
      expect(result).toEqual([]);
      expect(mockSql).not.toHaveBeenCalled();
    });

    it('resolves broad-group siblings for an SPX call (4 others, self excluded)', async () => {
      mockSql.mockResolvedValueOnce([]);
      await getSiblingConfirmation('SPX', 'call', FIRE);
      const siblings = siblingsPassedTo(mockSql.mock.calls[0] as unknown[]);
      expect(siblings.sort()).toEqual(['IWM', 'NDX', 'QQQ', 'SPY']);
      expect(siblings).not.toContain('SPX');
    });

    it('excludes the cash index itself for an SPXW alert', async () => {
      mockSql.mockResolvedValueOnce([]);
      await getSiblingConfirmation('SPXW', 'call', FIRE);
      const siblings = siblingsPassedTo(mockSql.mock.calls[0] as unknown[]);
      expect(siblings.sort()).toEqual(['IWM', 'NDX', 'QQQ', 'SPY']);
    });

    it('falls back to broad-market siblings for an out-of-group single stock', async () => {
      mockSql.mockResolvedValueOnce([]);
      await getSiblingConfirmation('AAPL', 'put', FIRE);
      const siblings = siblingsPassedTo(mockSql.mock.calls[0] as unknown[]);
      expect(siblings.sort()).toEqual(['IWM', 'NDX', 'QQQ', 'SPX', 'SPY']);
    });

    it('never asks for the futures views', async () => {
      for (const t of ['SPX', 'NDX', 'AAPL', 'VIX']) {
        mockSql.mockResolvedValueOnce([]);
        await getSiblingConfirmation(t, 'call', FIRE);
      }
      for (const call of mockSql.mock.calls) {
        const siblings = siblingsPassedTo(call as unknown[]);
        expect(siblings).not.toContain('ES_SPX');
        expect(siblings).not.toContain('NQ_NDX');
      }
    });
  });

  // ── SIBLING_GROUPS sanity ─────────────────────────────────

  describe('SIBLING_GROUPS', () => {
    it('contains the expected 5 buckets', () => {
      expect(Object.keys(SIBLING_GROUPS).sort()).toEqual([
        'bonds',
        'broad',
        'energy',
        'metals',
        'vol',
      ]);
    });
  });

  // ── mapToGexbotTicker ─────────────────────────────────────

  describe('mapToGexbotTicker', () => {
    it('maps the three OPRA weekly-cash roots to their GexBot cash-index ticker', () => {
      // Both detect-cron universes carry SPXW/NDXP/RUTW; GexBot covers
      // them under SPX/NDX/RUT. Without these mappings, every fire on
      // those roots would silently bind NULL into the gex_* columns.
      expect(mapToGexbotTicker('SPXW')).toBe('SPX');
      expect(mapToGexbotTicker('NDXP')).toBe('NDX');
      expect(mapToGexbotTicker('RUTW')).toBe('RUT');
    });

    it('returns the same ticker when it is in the GexBot universe', () => {
      expect(mapToGexbotTicker('SPY')).toBe('SPY');
      expect(mapToGexbotTicker('QQQ')).toBe('QQQ');
      expect(mapToGexbotTicker('VIX')).toBe('VIX');
    });

    it('returns null for tickers outside the GexBot universe', () => {
      expect(mapToGexbotTicker('AAPL')).toBeNull();
      expect(mapToGexbotTicker('TSLA')).toBeNull();
      expect(mapToGexbotTicker('NVDA')).toBeNull();
    });
  });

  // ── getLatestGexbotSnapshotAt ─────────────────────────────

  describe('getLatestGexbotSnapshotAt', () => {
    it('returns null when no row falls inside the freshness window', async () => {
      mockSql.mockResolvedValueOnce([]);
      const result = await getLatestGexbotSnapshotAt(
        'SPY',
        new Date('2026-05-22T14:00:00Z'),
      );
      expect(result).toBeNull();
    });

    it('returns the most recent row coerced to numbers', async () => {
      const captured = new Date('2026-05-22T13:59:30Z');
      mockSql.mockResolvedValueOnce([
        {
          captured_at: captured,
          one_cvroflow: '1.42',
          net_put_dex: '-1500000',
          one_dexoflow: '0.18',
          one_gexoflow: '-0.05',
          zcvr: '1.1',
          zero_gamma: '5990',
          spot: '5985.2',
        },
      ]);
      const row = await getLatestGexbotSnapshotAt(
        'SPX',
        new Date('2026-05-22T14:00:00Z'),
      );
      expect(row).not.toBeNull();
      expect(row!.oneCvroflow).toBe(1.42);
      expect(row!.netPutDex).toBe(-1_500_000);
      expect(row!.zcvr).toBe(1.1);
      expect(row!.zeroGamma).toBe(5990);
      expect(row!.spot).toBe(5985.2);
      expect(row!.capturedAt.toISOString()).toBe(captured.toISOString());
    });

    it('requires the vendor timestamp (Unix seconds) to sit in the window', async () => {
      mockSql.mockResolvedValueOnce([]);
      await getLatestGexbotSnapshotAt('VIX', new Date('2026-05-22T14:00:00Z'));
      const text = (mockSql.mock.calls[0]?.[0] as string[]).join('?');
      expect(text).toMatch(/source_timestamp IS NULL/);
      expect(text).toMatch(/source_timestamp >= extract\(epoch FROM/);
    });

    it('propagates a DB failure', async () => {
      mockSql.mockRejectedValueOnce(new Error('connection lost'));
      await expect(
        getLatestGexbotSnapshotAt('SPX', new Date('2026-05-22T14:00:00Z')),
      ).rejects.toThrow('connection lost');
    });

    it('coerces string captured_at to Date', async () => {
      mockSql.mockResolvedValueOnce([
        {
          captured_at: '2026-05-22T13:59:30.000Z',
          one_cvroflow: null,
          net_put_dex: null,
          one_dexoflow: null,
          one_gexoflow: null,
          zcvr: null,
          zero_gamma: null,
          spot: null,
        },
      ]);
      const row = await getLatestGexbotSnapshotAt(
        'SPX',
        new Date('2026-05-22T14:00:00Z'),
      );
      expect(row).not.toBeNull();
      expect(row!.capturedAt).toBeInstanceOf(Date);
      expect(row!.oneCvroflow).toBeNull();
    });
  });

  // ── getExpectedMove ──────────────────────────────────────

  describe('getExpectedMove', () => {
    // 11:13:12 ET on a regular session; the vendor stamps seconds.
    const AS_OF_S = 1753283592;
    const CAPTURED = new Date('2025-07-23T15:13:14Z');

    function capture(overrides: Record<string, unknown> = {}) {
      return {
        captured_at: CAPTURED,
        raw_response: {
          timestamp: AS_OF_S,
          ticker: 'SPX',
          spot: 6326.27,
          min_dte: 0,
          mini_contracts: [
            [6320, 0.12, 0.12, 1, [], 0, null],
            [6325, 0.1, 0.12, 1, [], 0, null],
            [6330, 0.1, 0.1, 1, [], 0, null],
          ],
          ...overrides,
        },
      };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns [] when there is no fresh capture row', async () => {
      mockSql.mockResolvedValueOnce([]);
      expect(await getExpectedMove()).toEqual([]);
    });

    it('reads the latest SPX gamma_zero state capture inside the 5-minute window', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-07-23T15:13:30Z'));
      mockSql.mockResolvedValueOnce([]);
      await getExpectedMove();
      expect(mockSql).toHaveBeenCalledTimes(1);
      const args = (mockSql.mock.calls[0] as unknown[]).slice(1);
      expect(args).toEqual(['SPX', 'gamma_zero', '2025-07-23T15:08:30.000Z']);
      const text = (mockSql.mock.calls[0]?.[0] as string[]).join('?');
      expect(text).toContain('FROM gexbot_api_capture');
      expect(text).toContain("endpoint = 'state'");
      expect(text).toContain('ORDER BY captured_at DESC');
      expect(text).toContain('LIMIT 1');
    });

    it('computes the move as of the vendor timestamp', async () => {
      mockSql.mockResolvedValueOnce([capture()]);
      const [row] = await getExpectedMove();
      expect(row).toMatchObject({
        ticker: 'SPX',
        capturedAt: '2025-07-23T15:13:14.000Z',
        asOf: '2025-07-23T15:13:12.000Z',
        spot: 6326.27,
        minDte: 0,
        atmStrike: 6325,
        unavailable: null,
      });
      expect(row!.atmIv).toBeCloseTo(0.11, 12);
      expect(row!.expectedMove).toBeCloseTo(16.25557378390728, 9);
      expect(row!.lower).toBeCloseTo(6310.014426216093, 9);
      expect(row!.upper).toBeCloseTo(6342.525573783908, 9);
    });

    it('falls back to captured_at when the payload has no usable timestamp', async () => {
      mockSql.mockResolvedValueOnce([
        {
          ...capture({ timestamp: 'soon' }),
          captured_at: CAPTURED.toISOString(),
        },
      ]);
      const [row] = await getExpectedMove();
      expect(row!.asOf).toBe('2025-07-23T15:13:14.000Z');
      expect(row!.unavailable).toBeNull();
      // Two seconds later than the vendor stamp, so slightly less time left.
      expect(row!.dteFraction).toBeCloseTo(17206 / 86400, 12);
    });

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['beyond the Date range', 1e20],
    ])('falls back to captured_at for a %s timestamp', async (_label, ts) => {
      mockSql.mockResolvedValueOnce([capture({ timestamp: ts })]);
      const [row] = await getExpectedMove();
      expect(row!.asOf).toBe('2025-07-23T15:13:14.000Z');
      expect(row!.unavailable).toBeNull();
    });

    it('treats a replayed prior-session timestamp as no fresh data, not as "session closed"', async () => {
      // The vendor can repeat the prior close at the open; the IVs then
      // describe a session that ended yesterday. Today's session has not
      // closed, so the tile must wait (an empty read) rather than say so.
      mockSql.mockResolvedValueOnce([
        capture({ timestamp: Date.parse('2025-07-22T20:00:00Z') / 1000 }),
      ]);
      expect(await getExpectedMove()).toEqual([]);
    });

    it('compares the stamp to the capture by ET date: 23:00 ET the night before is not fresh', async () => {
      // 03:00Z on the 23rd is 23:00 ET on the 22nd; the capture is 13:31Z.
      mockSql.mockResolvedValueOnce([
        {
          ...capture({ timestamp: Date.parse('2025-07-23T03:00:00Z') / 1000 }),
          captured_at: new Date('2025-07-23T13:31:00Z'),
        },
      ]);
      expect(await getExpectedMove()).toEqual([]);
    });

    // The vendor rolls its day between 08:00 and 08:30 ET, so a stamp from
    // the premarket carries the roll's IVs, not the session's: sized from
    // 08:20 ET it would show a dteFraction larger than the session.
    describe('a vendor stamp from before the 09:30 ET open', () => {
      // 09:30:05 ET capture on 2025-07-23 (EDT).
      const CAPTURED_AT_OPEN = new Date('2025-07-23T13:30:05Z');
      const atOpen = (stamp: string) => ({
        ...capture({ timestamp: Date.parse(stamp) / 1000 }),
        captured_at: CAPTURED_AT_OPEN,
      });

      it('is no fresh data: an 08:20 ET same-day stamp on a 09:30:05 capture', async () => {
        mockSql.mockResolvedValueOnce([atOpen('2025-07-23T12:20:00Z')]);
        expect(await getExpectedMove()).toEqual([]);
      });

      it('is no fresh data one second before the open (09:29:59 ET)', async () => {
        mockSql.mockResolvedValueOnce([atOpen('2025-07-23T13:29:59Z')]);
        expect(await getExpectedMove()).toEqual([]);
      });

      it('is kept from 09:30:00 ET, and sized from that stamp', async () => {
        mockSql.mockResolvedValueOnce([atOpen('2025-07-23T13:30:00Z')]);
        const [row] = await getExpectedMove();
        expect(row!.asOf).toBe('2025-07-23T13:30:00.000Z');
        expect(row!.unavailable).toBeNull();
        // 09:30:00 ET to 16:00 ET is 6.5 h.
        expect(row!.dteFraction).toBeCloseTo(6.5 / 24, 12);
      });

      it('is no fresh data on the prior ET date too', async () => {
        mockSql.mockResolvedValueOnce([atOpen('2025-07-22T20:00:00Z')]);
        expect(await getExpectedMove()).toEqual([]);
      });

      it('reads the open by the ET date, not the UTC date', async () => {
        // 2025-07-24T01:00:02Z is 21:00:02 ET on the 23rd. The UTC date has
        // rolled to the 24th, but the open that bounds the stamp is the
        // 23rd's 09:30 ET, so a 21:00 ET stamp is kept (and past the close).
        mockSql.mockResolvedValueOnce([
          {
            ...capture({
              timestamp: Date.parse('2025-07-24T01:00:00Z') / 1000,
            }),
            captured_at: new Date('2025-07-24T01:00:02Z'),
          },
        ]);
        const [row] = await getExpectedMove();
        expect(row!.asOf).toBe('2025-07-24T01:00:00.000Z');
        expect(row!.unavailable).toBe('expired');
      });

      it('uses the capture date in winter too (EST, 09:30 ET is 14:30Z)', async () => {
        // 2025-12-10: 14:29:59Z is 09:29:59 EST, 14:30:00Z is 09:30:00 EST.
        const winter = (stamp: string) => ({
          ...capture({ timestamp: Date.parse(stamp) / 1000 }),
          captured_at: new Date('2025-12-10T14:30:05Z'),
        });
        mockSql.mockResolvedValueOnce([winter('2025-12-10T14:29:59Z')]);
        expect(await getExpectedMove()).toEqual([]);
        mockSql.mockResolvedValueOnce([winter('2025-12-10T14:30:00Z')]);
        const [row] = await getExpectedMove();
        expect(row!.asOf).toBe('2025-12-10T14:30:00.000Z');
      });
    });

    it("is live on the vendor's real last stamp of a session: 15:59:59 ET, captured 16:00:44", async () => {
      // Production shape on 2026-11-23 and 11-24: the vendor never stamps
      // 16:00:00; its last snapshot is 15:59:59 ET (20:59:59Z in EST), and
      // the capture lands about 45 s later. The row is live, one second of
      // time left on the vendor's clock; the tile's own marketOpen gate says
      // "session closed" (ExpectedMoveTile), not this read.
      mockSql.mockResolvedValueOnce([
        {
          ...capture({ timestamp: 1795553999 }),
          captured_at: new Date('2026-11-24T21:00:44Z'),
        },
      ]);
      const [row] = await getExpectedMove();
      expect(row!.asOf).toBe('2026-11-24T20:59:59.000Z');
      expect(row!.capturedAt).toBe('2026-11-24T21:00:44.000Z');
      expect(row!.unavailable).toBeNull();
      expect(row!.dteFraction).toBeCloseTo(1 / 86400, 12);
      expect(row!.expectedMove).not.toBeNull();
    });

    it('still says "expired" for a same-day stamp at the close: the session did end', async () => {
      // Captured at 16:03 ET with the vendor's final 16:00:00 ET snapshot.
      mockSql.mockResolvedValueOnce([
        {
          ...capture({ timestamp: Date.parse('2025-07-23T20:00:00Z') / 1000 }),
          captured_at: new Date('2025-07-23T20:03:00Z'),
        },
      ]);
      const [row] = await getExpectedMove();
      expect(row!.asOf).toBe('2025-07-23T20:00:00.000Z');
      expect(row!.unavailable).toBe('expired');
      expect(row!.expectedMove).toBeNull();
    });

    it('says "expired" on a half day from 13:00 ET', async () => {
      // 2026-11-27 closes at 13:00 ET (18:00Z). Captured 13:00:02 ET.
      mockSql.mockResolvedValueOnce([
        {
          ...capture({ timestamp: Date.parse('2026-11-27T18:00:01Z') / 1000 }),
          captured_at: new Date('2026-11-27T18:00:02Z'),
        },
      ]);
      const [row] = await getExpectedMove();
      expect(row!.unavailable).toBe('expired');
    });

    it('names a capture with no IV at the ATM strike instead of guessing', async () => {
      mockSql.mockResolvedValueOnce([
        capture({ mini_contracts: [[6325, 0, 0, 1, [], 0, null]] }),
      ]);
      const [row] = await getExpectedMove();
      expect(row!.unavailable).toBe('no_atm_iv');
      expect(row!.expectedMove).toBeNull();
      expect(row!.spot).toBe(6326.27);
    });

    it('names a malformed payload (no spot, no strikes) as no_spot', async () => {
      mockSql.mockResolvedValueOnce([
        { captured_at: CAPTURED, raw_response: null },
      ]);
      const [row] = await getExpectedMove();
      expect(row).toMatchObject({
        ticker: 'SPX',
        spot: null,
        minDte: null,
        expectedMove: null,
        unavailable: 'no_spot',
      });
    });

    it('names a missing min_dte as no_dte', async () => {
      mockSql.mockResolvedValueOnce([capture({ min_dte: undefined })]);
      const [row] = await getExpectedMove();
      expect(row!.unavailable).toBe('no_dte');
    });

    it('propagates a DB failure', async () => {
      mockSql.mockRejectedValueOnce(new Error('connection lost'));
      await expect(getExpectedMove()).rejects.toThrow('connection lost');
    });
  });
});
