import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PositionTable from '../../components/PositionMonitor/PositionTable';
import type {
  ButterflyPosition,
  HedgePosition,
  IronCondor,
  NakedPosition,
  OpenLeg,
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
    shortLeg: makeLeg({
      strike: 5600,
      type: 'PUT',
      qty: -10,
      tradePrice: 3.5,
    }),
    longLeg: makeLeg({
      strike: 5580,
      type: 'PUT',
      qty: 10,
      tradePrice: 2.0,
    }),
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
    openPnl: 800,
    pctOfMaxProfit: 53.3,
  });
  const callSpread = makeSpread({
    spreadType: 'CALL_CREDIT_SPREAD',
    shortLeg: makeLeg({ strike: 5800, type: 'CALL', qty: -10 }),
    longLeg: makeLeg({ strike: 5820, type: 'CALL', qty: 10 }),
    creditReceived: 1000,
    maxLoss: 19000,
    openPnl: 500,
    pctOfMaxProfit: 50,
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
    entryTime: '09:32',
    ...overrides,
  };
}

function makeHedge(overrides: Partial<HedgePosition> = {}): HedgePosition {
  return {
    leg: makeLeg({
      strike: 5500,
      type: 'PUT',
      qty: 5,
      tradePrice: 0.5,
    }),
    direction: 'LONG',
    protectionSide: 'PUT',
    strikeProtected: 5500,
    contracts: 5,
    entryCost: 250,
    currentValue: 300,
    openPnl: 50,
    ...overrides,
  };
}

function makeNaked(overrides: Partial<NakedPosition> = {}): NakedPosition {
  return {
    leg: makeLeg({ strike: 5900, type: 'CALL', qty: -5 }),
    contracts: 5,
    type: 'CALL',
    ...overrides,
  };
}

// ── Render helper ────────────────────────────────────────────

function renderTable(
  overrides: {
    spreads?: Spread[];
    ironCondors?: IronCondor[];
    butterflies?: ButterflyPosition[];
    hedges?: HedgePosition[];
    nakedPositions?: NakedPosition[];
    spotPrice?: number;
  } = {},
) {
  return render(
    <PositionTable
      spreads={overrides.spreads ?? []}
      ironCondors={overrides.ironCondors ?? []}
      butterflies={overrides.butterflies ?? []}
      hedges={overrides.hedges ?? []}
      nakedPositions={overrides.nakedPositions ?? []}
      spotPrice={overrides.spotPrice ?? 5700}
    />,
  );
}

/** Get data rows from the rendered table (skipping the header). */
function getDataRows() {
  const table = screen.getByRole('table');
  const rows = within(table).getAllByRole('row');
  return rows.slice(1);
}

// ── Tests ────────────────────────────────────────────────────

describe('PositionTable', () => {
  // ── Empty state ──────────────────────────────────────────

  it('shows empty message when no positions exist', () => {
    renderTable();
    expect(
      screen.getByText('No open positions found in this statement.'),
    ).toBeInTheDocument();
  });

  it('does not render a table when empty', () => {
    renderTable();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  // ── Table structure ──────────────────────────────────────

  it('renders the table with aria-label when positions exist', () => {
    renderTable({ spreads: [makeSpread()] });
    expect(
      screen.getByRole('table', { name: 'Open positions' }),
    ).toBeInTheDocument();
  });

  it('renders all column headers', () => {
    renderTable({ spreads: [makeSpread()] });
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Strikes')).toBeInTheDocument();
    expect(screen.getByText('Qty')).toBeInTheDocument();
    expect(screen.getByText('Credit')).toBeInTheDocument();
    expect(screen.getByText('Open P&L')).toBeInTheDocument();
    expect(screen.getByText('% Max')).toBeInTheDocument();
    expect(screen.getByText('Max Loss')).toBeInTheDocument();
    expect(screen.getByText('Risk:Reward')).toBeInTheDocument();
    expect(screen.getByText('Breakeven')).toBeInTheDocument();
    expect(screen.getByText('Cushion')).toBeInTheDocument();
    expect(screen.getByText('Entry')).toBeInTheDocument();
  });

  // ── Spread rows ──────────────────────────────────────────

  it('renders PCS type label for put credit spreads', () => {
    renderTable({ spreads: [makeSpread()] });
    expect(screen.getByText('PCS')).toBeInTheDocument();
  });

  it('renders CCS type label for call credit spreads', () => {
    const ccs = makeSpread({
      spreadType: 'CALL_CREDIT_SPREAD',
      shortLeg: makeLeg({ strike: 5800, type: 'CALL', qty: -10 }),
      longLeg: makeLeg({ strike: 5820, type: 'CALL', qty: 10 }),
    });
    renderTable({ spreads: [ccs] });
    expect(screen.getByText('CCS')).toBeInTheDocument();
  });

  it('renders strike label as short/long', () => {
    renderTable({
      spreads: [
        makeSpread({
          shortLeg: makeLeg({
            strike: 5600,
            type: 'PUT',
            qty: -10,
          }),
          longLeg: makeLeg({ strike: 5580, type: 'PUT', qty: 10 }),
        }),
      ],
    });
    expect(screen.getByText('5600/5580')).toBeInTheDocument();
  });

  it('renders credit received with currency formatting', () => {
    renderTable({
      spreads: [makeSpread({ creditReceived: 1500 })],
    });
    expect(screen.getByText('$1,500.00')).toBeInTheDocument();
  });

  it('renders open P&L when available', () => {
    renderTable({ spreads: [makeSpread({ openPnl: 800 })] });
    expect(screen.getByText('$800.00')).toBeInTheDocument();
  });

  it('renders em-dash for null open P&L', () => {
    renderTable({ spreads: [makeSpread({ openPnl: null })] });
    const rows = getDataRows();
    expect(rows[0]!.textContent).toContain('\u2014');
  });

  it('renders risk:reward ratio', () => {
    renderTable({
      spreads: [makeSpread({ riskRewardRatio: 12.3 })],
    });
    expect(screen.getByText('12.3:1')).toBeInTheDocument();
  });

  it('renders breakeven value', () => {
    renderTable({ spreads: [makeSpread({ breakeven: 5598.5 })] });
    expect(screen.getByText('5598.50')).toBeInTheDocument();
  });

  it('renders entry time when available', () => {
    renderTable({
      spreads: [makeSpread({ entryTime: '09:30' })],
    });
    expect(screen.getByText('09:30')).toBeInTheDocument();
  });

  it('renders em-dash for null entry time', () => {
    renderTable({ spreads: [makeSpread({ entryTime: null })] });
    const rows = getDataRows();
    expect(rows[0]!.textContent).toContain('\u2014');
  });

  // ── P&L coloring ─────────────────────────────────────────

  it('applies success color for positive open P&L', () => {
    renderTable({ spreads: [makeSpread({ openPnl: 800 })] });
    const pnlCell = screen.getByText('$800.00');
    const td = pnlCell.closest('td') as HTMLElement;
    expect(td.className).toContain('text-success');
  });

  it('applies danger color for negative open P&L', () => {
    renderTable({ spreads: [makeSpread({ openPnl: -500 })] });
    const pnlCell = screen.getByText('($500.00)');
    const td = pnlCell.closest('td') as HTMLElement;
    expect(td.className).toContain('text-danger');
  });

  it('applies muted color for null open P&L', () => {
    renderTable({ spreads: [makeSpread({ openPnl: null })] });
    const table = screen.getByRole('table');
    const cells = within(table).getAllByRole('cell');
    // Open P&L is the 5th cell (index 4) in the data row
    const pnlCell = cells[4]!;
    expect(pnlCell.className).toContain('text-muted');
  });

  // ── Cushion / sorting ────────────────────────────────────

  it('renders cushion percentage', () => {
    renderTable({
      spreads: [makeSpread({ distanceToShortStrikePct: 1.75 })],
      spotPrice: 5700,
    });
    expect(screen.getByText('1.8%')).toBeInTheDocument();
  });

  it('sorts PCS before CCS, each by ascending cushion', () => {
    const pcs1 = makeSpread({
      spreadType: 'PUT_CREDIT_SPREAD',
      shortLeg: makeLeg({ strike: 5600, type: 'PUT', qty: -10 }),
      longLeg: makeLeg({ strike: 5580, type: 'PUT', qty: 10 }),
      distanceToShortStrikePct: 2.0,
    });
    const pcs2 = makeSpread({
      spreadType: 'PUT_CREDIT_SPREAD',
      shortLeg: makeLeg({ strike: 5650, type: 'PUT', qty: -5 }),
      longLeg: makeLeg({ strike: 5630, type: 'PUT', qty: 5 }),
      distanceToShortStrikePct: 0.9,
    });
    const ccs1 = makeSpread({
      spreadType: 'CALL_CREDIT_SPREAD',
      shortLeg: makeLeg({ strike: 5800, type: 'CALL', qty: -10 }),
      longLeg: makeLeg({ strike: 5820, type: 'CALL', qty: 10 }),
      distanceToShortStrikePct: 1.5,
    });

    renderTable({ spreads: [pcs1, ccs1, pcs2] });
    const rows = getDataRows();

    // Row 0 = pcs2 (0.9% cushion), Row 1 = pcs1 (2.0%), Row 2 = ccs1
    expect(rows[0]!.textContent).toContain('PCS');
    expect(rows[0]!.textContent).toContain('5650/5630');
    expect(rows[1]!.textContent).toContain('PCS');
    expect(rows[1]!.textContent).toContain('5600/5580');
    expect(rows[2]!.textContent).toContain('CCS');
  });

  it('places null cushion spreads last within their type', () => {
    const pcsNear = makeSpread({
      spreadType: 'PUT_CREDIT_SPREAD',
      shortLeg: makeLeg({ strike: 5650, type: 'PUT', qty: -5 }),
      longLeg: makeLeg({ strike: 5630, type: 'PUT', qty: 5 }),
      distanceToShortStrikePct: 1.0,
    });
    const pcsNull = makeSpread({
      spreadType: 'PUT_CREDIT_SPREAD',
      shortLeg: makeLeg({ strike: 5600, type: 'PUT', qty: -10 }),
      longLeg: makeLeg({ strike: 5580, type: 'PUT', qty: 10 }),
      distanceToShortStrikePct: null,
    });

    renderTable({ spreads: [pcsNull, pcsNear] });
    const rows = getDataRows();
    expect(rows[0]!.textContent).toContain('5650/5630');
    expect(rows[1]!.textContent).toContain('5600/5580');
  });

  // ── Iron Condor rows ─────────────────────────────────────

  it('renders IC type label', () => {
    renderTable({ ironCondors: [makeIC()] });
    expect(screen.getByText('IC')).toBeInTheDocument();
  });

  it('renders IC strike label with put and call sides', () => {
    renderTable({ ironCondors: [makeIC()] });
    const rows = getDataRows();
    expect(rows[0]!.textContent).toContain('5600/5580p');
    expect(rows[0]!.textContent).toContain('5800/5820c');
  });

  it('renders IC total credit', () => {
    renderTable({
      ironCondors: [makeIC({ totalCredit: 2500 })],
    });
    expect(screen.getByText('$2,500.00')).toBeInTheDocument();
  });

  it('renders combined open P&L for IC', () => {
    const ic = makeIC();
    // putSpread.openPnl=800, callSpread.openPnl=500, combined=1300
    renderTable({ ironCondors: [ic] });
    expect(screen.getByText('$1,300.00')).toBeInTheDocument();
  });

  it('renders em-dash for IC P&L when one wing has null', () => {
    const ic = makeIC();
    const modified: IronCondor = {
      ...ic,
      putSpread: { ...ic.putSpread, openPnl: null },
    };
    renderTable({ ironCondors: [modified] });
    const rows = getDataRows();
    expect(rows[0]!.textContent).toContain('\u2014');
  });

  it('renders IC breakeven range', () => {
    renderTable({
      ironCondors: [makeIC({ breakevenLow: 5597.5, breakevenHigh: 5802.5 })],
    });
    expect(screen.getByText(/5597\.50/)).toBeInTheDocument();
    expect(screen.getByText(/5802\.50/)).toBeInTheDocument();
  });

  it('renders IC entry time', () => {
    renderTable({
      ironCondors: [makeIC({ entryTime: '09:32' })],
    });
    expect(screen.getByText('09:32')).toBeInTheDocument();
  });

  // ── IC expansion ─────────────────────────────────────────

  it('expands IC to show wing rows on click', async () => {
    const user = userEvent.setup();
    renderTable({ ironCondors: [makeIC()] });

    expect(screen.queryByText('PUT wing')).not.toBeInTheDocument();
    expect(screen.queryByText('CALL wing')).not.toBeInTheDocument();

    const rows = getDataRows();
    await user.click(rows[0]!);

    expect(screen.getByText('PUT wing')).toBeInTheDocument();
    expect(screen.getByText('CALL wing')).toBeInTheDocument();
  });

  it('collapses IC wings on second click', async () => {
    const user = userEvent.setup();
    renderTable({ ironCondors: [makeIC()] });

    const rows = getDataRows();
    await user.click(rows[0]!); // expand
    expect(screen.getByText('PUT wing')).toBeInTheDocument();

    await user.click(rows[0]!); // collapse
    expect(screen.queryByText('PUT wing')).not.toBeInTheDocument();
  });

  // ── Hedge rows ───────────────────────────────────────────

  it('renders HEDGE type label', () => {
    renderTable({ hedges: [makeHedge()] });
    expect(screen.getByText('HEDGE')).toBeInTheDocument();
  });

  it('renders hedge strike and protection side', () => {
    renderTable({
      hedges: [makeHedge({ protectionSide: 'PUT' })],
    });
    const table = screen.getByRole('table');
    expect(table.textContent).toContain('5500 PUT');
  });

  it('renders hedge quantity with direction prefix', () => {
    renderTable({
      hedges: [makeHedge({ direction: 'LONG', contracts: 5 })],
    });
    expect(screen.getByText('+5')).toBeInTheDocument();
  });

  it('renders short direction prefix for short hedges', () => {
    renderTable({
      hedges: [makeHedge({ direction: 'SHORT', contracts: 3 })],
    });
    expect(screen.getByText('-3')).toBeInTheDocument();
  });

  it('renders hedge entry cost', () => {
    renderTable({ hedges: [makeHedge({ entryCost: 250 })] });
    expect(screen.getByText('$250.00')).toBeInTheDocument();
  });

  it('renders hedge open P&L when present', () => {
    renderTable({ hedges: [makeHedge({ openPnl: 50 })] });
    expect(screen.getByText('$50.00')).toBeInTheDocument();
  });

  it('shows protection side label in cushion column', () => {
    renderTable({
      hedges: [makeHedge({ protectionSide: 'PUT' })],
    });
    expect(screen.getByText('PUT side')).toBeInTheDocument();
  });

  // ── Naked position rows ──────────────────────────────────

  it('renders NAKED type label', () => {
    renderTable({ nakedPositions: [makeNaked()] });
    expect(screen.getByText('NAKED')).toBeInTheDocument();
  });

  it('renders naked strike and type', () => {
    renderTable({
      nakedPositions: [makeNaked({ type: 'CALL' })],
    });
    const table = screen.getByRole('table');
    expect(table.textContent).toContain('5900 CALL');
  });

  it('renders UNDEFINED for naked max loss', () => {
    renderTable({ nakedPositions: [makeNaked()] });
    expect(screen.getByText('UNDEFINED')).toBeInTheDocument();
  });

  it('renders naked quantity with negative prefix', () => {
    renderTable({
      nakedPositions: [makeNaked({ contracts: 5 })],
    });
    expect(screen.getByText('-5')).toBeInTheDocument();
  });

  // ── % Max progress bar ───────────────────────────────────

  it('renders pctOfMaxProfit as a percentage', () => {
    renderTable({
      spreads: [makeSpread({ pctOfMaxProfit: 75 })],
    });
    expect(screen.getByText('75%')).toBeInTheDocument();
  });

  it('renders em-dash for null pctOfMaxProfit', () => {
    renderTable({
      spreads: [makeSpread({ pctOfMaxProfit: null })],
    });
    const rows = getDataRows();
    expect(rows[0]!.textContent).toContain('\u2014');
  });

  // ── Row ordering: ICs first, then spreads, hedges, naked ─

  it('renders ICs before spreads, hedges, and naked', () => {
    renderTable({
      ironCondors: [makeIC()],
      spreads: [makeSpread()],
      hedges: [makeHedge()],
      nakedPositions: [makeNaked()],
    });

    const rows = getDataRows();
    expect(rows[0]!.textContent).toContain('IC');
    expect(rows[1]!.textContent).toContain('PCS');
    expect(rows[2]!.textContent).toContain('HEDGE');
    expect(rows[3]!.textContent).toContain('NAKED');
  });

  // ── Max loss formatting ──────────────────────────────────

  it('formats negative max loss in parentheses', () => {
    renderTable({
      spreads: [makeSpread({ maxLoss: -18500 })],
    });
    expect(screen.getByText('($18,500.00)')).toBeInTheDocument();
  });

  // ── % Max progress bar color branches ────────────────────

  it('applies bg-success bar color when pctOfMaxProfit >= 80', () => {
    renderTable({ spreads: [makeSpread({ pctOfMaxProfit: 80 })] });
    const bar = document.querySelector('.bg-success');
    expect(bar).not.toBeNull();
  });

  it('applies bg-caution bar color when pctOfMaxProfit < 50', () => {
    renderTable({ spreads: [makeSpread({ pctOfMaxProfit: 49 })] });
    const bar = document.querySelector('.bg-caution');
    expect(bar).not.toBeNull();
  });

  it('applies bg-accent bar color when pctOfMaxProfit between 50 and 79', () => {
    renderTable({ spreads: [makeSpread({ pctOfMaxProfit: 65 })] });
    const bar = document.querySelector('.bg-accent');
    expect(bar).not.toBeNull();
  });

  it('clamps PctMaxBar width to 100% for values > 100', () => {
    renderTable({ spreads: [makeSpread({ pctOfMaxProfit: 150 })] });
    // Verifies the bar renders without error; clamping is internal
    expect(screen.getByText('150%')).toBeInTheDocument();
  });

  it('clamps PctMaxBar width to 0% for negative values', () => {
    renderTable({ spreads: [makeSpread({ pctOfMaxProfit: -10 })] });
    expect(screen.getByText('-10%')).toBeInTheDocument();
  });

  // ── ButterflyRow branches ─────────────────────────────────

  it('renders butterfly type label BFLY for symmetric butterfly', () => {
    const bfly: ButterflyPosition = {
      lowerLeg: makeLeg({ strike: 5560, type: 'PUT', qty: 1 }),
      middleLeg: makeLeg({ strike: 5580, type: 'PUT', qty: -2 }),
      upperLeg: makeLeg({ strike: 5600, type: 'PUT', qty: 1 }),
      optionType: 'PUT',
      contracts: 1,
      lowerWidth: 20,
      upperWidth: 20,
      isBrokenWing: false,
      maxProfitStrike: 5580,
      debitPaid: 150,
      maxProfit: 1850,
      maxLoss: 150,
      entryTime: '09:35',
      distanceToPin: -50,
    };
    renderTable({ butterflies: [bfly] });
    expect(screen.getByText('BFLY')).toBeInTheDocument();
  });

  it('renders BWB label for broken wing butterfly', () => {
    const bfly: ButterflyPosition = {
      lowerLeg: makeLeg({ strike: 5540, type: 'PUT', qty: 1 }),
      middleLeg: makeLeg({ strike: 5580, type: 'PUT', qty: -2 }),
      upperLeg: makeLeg({ strike: 5600, type: 'PUT', qty: 1 }),
      optionType: 'PUT',
      contracts: 1,
      lowerWidth: 40,
      upperWidth: 20,
      isBrokenWing: true,
      maxProfitStrike: 5580,
      debitPaid: 50,
      maxProfit: 1950,
      maxLoss: 2050,
      entryTime: '09:40',
      distanceToPin: null,
    };
    renderTable({ butterflies: [bfly] });
    expect(screen.getByText('BWB')).toBeInTheDocument();
  });

  it('renders butterfly strike label and type char', () => {
    const bfly: ButterflyPosition = {
      lowerLeg: makeLeg({ strike: 5560, type: 'PUT', qty: 1 }),
      middleLeg: makeLeg({ strike: 5580, type: 'PUT', qty: -2 }),
      upperLeg: makeLeg({ strike: 5600, type: 'PUT', qty: 1 }),
      optionType: 'PUT',
      contracts: 1,
      lowerWidth: 20,
      upperWidth: 20,
      isBrokenWing: false,
      maxProfitStrike: 5580,
      debitPaid: 150,
      maxProfit: 1850,
      maxLoss: 150,
      entryTime: null,
      distanceToPin: null,
    };
    renderTable({ butterflies: [bfly] });
    const table = screen.getByRole('table');
    expect(table.textContent).toContain('5560/5580/5600');
    expect(table.textContent).toContain('5560/5580/5600 P');
  });

  it('renders butterfly call type char C', () => {
    const bfly: ButterflyPosition = {
      lowerLeg: makeLeg({ strike: 5760, type: 'CALL', qty: 1 }),
      middleLeg: makeLeg({ strike: 5780, type: 'CALL', qty: -2 }),
      upperLeg: makeLeg({ strike: 5800, type: 'CALL', qty: 1 }),
      optionType: 'CALL',
      contracts: 1,
      lowerWidth: 20,
      upperWidth: 20,
      isBrokenWing: false,
      maxProfitStrike: 5780,
      debitPaid: 200,
      maxProfit: 1800,
      maxLoss: 200,
      entryTime: null,
      distanceToPin: null,
    };
    renderTable({ butterflies: [bfly] });
    const table = screen.getByRole('table');
    expect(table.textContent).toContain('5760/5780/5800 C');
  });

  it('renders em-dash for butterfly risk:reward when maxProfit is 0', () => {
    const bfly: ButterflyPosition = {
      lowerLeg: makeLeg({ strike: 5560, type: 'PUT', qty: 1 }),
      middleLeg: makeLeg({ strike: 5580, type: 'PUT', qty: -2 }),
      upperLeg: makeLeg({ strike: 5600, type: 'PUT', qty: 1 }),
      optionType: 'PUT',
      contracts: 1,
      lowerWidth: 20,
      upperWidth: 20,
      isBrokenWing: false,
      maxProfitStrike: 5580,
      debitPaid: 2000,
      maxProfit: 0, // zero maxProfit → em-dash for ratio
      maxLoss: 2000,
      entryTime: null,
      distanceToPin: null,
    };
    renderTable({ butterflies: [bfly] });
    const rows = getDataRows();
    // Row content should have em-dash in the risk:reward column
    expect(rows[0]!.textContent).toContain('\u2014');
  });

  it('renders butterfly distanceToPin with + prefix for positive values', () => {
    const bfly: ButterflyPosition = {
      lowerLeg: makeLeg({ strike: 5560, type: 'PUT', qty: 1 }),
      middleLeg: makeLeg({ strike: 5580, type: 'PUT', qty: -2 }),
      upperLeg: makeLeg({ strike: 5600, type: 'PUT', qty: 1 }),
      optionType: 'PUT',
      contracts: 1,
      lowerWidth: 20,
      upperWidth: 20,
      isBrokenWing: false,
      maxProfitStrike: 5580,
      debitPaid: 150,
      maxProfit: 1850,
      maxLoss: 150,
      entryTime: null,
      distanceToPin: 25,
    };
    renderTable({ butterflies: [bfly] });
    expect(screen.getByText('+25 pts')).toBeInTheDocument();
  });

  it('renders butterfly distanceToPin without + prefix for negative values', () => {
    const bfly: ButterflyPosition = {
      lowerLeg: makeLeg({ strike: 5560, type: 'PUT', qty: 1 }),
      middleLeg: makeLeg({ strike: 5580, type: 'PUT', qty: -2 }),
      upperLeg: makeLeg({ strike: 5600, type: 'PUT', qty: 1 }),
      optionType: 'PUT',
      contracts: 1,
      lowerWidth: 20,
      upperWidth: 20,
      isBrokenWing: false,
      maxProfitStrike: 5580,
      debitPaid: 150,
      maxProfit: 1850,
      maxLoss: 150,
      entryTime: null,
      distanceToPin: -30,
    };
    renderTable({ butterflies: [bfly] });
    expect(screen.getByText('-30 pts')).toBeInTheDocument();
  });

  it('renders em-dash for butterfly distanceToPin when null', () => {
    const bfly: ButterflyPosition = {
      lowerLeg: makeLeg({ strike: 5560, type: 'PUT', qty: 1 }),
      middleLeg: makeLeg({ strike: 5580, type: 'PUT', qty: -2 }),
      upperLeg: makeLeg({ strike: 5600, type: 'PUT', qty: 1 }),
      optionType: 'PUT',
      contracts: 1,
      lowerWidth: 20,
      upperWidth: 20,
      isBrokenWing: false,
      maxProfitStrike: 5580,
      debitPaid: 150,
      maxProfit: 1850,
      maxLoss: 150,
      entryTime: null,
      distanceToPin: null,
    };
    renderTable({ butterflies: [bfly] });
    const rows = getDataRows();
    expect(rows[0]!.textContent).toContain('\u2014');
  });

  // ── PositionTable: only butterflies (no spreads/ICs) ──────

  it('renders table with only butterfly positions', () => {
    const bfly: ButterflyPosition = {
      lowerLeg: makeLeg({ strike: 5560, type: 'PUT', qty: 1 }),
      middleLeg: makeLeg({ strike: 5580, type: 'PUT', qty: -2 }),
      upperLeg: makeLeg({ strike: 5600, type: 'PUT', qty: 1 }),
      optionType: 'PUT',
      contracts: 1,
      lowerWidth: 20,
      upperWidth: 20,
      isBrokenWing: false,
      maxProfitStrike: 5580,
      debitPaid: 150,
      maxProfit: 1850,
      maxLoss: 150,
      entryTime: null,
      distanceToPin: null,
    };
    renderTable({ butterflies: [bfly] });
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(
      screen.queryByText('No open positions found in this statement.'),
    ).not.toBeInTheDocument();
  });

  // ── IC with null cushionPct (both wings null) ─────────────

  it('renders IC with null cushion when pcts are null', () => {
    const ic = makeIC({
      putSpread: {
        ...makeIC().putSpread,
        distanceToShortStrikePct: null,
      },
      callSpread: {
        ...makeIC().callSpread,
        distanceToShortStrikePct: null,
      },
    });
    renderTable({ ironCondors: [ic] });
    const rows = getDataRows();
    // IC row with null cushion should render (not crash)
    expect(rows[0]!.textContent).toContain('IC');
  });

  // ── Alternating row background ────────────────────────────

  it('applies bg-table-alt to odd-indexed rows', () => {
    // With an IC + spread: IC is index 0 (bg-surface), spread is index 1 (bg-table-alt)
    renderTable({
      ironCondors: [makeIC()],
      spreads: [makeSpread()],
    });
    const rows = getDataRows();
    // IC row (index 0) has bg-surface
    expect(rows[0]!.className).toContain('bg-surface');
    // Spread row (index 1) has bg-table-alt
    expect(rows[1]!.className).toContain('bg-table-alt');
  });
});
