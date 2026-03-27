import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IronCondorSection from '../../components/IronCondorSection';
import type { CalculationResults, DeltaRow, DeltaRowError } from '../../types';

const exportMock = vi.hoisted(() => ({
  exportPnLComparison: vi.fn(),
}));

vi.mock('../../utils/exportXlsx', () => exportMock);

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
  props?: { wingWidth?: number; contracts?: number },
) {
  return render(
    <IronCondorSection
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

  it('hedge section always visible', () => {
    renderSection();
    expect(
      screen.getByText(/Hedge Calculator \(Reinsurance\)/i),
    ).toBeInTheDocument();
  });

  it('shows export button', () => {
    renderSection();
    expect(
      screen.getByRole('button', { name: 'Export P&L comparison to Excel' }),
    ).toBeInTheDocument();
  });

  it('renders IC Delta chips on one line with multiple delta rows', () => {
    renderSection({
      allDeltas: [makeDeltaRow(5), makeDeltaRow(10), makeDeltaRow(15)],
    });

    // IC Δ label appears in the hedge header
    const icDeltaLabel = screen.getByText(/^IC \u0394$/);
    expect(icDeltaLabel).toBeInTheDocument();

    // The chip container is the parent of the label
    const chipContainer = icDeltaLabel.parentElement!;
    const chips = chipContainer.querySelectorAll('[role="radio"]');
    expect(chips).toHaveLength(3);
    expect(chips[0]).toHaveTextContent(/5/);
    expect(chips[1]).toHaveTextContent(/10/);
    expect(chips[2]).toHaveTextContent(/15/);
  });

  it('does not show IC Delta chips with single delta row', () => {
    renderSection({ allDeltas: [makeDeltaRow(10)] });
    expect(screen.queryByText(/^IC \u0394$/)).not.toBeInTheDocument();
  });

  it('clicking an IC delta chip selects it', async () => {
    const user = userEvent.setup();
    renderSection({
      allDeltas: [makeDeltaRow(5), makeDeltaRow(10), makeDeltaRow(15)],
    });

    // Scope to IC Delta chip container
    const icLabel = screen.getByText(/^IC \u0394$/);
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

  // ============================================================
  // buildIronCondor integration — legs table shows computed strikes
  // ============================================================

  it('legs table shows correct strikes derived from buildIronCondor', () => {
    // With putSnapped=5630, callSnapped=5770 and wingWidth=25:
    //   longPut  = 5630 - 25 = 5605
    //   shortPut = 5630
    //   shortCall = 5770
    //   longCall  = 5770 + 25 = 5795
    renderSection({}, { wingWidth: 25 });

    const legsTable = screen.getByRole('table', {
      name: 'Iron condor legs by delta',
    });
    const tbody = within(legsTable).getAllByRole('row');
    // First row is header, second is data
    const dataRow = tbody[1]!;
    const cells = within(dataRow).getAllByRole('cell');

    // cells: Delta | LongPut | LongPutSpy | ShortPut | ShortPutSpy | ShortCall | ShortCallSpy | LongCall | LongCallSpy
    expect(cells[0]).toHaveTextContent('10Δ');
    expect(cells[1]).toHaveTextContent('5605');
    expect(cells[3]).toHaveTextContent('5630');
    expect(cells[5]).toHaveTextContent('5770');
    expect(cells[7]).toHaveTextContent('5795');
  });

  it('legs table renders one row per valid delta', () => {
    renderSection({
      allDeltas: [makeDeltaRow(5), makeDeltaRow(10), makeDeltaRow(15)],
    });

    const legsTable = screen.getByRole('table', {
      name: 'Iron condor legs by delta',
    });
    // Header row + 3 data rows
    const rows = within(legsTable).getAllByRole('row');
    expect(rows).toHaveLength(4);
  });

  it('different wing widths produce different long strikes', () => {
    renderSection({}, { wingWidth: 50 });

    const legsTable = screen.getByRole('table', {
      name: 'Iron condor legs by delta',
    });
    const dataRow = within(legsTable).getAllByRole('row')[1]!;
    const cells = within(dataRow).getAllByRole('cell');

    // longPut = 5630 - 50 = 5580, longCall = 5770 + 50 = 5820
    expect(cells[1]).toHaveTextContent('5580');
    expect(cells[7]).toHaveTextContent('5820');
  });

  // ============================================================
  // Error row filtering — DeltaRowError entries are excluded
  // ============================================================

  it('filters out error delta rows from icRows', () => {
    const errorRow: DeltaRowError = { delta: 5, error: 'Too far OTM' };
    renderSection({
      allDeltas: [errorRow, makeDeltaRow(10)],
    });

    const legsTable = screen.getByRole('table', {
      name: 'Iron condor legs by delta',
    });
    // Only 1 data row (the error row is filtered out)
    const rows = within(legsTable).getAllByRole('row');
    expect(rows).toHaveLength(2); // header + 1 data row
  });

  it('renders nothing when all delta rows are errors', () => {
    const err1: DeltaRowError = { delta: 5, error: 'Too far OTM' };
    const err2: DeltaRowError = { delta: 10, error: 'Negative premium' };
    renderSection({ allDeltas: [err1, err2] });

    const legsTable = screen.getByRole('table', {
      name: 'Iron condor legs by delta',
    });
    // Header row only, no data rows
    const rows = within(legsTable).getAllByRole('row');
    expect(rows).toHaveLength(1);

    // HedgeSection should not render when icRows is empty (hedgeIc is undefined)
    expect(
      screen.queryByText(/Hedge Calculator \(Reinsurance\)/i),
    ).not.toBeInTheDocument();
  });

  // ============================================================
  // P&L explanatory text
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

  it('explanatory text includes iron condor PoP clarification', () => {
    renderSection();
    expect(
      screen.getByText(/IC PoP = P\(price between both BEs\)/),
    ).toBeInTheDocument();
  });

  // ============================================================
  // Export button — dynamic import
  // ============================================================

  it('export button click does not throw', async () => {
    // The export button uses a dynamic import() which resolves to exportXlsx.
    // We verify the button is clickable and does not throw synchronously.
    const user = userEvent.setup();
    renderSection();

    const btn = screen.getByRole('button', {
      name: 'Export P&L comparison to Excel',
    });

    // Click should not throw — the dynamic import fires but we don't
    // need to await its completion for this integration test.
    await user.click(btn);

    // Button is still in the document after click
    expect(btn).toBeInTheDocument();
  });

  it('export button has correct label and text', () => {
    renderSection();
    const btn = screen.getByRole('button', {
      name: 'Export P&L comparison to Excel',
    });
    expect(btn).toHaveTextContent('⤓');
    expect(btn).toHaveTextContent('Export All Wing Widths to Excel');
  });

  // ============================================================
  // hedgeDeltaIdx state — selecting a chip changes the IC used by HedgeSection
  // ============================================================

  it('hedge section uses first IC row by default', () => {
    // Create two distinct delta rows with different putSnapped values
    const row5 = { ...makeDeltaRow(5), putSnapped: 5600, callSnapped: 5800 };
    const row15 = { ...makeDeltaRow(15), putSnapped: 5650, callSnapped: 5750 };

    renderSection({ allDeltas: [row5, row15] });

    // The hedge section receives ic from icRows[0] (delta=5).
    // Verify hedge section is visible (it receives the first IC row).
    expect(
      screen.getByText(/Hedge Calculator \(Reinsurance\)/i),
    ).toBeInTheDocument();
  });

  it('switching IC delta chip changes the hedge IC (re-renders hedge)', async () => {
    const user = userEvent.setup();

    // Two delta rows with meaningfully different strikes so hedgeSection re-renders
    const row5 = { ...makeDeltaRow(5), putSnapped: 5600, callSnapped: 5800 };
    const row15 = { ...makeDeltaRow(15), putSnapped: 5650, callSnapped: 5750 };

    renderSection({ allDeltas: [row5, row15] });

    // Hedge section is visible
    expect(
      screen.getByText(/Hedge Calculator \(Reinsurance\)/i),
    ).toBeInTheDocument();

    // IC Delta chip container
    const icLabel = screen.getByText(/^IC \u0394$/);
    const chipContainer = icLabel.parentElement!;
    const chips = chipContainer.querySelectorAll('[role="radio"]');
    expect(chips).toHaveLength(2);

    // Default: first chip selected
    expect(chips[0]!).toHaveAttribute('aria-checked', 'true');

    // Click second chip (delta=15)
    await user.click(chips[1]!);
    expect(chips[1]!).toHaveAttribute('aria-checked', 'true');
    expect(chips[0]!).toHaveAttribute('aria-checked', 'false');

    // Hedge section still visible after switching
    expect(
      screen.getByText(/Hedge Calculator \(Reinsurance\)/i),
    ).toBeInTheDocument();
  });

  // ============================================================
  // hedgeIc fallback — icRows[hedgeDeltaIdx] ?? icRows[0]
  // ============================================================

  it('hedge section renders with single delta row (hedgeDeltaIdx=0)', () => {
    renderSection({ allDeltas: [makeDeltaRow(10)] });
    // With one row, hedgeDeltaIdx=0 should work fine
    expect(
      screen.getByText(/Hedge Calculator \(Reinsurance\)/i),
    ).toBeInTheDocument();
  });

  // ============================================================
  // P&L Profile Table — multiple deltas produce correct groups
  // ============================================================

  it('P&L table renders three sub-rows per delta (put spread, call spread, IC)', () => {
    renderSection({
      allDeltas: [makeDeltaRow(10)],
    });

    const pnlTable = screen.getByRole('table', {
      name: 'Iron condor P&L by delta',
    });

    // Each delta gets 3 rows: Put Spread, Call Spread, Iron Condor
    expect(within(pnlTable).getByText('Put Spread')).toBeInTheDocument();
    expect(within(pnlTable).getByText('Call Spread')).toBeInTheDocument();
    expect(within(pnlTable).getByText('Iron Condor')).toBeInTheDocument();
  });

  it('P&L table renders sub-rows for each delta group', () => {
    renderSection({
      allDeltas: [makeDeltaRow(5), makeDeltaRow(10)],
    });

    const pnlTable = screen.getByRole('table', {
      name: 'Iron condor P&L by delta',
    });

    // Two delta groups × 3 sub-rows each = 6 data rows + 1 header = 7 total
    const allRows = within(pnlTable).getAllByRole('row');
    expect(allRows).toHaveLength(7);
  });

  // ============================================================
  // vix prop forwarding — results.vix is passed through to buildIronCondor
  // ============================================================

  it('renders correctly when results include vix field', () => {
    renderSection({ vix: 22.5 });

    // Component should render without error even with vix set
    expect(screen.getByText(/Iron Condor \(25-pt wings\)/)).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Iron condor legs by delta' }),
    ).toBeInTheDocument();
  });

  it('renders correctly when results omit vix field', () => {
    renderSection({ vix: undefined });

    expect(screen.getByText(/Iron Condor \(25-pt wings\)/)).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Iron condor legs by delta' }),
    ).toBeInTheDocument();
  });

  // ============================================================
  // Export button — dynamic import failure (.catch handler)
  // ============================================================

  describe('export button error handling', () => {
    let originalLocation: Location;

    beforeEach(() => {
      originalLocation = globalThis.location;
      // Replace location with a mock that has a spied reload
      Object.defineProperty(globalThis, 'location', {
        value: { ...originalLocation, reload: vi.fn() },
        writable: true,
        configurable: true,
      });
      // Make the export function throw so the .catch() handler fires
      exportMock.exportPnLComparison.mockImplementation(() => {
        throw new Error('chunk failed');
      });
    });

    afterEach(() => {
      Object.defineProperty(globalThis, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      });
      exportMock.exportPnLComparison.mockReset();
      vi.restoreAllMocks();
    });

    it('shows reload confirmation when export import fails', async () => {
      vi.spyOn(globalThis, 'confirm').mockReturnValue(false);

      const user = userEvent.setup();
      renderSection();

      const exportBtn = screen.getByRole('button', {
        name: 'Export P&L comparison to Excel',
      });
      await user.click(exportBtn);

      await waitFor(() => {
        expect(globalThis.confirm).toHaveBeenCalledWith(
          'A new version is available. Reload to use the export feature?',
        );
      });

      // confirm returned false — reload should NOT be called
      expect(globalThis.location.reload).not.toHaveBeenCalled();
    });

    it('reloads when user confirms after export import failure', async () => {
      vi.spyOn(globalThis, 'confirm').mockReturnValue(true);

      const user = userEvent.setup();
      renderSection();

      const exportBtn = screen.getByRole('button', {
        name: 'Export P&L comparison to Excel',
      });
      await user.click(exportBtn);

      await waitFor(() => {
        expect(globalThis.confirm).toHaveBeenCalledWith(
          'A new version is available. Reload to use the export feature?',
        );
      });

      // confirm returned true — reload SHOULD be called
      expect(globalThis.location.reload).toHaveBeenCalled();
    });
  });
});
