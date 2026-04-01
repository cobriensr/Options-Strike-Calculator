import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdvancedSection from '../../components/AdvancedSection';
import type { VIXDayData, OHLCField } from '../../types';

function defaultProps(
  overrides: Partial<Parameters<typeof AdvancedSection>[0]> = {},
) {
  return {
    skewPct: 0,
    onSkewChange: vi.fn(),
    showIC: false,
    onToggleIC: vi.fn(),
    wingWidth: 10,
    onWingWidthChange: vi.fn(),
    contracts: 1,
    onContractsChange: vi.fn(),
    showBWB: false,
    onToggleBWB: vi.fn(),
    bwbNarrowWidth: 20,
    onBwbNarrowWidthChange: vi.fn(),
    bwbWideMultiplier: 2,
    onBwbWideMultiplierChange: vi.fn(),
    vixOHLC: null as VIXDayData | null,
    vixOHLCField: 'smart' as OHLCField,
    onOHLCFieldChange: vi.fn(),
    vixDataLoaded: false,
    selectedDate: '',
    ...overrides,
  };
}

describe('AdvancedSection', () => {
  it('renders section heading', () => {
    render(<AdvancedSection {...defaultProps()} />);
    expect(screen.getByText('Advanced')).toBeInTheDocument();
  });

  // ============================================================
  // SKEW SLIDER
  // ============================================================

  it('shows "Off" when skewPct is 0', () => {
    render(<AdvancedSection {...defaultProps({ skewPct: 0 })} />);
    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it('shows skew value text when skewPct > 0', () => {
    render(<AdvancedSection {...defaultProps({ skewPct: 3 })} />);
    expect(screen.getByText('+3% put / \u22123% call')).toBeInTheDocument();
  });

  it('calls onSkewChange when slider changes', () => {
    const onSkewChange = vi.fn();
    render(<AdvancedSection {...defaultProps({ onSkewChange })} />);
    const slider = screen.getByRole('slider', { name: /put skew adjustment/i });
    fireEvent.change(slider, { target: { value: '5' } });
    expect(onSkewChange).toHaveBeenCalledWith(5);
  });

  // ============================================================
  // IRON CONDOR TOGGLE
  // ============================================================

  it('shows "Show Iron Condor" when showIC is false', () => {
    render(<AdvancedSection {...defaultProps({ showIC: false })} />);
    expect(
      screen.getByRole('button', { name: /show iron condor/i }),
    ).toBeInTheDocument();
  });

  it('shows "Hide Iron Condor" when showIC is true', () => {
    render(<AdvancedSection {...defaultProps({ showIC: true })} />);
    expect(
      screen.getByRole('button', { name: /hide iron condor/i }),
    ).toBeInTheDocument();
  });

  it('calls onToggleIC when button clicked', async () => {
    const user = userEvent.setup();
    const onToggleIC = vi.fn();
    render(<AdvancedSection {...defaultProps({ onToggleIC })} />);
    await user.click(screen.getByRole('button', { name: /iron condor/i }));
    expect(onToggleIC).toHaveBeenCalledOnce();
  });

  // ============================================================
  // IC PANEL VISIBILITY
  // ============================================================

  it('does not show wing width or contracts when showIC is false', () => {
    render(<AdvancedSection {...defaultProps({ showIC: false })} />);
    expect(screen.queryByText('Wing Width (SPX pts)')).not.toBeInTheDocument();
    expect(screen.queryByText('Contracts')).not.toBeInTheDocument();
  });

  // ============================================================
  // WING WIDTH
  // ============================================================

  it('shows wing width chips when showIC is true', () => {
    render(<AdvancedSection {...defaultProps({ showIC: true })} />);
    expect(screen.getByText('Wing Width (SPX pts)')).toBeInTheDocument();
    for (const w of [5, 10, 15, 20, 25, 30, 50]) {
      expect(
        screen.getByRole('radio', { name: String(w) }),
      ).toBeInTheDocument();
    }
  });

  it('calls onWingWidthChange when a chip is clicked', async () => {
    const user = userEvent.setup();
    const onWingWidthChange = vi.fn();
    render(
      <AdvancedSection
        {...defaultProps({ showIC: true, onWingWidthChange })}
      />,
    );
    await user.click(screen.getByRole('radio', { name: '25' }));
    expect(onWingWidthChange).toHaveBeenCalledWith(25);
  });

  // ============================================================
  // CONTRACTS COUNTER
  // ============================================================

  it('shows contracts counter when showIC is true', () => {
    render(
      <AdvancedSection {...defaultProps({ showIC: true, contracts: 3 })} />,
    );
    expect(screen.getByText('Contracts')).toBeInTheDocument();
    expect(screen.getByLabelText('Number of contracts')).toHaveValue('3');
  });

  it('increment button calls onContractsChange', async () => {
    const user = userEvent.setup();
    const onContractsChange = vi.fn();
    render(
      <AdvancedSection
        {...defaultProps({ showIC: true, contracts: 5, onContractsChange })}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: /increase contracts/i }),
    );
    expect(onContractsChange).toHaveBeenCalledWith(6);
  });

  it('decrement button calls onContractsChange', async () => {
    const user = userEvent.setup();
    const onContractsChange = vi.fn();
    render(
      <AdvancedSection
        {...defaultProps({ showIC: true, contracts: 5, onContractsChange })}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: /decrease contracts/i }),
    );
    expect(onContractsChange).toHaveBeenCalledWith(4);
  });

  it('decrement does not go below 1', async () => {
    const user = userEvent.setup();
    const onContractsChange = vi.fn();
    render(
      <AdvancedSection
        {...defaultProps({ showIC: true, contracts: 1, onContractsChange })}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: /decrease contracts/i }),
    );
    expect(onContractsChange).toHaveBeenCalledWith(1);
  });

  it('contracts input accepts numeric values', () => {
    const onContractsChange = vi.fn();
    render(
      <AdvancedSection
        {...defaultProps({ showIC: true, contracts: 1, onContractsChange })}
      />,
    );
    const input = screen.getByLabelText('Number of contracts');
    fireEvent.change(input, { target: { value: '42' } });
    expect(onContractsChange).toHaveBeenCalledWith(42);
  });

  it('does not call onContractsChange for values outside 1-999', () => {
    const onContractsChange = vi.fn();
    render(
      <AdvancedSection
        {...defaultProps({ showIC: true, contracts: 5, onContractsChange })}
      />,
    );
    const input = screen.getByLabelText('Number of contracts');
    fireEvent.change(input, { target: { value: '1000' } });
    expect(onContractsChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '0' } });
    expect(onContractsChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '-5' } });
    expect(onContractsChange).not.toHaveBeenCalled();
  });

  it('increment does not go above 999', async () => {
    const user = userEvent.setup();
    const onContractsChange = vi.fn();
    render(
      <AdvancedSection
        {...defaultProps({ showIC: true, contracts: 999, onContractsChange })}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: /increase contracts/i }),
    );
    expect(onContractsChange).toHaveBeenCalledWith(999);
  });

  it('contracts input empty string resets to 1', () => {
    const onContractsChange = vi.fn();
    render(
      <AdvancedSection
        {...defaultProps({ showIC: true, contracts: 5, onContractsChange })}
      />,
    );
    const input = screen.getByLabelText('Number of contracts');
    fireEvent.change(input, { target: { value: '' } });
    expect(onContractsChange).toHaveBeenCalledWith(1);
  });

  // ============================================================
  // WING WIDTH CHIP ACTIVE STATE
  // ============================================================

  it('marks the active wing width chip as aria-checked', () => {
    render(
      <AdvancedSection {...defaultProps({ showIC: true, wingWidth: 20 })} />,
    );
    const chip20 = screen.getByRole('radio', { name: '20' });
    expect(chip20).toHaveAttribute('aria-checked', 'true');
    const chip10 = screen.getByRole('radio', { name: '10' });
    expect(chip10).toHaveAttribute('aria-checked', 'false');
  });

  // ============================================================
  // SKEW DISPLAY AT BOUNDARY
  // ============================================================

  it('shows correct skew text at max value (8%)', () => {
    render(<AdvancedSection {...defaultProps({ skewPct: 8 })} />);
    expect(screen.getByText('+8% put / \u22128% call')).toBeInTheDocument();
  });

  // ============================================================
  // MODEL PARAMETERS
  // ============================================================

  const makeDeltaRow = (
    overrides: Partial<import('../../types').DeltaRow> = {},
  ): import('../../types').DeltaRow => ({
    delta: 10,
    z: 1.28,
    putStrike: 5800,
    callStrike: 6200,
    putSnapped: 5800,
    callSnapped: 6200,
    putSpySnapped: 580,
    callSpySnapped: 620,
    spyPut: '580',
    spyCall: '620',
    putDistance: 200,
    callDistance: 200,
    putPct: '3.33',
    callPct: '3.33',
    putPremium: 2.5,
    callPremium: 2.5,
    putSigma: 0.18,
    callSigma: 0.15,
    basePutSigma: 0.17,
    baseCallSigma: 0.14,
    putActualDelta: 0.1,
    callActualDelta: 0.1,
    putGamma: 0.002,
    callGamma: 0.002,
    putTheta: -50,
    callTheta: -50,
    ivAccelMult: 1.12,
    ...overrides,
  });

  const makeResults = (
    overrides: Partial<import('../../types').CalculationResults> = {},
  ): import('../../types').CalculationResults => ({
    allDeltas: [makeDeltaRow()],
    sigma: 0.16,
    T: 0.003,
    hoursRemaining: 4.5,
    spot: 6000,
    vix: 18,
    ...overrides,
  });

  it('does not render Model Parameters when results is undefined', () => {
    render(<AdvancedSection {...defaultProps()} />);
    expect(screen.queryByText('Model Parameters')).not.toBeInTheDocument();
  });

  it('does not render Model Parameters when results is null', () => {
    render(<AdvancedSection {...defaultProps({ results: null })} />);
    expect(screen.queryByText('Model Parameters')).not.toBeInTheDocument();
  });

  it('renders Model Parameters section when results exist', () => {
    render(<AdvancedSection {...defaultProps({ results: makeResults() })} />);
    expect(screen.getByText('Model Parameters')).toBeInTheDocument();
  });

  it('displays Eff. σ value from results', () => {
    render(
      <AdvancedSection
        {...defaultProps({ results: makeResults({ sigma: 0.16 }) })}
      />,
    );
    expect(screen.getByText('Eff. \u03C3')).toBeInTheDocument();
    expect(screen.getByText('16.00%')).toBeInTheDocument();
  });

  it('displays Hours Left value from results', () => {
    render(
      <AdvancedSection
        {...defaultProps({ results: makeResults({ hoursRemaining: 4.5 }) })}
      />,
    );
    expect(screen.getByText('Hours Left')).toBeInTheDocument();
    expect(screen.getByText('4.5h')).toBeInTheDocument();
  });

  it('displays IV Accel multiplier from first valid delta row', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          results: makeResults({
            allDeltas: [makeDeltaRow({ ivAccelMult: 1.12 })],
          }),
        })}
      />,
    );
    expect(screen.getByText('IV Accel')).toBeInTheDocument();
    expect(screen.getByText('1.12x')).toBeInTheDocument();
  });

  it('shows dash for IV Accel when all delta rows have errors', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          results: makeResults({
            allDeltas: [{ delta: 10, error: 'fail' }],
          }),
        })}
      />,
    );
    expect(screen.getByText('IV Accel')).toBeInTheDocument();
    expect(screen.getByText('\u2014')).toBeInTheDocument();
  });

  it('displays Kurtosis factor based on VIX level', () => {
    // VIX 18 → getKurtosisFactor returns { crash: 2.5, rally: 1.5 }
    render(
      <AdvancedSection
        {...defaultProps({ results: makeResults({ vix: 18 }) })}
      />,
    );
    expect(screen.getByText('Kurtosis')).toBeInTheDocument();
    expect(screen.getByText('2.5/1.5x')).toBeInTheDocument();
  });

  it('displays different Kurtosis factor for high VIX', () => {
    // VIX 32 → getKurtosisFactor returns { crash: 4.0, rally: 3.0 }
    render(
      <AdvancedSection
        {...defaultProps({ results: makeResults({ vix: 32 }) })}
      />,
    );
    expect(screen.getByText('4.0/3.0x')).toBeInTheDocument();
  });

  it('uses border-t separator on Model Parameters container', () => {
    render(<AdvancedSection {...defaultProps({ results: makeResults() })} />);
    const heading = screen.getByText('Model Parameters');
    // The border-t class is on the parent div that wraps the heading
    const container = heading.closest('div.border-t');
    expect(container).toBeInTheDocument();
  });

  // ============================================================
  // 10Δ IC SNAPSHOT
  // ============================================================

  it('renders 10Δ IC Snapshot when results contain a 10-delta row', () => {
    render(<AdvancedSection {...defaultProps({ results: makeResults() })} />);
    expect(screen.getByText(/10.*IC Snapshot/)).toBeInTheDocument();
  });

  it('does not render IC Snapshot when no 10-delta row exists', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          results: makeResults({
            allDeltas: [
              makeDeltaRow({ delta: 15 as import('../../types').DeltaTarget }),
            ],
          }),
        })}
      />,
    );
    expect(screen.queryByText(/IC Snapshot/)).not.toBeInTheDocument();
  });

  it('displays put and call snapped strikes in IC Snapshot', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          results: makeResults({
            allDeltas: [makeDeltaRow({ putSnapped: 5800, callSnapped: 6200 })],
          }),
        })}
      />,
    );
    expect(screen.getByText('5800')).toBeInTheDocument();
    expect(screen.getByText('6200')).toBeInTheDocument();
  });

  it('displays range percentage in IC Snapshot', () => {
    // range = callSnapped - putSnapped = 6200 - 5800 = 400
    // rangePct = (400 / 6000) * 100 = 6.7%
    render(
      <AdvancedSection
        {...defaultProps({
          results: makeResults({
            spot: 6000,
            allDeltas: [makeDeltaRow({ putSnapped: 5800, callSnapped: 6200 })],
          }),
        })}
      />,
    );
    expect(screen.getByText('6.7% range')).toBeInTheDocument();
  });

  it('displays spot price in IC Snapshot', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          results: makeResults({ spot: 6000 }),
        })}
      />,
    );
    expect(screen.getByText('6000')).toBeInTheDocument();
  });

  // ============================================================
  // MAX LOSS / PER CONTRACT
  // ============================================================

  it('shows Max Loss and Per Contract when showIC is true and 10Δ row exists', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          wingWidth: 10,
          contracts: 3,
          results: makeResults(),
        })}
      />,
    );
    expect(screen.getByText('Max Loss')).toBeInTheDocument();
    expect(screen.getByText('Per Contract')).toBeInTheDocument();
    // wingWidth 10 × $100 = $1,000 per contract
    expect(screen.getByText('$1,000')).toBeInTheDocument();
    // total: $1,000 × 3 contracts = $3,000
    expect(screen.getByText('$3,000')).toBeInTheDocument();
  });

  it('does not show Max Loss / Per Contract when showIC is false', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: false,
          wingWidth: 10,
          contracts: 3,
          results: makeResults(),
        })}
      />,
    );
    expect(screen.queryByText('Max Loss')).not.toBeInTheDocument();
    expect(screen.queryByText('Per Contract')).not.toBeInTheDocument();
  });

  it('calculates Max Loss correctly with different wing widths', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          wingWidth: 25,
          contracts: 2,
          results: makeResults(),
        })}
      />,
    );
    // Per contract: 25 × $100 = $2,500
    expect(screen.getByText('$2,500')).toBeInTheDocument();
    // Total: $2,500 × 2 = $5,000
    expect(screen.getByText('$5,000')).toBeInTheDocument();
  });

  it('does not show Max Loss when results have no 10-delta row', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          wingWidth: 10,
          contracts: 1,
          results: makeResults({
            allDeltas: [
              makeDeltaRow({ delta: 15 as import('../../types').DeltaTarget }),
            ],
          }),
        })}
      />,
    );
    expect(screen.queryByText('Max Loss')).not.toBeInTheDocument();
  });

  it('contracts +/- buttons have type="button"', () => {
    render(<AdvancedSection {...defaultProps({ showIC: true })} />);
    expect(
      screen.getByRole('button', { name: /decrease contracts/i }),
    ).toHaveAttribute('type', 'button');
    expect(
      screen.getByRole('button', { name: /increase contracts/i }),
    ).toHaveAttribute('type', 'button');
  });

  it('does not show Max Loss when 10-delta row has an error', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          wingWidth: 10,
          contracts: 1,
          results: makeResults({
            allDeltas: [
              makeDeltaRow({ delta: 15 as import('../../types').DeltaTarget }),
              { delta: 10, error: 'calculation failed' },
            ],
          }),
        })}
      />,
    );
    expect(screen.queryByText('Max Loss')).not.toBeInTheDocument();
  });

  // ============================================================
  // VIX OHLC DISPLAY
  // ============================================================

  const sampleOHLC: VIXDayData = {
    open: 18.5,
    high: 20.25,
    low: 17.8,
    close: 19.1,
  };

  it('shows OHLC values when vixOHLC is provided', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          vixDataLoaded: true,
          selectedDate: '2026-03-15',
          vixOHLC: sampleOHLC,
        })}
      />,
    );
    expect(screen.getByText('18.50')).toBeInTheDocument();
    expect(screen.getByText('20.25')).toBeInTheDocument();
    expect(screen.getByText('17.80')).toBeInTheDocument();
    expect(screen.getByText('19.10')).toBeInTheDocument();
  });

  it('shows OHLC field labels', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          vixDataLoaded: true,
          selectedDate: '2026-03-15',
          vixOHLC: sampleOHLC,
        })}
      />,
    );
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('low')).toBeInTheDocument();
    expect(screen.getByText('close')).toBeInTheDocument();
  });

  it('shows em dash for null OHLC values', () => {
    const partialOHLC: VIXDayData = {
      open: 18.5,
      high: null,
      low: 17.8,
      close: null,
    };
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          vixDataLoaded: true,
          selectedDate: '2026-03-15',
          vixOHLC: partialOHLC,
        })}
      />,
    );
    expect(screen.getByText('18.50')).toBeInTheDocument();
    expect(screen.getByText('17.80')).toBeInTheDocument();
    const dashes = screen.getAllByText('\u2014');
    expect(dashes.length).toBe(2);
  });

  it('does not show OHLC section when vixOHLC is null', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          vixDataLoaded: true,
          selectedDate: '2026-03-15',
          vixOHLC: null,
        })}
      />,
    );
    expect(screen.queryByText('VIX OHLC values')).not.toBeInTheDocument();
  });

  it('has accessible legend "VIX OHLC values"', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          vixDataLoaded: true,
          selectedDate: '2026-03-15',
          vixOHLC: sampleOHLC,
        })}
      />,
    );
    expect(screen.getByText('VIX OHLC values')).toBeInTheDocument();
  });

  it('shows field selector chips when vixOHLC present', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          vixDataLoaded: true,
          selectedDate: '2026-03-15',
          vixOHLC: sampleOHLC,
          vixOHLCField: 'smart',
        })}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Auto' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Open' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'High' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Low' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Close' })).toBeInTheDocument();
  });

  it('does not show field selector chips when vixOHLC is null', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          vixDataLoaded: true,
          selectedDate: '2026-03-15',
          vixOHLC: null,
        })}
      />,
    );
    expect(
      screen.queryByRole('radio', { name: 'Auto' }),
    ).not.toBeInTheDocument();
  });

  it('shows Auto chip as active when vixOHLCField=smart', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          vixDataLoaded: true,
          selectedDate: '2026-03-15',
          vixOHLC: sampleOHLC,
          vixOHLCField: 'smart',
        })}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Open' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('calls onOHLCFieldChange when chip clicked', async () => {
    const user = userEvent.setup();
    const onOHLCFieldChange = vi.fn();
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          vixDataLoaded: true,
          selectedDate: '2026-03-15',
          vixOHLC: sampleOHLC,
          vixOHLCField: 'smart',
          onOHLCFieldChange,
        })}
      />,
    );
    await user.click(screen.getByRole('radio', { name: 'High' }));
    expect(onOHLCFieldChange).toHaveBeenCalledWith('high');
  });

  it('shows Auto description when vixOHLCField=smart', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          vixDataLoaded: true,
          selectedDate: '2026-03-15',
          vixOHLC: sampleOHLC,
          vixOHLCField: 'smart',
        })}
      />,
    );
    expect(
      screen.getByText('Auto: uses Open for AM entries, Close for PM entries'),
    ).toBeInTheDocument();
  });

  it('shows specific field description when vixOHLCField=open', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          vixDataLoaded: true,
          selectedDate: '2026-03-15',
          vixOHLC: sampleOHLC,
          vixOHLCField: 'open',
        })}
      />,
    );
    expect(screen.getByText('Using VIX open value')).toBeInTheDocument();
  });

  it('shows error when vixDataLoaded && selectedDate && !vixOHLC', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          vixDataLoaded: true,
          selectedDate: '2026-03-15',
          vixOHLC: null,
        })}
      />,
    );
    expect(
      screen.getByText('No VIX data found for this date'),
    ).toBeInTheDocument();
  });

  it('VIX data error is announced via role="alert"', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          vixDataLoaded: true,
          selectedDate: '2026-03-15',
          vixOHLC: null,
        })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'No VIX data found for this date',
    );
  });

  it('does not show error when vixDataLoaded is false', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          vixDataLoaded: false,
          selectedDate: '2026-03-15',
          vixOHLC: null,
        })}
      />,
    );
    expect(
      screen.queryByText('No VIX data found for this date'),
    ).not.toBeInTheDocument();
  });

  it('does not show error when vixOHLC is provided', () => {
    render(
      <AdvancedSection
        {...defaultProps({
          showIC: true,
          vixDataLoaded: true,
          selectedDate: '2026-03-15',
          vixOHLC: sampleOHLC,
        })}
      />,
    );
    expect(
      screen.queryByText('No VIX data found for this date'),
    ).not.toBeInTheDocument();
  });
});
