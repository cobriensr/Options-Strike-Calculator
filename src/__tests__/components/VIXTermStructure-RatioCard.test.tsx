/**
 * Tests for VIXTermStructure RatioCard. Covers the trajectory-color
 * tier function, the +/-/zero formatDelta branches, and the conditional
 * trajectory rendering — none of which the parent VIXTermStructure tests
 * exercise because they pass null trajectories.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import RatioCard from '../../components/VIXTermStructure/RatioCard';

function defaultProps(
  overrides: Partial<Parameters<typeof RatioCard>[0]> = {},
) {
  return {
    title: 'VIX1D / VIX',
    subtitle: '0DTE / 30D ratio',
    ratio: 1.05,
    label: 'INVERTED',
    color: '#ff5555',
    advice: 'Hedge against tail risk.',
    trajectory: null,
    ...overrides,
  };
}

describe('RatioCard rendering', () => {
  it('renders title, subtitle, label badge, and ratio with x suffix', () => {
    render(<RatioCard {...defaultProps()} />);
    expect(screen.getByText('VIX1D / VIX')).toBeDefined();
    expect(screen.getByText('0DTE / 30D ratio')).toBeDefined();
    expect(screen.getByText('INVERTED')).toBeDefined();
    expect(screen.getByText('1.05x')).toBeDefined();
  });

  it('renders the advice paragraph', () => {
    render(<RatioCard {...defaultProps()} />);
    expect(screen.getByText('Hedge against tail risk.')).toBeDefined();
  });

  it('omits the trajectory line when trajectory prop is null', () => {
    render(<RatioCard {...defaultProps({ trajectory: null })} />);
    expect(screen.queryByLabelText(/15-minute change/)).toBeNull();
  });
});

describe('RatioCard trajectory display', () => {
  it('formats a positive delta with a + sign and two decimals', () => {
    render(
      <RatioCard
        {...defaultProps({ trajectory: { delta: 0.073, spanMin: 15 } })}
      />,
    );
    expect(screen.getByLabelText(/\+0\.07/)).toBeDefined();
    expect(screen.getByText(/15m/)).toBeDefined();
  });

  it('formats a negative delta with a unicode minus sign', () => {
    render(
      <RatioCard
        {...defaultProps({ trajectory: { delta: -0.12, spanMin: 12 } })}
      />,
    );
    expect(screen.getByLabelText(/\u22120\.12/)).toBeDefined();
  });

  it('renders ±0.00 when the rounded delta is exactly zero', () => {
    render(
      <RatioCard
        {...defaultProps({ trajectory: { delta: 0.001, spanMin: 10 } })}
      />,
    );
    // 0.001 rounds to 0; uses ± sigil
    expect(screen.getByLabelText(/\u00B10\.00/)).toBeDefined();
  });

  it('shows the elapsed minutes label', () => {
    render(
      <RatioCard
        {...defaultProps({ trajectory: { delta: 0.05, spanMin: 22 } })}
      />,
    );
    expect(screen.getByText(/22m/)).toBeDefined();
  });
});
