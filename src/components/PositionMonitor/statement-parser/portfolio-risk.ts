import type {
  AccountSummary,
  HedgePosition,
  IronCondor,
  NakedPosition,
  PnLSummary,
  PortfolioRisk,
  Spread,
} from '../types';
import { round2 } from '../../../utils/formatting';
import { SPX_MULTIPLIER as MULTIPLIER } from '../../../constants';

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
    const putCredit =
      ic.putSpread.creditReceived / (ic.contracts * MULTIPLIER);
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
