import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ParameterSummary from '../components/ParameterSummary';
import { lightTheme } from '../themes';

const th = lightTheme;

describe('ParameterSummary', () => {
  const defaultProps = {
    th,
    spySpot: '550.25',
    spxLabel: 'SPX (×10.00)',
    spxValue: '5503',
    sigma: '18.50%',
    T: '0.002976',
    hoursLeft: '4.87h',
  };

  it('renders all parameter labels', () => {
    render(<ParameterSummary {...defaultProps} />);
    expect(screen.getByText('SPY Spot')).toBeInTheDocument();
    expect(screen.getByText('SPX (×10.00)')).toBeInTheDocument();
    expect(screen.getByText('σ (IV)')).toBeInTheDocument();
    expect(screen.getByText('T')).toBeInTheDocument();
    expect(screen.getByText('Hours Left')).toBeInTheDocument();
  });

  it('renders all parameter values', () => {
    render(<ParameterSummary {...defaultProps} />);
    expect(screen.getByText('550.25')).toBeInTheDocument();
    expect(screen.getByText('5503')).toBeInTheDocument();
    expect(screen.getByText('18.50%')).toBeInTheDocument();
    expect(screen.getByText('0.002976')).toBeInTheDocument();
    expect(screen.getByText('4.87h')).toBeInTheDocument();
  });

  it('renders as a fieldset with aria-label', () => {
    render(<ParameterSummary {...defaultProps} />);
    expect(
      screen.getByRole('group', { name: 'Calculation parameters' }),
    ).toBeInTheDocument();
  });

  it('renders with different SPX label for direct mode', () => {
    render(<ParameterSummary {...defaultProps} spxLabel="SPX (×10.0134)" />);
    expect(screen.getByText('SPX (×10.0134)')).toBeInTheDocument();
  });
});
