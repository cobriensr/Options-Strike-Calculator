import type {
  ExecutedTrade,
  ExecutionQuality,
  OrderEntry,
  RejectionReason,
  SlippageEntry,
} from '../types';
import { round2 } from '../../../utils/formatting';
import { SPX_MULTIPLIER as MULTIPLIER } from '../../../constants';

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
  const filledOrders = orders.filter((o) =>
    o.status.includes('FILLED'),
  ).length;
  const rejectedOrders = orders.filter(
    (o) => o.status === 'REJECTED',
  ).length;
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
