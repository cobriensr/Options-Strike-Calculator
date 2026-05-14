/**
 * SilentBoomSection unit tests — pragmatic smoke + key-interaction
 * coverage. The main hook (useSilentBoomFeed) is mocked so tests don't
 * trigger network calls; the heavy SilentBoomRow child is stubbed so
 * tests don't need to set up its hook trio. The Day/Regime banner
 * children are left intact (small, pure components).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SilentBoomAlert } from '../components/SilentBoom/types';

// ── Mocks ─────────────────────────────────────────────────────────────

const { mockUseSilentBoomFeed } = vi.hoisted(() => ({
  mockUseSilentBoomFeed: vi.fn(),
}));

vi.mock('../hooks/useSilentBoomFeed', () => ({
  useSilentBoomFeed: mockUseSilentBoomFeed,
}));

// Stub SilentBoomRow so the section's pagination/filter logic is testable
// without dragging in the contract-tape / net-flow hooks.
vi.mock('../components/SilentBoom/SilentBoomRow', () => ({
  SilentBoomRow: ({ alert }: { alert: SilentBoomAlert }) => (
    <div
      data-testid={`silent-boom-row-${alert.optionChainId}`}
      data-ticker={alert.underlyingSymbol}
    >
      {alert.underlyingSymbol} {alert.strike}
    </div>
  ),
}));

import { SilentBoomSection } from '../components/SilentBoom/SilentBoomSection';

// ── Fixture factory ───────────────────────────────────────────────────

function makeAlert(overrides: Partial<SilentBoomAlert> = {}): SilentBoomAlert {
  return {
    id: 1,
    date: '2026-05-08',
    bucketCt: '2026-05-08T14:30:00Z',
    optionChainId: 'AAPL260508C00200000',
    underlyingSymbol: 'AAPL',
    optionType: 'C',
    strike: 200,
    expiry: '2026-05-08',
    dte: 0,
    spikeVolume: 1500,
    baselineVolume: 100,
    spikeRatio: 15,
    askPct: 0.75,
    volOi: 0.45,
    entryPrice: 1.5,
    openInterest: 5000,
    score: 12,
    scoreTier: 'tier2',
    directionGated: false,
    mktTideDiff: null,
    zeroDteDiff: null,
    spxSpotGammaOi: null,
    avgHoldMinutes: 197,
    outcomes: {
      peakCeilingPct: null,
      minutesToPeak: null,
      realized30mPct: null,
      realized60mPct: null,
      realized120mPct: null,
      realizedEodPct: null,
      realizedTrail3010Pct: null,
      enrichedAt: null,
    },
    insertedAt: '2026-05-08T14:31:00Z',
    ...overrides,
  };
}

const defaultHookResult = {
  alerts: [] as SilentBoomAlert[],
  loading: false,
  error: null as string | null,
  fetchedAt: null as number | null,
  total: 0,
  limit: 50,
  offset: 0,
  hasMore: false,
  refetch: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  // Clear localStorage between tests so persisted prefs don't leak
  // across cases (sortMode, convictionFloor, hideLatePm, hideGhosts,
  // minVolOi).
  window.localStorage.clear();
  mockUseSilentBoomFeed.mockReturnValue(defaultHookResult);
});

// ============================================================
// SMOKE
// ============================================================

describe('SilentBoomSection: smoke', () => {
  it('renders the Silent Boom section heading', () => {
    render(<SilentBoomSection marketOpen={false} />);
    expect(
      screen.getByRole('heading', { name: /silent boom/i }),
    ).toBeInTheDocument();
  });

  it('renders the methodology link to the spec doc', () => {
    render(<SilentBoomSection marketOpen={false} />);
    const link = screen.getByRole('link', { name: /methodology/i });
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/cobriensr/Options-Strike-Calculator/blob/main/docs/superpowers/specs/silent-boom-detector-2026-05-08.md',
    );
  });

  it('renders the export anchors (filtered + all)', () => {
    render(<SilentBoomSection marketOpen={false} />);
    expect(screen.getByText(/⤓ filtered/)).toBeInTheDocument();
    expect(screen.getByText(/⤓ all/)).toBeInTheDocument();
  });
});

// ============================================================
// EMPTY / LOADING / ERROR STATES
// ============================================================

describe('SilentBoomSection: states', () => {
  it('renders the empty-state copy when no alerts are returned', () => {
    mockUseSilentBoomFeed.mockReturnValue(defaultHookResult);
    render(<SilentBoomSection marketOpen={false} />);
    expect(screen.getByText(/No silent-boom alerts on/i)).toBeInTheDocument();
  });

  it('renders the loading line when the hook is loading and alerts are empty', () => {
    mockUseSilentBoomFeed.mockReturnValue({
      ...defaultHookResult,
      loading: true,
    });
    render(<SilentBoomSection marketOpen={false} />);
    expect(screen.getByText(/Loading silent-boom feed…/i)).toBeInTheDocument();
  });

  it('renders the error alert when the hook surfaces an error', () => {
    mockUseSilentBoomFeed.mockReturnValue({
      ...defaultHookResult,
      error: 'HTTP 503',
    });
    render(<SilentBoomSection marketOpen={false} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Error: HTTP 503/);
  });
});

// ============================================================
// POPULATED — RENDER ROWS
// ============================================================

describe('SilentBoomSection: populated rendering', () => {
  it('renders one SilentBoomRow stub per alert', () => {
    const alerts = [
      makeAlert({
        id: 1,
        optionChainId: 'AAPL260508C00200000',
        underlyingSymbol: 'AAPL',
        strike: 200,
      }),
      makeAlert({
        id: 2,
        optionChainId: 'TSLA260508C00250000',
        underlyingSymbol: 'TSLA',
        strike: 250,
      }),
    ];
    mockUseSilentBoomFeed.mockReturnValue({
      ...defaultHookResult,
      alerts,
      total: 2,
    });

    render(<SilentBoomSection marketOpen={true} />);

    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('silent-boom-row-TSLA260508C00250000'),
    ).toBeInTheDocument();
  });
});

// ============================================================
// KEY INTERACTION — filter toggles
// ============================================================

describe('SilentBoomSection: filter interactions', () => {
  it('flips the hide-post-14:30 aria-pressed state when toggled', () => {
    render(<SilentBoomSection marketOpen={false} />);
    const chip = screen.getByRole('button', { name: /hide post-14:30/i });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  it('flips the hide-ghosts aria-pressed state when toggled', () => {
    render(<SilentBoomSection marketOpen={false} />);
    const chip = screen.getByRole('button', { name: /hide ghosts/i });
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  it('flips the hide-counter-trend aria-pressed state and persists to localStorage', () => {
    render(<SilentBoomSection marketOpen={false} />);
    const chip = screen.getByTestId('silent-boom-hide-gated-chip');
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem('silentBoom.hideGated')).toBe('1');
  });

  it('drops gated rows from the displayed list when hide-counter-trend is on', () => {
    const alerts = [
      makeAlert({
        id: 1,
        optionChainId: 'AAPL260508C00200000',
        directionGated: false,
      }),
      makeAlert({
        id: 2,
        optionChainId: 'SPY260508P00500000',
        underlyingSymbol: 'SPY',
        optionType: 'P',
        strike: 500,
        directionGated: true,
      }),
    ];
    mockUseSilentBoomFeed.mockReturnValue({
      ...defaultHookResult,
      alerts,
      total: 2,
    });

    render(<SilentBoomSection marketOpen={false} />);

    // Both visible before toggling the filter.
    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('silent-boom-row-SPY260508P00500000'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('silent-boom-hide-gated-chip'));

    // Only AAPL (non-gated) remains.
    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('silent-boom-row-SPY260508P00500000'),
    ).not.toBeInTheDocument();
  });

  it('persists the conviction-floor selection to localStorage when changed', () => {
    render(<SilentBoomSection marketOpen={false} />);
    const tier1Chip = screen.getByRole('button', { name: /Tier 1/ });
    fireEvent.click(tier1Chip);
    expect(window.localStorage.getItem('silentBoom.convictionFloor')).toBe(
      'tier1',
    );
  });

  it('persists the sort mode to localStorage when changed', () => {
    render(<SilentBoomSection marketOpen={false} />);
    // Sort mode "spike ratio" — exact-match on the chip label.
    const sortChip = screen.getByRole('button', { name: /^spike ratio$/ });
    fireEvent.click(sortChip);
    expect(window.localStorage.getItem('silentBoom.sortMode')).toBe(
      'spike_ratio',
    );
  });

  it('persists the vol/OI floor to localStorage when changed', () => {
    render(<SilentBoomSection marketOpen={false} />);
    // Vol/OI floor "≥1.0" — match the chip label.
    const volOiChip = screen.getByRole('button', { name: /^≥1\.0$/ });
    fireEvent.click(volOiChip);
    expect(window.localStorage.getItem('silentBoom.minVolOi')).toBe('1');
  });
});

// ============================================================
// EXIT-POLICY CHIP TOGGLE
// ============================================================

describe('SilentBoomSection: exit-policy chip', () => {
  it('renders all five exit-policy chip labels', () => {
    render(<SilentBoomSection marketOpen={false} />);
    expect(screen.getByRole('button', { name: '30m' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '60m' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '120m' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'eod' })).toBeInTheDocument();
    // 'peak' label exists on both this chip row AND the sort chip row.
    expect(screen.getAllByRole('button', { name: 'peak' })).toHaveLength(2);
  });

  it('flips aria-pressed when an exit-policy chip is clicked', () => {
    render(<SilentBoomSection marketOpen={false} />);
    // Default is realized60mPct → 60m chip starts pressed.
    const sixtyM = screen.getByRole('button', { name: '60m' });
    expect(sixtyM).toHaveAttribute('aria-pressed', 'true');

    const thirtyM = screen.getByRole('button', { name: '30m' });
    expect(thirtyM).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(thirtyM);
    expect(thirtyM).toHaveAttribute('aria-pressed', 'true');
    expect(sixtyM).toHaveAttribute('aria-pressed', 'false');
  });

  it('persists the exit-policy selection to localStorage when changed', () => {
    render(<SilentBoomSection marketOpen={false} />);
    fireEvent.click(screen.getByRole('button', { name: '120m' }));
    expect(window.localStorage.getItem('silentBoom.exitPolicy')).toBe(
      'realized120mPct',
    );
  });

  it('hydrates the active chip from a previously-stored localStorage value', () => {
    window.localStorage.setItem('silentBoom.exitPolicy', 'realized120mPct');
    render(<SilentBoomSection marketOpen={false} />);
    expect(screen.getByRole('button', { name: '120m' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '60m' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('falls back to the realized60mPct default when localStorage holds a garbage value', () => {
    window.localStorage.setItem('silentBoom.exitPolicy', 'not-a-real-policy');
    render(<SilentBoomSection marketOpen={false} />);
    // Type guard rejects the garbage and the initializer keeps 60m active.
    expect(screen.getByRole('button', { name: '60m' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
