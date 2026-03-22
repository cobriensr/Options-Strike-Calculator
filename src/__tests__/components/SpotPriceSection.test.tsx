import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SpotPriceSection from '../../components/SpotPriceSection';
import { theme } from '../../themes';

const th = theme;
const inputCls = 'test-input';

function defaults(overrides: Record<string, unknown> = {}) {
  return {
    th,
    inputCls,
    spotPrice: '550',
    onSpotChange: vi.fn(),
    spxDirect: '',
    onSpxDirectChange: vi.fn(),
    spxRatio: 10.0,
    onSpxRatioChange: vi.fn(),
    dSpot: '',
    effectiveRatio: 10.0,
    spxDirectActive: false,
    derivedRatio: 10.0,
    errors: {} as Record<string, string>,
    ...overrides,
  };
}

describe('SpotPriceSection', () => {
  it('renders section heading "Spot Price"', () => {
    render(<SpotPriceSection {...defaults()} />);
    expect(screen.getByText('Spot Price')).toBeInTheDocument();
  });

  it('renders SPY and SPX input fields', () => {
    render(<SpotPriceSection {...defaults()} />);
    expect(screen.getByLabelText(/SPY Price/)).toBeInTheDocument();
    expect(screen.getByLabelText(/SPX Price/)).toBeInTheDocument();
  });

  it('calls onSpotChange when SPY input changes', () => {
    const onSpotChange = vi.fn();
    render(<SpotPriceSection {...defaults({ onSpotChange })} />);
    fireEvent.change(document.getElementById('spot-price')!, {
      target: { value: '555' },
    });
    expect(onSpotChange).toHaveBeenCalledWith('555');
  });

  it('calls onSpxDirectChange when SPX input changes', () => {
    const onSpxDirectChange = vi.fn();
    render(<SpotPriceSection {...defaults({ onSpxDirectChange })} />);
    fireEvent.change(document.getElementById('spx-direct')!, {
      target: { value: '5550' },
    });
    expect(onSpxDirectChange).toHaveBeenCalledWith('5550');
  });

  it('shows error when errors["spot"] exists', () => {
    render(
      <SpotPriceSection {...defaults({ errors: { spot: 'Invalid price' } })} />,
    );
    expect(screen.getByText('Invalid price')).toBeInTheDocument();
  });

  it('does not show error when no spot error', () => {
    render(<SpotPriceSection {...defaults()} />);
    expect(screen.queryByText('Invalid price')).not.toBeInTheDocument();
  });

  it('shows derived ratio when spxDirectActive=true and dSpot is valid', () => {
    render(
      <SpotPriceSection
        {...defaults({
          dSpot: '550',
          spxDirectActive: true,
          derivedRatio: 10.0125,
        })}
      />,
    );
    expect(screen.getByText('Derived ratio')).toBeInTheDocument();
    expect(screen.getByText('10.0125')).toBeInTheDocument();
    expect(screen.getByText(/Using actual SPX value/)).toBeInTheDocument();
  });

  it('shows ratio slider when spxDirectActive=false and dSpot is valid', () => {
    render(
      <SpotPriceSection
        {...defaults({ dSpot: '550', spxDirectActive: false, spxRatio: 10.0 })}
      />,
    );
    expect(screen.getByLabelText(/SPX\/SPY Ratio/)).toBeInTheDocument();
    const slider = document.getElementById('spx-ratio') as HTMLInputElement;
    expect(slider).toBeInTheDocument();
    expect(slider.type).toBe('range');
    expect(slider.min).toBe('9.95');
    expect(slider.max).toBe('10.05');
  });

  it('calls onSpxRatioChange when slider changes', () => {
    const onSpxRatioChange = vi.fn();
    render(
      <SpotPriceSection
        {...defaults({
          dSpot: '550',
          spxDirectActive: false,
          onSpxRatioChange,
        })}
      />,
    );
    const slider = document.getElementById('spx-ratio')!;
    fireEvent.change(slider, { target: { value: '10.02' } });
    expect(onSpxRatioChange).toHaveBeenCalledWith(10.02);
  });

  it('shows SPX for calculations value', () => {
    render(
      <SpotPriceSection
        {...defaults({ dSpot: '550', effectiveRatio: 10.0 })}
      />,
    );
    expect(screen.getByText('SPX for calculations')).toBeInTheDocument();
    expect(screen.getByText('5500')).toBeInTheDocument();
  });

  it('does not show ratio section when dSpot is empty', () => {
    render(<SpotPriceSection {...defaults({ dSpot: '' })} />);
    expect(screen.queryByText('SPX for calculations')).not.toBeInTheDocument();
    expect(screen.queryByText('Derived ratio')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/SPX\/SPY Ratio/)).not.toBeInTheDocument();
  });
});
