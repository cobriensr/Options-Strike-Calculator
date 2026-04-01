import type {
  ClosedSpread,
  ClosedSpreadOutcome,
  ExecutedTrade,
  TradeLeg,
} from '../types';
import { round2 } from '../../../utils/formatting';
import { SPX_MULTIPLIER as MULTIPLIER } from '../../../constants';

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
