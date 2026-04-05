/**
 * Position grouping: build vertical spreads, iron condors,
 * hedges, and naked positions from parsed option legs
 * and trade history.
 */

import type {
  CashEntry,
  ExecutedTrade,
  HedgePosition,
  IronCondor,
  NakedPosition,
  OpenLeg,
  Spread,
  SpreadType,
} from '../types';
import { SPX_MULTIPLIER as MULTIPLIER } from '../../../constants';
import { round2 } from '../../../utils/formatting';

// ── Position Grouping ──────────────────────────────────────

export interface GroupResult {
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
    const trade = openTrades[ti];
    if (!trade) continue;
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
    const pcs = tradePCS[p];
    if (!pcs) continue;

    for (let c = 0; c < tradeCCS.length; c++) {
      if (usedCCS.has(c)) continue;
      const ccs = tradeCCS[c];
      if (!ccs) continue;

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
    const pcs = tradePCS[p];
    if (!usedPCS.has(p) && pcs) allSpreads.push(pcs.spread);
  }
  for (let c = 0; c < tradeCCS.length; c++) {
    const ccs = tradeCCS[c];
    if (!usedCCS.has(c) && ccs) allSpreads.push(ccs.spread);
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
