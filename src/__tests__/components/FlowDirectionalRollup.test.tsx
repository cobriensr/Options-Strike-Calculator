import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FlowDirectionalRollup } from '../../components/OptionsFlow/FlowDirectionalRollup';
import type { DirectionalRollup } from '../../hooks/useOptionsFlow';

function makeRollup(
  overrides: Partial<DirectionalRollup> = {},
): DirectionalRollup {
  return {
    bullish_count: 4,
    bearish_count: 1,
    bullish_premium: 12_400_000,
    bearish_premium: 2_100_000,
    lean: 'bullish',
    confidence: 0.78,
    top_bullish_strike: 6900,
    top_bearish_strike: 6800,
    ...overrides,
  };
}

describe('FlowDirectionalRollup', () => {
  it('renders a green BULLISH badge when lean=bullish', () => {
    render(
      <FlowDirectionalRollup
        rollup={makeRollup({ lean: 'bullish' })}
        spot={6850}
        alertCount={10}
      />,
    );

    const label = screen.getByText('BULLISH');
    expect(label).toBeInTheDocument();
    // Badge wrapper (parent of the text) should have an emerald/green class
    const badge = label.closest('div');
    expect(badge?.className).toMatch(/emerald-|green-/);
  });

  it('renders a red BEARISH badge when lean=bearish', () => {
    render(
      <FlowDirectionalRollup
        rollup={makeRollup({ lean: 'bearish' })}
        spot={6850}
        alertCount={10}
      />,
    );
    const label = screen.getByText('BEARISH');
    expect(label).toBeInTheDocument();
    const badge = label.closest('div');
    expect(badge?.className).toMatch(/rose-|red-/);
  });

  it('renders a slate NEUTRAL badge when lean=neutral', () => {
    render(
      <FlowDirectionalRollup
        rollup={makeRollup({ lean: 'neutral' })}
        spot={6850}
        alertCount={10}
      />,
    );
    const label = screen.getByText('NEUTRAL');
    expect(label).toBeInTheDocument();
    const badge = label.closest('div');
    expect(badge?.className).toMatch(/slate-/);
  });

  it('shows "No spot data" when spot is null', () => {
    render(
      <FlowDirectionalRollup
        rollup={makeRollup()}
        spot={null}
        alertCount={10}
      />,
    );
    expect(screen.getByText(/no spot data/i)).toBeInTheDocument();
  });

  it('shows "No alerts in window" when alertCount is 0', () => {
    render(
      <FlowDirectionalRollup
        rollup={makeRollup()}
        spot={6850}
        alertCount={0}
      />,
    );
    expect(screen.getByText(/no alerts in window/i)).toBeInTheDocument();
  });

  it('shows both top bullish and top bearish strikes when both are present', () => {
    render(
      <FlowDirectionalRollup
        rollup={makeRollup({
          top_bullish_strike: 6900,
          top_bearish_strike: 6800,
        })}
        spot={6850}
        alertCount={5}
      />,
    );
    expect(screen.getByText(/6,900C/)).toBeInTheDocument();
    expect(screen.getByText(/6,800P/)).toBeInTheDocument();
  });

  it('formats premium totals in compact form', () => {
    render(
      <FlowDirectionalRollup
        rollup={makeRollup({
          bullish_premium: 12_400_000,
          bearish_premium: 2_100_000,
        })}
        spot={6850}
        alertCount={5}
      />,
    );
    expect(screen.getByText(/\$12\.4M/)).toBeInTheDocument();
    expect(screen.getByText(/\$2\.1M/)).toBeInTheDocument();
    // The raw cents value should NOT be in the DOM
    expect(screen.queryByText(/12400000/)).not.toBeInTheDocument();
  });

  it('renders the confidence percentage', () => {
    render(
      <FlowDirectionalRollup
        rollup={makeRollup({ confidence: 0.78 })}
        spot={6850}
        alertCount={10}
      />,
    );
    expect(screen.getByText('78%')).toBeInTheDocument();
  });

  it('renders bullish and bearish counts side-by-side', () => {
    render(
      <FlowDirectionalRollup
        rollup={makeRollup({ bullish_count: 4, bearish_count: 1 })}
        spot={6850}
        alertCount={5}
      />,
    );
    expect(screen.getByText(/4 bullish/)).toBeInTheDocument();
    expect(screen.getByText(/1 bearish/)).toBeInTheDocument();
  });
});
