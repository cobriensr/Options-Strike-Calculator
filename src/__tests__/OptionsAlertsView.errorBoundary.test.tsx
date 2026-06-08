import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OptionsAlertsView } from '../components/OptionsAlerts';

// Lottery feed throws on render to exercise the per-pane ErrorBoundary.
vi.mock('../components/LotteryFinder', () => ({
  LotteryFinderSection: () => {
    throw new Error('boom');
  },
}));
// Silent Boom renders normally — proving isolation, not a whole-view crash.
vi.mock('../components/SilentBoom', () => ({
  SilentBoomSection: () => <div data-testid="silent-boom">silent boom</div>,
}));

describe('OptionsAlertsView error isolation', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Silence the expected React error-boundary console noise for this case.
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it('isolates a crashing feed to its own pane (ErrorBoundary)', async () => {
    render(<OptionsAlertsView marketOpen hasMarketContext />);

    // (a) The Lottery pane shows the ErrorBoundary fallback.
    expect(
      await screen.findByText(/lottery finder failed to render/i),
    ).toBeInTheDocument();

    // (b) The Silent Boom feed still renders — the crash did not take down
    //     the whole view.
    expect(await screen.findByTestId('silent-boom')).toBeInTheDocument();
  });
});
