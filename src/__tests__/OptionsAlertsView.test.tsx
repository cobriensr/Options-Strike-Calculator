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
    expect(
      screen.getByRole('main', { name: /options alerts/i }),
    ).toBeInTheDocument();
  });

  it('renders both feed panes when market context is present', async () => {
    render(<OptionsAlertsView marketOpen hasMarketContext />);
    expect(
      screen.getByRole('main', { name: /options alerts/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /lottery finder alerts/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /silent boom alerts/i }),
    ).toBeInTheDocument();
    expect(await screen.findByTestId('lottery')).toBeInTheDocument();
    expect(await screen.findByTestId('silent-boom')).toBeInTheDocument();
  });

  it('uses a responsive layout: stacked by default, side-by-side on xl', () => {
    render(<OptionsAlertsView marketOpen hasMarketContext />);

    const root = screen.getByRole('main', { name: /options alerts/i });
    expect(root.className).toContain('flex-col');
    expect(root.className).toContain('xl:flex-row');

    const lottery = screen.getByRole('region', {
      name: /lottery finder alerts/i,
    });
    const silentBoom = screen.getByRole('region', {
      name: /silent boom alerts/i,
    });

    for (const pane of [lottery, silentBoom]) {
      expect(pane.className).toContain('min-h-0');
      expect(pane.className).toContain('flex-1');
      expect(pane.className).toContain('overflow-y-auto');
      expect(pane.className).toContain('min-w-0');
    }

    // The first (Lottery) pane carries the divider that flips from a bottom
    // border (stacked) to a right border (side-by-side) at the xl breakpoint.
    expect(lottery.className).toContain('border-b');
    expect(lottery.className).toContain('xl:border-b-0');
    expect(lottery.className).toContain('xl:border-r');
  });
});
