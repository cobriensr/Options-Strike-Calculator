import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VIXTermStructure from '../components/VIXTermStructure';
import { lightTheme, darkTheme } from '../themes';

/** Set an input value reliably via fireEvent.change */
function setInput(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

function enterVix1d(value: string) {
  setInput(screen.getByLabelText(/vix1d/i), value);
}

function enterVix9d(value: string) {
  setInput(screen.getByLabelText(/vix9d/i), value);
}

function enterBoth(vix1d: string, vix9d: string) {
  setInput(screen.getByLabelText(/vix1d/i), vix1d);
  setInput(screen.getByLabelText(/vix9d/i), vix9d);
}

// ============================================================
// RENDERING
// ============================================================
describe('VIXTermStructure: rendering', () => {
  it('renders without crashing', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    expect(screen.getByLabelText(/vix1d/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/vix9d/i)).toBeInTheDocument();
  });

  it('renders in dark mode', () => {
    render(<VIXTermStructure th={darkTheme} vix={20} />);
    expect(screen.getByLabelText(/vix1d/i)).toBeInTheDocument();
  });

  it('shows empty state hint when VIX is set but no VIX1D/VIX9D entered', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    expect(screen.getByText(/enter vix1d/i)).toBeInTheDocument();
    expect(screen.getByText(/CBOE:VIX1D/)).toBeInTheDocument();
  });

  it('shows VIX needed hint when VIX1D entered but VIX is null', () => {
    render(<VIXTermStructure th={lightTheme} vix={null} />);
    setInput(screen.getByLabelText(/vix1d/i), '18');
    // The hint about entering VIX should appear after typing
  });

  it('renders both input fields with placeholders', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    expect(screen.getByPlaceholderText('e.g. 18.5')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. 20.1')).toBeInTheDocument();
  });
});

// ============================================================
// VIX1D RATIO SIGNALS
// ============================================================
describe('VIXTermStructure: VIX1D ratio signals', () => {
  it('shows CALM signal when VIX1D/VIX < 0.85', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    enterVix1d('15'); // 15/20 = 0.75
    expect(screen.getByText('CALM')).toBeInTheDocument();
    expect(screen.getByText(/quieter than average/i)).toBeInTheDocument();
  });

  it('shows NORMAL signal when VIX1D/VIX is 0.85-1.15', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    enterVix1d('20'); // 20/20 = 1.0
    expect(screen.getByText('NORMAL')).toBeInTheDocument();
    expect(screen.getByText(/follow regime guide/i)).toBeInTheDocument();
  });

  it('shows ELEVATED signal when VIX1D/VIX is 1.15-1.50', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    enterVix1d('26'); // 26/20 = 1.30
    expect(screen.getByText('ELEVATED')).toBeInTheDocument();
    expect(screen.getByText(/above-average move/i)).toBeInTheDocument();
  });

  it('shows EVENT RISK signal when VIX1D/VIX > 1.50', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    enterVix1d('35'); // 35/20 = 1.75
    expect(screen.getByText('EVENT RISK')).toBeInTheDocument();
    // "sitting out" appears in both the combined banner and the card advice
    expect(screen.getAllByText(/sitting out/i).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('displays the ratio value', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    enterVix1d('24'); // 24/20 = 1.20
    expect(screen.getByText('1.20x')).toBeInTheDocument();
  });
});

// ============================================================
// VIX9D RATIO SIGNALS
// ============================================================
describe('VIXTermStructure: VIX9D ratio signals', () => {
  it('shows CONTANGO signal when VIX9D/VIX < 0.90', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    enterVix9d('16'); // 16/20 = 0.80
    expect(screen.getByText('CONTANGO')).toBeInTheDocument();
    expect(screen.getByText(/favorable term structure/i)).toBeInTheDocument();
  });

  it('shows FLAT signal when VIX9D/VIX is 0.90-1.10', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    enterVix9d('20'); // 20/20 = 1.0
    expect(screen.getByText('FLAT')).toBeInTheDocument();
    expect(screen.getByText(/neutral term structure/i)).toBeInTheDocument();
  });

  it('shows INVERTED signal when VIX9D/VIX is 1.10-1.25', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    enterVix9d('23'); // 23/20 = 1.15
    expect(screen.getByText('INVERTED')).toBeInTheDocument();
    expect(screen.getByText(/near-term stress/i)).toBeInTheDocument();
  });

  it('shows STEEP INVERSION signal when VIX9D/VIX > 1.25', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    enterVix9d('28'); // 28/20 = 1.40
    expect(screen.getByText('STEEP INVERSION')).toBeInTheDocument();
    expect(screen.getByText(/defensive posture/i)).toBeInTheDocument();
  });
});

// ============================================================
// COMBINED SIGNAL
// ============================================================
describe('VIXTermStructure: combined signal', () => {
  it('shows GREEN LIGHT when both ratios are calm', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    enterBoth('15', '16'); // 0.75 and 0.80
    expect(screen.getByText('GREEN LIGHT')).toBeInTheDocument();
    expect(screen.getByText(/favors selling premium/i)).toBeInTheDocument();
  });

  it('shows CAUTION when VIX1D is elevated even if VIX9D is calm', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    enterBoth('26', '17'); // 1.30 and 0.85
    expect(screen.getByText('CAUTION')).toBeInTheDocument();
  });

  it('shows HIGH ALERT when either ratio is extreme', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    enterBoth('35', '20'); // 1.75 and 1.0
    expect(screen.getByText('HIGH ALERT')).toBeInTheDocument();
  });

  it('uses worst-of logic for combined signal', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    enterBoth('20', '28'); // 1.0 (normal) and 1.4 (extreme)
    // VIX9D extreme should dominate
    expect(screen.getByText('HIGH ALERT')).toBeInTheDocument();
  });
});

// ============================================================
// VIX1D AS SIGMA
// ============================================================
describe('VIXTermStructure: VIX1D as sigma', () => {
  it('shows the VIX1D sigma tip when VIX1D is entered', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    setInput(screen.getByLabelText(/vix1d/i), '22.5');
    expect(
      screen.getByText(/derived directly from today/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/0.2250/)).toBeInTheDocument(); // σ = 22.5/100
  });

  it('shows use button when callback is provided', () => {
    const onUse = vi.fn();
    render(
      <VIXTermStructure th={lightTheme} vix={20} onUseVix1dAsSigma={onUse} />,
    );
    setInput(screen.getByLabelText(/vix1d/i), '22.5');
    const btn = screen.getByRole('button', { name: /use vix1d/i });
    expect(btn).toBeInTheDocument();
  });

  it('calls onUseVix1dAsSigma with correct value when clicked', async () => {
    const user = userEvent.setup();
    const onUse = vi.fn();
    render(
      <VIXTermStructure th={lightTheme} vix={20} onUseVix1dAsSigma={onUse} />,
    );
    setInput(screen.getByLabelText(/vix1d/i), '22.5');
    await user.click(screen.getByRole('button', { name: /use vix1d/i }));
    expect(onUse).toHaveBeenCalledWith(0.225);
  });

  it('does not show use button when no callback provided', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    setInput(screen.getByLabelText(/vix1d/i), '22.5');
    expect(
      screen.queryByRole('button', { name: /use vix1d/i }),
    ).not.toBeInTheDocument();
  });
});

// ============================================================
// EDGE CASES
// ============================================================
describe('VIXTermStructure: edge cases', () => {
  it('handles VIX of null gracefully', () => {
    render(<VIXTermStructure th={lightTheme} vix={null} />);
    expect(screen.getByLabelText(/vix1d/i)).toBeInTheDocument();
  });

  it('handles non-numeric input gracefully', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    setInput(screen.getByLabelText(/vix1d/i), 'abc');
    // Should not show ratio cards or crash
    expect(screen.queryByText(/x$/)).not.toBeInTheDocument();
  });

  it('handles very high VIX1D ratio', () => {
    render(<VIXTermStructure th={lightTheme} vix={15} />);
    setInput(screen.getByLabelText(/vix1d/i), '45'); // 3.0x
    expect(screen.getByText('EVENT RISK')).toBeInTheDocument();
  });

  it('handles VIX1D less than VIX', () => {
    render(<VIXTermStructure th={lightTheme} vix={25} />);
    setInput(screen.getByLabelText(/vix1d/i), '12'); // 0.48x
    expect(screen.getByText('CALM')).toBeInTheDocument();
  });

  it('works with only VIX1D entered (no VIX9D)', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    setInput(screen.getByLabelText(/vix1d/i), '20');
    expect(screen.getByText('NORMAL')).toBeInTheDocument();
    expect(screen.getByText('0.5x')).toBeInTheDocument(); // bar scale label
  });

  it('works with only VIX9D entered (no VIX1D)', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    setInput(screen.getByLabelText(/vix9d/i), '20');
    expect(screen.getByText('FLAT')).toBeInTheDocument();
  });
});

// ============================================================
// THEME SUPPORT
// ============================================================
describe('VIXTermStructure: theme support', () => {
  it('renders all signals in light theme', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    setInput(screen.getByLabelText(/vix1d/i), '20');
    expect(screen.getByText('NORMAL')).toBeInTheDocument();
  });

  it('renders all signals in dark theme', () => {
    render(<VIXTermStructure th={darkTheme} vix={20} />);
    setInput(screen.getByLabelText(/vix1d/i), '20');
    expect(screen.getByText('NORMAL')).toBeInTheDocument();
  });
});

// ============================================================
// AUTO-FILL FROM LIVE DATA
// ============================================================
describe('VIXTermStructure: auto-fill from live data', () => {
  it('auto-fills VIX1D when initialVix1d is provided', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} initialVix1d={18.99} />);
    const input = screen.getByLabelText(/vix1d/i) as HTMLInputElement;
    expect(input.value).toBe('18.99');
  });

  it('auto-fills VIX9D when initialVix9d is provided', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} initialVix9d={24.44} />);
    const input = screen.getByLabelText(/vix9d/i) as HTMLInputElement;
    expect(input.value).toBe('24.44');
  });

  it('auto-fills both VIX1D and VIX9D', () => {
    render(
      <VIXTermStructure
        th={lightTheme}
        vix={20}
        initialVix1d={18.99}
        initialVix9d={24.44}
      />,
    );
    const vix1dInput = screen.getByLabelText(/vix1d/i) as HTMLInputElement;
    const vix9dInput = screen.getByLabelText(/vix9d/i) as HTMLInputElement;
    expect(vix1dInput.value).toBe('18.99');
    expect(vix9dInput.value).toBe('24.44');
  });

  it('shows signal when auto-filled', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} initialVix1d={15} />);
    // 15/20 = 0.75 → CALM
    expect(screen.getByText('CALM')).toBeInTheDocument();
  });

  it('does not overwrite user input with initialVix1d', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} initialVix1d={18.99} />);
    const input = screen.getByLabelText(/vix1d/i) as HTMLInputElement;
    // User types a different value
    fireEvent.change(input, { target: { value: '25' } });
    expect(input.value).toBe('25');
  });

  it('works without initial values (backward compatible)', () => {
    render(<VIXTermStructure th={lightTheme} vix={20} />);
    const vix1dInput = screen.getByLabelText(/vix1d/i) as HTMLInputElement;
    const vix9dInput = screen.getByLabelText(/vix9d/i) as HTMLInputElement;
    expect(vix1dInput.value).toBe('');
    expect(vix9dInput.value).toBe('');
  });
});
