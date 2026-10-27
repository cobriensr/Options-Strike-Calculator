import { describe, it, expect, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { exportBWBComparison } from '../../utils/export';
import { calcAllDeltas, calcTimeToExpiry } from '../../utils/calculator';

vi.mock('xlsx', async () => {
  const actual = await vi.importActual<typeof XLSX>('xlsx');
  return { ...actual, writeFile: vi.fn() };
});

// Pin every BWB's log-normal PoP to a rounding boundary: 22 × 1.5/220 =
// 0.15 days of wins and 21.85 of losses. Rounding each to 0.1 separately
// gives 0.2 + 21.9 = 22.1 days.
vi.mock('../../utils/bwb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/bwb')>();
  const pin = <T extends object>(bwb: T): T => ({
    ...bwb,
    probabilityOfProfit: 1.5 / 220,
  });
  return {
    ...actual,
    buildPutBWB: (...args: Parameters<typeof actual.buildPutBWB>) =>
      pin(actual.buildPutBWB(...args)),
    buildCallBWB: (...args: Parameters<typeof actual.buildCallBWB>) =>
      pin(actual.buildCallBWB(...args)),
  };
});

describe('exportBWBComparison monthly day counts', () => {
  it('Monthly Wins + Losses is exactly 22 days even when the PoP sits on a rounding boundary', async () => {
    const T = calcTimeToExpiry(5);
    await exportBWBComparison({
      results: {
        allDeltas: calcAllDeltas(5800, 0.18, T, 0.03, 10),
        sigma: 0.18,
        T,
        hoursRemaining: 5,
        spot: 5800,
        marketHours: 6.5,
      },
      contracts: 1,
      effectiveRatio: 10,
    });
    const wb = vi.mocked(XLSX.writeFile).mock.calls.at(-1)![0];
    const rows: Record<string, number>[] = XLSX.utils.sheet_to_json(
      wb.Sheets['BWB Comparison']!,
    );
    expect(rows).toHaveLength(240);
    for (const r of rows) {
      expect(r['Monthly Wins (log-normal)']).toBe(0.2);
      expect(
        r['Monthly Wins (log-normal)']! + r['Monthly Losses (log-normal)']!,
      ).toBeCloseTo(22, 9);
    }
  });
});
