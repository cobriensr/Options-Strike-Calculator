import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DailyStatement } from '../../components/PositionMonitor/types';

// ============================================================
// MOCK CHILD COMPONENTS
// ============================================================

vi.mock('../../components/PositionMonitor/AccountOverview.tsx', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="account-overview">
      AccountOverview:{JSON.stringify(Object.keys(props))}
    </div>
  ),
}));

vi.mock('../../components/PositionMonitor/DataQualityAlerts.tsx', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="data-quality-alerts">
      DataQualityAlerts:{String(Array.isArray(props.warnings))}
    </div>
  ),
}));

vi.mock('../../components/PositionMonitor/ExecutionQuality.tsx', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="execution-quality">
      ExecutionQuality:{String(!!props.execution)}
    </div>
  ),
}));

vi.mock('../../components/PositionMonitor/PortfolioRiskSummary.tsx', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="portfolio-risk-summary">
      PortfolioRiskSummary:{String(!!props.risk)}
    </div>
  ),
}));

vi.mock('../../components/PositionMonitor/PositionTable.tsx', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="position-table">
      PositionTable:{String(Array.isArray(props.spreads))}
    </div>
  ),
}));

vi.mock('../../components/PositionMonitor/PositionVisuals', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="position-visuals">
      PositionVisuals:{String(Array.isArray(props.spreads))}
    </div>
  ),
}));

vi.mock('../../components/PositionMonitor/TradeLog.tsx', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="trade-log">
      TradeLog:{String(Array.isArray(props.trades))}
    </div>
  ),
}));

// ============================================================
// MOCK STATEMENT PARSER
// ============================================================

const mockParseStatement =
  vi.fn<(csv: string, spotPrice: number) => DailyStatement>();

vi.mock('../../components/PositionMonitor/statement-parser', () => ({
  parseStatement: (...args: unknown[]) =>
    mockParseStatement(args[0] as string, args[1] as number),
  // applyBSEstimates returns the statement unchanged (pass-through)
  applyBSEstimates: (s: DailyStatement) => ({ ...s }),
}));

// Import AFTER mocks are set up
import PositionMonitor from '../../components/PositionMonitor/index';

// ============================================================
// FACTORY HELPER — minimal valid DailyStatement
// ============================================================

function makeStatement(
  overrides: Partial<DailyStatement> = {},
): DailyStatement {
  return {
    date: '2026-03-27',
    cashEntries: [],
    orders: [],
    trades: [],
    openLegs: [],
    pnl: { entries: [], totals: null },
    accountSummary: {
      netLiquidatingValue: 100000,
      stockBuyingPower: 200000,
      optionBuyingPower: 100000,
      equityCommissionsYtd: 5,
    },
    spreads: [
      {
        spreadType: 'PUT_CREDIT_SPREAD',
        shortLeg: {
          symbol: '.SPXW260327',
          optionCode: 'SPXW260327P5650',
          exp: '2026-03-27',
          strike: 5650,
          type: 'PUT',
          qty: -1,
          tradePrice: 1.25,
          mark: 0.45,
          markValue: -45,
        },
        longLeg: {
          symbol: '.SPXW260327',
          optionCode: 'SPXW260327P5640',
          exp: '2026-03-27',
          strike: 5640,
          type: 'PUT',
          qty: 1,
          tradePrice: 0.45,
          mark: 0.15,
          markValue: 15,
        },
        contracts: 1,
        wingWidth: 10,
        creditReceived: 80,
        maxProfit: 80,
        maxLoss: 920,
        riskRewardRatio: 11.5,
        breakeven: 5649.2,
        entryTime: '3/27/26 09:45:00',
        entryNetPrice: 0.8,
        currentValue: -30,
        openPnl: 50,
        pctOfMaxProfit: 62.5,
        distanceToShortStrike: 50,
        distanceToShortStrikePct: 0.88,
        nearestShortStrike: 5650,
        entryCommissions: 1.3,
      },
    ],
    ironCondors: [],
    hedges: [],
    nakedPositions: [],
    closedSpreads: [],
    portfolioRisk: {
      callSideRisk: 0,
      putSideRisk: 920,
      callHedgeValue: 0,
      putHedgeValue: 0,
      netCallRisk: 0,
      netPutRisk: 920,
      totalMaxLoss: 920,
      totalCredit: 80,
      totalContracts: 2,
      spotPrice: 5700,
      nearestShortStrikeDistance: 50,
      nakedCount: 0,
      breakevenLow: 5649.2,
      breakevenHigh: null,
      buyingPowerUsed: 920,
      buyingPowerAvailable: 99080,
      buyingPowerUtilization: 0.0092,
      canAbsorbMaxLoss: true,
      concentration: 1,
    },
    executionQuality: {
      fills: [],
      averageSlippage: 0,
      totalSlippageDollars: 0,
      fillRate: 1,
      rejectedOrders: 0,
      canceledOrders: 0,
      replacementChains: 0,
      rejectionRate: 0,
      cancellationRate: 0,
      rejectionReasons: [],
      firstTradeTime: '09:45:00',
      lastTradeTime: '09:45:00',
      tradingSessionMinutes: 0,
      tradesPerHour: null,
    },
    warnings: [],
    ...overrides,
  };
}

// ============================================================
// HELPER — simulate uploading a CSV file
// ============================================================

function createCSVFile(
  content = 'fake,csv,data',
  name = 'statement.csv',
): File {
  return new File([content], name, { type: 'text/csv' });
}

async function uploadFile(file?: File) {
  const input = screen.getByLabelText('Upload paper trading statement CSV');
  const csvFile = file ?? createCSVFile();

  // Use fireEvent because userEvent doesn't support file inputs well
  fireEvent.change(input, { target: { files: [csvFile] } });

  // Wait for FileReader async callback to complete.
  // waitFor only fails when the callback throws, so we must assert.
  await waitFor(() => {
    const hasContent =
      screen.queryByTestId('data-quality-alerts') !== null ||
      screen.queryByRole('alert') !== null;
    expect(hasContent).toBe(true);
  });
}

// ============================================================
// TESTS
// ============================================================

describe('PositionMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Owner Gating ────────────────────────────────────────

  it('renders when import.meta.env.DEV is true (test env)', () => {
    render(<PositionMonitor spotPrice={5700} />);
    expect(screen.getByText('Position Monitor')).toBeInTheDocument();
  });

  // ── Empty State ─────────────────────────────────────────

  it('shows empty state prompt before upload', () => {
    render(<PositionMonitor spotPrice={5700} />);
    expect(
      screen.getByText('No positions tracked.'),
    ).toBeInTheDocument();
  });

  it('shows "Upload Statement" button before upload', () => {
    render(<PositionMonitor spotPrice={5700} />);
    expect(
      screen.getByRole('button', { name: /upload statement/i }),
    ).toBeInTheDocument();
  });

  it('does not show collapse toggle before upload', () => {
    render(<PositionMonitor spotPrice={5700} />);
    expect(
      screen.queryByRole('button', { name: /show|hide/i }),
    ).not.toBeInTheDocument();
  });

  it('does not show decay toggle before upload', () => {
    render(<PositionMonitor spotPrice={5700} />);
    expect(
      screen.queryByRole('button', { name: /decay/i }),
    ).not.toBeInTheDocument();
  });

  // ── File Upload Flow ────────────────────────────────────

  it('parses CSV and renders dashboard on successful upload', async () => {
    const stmt = makeStatement();
    mockParseStatement.mockReturnValue(stmt);

    render(<PositionMonitor spotPrice={5700} />);
    await uploadFile();

    expect(mockParseStatement).toHaveBeenCalledOnce();
    expect(mockParseStatement).toHaveBeenCalledWith('fake,csv,data', 5700);

    // Dashboard child components should be rendered
    expect(screen.getByTestId('data-quality-alerts')).toBeInTheDocument();
    expect(screen.getByTestId('portfolio-risk-summary')).toBeInTheDocument();
    expect(screen.getByTestId('position-visuals')).toBeInTheDocument();
    expect(screen.getByTestId('position-table')).toBeInTheDocument();
    expect(screen.getByTestId('account-overview')).toBeInTheDocument();
    expect(screen.getByTestId('trade-log')).toBeInTheDocument();
    expect(screen.getByTestId('execution-quality')).toBeInTheDocument();
  });

  it('shows badge with date and spread count after upload', async () => {
    const stmt = makeStatement({ date: '2026-03-27' });
    mockParseStatement.mockReturnValue(stmt);

    render(<PositionMonitor spotPrice={5700} />);
    await uploadFile();

    expect(screen.getByText(/2026-03-27/)).toBeInTheDocument();
    expect(screen.getByText(/1 spreads/)).toBeInTheDocument();
  });

  it('shows "Re-upload" button after successful upload', async () => {
    mockParseStatement.mockReturnValue(makeStatement());

    render(<PositionMonitor spotPrice={5700} />);
    await uploadFile();

    expect(
      screen.getByRole('button', { name: /re-upload/i }),
    ).toBeInTheDocument();
  });

  // ── Error State ─────────────────────────────────────────

  it('shows error message when parsing fails', async () => {
    mockParseStatement.mockImplementation(() => {
      throw new Error('Missing Cash Balance section');
    });

    render(<PositionMonitor spotPrice={5700} />);
    await uploadFile();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Missing Cash Balance section',
    );
  });

  it('shows generic error for non-Error throws', async () => {
    mockParseStatement.mockImplementation(() => {
      throw 'unexpected';
    });

    render(<PositionMonitor spotPrice={5700} />);
    await uploadFile();

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to parse file');
  });

  it('clears error on subsequent successful upload', async () => {
    // First upload fails
    mockParseStatement.mockImplementation(() => {
      throw new Error('Bad CSV');
    });

    render(<PositionMonitor spotPrice={5700} />);
    await uploadFile();
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Second upload succeeds
    mockParseStatement.mockReturnValue(makeStatement());
    await uploadFile();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // ── Collapse / Expand Toggle ────────────────────────────

  it('shows collapse toggle after upload', async () => {
    mockParseStatement.mockReturnValue(makeStatement());

    render(<PositionMonitor spotPrice={5700} />);
    await uploadFile();

    expect(screen.getByRole('button', { name: /hide/i })).toBeInTheDocument();
  });

  it('collapses dashboard when Hide is clicked', async () => {
    const user = userEvent.setup();
    mockParseStatement.mockReturnValue(makeStatement());

    render(<PositionMonitor spotPrice={5700} />);
    await uploadFile();

    const hideBtn = screen.getByRole('button', { name: /hide/i });
    await user.click(hideBtn);

    // Child components should be hidden
    expect(screen.queryByTestId('data-quality-alerts')).not.toBeInTheDocument();
    // Show button should appear
    expect(screen.getByRole('button', { name: /show/i })).toBeInTheDocument();
  });

  it('re-expands dashboard when Show is clicked', async () => {
    const user = userEvent.setup();
    mockParseStatement.mockReturnValue(makeStatement());

    render(<PositionMonitor spotPrice={5700} />);
    await uploadFile();

    // Collapse
    await user.click(screen.getByRole('button', { name: /hide/i }));
    // Re-expand
    await user.click(screen.getByRole('button', { name: /show/i }));

    expect(screen.getByTestId('data-quality-alerts')).toBeInTheDocument();
  });

  it('sets aria-expanded correctly on toggle button', async () => {
    const user = userEvent.setup();
    mockParseStatement.mockReturnValue(makeStatement());

    render(<PositionMonitor spotPrice={5700} />);
    await uploadFile();

    const hideBtn = screen.getByRole('button', { name: /hide/i });
    expect(hideBtn).toHaveAttribute('aria-expanded', 'true');

    await user.click(hideBtn);
    const showBtn = screen.getByRole('button', { name: /show/i });
    expect(showBtn).toHaveAttribute('aria-expanded', 'false');
  });

  // ── Theta Decay Toggle ──────────────────────────────────

  it('shows decay toggle after upload', async () => {
    mockParseStatement.mockReturnValue(makeStatement());

    render(<PositionMonitor spotPrice={5700} />);
    await uploadFile();

    expect(
      screen.getByRole('button', { name: /decay: off/i }),
    ).toBeInTheDocument();
  });

  it('enables decay mode and shows time label', async () => {
    mockParseStatement.mockReturnValue(makeStatement());

    render(<PositionMonitor spotPrice={5700} />);
    await uploadFile();

    fireEvent.click(screen.getByRole('button', { name: /decay: off/i }));

    // Default sim time is 10:00 AM CT
    expect(
      screen.getByRole('button', { name: /decay: 10:00 AM CT/i }),
    ).toBeInTheDocument();
  });

  it('shows time slider when decay is enabled', async () => {
    mockParseStatement.mockReturnValue(makeStatement());

    render(<PositionMonitor spotPrice={5700} />);
    await uploadFile();

    fireEvent.click(screen.getByRole('button', { name: /decay: off/i }));

    expect(
      screen.getByRole('slider', { name: /simulation time/i }),
    ).toBeInTheDocument();
  });

  it('hides time slider when decay is disabled', async () => {
    mockParseStatement.mockReturnValue(makeStatement());

    render(<PositionMonitor spotPrice={5700} />);
    await uploadFile();

    // Enable
    fireEvent.click(screen.getByRole('button', { name: /decay: off/i }));
    expect(
      screen.getByRole('slider', { name: /simulation time/i }),
    ).toBeInTheDocument();

    // Disable
    fireEvent.click(
      screen.getByRole('button', { name: /decay: 10:00 AM CT/i }),
    );
    expect(
      screen.queryByRole('slider', { name: /simulation time/i }),
    ).not.toBeInTheDocument();
  });

  it('updates time display when slider changes', async () => {
    mockParseStatement.mockReturnValue(makeStatement());

    render(<PositionMonitor spotPrice={5700} />);
    await uploadFile();

    // Enable decay
    fireEvent.click(screen.getByRole('button', { name: /decay: off/i }));

    const slider = screen.getByRole('slider', {
      name: /simulation time/i,
    });

    // Set to 12:30 PM CT = 750 minutes
    fireEvent.change(slider, { target: { value: '750' } });

    expect(
      screen.getByRole('button', { name: /decay: 12:30 PM CT/i }),
    ).toBeInTheDocument();
  });

  // ── Child Component Props ───────────────────────────────

  it('passes correct props to child components', async () => {
    const stmt = makeStatement();
    mockParseStatement.mockReturnValue(stmt);

    render(<PositionMonitor spotPrice={5700} />);
    await uploadFile();

    // DataQualityAlerts receives warnings array
    expect(screen.getByTestId('data-quality-alerts')).toHaveTextContent(
      'DataQualityAlerts:true',
    );

    // PortfolioRiskSummary receives risk object
    expect(screen.getByTestId('portfolio-risk-summary')).toHaveTextContent(
      'PortfolioRiskSummary:true',
    );

    // PositionVisuals receives spreads array
    expect(screen.getByTestId('position-visuals')).toHaveTextContent(
      'PositionVisuals:true',
    );

    // PositionTable receives spreads array
    expect(screen.getByTestId('position-table')).toHaveTextContent(
      'PositionTable:true',
    );

    // AccountOverview receives prop keys
    expect(screen.getByTestId('account-overview')).toHaveTextContent(
      'cashEntries',
    );
    expect(screen.getByTestId('account-overview')).toHaveTextContent(
      'accountSummary',
    );
    expect(screen.getByTestId('account-overview')).toHaveTextContent('pnl');

    // TradeLog receives trades array
    expect(screen.getByTestId('trade-log')).toHaveTextContent('TradeLog:true');

    // ExecutionQuality receives execution object
    expect(screen.getByTestId('execution-quality')).toHaveTextContent(
      'ExecutionQuality:true',
    );
  });

  // ── Badge Spread Count ──────────────────────────────────

  it('counts iron condors in the spread badge', async () => {
    const stmt = makeStatement({
      ironCondors: [
        {
          spreadType: 'IRON_CONDOR',
          putSpread: makeStatement().spreads[0]!,
          callSpread: makeStatement().spreads[0]!,
          contracts: 1,
          totalCredit: 160,
          maxProfit: 160,
          maxLoss: 840,
          riskRewardRatio: 5.25,
          breakevenLow: 5618.4,
          breakevenHigh: 5781.6,
          putWingWidth: 10,
          callWingWidth: 10,
          entryTime: null,
        },
      ],
    });
    mockParseStatement.mockReturnValue(stmt);

    render(<PositionMonitor spotPrice={5700} />);
    await uploadFile();

    // 1 spread + 1 IC = 2 spreads
    expect(screen.getByText(/2 spreads/)).toBeInTheDocument();
  });

  // ── Hidden File Input ───────────────────────────────────

  it('has a hidden file input that accepts CSV', () => {
    render(<PositionMonitor spotPrice={5700} />);
    const input = screen.getByLabelText('Upload paper trading statement CSV');
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', '.csv');
    expect(input).toHaveClass('hidden');
  });

  // ── Upload button triggers file input ───────────────────

  it('clicking Upload Statement opens file dialog', async () => {
    const user = userEvent.setup();
    render(<PositionMonitor spotPrice={5700} />);

    const input = screen.getByLabelText(
      'Upload paper trading statement CSV',
    ) as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');

    await user.click(screen.getByRole('button', { name: /upload statement/i }));
    expect(clickSpy).toHaveBeenCalledOnce();
  });

  // ── Dashboard not shown when collapsed ──────────────────

  it('does not render child components when collapsed', async () => {
    const user = userEvent.setup();
    mockParseStatement.mockReturnValue(makeStatement());

    render(<PositionMonitor spotPrice={5700} />);
    await uploadFile();

    // Collapse
    await user.click(screen.getByRole('button', { name: /hide/i }));

    expect(
      screen.queryByTestId('portfolio-risk-summary'),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('position-visuals')).not.toBeInTheDocument();
    expect(screen.queryByTestId('position-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('account-overview')).not.toBeInTheDocument();
    expect(screen.queryByTestId('trade-log')).not.toBeInTheDocument();
    expect(screen.queryByTestId('execution-quality')).not.toBeInTheDocument();
  });
});
