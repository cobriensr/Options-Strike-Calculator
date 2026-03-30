import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import PortfolioRiskSummary from '../../components/PositionMonitor/PortfolioRiskSummary';
import type {
  AccountSummary,
  HedgePosition,
  IronCondor,
  OpenLeg,
  PortfolioRisk,
  Spread,
} from '../../components/PositionMonitor/types';

// ── Factories ────────────────────────────────────────────────

function makeLeg(
  overrides: Partial<OpenLeg> & Pick<OpenLeg, 'strike' | 'type' | 'qty'>,
): OpenLeg {
  return {
    symbol: 'SPX',
    optionCode: `SPXW260327${overrides.type === 'PUT' ? 'P' : 'C'}${String(overrides.strike)}`,
    exp: '2026-03-27',
    tradePrice: 0,
    mark: null,
    markValue: null,
    ...overrides,
  };
}

function makeSpread(overrides: Partial<Spread> = {}): Spread {
  return {
    spreadType: 'PUT_CREDIT_SPREAD',
    shortLeg: makeLeg({ strike: 5600, type: 'PUT', qty: -10, tradePrice: 3.5 }),
    longLeg: makeLeg({ strike: 5580, type: 'PUT', qty: 10, tradePrice: 2.0 }),
    contracts: 10,
    wingWidth: 20,
    creditReceived: 1500,
    maxProfit: 1500,
    maxLoss: 18500,
    riskRewardRatio: 12.33,
    breakeven: 5598.5,
    entryTime: null,
    entryNetPrice: null,
    currentValue: null,
    openPnl: null,
    pctOfMaxProfit: null,
    distanceToShortStrike: 100,
    distanceToShortStrikePct: 1.75,
    nearestShortStrike: 5600,
    entryCommissions: 13,
    ...overrides,
  };
}

function makeIC(overrides: Partial<IronCondor> = {}): IronCondor {
  const putSpread = makeSpread({
    spreadType: 'PUT_CREDIT_SPREAD',
    shortLeg: makeLeg({ strike: 5600, type: 'PUT', qty: -10 }),
    longLeg: makeLeg({ strike: 5580, type: 'PUT', qty: 10 }),
  });
  const callSpread = makeSpread({
    spreadType: 'CALL_CREDIT_SPREAD',
    shortLeg: makeLeg({ strike: 5800, type: 'CALL', qty: -10 }),
    longLeg: makeLeg({ strike: 5820, type: 'CALL', qty: 10 }),
    creditReceived: 1000,
    maxLoss: 19000,
  });
  return {
    spreadType: 'IRON_CONDOR',
    putSpread,
    callSpread,
    contracts: 10,
    totalCredit: 2500,
    maxProfit: 2500,
    maxLoss: 17500,
    riskRewardRatio: 7,
    breakevenLow: 5597.5,
    breakevenHigh: 5802.5,
    putWingWidth: 20,
    callWingWidth: 20,
    entryTime: null,
    ...overrides,
  };
}

function makeHedge(overrides: Partial<HedgePosition> = {}): HedgePosition {
  return {
    leg: makeLeg({ strike: 5500, type: 'PUT', qty: 5, tradePrice: 0.5 }),
    direction: 'LONG',
    protectionSide: 'PUT',
    strikeProtected: 5500,
    contracts: 5,
    entryCost: 250,
    currentValue: null,
    openPnl: null,
    ...overrides,
  };
}

function makeRisk(overrides: Partial<PortfolioRisk> = {}): PortfolioRisk {
  return {
    callSideRisk: 19000,
    putSideRisk: 18500,
    callHedgeValue: 0,
    putHedgeValue: 0,
    netCallRisk: 19000,
    netPutRisk: 18500,
    totalMaxLoss: 19000,
    totalCredit: 2500,
    totalContracts: 20,
    spotPrice: 5700,
    nearestShortStrikeDistance: 100,
    nakedCount: 0,
    breakevenLow: 5597.5,
    breakevenHigh: 5802.5,
    buyingPowerUsed: 20000,
    buyingPowerAvailable: 80000,
    buyingPowerUtilization: 0.2,
    canAbsorbMaxLoss: true,
    concentration: 0.65,
    ...overrides,
  };
}

function makeAccount(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    netLiquidatingValue: 100000,
    stockBuyingPower: 80000,
    optionBuyingPower: 80000,
    equityCommissionsYtd: 50,
    ...overrides,
  };
}

// ── Render helper ────────────────────────────────────────────

function renderSummary(
  overrides: {
    risk?: Partial<PortfolioRisk>;
    account?: Partial<AccountSummary>;
    spreads?: Spread[];
    ironCondors?: IronCondor[];
    hedges?: HedgePosition[];
  } = {},
) {
  return render(
    <PortfolioRiskSummary
      risk={makeRisk(overrides.risk)}
      accountSummary={makeAccount(overrides.account)}
      spreads={overrides.spreads ?? [makeSpread()]}
      ironCondors={overrides.ironCondors ?? []}
      hedges={overrides.hedges ?? []}
    />,
  );
}

// ── Tests ────────────────────────────────────────────────────

describe('PortfolioRiskSummary', () => {
  it('renders the portfolio risk summary region', () => {
    renderSummary();
    expect(
      screen.getByRole('region', { name: 'Portfolio risk summary' }),
    ).toBeInTheDocument();
  });

  // ── Card labels ──────────────────────────────────────────

  it('renders all eight card labels', () => {
    renderSummary();
    expect(screen.getByText('Total Max Loss')).toBeInTheDocument();
    expect(screen.getByText('Total Credit')).toBeInTheDocument();
    expect(screen.getByText('Portfolio Heat')).toBeInTheDocument();
    expect(screen.getByText('Buying Power')).toBeInTheDocument();
    expect(screen.getByText('Risk Boundaries')).toBeInTheDocument();
    expect(screen.getByText('Breakeven Range')).toBeInTheDocument();
    expect(screen.getByText('Side Breakdown')).toBeInTheDocument();
    expect(screen.getByText('Can Absorb')).toBeInTheDocument();
  });

  // ── Total Max Loss ───────────────────────────────────────

  it('displays total max loss with currency formatting', () => {
    renderSummary({ risk: { totalMaxLoss: 19000 } });
    const card = screen
      .getByText('Total Max Loss')
      .closest('div')!.parentElement!;
    expect(within(card).getByText('$19,000.00')).toBeInTheDocument();
  });

  it('shows negative total max loss in parentheses', () => {
    renderSummary({ risk: { totalMaxLoss: -19000 } });
    expect(screen.getByText('($19,000.00)')).toBeInTheDocument();
  });

  it('shows portfolio heat percentage in sub text', () => {
    renderSummary({
      risk: { totalMaxLoss: 19000 },
      account: { netLiquidatingValue: 100000 },
    });
    expect(screen.getByText('19.0% of NLV')).toBeInTheDocument();
  });

  // ── Total Credit ─────────────────────────────────────────

  it('displays total credit and contracts count', () => {
    renderSummary({ risk: { totalCredit: 2500, totalContracts: 20 } });
    expect(screen.getByText('$2,500.00')).toBeInTheDocument();
    expect(screen.getByText('20 contracts')).toBeInTheDocument();
  });

  // ── Portfolio Heat ───────────────────────────────────────

  it('displays portfolio heat percentage', () => {
    renderSummary({
      risk: { totalMaxLoss: 10000 },
      account: { netLiquidatingValue: 100000 },
    });
    // 10000 / 100000 * 100 = 10.0%
    expect(screen.getByText('10.0%')).toBeInTheDocument();
  });

  it('shows 0.0% heat when NLV is zero', () => {
    renderSummary({
      risk: { totalMaxLoss: 10000 },
      account: { netLiquidatingValue: 0 },
    });
    expect(screen.getByText('0.0%')).toBeInTheDocument();
  });

  // ── Heat color logic ─────────────────────────────────────

  it('applies danger color when heat exceeds 25%', () => {
    renderSummary({
      risk: { totalMaxLoss: 30000 },
      account: { netLiquidatingValue: 100000 },
    });
    // 30% of NLV — text-danger
    const maxLossText = screen.getByText('$30,000.00');
    expect(maxLossText.className).toContain('text-danger');
  });

  it('applies caution color when heat is between 10% and 25%', () => {
    renderSummary({
      risk: { totalMaxLoss: 15000 },
      account: { netLiquidatingValue: 100000 },
    });
    // 15% of NLV — text-caution
    const maxLossText = screen.getByText('$15,000.00');
    expect(maxLossText.className).toContain('text-caution');
  });

  it('applies success color when heat is below 10%', () => {
    renderSummary({
      risk: { totalMaxLoss: 5000 },
      account: { netLiquidatingValue: 100000 },
    });
    // 5% of NLV — text-success
    const maxLossText = screen.getByText('$5,000.00');
    expect(maxLossText.className).toContain('text-success');
  });

  // ── Buying Power ─────────────────────────────────────────

  it('displays buying power available', () => {
    renderSummary({ risk: { buyingPowerAvailable: 80000 } });
    expect(screen.getByText('$80,000.00')).toBeInTheDocument();
  });

  it('shows buying power utilization percentage', () => {
    renderSummary({
      risk: { buyingPowerUsed: 20000, buyingPowerAvailable: 80000 },
    });
    // 20000 / (20000 + 80000) * 100 = 20.0%
    expect(screen.getByText('20.0% utilized')).toBeInTheDocument();
  });

  it('shows 0.0% utilization when total BP is zero', () => {
    renderSummary({
      risk: { buyingPowerUsed: 0, buyingPowerAvailable: 0 },
    });
    expect(screen.getByText('0.0% utilized')).toBeInTheDocument();
  });

  // ── Risk Boundaries ──────────────────────────────────────

  it('displays lowest put strike from spreads', () => {
    const pcs = makeSpread({
      spreadType: 'PUT_CREDIT_SPREAD',
      shortLeg: makeLeg({ strike: 5600, type: 'PUT', qty: -10 }),
    });
    renderSummary({ spreads: [pcs], risk: { spotPrice: 5700 } });
    expect(screen.getByText('5600')).toBeInTheDocument();
  });

  it('displays highest call strike from spreads', () => {
    const ccs = makeSpread({
      spreadType: 'CALL_CREDIT_SPREAD',
      shortLeg: makeLeg({ strike: 5800, type: 'CALL', qty: -10 }),
      longLeg: makeLeg({ strike: 5820, type: 'CALL', qty: 10 }),
    });
    renderSummary({ spreads: [ccs], risk: { spotPrice: 5700 } });
    expect(screen.getByText('5800')).toBeInTheDocument();
  });

  it('shows em-dash when no put spreads exist', () => {
    const ccs = makeSpread({
      spreadType: 'CALL_CREDIT_SPREAD',
      shortLeg: makeLeg({ strike: 5800, type: 'CALL', qty: -10 }),
      longLeg: makeLeg({ strike: 5820, type: 'CALL', qty: 10 }),
    });
    renderSummary({ spreads: [ccs], ironCondors: [] });
    // The card's parent div (bg-surface-alt) contains all content
    const card = screen
      .getByText('Risk Boundaries')
      .closest('.bg-surface-alt')!;
    expect(card.textContent).toContain('\u2014');
  });

  it('includes IC short strikes in risk boundaries', () => {
    const ic = makeIC();
    renderSummary({ spreads: [], ironCondors: [ic] });
    // Put side: 5600 from IC
    expect(screen.getByText('5600')).toBeInTheDocument();
    // Call side: 5800 from IC
    expect(screen.getByText('5800')).toBeInTheDocument();
  });

  // ── Breakeven Range ──────────────────────────────────────

  it('displays breakeven low and high', () => {
    renderSummary({
      risk: { breakevenLow: 5597.5, breakevenHigh: 5802.5 },
    });
    expect(screen.getByText('5597.50')).toBeInTheDocument();
    expect(screen.getByText('5802.50')).toBeInTheDocument();
  });

  it('shows em-dash for null breakeven values', () => {
    renderSummary({
      risk: { breakevenLow: null, breakevenHigh: null },
    });
    const card = screen
      .getByText('Breakeven Range')
      .closest('.bg-surface-alt')!;
    const spans = card.querySelectorAll('span');
    const dashTexts = Array.from(spans)
      .map((s) => s.textContent)
      .filter((t) => t === '\u2014');
    expect(dashTexts.length).toBeGreaterThanOrEqual(2);
  });

  // ── Side Breakdown ───────────────────────────────────────

  it('displays PUT and CALL labels in side breakdown', () => {
    renderSummary();
    expect(screen.getByText('PUT')).toBeInTheDocument();
    expect(screen.getByText('CALL')).toBeInTheDocument();
  });

  it('displays net risk values for each side', () => {
    renderSummary({
      risk: { netPutRisk: 14200, netCallRisk: 15300 },
    });
    const card = screen
      .getByText('Side Breakdown')
      .closest('.bg-surface-alt') as HTMLElement;
    expect(within(card).getByText('$14,200.00')).toBeInTheDocument();
    expect(within(card).getByText('$15,300.00')).toBeInTheDocument();
  });

  it('shows hedge count in side breakdown subtitle', () => {
    renderSummary({ hedges: [makeHedge()] });
    expect(screen.getByText('Net risk by side (1 hedge)')).toBeInTheDocument();
  });

  it('pluralizes hedge count when multiple hedges', () => {
    renderSummary({ hedges: [makeHedge(), makeHedge()] });
    expect(screen.getByText('Net risk by side (2 hedges)')).toBeInTheDocument();
  });

  it('shows no hedge suffix when no hedges exist', () => {
    renderSummary({ hedges: [] });
    expect(screen.getByText('Net risk by side')).toBeInTheDocument();
  });

  // ── Can Absorb ───────────────────────────────────────────

  it('shows Yes when BP can absorb max loss', () => {
    renderSummary({ risk: { canAbsorbMaxLoss: true } });
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });

  it('shows No when BP cannot absorb max loss', () => {
    renderSummary({ risk: { canAbsorbMaxLoss: false } });
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('applies success color when can absorb', () => {
    renderSummary({ risk: { canAbsorbMaxLoss: true } });
    const yesText = screen.getByText('Yes');
    expect(yesText.className).toContain('text-success');
  });

  it('applies danger color when cannot absorb', () => {
    renderSummary({ risk: { canAbsorbMaxLoss: false } });
    const noText = screen.getByText('No');
    expect(noText.className).toContain('text-danger');
  });

  // ── Distance percentages in risk boundaries ──────────────

  it('shows put distance percentage from spot', () => {
    const pcs = makeSpread({
      spreadType: 'PUT_CREDIT_SPREAD',
      shortLeg: makeLeg({ strike: 5600, type: 'PUT', qty: -10 }),
    });
    // (5700 - 5600) / 5700 * 100 = 1.8%
    renderSummary({
      spreads: [pcs],
      ironCondors: [],
      risk: { spotPrice: 5700 },
    });
    expect(screen.getByText('(1.8%)')).toBeInTheDocument();
  });
});
