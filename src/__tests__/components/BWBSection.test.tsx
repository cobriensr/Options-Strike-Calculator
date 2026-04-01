import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import BWBSection from '../../components/BWBSection';
import type { CalculationResults, DeltaRow, DeltaRowError } from '../../types';

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
    basePutSigma: 0.19,
    baseCallSigma: 0.17,
    putActualDelta: 0.098,
    callActualDelta: 0.095,
    putGamma: 0.0012,
    callGamma: 0.0011,
    putTheta: -1500,
    callTheta: -1400,
    ivAccelMult: 1,
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
  props?: {
    narrowWidth?: number;
    wideMultiplier?: number;
    contracts?: number;
  },
) {
  return render(
    <BWBSection
      results={makeResults(overrides)}
      narrowWidth={props?.narrowWidth ?? 20}
      wideMultiplier={props?.wideMultiplier ?? 2}
      contracts={props?.contracts ?? 1}
      effectiveRatio={10}
    />,
  );
}

// ============================================================
// TESTS
// ============================================================

describe('BWBSection', () => {
  // ============================================================
  // Heading
  // ============================================================

  it('renders heading with narrow/wide wing widths', () => {
    renderSection({}, { narrowWidth: 20, wideMultiplier: 2 });
    expect(
      screen.getByText(/Broken Wing Butterfly \(20\/40-pt wings\)/),
    ).toBeInTheDocument();
  });

  it('renders heading with different multiplier', () => {
    renderSection({}, { narrowWidth: 15, wideMultiplier: 3 });
    expect(
      screen.getByText(/Broken Wing Butterfly \(15\/45-pt wings\)/),
    ).toBeInTheDocument();
  });

  // ============================================================
  // Tables rendered
  // ============================================================

  it('renders legs table', () => {
    renderSection();
    expect(
      screen.getByRole('table', { name: 'BWB legs by delta' }),
    ).toBeInTheDocument();
  });

  it('renders P&L table', () => {
    renderSection();
    expect(
      screen.getByRole('table', { name: 'BWB P&L by delta' }),
    ).toBeInTheDocument();
  });

  // ============================================================
  // Contract count in P&L heading
  // ============================================================

  it('shows singular contract in P&L heading', () => {
    renderSection({}, { contracts: 1 });
    expect(screen.getByText(/1 contract \(theoretical\)/)).toBeInTheDocument();
  });

  it('shows plural contracts in P&L heading', () => {
    renderSection({}, { contracts: 5 });
    expect(screen.getByText(/5 contracts \(theoretical\)/)).toBeInTheDocument();
  });

  // ============================================================
  // Legs table — strikes derived from buildPutBWB / buildCallBWB
  // ============================================================

  it('legs table shows correct put BWB strikes', () => {
    // putSnapped=5630, narrowWidth=20, wideWidth=40
    //   longFar  = 5630 - 40 = 5590
    //   short    = 5630
    //   longNear = 5630 + 20 = 5650
    renderSection({}, { narrowWidth: 20, wideMultiplier: 2 });

    const legsTable = screen.getByRole('table', {
      name: 'BWB legs by delta',
    });
    // Find the Put BWB row
    const putRow = within(legsTable)
      .getByText(/Put BWB/)
      .closest('tr')!;
    const cells = within(putRow).getAllByRole('cell');

    // cells: [Delta(rowSpan)] Side | LongFar | SPY | Short×2 | SPY | LongNear | SPY
    // With rowSpan, the delta cell is only in the first row
    expect(cells).toHaveLength(8); // delta + side + 3 strikes × 2 (SPX + SPY)
    expect(within(putRow).getByText('5590')).toBeInTheDocument();
    expect(within(putRow).getByText('5630')).toBeInTheDocument();
    expect(within(putRow).getByText('5650')).toBeInTheDocument();
  });

  it('legs table shows correct call BWB strikes', () => {
    // callSnapped=5770, narrowWidth=20, wideWidth=40
    //   longNear = 5770 - 20 = 5750
    //   short    = 5770
    //   longFar  = 5770 + 40 = 5810
    renderSection({}, { narrowWidth: 20, wideMultiplier: 2 });

    const legsTable = screen.getByRole('table', {
      name: 'BWB legs by delta',
    });
    const callRow = within(legsTable)
      .getByText(/Call BWB/)
      .closest('tr')!;

    expect(within(callRow).getByText('5750')).toBeInTheDocument();
    expect(within(callRow).getByText('5770')).toBeInTheDocument();
    expect(within(callRow).getByText('5810')).toBeInTheDocument();
  });

  it('legs table renders two rows per delta (put + call)', () => {
    renderSection({ allDeltas: [makeDeltaRow(10)] });

    const legsTable = screen.getByRole('table', {
      name: 'BWB legs by delta',
    });
    // Header row + 2 data rows (put + call)
    const rows = within(legsTable).getAllByRole('row');
    expect(rows).toHaveLength(3);
  });

  it('legs table renders two rows per delta with multiple deltas', () => {
    renderSection({
      allDeltas: [makeDeltaRow(5), makeDeltaRow(10), makeDeltaRow(15)],
    });

    const legsTable = screen.getByRole('table', {
      name: 'BWB legs by delta',
    });
    // Header + 3 deltas × 2 rows each = 7
    const rows = within(legsTable).getAllByRole('row');
    expect(rows).toHaveLength(7);
  });

  it('different wing widths produce different strikes', () => {
    renderSection({}, { narrowWidth: 25, wideMultiplier: 3 });

    const legsTable = screen.getByRole('table', {
      name: 'BWB legs by delta',
    });
    const putRow = within(legsTable)
      .getByText(/Put BWB/)
      .closest('tr')!;

    // putSnapped=5630, narrow=25, wide=75
    //   longFar = 5630 - 75 = 5555
    //   longNear = 5630 + 25 = 5655
    expect(within(putRow).getByText('5555')).toBeInTheDocument();
    expect(within(putRow).getByText('5655')).toBeInTheDocument();
  });

  // ============================================================
  // P&L Profile Table
  // ============================================================

  it('P&L table renders two sub-rows per delta (put BWB, call BWB)', () => {
    renderSection({ allDeltas: [makeDeltaRow(10)] });

    const pnlTable = screen.getByRole('table', {
      name: 'BWB P&L by delta',
    });
    expect(within(pnlTable).getByText('Put BWB')).toBeInTheDocument();
    expect(within(pnlTable).getByText('Call BWB')).toBeInTheDocument();
  });

  it('P&L table renders sub-rows for each delta group', () => {
    renderSection({
      allDeltas: [makeDeltaRow(5), makeDeltaRow(10)],
    });

    const pnlTable = screen.getByRole('table', {
      name: 'BWB P&L by delta',
    });

    // 2 deltas × 2 sub-rows each = 4 data rows + 1 header = 5 total
    const allRows = within(pnlTable).getAllByRole('row');
    expect(allRows).toHaveLength(5);
  });

  it('P&L table shows sweet spot column', () => {
    renderSection();

    const pnlTable = screen.getByRole('table', {
      name: 'BWB P&L by delta',
    });
    // Sweet spot header
    expect(
      within(pnlTable).getByRole('columnheader', { name: 'Sweet Spot' }),
    ).toBeInTheDocument();
    // Sweet spot value = shortStrike = 5630 (put BWB)
    expect(within(pnlTable).getByText('5630')).toBeInTheDocument();
    // Sweet spot value = shortStrike = 5770 (call BWB)
    expect(within(pnlTable).getByText('5770')).toBeInTheDocument();
  });

  // ============================================================
  // Error row filtering
  // ============================================================

  it('filters out error delta rows', () => {
    const errorRow: DeltaRowError = { delta: 5, error: 'Too far OTM' };
    renderSection({
      allDeltas: [errorRow, makeDeltaRow(10)],
    });

    const legsTable = screen.getByRole('table', {
      name: 'BWB legs by delta',
    });
    // Only 1 valid delta → 2 data rows (put + call) + 1 header = 3
    const rows = within(legsTable).getAllByRole('row');
    expect(rows).toHaveLength(3);
  });

  it('renders empty tables when all delta rows are errors', () => {
    const err1: DeltaRowError = { delta: 5, error: 'Too far OTM' };
    const err2: DeltaRowError = { delta: 10, error: 'Negative premium' };
    renderSection({ allDeltas: [err1, err2] });

    const legsTable = screen.getByRole('table', {
      name: 'BWB legs by delta',
    });
    // Header row only, no data rows
    const rows = within(legsTable).getAllByRole('row');
    expect(rows).toHaveLength(1);
  });

  // ============================================================
  // Explanatory text
  // ============================================================

  it('shows explanatory text with singular contract', () => {
    renderSection({}, { contracts: 1 });
    expect(
      screen.getByText(/SPX \$100 multiplier × 1 contract\b/),
    ).toBeInTheDocument();
  });

  it('shows explanatory text with plural contracts', () => {
    renderSection({}, { contracts: 5 });
    expect(
      screen.getByText(/SPX \$100 multiplier × 5 contracts/),
    ).toBeInTheDocument();
  });

  it('explanatory text mentions sweet spot', () => {
    renderSection();
    expect(
      screen.getByText(/Sweet spot = max profit at the short strike/),
    ).toBeInTheDocument();
  });

  // ============================================================
  // vix prop forwarding
  // ============================================================

  it('renders correctly when results include vix field', () => {
    renderSection({ vix: 22.5 });
    expect(
      screen.getByText(/Broken Wing Butterfly \(20\/40-pt wings\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'BWB legs by delta' }),
    ).toBeInTheDocument();
  });

  it('renders correctly when results omit vix field', () => {
    renderSection({ vix: undefined });
    expect(
      screen.getByText(/Broken Wing Butterfly \(20\/40-pt wings\)/),
    ).toBeInTheDocument();
  });

  // ============================================================
  // Export button
  // ============================================================

  it('shows export button', () => {
    renderSection();
    expect(
      screen.getByRole('button', { name: 'Export All BWB Widths to Excel' }),
    ).toBeInTheDocument();
  });

  it('export button has correct text', () => {
    renderSection();
    const btn = screen.getByRole('button', {
      name: 'Export All BWB Widths to Excel',
    });
    expect(btn).toHaveTextContent('Export All BWB Widths to Excel');
  });
});
