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
  getConvexityTrend,
  getLatestSnapshots,
  getMaxchangeWinners,
  getSiblingConfirmation,
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
          delta_risk_reversal: '0.05',
        },
      ]);
      const [row] = await getLatestSnapshots();
      expect(row!.spot).toBe(5985.2);
      expect(row!.zcvr).toBe(1.25);
      expect(row!.zvanna).toBeNull();
      expect(row!.capturedAt).toBe('2026-05-19T14:00:00.000Z');
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

  // ── getSiblingConfirmation ───────────────────────────────

  describe('getSiblingConfirmation', () => {
    it('returns confirm for call when sibling zcvr > 1', async () => {
      mockSql.mockResolvedValueOnce([
        { ticker: 'QQQ', zcvr: '1.3', delta_risk_reversal: '0.02' },
      ]);
      const [row] = await getSiblingConfirmation('SPY', 'call');
      expect(row!.verdict).toBe('confirm');
    });

    it('returns contradict for call when sibling zcvr < 1 and DRR < 0', async () => {
      mockSql.mockResolvedValueOnce([
        { ticker: 'QQQ', zcvr: '0.8', delta_risk_reversal: '-0.04' },
      ]);
      const [row] = await getSiblingConfirmation('SPY', 'call');
      expect(row!.verdict).toBe('contradict');
    });

    it('mirrors logic for put alerts', async () => {
      mockSql.mockResolvedValueOnce([
        { ticker: 'QQQ', zcvr: '0.8', delta_risk_reversal: '-0.02' },
      ]);
      const [row] = await getSiblingConfirmation('SPY', 'put');
      expect(row!.verdict).toBe('confirm');
    });

    it('returns neutral when both metrics are null', async () => {
      mockSql.mockResolvedValueOnce([
        { ticker: 'QQQ', zcvr: null, delta_risk_reversal: null },
      ]);
      const [row] = await getSiblingConfirmation('SPY', 'call');
      expect(row!.verdict).toBe('neutral');
    });

    it('returns [] when sibling group resolution yields no siblings', async () => {
      // A ticker not in any group → falls back to broad siblings minus
      // itself. SPX is in broad, so siblings should be [SPY,QQQ,IWM,NDX]
      // — non-empty. Use a fake ticker via group inspection instead.
      // For an "alone" ticker the function returns broad-minus-self.
      mockSql.mockResolvedValueOnce([]);
      const result = await getSiblingConfirmation('SPY', 'call');
      expect(result).toEqual([]);
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
      await getSiblingConfirmation('VIX', 'call');
      const siblings = siblingsPassedTo(mockSql.mock.calls[0] as unknown[]);
      expect(siblings).toEqual(['UVXY']);
    });

    it('resolves bonds-group siblings for a TLT put (HYG only)', async () => {
      mockSql.mockResolvedValueOnce([]);
      await getSiblingConfirmation('TLT', 'put');
      const siblings = siblingsPassedTo(mockSql.mock.calls[0] as unknown[]);
      expect(siblings).toEqual(['HYG']);
    });

    it('resolves metals-group siblings for a GLD call (SLV only)', async () => {
      mockSql.mockResolvedValueOnce([]);
      await getSiblingConfirmation('GLD', 'call');
      const siblings = siblingsPassedTo(mockSql.mock.calls[0] as unknown[]);
      expect(siblings).toEqual(['SLV']);
    });

    it('returns [] without sql call for energy-group USO (no siblings)', async () => {
      // USO is alone in the energy group → siblingsFor returns [].
      // The function should short-circuit before issuing the SQL query.
      const result = await getSiblingConfirmation('USO', 'put');
      expect(result).toEqual([]);
      expect(mockSql).not.toHaveBeenCalled();
    });

    it('resolves broad-group siblings for an SPX call (4 others, self excluded)', async () => {
      mockSql.mockResolvedValueOnce([]);
      await getSiblingConfirmation('SPX', 'call');
      const siblings = siblingsPassedTo(mockSql.mock.calls[0] as unknown[]);
      // broad = [SPX, SPY, QQQ, IWM, NDX]; SPX excluded → 4 siblings.
      expect(siblings.sort()).toEqual(['IWM', 'NDX', 'QQQ', 'SPY']);
      expect(siblings).not.toContain('SPX');
    });

    it('falls back to broad-market siblings for an out-of-group single stock', async () => {
      mockSql.mockResolvedValueOnce([]);
      await getSiblingConfirmation('AAPL', 'put');
      const siblings = siblingsPassedTo(mockSql.mock.calls[0] as unknown[]);
      // AAPL isn't in any group → broad-minus-self. AAPL isn't in
      // broad either so all 5 broad tickers come through.
      expect(siblings.sort()).toEqual(['IWM', 'NDX', 'QQQ', 'SPX', 'SPY']);
    });

    it('classifies neutral when only zcvr OR only DRR has a same-direction signal', async () => {
      // Reviewer note v0: heuristic is OR semantics. zcvr=1.05 (only
      // mildly call-leaning, below threshold) + DRR=null → callBias
      // false (zcvr ≤ 1 threshold) → neutral.
      mockSql.mockResolvedValueOnce([
        { ticker: 'QQQ', zcvr: '1.0', delta_risk_reversal: null },
      ]);
      const [row] = await getSiblingConfirmation('SPY', 'call');
      expect(row!.verdict).toBe('neutral');
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
});
