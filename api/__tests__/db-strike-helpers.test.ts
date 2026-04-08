// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock DB ──────────────────────────────────────────────────────
const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

import {
  getStrikeExposures,
  formatStrikeExposuresForClaude,
  getAllExpiryStrikeExposures,
  formatAllExpiryStrikesForClaude,
  formatGreekFlowForClaude,
} from '../_lib/db-strike-helpers.js';
import type {
  StrikeExposureRow,
  FlowDataRow,
} from '../_lib/db-strike-helpers.js';

// ── Helpers ──────────────────────────────────────────────────────

function makeRow(
  overrides: Partial<StrikeExposureRow> = {},
): StrikeExposureRow {
  return {
    strike: 5800,
    price: 5800,
    timestamp: '2026-03-24T15:00:00Z',
    netGamma: 1000000,
    netCharm: 50000,
    netDelta: 200000,
    callGammaOi: 600000,
    putGammaOi: 400000,
    callCharmOi: 30000,
    putCharmOi: 20000,
    dirGamma: 800000,
    dirCharm: 40000,
    ...overrides,
  };
}

/** Build a raw DB row (snake_case fields as returned by postgres). */
function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    strike: 5800,
    price: 5800,
    timestamp: '2026-03-24T15:00:00Z',
    call_gamma_oi: 600000,
    put_gamma_oi: 400000,
    call_gamma_ask: 200000,
    call_gamma_bid: 150000,
    put_gamma_ask: 100000,
    put_gamma_bid: 50000,
    call_charm_oi: 30000,
    put_charm_oi: 20000,
    call_charm_ask: 10000,
    call_charm_bid: 8000,
    put_charm_ask: 6000,
    put_charm_bid: 4000,
    call_delta_oi: 120000,
    put_delta_oi: 80000,
    call_vanna_oi: 15000,
    put_vanna_oi: -10000,
    ...overrides,
  };
}

/**
 * Build a full set of StrikeExposureRow objects spanning 5700-5900.
 * ATM price is 5800. Gamma and charm values vary to exercise formatting logic.
 */
function buildStrikeRows(): StrikeExposureRow[] {
  const strikes = [5700, 5750, 5790, 5795, 5800, 5805, 5810, 5850, 5900];
  return strikes.map((s) => {
    const belowAtm = s < 5800;
    const aboveAtm = s > 5800;
    // Gamma: positive (walls) for round strikes, negative (acceleration) for others
    const netGamma =
      s === 5800
        ? 5_000_000
        : s === 5700
          ? 3_000_000
          : s === 5900
            ? 2_000_000
            : s === 5750
              ? -1_500_000
              : s === 5850
                ? -2_000_000
                : belowAtm
                  ? 500_000
                  : -300_000;
    // Charm: positive below ATM, negative above ATM → CCS-CONFIRMING
    const netCharm = belowAtm ? 80_000 : aboveAtm ? -60_000 : 10_000;
    return makeRow({
      strike: s,
      price: 5800,
      netGamma,
      netCharm,
      netDelta: 200_000,
      callGammaOi: netGamma > 0 ? netGamma * 0.6 : 0,
      putGammaOi: netGamma > 0 ? netGamma * 0.4 : netGamma,
      callCharmOi: netCharm > 0 ? netCharm * 0.6 : 0,
      putCharmOi: netCharm > 0 ? netCharm * 0.4 : netCharm,
      dirGamma: Math.abs(netGamma) * 0.8,
      dirCharm: Math.abs(netCharm) * 0.7,
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe('db-strike-helpers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ================================================================
  // getStrikeExposures
  // ================================================================
  describe('getStrikeExposures', () => {
    it('returns empty array when no timestamp found', async () => {
      mockSql.mockResolvedValueOnce([{ latest_ts: null }]);

      const result = await getStrikeExposures('2026-03-24');

      expect(result).toEqual([]);
      // Only one query (the MAX(timestamp) query), no second query
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('returns mapped rows with correct calculations when data exists', async () => {
      // First call: latest timestamp
      mockSql.mockResolvedValueOnce([{ latest_ts: '2026-03-24T15:00:00Z' }]);
      // Second call: actual rows
      mockSql.mockResolvedValueOnce([
        makeDbRow({
          strike: 5800,
          price: 5800,
          call_gamma_oi: 600000,
          put_gamma_oi: 400000,
          call_charm_oi: 30000,
          put_charm_oi: 20000,
          call_delta_oi: 120000,
          put_delta_oi: 80000,
          call_gamma_ask: 200000,
          call_gamma_bid: 150000,
          put_gamma_ask: 100000,
          put_gamma_bid: 50000,
          call_charm_ask: 10000,
          call_charm_bid: 8000,
          put_charm_ask: 6000,
          put_charm_bid: 4000,
        }),
      ]);

      const result = await getStrikeExposures('2026-03-24');

      expect(result).toHaveLength(1);
      const row = result[0]!;
      // netGamma = callGammaOi + putGammaOi
      expect(row.netGamma).toBe(600000 + 400000);
      // netCharm = callCharmOi + putCharmOi
      expect(row.netCharm).toBe(30000 + 20000);
      // netDelta = callDeltaOi + putDeltaOi
      expect(row.netDelta).toBe(120000 + 80000);
      // dirGamma = call_gamma_ask + call_gamma_bid + put_gamma_ask + put_gamma_bid
      expect(row.dirGamma).toBe(200000 + 150000 + 100000 + 50000);
      // dirCharm = call_charm_ask + call_charm_bid + put_charm_ask + put_charm_bid
      expect(row.dirCharm).toBe(10000 + 8000 + 6000 + 4000);
      expect(row.strike).toBe(5800);
      expect(row.price).toBe(5800);
      expect(row.timestamp).toBe('2026-03-24T15:00:00Z');
      expect(row.callGammaOi).toBe(600000);
      expect(row.putGammaOi).toBe(400000);
      expect(row.callCharmOi).toBe(30000);
      expect(row.putCharmOi).toBe(20000);
      expect(mockSql).toHaveBeenCalledTimes(2);
    });

    it('uses default ticker SPX when not specified', async () => {
      mockSql.mockResolvedValueOnce([{ latest_ts: null }]);

      await getStrikeExposures('2026-03-24');

      // The tagged template call includes the date and ticker as parameters.
      // We can inspect the template call args — first call is the MAX query.
      // mockSql is called as a tagged template literal; the second arg should be 'SPX'.
      const callArgs = mockSql.mock.calls[0]!;
      // Tagged template: first arg = string[], rest = interpolated values
      // Interpolated values are date and ticker
      expect(callArgs[1]).toBe('2026-03-24');
      expect(callArgs[2]).toBe('SPX');
    });

    it('passes custom ticker when specified', async () => {
      mockSql.mockResolvedValueOnce([{ latest_ts: null }]);

      await getStrikeExposures('2026-03-24', 'QQQ');

      const callArgs = mockSql.mock.calls[0]!;
      expect(callArgs[2]).toBe('QQQ');
    });

    it('handles null/undefined DB values gracefully (Number(null) || 0 → 0)', async () => {
      mockSql.mockResolvedValueOnce([{ latest_ts: '2026-03-24T15:00:00Z' }]);
      mockSql.mockResolvedValueOnce([
        makeDbRow({
          call_gamma_oi: null,
          put_gamma_oi: undefined,
          call_charm_oi: null,
          put_charm_oi: null,
          call_delta_oi: null,
          put_delta_oi: null,
          call_gamma_ask: null,
          call_gamma_bid: null,
          put_gamma_ask: null,
          put_gamma_bid: null,
          call_charm_ask: null,
          call_charm_bid: null,
          put_charm_ask: null,
          put_charm_bid: null,
        }),
      ]);

      const result = await getStrikeExposures('2026-03-24');
      const row = result[0]!;

      expect(row.netGamma).toBe(0);
      expect(row.netCharm).toBe(0);
      expect(row.netDelta).toBe(0);
      expect(row.dirGamma).toBe(0);
      expect(row.dirCharm).toBe(0);
      expect(row.callGammaOi).toBe(0);
      expect(row.putGammaOi).toBe(0);
      expect(row.callCharmOi).toBe(0);
      expect(row.putCharmOi).toBe(0);
    });
  });

  // ================================================================
  // formatStrikeExposuresForClaude
  // ================================================================
  describe('formatStrikeExposuresForClaude', () => {
    it('returns null for empty array', () => {
      expect(formatStrikeExposuresForClaude([])).toBeNull();
    });

    it('returns header with ATM price and time', () => {
      const rows = [makeRow()];
      const result = formatStrikeExposuresForClaude(rows)!;

      expect(result).toContain('SPX 0DTE Per-Strike Greek Profile');
      expect(result).toContain('ATM: 5800');
      // Timestamp is 15:00 UTC = 11:00 AM ET
      expect(result).toMatch(/\d{2}:\d{2}\s*(AM|PM)\s*ET/i);
    });

    it('identifies gamma walls (positive netGamma)', () => {
      const rows = buildStrikeRows();
      const result = formatStrikeExposuresForClaude(rows)!;

      expect(result).toContain('Gamma Walls (positive');
      // 5800 is the largest wall at 5M
      expect(result).toContain('5800');
      // 5700 at 3M is second wall
      expect(result).toContain('5700');
      // 5900 at 2M is third wall
      expect(result).toContain('5900');
    });

    it('identifies acceleration zones (negative netGamma)', () => {
      const rows = buildStrikeRows();
      const result = formatStrikeExposuresForClaude(rows)!;

      expect(result).toContain('Acceleration Zones (negative gamma');
      // 5850 at -2M is the most negative
      expect(result).toContain('5850');
      // 5750 at -1.5M is second most negative
      expect(result).toContain('5750');
    });

    it('identifies charm pattern: CCS-CONFIRMING (positive below, negative above ATM)', () => {
      // buildStrikeRows produces positive charm below ATM, negative above → CCS
      const rows = buildStrikeRows();
      const result = formatStrikeExposuresForClaude(rows)!;

      expect(result).toContain('CCS-CONFIRMING');
    });

    it('identifies charm pattern: PCS-CONFIRMING (negative below, positive above)', () => {
      const rows = buildStrikeRows().map((r) => ({
        ...r,
        netCharm: r.strike < 5800 ? -50000 : r.strike > 5800 ? 70000 : 0,
      }));
      const result = formatStrikeExposuresForClaude(rows)!;

      expect(result).toContain('PCS-CONFIRMING');
    });

    it('identifies charm pattern: ALL-NEGATIVE', () => {
      const rows = buildStrikeRows().map((r) => ({
        ...r,
        netCharm: -40000,
      }));
      const result = formatStrikeExposuresForClaude(rows)!;

      expect(result).toContain('ALL-NEGATIVE');
    });

    it('identifies charm pattern: ALL-POSITIVE', () => {
      const rows = buildStrikeRows().map((r) => ({
        ...r,
        netCharm: 40000,
      }));
      const result = formatStrikeExposuresForClaude(rows)!;

      expect(result).toContain('ALL-POSITIVE');
    });

    it('identifies charm pattern: MIXED (when avgCharmBelow or avgCharmAbove is 0)', () => {
      // Set charm to zero for all strikes outside the ±10 ATM band
      // so that avg below and avg above are both 0
      const rows = buildStrikeRows().map((r) => ({
        ...r,
        netCharm: 0,
      }));
      const result = formatStrikeExposuresForClaude(rows)!;

      expect(result).toContain('MIXED');
    });

    it('shows charm floor and ceiling', () => {
      const rows = buildStrikeRows();
      const result = formatStrikeExposuresForClaude(rows)!;

      expect(result).toContain('Charm Floor:');
      expect(result).toContain('strongest time-based support');
      expect(result).toContain('Charm Ceiling:');
      expect(result).toContain('strongest time-based resistance');
    });

    it('shows strike table with ±100 pts from ATM and ATM marker', () => {
      const rows = buildStrikeRows();
      const result = formatStrikeExposuresForClaude(rows)!;

      expect(result).toContain('Per-Strike Profile (ATM ±100 pts)');
      expect(result).toContain('Strike | Net Gamma');

      // All strikes from 5700 to 5900 are within ±100 of 5800
      for (const s of [5700, 5750, 5790, 5795, 5800, 5805, 5810, 5850, 5900]) {
        expect(result).toContain(s.toString());
      }

      // ATM marker — strike 5800 is exactly ATM (|5800 - 5800| < 3)
      expect(result).toContain('← ATM');
    });

    it('excludes strikes outside ±100 from ATM in strike table', () => {
      const rows = [
        ...buildStrikeRows(),
        makeRow({ strike: 5600, price: 5800, netGamma: 100000 }),
        makeRow({ strike: 6000, price: 5800, netGamma: 100000 }),
      ];
      const result = formatStrikeExposuresForClaude(rows)!;

      // The table section should not include strikes > 100 pts away
      const tableSection = result.split('Per-Strike Profile')[1]!;
      expect(tableSection).not.toContain('5600');
      expect(tableSection).not.toContain('6000');
    });

    // ── fmtStrike (tested indirectly via output) ────────────────

    it('formats values in billions (B)', () => {
      const rows = [
        makeRow({
          strike: 5800,
          netGamma: 2_500_000_000,
          dirGamma: 0,
          netCharm: 0,
          dirCharm: 0,
        }),
      ];
      const result = formatStrikeExposuresForClaude(rows)!;

      expect(result).toContain('+2.5B');
    });

    it('formats values in millions (M)', () => {
      const rows = [
        makeRow({
          strike: 5800,
          netGamma: 3_700_000,
          dirGamma: 0,
          netCharm: 0,
          dirCharm: 0,
        }),
      ];
      const result = formatStrikeExposuresForClaude(rows)!;

      expect(result).toContain('+3.7M');
    });

    it('formats values in thousands (K)', () => {
      const rows = [
        makeRow({
          strike: 5800,
          netGamma: 45_000,
          dirGamma: 0,
          netCharm: 0,
          dirCharm: 0,
        }),
      ];
      const result = formatStrikeExposuresForClaude(rows)!;

      expect(result).toContain('+45.0K');
    });

    it('formats unit values (>= 1, < 1000)', () => {
      const rows = [
        makeRow({
          strike: 5800,
          netGamma: 750,
          dirGamma: 0,
          netCharm: 0,
          dirCharm: 0,
        }),
      ];
      const result = formatStrikeExposuresForClaude(rows)!;

      expect(result).toContain('+750');
    });

    it('formats decimal values (< 1)', () => {
      const rows = [
        makeRow({
          strike: 5800,
          netGamma: 0.42,
          dirGamma: 0,
          netCharm: 0,
          dirCharm: 0,
        }),
      ];
      const result = formatStrikeExposuresForClaude(rows)!;

      expect(result).toContain('+0.42');
    });

    it('formats negative values with minus sign', () => {
      const rows = [
        makeRow({
          strike: 5800,
          netGamma: -1_200_000,
          dirGamma: 0,
          netCharm: 0,
          dirCharm: 0,
        }),
      ];
      const result = formatStrikeExposuresForClaude(rows)!;

      expect(result).toContain('-1.2M');
    });

    it('formats zero as 0', () => {
      const rows = [
        makeRow({
          strike: 5800,
          netGamma: 0,
          dirGamma: 0,
          netCharm: 0,
          dirCharm: 0,
        }),
      ];
      const result = formatStrikeExposuresForClaude(rows)!;

      // The strike table should show "0" for the zero value
      expect(result).toMatch(/\b0\b/);
    });

    it('gamma wall location shows "pts below" or "pts above"', () => {
      const rows = [
        makeRow({
          strike: 5750,
          price: 5800,
          netGamma: 2_000_000,
          netCharm: 10000,
        }),
        makeRow({
          strike: 5850,
          price: 5800,
          netGamma: 1_500_000,
          netCharm: -10000,
        }),
      ];
      const result = formatStrikeExposuresForClaude(rows)!;

      expect(result).toContain('50 pts below');
      expect(result).toContain('50 pts above');
    });

    it('marks gamma walls with "strengthens" or "decays" based on charm sign', () => {
      const rows = [
        makeRow({
          strike: 5750,
          price: 5800,
          netGamma: 2_000_000,
          netCharm: 50000,
        }),
        makeRow({
          strike: 5850,
          price: 5800,
          netGamma: 1_000_000,
          netCharm: -30000,
        }),
      ];
      const result = formatStrikeExposuresForClaude(rows)!;

      expect(result).toContain('strengthens');
      expect(result).toContain('decays');
    });
  });

  // ================================================================
  // getAllExpiryStrikeExposures
  // ================================================================
  describe('getAllExpiryStrikeExposures', () => {
    it('returns empty array when no timestamp found', async () => {
      mockSql.mockResolvedValueOnce([{ latest_ts: null }]);

      const result = await getAllExpiryStrikeExposures('2026-03-24');

      expect(result).toEqual([]);
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('returns mapped rows with correct calculations when data exists', async () => {
      mockSql.mockResolvedValueOnce([{ latest_ts: '2026-03-24T15:00:00Z' }]);
      mockSql.mockResolvedValueOnce([makeDbRow()]);

      const result = await getAllExpiryStrikeExposures('2026-03-24');

      expect(result).toHaveLength(1);
      const row = result[0]!;
      expect(row.netGamma).toBe(600000 + 400000);
      expect(row.netCharm).toBe(30000 + 20000);
      expect(row.netDelta).toBe(120000 + 80000);
      expect(row.dirGamma).toBe(200000 + 150000 + 100000 + 50000);
      expect(row.dirCharm).toBe(10000 + 8000 + 6000 + 4000);
      expect(row.strike).toBe(5800);
      expect(row.price).toBe(5800);
      expect(mockSql).toHaveBeenCalledTimes(2);
    });

    it('uses default ticker SPX', async () => {
      mockSql.mockResolvedValueOnce([{ latest_ts: null }]);

      await getAllExpiryStrikeExposures('2026-03-24');

      const callArgs = mockSql.mock.calls[0]!;
      expect(callArgs[1]).toBe('2026-03-24');
      expect(callArgs[2]).toBe('SPX');
    });

    it('passes custom ticker when specified', async () => {
      mockSql.mockResolvedValueOnce([{ latest_ts: null }]);

      await getAllExpiryStrikeExposures('2026-03-24', 'QQQ');

      const callArgs = mockSql.mock.calls[0]!;
      expect(callArgs[2]).toBe('QQQ');
    });

    it('filters by the 1970-01-01 sentinel expiry', async () => {
      mockSql.mockResolvedValueOnce([{ latest_ts: '2026-03-24T15:00:00Z' }]);
      mockSql.mockResolvedValueOnce([]);

      await getAllExpiryStrikeExposures('2026-03-24');

      // Both queries should include the sentinel value as a parameter
      const firstCallArgs = mockSql.mock.calls[0]!;
      expect(firstCallArgs[3]).toBe('1970-01-01');
      const secondCallArgs = mockSql.mock.calls[1]!;
      expect(secondCallArgs).toEqual(
        expect.arrayContaining([expect.stringContaining('1970-01-01')]),
      );
    });

    it('handles null DB values gracefully', async () => {
      mockSql.mockResolvedValueOnce([{ latest_ts: '2026-03-24T15:00:00Z' }]);
      mockSql.mockResolvedValueOnce([
        makeDbRow({
          call_gamma_oi: null,
          put_gamma_oi: null,
          call_charm_oi: null,
          put_charm_oi: null,
          call_delta_oi: null,
          put_delta_oi: null,
          call_gamma_ask: null,
          call_gamma_bid: null,
          put_gamma_ask: null,
          put_gamma_bid: null,
          call_charm_ask: null,
          call_charm_bid: null,
          put_charm_ask: null,
          put_charm_bid: null,
        }),
      ]);

      const result = await getAllExpiryStrikeExposures('2026-03-24');
      const row = result[0]!;

      expect(row.netGamma).toBe(0);
      expect(row.netCharm).toBe(0);
      expect(row.netDelta).toBe(0);
      expect(row.dirGamma).toBe(0);
      expect(row.dirCharm).toBe(0);
    });
  });

  // ================================================================
  // formatAllExpiryStrikesForClaude
  // ================================================================
  describe('formatAllExpiryStrikesForClaude', () => {
    it('returns null for empty array', () => {
      expect(formatAllExpiryStrikesForClaude([])).toBeNull();
    });

    it('returns header with ATM price and all-expiry label', () => {
      const rows = [makeRow()];
      const result = formatAllExpiryStrikesForClaude(rows)!;

      expect(result).toContain('SPX All-Expiry Per-Strike Profile');
      expect(result).toContain('ATM: 5800');
      expect(result).toContain('ALL expirations');
      expect(result).toMatch(/\d{2}:\d{2}\s*(AM|PM)\s*ET/i);
    });

    it('identifies multi-day gamma anchors (positive gamma walls)', () => {
      const rows = buildStrikeRows();
      const result = formatAllExpiryStrikesForClaude(rows)!;

      expect(result).toContain('Multi-Day Gamma Anchors');
      expect(result).toContain('5800');
      expect(result).toContain('5700');
    });

    it('shows "pts below" and "pts above" for wall locations', () => {
      const rows = [
        makeRow({
          strike: 5750,
          price: 5800,
          netGamma: 2_000_000,
          netCharm: 10000,
        }),
        makeRow({
          strike: 5850,
          price: 5800,
          netGamma: 1_500_000,
          netCharm: -10000,
        }),
      ];
      const result = formatAllExpiryStrikesForClaude(rows)!;

      expect(result).toContain('50 pts below');
      expect(result).toContain('50 pts above');
    });

    it('marks walls with "strengthens" or "decays" based on charm sign', () => {
      const rows = [
        makeRow({
          strike: 5750,
          price: 5800,
          netGamma: 2_000_000,
          netCharm: 50000,
        }),
        makeRow({
          strike: 5850,
          price: 5800,
          netGamma: 1_000_000,
          netCharm: -30000,
        }),
      ];
      const result = formatAllExpiryStrikesForClaude(rows)!;

      expect(result).toContain('strengthens');
      expect(result).toContain('decays');
    });

    it('identifies all-expiry acceleration zones (negative gamma)', () => {
      const rows = buildStrikeRows();
      const result = formatAllExpiryStrikesForClaude(rows)!;

      expect(result).toContain('All-Expiry Acceleration Zones');
      expect(result).toContain('5850');
      expect(result).toContain('5750');
    });

    // ── 0DTE vs All-Expiry comparison ──────────────────────────

    it('shows comparison section when zeroDteRows provided', () => {
      const allRows = buildStrikeRows();
      const zeroDteRows = buildStrikeRows();
      const result = formatAllExpiryStrikesForClaude(allRows, zeroDteRows)!;

      expect(result).toContain('0DTE vs All-Expiry Comparison');
    });

    it('shows "no major sign divergences" when 0DTE and all-expiry agree', () => {
      const allRows = buildStrikeRows();
      // Same sign gamma for all strikes → no divergence
      const zeroDteRows = buildStrikeRows();
      const result = formatAllExpiryStrikesForClaude(allRows, zeroDteRows)!;

      expect(result).toContain('No major sign divergences');
      expect(result).toContain('gamma structure is consistent');
    });

    it('detects divergence: 0DTE wall but all-expiry danger zone', () => {
      const allRows = [
        makeRow({ strike: 5800, price: 5800, netGamma: -2_000_000 }),
      ];
      const zeroDteRows = [
        makeRow({ strike: 5800, price: 5800, netGamma: 3_000_000 }),
      ];
      const result = formatAllExpiryStrikesForClaude(allRows, zeroDteRows)!;

      expect(result).toContain('0DTE wall but all-expiry danger zone');
      expect(result).toContain('wall may fail');
    });

    it('detects divergence: 0DTE danger zone but all-expiry wall', () => {
      const allRows = [
        makeRow({ strike: 5800, price: 5800, netGamma: 2_000_000 }),
      ];
      const zeroDteRows = [
        makeRow({ strike: 5800, price: 5800, netGamma: -1_500_000 }),
      ];
      const result = formatAllExpiryStrikesForClaude(allRows, zeroDteRows)!;

      expect(result).toContain('0DTE danger zone but all-expiry wall');
      expect(result).toContain('backstop');
    });

    it('limits divergences to 5 entries', () => {
      // Create 7 strikes that all diverge
      const strikes = [5770, 5780, 5790, 5800, 5810, 5820, 5830];
      const allRows = strikes.map((s) =>
        makeRow({ strike: s, price: 5800, netGamma: -500_000 }),
      );
      const zeroDteRows = strikes.map((s) =>
        makeRow({ strike: s, price: 5800, netGamma: 500_000 }),
      );
      const result = formatAllExpiryStrikesForClaude(allRows, zeroDteRows)!;

      const divergenceLines = result
        .split('\n')
        .filter((l) => l.includes('0DTE wall but'));
      expect(divergenceLines.length).toBeLessThanOrEqual(5);
    });

    it('skips comparison for strikes not present in both datasets', () => {
      const allRows = [
        makeRow({ strike: 5800, price: 5800, netGamma: -1_000_000 }),
      ];
      // zeroDteRows has a different strike — no overlap
      const zeroDteRows = [
        makeRow({ strike: 5900, price: 5800, netGamma: 1_000_000 }),
      ];
      const result = formatAllExpiryStrikesForClaude(allRows, zeroDteRows)!;

      // No overlapping strikes → no divergences found → consistent message
      expect(result).toContain('No major sign divergences');
    });

    it('omits comparison section when zeroDteRows is undefined', () => {
      const allRows = buildStrikeRows();
      const result = formatAllExpiryStrikesForClaude(allRows)!;

      expect(result).not.toContain('0DTE vs All-Expiry Comparison');
    });

    it('omits comparison section when zeroDteRows is empty', () => {
      const allRows = buildStrikeRows();
      const result = formatAllExpiryStrikesForClaude(allRows, [])!;

      expect(result).not.toContain('0DTE vs All-Expiry Comparison');
    });
  });

  // ================================================================
  // formatGreekFlowForClaude
  // ================================================================
  describe('formatGreekFlowForClaude', () => {
    function makeFlowRow(overrides: Partial<FlowDataRow> = {}): FlowDataRow {
      return {
        timestamp: '2026-03-24T15:00:00Z',
        ncp: 500000,
        npp: 300000,
        netVolume: 120000,
        // OTM fields default to null (non-greek-flow rows don't have them).
        // Specific OTM tests override these via the overrides arg.
        otmNcp: null,
        otmNpp: null,
        ...overrides,
      };
    }

    it('returns null for empty array', () => {
      expect(formatGreekFlowForClaude([])).toBeNull();
    });

    it('returns header with "0DTE SPX Delta Flow" label', () => {
      const result = formatGreekFlowForClaude([makeFlowRow()])!;

      expect(result).toContain('0DTE SPX Delta Flow');
    });

    it('shows latest values (Total Delta Flow, Directionalized Delta Flow, Volume)', () => {
      const result = formatGreekFlowForClaude([makeFlowRow()])!;

      expect(result).toContain('Total Delta Flow:');
      expect(result).toContain('Directionalized Delta Flow:');
      expect(result).toContain('Volume: 120,000');
    });

    it('shows direction: rising/falling/flat for total delta and dir delta', () => {
      const rows = [
        makeFlowRow({
          timestamp: '2026-03-24T14:00:00Z',
          ncp: 100000,
          npp: 400000,
        }),
        makeFlowRow({
          timestamp: '2026-03-24T15:00:00Z',
          ncp: 500000,
          npp: 200000,
        }),
      ];
      const result = formatGreekFlowForClaude(rows)!;

      expect(result).toContain('rising (bullish delta accumulation)');
      expect(result).toContain('falling (intent-weighted bearish)');
    });

    it('shows direction: flat when latest equals first', () => {
      const rows = [
        makeFlowRow({
          timestamp: '2026-03-24T14:00:00Z',
          ncp: 500000,
          npp: 300000,
        }),
        makeFlowRow({
          timestamp: '2026-03-24T15:00:00Z',
          ncp: 500000,
          npp: 300000,
        }),
      ];
      const result = formatGreekFlowForClaude(rows)!;

      expect(result).toContain('Direction: Total delta flat');
      expect(result).toContain('Dir delta: flat');
    });

    it('detects DIVERGENCE: Total delta positive but directionalized negative', () => {
      const rows = [makeFlowRow({ ncp: 500000, npp: -200000 })];
      const result = formatGreekFlowForClaude(rows)!;

      expect(result).toContain(
        'DIVERGENCE: Total delta positive but directionalized negative',
      );
    });

    it('detects DIVERGENCE: Total delta negative but directionalized positive', () => {
      const rows = [makeFlowRow({ ncp: -500000, npp: 200000 })];
      const result = formatGreekFlowForClaude(rows)!;

      expect(result).toContain(
        'DIVERGENCE: Total delta negative but directionalized positive',
      );
    });

    it('no divergence line when signs agree', () => {
      const rows = [makeFlowRow({ ncp: 500000, npp: 300000 })];
      const result = formatGreekFlowForClaude(rows)!;

      expect(result).not.toContain('DIVERGENCE');
    });

    it('shows recent history section when rows.length > 1', () => {
      const rows = [
        makeFlowRow({ timestamp: '2026-03-24T14:00:00Z' }),
        makeFlowRow({ timestamp: '2026-03-24T15:00:00Z' }),
      ];
      const result = formatGreekFlowForClaude(rows)!;

      expect(result).toContain('Recent History (5-min intervals)');
    });

    it('omits recent history when only 1 row', () => {
      const result = formatGreekFlowForClaude([makeFlowRow()])!;

      expect(result).not.toContain('Recent History');
    });

    it('shows at most 6 recent rows in history', () => {
      const rows = Array.from({ length: 10 }, (_, i) =>
        makeFlowRow({
          timestamp: `2026-03-24T14:${String(i * 5).padStart(2, '0')}:00Z`,
        }),
      );
      const result = formatGreekFlowForClaude(rows)!;

      const historySection = result.split(
        'Recent History (5-min intervals):',
      )[1]!;
      const historyLines = historySection
        .split('\n')
        .filter((l) => l.includes('ET —'));
      expect(historyLines).toHaveLength(6);
    });

    it('handles null netVolume (shows N/A)', () => {
      const result = formatGreekFlowForClaude([
        makeFlowRow({ netVolume: null }),
      ])!;

      expect(result).toContain('Volume: N/A');
    });

    it('formatDeltaVal formats millions (output contains "+X.XM")', () => {
      const result = formatGreekFlowForClaude([
        makeFlowRow({ ncp: 2_500_000 }),
      ])!;

      expect(result).toContain('+2.5M');
    });

    it('formatDeltaVal formats thousands (output contains "+X.XK")', () => {
      const result = formatGreekFlowForClaude([makeFlowRow({ ncp: 45_000 })])!;

      expect(result).toContain('+45.0K');
    });

    it('formatDeltaVal formats zero as "0"', () => {
      const result = formatGreekFlowForClaude([
        makeFlowRow({ ncp: 0, npp: 0 }),
      ])!;

      expect(result).toMatch(/Total Delta Flow: 0/);
    });

    it('formatDeltaVal formats small values', () => {
      const result = formatGreekFlowForClaude([makeFlowRow({ ncp: 750 })])!;

      expect(result).toContain('+750');
    });

    it('formatDeltaVal formats negative values', () => {
      const result = formatGreekFlowForClaude([
        makeFlowRow({ ncp: -1_200_000 }),
      ])!;

      expect(result).toContain('-1.2M');
    });

    // ── OTM display + divergence (ENH-FIX-001) ─────────────────

    it('omits OTM lines when otmNcp is null (backward compatibility)', () => {
      const result = formatGreekFlowForClaude([
        makeFlowRow({ ncp: 1_000_000, npp: 500_000 }),
      ])!;

      expect(result).not.toContain('OTM Total Delta Flow');
      expect(result).not.toContain('OTM Directionalized Delta Flow');
      expect(result).not.toContain('OTM DIVERGENCE');
      expect(result).not.toContain('OTM-DOMINANT');
      expect(result).not.toContain('ATM-DOMINANT');
    });

    it('shows OTM values in Latest block when present', () => {
      const result = formatGreekFlowForClaude([
        makeFlowRow({
          ncp: 5_000_000,
          npp: -3_000_000,
          otmNcp: 2_500_000,
          otmNpp: -1_800_000,
        }),
      ])!;

      expect(result).toContain('OTM Total Delta Flow: +2.5M');
      expect(result).toContain('OTM Directionalized Delta Flow: -1.8M');
    });

    it('flags OTM DIVERGENCE when total is positive but OTM is negative', () => {
      const result = formatGreekFlowForClaude([
        makeFlowRow({
          ncp: 5_000_000, // total bullish
          npp: 4_000_000,
          otmNcp: -2_000_000, // but OTM bearish
          otmNpp: -1_500_000,
        }),
      ])!;

      expect(result).toContain('OTM DIVERGENCE');
      expect(result).toContain('Trust OTM for directional conviction');
    });

    it('flags OTM DIVERGENCE when total is negative but OTM is positive', () => {
      const result = formatGreekFlowForClaude([
        makeFlowRow({
          ncp: -5_000_000, // total bearish
          npp: -4_000_000,
          otmNcp: 2_000_000, // but OTM bullish
          otmNpp: 1_500_000,
        }),
      ])!;

      expect(result).toContain('OTM DIVERGENCE');
    });

    it('flags OTM-DOMINANT when OTM share exceeds 70% (same-direction conviction)', () => {
      const result = formatGreekFlowForClaude([
        makeFlowRow({
          ncp: 1_000_000,
          npp: 800_000,
          otmNcp: 800_000, // 80% of total
          otmNpp: 650_000,
        }),
      ])!;

      expect(result).toContain('OTM-DOMINANT');
      expect(result).not.toContain('OTM DIVERGENCE');
      expect(result).not.toContain('ATM-DOMINANT');
    });

    it('flags ATM-DOMINANT when OTM share is below 30% (hedging dilution)', () => {
      const result = formatGreekFlowForClaude([
        makeFlowRow({
          ncp: 1_000_000,
          npp: 800_000,
          otmNcp: 200_000, // 20% of total
          otmNpp: 150_000,
        }),
      ])!;

      expect(result).toContain('ATM-DOMINANT');
      expect(result).not.toContain('OTM-DOMINANT');
      expect(result).not.toContain('OTM DIVERGENCE');
    });

    it('emits neither dominance label when OTM share is between 30% and 70%', () => {
      const result = formatGreekFlowForClaude([
        makeFlowRow({
          ncp: 1_000_000,
          npp: 800_000,
          otmNcp: 500_000, // 50% of total
          otmNpp: 400_000,
        }),
      ])!;

      expect(result).not.toContain('OTM-DOMINANT');
      expect(result).not.toContain('ATM-DOMINANT');
      expect(result).not.toContain('OTM DIVERGENCE');
    });

    it('flags OTM EXCEEDS TOTAL when total ncp is zero but OTM has magnitude', () => {
      // Pure cancellation case: ATM hedging exactly offsets OTM directional.
      // The aggregate looks like "nothing happening" but OTM carries the signal.
      const result = formatGreekFlowForClaude([
        makeFlowRow({
          ncp: 0,
          npp: 0,
          otmNcp: 500_000,
          otmNpp: 300_000,
        }),
      ])!;

      expect(result).toContain('OTM EXCEEDS TOTAL');
      expect(result).not.toContain('OTM-DOMINANT');
      expect(result).not.toContain('ATM-DOMINANT');
    });

    it('flags OTM EXCEEDS TOTAL when |otmNcp| > |ncp| with same sign (ATM cancellation)', () => {
      // ATM hedging is partially offsetting OTM conviction. A naive
      // "OTM share" ratio would report >70% (e.g., 300%) which is
      // factually wrong. The OTM EXCEEDS TOTAL branch catches this.
      // Reproducer for the bug the code-reviewer flagged.
      const result = formatGreekFlowForClaude([
        makeFlowRow({
          ncp: 1_000_000, // total bullish but small
          npp: 800_000,
          otmNcp: 3_000_000, // OTM bullish and 3x bigger — ATM contributed -2M
          otmNpp: 2_500_000,
        }),
      ])!;

      expect(result).toContain('OTM EXCEEDS TOTAL');
      // Must NOT emit the misleading "Over 70%" label for this case.
      expect(result).not.toContain('OTM-DOMINANT');
      expect(result).not.toContain('ATM-DOMINANT');
      expect(result).not.toContain('OTM DIVERGENCE');
    });

    it('flags OTM EXCEEDS TOTAL for bearish cancellation (|otmNcp| > |ncp|, both negative)', () => {
      const result = formatGreekFlowForClaude([
        makeFlowRow({
          ncp: -1_000_000,
          npp: -800_000,
          otmNcp: -3_000_000, // OTM bearish and bigger — ATM contributed +2M
          otmNpp: -2_500_000,
        }),
      ])!;

      expect(result).toContain('OTM EXCEEDS TOTAL');
      expect(result).not.toContain('OTM-DOMINANT');
      expect(result).not.toContain('OTM DIVERGENCE');
    });

    it('emits no labels when both total and OTM are below the noise floor', () => {
      // Both values under NEAR_ZERO_DELTA ($100K) — nothing meaningful
      // happening, the whole interpretation block should be skipped.
      const result = formatGreekFlowForClaude([
        makeFlowRow({
          ncp: 50_000,
          npp: 30_000,
          otmNcp: 20_000,
          otmNpp: 10_000,
        }),
      ])!;

      expect(result).not.toContain('OTM-DOMINANT');
      expect(result).not.toContain('ATM-DOMINANT');
      expect(result).not.toContain('OTM DIVERGENCE');
      expect(result).not.toContain('OTM EXCEEDS TOTAL');
    });

    it('includes OTM segment in time series rows when otmNcp is present', () => {
      const result = formatGreekFlowForClaude([
        makeFlowRow({
          timestamp: '2026-03-24T14:30:00Z',
          ncp: 1_000_000,
          otmNcp: 600_000,
        }),
        makeFlowRow({
          timestamp: '2026-03-24T14:35:00Z',
          ncp: 1_500_000,
          otmNcp: 900_000,
        }),
      ])!;

      // Time series rows should include the OTM segment
      expect(result).toMatch(/OTM Δ: \+[0-9.]+[KM]/);
    });
  });
});
