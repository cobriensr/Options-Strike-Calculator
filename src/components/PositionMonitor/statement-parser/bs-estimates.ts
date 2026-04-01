import type {
  DailyStatement,
  NakedPosition,
  PnLSummary,
  Spread,
} from '../types';
import { round2 } from '../../../utils/formatting';
import { computePortfolioRisk } from './portfolio-risk';

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
