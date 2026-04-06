import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import VIXTermStructure from '../../components/VIXTermStructure';

// ============================================================
// HELPERS
// ============================================================

/** Default props that produce valid ratios and cards */
const baseProps = {
  vix: 20,
  initialVix1d: 18.5,
  initialVix9d: 20.1,
  initialVvix: 95,
} as const;

// ============================================================
// AUTO-FILL FROM INITIAL PROPS
// ============================================================

describe('VIXTermStructure (spot): auto-fill', () => {
  it('populates VIX1D input from initialVix1d', () => {
    render(<VIXTermStructure vix={20} initialVix1d={17.25} />);
    const input = screen.getByLabelText(/VIX1D/i) as HTMLInputElement;
    expect(input.value).toBe('17.25');
  });

  it('populates VIX9D input from initialVix9d', () => {
    render(<VIXTermStructure vix={20} initialVix9d={21.5} />);
    const input = screen.getByLabelText(/VIX9D/i) as HTMLInputElement;
    expect(input.value).toBe('21.50');
  });

  it('does not overwrite user edits when initialVix1d changes', () => {
    const { rerender } = render(
      <VIXTermStructure vix={20} initialVix1d={18.0} />,
    );
    const input = screen.getByLabelText(/VIX1D/i) as HTMLInputElement;

    // Simulate user typing
    fireEvent.change(input, { target: { value: '22.00' } });
    expect(input.value).toBe('22.00');

    // Re-render with new initial value — should NOT overwrite
    rerender(<VIXTermStructure vix={20} initialVix1d={19.0} />);
    expect(input.value).toBe('22.00');
  });
});

// ============================================================
// COMBINED SIGNAL BANNER
// ============================================================

describe('VIXTermStructure (spot): combined signal banner', () => {
  it('shows GREEN LIGHT when all signals are calm', () => {
    render(
      <VIXTermStructure
        vix={25}
        initialVix1d={15} // ratio 0.6 → calm
        initialVix9d={20} // ratio 0.8 → calm
        initialVvix={70} // → stable/calm
      />,
    );
    expect(screen.getByText('GREEN LIGHT')).toBeInTheDocument();
    expect(screen.getByText(/favors selling premium/i)).toBeInTheDocument();
  });

  it('shows PROCEED when worst signal is normal', () => {
    render(
      <VIXTermStructure
        vix={20}
        initialVix1d={19} // ratio 0.95 → normal
        initialVix9d={20} // ratio 1.0 → normal
        initialVvix={85} // → normal
      />,
    );
    expect(screen.getByText('PROCEED')).toBeInTheDocument();
    expect(screen.getByText(/follow delta guide/i)).toBeInTheDocument();
  });

  it('shows CAUTION when worst signal is elevated', () => {
    render(
      <VIXTermStructure
        vix={20}
        initialVix1d={25} // ratio 1.25 → elevated
        initialVix9d={20} // ratio 1.0 → normal
        initialVvix={85} // → normal
      />,
    );
    expect(screen.getByText('CAUTION')).toBeInTheDocument();
    expect(screen.getByText(/reduce exposure/i)).toBeInTheDocument();
  });

  it('shows HIGH ALERT when worst signal is extreme', () => {
    render(
      <VIXTermStructure
        vix={20}
        initialVix1d={35} // ratio 1.75 → extreme
        initialVix9d={20} // ratio 1.0 → normal
        initialVvix={85} // → normal
      />,
    );
    expect(screen.getByText('HIGH ALERT')).toBeInTheDocument();
    expect(screen.getByText(/Significant event risk/i)).toBeInTheDocument();
  });

  it('does not render banner when vix is null', () => {
    render(<VIXTermStructure vix={null} />);
    expect(screen.queryByText('GREEN LIGHT')).not.toBeInTheDocument();
    expect(screen.queryByText('HIGH ALERT')).not.toBeInTheDocument();
  });
});

// ============================================================
// RATIO CARDS
// ============================================================

describe('VIXTermStructure (spot): ratio cards', () => {
  it('renders VIX1D / VIX ratio card with correct ratio', () => {
    render(<VIXTermStructure vix={20} initialVix1d={18} initialVix9d={20} />);
    expect(screen.getByText('VIX1D / VIX')).toBeInTheDocument();
    expect(screen.getByText('0.90x')).toBeInTheDocument();
  });

  it('renders VIX9D / VIX ratio card with correct ratio', () => {
    render(<VIXTermStructure vix={20} initialVix1d={18} initialVix9d={22} />);
    expect(screen.getByText('VIX9D / VIX')).toBeInTheDocument();
    expect(screen.getByText('1.10x')).toBeInTheDocument();
  });

  it('does not render ratio cards when inputs are empty', () => {
    render(<VIXTermStructure vix={20} />);
    // Default input values are 18.50 and 20.10 so cards will show
    // Clear the inputs via user interaction
    const vix1dInput = screen.getByLabelText(/VIX1D/i) as HTMLInputElement;
    const vix9dInput = screen.getByLabelText(/VIX9D/i) as HTMLInputElement;
    fireEvent.change(vix1dInput, { target: { value: '' } });
    fireEvent.change(vix9dInput, { target: { value: '' } });
    expect(screen.queryByText('VIX1D / VIX')).not.toBeInTheDocument();
    expect(screen.queryByText('VIX9D / VIX')).not.toBeInTheDocument();
  });
});

// ============================================================
// VVIX CARD
// ============================================================

describe('VIXTermStructure (spot): VVIX card', () => {
  it('renders VVIX card when initialVvix is provided', () => {
    render(<VIXTermStructure vix={20} initialVvix={95} />);
    expect(screen.getByText('VVIX')).toBeInTheDocument();
    expect(screen.getByText('95.0')).toBeInTheDocument();
  });

  it('does not render VVIX card when initialVvix is null', () => {
    render(<VIXTermStructure vix={20} />);
    expect(screen.queryByText('VVIX')).not.toBeInTheDocument();
  });

  it('does not render VVIX card when initialVvix is 0', () => {
    render(<VIXTermStructure vix={20} initialVvix={0} />);
    expect(screen.queryByText('Volatility of VIX')).not.toBeInTheDocument();
  });
});

// ============================================================
// TERM STRUCTURE SHAPE
// ============================================================

describe('VIXTermStructure (spot): term structure shape', () => {
  it('renders contango shape badge and advice', () => {
    render(
      <VIXTermStructure
        {...baseProps}
        termShape="contango"
        termShapeAdvice="Normal contango — sell premium."
      />,
    );
    expect(screen.getByText('CONTANGO')).toBeInTheDocument();
    expect(
      screen.getByText('Normal contango — sell premium.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Curve Shape')).toBeInTheDocument();
  });

  it('renders fear-spike shape', () => {
    render(
      <VIXTermStructure
        {...baseProps}
        termShape="fear-spike"
        termShapeAdvice="Panic."
      />,
    );
    expect(screen.getByText('FEAR SPIKE')).toBeInTheDocument();
  });

  it('renders backwardation shape', () => {
    render(
      <VIXTermStructure
        {...baseProps}
        termShape="backwardation"
        termShapeAdvice="Inverted."
      />,
    );
    expect(screen.getByText('BACKWARDATION')).toBeInTheDocument();
  });

  it('renders front-calm shape', () => {
    render(
      <VIXTermStructure
        {...baseProps}
        termShape="front-calm"
        termShapeAdvice="Front quiet."
      />,
    );
    expect(screen.getByText('FRONT CALM')).toBeInTheDocument();
  });

  it('renders flat shape as fallback', () => {
    render(
      <VIXTermStructure
        {...baseProps}
        termShape="other"
        termShapeAdvice="Flat structure detected."
      />,
    );
    expect(screen.getByText('Curve Shape')).toBeInTheDocument();
    expect(screen.getByText('Flat structure detected.')).toBeInTheDocument();
  });

  it('does not render shape section when termShape is null', () => {
    render(<VIXTermStructure {...baseProps} />);
    expect(screen.queryByText('Curve Shape')).not.toBeInTheDocument();
  });

  it('does not render shape section when termShapeAdvice is null', () => {
    render(<VIXTermStructure {...baseProps} termShape="contango" />);
    expect(screen.queryByText('Curve Shape')).not.toBeInTheDocument();
  });
});

// ============================================================
// VIX1D SIGMA STATUS
// ============================================================

describe('VIXTermStructure (spot): VIX1D σ status', () => {
  it('shows tip with "Use VIX1D as σ" button when callback is provided', () => {
    const onUse = vi.fn();
    render(
      <VIXTermStructure
        vix={20}
        initialVix1d={18.5}
        onUseVix1dAsSigma={onUse}
      />,
    );
    expect(screen.getByText(/Tip:/i)).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /Use VIX1D/i });
    expect(btn).toBeInTheDocument();
  });

  it('calls onUseVix1dAsSigma with sigma value when button is clicked', () => {
    const onUse = vi.fn();
    render(
      <VIXTermStructure
        vix={20}
        initialVix1d={18.5}
        onUseVix1dAsSigma={onUse}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Use VIX1D/i }));
    // sigma = 18.5 / 100 = 0.185
    expect(onUse).toHaveBeenCalledWith(0.185);
  });

  it('shows active status when isVix1dActive is true', () => {
    render(
      <VIXTermStructure vix={20} initialVix1d={18.5} isVix1dActive={true} />,
    );
    expect(screen.getByText(/Active:/i)).toBeInTheDocument();
    expect(screen.getByText(/No 0DTE adjustment/i)).toBeInTheDocument();
  });

  it('does not show sigma status when VIX1D input is empty', () => {
    render(<VIXTermStructure vix={20} />);
    const input = screen.getByLabelText(/VIX1D/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.queryByText(/Tip:/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Active:/i)).not.toBeInTheDocument();
  });
});

// ============================================================
// EMPTY STATES
// ============================================================

describe('VIXTermStructure (spot): empty states', () => {
  it('shows "Enter a VIX value" when vix is null but inputs have values', () => {
    render(<VIXTermStructure vix={null} />);
    expect(screen.getByText(/Enter a VIX value above/i)).toBeInTheDocument();
  });

  it('shows ticker guidance when vix is set but no VIX1D/9D/VVIX', () => {
    render(<VIXTermStructure vix={20} />);
    // Clear the default input values
    const vix1dInput = screen.getByLabelText(/VIX1D/i) as HTMLInputElement;
    const vix9dInput = screen.getByLabelText(/VIX9D/i) as HTMLInputElement;
    fireEvent.change(vix1dInput, { target: { value: '' } });
    fireEvent.change(vix9dInput, { target: { value: '' } });
    expect(screen.getByText(/CBOE:VIX1D/)).toBeInTheDocument();
  });
});

// ============================================================
// USER INPUT
// ============================================================

describe('VIXTermStructure (spot): user input', () => {
  it('updates VIX1D ratio when input changes', () => {
    render(<VIXTermStructure vix={20} />);
    const input = screen.getByLabelText(/VIX1D/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '30' } });
    // 30/20 = 1.5 → extreme → EVENT RISK label
    expect(screen.getByText('EVENT RISK')).toBeInTheDocument();
  });

  it('updates VIX9D ratio when input changes', () => {
    render(<VIXTermStructure vix={20} />);
    const input = screen.getByLabelText(/VIX9D/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '26' } });
    // 26/20 = 1.3 → extreme → STEEP INVERSION
    expect(screen.getByText('STEEP INVERSION')).toBeInTheDocument();
  });
});

// ============================================================
// GRID LAYOUT
// ============================================================

describe('VIXTermStructure (spot): grid layout', () => {
  it('uses 2-col grid when multiple cards are shown', () => {
    const { container } = render(
      <VIXTermStructure vix={20} initialVix1d={18} initialVix9d={20} />,
    );
    const grid = container.querySelector('.sm\\:grid-cols-2');
    expect(grid).not.toBeNull();
  });
});
