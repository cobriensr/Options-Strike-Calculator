import * as XLSX from 'xlsx';
import type { DeltaRow, CalculationResults } from './types';
import { buildIronCondor } from './calculator';

const ALL_WING_WIDTHS = [5, 10, 15, 20, 25, 30, 50];

interface ExportParams {
  results: CalculationResults;
  contracts: number;
  effectiveRatio: number;
  skewPct: number;
}

/**
 * Generates and downloads an XLSX file comparing P&L across all wing widths.
 *
 * Sheet 1: "Summary" — one row per delta × wing width combo
 * Sheet 2: "Iron Condor Legs" — all legs for each combo
 * Sheet 3: "Inputs" — captures the inputs used for the export
 */
export function exportPnLComparison({ results, contracts, effectiveRatio, skewPct }: ExportParams): void {
  const wb = XLSX.utils.book_new();
  const mult = 100 * contracts;
  const deltaRows = results.allDeltas.filter((r): r is DeltaRow => !('error' in r));

  // ============================================================
  // Sheet 1: P&L Summary (all wing widths × all deltas × put/call/combined)
  // ============================================================
  const summaryHeaders = [
    'Delta', 'Wing Width', 'Side',
    'Credit (pts)', 'Credit ($)',
    'Max Loss (pts)', 'Max Loss ($)',
    'Buying Power ($)',
    'RoR (%)', 'PoP (%)',
    'Breakeven',
    'Short Strike', 'Long Strike',
  ];

  const summaryData: (string | number)[][] = [];

  for (const width of ALL_WING_WIDTHS) {
    for (const row of deltaRows) {
      const ic = buildIronCondor(row, width, results.spot, results.T, effectiveRatio);

      // Put Spread
      summaryData.push([
        ic.delta + 'Δ', width, 'Put Spread',
        round4(ic.putSpreadCredit), round2(ic.putSpreadCredit * mult),
        round4(ic.putSpreadMaxLoss), round2(ic.putSpreadMaxLoss * mult),
        round2(ic.putSpreadMaxLoss * mult),
        round1(ic.putSpreadRoR * 100), round1(ic.putSpreadPoP * 100),
        round0(ic.putSpreadBE),
        ic.shortPut, ic.longPut,
      ]);

      // Call Spread
      summaryData.push([
        ic.delta + 'Δ', width, 'Call Spread',
        round4(ic.callSpreadCredit), round2(ic.callSpreadCredit * mult),
        round4(ic.callSpreadMaxLoss), round2(ic.callSpreadMaxLoss * mult),
        round2(ic.callSpreadMaxLoss * mult),
        round1(ic.callSpreadRoR * 100), round1(ic.callSpreadPoP * 100),
        round0(ic.callSpreadBE),
        ic.shortCall, ic.longCall,
      ]);

      // Iron Condor (combined)
      summaryData.push([
        ic.delta + 'Δ', width, 'Iron Condor',
        round4(ic.creditReceived), round2(ic.creditReceived * mult),
        round4(ic.maxLoss), round2(ic.maxLoss * mult),
        round2(ic.maxLoss * mult),
        round1(ic.returnOnRisk * 100), round1(ic.probabilityOfProfit * 100),
        round0(ic.breakEvenLow) + '–' + round0(ic.breakEvenHigh),
        ic.shortPut + ' / ' + ic.shortCall, ic.longPut + ' / ' + ic.longCall,
      ]);
    }
  }

  const summaryWs = XLSX.utils.aoa_to_sheet([summaryHeaders, ...summaryData]);
  setColumnWidths(summaryWs, [8, 10, 12, 12, 12, 12, 12, 12, 8, 8, 16, 16, 16]);
  XLSX.utils.book_append_sheet(wb, summaryWs, 'P&L Comparison');

  // ============================================================
  // Sheet 2: IC-Only Pivot (one row per delta × wing width, IC only)
  // ============================================================
  const pivotHeaders = [
    'Wing Width', 'Delta',
    'Credit (pts)', 'Credit ($)',
    'Max Loss (pts)', 'Max Loss ($)',
    'Buying Power ($)',
    'RoR (%)', 'PoP (%)',
    'BE Low', 'BE High',
    'Put Credit ($)', 'Call Credit ($)',
    'Put PoP (%)', 'Call PoP (%)',
    'Short Put', 'Short Call',
    'Long Put', 'Long Call',
  ];

  const pivotData: (string | number)[][] = [];

  for (const width of ALL_WING_WIDTHS) {
    for (const row of deltaRows) {
      const ic = buildIronCondor(row, width, results.spot, results.T, effectiveRatio);
      pivotData.push([
        width, ic.delta + 'Δ',
        round4(ic.creditReceived), round2(ic.creditReceived * mult),
        round4(ic.maxLoss), round2(ic.maxLoss * mult),
        round2(ic.maxLoss * mult),
        round1(ic.returnOnRisk * 100), round1(ic.probabilityOfProfit * 100),
        round0(ic.breakEvenLow), round0(ic.breakEvenHigh),
        round2(ic.putSpreadCredit * mult), round2(ic.callSpreadCredit * mult),
        round1(ic.putSpreadPoP * 100), round1(ic.callSpreadPoP * 100),
        ic.shortPut, ic.shortCall,
        ic.longPut, ic.longCall,
      ]);
    }
  }

  const pivotWs = XLSX.utils.aoa_to_sheet([pivotHeaders, ...pivotData]);
  setColumnWidths(pivotWs, [10, 8, 12, 12, 12, 12, 12, 8, 8, 8, 8, 12, 12, 10, 10, 10, 10, 10, 10]);
  XLSX.utils.book_append_sheet(wb, pivotWs, 'IC Summary');

  // ============================================================
  // Sheet 3: Inputs snapshot
  // ============================================================
  const inputsData = [
    ['0DTE Strike Calculator — Export'],
    [],
    ['Parameter', 'Value'],
    ['SPY Spot', round2(results.spot / effectiveRatio)],
    ['SPX Equivalent', round0(results.spot)],
    ['SPX/SPY Ratio', round4(effectiveRatio)],
    ['σ (IV)', round4(results.sigma) + ' (' + round2(results.sigma * 100) + '%)'],
    ['Put Skew', skewPct + '%'],
    ['T (annualized)', results.T.toFixed(6)],
    ['Hours Remaining', round2(results.hoursRemaining)],
    ['Contracts', contracts],
    ['SPX Multiplier', '$100'],
    [],
    ['Wing Widths Compared', ALL_WING_WIDTHS.join(', ')],
    ['Deltas Compared', deltaRows.map((r) => r.delta + 'Δ').join(', ')],
    [],
    ['Notes'],
    ['All premiums are theoretical Black-Scholes values (r=0).'],
    ['Buying Power = Max Loss = Wing Width − Credit Received.'],
    ['PoP (Iron Condor) = P(price between both breakevens), NOT product of spread PoPs.'],
    ['Individual spread PoPs are single-tail probabilities (always higher than IC PoP).'],
    ['Dollar values = SPX points × $100 × ' + contracts + ' contracts.'],
  ];

  const inputsWs = XLSX.utils.aoa_to_sheet(inputsData);
  setColumnWidths(inputsWs, [24, 30]);
  XLSX.utils.book_append_sheet(wb, inputsWs, 'Inputs');

  // ============================================================
  // Download
  // ============================================================
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '');
  const filename = 'strike-calc-pnl-' + timestamp + '.xlsx';
  XLSX.writeFile(wb, filename);
}

// Helpers
function round0(n: number): number { return Math.round(n); }
function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }

function setColumnWidths(ws: XLSX.WorkSheet, widths: number[]): void {
  ws['!cols'] = widths.map((w) => ({ wch: w }));
}
