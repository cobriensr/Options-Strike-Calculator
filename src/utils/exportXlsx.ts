import type * as XLSX from 'xlsx';
import type { DeltaRow, CalculationResults } from '../types';
import { buildIronCondor, buildPutBWB, buildCallBWB } from './calculator';

const ALL_WING_WIDTHS = [5, 10, 15, 20, 25, 30, 50];
const BWB_NARROWS = [10, 15, 20, 25, 30];
const BWB_MULTIPLIERS = [1.5, 2, 2.5, 3];

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
export async function exportPnLComparison({
  results,
  contracts,
  effectiveRatio,
  skewPct,
}: ExportParams): Promise<void> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const mult = 100 * contracts;
  const deltaRows = results.allDeltas.filter(
    (r): r is DeltaRow => !('error' in r),
  );

  // ============================================================
  // Sheet 1: P&L Summary (all wing widths × all deltas × put/call/combined)
  // ============================================================
  const summaryHeaders = [
    'Delta',
    'Wing Width',
    'Side',
    'Credit (pts)',
    'Credit ($)',
    'Max Loss (pts)',
    'Max Loss ($)',
    'Buying Power ($)',
    'RoR (%)',
    'PoP (%)',
    'Wins to Recover',
    'Breakeven',
    'Short Strike',
    'Long Strike',
    'Monthly Wins (est)',
    'Monthly Losses (est)',
    'Monthly Profit ($)',
    'Monthly Loss ($)',
    'Monthly Net ($)',
  ];

  const summaryData: (string | number)[][] = [];
  const tradingDaysPerMonth = 22;

  for (const width of ALL_WING_WIDTHS) {
    for (const row of deltaRows) {
      const ic = buildIronCondor(
        row,
        width,
        results.spot,
        results.T,
        effectiveRatio,
        results.vix,
      );

      const addRow = (
        side: string,
        credit: number,
        maxLoss: number,
        ror: number,
        pop: number,
        be: string,
        shortStrike: string | number,
        longStrike: string | number,
      ) => {
        const winsToRecover = credit > 0 ? round1(maxLoss / credit) : 0;
        const monthlyWins = round1(tradingDaysPerMonth * pop);
        const monthlyLosses = round1(tradingDaysPerMonth * (1 - pop));
        const monthlyProfit = round2(monthlyWins * credit * mult);
        const monthlyLossDollars = round2(monthlyLosses * maxLoss * mult);
        const monthlyNet = round2(monthlyProfit - monthlyLossDollars);

        summaryData.push([
          ic.delta + 'Δ',
          width,
          side,
          round4(credit),
          round2(credit * mult),
          round4(maxLoss),
          round2(maxLoss * mult),
          round2(maxLoss * mult),
          round1(ror * 100),
          round1(pop * 100),
          winsToRecover,
          be,
          shortStrike,
          longStrike,
          monthlyWins,
          monthlyLosses,
          monthlyProfit,
          monthlyLossDollars,
          monthlyNet,
        ]);
      };

      // Put Spread
      addRow(
        'Put Spread',
        ic.putSpreadCredit,
        ic.putSpreadMaxLoss,
        ic.putSpreadRoR,
        ic.putSpreadPoP,
        String(round0(ic.putSpreadBE)),
        ic.shortPut,
        ic.longPut,
      );

      // Call Spread
      addRow(
        'Call Spread',
        ic.callSpreadCredit,
        ic.callSpreadMaxLoss,
        ic.callSpreadRoR,
        ic.callSpreadPoP,
        String(round0(ic.callSpreadBE)),
        ic.shortCall,
        ic.longCall,
      );

      // Iron Condor
      addRow(
        'Iron Condor',
        ic.creditReceived,
        ic.maxLoss,
        ic.returnOnRisk,
        ic.probabilityOfProfit,
        round0(ic.breakEvenLow) + '–' + round0(ic.breakEvenHigh),
        ic.shortPut + ' / ' + ic.shortCall,
        ic.longPut + ' / ' + ic.longCall,
      );
    }
  }

  const summaryWs = XLSX.utils.aoa_to_sheet([summaryHeaders, ...summaryData]);
  setColumnWidths(
    summaryWs,
    [8, 10, 12, 12, 12, 12, 12, 12, 8, 8, 10, 16, 16, 16, 10, 10, 14, 14, 14],
  );
  XLSX.utils.book_append_sheet(wb, summaryWs, 'P&L Comparison');

  // ============================================================
  // Sheet 2: IC-Only Pivot (one row per delta × wing width, IC only)
  // ============================================================
  const pivotHeaders = [
    'Wing Width',
    'Delta',
    'Credit (pts)',
    'Credit ($)',
    'Max Loss (pts)',
    'Max Loss ($)',
    'Buying Power ($)',
    'RoR (%)',
    'PoP (%)',
    'Wins to Recover',
    'BE Low',
    'BE High',
    'Put Credit ($)',
    'Call Credit ($)',
    'Put PoP (%)',
    'Call PoP (%)',
    'Monthly Wins',
    'Monthly Losses',
    'Monthly Profit ($)',
    'Monthly Loss ($)',
    'Monthly Net ($)',
    'Short Put',
    'Short Call',
    'Long Put',
    'Long Call',
  ];

  const pivotData: (string | number)[][] = [];

  for (const width of ALL_WING_WIDTHS) {
    for (const row of deltaRows) {
      const ic = buildIronCondor(
        row,
        width,
        results.spot,
        results.T,
        effectiveRatio,
        results.vix,
      );
      const winsToRecover =
        ic.creditReceived > 0 ? round1(ic.maxLoss / ic.creditReceived) : 0;
      const pop = ic.probabilityOfProfit;
      const monthlyWins = round1(tradingDaysPerMonth * pop);
      const monthlyLosses = round1(tradingDaysPerMonth * (1 - pop));
      const monthlyProfit = round2(monthlyWins * ic.creditReceived * mult);
      const monthlyLossDollars = round2(monthlyLosses * ic.maxLoss * mult);
      const monthlyNet = round2(monthlyProfit - monthlyLossDollars);

      pivotData.push([
        width,
        ic.delta + 'Δ',
        round4(ic.creditReceived),
        round2(ic.creditReceived * mult),
        round4(ic.maxLoss),
        round2(ic.maxLoss * mult),
        round2(ic.maxLoss * mult),
        round1(ic.returnOnRisk * 100),
        round1(ic.probabilityOfProfit * 100),
        winsToRecover,
        round0(ic.breakEvenLow),
        round0(ic.breakEvenHigh),
        round2(ic.putSpreadCredit * mult),
        round2(ic.callSpreadCredit * mult),
        round1(ic.putSpreadPoP * 100),
        round1(ic.callSpreadPoP * 100),
        monthlyWins,
        monthlyLosses,
        monthlyProfit,
        monthlyLossDollars,
        monthlyNet,
        ic.shortPut,
        ic.shortCall,
        ic.longPut,
        ic.longCall,
      ]);
    }
  }

  const pivotWs = XLSX.utils.aoa_to_sheet([pivotHeaders, ...pivotData]);
  setColumnWidths(
    pivotWs,
    [
      10, 8, 12, 12, 12, 12, 12, 8, 8, 10, 8, 8, 12, 12, 10, 10, 10, 10, 14, 14,
      14, 10, 10, 10, 10,
    ],
  );
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
    [
      'σ (IV)',
      round4(results.sigma) + ' (' + round2(results.sigma * 100) + '%)',
    ],
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
    [
      'Wins to Recover = Max Loss ÷ Credit (how many winning trades to offset one loss).',
    ],
    [
      'PoP (Iron Condor) = P(price between both breakevens), NOT product of spread PoPs.',
    ],
    [
      'Individual spread PoPs are single-tail probabilities (always higher than IC PoP).',
    ],
    ['Dollar values = SPX points × $100 × ' + contracts + ' contracts.'],
    [],
    ['Monthly Projections (22 trading days)'],
    ['Monthly Wins = 22 × PoP. Monthly Losses = 22 × (1 − PoP).'],
    [
      'Monthly Profit = Monthly Wins × Credit ($). Monthly Loss = Monthly Losses × Max Loss ($).',
    ],
    ['Monthly Net = Monthly Profit − Monthly Loss.'],
    [
      'IMPORTANT: Monthly Net assumes every trade is held to expiration with no management.',
    ],
    ['Theoretical net is approximately zero (Black-Scholes is fair pricing).'],
    [
      'Real edge comes from trade management: closing losers early, taking profits at 50%, avoiding high-VIX days.',
    ],
  ];

  const inputsWs = XLSX.utils.aoa_to_sheet(inputsData);
  setColumnWidths(inputsWs, [24, 30]);
  XLSX.utils.book_append_sheet(wb, inputsWs, 'Inputs');

  // ============================================================
  // Download
  // ============================================================
  const timestamp = new Date()
    .toISOString()
    .slice(0, 16)
    .replace('T', '_')
    .replace(':', '');
  const filename = 'strike-calc-pnl-' + timestamp + '.xlsx';
  XLSX.writeFile(wb, filename);
}

// ============================================================
// BWB Export
// ============================================================

interface BWBExportParams {
  results: CalculationResults;
  contracts: number;
  effectiveRatio: number;
}

/**
 * Generates and downloads an XLSX file comparing BWB P&L across
 * all narrow width × multiplier combinations.
 *
 * Sheet 1: "BWB Comparison" — put + call BWB for each combo
 * Sheet 2: "Inputs" — captures the inputs used for the export
 */
export async function exportBWBComparison({
  results,
  contracts,
  effectiveRatio,
}: BWBExportParams): Promise<void> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const mult = 100 * contracts;
  const deltaRows = results.allDeltas.filter(
    (r): r is DeltaRow => !('error' in r),
  );
  const tradingDaysPerMonth = 22;

  // ============================================================
  // Sheet 1: BWB Comparison
  // ============================================================
  const headers = [
    'Narrow',
    'Wide',
    'Mult',
    'Delta',
    'Side',
    'Net Credit (pts)',
    'Net Credit ($)',
    'Max Profit (pts)',
    'Max Profit ($)',
    'Max Loss (pts)',
    'Max Loss ($)',
    'Buying Power ($)',
    'RoR (%)',
    'PoP (%)',
    'Breakeven',
    'Sweet Spot',
    'Short ×2',
    'Long Near',
    'Long Far',
    'Monthly Wins',
    'Monthly Losses',
    'Monthly Profit ($)',
    'Monthly Loss ($)',
    'Monthly Net ($)',
  ];

  const data: (string | number)[][] = [];

  for (const narrow of BWB_NARROWS) {
    for (const m of BWB_MULTIPLIERS) {
      const wide = narrow * m;
      for (const row of deltaRows) {
        const putBwb = buildPutBWB(
          row,
          narrow,
          wide,
          results.spot,
          results.T,
          effectiveRatio,
          results.vix,
        );
        const callBwb = buildCallBWB(
          row,
          narrow,
          wide,
          results.spot,
          results.T,
          effectiveRatio,
          results.vix,
        );

        for (const bwb of [putBwb, callBwb]) {
          const pop = bwb.adjustedPoP;
          const monthlyWins = round1(tradingDaysPerMonth * pop);
          const monthlyLosses = round1(tradingDaysPerMonth * (1 - pop));
          const monthlyProfit = round2(
            monthlyWins * Math.max(0, bwb.netCredit) * mult,
          );
          const monthlyLoss = round2(monthlyLosses * bwb.maxLoss * mult);
          const monthlyNet = round2(monthlyProfit - monthlyLoss);

          data.push([
            narrow,
            wide,
            m + 'x',
            bwb.delta + 'Δ',
            bwb.side === 'put' ? 'Put BWB' : 'Call BWB',
            round4(bwb.netCredit),
            round2(bwb.netCredit * mult),
            round4(bwb.maxProfit),
            round2(bwb.maxProfit * mult),
            round4(bwb.maxLoss),
            round2(bwb.maxLoss * mult),
            round2(bwb.maxLoss * mult),
            round1(bwb.returnOnRisk * 100),
            round1(pop * 100),
            round0(bwb.breakeven),
            bwb.sweetSpot,
            bwb.shortStrike,
            bwb.longNearStrike,
            bwb.longFarStrike,
            monthlyWins,
            monthlyLosses,
            monthlyProfit,
            monthlyLoss,
            monthlyNet,
          ]);
        }
      }
    }
  }

  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  setColumnWidths(
    ws,
    [
      8, 8, 6, 8, 10, 14, 12, 14, 12, 12, 12, 12, 8, 8, 10, 10, 10, 10, 10, 10,
      10, 14, 14, 14,
    ],
  );
  XLSX.utils.book_append_sheet(wb, ws, 'BWB Comparison');

  // ============================================================
  // Sheet 2: Inputs snapshot
  // ============================================================
  const inputsData = [
    ['0DTE Strike Calculator — BWB Export'],
    [],
    ['Parameter', 'Value'],
    ['SPY Spot', round2(results.spot / effectiveRatio)],
    ['SPX Equivalent', round0(results.spot)],
    ['SPX/SPY Ratio', round4(effectiveRatio)],
    [
      'σ (IV)',
      round4(results.sigma) + ' (' + round2(results.sigma * 100) + '%)',
    ],
    ['T (annualized)', results.T.toFixed(6)],
    ['Hours Remaining', round2(results.hoursRemaining)],
    ['Contracts', contracts],
    ['SPX Multiplier', '$100'],
    [],
    ['Narrow Widths Compared', BWB_NARROWS.join(', ')],
    [
      'Wide Multipliers Compared',
      BWB_MULTIPLIERS.map((m) => m + 'x').join(', '),
    ],
    ['Deltas Compared', deltaRows.map((r) => r.delta + 'Δ').join(', ')],
    [],
    ['Notes'],
    ['All premiums are theoretical Black-Scholes values (r=0).'],
    ['BWB uses a single σ per side (put or call), same as IC pricing.'],
    ['Net Credit can be negative (net debit) depending on wing asymmetry.'],
    ['Max Profit = Narrow Width + Net Credit (at the sweet spot).'],
    ['Max Loss = Wide Width − Narrow Width − Net Credit (capped at far wing).'],
    ['Buying Power = Max Loss.'],
    ['Dollar values = SPX points × $100 × ' + contracts + ' contracts.'],
    [],
    ['Monthly Projections (22 trading days)'],
    [
      'IMPORTANT: Monthly Net assumes every trade is held to expiration with no management.',
    ],
    [
      'BWB profit peaks at the sweet spot — real edge comes from selecting setups where a gamma wall aligns with the sweet spot.',
    ],
  ];

  const inputsWs = XLSX.utils.aoa_to_sheet(inputsData);
  setColumnWidths(inputsWs, [28, 30]);
  XLSX.utils.book_append_sheet(wb, inputsWs, 'Inputs');

  // ============================================================
  // Download
  // ============================================================
  const timestamp = new Date()
    .toISOString()
    .slice(0, 16)
    .replace('T', '_')
    .replace(':', '');
  const filename = 'strike-calc-bwb-' + timestamp + '.xlsx';
  XLSX.writeFile(wb, filename);
}

// Helpers
function round0(n: number): number {
  return Math.round(n);
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function setColumnWidths(ws: XLSX.WorkSheet, widths: number[]): void {
  ws['!cols'] = widths.map((w) => ({ wch: w }));
}
