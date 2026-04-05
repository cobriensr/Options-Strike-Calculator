import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FuturesPanel from '../../components/futures/FuturesPanel';
import type { FuturesDataState } from '../../hooks/useFuturesData';
import { useFuturesData } from '../../hooks/useFuturesData';

vi.mock('../../hooks/useFuturesData', () => ({
  useFuturesData: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────

const mockUseFuturesData = vi.mocked(useFuturesData);

function mockState(overrides: Partial<FuturesDataState> = {}) {
  const defaults: FuturesDataState = {
    snapshots: [],
    vxTermSpread: null,
    vxTermStructure: null,
    esSpxBasis: null,
    updatedAt: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  };
  mockUseFuturesData.mockReturnValue({ ...defaults, ...overrides });
}

function makeSnapshots() {
  return [
    {
      symbol: 'ES',
      price: 5450.25,
      change1hPct: 0.15,
      changeDayPct: 0.42,
      volumeRatio: 1.2,
    },
    {
      symbol: 'NQ',
      price: 19800.5,
      change1hPct: -0.1,
      changeDayPct: 0.3,
      volumeRatio: 0.9,
    },
    {
      symbol: 'VXM1',
      price: 18.75,
      change1hPct: null,
      changeDayPct: -1.5,
      volumeRatio: null,
    },
    {
      symbol: 'VXM2',
      price: 20.1,
      change1hPct: null,
      changeDayPct: -0.8,
      volumeRatio: null,
    },
    {
      symbol: 'ZN',
      price: 110.234,
      change1hPct: 0.02,
      changeDayPct: 0.05,
      volumeRatio: 1.0,
    },
    {
      symbol: 'RTY',
      price: 2050.0,
      change1hPct: 0.25,
      changeDayPct: 0.6,
      volumeRatio: 1.1,
    },
    {
      symbol: 'CL',
      price: 72.45,
      change1hPct: -0.4,
      changeDayPct: -1.2,
      volumeRatio: 1.8,
    },
  ];
}

// ============================================================
// LOADING STATE
// ============================================================

describe('FuturesPanel: loading state', () => {
  it('shows loading skeleton when loading with no data', () => {
    mockState({ loading: true, snapshots: [] });
    render(<FuturesPanel />);

    // aria-busy is set on the loading skeleton container
    const busyEl = document.querySelector('[aria-busy="true"]');
    expect(busyEl).toBeInTheDocument();
  });

  it('shows Loading text on refresh button when loading', () => {
    mockState({ loading: true, snapshots: [] });
    render(<FuturesPanel />);

    expect(
      screen.getByRole('button', { name: 'Refresh futures data' }),
    ).toHaveTextContent('Loading...');
  });

  it('does not show skeleton when loading with existing data', () => {
    mockState({ loading: true, snapshots: makeSnapshots() });
    render(<FuturesPanel />);

    const busyEl = document.querySelector('[aria-busy="true"]');
    expect(busyEl).not.toBeInTheDocument();
  });
});

// ============================================================
// EMPTY STATE
// ============================================================

describe('FuturesPanel: empty state', () => {
  it('shows empty state message when no data and not loading', () => {
    mockState({ loading: false, snapshots: [] });
    render(<FuturesPanel />);

    expect(screen.getByText('No futures data yet')).toBeInTheDocument();
    expect(
      screen.getByText(/sidecar is streaming/),
    ).toBeInTheDocument();
  });

  it('does not show empty state when loading', () => {
    mockState({ loading: true, snapshots: [] });
    render(<FuturesPanel />);

    expect(
      screen.queryByText('No futures data yet'),
    ).not.toBeInTheDocument();
  });

  it('does not show empty state when error is present', () => {
    mockState({
      loading: false,
      snapshots: [],
      error: 'Network error',
    });
    render(<FuturesPanel />);

    expect(
      screen.queryByText('No futures data yet'),
    ).not.toBeInTheDocument();
  });
});

// ============================================================
// ERROR STATE
// ============================================================

describe('FuturesPanel: error state', () => {
  it('shows error message when fetch fails', () => {
    mockState({
      loading: false,
      error: 'Failed to fetch futures data (HTTP 500)',
    });
    render(<FuturesPanel />);

    expect(
      screen.getByText('Failed to fetch futures data (HTTP 500)'),
    ).toBeInTheDocument();
  });
});

// ============================================================
// DATA RENDERING
// ============================================================

describe('FuturesPanel: data rendering', () => {
  it('renders FuturesGrid and VixTermStructure when data is available', () => {
    mockState({
      snapshots: makeSnapshots(),
      vxTermSpread: -1.35,
      vxTermStructure: 'CONTANGO',
      esSpxBasis: 3.5,
    });
    render(<FuturesPanel />);

    // FuturesGrid renders all symbols
    expect(screen.getByText('/ES')).toBeInTheDocument();
    expect(screen.getByText('/NQ')).toBeInTheDocument();

    // VixTermStructure renders the term structure badge
    expect(screen.getByText('CONTANGO')).toBeInTheDocument();
  });
});

// ============================================================
// REFRESH BUTTON
// ============================================================

describe('FuturesPanel: refresh button', () => {
  it('renders refresh button', () => {
    mockState();
    render(<FuturesPanel />);

    expect(
      screen.getByRole('button', { name: 'Refresh futures data' }),
    ).toBeInTheDocument();
  });

  it('shows Refresh text when not loading', () => {
    mockState({ loading: false });
    render(<FuturesPanel />);

    expect(
      screen.getByRole('button', { name: 'Refresh futures data' }),
    ).toHaveTextContent('Refresh');
  });

  it('calls refetch when clicked', async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    mockState({ loading: false, refetch });
    render(<FuturesPanel />);

    await user.click(
      screen.getByRole('button', { name: 'Refresh futures data' }),
    );
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('disables refresh button when loading', () => {
    mockState({ loading: true });
    render(<FuturesPanel />);

    expect(
      screen.getByRole('button', { name: 'Refresh futures data' }),
    ).toBeDisabled();
  });
});

// ============================================================
// SECTION STRUCTURE
// ============================================================

describe('FuturesPanel: section structure', () => {
  it('renders inside a section with label Futures', () => {
    mockState();
    render(<FuturesPanel />);

    expect(
      screen.getByRole('region', { name: 'Futures' }),
    ).toBeInTheDocument();
  });
});
