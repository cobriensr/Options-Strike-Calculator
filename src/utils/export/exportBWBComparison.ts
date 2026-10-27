import type { DeltaRow, CalculationResults } from '../../types/index.js';
import {
  buildCallBWB,
  buildPutBWB,
  bwbPnLAtExpiry,
  bwbSettlementSigma,
  expectedPnLSplit,
} from '../bwb.js';
import {
  BWB_NARROW_OPTIONS,
  BWB_WIDE_MULTIPLIERS,
} from '../../constants/index.js';
import { round0, round1, round2, round4 } from '../formatting.js';
import { setColumnWidths } from './helpers.js';

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
    'Near Breakeven',
    'Sweet Spot',
    'Short ×2',
    'Long Near',
    'Long Far',
    'Monthly Wins (log-normal)',
    'Monthly Losses (log-normal)',
    'Monthly Win EV ($)',
    'Monthly Loss EV ($)',
    'Monthly Net EV ($)',
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
          // Projection by expected value of the whole expiry payoff, under
          // the log-normal probabilityOfProfit uses (owner decision Q25).
          // The fat-tail adjusted PoP in the PoP column is a constant
          // multiplier, not a distribution, so it can't weight a payoff.
          const { expectedWin, expectedLoss } = expectedPnLSplit(
            (spx) => bwbPnLAtExpiry(bwb, spx),
            {
              spot: results.spot,
              sigma: bwbSettlementSigma(row, bwb.side),
              T: results.T,
            },
          );
          const pop = bwb.probabilityOfProfit;
          const monthlyWins = round1(tradingDaysPerMonth * pop);
          const monthlyLosses = round1(tradingDaysPerMonth * (1 - pop));
          const monthlyWinEV = round2(tradingDaysPerMonth * expectedWin * mult);
          const monthlyLossEV = round2(
            tradingDaysPerMonth * expectedLoss * mult,
          );
          const monthlyNetEV = round2(monthlyWinEV - monthlyLossEV);

          data.push([
            bwb.narrowWidth,
            bwb.wideWidth,
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
            round1(bwb.adjustedPoP * 100),
            round0(bwb.breakeven),
            bwb.breakevenNear == null ? '' : round0(bwb.breakevenNear),
            bwb.sweetSpot,
            bwb.shortStrike,
            bwb.longNearStrike,
            bwb.longFarStrike,
            monthlyWins,
            monthlyLosses,
            monthlyWinEV,
            monthlyLossEV,
            monthlyNetEV,
          ]);
        }
      }
    }
  }

  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  setColumnWidths(
    ws,
    [
      8, 8, 6, 8, 10, 14, 12, 14, 12, 12, 12, 12, 8, 8, 10, 14, 10, 10, 10, 10,
      24, 26, 18, 18, 18,
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
    [
      'Narrow and Wide are the snapped strike distances: an off-grid wide width (e.g. 37.5) snaps away from the short strike to 40 on both sides.',
    ],
    ['Max Loss = Wide Width − Narrow Width − Net Credit (capped at far wing).'],
    [
      'A debit BWB profits only between Breakeven and Near Breakeven; PoP is the probability of settling between them.',
    ],
    ['Buying Power = Max Loss.'],
    ['Dollar values = SPX points × $100 × ' + contracts + ' contracts.'],
    [],
    ['Monthly Projections (22 trading days, log-normal expected value)'],
    [
      'Monthly Win EV ($) = 22 × the expected profit per trade, summed over the settlements that make money. Monthly Loss EV ($) = 22 × the expected loss over the settlements that lose. Monthly Net EV ($) = Win EV − Loss EV.',
    ],
    [
      'The expectations integrate the full expiry payoff under the same log-normal (r=0, base σ per side) as the log-normal PoP. Monthly Wins / Losses = 22 × that log-normal PoP.',
    ],
    [
      'PoP (%) is fat-tail adjusted. That adjustment is a constant multiplier, not a distribution, so the projections do not use it.',
    ],
    [
      'Premiums are priced at the IV-accelerated σ and settle at the base σ, so Net EV is the gap between the two. With no IV acceleration it is 0.',
    ],
    [
      'IMPORTANT: Monthly Net EV assumes every trade is held to expiration with no management.',
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
