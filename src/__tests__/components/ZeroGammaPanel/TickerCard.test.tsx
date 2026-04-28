import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TickerCard } from '../../../components/ZeroGammaPanel/TickerCard';
import type { ZeroGammaRow } from '../../../hooks/useZeroGamma';

function row(overrides: Partial<ZeroGammaRow> = {}): ZeroGammaRow {
  return {
    ticker: 'SPX',
    spot: 7100,
    zeroGamma: 7050,
    confidence: 0.7,
    netGammaAtSpot: -1e9,
    gammaCurve: null,
    ts: '2026-04-28T20:10:00.000Z',
    ...overrides,
  };
}

describe('TickerCard regime classification', () => {
  it('shows SUPPRESSION when spot is comfortably above zero-gamma', () => {
    const r = row({ spot: 7100, zeroGamma: 7050 });
    render(
      <TickerCard
        ticker="SPX"
        latest={r}
        history={[r]}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText('SUPPRESSION')).toBeInTheDocument();
  });

  it('shows ACCELERATION when spot is comfortably below zero-gamma', () => {
    const r = row({ spot: 7050, zeroGamma: 7100 });
    render(
      <TickerCard
        ticker="SPX"
        latest={r}
        history={[r]}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText('ACCELERATION')).toBeInTheDocument();
  });

  it('shows KNIFE EDGE within ±0.3% of zero-gamma', () => {
    // 0.2% above
    const r = row({ spot: 7100, zeroGamma: 7100 - 7100 * 0.002 });
    render(
      <TickerCard
        ticker="SPX"
        latest={r}
        history={[r]}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText('KNIFE EDGE')).toBeInTheDocument();
  });

  it('shows NO FLIP when zeroGamma is null', () => {
    const r = row({ zeroGamma: null });
    render(
      <TickerCard
        ticker="SPX"
        latest={r}
        history={[r]}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText('NO FLIP')).toBeInTheDocument();
    // Both the ZG value and the distance row fall back to a dash.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });
});

describe('TickerCard rendering states', () => {
  it('shows loading state before any data arrives', () => {
    render(
      <TickerCard
        ticker="SPX"
        latest={null}
        history={[]}
        loading={true}
        error={null}
      />,
    );
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows error state with role="alert"', () => {
    render(
      <TickerCard
        ticker="SPX"
        latest={null}
        history={[]}
        loading={false}
        error="Failed to load zero-gamma data"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Failed to load');
  });

  it('shows "No data yet" when latest is null but not loading', () => {
    render(
      <TickerCard
        ticker="SPY"
        latest={null}
        history={[]}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText('No data yet')).toBeInTheDocument();
  });

  it('formats positive distance with leading +', () => {
    const r = row({ spot: 7100, zeroGamma: 7050 });
    render(
      <TickerCard
        ticker="SPX"
        latest={r}
        history={[r]}
        loading={false}
        error={null}
      />,
    );
    // Distance: spot - zg = +50, +50/7100 ≈ +0.70%
    expect(screen.getByText(/\+50\.00 \(\+0\.70%\)/)).toBeInTheDocument();
  });

  it('dims zero-gamma value when confidence < 0.5', () => {
    const r = row({ confidence: 0.3 });
    const { container } = render(
      <TickerCard
        ticker="SPX"
        latest={r}
        history={[r]}
        loading={false}
        error={null}
      />,
    );
    const dimmed = container.querySelector('[style*="opacity"]');
    expect(dimmed).not.toBeNull();
  });
});
