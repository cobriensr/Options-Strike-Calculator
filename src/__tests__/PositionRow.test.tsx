/**
 * PositionRow — desktop <tr> renderers + mobile card variants.
 *
 * The mobile cards (IronCondorCard / SpreadCard / ButterflyCard /
 * HedgeCards / NakedCards) had zero coverage before this file.
 * Desktop rows exist primarily to cover IronCondorRow's expand/collapse
 * branch which the parent table doesn't exercise directly.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  IronCondorRow,
  SpreadRow,
  HedgeRows,
  NakedRows,
  ButterflyRow,
} from '../components/PositionMonitor/PositionRow';
import {
  IronCondorCard,
  SpreadCard,
  ButterflyCard,
  HedgeCards,
  NakedCards,
} from '../components/PositionMonitor/PositionCards';
import type {
  ButterflyPosition,
  HedgePosition,
  IronCondor,
  NakedPosition,
  OpenLeg,
  Spread,
} from '../components/PositionMonitor/types';

// ============================================================
// FACTORIES
// ============================================================

function makeLeg(overrides: Partial<OpenLeg> = {}): OpenLeg {
  return {
    symbol: 'SPXW',
    optionCode: 'SPXW260427P05790',
    exp: '2026-04-27',
    strike: 5790,
    type: 'PUT',
    qty: -1,
    tradePrice: 5,
    mark: 4.5,
    markValue: -450,
    ...overrides,
  };
}

function makeSpread(overrides: Partial<Spread> = {}): Spread {
  return {
    spreadType: 'PUT_CREDIT_SPREAD',
    shortLeg: makeLeg({ strike: 5790, qty: -1 }),
    longLeg: makeLeg({ strike: 5780, qty: 1, tradePrice: 3 }),
    contracts: 1,
    wingWidth: 10,
    creditReceived: 200,
    maxProfit: 200,
    maxLoss: 800,
    riskRewardRatio: 4.0,
    breakeven: 5788,
    entryTime: '09:32:00',
    entryNetPrice: 2,
    currentValue: -150,
    openPnl: 50,
    pctOfMaxProfit: 25,
    distanceToShortStrike: 10,
    distanceToShortStrikePct: 0.0017,
    nearestShortStrike: 5790,
    entryCommissions: 1.3,
    ...overrides,
  };
}

function makeIronCondor(overrides: Partial<IronCondor> = {}): IronCondor {
  return {
    spreadType: 'IRON_CONDOR',
    putSpread: makeSpread({
      spreadType: 'PUT_CREDIT_SPREAD',
      shortLeg: makeLeg({ strike: 5790 }),
      longLeg: makeLeg({ strike: 5780 }),
      openPnl: 25,
    }),
    callSpread: makeSpread({
      spreadType: 'CALL_CREDIT_SPREAD',
      shortLeg: makeLeg({ strike: 5810, type: 'CALL' }),
      longLeg: makeLeg({ strike: 5820, type: 'CALL' }),
      openPnl: 25,
    }),
    contracts: 1,
    totalCredit: 400,
    maxProfit: 400,
    maxLoss: 600,
    riskRewardRatio: 1.5,
    breakevenLow: 5786,
    breakevenHigh: 5814,
    putWingWidth: 10,
    callWingWidth: 10,
    entryTime: '09:30:00',
    ...overrides,
  };
}

function makeHedge(overrides: Partial<HedgePosition> = {}): HedgePosition {
  return {
    leg: makeLeg({ strike: 5750, type: 'PUT', qty: 2, tradePrice: 1.2 }),
    direction: 'LONG',
    protectionSide: 'PUT',
    strikeProtected: 5750,
    contracts: 2,
    entryCost: 240,
    currentValue: 180,
    openPnl: -60,
    ...overrides,
  };
}

function makeNaked(overrides: Partial<NakedPosition> = {}): NakedPosition {
  return {
    leg: makeLeg({ strike: 5800, qty: -1 }),
    contracts: 1,
    type: 'PUT',
    ...overrides,
  };
}

function makeButterfly(
  overrides: Partial<ButterflyPosition> = {},
): ButterflyPosition {
  return {
    lowerLeg: makeLeg({ strike: 5780, type: 'PUT', qty: 1 }),
    middleLeg: makeLeg({ strike: 5800, type: 'PUT', qty: -2 }),
    upperLeg: makeLeg({ strike: 5820, type: 'PUT', qty: 1 }),
    optionType: 'PUT',
    contracts: 1,
    lowerWidth: 20,
    upperWidth: 20,
    isBrokenWing: false,
    maxProfitStrike: 5800,
    debitPaid: 500,
    maxProfit: 1500,
    maxLoss: 500,
    entryTime: '09:30:00',
    distanceToPin: 0,
    ...overrides,
  };
}

/** Renders <tr>-producing components inside a host table so the rows
 *  attach to a valid parent (avoids a JSDOM warning about rows outside
 *  a table context). */
function renderInTable(node: React.ReactNode) {
  return render(
    <table>
      <tbody>{node}</tbody>
    </table>,
  );
}

// ============================================================
// IronCondorRow (desktop)
// ============================================================

describe('IronCondorRow', () => {
  it('renders the strike string with both wings + total credit', () => {
    renderInTable(
      <IronCondorRow ic={makeIronCondor()} spotPrice={5800} index={0} />,
    );
    expect(screen.getByText(/5790\/5780p – 5810\/5820c/)).toBeInTheDocument();
    expect(screen.getByText('$400.00')).toBeInTheDocument();
  });

  it('shows "—" for openPnl when either spread has null openPnl', () => {
    const ic = makeIronCondor({
      putSpread: makeSpread({ openPnl: null }),
      callSpread: makeSpread({ openPnl: 30 }),
    });
    renderInTable(<IronCondorRow ic={ic} spotPrice={5800} index={0} />);
    // openPnl em-dash specific to the IC summary row.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('expands the wing rows on click and collapses on second click', () => {
    renderInTable(
      <IronCondorRow ic={makeIronCondor()} spotPrice={5800} index={0} />,
    );
    expect(screen.queryByText('PUT wing')).not.toBeInTheDocument();
    const summaryRow = screen.getByText('IC').closest('tr')!;
    fireEvent.click(summaryRow);
    expect(screen.getByText('PUT wing')).toBeInTheDocument();
    expect(screen.getByText('CALL wing')).toBeInTheDocument();
    fireEvent.click(summaryRow);
    expect(screen.queryByText('PUT wing')).not.toBeInTheDocument();
  });

  it('uses the alt background tint on odd-indexed rows', () => {
    renderInTable(
      <IronCondorRow ic={makeIronCondor()} spotPrice={5800} index={1} />,
    );
    const tr = screen.getByText('IC').closest('tr')!;
    expect(tr).toHaveClass('bg-table-alt');
  });
});

// ============================================================
// SpreadRow (desktop)
// ============================================================

describe('SpreadRow', () => {
  it('renders a put credit spread with the PCS label and red tone', () => {
    renderInTable(
      <SpreadRow
        spread={makeSpread({ spreadType: 'PUT_CREDIT_SPREAD' })}
        spotPrice={5800}
        rowIndex={0}
      />,
    );
    const label = screen.getByText('PCS');
    expect(label.className).toMatch(/text-red-400/);
  });

  it('renders a call credit spread with the CCS label and green tone', () => {
    renderInTable(
      <SpreadRow
        spread={makeSpread({ spreadType: 'CALL_CREDIT_SPREAD' })}
        spotPrice={5800}
        rowIndex={0}
      />,
    );
    const label = screen.getByText('CCS');
    expect(label.className).toMatch(/text-green-400/);
  });

  it('shows "—" when openPnl is null', () => {
    renderInTable(
      <SpreadRow
        spread={makeSpread({ openPnl: null })}
        spotPrice={5800}
        rowIndex={0}
      />,
    );
    // "openPnl" cell is "—"; multiple em-dashes can exist depending on
    // helper output, so we just assert at least one is present.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

// ============================================================
// HedgeRows (desktop)
// ============================================================

describe('HedgeRows', () => {
  it('renders one row per hedge with HEDGE label and signed contracts', () => {
    renderInTable(
      <HedgeRows
        hedges={[makeHedge({ direction: 'LONG', contracts: 2 })]}
        startIndex={0}
      />,
    );
    expect(screen.getByText('HEDGE')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByText(/PUT side/)).toBeInTheDocument();
  });

  it('renders SHORT direction as -N contracts', () => {
    renderInTable(
      <HedgeRows
        hedges={[makeHedge({ direction: 'SHORT', contracts: 3 })]}
        startIndex={0}
      />,
    );
    expect(screen.getByText('-3')).toBeInTheDocument();
  });

  it('renders nothing when the hedges array is empty', () => {
    const { container } = renderInTable(
      <HedgeRows hedges={[]} startIndex={0} />,
    );
    expect(container.querySelector('tbody')?.children.length).toBe(0);
  });
});

// ============================================================
// NakedRows (desktop)
// ============================================================

describe('NakedRows', () => {
  it('renders one row per naked position with UNDEFINED max loss', () => {
    renderInTable(<NakedRows naked={[makeNaked()]} startIndex={0} />);
    expect(screen.getByText('NAKED')).toBeInTheDocument();
    expect(screen.getByText('UNDEFINED')).toBeInTheDocument();
    expect(screen.getByText(/5800 PUT/)).toBeInTheDocument();
  });

  it('renders nothing for an empty naked list', () => {
    const { container } = renderInTable(
      <NakedRows naked={[]} startIndex={0} />,
    );
    expect(container.querySelector('tbody')?.children.length).toBe(0);
  });
});

// ============================================================
// ButterflyRow (desktop)
// ============================================================

describe('ButterflyRow', () => {
  it('renders BFLY label for symmetric butterflies', () => {
    renderInTable(
      <ButterflyRow
        butterfly={makeButterfly({ isBrokenWing: false })}
        rowIndex={0}
      />,
    );
    expect(screen.getByText('BFLY')).toBeInTheDocument();
  });

  it('renders BWB label for broken wing butterflies', () => {
    renderInTable(
      <ButterflyRow
        butterfly={makeButterfly({ isBrokenWing: true })}
        rowIndex={0}
      />,
    );
    expect(screen.getByText('BWB')).toBeInTheDocument();
  });

  it('renders the strike triple with the option type letter (P for PUT)', () => {
    renderInTable(<ButterflyRow butterfly={makeButterfly()} rowIndex={0} />);
    expect(screen.getByText(/5780\/5800\/5820 P/)).toBeInTheDocument();
  });

  it('renders the option type letter C for CALL butterflies', () => {
    renderInTable(
      <ButterflyRow
        butterfly={makeButterfly({ optionType: 'CALL' })}
        rowIndex={0}
      />,
    );
    expect(screen.getByText(/5780\/5800\/5820 C/)).toBeInTheDocument();
  });

  it('renders distanceToPin with sign and unit', () => {
    renderInTable(
      <ButterflyRow
        butterfly={makeButterfly({ distanceToPin: 5 })}
        rowIndex={0}
      />,
    );
    expect(screen.getByText('+5 pts')).toBeInTheDocument();
  });

  it('renders "—" for distanceToPin when null', () => {
    renderInTable(
      <ButterflyRow
        butterfly={makeButterfly({ distanceToPin: null })}
        rowIndex={0}
      />,
    );
    // At least one em-dash should appear on the row.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders "—" R:R when maxProfit is zero (avoids divide-by-zero)', () => {
    renderInTable(
      <ButterflyRow butterfly={makeButterfly({ maxProfit: 0 })} rowIndex={0} />,
    );
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

// ============================================================
// IronCondorCard (mobile)
// ============================================================

describe('IronCondorCard', () => {
  it('renders the IC label, strikes, and credit', () => {
    render(<IronCondorCard ic={makeIronCondor()} spotPrice={5800} />);
    expect(screen.getByText('IC')).toBeInTheDocument();
    // Card splits the strike string across literal text nodes ("5790/5780p"
    // " – " "5810/5820c"), so match by element text rather than the full
    // string at one node.
    expect(screen.getByText(/5790\/5780p/)).toBeInTheDocument();
    expect(screen.getByText(/5810\/5820c/)).toBeInTheDocument();
    expect(screen.getByText('$400.00')).toBeInTheDocument();
  });

  it('expands the wing details on click', () => {
    render(<IronCondorCard ic={makeIronCondor()} spotPrice={5800} />);
    expect(screen.queryByText(/PUT wing/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Iron Condor/ }));
    expect(screen.getByText(/PUT wing/)).toBeInTheDocument();
    expect(screen.getByText(/CALL wing/)).toBeInTheDocument();
  });

  it('shows the contract count and breakevens in the stats grid', () => {
    render(<IronCondorCard ic={makeIronCondor()} spotPrice={5800} />);
    expect(screen.getByText(/1 contracts/)).toBeInTheDocument();
    // Breakevens rendered as "5786 / 5814" (toFixed(0))
    expect(screen.getByText('5786 / 5814')).toBeInTheDocument();
  });

  it('renders "—" for openPnl when either wing pnl is null', () => {
    const ic = makeIronCondor({
      putSpread: makeSpread({ openPnl: null }),
      callSpread: makeSpread({ openPnl: 30 }),
    });
    render(<IronCondorCard ic={ic} spotPrice={5800} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('sets aria-expanded on the toggle button to reflect state', () => {
    render(<IronCondorCard ic={makeIronCondor()} spotPrice={5800} />);
    const btn = screen.getByRole('button', { name: /Iron Condor/ });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });
});

// ============================================================
// SpreadCard (mobile)
// ============================================================

describe('SpreadCard', () => {
  it('renders a PCS card with red label tone', () => {
    render(
      <SpreadCard
        spread={makeSpread({ spreadType: 'PUT_CREDIT_SPREAD' })}
        spotPrice={5800}
      />,
    );
    expect(screen.getByText('PCS').className).toMatch(/text-red-400/);
  });

  it('renders a CCS card with green label tone', () => {
    render(
      <SpreadCard
        spread={makeSpread({ spreadType: 'CALL_CREDIT_SPREAD' })}
        spotPrice={5800}
      />,
    );
    expect(screen.getByText('CCS').className).toMatch(/text-green-400/);
  });

  it('shows credit, max loss, R:R, breakeven, and contract count', () => {
    render(<SpreadCard spread={makeSpread()} spotPrice={5800} />);
    expect(screen.getByText('$200.00')).toBeInTheDocument(); // credit
    expect(screen.getByText('$800.00')).toBeInTheDocument(); // max loss
    expect(screen.getByText('4.0:1')).toBeInTheDocument(); // R:R
    expect(screen.getByText('5788.00')).toBeInTheDocument(); // breakeven
    expect(screen.getByText(/1 contracts/)).toBeInTheDocument();
  });

  it('shows "—" when openPnl is null', () => {
    render(
      <SpreadCard
        spread={makeSpread({ openPnl: null, pctOfMaxProfit: null })}
        spotPrice={5800}
      />,
    );
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

// ============================================================
// ButterflyCard (mobile)
// ============================================================

describe('ButterflyCard', () => {
  it('renders the BFLY label and strike triple with PUT letter', () => {
    render(<ButterflyCard butterfly={makeButterfly()} />);
    expect(screen.getByText('BFLY')).toBeInTheDocument();
    expect(screen.getByText(/5780\/5800\/5820 P/)).toBeInTheDocument();
  });

  it('renders BWB label when isBrokenWing is true', () => {
    render(<ButterflyCard butterfly={makeButterfly({ isBrokenWing: true })} />);
    expect(screen.getByText('BWB')).toBeInTheDocument();
  });

  it('renders pin strike + R:R + signed distance to pin', () => {
    render(
      <ButterflyCard
        butterfly={makeButterfly({
          maxProfitStrike: 5800,
          maxProfit: 1500,
          maxLoss: 500,
          distanceToPin: -7,
        })}
      />,
    );
    expect(screen.getByText('5800')).toBeInTheDocument();
    // 500/1500 = 0.333... → "0.3:1"
    expect(screen.getByText('0.3:1')).toBeInTheDocument();
    expect(screen.getByText('-7 pts')).toBeInTheDocument();
  });

  it('renders R:R as "—" when maxProfit is zero', () => {
    render(<ButterflyCard butterfly={makeButterfly({ maxProfit: 0 })} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders "—" for distanceToPin when null', () => {
    render(
      <ButterflyCard butterfly={makeButterfly({ distanceToPin: null })} />,
    );
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

// ============================================================
// HedgeCards (mobile)
// ============================================================

describe('HedgeCards', () => {
  it('renders one card per hedge with the HEDGE label', () => {
    render(<HedgeCards hedges={[makeHedge(), makeHedge()]} />);
    expect(screen.getAllByText('HEDGE')).toHaveLength(2);
  });

  it('renders +N contracts for LONG direction', () => {
    render(
      <HedgeCards hedges={[makeHedge({ direction: 'LONG', contracts: 3 })]} />,
    );
    expect(screen.getByText('+3')).toBeInTheDocument();
  });

  it('renders -N contracts for SHORT direction', () => {
    render(
      <HedgeCards hedges={[makeHedge({ direction: 'SHORT', contracts: 4 })]} />,
    );
    expect(screen.getByText('-4')).toBeInTheDocument();
  });

  it('renders entry cost and pnl', () => {
    render(
      <HedgeCards hedges={[makeHedge({ entryCost: 240, openPnl: -60 })]} />,
    );
    expect(screen.getByText('$240.00')).toBeInTheDocument();
    expect(screen.getByText('($60.00)')).toBeInTheDocument();
  });

  it('renders "—" for openPnl when null', () => {
    render(<HedgeCards hedges={[makeHedge({ openPnl: null })]} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders the protection-side caption text', () => {
    render(<HedgeCards hedges={[makeHedge({ protectionSide: 'CALL' })]} />);
    expect(screen.getByText(/CALL side protection/)).toBeInTheDocument();
  });
});

// ============================================================
// NakedCards (mobile)
// ============================================================

describe('NakedCards', () => {
  it('renders one card per naked position with the danger styling', () => {
    render(<NakedCards naked={[makeNaked()]} />);
    expect(screen.getByText('NAKED')).toBeInTheDocument();
    expect(screen.getByText('UNDEFINED')).toBeInTheDocument();
  });

  it('renders the strike and option type', () => {
    render(
      <NakedCards
        naked={[makeNaked({ leg: makeLeg({ strike: 5800 }), type: 'PUT' })]}
      />,
    );
    expect(screen.getByText(/5800 PUT/)).toBeInTheDocument();
  });

  it('renders the unlimited-risk caption', () => {
    render(<NakedCards naked={[makeNaked({ type: 'CALL' })]} />);
    expect(
      screen.getByText(/Naked short call — unlimited risk/),
    ).toBeInTheDocument();
  });

  it('renders nothing for an empty naked list', () => {
    const { container } = render(<NakedCards naked={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

// ============================================================
// PctMaxBar (via SpreadRow / SpreadCard)
// ============================================================

describe('PctMaxBar (rendered via SpreadCard)', () => {
  it('renders an em-dash when pct is null', () => {
    render(
      <SpreadCard
        spread={makeSpread({ pctOfMaxProfit: null })}
        spotPrice={5800}
      />,
    );
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders the pct rounded to integer percent', () => {
    render(
      <SpreadCard
        spread={makeSpread({ pctOfMaxProfit: 73.4 })}
        spotPrice={5800}
      />,
    );
    expect(screen.getByText('73%')).toBeInTheDocument();
  });

  it('clamps the bar width to 100% when pct exceeds 100', () => {
    const { container } = render(
      <SpreadCard
        spread={makeSpread({ pctOfMaxProfit: 150 })}
        spotPrice={5800}
      />,
    );
    // The inner bar's inline width style should be "100%" after the
    // clamp. Use the success bg-color class to find it.
    const bar = container.querySelector('.bg-success') as HTMLElement | null;
    expect(bar).not.toBeNull();
    expect(bar?.style.width).toBe('100%');
  });

  it('clamps the bar width to 0% when pct is negative', () => {
    const { container } = render(
      <SpreadCard
        spread={makeSpread({ pctOfMaxProfit: -10 })}
        spotPrice={5800}
      />,
    );
    const bar = container.querySelector('.bg-caution') as HTMLElement | null;
    expect(bar).not.toBeNull();
    expect(bar?.style.width).toBe('0%');
  });

  it('uses the success color when pct is at or above 80', () => {
    const { container } = render(
      <SpreadCard
        spread={makeSpread({ pctOfMaxProfit: 85 })}
        spotPrice={5800}
      />,
    );
    expect(container.querySelector('.bg-success')).not.toBeNull();
  });

  it('uses the accent color when pct is between 50 and 80', () => {
    const { container } = render(
      <SpreadCard
        spread={makeSpread({ pctOfMaxProfit: 60 })}
        spotPrice={5800}
      />,
    );
    expect(container.querySelector('.bg-accent')).not.toBeNull();
  });

  it('uses the caution color when pct is below 50', () => {
    const { container } = render(
      <SpreadCard
        spread={makeSpread({ pctOfMaxProfit: 25 })}
        spotPrice={5800}
      />,
    );
    expect(container.querySelector('.bg-caution')).not.toBeNull();
  });
});
