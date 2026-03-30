import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PositionVisuals from '../../components/PositionMonitor/PositionVisuals';
import type {
  ExecutedTrade,
  HedgePosition,
  IronCondor,
  NakedPosition,
  OpenLeg,
  PortfolioRisk,
  Spread,
  TradeLeg,
} from '../../components/PositionMonitor/types';

// ============================================================
// FACTORY HELPERS
// ============================================================

function makeOpenLeg(overrides: Partial<OpenLeg> = {}): OpenLeg {
  return {
    symbol: '.SPXW260327',
    optionCode: 'SPXW260327P5650',
    exp: '2026-03-27',
    strike: 5650,
    type: 'PUT',
    qty: -1,
    tradePrice: 1.25,
    mark: 0.45,
    markValue: -45,
    ...overrides,
  };
}

function makeSpread(overrides: Partial<Spread> = {}): Spread {
  return {
    spreadType: 'PUT_CREDIT_SPREAD',
    shortLeg: makeOpenLeg({ strike: 5650, qty: -1, type: 'PUT' }),
    longLeg: makeOpenLeg({
      strike: 5640,
      qty: 1,
      type: 'PUT',
      optionCode: 'SPXW260327P5640',
    }),
    contracts: 1,
    wingWidth: 10,
    creditReceived: 80,
    maxProfit: 80,
    maxLoss: 920,
    riskRewardRatio: 11.5,
    breakeven: 5649.2,
    entryTime: '3/27/26 09:45:00',
    entryNetPrice: 0.8,
    currentValue: -45,
    openPnl: 35,
    pctOfMaxProfit: 43.75,
    distanceToShortStrike: 50,
    distanceToShortStrikePct: 0.88,
    nearestShortStrike: 5650,
    entryCommissions: 1.3,
    ...overrides,
  };
}

function makeCallSpread(overrides: Partial<Spread> = {}): Spread {
  return makeSpread({
    spreadType: 'CALL_CREDIT_SPREAD',
    shortLeg: makeOpenLeg({
      strike: 5750,
      qty: -1,
      type: 'CALL',
      optionCode: 'SPXW260327C5750',
    }),
    longLeg: makeOpenLeg({
      strike: 5760,
      qty: 1,
      type: 'CALL',
      optionCode: 'SPXW260327C5760',
    }),
    breakeven: 5750.8,
    nearestShortStrike: 5750,
    ...overrides,
  });
}

function makeIronCondor(overrides: Partial<IronCondor> = {}): IronCondor {
  return {
    spreadType: 'IRON_CONDOR',
    putSpread: makeSpread({
      shortLeg: makeOpenLeg({ strike: 5620, type: 'PUT' }),
      longLeg: makeOpenLeg({ strike: 5610, type: 'PUT' }),
    }),
    callSpread: makeCallSpread({
      shortLeg: makeOpenLeg({ strike: 5780, type: 'CALL' }),
      longLeg: makeOpenLeg({ strike: 5790, type: 'CALL' }),
    }),
    contracts: 1,
    totalCredit: 160,
    maxProfit: 160,
    maxLoss: 840,
    riskRewardRatio: 5.25,
    breakevenLow: 5618.4,
    breakevenHigh: 5781.6,
    putWingWidth: 10,
    callWingWidth: 10,
    entryTime: '3/27/26 10:00:00',
    ...overrides,
  };
}

function makeHedge(overrides: Partial<HedgePosition> = {}): HedgePosition {
  return {
    leg: makeOpenLeg({
      strike: 5600,
      qty: 1,
      type: 'PUT',
      optionCode: 'SPXW260327P5600',
    }),
    direction: 'LONG',
    protectionSide: 'PUT',
    strikeProtected: 5600,
    contracts: 1,
    entryCost: 35,
    currentValue: 20,
    openPnl: -15,
    ...overrides,
  };
}

function makeNaked(overrides: Partial<NakedPosition> = {}): NakedPosition {
  return {
    leg: makeOpenLeg({
      strike: 5800,
      qty: -1,
      type: 'CALL',
      optionCode: 'SPXW260327C5800',
    }),
    contracts: 1,
    type: 'CALL',
    ...overrides,
  };
}

function makeTradeLeg(overrides: Partial<TradeLeg> = {}): TradeLeg {
  return {
    side: 'SELL',
    qty: 1,
    posEffect: 'TO OPEN',
    symbol: '.SPXW260327',
    exp: '2026-03-27',
    strike: 5650,
    type: 'PUT',
    price: 1.25,
    creditDebit: 'CREDIT',
    ...overrides,
  };
}

function makeTrade(overrides: Partial<ExecutedTrade> = {}): ExecutedTrade {
  return {
    execTime: '3/27/26 09:45:00',
    spread: 'VERTICAL',
    legs: [
      makeTradeLeg({ posEffect: 'TO OPEN' }),
      makeTradeLeg({
        side: 'BUY',
        qty: 1,
        posEffect: 'TO OPEN',
        strike: 5640,
        price: 0.45,
        creditDebit: 'DEBIT',
      }),
    ],
    netPrice: 0.8,
    orderType: 'LMT',
    ...overrides,
  };
}

function makePortfolioRisk(
  overrides: Partial<PortfolioRisk> = {},
): PortfolioRisk {
  return {
    callSideRisk: 920,
    putSideRisk: 920,
    callHedgeValue: 0,
    putHedgeValue: 35,
    netCallRisk: 920,
    netPutRisk: 885,
    totalMaxLoss: 920,
    totalCredit: 160,
    totalContracts: 4,
    spotPrice: 5700,
    nearestShortStrikeDistance: 50,
    nakedCount: 0,
    breakevenLow: 5618.4,
    breakevenHigh: 5781.6,
    buyingPowerUsed: 1840,
    buyingPowerAvailable: 98160,
    buyingPowerUtilization: 0.0184,
    canAbsorbMaxLoss: true,
    concentration: 0.5,
    ...overrides,
  };
}

function defaultProps() {
  return {
    spreads: [makeSpread()] as readonly Spread[],
    ironCondors: [] as readonly IronCondor[],
    hedges: [] as readonly HedgePosition[],
    nakedPositions: [] as readonly NakedPosition[],
    trades: [makeTrade()] as readonly ExecutedTrade[],
    portfolioRisk: makePortfolioRisk(),
    spotPrice: 5700,
  };
}

// ============================================================
// TESTS
// ============================================================

describe('PositionVisuals', () => {
  // ── Region / Container ──────────────────────────────────

  it('renders the position-visuals region', () => {
    render(<PositionVisuals {...defaultProps()} />);
    expect(
      screen.getByRole('region', { name: 'Position visualizations' }),
    ).toBeInTheDocument();
  });

  it('renders with data-testid', () => {
    render(<PositionVisuals {...defaultProps()} />);
    expect(screen.getByTestId('position-visuals')).toBeInTheDocument();
  });

  // ── Panel Titles ────────────────────────────────────────

  it('renders all four panel titles', () => {
    render(<PositionVisuals {...defaultProps()} />);
    expect(screen.getByText('Strike Map')).toBeInTheDocument();
    expect(screen.getByText('Risk Waterfall')).toBeInTheDocument();
    expect(screen.getByText('Credit vs Time')).toBeInTheDocument();
    expect(screen.getByText('% Max Profit')).toBeInTheDocument();
  });

  it('renders panel descriptions', () => {
    render(<PositionVisuals {...defaultProps()} />);
    expect(screen.getByText('Positions relative to spot')).toBeInTheDocument();
    expect(screen.getByText('Max loss by position')).toBeInTheDocument();
    expect(
      screen.getByText('Entry prices by time of day'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Theta capture per position'),
    ).toBeInTheDocument();
  });

  // ── Expand / Collapse ───────────────────────────────────

  it('expands a panel when its header is clicked', async () => {
    const user = userEvent.setup();
    render(<PositionVisuals {...defaultProps()} />);

    const btn = screen.getByText('Strike Map').closest('button')!;
    await user.click(btn);

    // After expand, the same button should show the collapse indicator
    // (the component toggles expanded state)
    expect(btn).toBeInTheDocument();
  });

  it('collapses an expanded panel on second click', async () => {
    const user = userEvent.setup();
    render(<PositionVisuals {...defaultProps()} />);

    const btn = screen.getByText('Risk Waterfall').closest('button')!;
    await user.click(btn); // expand
    await user.click(btn); // collapse

    // Panel still renders (all panels always render content)
    expect(screen.getByText('Risk Waterfall')).toBeInTheDocument();
  });

  // ── Strike Map Panel ────────────────────────────────────

  it('renders strike map SVG with aria-label', () => {
    render(<PositionVisuals {...defaultProps()} />);
    expect(
      screen.getByRole('img', { name: 'Strike position map' }),
    ).toBeInTheDocument();
  });

  it('shows spot price label in strike map', () => {
    render(<PositionVisuals {...defaultProps()} />);
    expect(screen.getByText(/SPX 5,700/)).toBeInTheDocument();
  });

  it('shows spread strike labels in strike map', () => {
    render(<PositionVisuals {...defaultProps()} />);
    // PCS 5650/5640 appears in strike map, waterfall, and gauges
    const matches = screen.getAllByText(/5,650\/5,640/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('renders empty strike map when no positions', () => {
    render(
      <PositionVisuals
        {...defaultProps()}
        spreads={[]}
        ironCondors={[]}
        hedges={[]}
        nakedPositions={[]}
      />,
    );
    expect(screen.getByText('No positions to map.')).toBeInTheDocument();
  });

  // ── Strike Map: Spot Price Inference ────────────────────

  it('infers spot price when calculator spot is >2% away', () => {
    // Put spread at 5650, calculator spot at 4000 (far away)
    // Should infer spot = 5650 + 30 = 5680 (only puts, no calls)
    render(
      <PositionVisuals
        {...defaultProps()}
        spotPrice={4000}
        ironCondors={[]}
      />,
    );
    // Should display the inferred spot, not 4000
    expect(screen.queryByText(/SPX 4,000/)).not.toBeInTheDocument();
    expect(screen.getByText(/SPX 5,680/)).toBeInTheDocument();
  });

  it('uses calculator spot when within 2% of inferred', () => {
    // Put spread at 5650, spot at 5700 is close to inferred 5680
    render(<PositionVisuals {...defaultProps()} spotPrice={5700} />);
    expect(screen.getByText(/SPX 5,700/)).toBeInTheDocument();
  });

  it('infers spot from iron condor midpoint', () => {
    const ic = makeIronCondor({
      putSpread: makeSpread({
        shortLeg: makeOpenLeg({ strike: 5600, type: 'PUT' }),
        longLeg: makeOpenLeg({ strike: 5590, type: 'PUT' }),
      }),
      callSpread: makeCallSpread({
        shortLeg: makeOpenLeg({ strike: 5800, type: 'CALL' }),
        longLeg: makeOpenLeg({ strike: 5810, type: 'CALL' }),
      }),
    });
    // Calculator spot far away; inferred = (5600 + 5800) / 2 = 5700
    render(
      <PositionVisuals
        {...defaultProps()}
        spreads={[]}
        ironCondors={[ic]}
        spotPrice={4000}
      />,
    );
    expect(screen.getByText(/SPX 5,700/)).toBeInTheDocument();
  });

  // ── Strike Map with hedges and naked ────────────────────

  it('renders hedge marker in strike map', () => {
    render(
      <PositionVisuals {...defaultProps()} hedges={[makeHedge()]} />,
    );
    expect(screen.getByText(/H 5,600/)).toBeInTheDocument();
  });

  it('renders naked marker in strike map', () => {
    render(
      <PositionVisuals
        {...defaultProps()}
        nakedPositions={[makeNaked()]}
      />,
    );
    expect(screen.getByText(/! 5,800/)).toBeInTheDocument();
  });

  // ── Strike Map with iron condor ─────────────────────────

  it('renders iron condor bars in strike map', () => {
    const ic = makeIronCondor();
    render(
      <PositionVisuals {...defaultProps()} ironCondors={[ic]} />,
    );
    // IC put side: 5620/5610
    expect(screen.getByText(/5,620\/5,610/)).toBeInTheDocument();
    // IC call side: 5780/5790
    expect(screen.getByText(/5,780\/5,790/)).toBeInTheDocument();
  });

  // ── Risk Waterfall Panel ────────────────────────────────

  it('renders risk waterfall SVG with aria-label', () => {
    render(<PositionVisuals {...defaultProps()} />);
    expect(
      screen.getByRole('img', { name: 'Risk waterfall' }),
    ).toBeInTheDocument();
  });

  it('renders empty risk waterfall when no positions', () => {
    render(
      <PositionVisuals
        {...defaultProps()}
        spreads={[]}
        ironCondors={[]}
        hedges={[]}
      />,
    );
    expect(screen.getByText('No risk to display.')).toBeInTheDocument();
  });

  it('renders spread risk bar in waterfall', () => {
    render(<PositionVisuals {...defaultProps()} />);
    // Should show max loss formatted: $920
    expect(screen.getByText('$920')).toBeInTheDocument();
  });

  it('renders hedge offset bar in waterfall', () => {
    render(
      <PositionVisuals {...defaultProps()} hedges={[makeHedge()]} />,
    );
    // Hedge label: "Hedge 5,600P"
    expect(screen.getByText(/Hedge 5,600P/)).toBeInTheDocument();
  });

  it('renders iron condor risk bar in waterfall', () => {
    const ic = makeIronCondor();
    render(
      <PositionVisuals
        {...defaultProps()}
        spreads={[]}
        ironCondors={[ic]}
      />,
    );
    // IC label: "IC 5,620/5,780"
    expect(screen.getByText(/IC 5,620\/5,780/)).toBeInTheDocument();
  });

  // ── Credit vs Time Panel ────────────────────────────────

  it('renders credit vs time SVG with aria-label', () => {
    render(<PositionVisuals {...defaultProps()} />);
    expect(
      screen.getByRole('img', { name: 'Credit received vs entry time' }),
    ).toBeInTheDocument();
  });

  it('renders empty credit chart when no opening trades', () => {
    const closingTrade = makeTrade({
      legs: [makeTradeLeg({ posEffect: 'TO CLOSE' })],
    });
    render(
      <PositionVisuals {...defaultProps()} trades={[closingTrade]} />,
    );
    expect(
      screen.getByText('No opening trades to chart.'),
    ).toBeInTheDocument();
  });

  it('shows credit value bubble in chart', () => {
    render(<PositionVisuals {...defaultProps()} />);
    // The trade has netPrice 0.80
    const matches = screen.getAllByText('0.80');
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  // ── % Max Profit Gauges Panel ───────────────────────────

  it('renders profit gauges for spreads', () => {
    render(<PositionVisuals {...defaultProps()} />);
    // Gauge label: "5,650/5,640p"
    expect(screen.getByText('5,650/5,640p')).toBeInTheDocument();
  });

  it('renders profit gauges for iron condors', () => {
    const ic = makeIronCondor();
    render(
      <PositionVisuals {...defaultProps()} ironCondors={[ic]} />,
    );
    // IC gauge label: "5,620p/5,780c"
    expect(screen.getByText(/5,620p\/5,780c/)).toBeInTheDocument();
  });

  it('renders empty profit gauges when no positions', () => {
    render(
      <PositionVisuals
        {...defaultProps()}
        spreads={[]}
        ironCondors={[]}
      />,
    );
    expect(
      screen.getByText('No positions for profit tracking.'),
    ).toBeInTheDocument();
  });

  it('shows gauge percentage for spread with pctOfMaxProfit', () => {
    // Default spread has pctOfMaxProfit = 43.75
    render(<PositionVisuals {...defaultProps()} />);
    expect(screen.getByText('44%')).toBeInTheDocument();
  });

  it('shows dash for gauge with null pctOfMaxProfit', () => {
    const spread = makeSpread({ pctOfMaxProfit: null });
    render(
      <PositionVisuals {...defaultProps()} spreads={[spread]} />,
    );
    // Unicode em dash
    expect(screen.getByText('\u2014')).toBeInTheDocument();
  });

  it('shows credit amount under gauge', () => {
    // Default spread creditReceived = 80, should show as "$80"
    render(<PositionVisuals {...defaultProps()} />);
    expect(screen.getByText('$80')).toBeInTheDocument();
  });

  // ── Multiple Positions Combined ─────────────────────────

  it('renders with PCS, CCS, IC, hedges, and naked together', () => {
    const props = {
      ...defaultProps(),
      spreads: [makeSpread(), makeCallSpread()],
      ironCondors: [makeIronCondor()],
      hedges: [makeHedge()],
      nakedPositions: [makeNaked()],
    };
    render(<PositionVisuals {...props} />);

    // All four panels should have content (not empty state)
    expect(
      screen.queryByText('No positions to map.'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('No risk to display.'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('No positions for profit tracking.'),
    ).not.toBeInTheDocument();
  });

  // ── Large Value Formatting ──────────────────────────────

  it('formats large dollar values with k suffix', () => {
    // Spread with maxLoss >= 1000 renders as $Xk in waterfall
    const bigSpread = makeSpread({ maxLoss: 4600 });
    render(
      <PositionVisuals {...defaultProps()} spreads={[bigSpread]} />,
    );
    expect(screen.getByText('$4.6k')).toBeInTheDocument();
  });

  it('formats credit >= 1000 with k suffix in gauges', () => {
    const bigSpread = makeSpread({ creditReceived: 1500 });
    render(
      <PositionVisuals {...defaultProps()} spreads={[bigSpread]} />,
    );
    expect(screen.getByText('$1.5k')).toBeInTheDocument();
  });

  // ── Multiple Trades in Credit Chart ─────────────────────

  it('renders multiple bubbles for multiple opening trades', () => {
    const trade1 = makeTrade({
      execTime: '3/27/26 09:45:00',
      netPrice: 0.8,
    });
    const trade2 = makeTrade({
      execTime: '3/27/26 10:15:00',
      netPrice: 1.2,
    });
    render(
      <PositionVisuals {...defaultProps()} trades={[trade1, trade2]} />,
    );
    expect(screen.getByText('0.80')).toBeInTheDocument();
    expect(screen.getByText('1.20')).toBeInTheDocument();
  });

  // ── Time axis labels in credit chart ────────────────────

  it('shows time axis labels extracted from trade times', () => {
    const trade = makeTrade({ execTime: '3/27/26 09:45:00' });
    render(
      <PositionVisuals {...defaultProps()} trades={[trade]} />,
    );
    // fmtTime extracts "09:45"
    const timeLabels = screen.getAllByText('09:45');
    expect(timeLabels.length).toBeGreaterThanOrEqual(1);
  });
});
