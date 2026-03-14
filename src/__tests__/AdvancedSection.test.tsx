import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdvancedSection from '../components/AdvancedSection';
import { lightTheme } from '../themes';

const th = lightTheme;

function defaultProps(
  overrides: Partial<Parameters<typeof AdvancedSection>[0]> = {},
) {
  return {
    th,
    skewPct: 0,
    onSkewChange: vi.fn(),
    showIC: false,
    onToggleIC: vi.fn(),
    wingWidth: 10,
    onWingWidthChange: vi.fn(),
    contracts: 1,
    onContractsChange: vi.fn(),
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
});
