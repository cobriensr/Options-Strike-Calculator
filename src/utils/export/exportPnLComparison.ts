import type { DeltaRow, CalculationResults } from '../../types/index.js';
import { buildIronCondor } from '../calculator.js';
import { WING_OPTIONS } from '../../constants/index.js';
import { round0, round1, round2, round4 } from '../formatting.js';
import { setColumnWidths } from './helpers.js';

const ALL_WING_WIDTHS = [...WING_OPTIONS];

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
