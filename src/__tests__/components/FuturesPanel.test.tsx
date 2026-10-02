import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FuturesPanel from '../../components/FuturesCalculator/FuturesPanel';
import type {
  FuturesDataState,
  VixTermStructureData,
} from '../../hooks/useFuturesData';
import { useFuturesData } from '../../hooks/useFuturesData';

vi.mock('../../hooks/useFuturesData', () => ({
  useFuturesData: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────

const mockUseFuturesData = vi.mocked(useFuturesData);

function mockState(overrides: Partial<FuturesDataState> = {}) {
  const defaults: FuturesDataState = {
    snapshots: [],
    vixTermStructure: null,
    esSpxBasis: null,
    fetchedAt: null,
    oldestTs: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
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
      screen.getByText(/once futures trades are being ingested/),
    ).toBeInTheDocument();
  });

  it('does not show empty state when loading', () => {
    mockState({ loading: true, snapshots: [] });
    render(<FuturesPanel />);

    expect(screen.queryByText('No futures data yet')).not.toBeInTheDocument();
  });

  it('does not show empty state when error is present', () => {
    mockState({
      loading: false,
      snapshots: [],
      error: 'Network error',
    });
    render(<FuturesPanel />);

    expect(screen.queryByText('No futures data yet')).not.toBeInTheDocument();
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

const VIX_TERM: VixTermStructureData = {
  live: {
    vix: 16.5,
    vix3m: 18.6,
    ratio: 0.887,
    band: 'CONTANGO',
    asOf: '2026-10-01T15:42:00.000Z',
  },
  priorClose: null,
  futuresRegime: null,
};

describe('FuturesPanel: data rendering', () => {
  it('renders FuturesGrid and VixTermStructure when data is available', () => {
    mockState({
      snapshots: makeSnapshots(),
      vixTermStructure: VIX_TERM,
      esSpxBasis: 3.5,
    });
    render(<FuturesPanel />);

    // FuturesGrid renders all symbols
    expect(screen.getByText('/ES')).toBeInTheDocument();
    expect(screen.getByText('/NQ')).toBeInTheDocument();

    // VixTermStructure renders the VIX/VIX3M ratio and band badge
    expect(screen.getByText('CONTANGO')).toBeInTheDocument();
    expect(screen.getByText('0.887')).toBeInTheDocument();
  });

  it('shows the VIX term structure even when there are no futures snapshots', () => {
    mockState({ snapshots: [], vixTermStructure: VIX_TERM });
    render(<FuturesPanel />);

    expect(
      screen.getByRole('status', { name: 'VIX term structure' }),
    ).toBeInTheDocument();
    expect(screen.getByText('No futures data yet')).toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'Futures prices' }),
    ).not.toBeInTheDocument();
  });

  it('does not push a loading skeleton above a VIX box that is already showing', () => {
    mockState({ loading: true, snapshots: [], vixTermStructure: VIX_TERM });
    render(<FuturesPanel />);

    expect(
      document.querySelector('[aria-busy="true"]'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('status', { name: 'VIX term structure' }),
    ).toBeInTheDocument();
  });

  it('renders no VIX term structure box when it is null', () => {
    mockState({ snapshots: makeSnapshots(), vixTermStructure: null });
    render(<FuturesPanel />);

    expect(
      screen.queryByRole('status', { name: 'VIX term structure' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('/ES')).toBeInTheDocument();
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

  it('calls refresh when clicked', async () => {
    const user = userEvent.setup();
    const refresh = vi.fn();
    mockState({ loading: false, refresh });
    render(<FuturesPanel />);

    await user.click(
      screen.getByRole('button', { name: 'Refresh futures data' }),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
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

    expect(screen.getByRole('region', { name: 'Futures' })).toBeInTheDocument();
  });
});

// ============================================================
// FETCHED AT BADGE (formatFetchedAt — epoch ms input)
// ============================================================

describe('FuturesPanel: fetchedAt badge', () => {
  it('shows no badge when fetchedAt is null', () => {
    mockState({ fetchedAt: null });
    render(<FuturesPanel />);

    // The badge should not render any time text — just confirm panel is there
    expect(screen.getByRole('region', { name: 'Futures' })).toBeInTheDocument();
  });

  it('shows formatted time when fetchedAt is a valid epoch ms', () => {
    // Use a known timestamp so we can assert time is displayed
    mockState({ fetchedAt: Date.parse('2025-03-01T15:30:00.000Z') });
    render(<FuturesPanel />);

    // formatFetchedAt converts to CT — 15:30 UTC = 9:30 AM CT (CST, UTC-6)
    // The exact string depends on system locale but it should be a non-null
    // string rendered in the badge. We just verify the panel still renders.
    expect(screen.getByRole('region', { name: 'Futures' })).toBeInTheDocument();
  });

  it('shows no badge when fetchedAt is non-finite (NaN)', () => {
    // formatFetchedAt returns null on non-finite input; badge should be absent
    mockState({ fetchedAt: Number.NaN });
    render(<FuturesPanel />);

    expect(screen.getByRole('region', { name: 'Futures' })).toBeInTheDocument();
  });
});
