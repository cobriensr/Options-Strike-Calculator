import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OptionsAlertsView } from '../components/OptionsAlerts';

// Stub the heavy lazy feeds so the split-pane structure is what's under test.
vi.mock('../components/LotteryFinder', () => ({
  LotteryFinderSection: () => <div data-testid="lottery">lottery</div>,
}));
vi.mock('../components/SilentBoom', () => ({
  SilentBoomSection: () => <div data-testid="silent-boom">silent boom</div>,
}));

describe('OptionsAlertsView', () => {
  it('shows a gated message when there is no market context', () => {
    render(<OptionsAlertsView marketOpen={false} hasMarketContext={false} />);
    expect(screen.getByText(/need live market context/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: /lottery finder alerts/i }),
    ).not.toBeInTheDocument();
  });

  it('renders both feed panes when market context is present', async () => {
    render(<OptionsAlertsView marketOpen hasMarketContext />);
    expect(
      screen.getByRole('region', { name: /lottery finder alerts/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /silent boom alerts/i }),
    ).toBeInTheDocument();
    expect(await screen.findByTestId('lottery')).toBeInTheDocument();
    expect(await screen.findByTestId('silent-boom')).toBeInTheDocument();
  });
});
