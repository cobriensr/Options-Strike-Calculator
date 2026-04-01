/**
 * Client-side parser for single-day thinkorswim paperMoney
 * account statement CSV exports.
 *
 * Main export: parseStatement(csv, spotPrice) → DailyStatement
 *
 * This parser is completely independent from api/_lib/csv-parser.ts.
 * It runs entirely in the browser — no server dependencies.
 */

import type {
  AccountSummary,
  CashEntry,
  ClosedSpread,
  ClosedSpreadOutcome,
  DailyStatement,
  DataQualityWarning,
  ExecutedTrade,
  ExecutionQuality,
  HedgePosition,
  IronCondor,
  NakedPosition,
  OpenLeg,
  OrderEntry,
  PnLSummary,
  PortfolioRisk,
  RejectionReason,
  SlippageEntry,
  Spread,
  SpreadType,
  TradeLeg,
  WarningCode,
  WarningSeverity,
} from './types';
import { SPX_MULTIPLIER as MULTIPLIER } from '../../constants';
import { round2 } from '../../utils/formatting';
import { parseShortDate } from './statement-parser/value-parsers';
import {
  type SectionBounds,
  findSections,
  parseCashBalance,
  parseOrderHistory,
  parseTradeHistory,
  parseOptions,
  parsePnL,
  parseAccountSummarySection,
} from './statement-parser/section-parsers';

export {
  parseCSVLine,
  parseCurrency,
  parsePercentage,
  parseTosDate,
  parseTrdDescription,
} from './statement-parser/value-parsers';

// ── Position Grouping ──────────────────────────────────────

interface GroupResult {
  readonly spreads: Spread[];
  readonly ironCondors: IronCondor[];
  readonly hedges: HedgePosition[];
  readonly naked: NakedPosition[];
}

/**
 * Build a spread from a short leg and long leg.
 * Determines PCS vs CCS, computes risk metrics.
 */
function buildSpread(
  shortLeg: OpenLeg,
  longLeg: OpenLeg,
  trades: ExecutedTrade[],
  spotPrice: number,
  cashEntries: CashEntry[],
): Spread {
  const contracts = Math.abs(shortLeg.qty);
  const wingWidth = Math.abs(shortLeg.strike - longLeg.strike);

  // Credit = |shortTradePrice| - |longTradePrice|
  const creditPerContract =
    Math.abs(shortLeg.tradePrice) - Math.abs(longLeg.tradePrice);
  const creditReceived = creditPerContract * MULTIPLIER * contracts;
  const maxProfit = creditReceived;
  const maxLoss = wingWidth * MULTIPLIER * contracts - creditReceived;
  const riskRewardRatio = maxProfit > 0 ? maxLoss / maxProfit : Infinity;

  const isPCS = shortLeg.type === 'PUT';
  const breakeven = isPCS
    ? shortLeg.strike - creditPerContract
    : shortLeg.strike + creditPerContract;

  const spreadType: SpreadType = isPCS
    ? 'PUT_CREDIT_SPREAD'
    : 'CALL_CREDIT_SPREAD';

  // Cross-reference with trade history for entry time/price
  const { entryTime, entryNetPrice } = matchTradeEntry(
    shortLeg,
    longLeg,
    trades,
  );

  // Current value from marks
  const hasMarks = shortLeg.mark !== null || longLeg.mark !== null;
  const currentValue = hasMarks
    ? round2(
        (shortLeg.mark ?? 0) * shortLeg.qty * MULTIPLIER +
          (longLeg.mark ?? 0) * longLeg.qty * MULTIPLIER,
      )
    : null;

  // Open P&L
  const openPnl =
    currentValue !== null
      ? round2(creditReceived - Math.abs(currentValue))
      : null;

  // Pct of max profit
  const pctOfMaxProfit =
    openPnl !== null && maxProfit > 0
      ? round2((openPnl / maxProfit) * 100)
      : null;

  // Distance to short strike
  const distanceToShortStrike = isPCS
    ? round2(spotPrice - shortLeg.strike)
    : round2(shortLeg.strike - spotPrice);
  const distanceToShortStrikePct =
    spotPrice > 0 ? round2((distanceToShortStrike / spotPrice) * 100) : null;

  // Entry commissions from cash entries
  const entryCommissions = computeEntryCommissions(
    shortLeg,
    longLeg,
    trades,
    cashEntries,
  );

  return {
    spreadType,
    shortLeg,
    longLeg,
    contracts,
    wingWidth,
    creditReceived: round2(creditReceived),
    maxProfit: round2(maxProfit),
    maxLoss: round2(Math.max(0, maxLoss)),
    riskRewardRatio: round2(riskRewardRatio),
    breakeven: round2(breakeven),
    entryTime,
    entryNetPrice,
    currentValue,
    openPnl,
    pctOfMaxProfit,
    distanceToShortStrike,
    distanceToShortStrikePct,
    nearestShortStrike: shortLeg.strike,
    entryCommissions,
  };
}

/**
 * Compute entry commissions for a spread by cross-referencing
 * cash entries by matching trade ref numbers, or estimate
 * from trade data.
 */
function computeEntryCommissions(
  shortLeg: OpenLeg,
  longLeg: OpenLeg,
  trades: ExecutedTrade[],
  cashEntries: CashEntry[],
): number {
  // Try to find the matching trade to get a ref number
  for (const trade of trades) {
    const openLegs = trade.legs.filter((l) => l.posEffect === 'TO OPEN');
    const hasShort = openLegs.some(
      (l) =>
        l.side === 'SELL' &&
        l.strike === shortLeg.strike &&
        l.type === shortLeg.type,
    );
    const hasLong = openLegs.some(
      (l) =>
        l.side === 'BUY' &&
        l.strike === longLeg.strike &&
        l.type === longLeg.type,
    );

    if (hasShort && hasLong) {
      // Find commission entries close in time to this trade
      for (const cash of cashEntries) {
        if (cash.type !== 'TRD') continue;
        if (cash.commissions === 0) continue;
        // Match by description containing strike info
        const desc = cash.description;
        const shortStr = shortLeg.strike.toString();
        const longStr = longLeg.strike.toString();
        if (desc.includes(shortStr) || desc.includes(longStr)) {
          return Math.abs(cash.commissions);
        }
      }
      break;
    }
  }

  return 0;
}

/**
 * Try to find the trade entry matching a spread's legs.
 */
function matchTradeEntry(
  shortLeg: OpenLeg,
  longLeg: OpenLeg,
  trades: ExecutedTrade[],
): {
  entryTime: string | null;
  entryNetPrice: number | null;
} {
  for (const trade of trades) {
    const legs = trade.legs.filter((l) => l.posEffect === 'TO OPEN');
    if (legs.length < 2) continue;

    const hasShort = legs.some(
      (l) =>
        l.side === 'SELL' &&
        l.strike === shortLeg.strike &&
        l.type === shortLeg.type,
    );
    const hasLong = legs.some(
      (l) =>
        l.side === 'BUY' &&
        l.strike === longLeg.strike &&
        l.type === longLeg.type,
    );

    if (hasShort && hasLong) {
      return {
        entryTime: trade.execTime,
        entryNetPrice: trade.netPrice,
      };
    }
  }
  return { entryTime: null, entryNetPrice: null };
}

/**
 * Group open legs into spreads, iron condors, hedges, and
 * naked positions.
 *
 * Step 1: Detect iron condors (PCS + CCS pair, same qty)
 * Step 2: Match remaining legs into vertical spreads
 * Step 3: Classify leftover longs as hedges, shorts as naked
 */
export function groupIntoSpreads(
  legs: OpenLeg[],
  trades: ExecutedTrade[],
  spotPrice: number,
  cashEntries: CashEntry[],
): GroupResult {
  const allSpreads: Spread[] = [];
  const allICs: IronCondor[] = [];
  const allHedges: HedgePosition[] = [];
  const allNaked: NakedPosition[] = [];

  // ─ Primary strategy: build spreads from Trade History ──
  // Trade History has exact leg pairings and quantities per
  // trade, avoiding the aggregation mismatch in Options.
  // Only use TO OPEN trades (not closes).

  const openTrades = trades.filter((t) =>
    t.legs.some((l) => l.posEffect === 'TO OPEN'),
  );

  // Build a spread from each 2-leg TO OPEN trade
  type TradeSpread = {
    spread: Spread;
    tradeIdx: number;
  };

  const tradePCS: TradeSpread[] = [];
  const tradeCCS: TradeSpread[] = [];

  for (let ti = 0; ti < openTrades.length; ti++) {
    const trade = openTrades[ti]!;
    const openLegs = trade.legs.filter((l) => l.posEffect === 'TO OPEN');
    if (openLegs.length !== 2) continue;

    const sellLeg = openLegs.find((l) => l.side === 'SELL');
    const buyLeg = openLegs.find((l) => l.side === 'BUY');
    if (!sellLeg || !buyLeg) continue;
    if (sellLeg.type !== buyLeg.type) continue;

    // Create synthetic OpenLeg objects from trade legs
    const shortLeg: OpenLeg = {
      symbol: sellLeg.symbol,
      optionCode: '',
      exp: sellLeg.exp,
      strike: sellLeg.strike,
      type: sellLeg.type,
      qty: -Math.abs(sellLeg.qty),
      tradePrice: sellLeg.price,
      mark: null,
      markValue: null,
    };
    const longLeg: OpenLeg = {
      symbol: buyLeg.symbol,
      optionCode: '',
      exp: buyLeg.exp,
      strike: buyLeg.strike,
      type: buyLeg.type,
      qty: Math.abs(buyLeg.qty),
      tradePrice: buyLeg.price,
      mark: null,
      markValue: null,
    };

    const spread = buildSpread(
      shortLeg,
      longLeg,
      trades,
      spotPrice,
      cashEntries,
    );

    const ts: TradeSpread = {
      spread,
      tradeIdx: ti,
    };

    if (sellLeg.type === 'PUT') {
      tradePCS.push(ts);
    } else {
      tradeCCS.push(ts);
    }
  }

  // ─ Step 2: Pair PCS + CCS into ICs by qty ────────────
  // Match by contract count — no time constraint, since a
  // trader may add the second wing hours after the first.
  const usedPCS = new Set<number>();
  const usedCCS = new Set<number>();

  for (let p = 0; p < tradePCS.length; p++) {
    if (usedPCS.has(p)) continue;
    const pcs = tradePCS[p]!;

    for (let c = 0; c < tradeCCS.length; c++) {
      if (usedCCS.has(c)) continue;
      const ccs = tradeCCS[c]!;

      const qtyMatch = pcs.spread.contracts === ccs.spread.contracts;

      if (qtyMatch) {
        usedPCS.add(p);
        usedCCS.add(c);

        const contracts = pcs.spread.contracts;
        const totalCredit = round2(
          pcs.spread.creditReceived + ccs.spread.creditReceived,
        );
        const totalCreditPerContract = totalCredit / (MULTIPLIER * contracts);

        const putWingWidth = pcs.spread.wingWidth;
        const callWingWidth = ccs.spread.wingWidth;
        const widerWing = Math.max(putWingWidth, callWingWidth);
        const maxLoss = widerWing * MULTIPLIER * contracts - totalCredit;

        allICs.push({
          spreadType: 'IRON_CONDOR',
          putSpread: pcs.spread,
          callSpread: ccs.spread,
          contracts,
          totalCredit,
          maxProfit: totalCredit,
          maxLoss: round2(Math.max(0, maxLoss)),
          riskRewardRatio:
            totalCredit > 0
              ? round2(Math.max(0, maxLoss) / totalCredit)
              : Infinity,
          breakevenLow: round2(
            pcs.spread.shortLeg.strike - totalCreditPerContract,
          ),
          breakevenHigh: round2(
            ccs.spread.shortLeg.strike + totalCreditPerContract,
          ),
          putWingWidth,
          callWingWidth,
          entryTime: pcs.spread.entryTime ?? ccs.spread.entryTime,
        });

        break;
      }
    }
  }

  // Remaining unpaired verticals
  for (let p = 0; p < tradePCS.length; p++) {
    if (!usedPCS.has(p)) allSpreads.push(tradePCS[p]!.spread);
  }
  for (let c = 0; c < tradeCCS.length; c++) {
    if (!usedCCS.has(c)) allSpreads.push(tradeCCS[c]!.spread);
  }

  // ─ Step 3: Check for true hedges in Options section ────
  // Any Options leg NOT accounted for by the trades above.
  // Track which strikes/types were covered by trade-based spreads.
  const coveredLegs = new Map<string, number>();
  const addCovered = (strike: number, type: string, qty: number) => {
    const key = `${strike}:${type}`;
    coveredLegs.set(key, (coveredLegs.get(key) ?? 0) + qty);
  };

  for (const s of allSpreads) {
    addCovered(s.shortLeg.strike, s.shortLeg.type, Math.abs(s.shortLeg.qty));
    addCovered(s.longLeg.strike, s.longLeg.type, Math.abs(s.longLeg.qty));
  }
  for (const ic of allICs) {
    addCovered(
      ic.putSpread.shortLeg.strike,
      ic.putSpread.shortLeg.type,
      ic.contracts,
    );
    addCovered(
      ic.putSpread.longLeg.strike,
      ic.putSpread.longLeg.type,
      ic.contracts,
    );
    addCovered(
      ic.callSpread.shortLeg.strike,
      ic.callSpread.shortLeg.type,
      ic.contracts,
    );
    addCovered(
      ic.callSpread.longLeg.strike,
      ic.callSpread.longLeg.type,
      ic.contracts,
    );
  }

  for (const leg of legs) {
    const key = `${leg.strike}:${leg.type}`;
    const covered = coveredLegs.get(key) ?? 0;
    const uncovered = Math.abs(leg.qty) - covered;
    if (uncovered <= 0) continue;

    // Remove from covered map
    coveredLegs.set(key, covered + uncovered);

    if (leg.qty > 0) {
      const entryCost = Math.abs(leg.tradePrice) * MULTIPLIER * uncovered;
      const hedgeCurrentValue =
        leg.markValue !== null
          ? round2((leg.markValue / Math.abs(leg.qty)) * uncovered)
          : null;
      const hedgeOpenPnl =
        hedgeCurrentValue !== null
          ? round2(hedgeCurrentValue - entryCost)
          : null;
      allHedges.push({
        leg: { ...leg, qty: uncovered },
        direction: 'LONG',
        protectionSide: leg.type,
        strikeProtected: leg.strike,
        contracts: uncovered,
        entryCost,
        currentValue: hedgeCurrentValue,
        openPnl: hedgeOpenPnl,
      });
    } else {
      allNaked.push({
        leg: { ...leg, qty: -uncovered },
        contracts: uncovered,
        type: leg.type,
      });
    }
  }

  return {
    spreads: allSpreads,
    ironCondors: allICs,
    hedges: allHedges,
    naked: allNaked,
  };
}

// ── Closed Spread Matching ─────────────────────────────────

export function matchClosedSpreads(trades: ExecutedTrade[]): ClosedSpread[] {
  const closedSpreads: ClosedSpread[] = [];

  // Find trades that have TO CLOSE legs
  const closeTrades = trades.filter((t) =>
    t.legs.some((l) => l.posEffect === 'TO CLOSE'),
  );
  const openTrades = trades.filter((t) =>
    t.legs.some((l) => l.posEffect === 'TO OPEN'),
  );

  // Index opening trades by their leg signatures
  interface OpenSpread {
    trade: ExecutedTrade;
    shortLeg: TradeLeg;
    longLeg: TradeLeg;
    used: boolean;
  }

  const openSpreads: OpenSpread[] = [];
  for (const trade of openTrades) {
    const openLegs = trade.legs.filter((l) => l.posEffect === 'TO OPEN');
    if (openLegs.length !== 2) continue;

    const sellLeg = openLegs.find((l) => l.side === 'SELL');
    const buyLeg = openLegs.find((l) => l.side === 'BUY');
    if (!sellLeg || !buyLeg) continue;
    if (sellLeg.type !== buyLeg.type) continue;

    openSpreads.push({
      trade,
      shortLeg: sellLeg,
      longLeg: buyLeg,
      used: false,
    });
  }

  for (const closeTrade of closeTrades) {
    const closeLegs = closeTrade.legs.filter((l) => l.posEffect === 'TO CLOSE');
    if (closeLegs.length !== 2) continue;

    // BUY TO CLOSE covers the short
    // SELL TO CLOSE covers the long
    const btcLeg = closeLegs.find((l) => l.side === 'BUY');
    const stcLeg = closeLegs.find((l) => l.side === 'SELL');
    if (!btcLeg || !stcLeg) continue;

    // Find matching open spread
    for (const openSpread of openSpreads) {
      if (openSpread.used) continue;

      if (
        openSpread.shortLeg.strike === btcLeg.strike &&
        openSpread.shortLeg.type === btcLeg.type &&
        openSpread.longLeg.strike === stcLeg.strike &&
        openSpread.longLeg.type === stcLeg.type &&
        openSpread.shortLeg.qty === btcLeg.qty
      ) {
        openSpread.used = true;

        const contracts = openSpread.shortLeg.qty;
        const wingWidth = Math.abs(
          openSpread.shortLeg.strike - openSpread.longLeg.strike,
        );
        const openCredit = Math.abs(openSpread.trade.netPrice);
        const closeDebit = Math.abs(closeTrade.netPrice);
        const realizedPnl = (openCredit - closeDebit) * MULTIPLIER * contracts;

        const isPCS = openSpread.shortLeg.type === 'PUT';

        // maxLoss for returnOnRisk
        const maxLoss =
          wingWidth * MULTIPLIER * contracts -
          openCredit * MULTIPLIER * contracts;
        const returnOnRisk = maxLoss > 0 ? round2(realizedPnl / maxLoss) : 0;

        // creditCapturedPct
        const openCreditDollars = openCredit * MULTIPLIER * contracts;
        const creditCapturedPct =
          openCreditDollars > 0
            ? round2((realizedPnl / openCreditDollars) * 100)
            : 0;

        // holdTimeMinutes
        const holdTimeMinutes = computeHoldTime(
          openSpread.trade.execTime,
          closeTrade.execTime,
        );

        // outcome
        const outcome = classifyOutcome(realizedPnl, openCreditDollars);

        closedSpreads.push({
          spreadType: isPCS ? 'PUT_CREDIT_SPREAD' : 'CALL_CREDIT_SPREAD',
          shortStrike: openSpread.shortLeg.strike,
          longStrike: openSpread.longLeg.strike,
          optionType: openSpread.shortLeg.type,
          contracts,
          wingWidth,
          openCredit: round2(openCredit),
          closeDebit: round2(closeDebit),
          realizedPnl: round2(realizedPnl),
          openTime: openSpread.trade.execTime,
          closeTime: closeTrade.execTime,
          returnOnRisk,
          creditCapturedPct,
          holdTimeMinutes,
          outcome,
        });

        break;
      }
    }
  }

  return closedSpreads;
}

// ── Portfolio Risk ─────────────────────────────────────────

export function computePortfolioRisk(
  spreads: Spread[],
  ironCondors: IronCondor[],
  hedges: HedgePosition[],
  naked: NakedPosition[],
  accountSummary: AccountSummary,
  _pnl: PnLSummary,
  spotPrice: number,
): PortfolioRisk {
  let callSideRisk = 0;
  let putSideRisk = 0;

  // Standalone verticals add to their respective side
  for (const spread of spreads) {
    if (spread.spreadType === 'PUT_CREDIT_SPREAD') {
      putSideRisk += spread.maxLoss;
    } else if (spread.spreadType === 'CALL_CREDIT_SPREAD') {
      callSideRisk += spread.maxLoss;
    }
  }

  // IC max loss = wider wing. At expiry only one side can
  // lose, but we count it against BOTH sides conservatively.
  for (const ic of ironCondors) {
    callSideRisk += ic.maxLoss;
    putSideRisk += ic.maxLoss;
  }

  // Hedge values
  let callHedgeValue = 0;
  let putHedgeValue = 0;
  for (const hedge of hedges) {
    if (hedge.protectionSide === 'CALL') {
      callHedgeValue += hedge.entryCost;
    } else {
      putHedgeValue += hedge.entryCost;
    }
  }

  const netCallRisk = Math.max(0, callSideRisk - callHedgeValue);
  const netPutRisk = Math.max(0, putSideRisk - putHedgeValue);
  const totalMaxLoss = Math.max(netPutRisk, netCallRisk);

  // Total credit
  let totalCredit = 0;
  for (const spread of spreads) {
    totalCredit += spread.creditReceived;
  }
  for (const ic of ironCondors) {
    totalCredit += ic.totalCredit;
  }

  // Total contracts
  let totalContracts = 0;
  for (const spread of spreads) {
    totalContracts += spread.contracts;
  }
  for (const ic of ironCondors) {
    // Each IC has 4 legs but 2 spread sides
    totalContracts += ic.contracts * 2;
  }
  for (const h of hedges) {
    totalContracts += h.contracts;
  }
  for (const n of naked) {
    totalContracts += n.contracts;
  }

  // Nearest short strike distance
  let nearestDistance = Infinity;
  const updateNearest = (s: Spread) => {
    const dist = Math.abs(s.shortLeg.strike - spotPrice);
    if (dist < nearestDistance) nearestDistance = dist;
  };
  spreads.forEach(updateNearest);
  for (const ic of ironCondors) {
    updateNearest(ic.putSpread);
    updateNearest(ic.callSpread);
  }
  if (nearestDistance === Infinity) nearestDistance = 0;

  // Breakeven levels from put/call credit spreads
  let lowestShortPutStrike = Infinity;
  let highestShortCallStrike = -Infinity;
  let totalPutCreditPerContract = 0;
  let totalCallCreditPerContract = 0;
  let putSpreadCount = 0;
  let callSpreadCount = 0;

  for (const spread of spreads) {
    const creditPerContract =
      spread.creditReceived / (spread.contracts * MULTIPLIER);
    if (spread.spreadType === 'PUT_CREDIT_SPREAD') {
      if (spread.shortLeg.strike < lowestShortPutStrike) {
        lowestShortPutStrike = spread.shortLeg.strike;
      }
      totalPutCreditPerContract += creditPerContract;
      putSpreadCount++;
    } else if (spread.spreadType === 'CALL_CREDIT_SPREAD') {
      if (spread.shortLeg.strike > highestShortCallStrike) {
        highestShortCallStrike = spread.shortLeg.strike;
      }
      totalCallCreditPerContract += creditPerContract;
      callSpreadCount++;
    }
  }
  for (const ic of ironCondors) {
    const putCredit = ic.putSpread.creditReceived / (ic.contracts * MULTIPLIER);
    const callCredit =
      ic.callSpread.creditReceived / (ic.contracts * MULTIPLIER);
    if (ic.putSpread.shortLeg.strike < lowestShortPutStrike) {
      lowestShortPutStrike = ic.putSpread.shortLeg.strike;
    }
    if (ic.callSpread.shortLeg.strike > highestShortCallStrike) {
      highestShortCallStrike = ic.callSpread.shortLeg.strike;
    }
    totalPutCreditPerContract += putCredit;
    totalCallCreditPerContract += callCredit;
    putSpreadCount++;
    callSpreadCount++;
  }

  const breakevenLow =
    putSpreadCount > 0
      ? round2(lowestShortPutStrike - totalPutCreditPerContract)
      : null;
  const breakevenHigh =
    callSpreadCount > 0
      ? round2(highestShortCallStrike + totalCallCreditPerContract)
      : null;

  // Buying power fields
  const nlv = accountSummary.netLiquidatingValue;
  const buyingPowerAvailable = accountSummary.optionBuyingPower;
  const buyingPowerUsed = nlv - buyingPowerAvailable;
  const buyingPowerUtilization = nlv > 0 ? round2(buyingPowerUsed / nlv) : 0;
  const canAbsorbMaxLoss = buyingPowerAvailable > totalMaxLoss;

  // Concentration: largest single spread maxLoss / totalMaxLoss
  let largestMaxLoss = 0;
  for (const spread of spreads) {
    if (spread.maxLoss > largestMaxLoss) {
      largestMaxLoss = spread.maxLoss;
    }
  }
  for (const ic of ironCondors) {
    if (ic.maxLoss > largestMaxLoss) {
      largestMaxLoss = ic.maxLoss;
    }
  }
  const concentration =
    totalMaxLoss > 0 ? round2(largestMaxLoss / totalMaxLoss) : 0;

  return {
    callSideRisk: round2(callSideRisk),
    putSideRisk: round2(putSideRisk),
    callHedgeValue: round2(callHedgeValue),
    putHedgeValue: round2(putHedgeValue),
    netCallRisk: round2(netCallRisk),
    netPutRisk: round2(netPutRisk),
    totalMaxLoss: round2(totalMaxLoss),
    totalCredit: round2(totalCredit),
    totalContracts,
    spotPrice,
    nearestShortStrikeDistance: round2(nearestDistance),
    nakedCount: naked.length,
    breakevenLow,
    breakevenHigh,
    buyingPowerUsed: round2(buyingPowerUsed),
    buyingPowerAvailable: round2(buyingPowerAvailable),
    buyingPowerUtilization,
    canAbsorbMaxLoss,
    concentration,
  };
}

// ── Execution Quality ──────────────────────────────────────

export function computeExecutionQuality(
  orders: OrderEntry[],
  trades: ExecutedTrade[],
): ExecutionQuality {
  const fills: SlippageEntry[] = [];

  // Match orders to fills for slippage calculation
  for (const trade of trades) {
    const matchingOrder = findMatchingOrder(trade, orders);

    if (matchingOrder && matchingOrder.price > 0) {
      const slippage = trade.netPrice - matchingOrder.price;
      const primaryLeg = trade.legs[0];

      if (primaryLeg) {
        fills.push({
          orderTime: matchingOrder.timePlaced,
          fillTime: trade.execTime,
          symbol: primaryLeg.symbol,
          strike: primaryLeg.strike,
          type: primaryLeg.type,
          spread: trade.spread,
          limitPrice: matchingOrder.price,
          fillPrice: trade.netPrice,
          slippage: round2(slippage),
          contracts: primaryLeg.qty,
        });
      }
    }
  }

  const totalSlippage = fills.reduce((sum, f) => sum + f.slippage, 0);
  const avgSlippage = fills.length > 0 ? totalSlippage / fills.length : 0;

  // Total slippage in dollars
  const totalSlippageDollars = fills.reduce(
    (sum, f) => sum + f.slippage * MULTIPLIER * f.contracts,
    0,
  );

  // Count order outcomes
  const filledOrders = orders.filter((o) => o.status.includes('FILLED')).length;
  const rejectedOrders = orders.filter((o) => o.status === 'REJECTED').length;
  const canceledOrders = orders.filter((o) =>
    o.status.includes('CANCELED'),
  ).length;
  const totalOrders = orders.length;
  const fillRate = totalOrders > 0 ? filledOrders / totalOrders : 0;

  // Count replacement chains
  const replacementChains = orders.filter((o) => o.isReplacement).length;

  // Rejection & cancellation rates
  const rejectionRate =
    totalOrders > 0 ? round2(rejectedOrders / totalOrders) : 0;
  const cancellationRate =
    totalOrders > 0 ? round2(canceledOrders / totalOrders) : 0;

  // Rejection reasons grouped by statusDetail
  const reasonCounts = new Map<string, number>();
  for (const order of orders) {
    if (order.status === 'REJECTED' && order.statusDetail) {
      const reason = order.statusDetail;
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }
  const rejectionReasons: RejectionReason[] = [];
  for (const [reason, count] of reasonCounts) {
    rejectionReasons.push({ reason, count });
  }
  rejectionReasons.sort((a, b) => b.count - a.count);

  // Trade timing
  let firstTradeTime: string | null = null;
  let lastTradeTime: string | null = null;
  if (trades.length > 0) {
    const sorted = [...trades].sort((a, b) => {
      const ta = new Date(a.execTime).getTime();
      const tb = new Date(b.execTime).getTime();
      return ta - tb;
    });
    firstTradeTime = sorted[0]!.execTime;
    lastTradeTime = sorted.at(-1)!.execTime;
  }

  let tradingSessionMinutes: number | null = null;
  let tradesPerHour: number | null = null;
  if (firstTradeTime && lastTradeTime) {
    const firstMs = new Date(firstTradeTime).getTime();
    const lastMs = new Date(lastTradeTime).getTime();
    if (!Number.isNaN(firstMs) && !Number.isNaN(lastMs)) {
      const diffMs = lastMs - firstMs;
      tradingSessionMinutes = Math.round(diffMs / 60_000);
      const hours = diffMs / 3_600_000;
      tradesPerHour = hours > 0 ? round2(trades.length / hours) : null;
    }
  }

  return {
    fills,
    averageSlippage: round2(avgSlippage),
    totalSlippageDollars: round2(totalSlippageDollars),
    fillRate: round2(fillRate),
    rejectedOrders,
    canceledOrders,
    replacementChains,
    rejectionRate,
    cancellationRate,
    rejectionReasons,
    firstTradeTime,
    lastTradeTime,
    tradingSessionMinutes,
    tradesPerHour,
  };
}

/**
 * Try to match an executed trade to its originating order.
 * Match by: closest time before fill, same spread type,
 * and matching leg strikes/types.
 */
function findMatchingOrder(
  trade: ExecutedTrade,
  orders: OrderEntry[],
): OrderEntry | null {
  const tradeLeg = trade.legs[0];
  if (!tradeLeg) return null;

  let bestMatch: OrderEntry | null = null;
  let bestTimeDiff = Infinity;

  for (const order of orders) {
    if (!order.status.includes('FILLED')) continue;
    if (order.spread !== trade.spread) continue;

    // Check if any order leg matches the primary trade leg
    const hasMatch = order.legs.some(
      (ol) =>
        ol.strike === tradeLeg.strike &&
        ol.type === tradeLeg.type &&
        ol.side === tradeLeg.side,
    );
    if (!hasMatch) continue;

    // Prefer closest time
    const orderTime = new Date(order.timePlaced).getTime();
    const tradeTime = new Date(trade.execTime).getTime();
    const diff = Math.abs(tradeTime - orderTime);

    if (diff < bestTimeDiff) {
      bestTimeDiff = diff;
      bestMatch = order;
    }
  }

  return bestMatch;
}

// ── Data Quality Warnings ──────────────────────────────────

export function generateWarnings(
  cashEntries: CashEntry[],
  openLegs: OpenLeg[],
  hasMark: boolean,
  pnl: PnLSummary,
  naked: NakedPosition[],
  sections: Map<string, SectionBounds>,
  spreads: Spread[],
  ironCondors: IronCondor[],
): DataQualityWarning[] {
  const warnings: DataQualityWarning[] = [];

  // Always emit PAPER_TRADING
  warnings.push(
    makeWarning(
      'PAPER_TRADING',
      'info',
      'This data is from a paperMoney account.' + ' Results are simulated.',
    ),
  );

  // MISSING_MARK
  if (!hasMark && openLegs.length > 0) {
    warnings.push(
      makeWarning(
        'MISSING_MARK',
        'warn',
        'Options section lacks Mark/Mark Value columns.' +
          ' Current market values unavailable.',
      ),
    );
  }

  // UNMATCHED_SHORT
  for (const n of naked) {
    const msg =
      `Naked short ${n.type} at strike ` +
      `${n.leg.strike} (${n.contracts} contracts).` +
      ' No matching long leg found.';
    warnings.push(
      makeWarning(
        'UNMATCHED_SHORT',
        'error',
        msg,
        `Option code: ${n.leg.optionCode}`,
      ),
    );
  }

  // BALANCE_DISCONTINUITY
  for (let i = 1; i < cashEntries.length; i++) {
    const prev = cashEntries[i - 1]!;
    const curr = cashEntries[i]!;
    if (curr.type === 'BAL') continue;

    const expectedBalance =
      prev.balance + curr.amount + curr.miscFees + curr.commissions;
    const diff = Math.abs(expectedBalance - curr.balance);

    if (diff > 0.02) {
      const expected = expectedBalance.toFixed(2);
      const actual = curr.balance.toFixed(2);
      const diffStr = diff.toFixed(2);
      const detail =
        `Expected ${expected}, got ${actual}` + ` (diff: ${diffStr})`;
      warnings.push(
        makeWarning(
          'BALANCE_DISCONTINUITY',
          'warn',
          `Balance mismatch after ${curr.type}` + ` at ${curr.time}.`,
          detail,
        ),
      );
    }
  }

  // MISSING_SECTION
  const expectedSections = [
    'Cash Balance',
    'Account Order History',
    'Account Trade History',
    'Options',
    'Profits and Losses',
    'Account Summary',
  ];
  for (const name of expectedSections) {
    if (!sections.has(name)) {
      warnings.push(
        makeWarning(
          'MISSING_SECTION',
          'warn',
          `Expected section "${name}" not found in CSV.`,
        ),
      );
    }
  }

  // PNL_MISMATCH — compare computed credit to P&L section
  if (pnl.totals) {
    let computedOpenPnl = 0;
    for (const spread of spreads) {
      computedOpenPnl += spread.creditReceived;
    }
    for (const ic of ironCondors) {
      computedOpenPnl += ic.totalCredit;
    }

    // Flag large discrepancies between reported and computed
    if (pnl.totals.markValue !== 0 && computedOpenPnl !== 0) {
      const reported = pnl.totals.plOpen;
      if (openLegs.length > 0 && Math.abs(reported) > computedOpenPnl * 5) {
        const reportedStr = reported.toFixed(2);
        warnings.push(
          makeWarning(
            'PNL_MISMATCH',
            'warn',
            `Reported P/L Open ($${reportedStr})` +
              ' may not match computed positions.',
            'This can happen if positions were' + ' opened on prior days.',
          ),
        );
      }
    }
  }

  return warnings;
}

function makeWarning(
  code: WarningCode,
  severity: WarningSeverity,
  message: string,
  detail?: string,
): DataQualityWarning {
  return detail
    ? { code, severity, message, detail }
    : { code, severity, message };
}

// ── Utilities ──────────────────────────────────────────────

/**
 * Compute hold time in minutes between two time strings.
 * Returns null if either time cannot be parsed.
 */
function computeHoldTime(openTime: string, closeTime: string): number | null {
  const openMs = new Date(openTime).getTime();
  const closeMs = new Date(closeTime).getTime();
  if (Number.isNaN(openMs) || Number.isNaN(closeMs)) return null;
  const diffMs = closeMs - openMs;
  if (diffMs < 0) return null;
  return Math.round(diffMs / 60_000);
}

/**
 * Classify a closed spread outcome based on realized P&L.
 */
function classifyOutcome(
  realizedPnl: number,
  openCreditDollars: number,
): ClosedSpreadOutcome {
  const scratchThreshold = openCreditDollars * 0.05;
  if (Math.abs(realizedPnl) <= scratchThreshold) return 'SCRATCH';
  if (realizedPnl < 0) return 'LOSS';
  if (realizedPnl >= openCreditDollars * 0.95) return 'FULL_PROFIT';
  return 'PARTIAL_PROFIT';
}

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

// ── Black-Scholes P&L Estimation ────────────────────────

/**
 * Parse a time string like "3/27/26 09:29:13" or "09:29:13" to
 * minutes since midnight for time comparison.
 */
function timeToMinutes(t: string): number {
  const match = t.match(/(\d{1,2}):(\d{2})/);
  if (!match) return 0;
  return Number.parseInt(match[1]!, 10) * 60 + Number.parseInt(match[2]!, 10);
}

/** 0DTE market session: 8:30 CT to 15:00 CT = 390 minutes */
const SESSION_START_MIN = 8 * 60 + 30; // 8:30 CT
const SESSION_END_MIN = 15 * 60; // 15:00 CT
const SESSION_LENGTH_MIN = SESSION_END_MIN - SESSION_START_MIN;

/**
 * Re-estimate open P&L using sqrt-time theta decay.
 *
 * For 0DTE credit spreads, BS with flat vol doesn't reproduce
 * actual market prices (extreme skew, gamma dynamics). Instead,
 * use the entry spread price as baseline and decay it toward 0
 * using sqrt(time_remaining / time_at_entry).
 *
 * This gives intuitive results:
 * - At entry time: spread worth full entry price → 0% max profit
 * - Midway through: worth ~70% of entry → ~30% captured
 * - Near close: worth ~0 → ~100% captured
 */
export function applyBSEstimates(
  statement: DailyStatement,
  _calculatorSpot: number,
  _sigma: number,
  T: number,
): DailyStatement {
  // Convert calculator T to minutes remaining in the session.
  // T is fraction of a year. The calculator computes it from
  // hours remaining, so we can back it out.
  // T = hoursRemaining / (365.25 * 24) approximately, but
  // the calculator may use trading hours. Use T directly
  // to derive a decay ratio.
  const hoursRemaining = T * 365.25 * 24;
  const minutesRemaining = hoursRemaining * 60;
  const currentMinute =
    SESSION_END_MIN - Math.min(minutesRemaining, SESSION_LENGTH_MIN);

  const decaySpread = (s: Spread): Spread => {
    // Use matched trade entry price, or fall back to the
    // difference of leg trade prices from the Options section
    const netPrice =
      s.entryNetPrice ?? Math.abs(s.shortLeg.tradePrice - s.longLeg.tradePrice);
    if (netPrice <= 0) return s;

    // Find when this spread was entered (minutes since midnight)
    const entryMin = s.entryTime
      ? timeToMinutes(s.entryTime)
      : SESSION_START_MIN;

    // Minutes remaining at entry vs now
    const entryRemaining = Math.max(SESSION_END_MIN - entryMin, 1);
    const nowRemaining = Math.max(SESSION_END_MIN - currentMinute, 0);

    // If the calculator time is before this position was entered,
    // the position doesn't exist yet — show full entry value
    if (currentMinute < entryMin) {
      return {
        ...s,
        currentValue: s.creditReceived,
        openPnl: 0,
        pctOfMaxProfit: 0,
      };
    }

    // Sqrt-time decay: value decays with sqrt of time remaining
    const decayFactor = Math.sqrt(nowRemaining / entryRemaining);
    const estimatedSpreadPrice = round2(netPrice * decayFactor);
    const contracts = s.contracts;
    const currentValue = round2(estimatedSpreadPrice * contracts * 100);
    const openPnl = round2(s.creditReceived - currentValue);
    const pctOfMaxProfit =
      s.maxProfit > 0
        ? round2(Math.min(100, (openPnl / s.maxProfit) * 100))
        : null;

    return {
      ...s,
      currentValue,
      openPnl,
      pctOfMaxProfit,
    };
  };

  const spreads = statement.spreads.map(decaySpread);

  const ironCondors = statement.ironCondors.map((ic) => {
    const putSpread = decaySpread(ic.putSpread);
    const callSpread = decaySpread(ic.callSpread);
    return { ...ic, putSpread, callSpread };
  });

  const hedges = statement.hedges.map((h) => {
    // For hedges (long options), value also decays with sqrt-time
    if (h.entryCost <= 0) return h;
    const entryMin = SESSION_START_MIN; // approximate
    const entryRemaining = Math.max(SESSION_END_MIN - entryMin, 1);
    const nowRemaining = Math.max(SESSION_END_MIN - currentMinute, 0);
    const decayFactor = Math.sqrt(nowRemaining / entryRemaining);
    const currentValue = round2(h.entryCost * decayFactor);
    const openPnl = round2(currentValue - h.entryCost);
    return { ...h, currentValue, openPnl };
  });

  // Recompute portfolio risk with decay-adjusted positions
  const portfolioRisk = computePortfolioRisk(
    spreads,
    ironCondors,
    hedges,
    statement.nakedPositions as NakedPosition[],
    statement.accountSummary,
    statement.pnl,
    _calculatorSpot,
  );

  // Compute aggregate open P&L from decay-adjusted spreads
  let totalOpenPnl = 0;
  for (const s of spreads) {
    if (s.openPnl != null) totalOpenPnl += s.openPnl;
  }
  for (const ic of ironCondors) {
    if (ic.putSpread.openPnl != null) totalOpenPnl += ic.putSpread.openPnl;
    if (ic.callSpread.openPnl != null) totalOpenPnl += ic.callSpread.openPnl;
  }
  for (const h of hedges) {
    if (h.openPnl != null) totalOpenPnl += h.openPnl;
  }

  // Build updated P&L summary reflecting decay estimates
  const decayPnl: PnLSummary = {
    entries: statement.pnl.entries,
    totals: statement.pnl.totals
      ? {
          ...statement.pnl.totals,
          plOpen: round2(totalOpenPnl),
          plDay: round2(totalOpenPnl),
        }
      : null,
  };

  return {
    ...statement,
    spreads,
    ironCondors,
    hedges,
    portfolioRisk,
    pnl: decayPnl,
  };
}
