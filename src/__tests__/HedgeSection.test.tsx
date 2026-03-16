import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import HedgeSection from '../components/HedgeSection';
import { lightTheme } from '../themes';
import type { CalculationResults, IronCondorLegs } from '../types';

const th = lightTheme;

// ============================================================
// HELPERS
// ============================================================

function makeResults(
  overrides: Partial<CalculationResults> = {},
): CalculationResults {
  return {
    allDeltas: [],
    sigma: 0.23,
    T: 0.003,
    hoursRemaining: 4.87,
    spot: 5700,
    ...overrides,
  };
}

function makeIC(): IronCondorLegs {
  return {
    delta: 10,
    shortPut: 5630,
    longPut: 5620,
    shortCall: 5770,
    longCall: 5780,
    shortPutSpy: 563,
    longPutSpy: 562,
    shortCallSpy: 577,
    longCallSpy: 578,
    wingWidthSpx: 10,
    shortPutPremium: 1.85,
    longPutPremium: 0.95,
    shortCallPremium: 1.72,
    longCallPremium: 0.88,
    creditReceived: 1.74,
    maxProfit: 1.74,
    maxLoss: 8.26,
    breakEvenLow: 5628.26,
    breakEvenHigh: 5771.74,
    returnOnRisk: 0.2106,
    probabilityOfProfit: 0.82,
    putSpreadCredit: 0.9,
    callSpreadCredit: 0.84,
    putSpreadMaxLoss: 9.1,
    callSpreadMaxLoss: 9.16,
    putSpreadBE: 5629.1,
    callSpreadBE: 5770.84,
    putSpreadRoR: 0.0989,
    callSpreadRoR: 0.0917,
    putSpreadPoP: 0.92,
    callSpreadPoP: 0.91,
    adjustedPoP: 0.75,
    adjustedPutSpreadPoP: 0.85,
    adjustedCallSpreadPoP: 0.85,
  };
}

function renderHedge(overrides?: { contracts?: number; skew?: number }) {
  return render(
    <HedgeSection
      th={th}
      results={makeResults()}
      ic={makeIC()}
      contracts={overrides?.contracts ?? 10}
      skew={overrides?.skew ?? 0.03}
    />,
  );
}

// ============================================================
// TESTS
// ============================================================

describe('HedgeSection', () => {
  it('renders the section heading', () => {
    renderHedge();
    expect(
      screen.getByText('Hedge Calculator (Reinsurance)'),
    ).toBeInTheDocument();
  });

  it('shows hedge delta buttons', () => {
    renderHedge();
    expect(screen.getByRole('radio', { name: '1\u0394' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '2\u0394' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '3\u0394' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '5\u0394' })).toBeInTheDocument();
  });

  it('defaults to 2\u0394 selected', () => {
    renderHedge();
    const btn2 = screen.getByRole('radio', { name: '2\u0394' });
    expect(btn2).toHaveAttribute('aria-checked', 'true');

    const btn1 = screen.getByRole('radio', { name: '1\u0394' });
    expect(btn1).toHaveAttribute('aria-checked', 'false');
  });

  it('shows put hedge section', () => {
    renderHedge();
    expect(
      screen.getByText('Put Hedge (Crash Protection)'),
    ).toBeInTheDocument();
    expect(screen.getByText('Buy Puts')).toBeInTheDocument();
    expect(screen.getAllByText('Strike')).toHaveLength(2);
    expect(screen.getAllByText('Premium')).toHaveLength(2);
  });

  it('shows call hedge section', () => {
    renderHedge();
    expect(
      screen.getByText('Call Hedge (Rally Protection)'),
    ).toBeInTheDocument();
    expect(screen.getByText('Buy Calls')).toBeInTheDocument();
  });

  it('shows summary stats', () => {
    renderHedge();
    expect(screen.getByText('Net Daily Cost')).toBeInTheDocument();
    expect(screen.getByText('IC Credit')).toBeInTheDocument();
    expect(screen.getByText('Net Credit After Hedge')).toBeInTheDocument();
    expect(screen.getByText('Hedge % of Credit')).toBeInTheDocument();
  });

  it('scenario table is hidden by default', () => {
    renderHedge();
    expect(
      screen.queryByText('Crash Scenarios (SPX drops)'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Rally Scenarios (SPX rises)'),
    ).not.toBeInTheDocument();
  });

  it('clicking Show P&L Scenario Table reveals scenario tables', async () => {
    const user = userEvent.setup();
    renderHedge();

    const toggleBtn = screen.getByRole('button', {
      name: /show p&l scenario table/i,
    });
    await user.click(toggleBtn);

    expect(screen.getByText('Crash Scenarios (SPX drops)')).toBeInTheDocument();
    expect(screen.getByText('Rally Scenarios (SPX rises)')).toBeInTheDocument();
  });

  it('clicking a different hedge delta updates the selection', async () => {
    const user = userEvent.setup();
    renderHedge();

    const btn5 = screen.getByRole('radio', { name: '5\u0394' });
    expect(btn5).toHaveAttribute('aria-checked', 'false');

    await user.click(btn5);
    expect(btn5).toHaveAttribute('aria-checked', 'true');

    const btn2 = screen.getByRole('radio', { name: '2\u0394' });
    expect(btn2).toHaveAttribute('aria-checked', 'false');
  });
});
