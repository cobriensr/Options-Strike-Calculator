import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sparkline } from '../../../components/ZeroGammaPanel/Sparkline';
import type { ZeroGammaRow } from '../../../hooks/useZeroGamma';

function row(spot: number, zeroGamma: number | null, ts: string): ZeroGammaRow {
  return {
    ticker: 'SPX',
    spot,
    zeroGamma,
    confidence: 0.7,
    netGammaAtSpot: null,
    gammaCurve: null,
    ts,
  };
}

describe('Sparkline edge cases', () => {
  it('shows the waiting fallback when fewer than 2 snapshots', () => {
    render(<Sparkline history={[]} priceDigits={2} />);
    expect(screen.getByText(/waiting for ≥2 snapshots/i)).toBeInTheDocument();
  });

  it('renders an SVG when given multiple snapshots', () => {
    const history = [
      row(7100, 7050, '2026-04-28T19:00:00Z'),
      row(7110, 7055, '2026-04-28T19:05:00Z'),
      row(7120, 7060, '2026-04-28T19:10:00Z'),
    ];
    render(<Sparkline history={history} priceDigits={2} />);
    expect(screen.getByRole('img', { name: /sparkline/i })).toBeInTheDocument();
  });

  it('handles a flat series (range = 0) without crashing', () => {
    const history = [
      row(7100, 7100, '2026-04-28T19:00:00Z'),
      row(7100, 7100, '2026-04-28T19:05:00Z'),
    ];
    const { container } = render(
      <Sparkline history={history} priceDigits={2} />,
    );
    // Two paths (spot + zg). Both should still be rendered.
    expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(1);
  });

  it('breaks the zero-gamma line into separate segments at null gaps', () => {
    const history = [
      row(7100, 7050, '2026-04-28T19:00:00Z'),
      row(7110, null, '2026-04-28T19:05:00Z'),
      row(7120, 7065, '2026-04-28T19:10:00Z'),
      row(7115, 7060, '2026-04-28T19:15:00Z'),
    ];
    const { container } = render(
      <Sparkline history={history} priceDigits={2} />,
    );
    const zgPath = container.querySelectorAll('path')[1];
    expect(zgPath).toBeDefined();
    const d = zgPath!.getAttribute('d') ?? '';
    // Two segments → two M commands.
    const moveCommands = d.match(/M /g) ?? [];
    expect(moveCommands.length).toBe(2);
  });

  it('renders only the spot line when every zero-gamma is null', () => {
    const history = [
      row(7100, null, '2026-04-28T19:00:00Z'),
      row(7110, null, '2026-04-28T19:05:00Z'),
    ];
    const { container } = render(
      <Sparkline history={history} priceDigits={2} />,
    );
    const paths = container.querySelectorAll('path');
    // Spot path always rendered with at least one M command.
    expect((paths[0]!.getAttribute('d') ?? '').includes('M')).toBe(true);
    // ZG path is rendered as an empty string.
    expect(paths[1]!.getAttribute('d')).toBe('');
  });
});
