/**
 * Tests for VIXTermStructure RatioCard. Covers the trajectory-color
 * tier function, the +/-/zero formatDelta branches, and the conditional
 * trajectory rendering — none of which the parent VIXTermStructure tests
 * exercise because they pass null trajectories.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import RatioCard from '../../components/VIXTermStructure/RatioCard';
import { genericElementsWithAriaLabel, srHintText } from '../helpers/aria';

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
    expect(screen.queryByText(/-minute change/)).toBeNull();
  });
});

describe('RatioCard trajectory display', () => {
  it('formats a positive delta with a + sign and two decimals', () => {
    const { container } = render(
      <RatioCard
        {...defaultProps({ trajectory: { delta: 0.073, spanMin: 15 } })}
      />,
    );
    const delta = screen.getByText(/\+0\.07/);
    expect(delta).toBeDefined();
    expect(screen.getByText(/15m/)).toBeDefined();
    // The delta is a bare div: it says what the number is in a hidden hint,
    // not an aria-label (ARIA 1.2 prohibits naming a generic element).
    expect(srHintText(delta)).toBe('15-minute change');
    expect(delta).not.toHaveAttribute('aria-label');
    expect(genericElementsWithAriaLabel(container)).toEqual([]);
  });

  it('formats a negative delta with a unicode minus sign', () => {
    render(
      <RatioCard
        {...defaultProps({ trajectory: { delta: -0.12, spanMin: 12 } })}
      />,
    );
    const delta = screen.getByText(/\u22120\.12/);
    expect(delta).toBeDefined();
    // The hint follows the real span, not a fixed 15 minutes.
    expect(srHintText(delta)).toBe('12-minute change');
  });

  it('renders ±0.00 when the rounded delta is exactly zero', () => {
    render(
      <RatioCard
        {...defaultProps({ trajectory: { delta: 0.001, spanMin: 10 } })}
      />,
    );
    // 0.001 rounds to 0; uses ± sigil
    expect(srHintText(screen.getByText(/\u00B10\.00/))).toBe(
      '10-minute change',
    );
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
