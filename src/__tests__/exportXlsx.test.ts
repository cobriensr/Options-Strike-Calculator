import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as XLSX from 'xlsx';
import { exportPnLComparison } from '../utils/exportXlsx';
import { calcAllDeltas, calcTimeToExpiry } from '../utils/calculator';
import type { CalculationResults } from '../types';

// Mock XLSX.writeFile to capture the workbook instead of writing to disk
vi.mock('xlsx', async () => {
  const actual = await vi.importActual<typeof XLSX>('xlsx');
  return {
    ...actual,
    writeFile: vi.fn(),
  };
});

function makeResults(
  spot = 6850,
  sigma = 0.2,
  hoursRemaining = 4,
): CalculationResults {
  const T = calcTimeToExpiry(hoursRemaining);
  const allDeltas = calcAllDeltas(spot, sigma, T, 0.03, 10);
  return { allDeltas, sigma, T, hoursRemaining, spot };
}

function getWorkbook(): XLSX.WorkBook {
  const calls = (XLSX.writeFile as ReturnType<typeof vi.fn>).mock.calls;
  return calls.at(-1)![0];
}

function getSheet(wb: XLSX.WorkBook, name: string): XLSX.WorkSheet {
  const sheet = wb.Sheets[name];
  if (!sheet) throw new Error(`Sheet "${name}" not found`);
  return sheet;
}

describe('exportPnLComparison', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls XLSX.writeFile', async () => {
    await exportPnLComparison({
      results: makeResults(),
      contracts: 1,
      effectiveRatio: 10,
      skewPct: 3,
    });
    expect(XLSX.writeFile).toHaveBeenCalledTimes(1);
  });

  it('generates filename with timestamp', async () => {
    await exportPnLComparison({
      results: makeResults(),
      contracts: 1,
      effectiveRatio: 10,
      skewPct: 3,
    });
    const filename = (XLSX.writeFile as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as string;
    expect(filename).toMatch(/^strike-calc-pnl-\d{4}-\d{2}-\d{2}_\d{4}\.xlsx$/);
  });

  it('creates 3 sheets', async () => {
    await exportPnLComparison({
      results: makeResults(),
      contracts: 1,
      effectiveRatio: 10,
      skewPct: 3,
    });
    const wb = getWorkbook();
    expect(wb.SheetNames).toHaveLength(3);
    expect(wb.SheetNames).toEqual(['P&L Comparison', 'IC Summary', 'Inputs']);
  });

  describe('Sheet 1: P&L Comparison', () => {
    it('has correct header row', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 5,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'P&L Comparison');
      const data: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      const headers = data[0];
      expect(headers).toContain('Delta');
      expect(headers).toContain('Wing Width');
      expect(headers).toContain('Side');
      expect(headers).toContain('Credit (pts)');
      expect(headers).toContain('Credit ($)');
      expect(headers).toContain('Max Loss (pts)');
      expect(headers).toContain('Max Loss ($)');
      expect(headers).toContain('Buying Power ($)');
      expect(headers).toContain('RoR (%)');
      expect(headers).toContain('PoP (%)');
      expect(headers).toContain('Wins to Recover');
      expect(headers).toContain('Monthly Net ($)');
    });

    it('has 126 data rows (7 wing widths × 6 deltas × 3 sides)', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 1,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'P&L Comparison');
      const data: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      // 1 header + 126 data rows
      expect(data.length).toBe(127);
    });

    it('contains all three side types', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 1,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'P&L Comparison');
      const data: any[] = XLSX.utils.sheet_to_json(sheet);
      const sides = [...new Set(data.map((r) => r['Side']))];
      expect(sides).toContain('Put Spread');
      expect(sides).toContain('Call Spread');
      expect(sides).toContain('Iron Condor');
    });

    it('contains all wing widths', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 1,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'P&L Comparison');
      const data: any[] = XLSX.utils.sheet_to_json(sheet);
      const widths = [...new Set(data.map((r) => r['Wing Width']))].sort(
        (a, b) => Number(a) - Number(b),
      );
      expect(widths).toEqual([5, 10, 15, 20, 25, 30, 50]);
    });

    it('contains all 6 deltas', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 1,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'P&L Comparison');
      const data: any[] = XLSX.utils.sheet_to_json(sheet);
      const deltas = [...new Set(data.map((r) => r['Delta']))];
      expect(deltas).toContain('5Δ');
      expect(deltas).toContain('8Δ');
      expect(deltas).toContain('10Δ');
      expect(deltas).toContain('12Δ');
      expect(deltas).toContain('15Δ');
      expect(deltas).toContain('20Δ');
    });

    it('credits are positive', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 10,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'P&L Comparison');
      const data: any[] = XLSX.utils.sheet_to_json(sheet);
      for (const row of data) {
        expect(row['Credit ($)']).toBeGreaterThan(0);
        expect(row['Credit (pts)']).toBeGreaterThan(0);
      }
    });

    it('max loss is positive and less than wing width × multiplier × contracts', async () => {
      const contracts = 5;
      await exportPnLComparison({
        results: makeResults(),
        contracts,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'P&L Comparison');
      const data: any[] = XLSX.utils.sheet_to_json(sheet);
      for (const row of data) {
        expect(row['Max Loss ($)']).toBeGreaterThan(0);
        const maxPossible = row['Wing Width'] * 100 * contracts;
        expect(row['Max Loss ($)']).toBeLessThan(maxPossible);
      }
    });

    it('buying power equals max loss', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 10,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'P&L Comparison');
      const data: any[] = XLSX.utils.sheet_to_json(sheet);
      for (const row of data) {
        expect(row['Buying Power ($)']).toBe(row['Max Loss ($)']);
      }
    });

    it('wins to recover is positive', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 1,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'P&L Comparison');
      const data: any[] = XLSX.utils.sheet_to_json(sheet);
      for (const row of data) {
        expect(row['Wins to Recover']).toBeGreaterThan(0);
      }
    });

    it('dollar values scale with contracts', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 1,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb1 = getWorkbook();
      const data1: any[] = XLSX.utils.sheet_to_json(
        getSheet(wb1, 'P&L Comparison'),
      );

      await exportPnLComparison({
        results: makeResults(),
        contracts: 10,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb10 = getWorkbook();
      const data10: any[] = XLSX.utils.sheet_to_json(
        getSheet(wb10, 'P&L Comparison'),
      );

      // First row credit should be 10× for 10 contracts
      expect(data10[0]['Credit ($)']).toBeCloseTo(
        data1[0]['Credit ($)'] * 10,
        0,
      );
    });

    it('PoP is between 0 and 100', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 1,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'P&L Comparison');
      const data: any[] = XLSX.utils.sheet_to_json(sheet);
      for (const row of data) {
        expect(row['PoP (%)']).toBeGreaterThan(0);
        expect(row['PoP (%)']).toBeLessThan(100);
      }
    });

    it('RoR is between 0 and 100', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 1,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'P&L Comparison');
      const data: any[] = XLSX.utils.sheet_to_json(sheet);
      for (const row of data) {
        expect(row['RoR (%)']).toBeGreaterThan(0);
        expect(row['RoR (%)']).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('Sheet 2: IC Summary', () => {
    it('has 42 rows (7 wing widths × 6 deltas)', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 1,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'IC Summary');
      const data: any[] = XLSX.utils.sheet_to_json(sheet);
      expect(data.length).toBe(42);
    });

    it('has per-side credit columns', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 5,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'IC Summary');
      const data: any[] = XLSX.utils.sheet_to_json(sheet);
      for (const row of data) {
        expect(row['Put Credit ($)']).toBeGreaterThan(0);
        expect(row['Call Credit ($)']).toBeGreaterThan(0);
      }
    });

    it('put credit + call credit ≈ total credit', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 5,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'IC Summary');
      const data: any[] = XLSX.utils.sheet_to_json(sheet);
      for (const row of data) {
        expect(row['Put Credit ($)'] + row['Call Credit ($)']).toBeCloseTo(
          row['Credit ($)'],
          0,
        );
      }
    });

    it('has wins to recover column', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 1,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'IC Summary');
      const data: any[] = XLSX.utils.sheet_to_json(sheet);
      for (const row of data) {
        expect(row['Wins to Recover']).toBeGreaterThan(0);
      }
    });

    it('has monthly projection columns', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 1,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'IC Summary');
      const headers = XLSX.utils.sheet_to_json<string[]>(sheet, {
        header: 1,
      })[0];
      expect(headers).toContain('Monthly Wins');
      expect(headers).toContain('Monthly Losses');
      expect(headers).toContain('Monthly Profit ($)');
      expect(headers).toContain('Monthly Loss ($)');
      expect(headers).toContain('Monthly Net ($)');
    });

    it('monthly wins + monthly losses ≈ 22', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 1,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'IC Summary');
      const data: any[] = XLSX.utils.sheet_to_json(sheet);
      for (const row of data) {
        expect(row['Monthly Wins'] + row['Monthly Losses']).toBeCloseTo(22, 0);
      }
    });

    it('has strike columns', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 1,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'IC Summary');
      const data: any[] = XLSX.utils.sheet_to_json(sheet);
      for (const row of data) {
        expect(row['Short Put']).toBeGreaterThan(0);
        expect(row['Short Call']).toBeGreaterThan(0);
        expect(row['Short Put']).toBeLessThan(row['Short Call']);
      }
    });
  });

  describe('Sheet 3: Inputs', () => {
    it('captures SPY spot', async () => {
      await exportPnLComparison({
        results: makeResults(6850),
        contracts: 5,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'Inputs');
      const data: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      const flat = data.map((r) => r.join(' '));
      expect(flat.some((s) => s.includes('685'))).toBe(true); // 6850/10 = 685
    });

    it('captures contracts count', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 25,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'Inputs');
      const data: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      const flat = data.map((r) => r.join(' '));
      expect(flat.some((s) => s.includes('25'))).toBe(true);
    });

    it('captures skew percentage', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 1,
        effectiveRatio: 10,
        skewPct: 5,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'Inputs');
      const data: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      const flat = data.map((r) => r.join(' '));
      expect(flat.some((s) => s.includes('5%'))).toBe(true);
    });

    it('includes methodology notes', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 1,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'Inputs');
      const data: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      const flat = data.map((r) => r.join(' '));
      expect(flat.some((s) => s.includes('Black-Scholes'))).toBe(true);
      expect(flat.some((s) => s.includes('Wins to Recover'))).toBe(true);
      expect(flat.some((s) => s.includes('trade management'))).toBe(true);
    });

    it('lists all wing widths compared', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 1,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();
      const sheet = getSheet(wb, 'Inputs');
      const data: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      const flat = data.map((r) => r.join(' '));
      expect(flat.some((s) => s.includes('5, 10, 15, 20, 25, 30, 50'))).toBe(
        true,
      );
    });
  });

  describe('edge cases', () => {
    it('wins to recover is 0 when credit is zero', async () => {
      const calculator = await import('../utils/calculator');
      const mockIc = {
        delta: 5 as const,
        shortPut: 6800,
        longPut: 6795,
        shortCall: 6900,
        longCall: 6905,
        shortPutSpy: 680,
        longPutSpy: 679.5,
        shortCallSpy: 690,
        longCallSpy: 690.5,
        wingWidthSpx: 5,
        shortPutPremium: 0,
        longPutPremium: 0,
        shortCallPremium: 0,
        longCallPremium: 0,
        creditReceived: 0,
        maxProfit: 0,
        maxLoss: 5,
        breakEvenLow: 6800,
        breakEvenHigh: 6900,
        returnOnRisk: 0,
        probabilityOfProfit: 0.5,
        putSpreadCredit: 0,
        callSpreadCredit: 0,
        putSpreadMaxLoss: 5,
        callSpreadMaxLoss: 5,
        putSpreadBE: 6800,
        callSpreadBE: 6900,
        putSpreadRoR: 0,
        callSpreadRoR: 0,
        putSpreadPoP: 0.7,
        callSpreadPoP: 0.7,
      };

      vi.spyOn(calculator, 'buildIronCondor').mockReturnValue(mockIc);

      await exportPnLComparison({
        results: makeResults(),
        contracts: 1,
        effectiveRatio: 10,
        skewPct: 3,
      });
      const wb = getWorkbook();

      // Sheet 1 - addRow branch: credit <= 0 → winsToRecover = 0
      const summaryData: any[] = XLSX.utils.sheet_to_json(
        getSheet(wb, 'P&L Comparison'),
      );
      for (const row of summaryData) {
        expect(row['Wins to Recover']).toBe(0);
      }

      // Sheet 2 - IC summary branch: creditReceived <= 0 → winsToRecover = 0
      const icData: any[] = XLSX.utils.sheet_to_json(
        getSheet(wb, 'IC Summary'),
      );
      for (const row of icData) {
        expect(row['Wins to Recover']).toBe(0);
      }

      vi.mocked(calculator.buildIronCondor).mockRestore();
    });

    it('works with 1 contract', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 1,
        effectiveRatio: 10,
        skewPct: 3,
      });
    });

    it('works with large contract count', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 500,
        effectiveRatio: 10,
        skewPct: 3,
      });
    });

    it('works with zero skew', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 10,
        effectiveRatio: 10,
        skewPct: 0,
      });
    });

    it('works with non-default ratio', async () => {
      await exportPnLComparison({
        results: makeResults(),
        contracts: 10,
        effectiveRatio: 10.0238,
        skewPct: 3,
      });
    });

    it('works with different time inputs', async () => {
      await exportPnLComparison({
        results: makeResults(6850, 0.2, 1),
        contracts: 10,
        effectiveRatio: 10,
        skewPct: 3,
      });
      await exportPnLComparison({
        results: makeResults(6850, 0.2, 6),
        contracts: 10,
        effectiveRatio: 10,
        skewPct: 3,
      });
    });
  });
});
