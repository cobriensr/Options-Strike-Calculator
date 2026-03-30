import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import AccountOverview from '../components/PositionMonitor/AccountOverview';
import type {
  AccountSummary,
  CashEntry,
  ClosedSpread,
  PnLSummary,
} from '../components/PositionMonitor/types';

// ============================================================
// FACTORIES
// ============================================================

function makeCashEntry(
  overrides: Partial<CashEntry> = {},
): CashEntry {
  return {
    date: '2026-03-29',
    time: '09:30:00',
    type: 'TRD',
    refNumber: null,
    description: 'Test trade',
    miscFees: 0,
    commissions: 0,
    amount: 0,
    balance: 100000,
    ...overrides,
  };
}

function makeAccountSummary(
  overrides: Partial<AccountSummary> = {},
): AccountSummary {
  return {
    netLiquidatingValue: 100000,
    stockBuyingPower: 200000,
    optionBuyingPower: 100000,
    equityCommissionsYtd: 250,
    ...overrides,
  };
}

function makePnlSummary(
  overrides: Partial<PnLSummary> = {},
): PnLSummary {
  return {
    entries: [],
    totals: null,
    ...overrides,
  };
}

function makeClosedSpread(
  overrides: Partial<ClosedSpread> = {},
): ClosedSpread {
  return {
    spreadType: 'PUT_CREDIT_SPREAD',
    shortStrike: 5650,
    longStrike: 5640,
    optionType: 'PUT',
    contracts: 1,
    wingWidth: 10,
    openCredit: 90,
    closeDebit: 20,
    realizedPnl: 70,
    openTime: '09:35:00',
    closeTime: '14:30:00',
    returnOnRisk: 0.077,
    creditCapturedPct: 77.8,
    holdTimeMinutes: 295,
    outcome: 'PARTIAL_PROFIT',
    ...overrides,
  };
}

function renderOverview(overrides?: {
  cashEntries?: readonly CashEntry[];
  accountSummary?: AccountSummary;
  pnl?: PnLSummary;
  closedSpreads?: readonly ClosedSpread[];
}) {
  return render(
    <AccountOverview
      cashEntries={overrides?.cashEntries ?? []}
      accountSummary={
        overrides?.accountSummary ?? makeAccountSummary()
      }
      pnl={overrides?.pnl ?? makePnlSummary()}
      closedSpreads={overrides?.closedSpreads ?? []}
    />,
  );
}

// ============================================================
// TESTS
// ============================================================

describe('AccountOverview', () => {
  it('renders the region with correct aria label', () => {
    renderOverview();
    expect(
      screen.getByRole('region', { name: 'Account overview' }),
    ).toBeInTheDocument();
  });

  it('renders the data-testid', () => {
    renderOverview();
    expect(
      screen.getByTestId('account-overview'),
    ).toBeInTheDocument();
  });

  // ── Top Row Cards ──────────────────────────────────────

  it('shows starting and ending balance of $0 with empty entries', () => {
    renderOverview({ cashEntries: [] });
    // Both should show $0.00
    const zeroes = screen.getAllByText('$0.00');
    expect(zeroes.length).toBeGreaterThanOrEqual(2);
  });

  it('computes starting balance from first BAL entry', () => {
    const entries = [
      makeCashEntry({
        type: 'BAL',
        balance: 50000,
        time: '00:00:00',
      }),
      makeCashEntry({
        type: 'TRD',
        balance: 50100,
        amount: 100,
      }),
    ];
    renderOverview({ cashEntries: entries });
    expect(screen.getByText('$50,000.00')).toBeInTheDocument();
  });

  it('computes ending balance from last cash entry', () => {
    const entries = [
      makeCashEntry({
        type: 'BAL',
        balance: 50000,
        time: '00:00:00',
      }),
      makeCashEntry({
        type: 'TRD',
        balance: 50350,
        amount: 350,
      }),
    ];
    renderOverview({ cashEntries: entries });
    expect(screen.getByText('$50,350.00')).toBeInTheDocument();
  });

  it('computes gross P&L as ending - starting', () => {
    const entries = [
      makeCashEntry({
        type: 'BAL',
        balance: 100000,
        time: '00:00:00',
      }),
      makeCashEntry({
        type: 'TRD',
        balance: 100500,
        amount: 500,
      }),
    ];
    renderOverview({ cashEntries: entries });
    expect(screen.getByText('$500.00')).toBeInTheDocument();
  });

  it('formats negative P&L with parentheses', () => {
    const entries = [
      makeCashEntry({
        type: 'BAL',
        balance: 100000,
        time: '00:00:00',
      }),
      makeCashEntry({
        type: 'TRD',
        balance: 99700,
        amount: -300,
      }),
    ];
    renderOverview({ cashEntries: entries });
    expect(screen.getByText('($300.00)')).toBeInTheDocument();
  });

  it('displays NLV from account summary', () => {
    renderOverview({
      accountSummary: makeAccountSummary({
        netLiquidatingValue: 123456.78,
      }),
    });
    expect(
      screen.getByText('$123,456.78'),
    ).toBeInTheDocument();
  });

  // ── Commissions & Fees ─────────────────────────────────

  it('sums total commissions and misc fees', () => {
    const entries = [
      makeCashEntry({ commissions: -1.3, miscFees: -0.2 }),
      makeCashEntry({ commissions: -1.3, miscFees: -0.2 }),
    ];
    renderOverview({ cashEntries: entries });
    // Total = 1.3+0.2 + 1.3+0.2 = 3.00
    expect(screen.getByText('$3.00')).toBeInTheDocument();
  });

  it('shows misc fee breakdown when present', () => {
    const entries = [
      makeCashEntry({ commissions: -2.6, miscFees: -0.4 }),
    ];
    renderOverview({ cashEntries: entries });
    expect(
      screen.getByText(/Commissions:.*Fees:/),
    ).toBeInTheDocument();
  });

  it('hides misc fee breakdown when miscFees are zero', () => {
    const entries = [
      makeCashEntry({ commissions: -1.3, miscFees: 0 }),
    ];
    renderOverview({ cashEntries: entries });
    expect(
      screen.queryByText(/Commissions:.*Fees:/),
    ).not.toBeInTheDocument();
  });

  it('computes fee drag as percentage of credits received', () => {
    // One TRD entry with $100 credit, commissions = $5
    const entries = [
      makeCashEntry({
        type: 'TRD',
        amount: 100,
        commissions: -5,
        miscFees: 0,
        balance: 100100,
      }),
    ];
    renderOverview({ cashEntries: entries });
    // feeDrag = (5 / 100) * 100 = 5.0%
    expect(screen.getByText('5.0%')).toBeInTheDocument();
  });

  it('shows fee drag with caution styling when > 5%', () => {
    const entries = [
      makeCashEntry({
        type: 'TRD',
        amount: 100,
        commissions: -6,
        miscFees: 0,
        balance: 100100,
      }),
    ];
    const { container } = renderOverview({ cashEntries: entries });
    // feeDrag = 6.0% > 5 → text-caution class
    const feeDragEl = container.querySelector('.text-caution');
    expect(feeDragEl).toBeInTheDocument();
    expect(feeDragEl?.textContent).toBe('6.0%');
  });

  it('shows 0.0% fee drag when no credits received', () => {
    const entries = [
      makeCashEntry({
        type: 'TRD',
        amount: -50,
        commissions: -2,
        balance: 99950,
      }),
    ];
    renderOverview({ cashEntries: entries });
    expect(screen.getByText('0.0%')).toBeInTheDocument();
  });

  it('displays YTD commissions from account summary', () => {
    renderOverview({
      accountSummary: makeAccountSummary({
        equityCommissionsYtd: 1234.56,
      }),
    });
    expect(screen.getByText('$1,234.56')).toBeInTheDocument();
  });

  // ── Closed Spreads Section ─────────────────────────────

  it('does not render closed spreads section when empty', () => {
    renderOverview({ closedSpreads: [] });
    expect(
      screen.queryByText('Closed Spreads'),
    ).not.toBeInTheDocument();
  });

  it('renders closed spreads section when spreads exist', () => {
    renderOverview({
      closedSpreads: [makeClosedSpread()],
    });
    expect(
      screen.getByText('Closed Spreads'),
    ).toBeInTheDocument();
  });

  it('shows win/loss record', () => {
    const spreads = [
      makeClosedSpread({ realizedPnl: 70 }),
      makeClosedSpread({ realizedPnl: 50 }),
      makeClosedSpread({ realizedPnl: -200 }),
    ];
    renderOverview({ closedSpreads: spreads });
    expect(screen.getByText('2W')).toBeInTheDocument();
    expect(screen.getByText('1L')).toBeInTheDocument();
  });

  it('computes total realized P&L', () => {
    const spreads = [
      makeClosedSpread({ realizedPnl: 70 }),
      makeClosedSpread({ realizedPnl: -200 }),
    ];
    renderOverview({ closedSpreads: spreads });
    // Total = 70 + (-200) = -130
    expect(screen.getByText('($130.00)')).toBeInTheDocument();
  });

  it('computes average winner', () => {
    const spreads = [
      makeClosedSpread({ realizedPnl: 60 }),
      makeClosedSpread({ realizedPnl: 80 }),
      makeClosedSpread({ realizedPnl: -100 }),
    ];
    renderOverview({ closedSpreads: spreads });
    // avgWinner = (60 + 80) / 2 = 70
    expect(screen.getByText('$70.00')).toBeInTheDocument();
  });

  it('shows em dash for avg winner when no winners', () => {
    const spreads = [
      makeClosedSpread({ realizedPnl: -100 }),
    ];
    renderOverview({ closedSpreads: spreads });
    // avgWinner = 0, renders \u2014
    expect(screen.getByText('Avg Winner').nextElementSibling)
      .toBeTruthy();
    const avgWinnerStat = screen
      .getByText('Avg Winner')
      .closest('div')?.parentElement;
    expect(avgWinnerStat?.textContent).toContain('\u2014');
  });

  it('computes average loser', () => {
    const spreads = [
      makeClosedSpread({ realizedPnl: 60 }),
      makeClosedSpread({ realizedPnl: -120 }),
      makeClosedSpread({ realizedPnl: -80 }),
    ];
    renderOverview({ closedSpreads: spreads });
    // avgLoser = (-120 + -80) / 2 = -100
    expect(screen.getByText('($100.00)')).toBeInTheDocument();
  });

  it('shows em dash for avg loser when no losers', () => {
    const spreads = [
      makeClosedSpread({ realizedPnl: 50 }),
    ];
    renderOverview({ closedSpreads: spreads });
    const avgLoserStat = screen
      .getByText('Avg Loser')
      .closest('div')?.parentElement;
    expect(avgLoserStat?.textContent).toContain('\u2014');
  });

  it('computes win rate', () => {
    const spreads = [
      makeClosedSpread({ realizedPnl: 70 }),
      makeClosedSpread({ realizedPnl: 50 }),
      makeClosedSpread({ realizedPnl: -200 }),
      makeClosedSpread({ realizedPnl: -100 }),
    ];
    renderOverview({ closedSpreads: spreads });
    // winRate = (2/4) * 100 = 50.0%
    expect(screen.getByText('50.0%')).toBeInTheDocument();
  });

  it('computes profit factor', () => {
    const spreads = [
      makeClosedSpread({ realizedPnl: 60 }),
      makeClosedSpread({ realizedPnl: 40 }),
      makeClosedSpread({ realizedPnl: -50 }),
    ];
    renderOverview({ closedSpreads: spreads });
    // grossWins = 100, grossLosses = 50, pf = 2.00
    expect(screen.getByText('2.00')).toBeInTheDocument();
  });

  it('shows infinity symbol when no losers (profit factor)', () => {
    const spreads = [
      makeClosedSpread({ realizedPnl: 70 }),
    ];
    renderOverview({ closedSpreads: spreads });
    expect(screen.getByText('\u221E')).toBeInTheDocument();
  });

  it('shows 0.00 profit factor when no winners and no losers of trades with zero PnL', () => {
    // All scratch trades with realizedPnl === 0
    const spreads = [
      makeClosedSpread({ realizedPnl: 0 }),
    ];
    // closedSpreads.length > 0 so section renders, but
    // no winners/no losers → grossWins=0, grossLosses=0 → pf=0
    renderOverview({ closedSpreads: spreads });
    expect(screen.getByText('0.00')).toBeInTheDocument();
  });

  // ── Broker P&L Section ─────────────────────────────────

  it('does not render broker P&L when totals is null', () => {
    renderOverview({
      pnl: makePnlSummary({ totals: null }),
    });
    expect(
      screen.queryByText('Broker P&L (Profits & Losses)'),
    ).not.toBeInTheDocument();
  });

  it('renders broker P&L section when totals exist', () => {
    renderOverview({
      pnl: makePnlSummary({
        totals: {
          symbol: 'TOTAL',
          description: 'Overall totals',
          plOpen: 150,
          plPct: 0.5,
          plDay: 200,
          plYtd: 5000,
          plDiff: 0,
          marginReq: 12000,
          markValue: 0,
        },
      }),
    });
    expect(
      screen.getByText('Broker P&L (Profits & Losses)'),
    ).toBeInTheDocument();
    expect(screen.getByText('$150.00')).toBeInTheDocument();
    expect(screen.getByText('$200.00')).toBeInTheDocument();
    expect(screen.getByText('$5,000.00')).toBeInTheDocument();
    expect(screen.getByText('$12,000.00')).toBeInTheDocument();
  });

  it('applies correct P&L color classes for positive values', () => {
    renderOverview({
      pnl: makePnlSummary({
        totals: {
          symbol: 'TOTAL',
          description: '',
          plOpen: 100,
          plPct: 0,
          plDay: 200,
          plYtd: 300,
          plDiff: 0,
          marginReq: 0,
          markValue: 0,
        },
      }),
    });
    const plOpenEl = screen.getByText('$100.00');
    expect(plOpenEl.className).toContain('text-success');
  });

  it('applies correct P&L color classes for negative values', () => {
    renderOverview({
      pnl: makePnlSummary({
        totals: {
          symbol: 'TOTAL',
          description: '',
          plOpen: -500,
          plPct: 0,
          plDay: 0,
          plYtd: 0,
          plDiff: 0,
          marginReq: 0,
          markValue: 0,
        },
      }),
    });
    const plOpenEl = screen.getByText('($500.00)');
    expect(plOpenEl.className).toContain('text-danger');
  });

  it('applies text-primary class for zero P&L values', () => {
    renderOverview({
      pnl: makePnlSummary({
        totals: {
          symbol: 'TOTAL',
          description: '',
          plOpen: 0,
          plPct: 0,
          plDay: 0,
          plYtd: 0,
          plDiff: 0,
          marginReq: 0,
          markValue: 0,
        },
      }),
    });
    // P&L Open label exists, the value $0.00 should have text-primary
    const stats = screen.getAllByText('$0.00');
    const plOpenStat = stats.find(
      (el) => el.className.includes('text-primary'),
    );
    expect(plOpenStat).toBeTruthy();
  });

  // ── Labels ─────────────────────────────────────────────

  it('renders all top-row card labels', () => {
    renderOverview();
    expect(
      screen.getByText('Starting Balance'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Ending Balance'),
    ).toBeInTheDocument();
    expect(screen.getByText('Day P&L')).toBeInTheDocument();
    expect(screen.getByText('NLV')).toBeInTheDocument();
  });

  it('renders commissions section labels', () => {
    renderOverview();
    expect(
      screen.getByText('Commissions & Fees'),
    ).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Fee Drag')).toBeInTheDocument();
    expect(screen.getByText('YTD')).toBeInTheDocument();
  });
});
