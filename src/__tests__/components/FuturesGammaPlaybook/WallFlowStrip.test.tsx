import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { WallFlowStrip } from '../../../components/FuturesGammaPlaybook/WallFlowStrip';

describe('WallFlowStrip', () => {
  it('renders em-dashes when both trends are null', () => {
    render(<WallFlowStrip ceilingTrend5m={null} floorTrend5m={null} />);
    const pctLabels = screen.getAllByText('—');
    expect(pctLabels.length).toBe(2);
  });

  it('labels ceiling as strengthening when Δ% ≥ threshold', () => {
    render(<WallFlowStrip ceilingTrend5m={3.2} floorTrend5m={0.1} />);
    expect(screen.getByText('strengthening')).toBeTruthy();
    expect(screen.getByText('flat')).toBeTruthy();
  });

  it('labels floor as eroding when Δ% ≤ −threshold', () => {
    render(<WallFlowStrip ceilingTrend5m={0} floorTrend5m={-5.4} />);
    expect(screen.getByText('eroding')).toBeTruthy();
  });

  it('sub-threshold trends collapse to flat (dead-band)', () => {
    // ±1.9% is inside the ±2% dead-band.
    render(<WallFlowStrip ceilingTrend5m={1.9} floorTrend5m={-1.9} />);
    const flatLabels = screen.getAllByText('flat');
    expect(flatLabels.length).toBe(2);
  });

  it('formats percentages with a sign', () => {
    render(<WallFlowStrip ceilingTrend5m={3.2} floorTrend5m={-1.1} />);
    expect(screen.getByText('+3.2%')).toBeTruthy();
    expect(screen.getByText('-1.1%')).toBeTruthy();
  });
});
