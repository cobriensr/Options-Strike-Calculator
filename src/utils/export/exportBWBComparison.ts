import type { DeltaRow, CalculationResults } from '../../types';
import { buildPutBWB, buildCallBWB } from '../calculator';
import { BWB_NARROW_OPTIONS, BWB_WIDE_MULTIPLIERS } from '../../constants';
import { round0, round1, round2, round4 } from '../formatting';
import { setColumnWidths } from './helpers';

const BWB_NARROWS = [...BWB_NARROW_OPTIONS];
const BWB_MULTIPLIERS = [...BWB_WIDE_MULTIPLIERS];

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
