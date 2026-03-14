import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IronCondorSection from '../components/IronCondorSection';
import { lightTheme } from '../themes';
import type { CalculationResults, DeltaRow } from '../types';

const th = lightTheme;

// ============================================================
// HELPERS
// ============================================================

function makeDeltaRow(delta: 5 | 8 | 10 | 12 | 15 | 20 = 10): DeltaRow {
  return {
    delta,
    z: 1.28,
    putStrike: 5630.5,
    callStrike: 5769.5,
    putSnapped: 5630,
    callSnapped: 5770,
    putSpySnapped: 563,
    callSpySnapped: 577,
    spyPut: '563',
    spyCall: '577',
    putDistance: 69.5,
    callDistance: 69.5,
    putPct: '1.22%',
    callPct: '1.22%',
    putPremium: 1.85,
    callPremium: 1.72,
    putSigma: 0.2,
    callSigma: 0.18,
    putActualDelta: 0.098,
    callActualDelta: 0.095,
    putGamma: 0.0012,
    callGamma: 0.0011,
  };
}

function makeResults(
  overrides: Partial<CalculationResults> = {},
): CalculationResults {
  return {
    allDeltas: [makeDeltaRow(10)],
    sigma: 0.15,
    T: 0.03,
    hoursRemaining: 7,
    spot: 5700,
    ...overrides,
  };
}

function renderSection(
  overrides: Partial<CalculationResults> = {},
  props?: { wingWidth?: number; contracts?: number },
) {
  return render(
    <IronCondorSection
      th={th}
      results={makeResults(overrides)}
      wingWidth={props?.wingWidth ?? 25}
      contracts={props?.contracts ?? 1}
      effectiveRatio={10}
      skewPct={0}
    />,
  );
}

// ============================================================
// TESTS
// ============================================================

describe('IronCondorSection', () => {
  it('renders iron condor heading with wing width', () => {
    renderSection({}, { wingWidth: 25 });
    expect(screen.getByText(/Iron Condor \(25-pt wings\)/)).toBeInTheDocument();
  });

  it('renders heading with different wing width', () => {
    renderSection({}, { wingWidth: 50 });
    expect(screen.getByText(/Iron Condor \(50-pt wings\)/)).toBeInTheDocument();
  });

  it('renders legs table', () => {
    renderSection();
    expect(
      screen.getByRole('table', { name: 'Iron condor legs by delta' }),
    ).toBeInTheDocument();
  });

  it('renders P&L table', () => {
    renderSection();
    expect(
      screen.getByRole('table', { name: 'Iron condor P&L by delta' }),
    ).toBeInTheDocument();
  });

  it('shows contract count in P&L heading (singular)', () => {
    renderSection({}, { contracts: 1 });
    expect(screen.getByText(/1 contract \(theoretical\)/)).toBeInTheDocument();
  });

  it('shows contract count in P&L heading (plural)', () => {
    renderSection({}, { contracts: 3 });
    expect(screen.getByText(/3 contracts \(theoretical\)/)).toBeInTheDocument();
  });

  it('shows hedge calculator toggle button', () => {
    renderSection();
    const btn = screen.getByRole('button', { name: /Hedge Calculator/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows export button', () => {
    renderSection();
    expect(
      screen.getByRole('button', { name: 'Export P&L comparison to Excel' }),
    ).toBeInTheDocument();
  });

  it('hedge section hidden by default', () => {
    renderSection();
    const btn = screen.getByRole('button', { name: /Hedge Calculator/i });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    // Delta selector chips should not appear
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('toggling hedge button shows hedge content', async () => {
    const user = userEvent.setup();
    renderSection();
    const btn = screen.getByRole('button', { name: /Hedge Calculator/i });
    await user.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders with multiple delta rows and shows delta selector chips when hedge open', async () => {
    const user = userEvent.setup();
    renderSection({
      allDeltas: [makeDeltaRow(5), makeDeltaRow(10), makeDeltaRow(15)],
    });

    const btn = screen.getByRole('button', { name: /Hedge Calculator/i });
    await user.click(btn);

    // IC Delta selector label and chips appear
    const icDeltaLabel = screen.getByText('IC Delta');
    expect(icDeltaLabel).toBeInTheDocument();

    // The chip container is the parent of the label
    const chipContainer = icDeltaLabel.parentElement!;
    const chips = chipContainer.querySelectorAll('[role="radio"]');
    expect(chips).toHaveLength(3);
    expect(chips[0]).toHaveTextContent(/5/);
    expect(chips[1]).toHaveTextContent(/10/);
    expect(chips[2]).toHaveTextContent(/15/);
  });

  it('does not show IC Delta label with single delta row when hedge open', async () => {
    const user = userEvent.setup();
    renderSection({ allDeltas: [makeDeltaRow(10)] });

    const btn = screen.getByRole('button', { name: /Hedge Calculator/i });
    await user.click(btn);

    // The "IC Delta" label only appears when icRows.length > 1
    expect(screen.queryByText('IC Delta')).not.toBeInTheDocument();
  });

  it('clicking a delta chip selects it', async () => {
    const user = userEvent.setup();
    renderSection({
      allDeltas: [makeDeltaRow(5), makeDeltaRow(10), makeDeltaRow(15)],
    });

    // Open hedge section
    const btn = screen.getByRole('button', { name: /Hedge Calculator/i });
    await user.click(btn);

    // Scope to IC Delta chip container
    const icLabel = screen.getByText('IC Delta');
    const chipContainer = icLabel.parentElement!;
    const chips = chipContainer.querySelectorAll('[role="radio"]');
    expect(chips).toHaveLength(3);
    // First chip is selected by default
    expect(chips[0]!).toHaveAttribute('aria-checked', 'true');
    expect(chips[1]!).toHaveAttribute('aria-checked', 'false');

    // Click second chip
    await user.click(chips[1]!);
    expect(chips[1]!).toHaveAttribute('aria-checked', 'true');
    expect(chips[0]!).toHaveAttribute('aria-checked', 'false');
  });
});
