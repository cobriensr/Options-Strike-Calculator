/**
 * Client-side parser for single-day thinkorswim paperMoney
 * account statement CSV exports.
 *
 * Main export: parseStatement(csv, spotPrice) → DailyStatement
 *
 * This parser is completely independent from api/_lib/csv-parser.ts.
 * It runs entirely in the browser — no server dependencies.
 */

import type { DailyStatement, IronCondor, Spread } from './types';
import { round2 } from '../../utils/formatting';
import { parseShortDate } from './statement-parser/value-parsers';
import {
  findSections,
  parseCashBalance,
  parseOrderHistory,
  parseTradeHistory,
  parseOptions,
  parsePnL,
  parseAccountSummarySection,
} from './statement-parser/section-parsers';
import { groupIntoSpreads } from './statement-parser/spread-builder';
import { matchClosedSpreads } from './statement-parser/closed-spreads';
import { computePortfolioRisk } from './statement-parser/portfolio-risk';
import { computeExecutionQuality } from './statement-parser/execution-quality';
import { generateWarnings } from './statement-parser/warnings';

export {
  parseCSVLine,
  parseCurrency,
  parsePercentage,
  parseTosDate,
  parseTrdDescription,
} from './statement-parser/value-parsers';

export { groupIntoSpreads } from './statement-parser/spread-builder';
export type { GroupResult } from './statement-parser/spread-builder';
export { matchClosedSpreads } from './statement-parser/closed-spreads';
export { computePortfolioRisk } from './statement-parser/portfolio-risk';
export { computeExecutionQuality } from './statement-parser/execution-quality';
export { generateWarnings } from './statement-parser/warnings';
export { applyBSEstimates } from './statement-parser/bs-estimates';

// ── Main Parser ────────────────────────────────────────────

/**
 * Parse a single-day thinkorswim paperMoney account
 * statement CSV.
 *
 * @param csv — Raw CSV text from the export
 * @param spotPrice — Current SPX spot price
 * @returns Fully parsed and analyzed DailyStatement
 */
export function parseStatement(csv: string, spotPrice: number): DailyStatement {
  const lines = csv.split(/\r?\n/);
  const sections = findSections(lines);

  // ── Parse each section ─────────────────────────────────

  const cashEntries = sections.has('Cash Balance')
    ? parseCashBalance(lines, sections.get('Cash Balance')!)
    : [];

  const orders = sections.has('Account Order History')
    ? parseOrderHistory(lines, sections.get('Account Order History')!)
    : [];

  const trades = sections.has('Account Trade History')
    ? parseTradeHistory(lines, sections.get('Account Trade History')!)
    : [];

  const optionsResult = sections.has('Options')
    ? parseOptions(lines, sections.get('Options')!)
    : { legs: [], hasMark: false };
  const openLegs = optionsResult.legs;

  const pnl = sections.has('Profits and Losses')
    ? parsePnL(lines, sections.get('Profits and Losses')!)
    : { entries: [], totals: null };

  const accountSummary = sections.has('Account Summary')
    ? parseAccountSummarySection(lines, sections.get('Account Summary')!)
    : {
        netLiquidatingValue: 0,
        stockBuyingPower: 0,
        optionBuyingPower: 0,
        equityCommissionsYtd: 0,
      };

  // ── Derive date from first cash entry or first trade ───

  let date = '';
  if (cashEntries.length > 0) {
    date = cashEntries[0]!.date;
  } else if (trades.length > 0) {
    // Extract date from exec time "3/27/26 09:29:13"
    const timeParts = trades[0]!.execTime.split(' ');
    if (timeParts[0]) {
      date = parseShortDate(timeParts[0]);
    }
  }

  // ── Group positions ────────────────────────────────────

  const grouped = groupIntoSpreads(openLegs, trades, spotPrice, cashEntries);

  // ── Estimate P&L from aggregate when marks are missing ─

  const allSpreadsLackMarks =
    grouped.spreads.every((s) => s.currentValue === null) &&
    grouped.ironCondors.every(
      (ic) =>
        ic.putSpread.currentValue === null &&
        ic.callSpread.currentValue === null,
    );

  if (allSpreadsLackMarks && pnl.totals) {
    // P/L Open from broker: negative = positions cost this much to
    // close (i.e. you're still "in" by credit - abs(plOpen)).
    // Distribute proportionally by credit weight across spreads.
    const aggPlOpen = pnl.totals.plOpen;
    const totalCredit =
      grouped.spreads.reduce((s, sp) => s + sp.creditReceived, 0) +
      grouped.ironCondors.reduce((s, ic) => s + ic.totalCredit, 0);

    if (totalCredit > 0) {
      const estimateSpreadPnl = (
        credit: number,
      ): {
        openPnl: number;
        pctOfMaxProfit: number | null;
      } => {
        const weight = credit / totalCredit;
        // Cost to close this spread (proportional share of aggregate)
        const costToClose = round2(Math.abs(aggPlOpen) * weight);
        // Open P&L = credit minus cost to close
        const openPnl = round2(credit - costToClose);
        const pctOfMaxProfit =
          credit > 0 ? round2((openPnl / credit) * 100) : null;
        return { openPnl, pctOfMaxProfit };
      };

      for (let i = 0; i < grouped.spreads.length; i++) {
        const sp = grouped.spreads[i]!;
        const est = estimateSpreadPnl(sp.creditReceived);
        (grouped.spreads as Spread[])[i] = {
          ...sp,
          ...est,
        };
      }
      for (let i = 0; i < grouped.ironCondors.length; i++) {
        const ic = grouped.ironCondors[i]!;
        const putEst = estimateSpreadPnl(ic.putSpread.creditReceived);
        const callEst = estimateSpreadPnl(ic.callSpread.creditReceived);
        (grouped.ironCondors as IronCondor[])[i] = {
          ...ic,
          putSpread: { ...ic.putSpread, ...putEst },
          callSpread: { ...ic.callSpread, ...callEst },
        };
      }
    }
  }

  // ── Match closed spreads ───────────────────────────────

  const closedSpreads = matchClosedSpreads(trades);

  // ── Compute analytics ──────────────────────────────────

  const portfolioRisk = computePortfolioRisk(
    grouped.spreads,
    grouped.ironCondors,
    grouped.hedges,
    grouped.naked,
    accountSummary,
    pnl,
    spotPrice,
  );

  const executionQuality = computeExecutionQuality(orders, trades);

  const warnings = generateWarnings(
    cashEntries,
    openLegs,
    optionsResult.hasMark,
    pnl,
    grouped.naked,
    sections,
    grouped.spreads,
    grouped.ironCondors,
  );

  return {
    date,
    cashEntries,
    orders,
    trades,
    openLegs,
    pnl,
    accountSummary,
    spreads: grouped.spreads,
    ironCondors: grouped.ironCondors,
    hedges: grouped.hedges,
    nakedPositions: grouped.naked,
    closedSpreads,
    portfolioRisk,
    executionQuality,
    warnings,
  };
}
