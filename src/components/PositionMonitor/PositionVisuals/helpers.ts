import type {
  ExecutedTrade,
  HedgePosition,
  IronCondor,
  NakedPosition,
  PortfolioRisk,
  Spread,
} from '../types';

export interface PositionVisualsProps {
  spreads: readonly Spread[];
  ironCondors: readonly IronCondor[];
  hedges: readonly HedgePosition[];
  nakedPositions: readonly NakedPosition[];
  trades: readonly ExecutedTrade[];
  portfolioRisk: PortfolioRisk;
  spotPrice: number;
}

export function fmtK(v: number): string {
  if (Math.abs(v) >= 1000) {
    return `$${(v / 1000).toFixed(1)}k`;
  }
  return `$${v.toLocaleString('en-US', {
    maximumFractionDigits: 0,
  })}`;
}

export function fmtStrike(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function fmtTime(t: string): string {
  // "3/27/26 09:30:00" → "09:30" or "09:30:00" → "09:30"
  const match = t.match(/(\d{1,2}:\d{2})/);
  return match?.[1] ?? t;
}
