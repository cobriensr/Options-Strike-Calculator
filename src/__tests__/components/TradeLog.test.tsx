import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TradeLog from '../../components/PositionMonitor/TradeLog';
import type {
  CashEntry,
  ClosedSpread,
  ExecutedTrade,
  TradeLeg,
} from '../../components/PositionMonitor/types';

// ── Factories ────────────────────────────────────────────────

function makeLeg(overrides: Partial<TradeLeg> = {}): TradeLeg {
  return {
    side: 'SELL',
    qty: -10,
    posEffect: 'TO OPEN',
    symbol: 'SPX',
    exp: '2026-03-27',
    strike: 5600,
    type: 'PUT',
    price: 3.5,
    creditDebit: 'CREDIT',
    ...overrides,
  };
}

function makeTrade(
  overrides: Omit<Partial<ExecutedTrade>, 'legs'> & {
    legs?: TradeLeg[];
  } = {},
): ExecutedTrade {
  const { legs, ...rest } = overrides;
  return {
    execTime: '09:30:00',
    spread: 'VERTICAL',
    netPrice: 1.5,
    orderType: 'LMT',
    legs: legs ?? [
      makeLeg({
        side: 'SELL',
        strike: 5600,
        type: 'PUT',
        price: 3.5,
      }),
      makeLeg({
        side: 'BUY',
        qty: 10,
        strike: 5580,
        type: 'PUT',
        price: 2.0,
        creditDebit: null,
      }),
    ],
    ...rest,
  };
}

function makeClosingTrade(
  overrides: Omit<Partial<ExecutedTrade>, 'legs'> = {},
): ExecutedTrade {
  return makeTrade({
    execTime: '14:00:00',
    netPrice: -0.05,
    legs: [
      makeLeg({
        side: 'BUY',
        qty: 10,
        posEffect: 'TO CLOSE',
        strike: 5800,
        type: 'CALL',
        price: 0.1,
        creditDebit: 'DEBIT',
      }),
      makeLeg({
        side: 'SELL',
        qty: -10,
        posEffect: 'TO CLOSE',
        strike: 5820,
        type: 'CALL',
        price: 0.05,
        creditDebit: null,
      }),
    ],
    ...overrides,
  });
}

function makeCashEntry(
  overrides: Partial<CashEntry> = {},
): CashEntry {
  return {
    date: '3/27/26',
    time: '09:30:00',
    type: 'TRD',
    refNumber: '1001',
    description: 'SOLD -10 VERTICAL SPX',
    miscFees: -10.52,
    commissions: -13.0,
    amount: 1500,
    balance: 101476.48,
    ...overrides,
  };
}

function makeClosedSpread(
  overrides: Partial<ClosedSpread> = {},
): ClosedSpread {
  return {
    spreadType: 'CALL_CREDIT_SPREAD',
    shortStrike: 5800,
    longStrike: 5820,
    optionType: 'CALL',
    contracts: 10,
    wingWidth: 20,
    openCredit: 1000,
    closeDebit: 50,
    realizedPnl: 950,
    openTime: '09:35:00',
    closeTime: '14:00:00',
    returnOnRisk: 0.05,
    creditCapturedPct: 95,
    holdTimeMinutes: 265,
    outcome: 'FULL_PROFIT',
    ...overrides,
  };
}

// ── Render helper ────────────────────────────────────────────

function renderTradeLog(
  overrides: {
    trades?: ExecutedTrade[];
    cashEntries?: CashEntry[];
    closedSpreads?: ClosedSpread[];
  } = {},
) {
  return render(
    <TradeLog
      trades={overrides.trades ?? [makeTrade()]}
      cashEntries={overrides.cashEntries ?? [makeCashEntry()]}
      closedSpreads={overrides.closedSpreads ?? []}
    />,
  );
}

/** Get data rows from the trade table (skipping the header). */
function getDataRows() {
  const table = screen.getByRole('table');
  const rows = within(table).getAllByRole('row');
  return rows.slice(1);
}

// ── Tests ────────────────────────────────────────────────────

describe('TradeLog', () => {
  // ── Empty state ──────────────────────────────────────────

  it('shows empty message when no trades exist', () => {
    render(
      <TradeLog trades={[]} cashEntries={[]} closedSpreads={[]} />,
    );
    expect(
      screen.getByText('No trades found in this statement.'),
    ).toBeInTheDocument();
  });

  it('renders data-testid when empty', () => {
    render(
      <TradeLog trades={[]} cashEntries={[]} closedSpreads={[]} />,
    );
    expect(screen.getByTestId('trade-log')).toBeInTheDocument();
  });

  it('does not render a table when empty', () => {
    render(
      <TradeLog trades={[]} cashEntries={[]} closedSpreads={[]} />,
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  // ── Region and structure ─────────────────────────────────

  it('renders the trade log region', () => {
    renderTradeLog();
    expect(
      screen.getByRole('region', { name: 'Trade log' }),
    ).toBeInTheDocument();
  });

  it('renders data-testid when populated', () => {
    renderTradeLog();
    expect(screen.getByTestId('trade-log')).toBeInTheDocument();
  });

  it('renders the trade history table', () => {
    renderTradeLog();
    expect(
      screen.getByRole('table', { name: 'Trade history' }),
    ).toBeInTheDocument();
  });

  it('renders all column headers', () => {
    renderTradeLog();
    expect(screen.getByText('Time')).toBeInTheDocument();
    expect(screen.getByText('Action')).toBeInTheDocument();
    expect(screen.getByText('Spread')).toBeInTheDocument();
    expect(screen.getByText('Strikes')).toBeInTheDocument();
    expect(screen.getByText('Qty')).toBeInTheDocument();
    expect(screen.getByText('Net Price')).toBeInTheDocument();
    expect(screen.getByText('Fees')).toBeInTheDocument();
    expect(screen.getByText('Balance')).toBeInTheDocument();
  });

  // ── Trade row data ───────────────────────────────────────

  it('renders execution time in HH:MM format', () => {
    renderTradeLog({
      trades: [makeTrade({ execTime: '09:30:00' })],
    });
    expect(screen.getByText('09:30')).toBeInTheDocument();
  });

  it('extracts time from ISO format', () => {
    renderTradeLog({
      trades: [makeTrade({ execTime: '2026-03-27T14:30:00' })],
      cashEntries: [],
    });
    expect(screen.getByText('14:30')).toBeInTheDocument();
  });

  it('renders SOLD TO OPEN for sell-to-open trades', () => {
    renderTradeLog({
      trades: [
        makeTrade({
          legs: [
            makeLeg({
              side: 'SELL',
              posEffect: 'TO OPEN',
              strike: 5600,
              type: 'PUT',
              price: 3.5,
            }),
          ],
        }),
      ],
    });
    expect(screen.getByText('SOLD TO OPEN')).toBeInTheDocument();
  });

  it('renders BOT TO CLOSE for buy-to-close trades', () => {
    renderTradeLog({
      trades: [makeClosingTrade()],
      cashEntries: [],
    });
    expect(screen.getByText('BOT TO CLOSE')).toBeInTheDocument();
  });

  it('renders spread type', () => {
    renderTradeLog({
      trades: [makeTrade({ spread: 'VERTICAL' })],
    });
    expect(screen.getByText('VERTICAL')).toBeInTheDocument();
  });

  // ── strikeLabel helper ───────────────────────────────────

  it('renders strikes with option type suffix for same-type legs', () => {
    renderTradeLog({
      trades: [
        makeTrade({
          legs: [
            makeLeg({ side: 'SELL', strike: 5600, type: 'PUT' }),
            makeLeg({
              side: 'BUY',
              qty: 10,
              strike: 5580,
              type: 'PUT',
            }),
          ],
        }),
      ],
    });
    expect(screen.getByText('5600/5580 P')).toBeInTheDocument();
  });

  it('renders strikes with per-leg type suffix for mixed types', () => {
    renderTradeLog({
      trades: [
        makeTrade({
          legs: [
            makeLeg({
              side: 'SELL',
              strike: 5600,
              type: 'PUT',
            }),
            makeLeg({
              side: 'SELL',
              strike: 5800,
              type: 'CALL',
            }),
          ],
        }),
      ],
    });
    expect(screen.getByText('5600P/5800C')).toBeInTheDocument();
  });

  it('renders em-dash for trades with no legs', () => {
    renderTradeLog({
      trades: [
        {
          execTime: '09:30:00',
          spread: 'SINGLE',
          netPrice: 1.0,
          orderType: 'LMT',
          legs: [],
        },
      ],
    });
    const rows = getDataRows();
    expect(rows[0]!.textContent).toContain('\u2014');
  });

  // ── Quantity ─────────────────────────────────────────────

  it('renders max quantity from legs', () => {
    renderTradeLog({
      trades: [
        makeTrade({
          legs: [
            makeLeg({
              side: 'SELL',
              qty: -10,
              strike: 5600,
              type: 'PUT',
            }),
            makeLeg({
              side: 'BUY',
              qty: 10,
              strike: 5580,
              type: 'PUT',
            }),
          ],
        }),
      ],
    });
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  // ── Net price / P&L coloring ─────────────────────────────

  it('renders net price with currency formatting', () => {
    renderTradeLog({
      trades: [makeTrade({ netPrice: 1.5 })],
    });
    expect(screen.getByText('$1.50')).toBeInTheDocument();
  });

  it('applies success color for positive net price', () => {
    renderTradeLog({
      trades: [makeTrade({ netPrice: 1.5 })],
    });
    const priceCell = screen.getByText('$1.50');
    const td = priceCell.closest('td') as HTMLElement;
    expect(td.className).toContain('text-success');
  });

  it('applies danger color for negative net price', () => {
    renderTradeLog({
      trades: [makeTrade({ netPrice: -0.5 })],
    });
    const priceCell = screen.getByText('($0.50)');
    const td = priceCell.closest('td') as HTMLElement;
    expect(td.className).toContain('text-danger');
  });

  it('applies primary color for zero net price', () => {
    renderTradeLog({
      trades: [makeTrade({ netPrice: 0 })],
    });
    const priceCell = screen.getByText('$0.00');
    const td = priceCell.closest('td') as HTMLElement;
    expect(td.className).toContain('text-primary');
  });

  // ── matchCashEntry / fees / balance ──────────────────────

  it('displays fees from matched cash entry', () => {
    const trade = makeTrade({ execTime: '09:30:00' });
    const cash = makeCashEntry({
      time: '09:30:00',
      commissions: -13.0,
      miscFees: -10.52,
    });
    renderTradeLog({ trades: [trade], cashEntries: [cash] });
    // fees = abs(-13.0) + abs(-10.52) = 23.52
    expect(screen.getByText('$23.52')).toBeInTheDocument();
  });

  it('displays balance from matched cash entry', () => {
    const trade = makeTrade({ execTime: '09:30:00' });
    const cash = makeCashEntry({
      time: '09:30:00',
      balance: 101476.48,
    });
    renderTradeLog({ trades: [trade], cashEntries: [cash] });
    expect(screen.getByText('$101,476.48')).toBeInTheDocument();
  });

  it('shows em-dash for fees when no cash match', () => {
    renderTradeLog({
      trades: [makeTrade({ execTime: '10:00:00' })],
      cashEntries: [makeCashEntry({ time: '09:30:00' })],
    });
    const rows = getDataRows();
    const cells = within(rows[0]!).getAllByRole('cell');
    const feesCell = cells[6]!;
    expect(feesCell.textContent).toBe('\u2014');
  });

  it('shows em-dash for balance when no cash match', () => {
    renderTradeLog({
      trades: [makeTrade({ execTime: '10:00:00' })],
      cashEntries: [makeCashEntry({ time: '09:30:00' })],
    });
    const rows = getDataRows();
    const cells = within(rows[0]!).getAllByRole('cell');
    const balanceCell = cells[7]!;
    expect(balanceCell.textContent).toBe('\u2014');
  });

  it('only matches TRD-type cash entries', () => {
    renderTradeLog({
      trades: [makeTrade({ execTime: '09:30:00' })],
      cashEntries: [
        makeCashEntry({
          time: '09:30:00',
          type: 'BAL',
          balance: 999999,
        }),
      ],
    });
    const rows = getDataRows();
    const cells = within(rows[0]!).getAllByRole('cell');
    const balanceCell = cells[7]!;
    expect(balanceCell.textContent).toBe('\u2014');
  });

  // ── matchClosedSpread / realized P&L badge ───────────────

  it('shows realized P&L badge for closing trade with matched closed spread', () => {
    const closingTrade = makeClosingTrade({
      execTime: '14:00:00',
    });
    const closed = makeClosedSpread({
      closeTime: '14:00:00',
      shortStrike: 5800,
      longStrike: 5820,
      realizedPnl: 950,
    });
    renderTradeLog({
      trades: [closingTrade],
      cashEntries: [],
      closedSpreads: [closed],
    });
    expect(screen.getByText('$950.00')).toBeInTheDocument();
  });

  it('does not show P&L badge for opening trades', () => {
    const openTrade = makeTrade({ execTime: '09:30:00' });
    const closed = makeClosedSpread({
      closeTime: '09:30:00',
      shortStrike: 5600,
      realizedPnl: 500,
    });
    renderTradeLog({
      trades: [openTrade],
      cashEntries: [],
      closedSpreads: [closed],
    });
    expect(screen.queryByText('$500.00')).not.toBeInTheDocument();
  });

  it('applies success style for positive realized P&L', () => {
    const closingTrade = makeClosingTrade({
      execTime: '14:00:00',
    });
    const closed = makeClosedSpread({
      closeTime: '14:00:00',
      shortStrike: 5800,
      longStrike: 5820,
      realizedPnl: 950,
    });
    renderTradeLog({
      trades: [closingTrade],
      cashEntries: [],
      closedSpreads: [closed],
    });
    const badge = screen.getByText('$950.00');
    expect(badge.className).toContain('text-success');
  });

  it('applies danger style for negative realized P&L', () => {
    const closingTrade = makeClosingTrade({
      execTime: '14:00:00',
    });
    const closed = makeClosedSpread({
      closeTime: '14:00:00',
      shortStrike: 5800,
      longStrike: 5820,
      realizedPnl: -200,
    });
    renderTradeLog({
      trades: [closingTrade],
      cashEntries: [],
      closedSpreads: [closed],
    });
    const badge = screen.getByText('($200.00)');
    expect(badge.className).toContain('text-danger');
  });

  // ── Filter buttons ───────────────────────────────────────

  it('renders All, Opens, and Closes filter buttons', () => {
    renderTradeLog();
    expect(
      screen.getByRole('button', { name: 'All' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Opens' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Closes' }),
    ).toBeInTheDocument();
  });

  it('shows trade count next to filter buttons', () => {
    renderTradeLog({ trades: [makeTrade(), makeTrade()] });
    expect(screen.getByText('2 trades')).toBeInTheDocument();
  });

  it('shows singular trade count for single trade', () => {
    renderTradeLog({ trades: [makeTrade()] });
    expect(screen.getByText('1 trade')).toBeInTheDocument();
  });

  it('defaults to All filter showing all trades', () => {
    const openTrade = makeTrade({ execTime: '09:30:00' });
    const closeTrade = makeClosingTrade({
      execTime: '14:00:00',
    });
    renderTradeLog({
      trades: [openTrade, closeTrade],
      cashEntries: [],
    });
    expect(screen.getByText('2 trades')).toBeInTheDocument();
  });

  it('filters to only opens when Opens is clicked', async () => {
    const user = userEvent.setup();
    const openTrade = makeTrade({ execTime: '09:30:00' });
    const closeTrade = makeClosingTrade({
      execTime: '14:00:00',
    });
    renderTradeLog({
      trades: [openTrade, closeTrade],
      cashEntries: [],
    });

    await user.click(
      screen.getByRole('button', { name: 'Opens' }),
    );

    expect(screen.getByText('1 trade')).toBeInTheDocument();
    expect(screen.getByText('SOLD TO OPEN')).toBeInTheDocument();
    expect(
      screen.queryByText('BOT TO CLOSE'),
    ).not.toBeInTheDocument();
  });

  it('filters to only closes when Closes is clicked', async () => {
    const user = userEvent.setup();
    const openTrade = makeTrade({ execTime: '09:30:00' });
    const closeTrade = makeClosingTrade({
      execTime: '14:00:00',
    });
    renderTradeLog({
      trades: [openTrade, closeTrade],
      cashEntries: [],
    });

    await user.click(
      screen.getByRole('button', { name: 'Closes' }),
    );

    expect(screen.getByText('1 trade')).toBeInTheDocument();
    expect(
      screen.queryByText('SOLD TO OPEN'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('BOT TO CLOSE')).toBeInTheDocument();
  });

  it('returns to all trades when All is clicked after filtering', async () => {
    const user = userEvent.setup();
    const openTrade = makeTrade({ execTime: '09:30:00' });
    const closeTrade = makeClosingTrade({
      execTime: '14:00:00',
    });
    renderTradeLog({
      trades: [openTrade, closeTrade],
      cashEntries: [],
    });

    await user.click(
      screen.getByRole('button', { name: 'Opens' }),
    );
    expect(screen.getByText('1 trade')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'All' }),
    );
    expect(screen.getByText('2 trades')).toBeInTheDocument();
  });

  it('applies active styling to selected filter button', async () => {
    const user = userEvent.setup();
    renderTradeLog();

    const allBtn = screen.getByRole('button', { name: 'All' });
    const opensBtn = screen.getByRole('button', { name: 'Opens' });

    // Default: All is active
    expect(allBtn.className).toContain(
      'border-chip-active-border',
    );
    expect(opensBtn.className).not.toContain(
      'border-chip-active-border',
    );

    await user.click(opensBtn);
    expect(opensBtn.className).toContain(
      'border-chip-active-border',
    );
    expect(allBtn.className).not.toContain(
      'border-chip-active-border',
    );
  });

  // ── Trade row expansion ──────────────────────────────────

  it('expands trade row to show leg details on click', async () => {
    const user = userEvent.setup();
    renderTradeLog({
      trades: [
        makeTrade({
          legs: [
            makeLeg({
              side: 'SELL',
              strike: 5600,
              type: 'PUT',
              price: 3.5,
            }),
            makeLeg({
              side: 'BUY',
              qty: 10,
              strike: 5580,
              type: 'PUT',
              price: 2.0,
            }),
          ],
        }),
      ],
    });

    expect(screen.queryByText('Leg 1')).not.toBeInTheDocument();

    const rows = getDataRows();
    await user.click(rows[0]!);

    expect(screen.getByText('Leg 1')).toBeInTheDocument();
    expect(screen.getByText('Leg 2')).toBeInTheDocument();
  });

  it('shows leg details including side, posEffect, strike, and price', async () => {
    const user = userEvent.setup();
    renderTradeLog({
      trades: [
        makeTrade({
          legs: [
            makeLeg({
              side: 'SELL',
              posEffect: 'TO OPEN',
              strike: 5600,
              type: 'PUT',
              price: 3.5,
              creditDebit: 'CREDIT',
            }),
          ],
        }),
      ],
      cashEntries: [],
    });

    const rows = getDataRows();
    await user.click(rows[0]!);

    // After expansion, find the leg row (second data row)
    const allDataRows = getDataRows();
    const legRow = allDataRows[1]!;
    expect(
      within(legRow).getByText('SELL TO OPEN'),
    ).toBeInTheDocument();
    expect(within(legRow).getByText('5600 P')).toBeInTheDocument();
    expect(within(legRow).getByText('3.50')).toBeInTheDocument();
    expect(within(legRow).getByText('CREDIT')).toBeInTheDocument();
  });

  it('collapses leg details on second click', async () => {
    const user = userEvent.setup();
    renderTradeLog({
      trades: [
        makeTrade({
          legs: [
            makeLeg({
              side: 'SELL',
              strike: 5600,
              type: 'PUT',
              price: 3.5,
            }),
          ],
        }),
      ],
      cashEntries: [],
    });

    const rows = getDataRows();
    await user.click(rows[0]!); // expand
    expect(screen.getByText('Leg 1')).toBeInTheDocument();

    await user.click(rows[0]!); // collapse
    expect(screen.queryByText('Leg 1')).not.toBeInTheDocument();
  });

  // ── Zero fees display ────────────────────────────────────

  it('shows em-dash for zero fees', () => {
    renderTradeLog({
      trades: [makeTrade({ execTime: '09:30:00' })],
      cashEntries: [
        makeCashEntry({
          time: '09:30:00',
          commissions: 0,
          miscFees: 0,
        }),
      ],
    });
    const rows = getDataRows();
    const cells = within(rows[0]!).getAllByRole('cell');
    const feesCell = cells[6]!;
    expect(feesCell.textContent).toBe('\u2014');
  });
});
