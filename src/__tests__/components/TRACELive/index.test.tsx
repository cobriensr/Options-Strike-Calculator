import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TRACELiveDashboard from '../../../components/TRACELive';

// Mock the data hook so we can drive component behavior without a server.
vi.mock('../../../components/TRACELive/hooks/useTraceLiveData', () => ({
  useTraceLiveData: vi.fn(() => ({
    list: [],
    listLoading: false,
    listError: null,
    detail: null,
    detailLoading: false,
    detailError: null,
    selectedDate: '2026-04-26',
    setSelectedDate: vi.fn(),
    selectedId: null,
    setSelectedId: vi.fn(),
    isLive: true,
    refresh: vi.fn(),
  })),
}));

vi.mock('../../../components/TRACELive/hooks/useTraceLiveCountdown', () => ({
  useTraceLiveCountdown: vi.fn(() => ({
    secondsRemaining: null,
    label: null,
    isOverdue: false,
    nextExpectedAt: null,
  })),
}));

vi.mock('../../../components/TRACELive/hooks/useTraceLiveChime', () => ({
  useTraceLiveChime: vi.fn(),
}));

// Pull the mocked hook reference for assertions.
import { useTraceLiveData } from '../../../components/TRACELive/hooks/useTraceLiveData';

describe('<TRACELiveDashboard>', () => {
  it('renders the SectionBox with the TRACE Live label', () => {
    render(<TRACELiveDashboard marketOpen={false} />);
    // SectionBox renders an <h2> with the label uppercase.
    expect(screen.getByText(/TRACE LIVE/i)).toBeInTheDocument();
  });

  it('passes marketOpen through to useTraceLiveData', () => {
    const mockHook = vi.mocked(useTraceLiveData);
    mockHook.mockClear();
    render(<TRACELiveDashboard marketOpen={true} />);
    expect(mockHook).toHaveBeenCalledWith(true);

    mockHook.mockClear();
    render(<TRACELiveDashboard marketOpen={false} />);
    expect(mockHook).toHaveBeenCalledWith(false);
  });

  it('switches the active tab when a tab is clicked', async () => {
    const user = userEvent.setup();
    render(<TRACELiveDashboard marketOpen={false} />);
    // TRACE Live mounts expanded by default (primary live-data panel).

    // Default active tab is gamma — its aria-selected should be true.
    const gammaTab = screen.getByRole('tab', { name: /Gamma/ });
    const charmTab = screen.getByRole('tab', { name: /Charm/ });
    expect(gammaTab).toHaveAttribute('aria-selected', 'true');
    expect(charmTab).toHaveAttribute('aria-selected', 'false');

    await user.click(charmTab);
    expect(charmTab).toHaveAttribute('aria-selected', 'true');
    expect(gammaTab).toHaveAttribute('aria-selected', 'false');
  });
});
