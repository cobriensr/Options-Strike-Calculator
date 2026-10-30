// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
          dexoflow: '1234.5',
          gexoflow: '567.8',
          cvroflow: '0.12',
          one_dexoflow: null,
          one_gexoflow: null,
          one_cvroflow: null,
          min_dte: 2,
        },
      ]);
      const [row] = await getLatestSnapshots();
      expect(row!.minDte).toBe(2);
      expect(row).not.toHaveProperty('deltaRiskReversal');
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
});
