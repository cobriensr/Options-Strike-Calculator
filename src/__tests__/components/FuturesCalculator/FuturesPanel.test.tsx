import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import FuturesPanel from '../../../components/FuturesCalculator/FuturesPanel';
import type { FuturesDataState } from '../../../hooks/useFuturesData';
import { useFuturesData } from '../../../hooks/useFuturesData';

vi.mock('../../../hooks/useFuturesData', () => ({
  useFuturesData: vi.fn(),
}));

const mockUseFuturesData = vi.mocked(useFuturesData);

function mockState(overrides: Partial<FuturesDataState> = {}) {
  const defaults: FuturesDataState = {
    snapshots: [],
    vxTermSpread: null,
    vxTermStructure: null,
    esSpxBasis: null,
    fetchedAt: null,
    oldestTs: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  };
  mockUseFuturesData.mockReturnValue({ ...defaults, ...overrides });
}

// ============================================================
// formatFetchedAt edge branches — epoch ms input
// ============================================================

describe('FuturesPanel — formatFetchedAt edge cases', () => {
  it('renders panel when fetchedAt is null (guard returns null early)', () => {
    mockState({ fetchedAt: null });
    render(<FuturesPanel />);
    // Panel still renders; badge is absent
    expect(screen.getByRole('region', { name: 'Futures' })).toBeInTheDocument();
  });

  it('renders panel when fetchedAt is non-finite (NaN)', () => {
    // Non-finite numbers fail the Number.isFinite guard — no badge shown.
    mockState({ fetchedAt: Number.NaN });
    render(<FuturesPanel />);
    expect(screen.getByRole('region', { name: 'Futures' })).toBeInTheDocument();
  });

  it('renders panel when fetchedAt is a valid epoch ms', () => {
    mockState({ fetchedAt: Date.parse('2026-04-02T15:30:00.000Z') });
    render(<FuturesPanel />);
    expect(screen.getByRole('region', { name: 'Futures' })).toBeInTheDocument();
  });

  it('renders panel when fetchedAt is Infinity (non-finite branch)', () => {
    // Both NaN and ±Infinity should fail Number.isFinite identically.
    mockState({ fetchedAt: Number.POSITIVE_INFINITY });
    render(<FuturesPanel />);
    expect(screen.getByRole('region', { name: 'Futures' })).toBeInTheDocument();
  });
});

// ============================================================
// FuturesCalculator always renders (no data dependency)
// ============================================================

describe('FuturesPanel — P&L Calculator', () => {
  it('renders the FuturesCalculator regardless of data state (loading)', () => {
    mockState({ loading: true, snapshots: [] });
    render(<FuturesPanel />);
    expect(
      screen.getByRole('region', { name: 'Futures day-trade P&L calculator' }),
    ).toBeInTheDocument();
  });

  it('renders the FuturesCalculator when snapshots empty and not loading', () => {
    mockState({ loading: false, snapshots: [] });
    render(<FuturesPanel />);
    expect(
      screen.getByRole('region', { name: 'Futures day-trade P&L calculator' }),
    ).toBeInTheDocument();
  });

  it('renders the FuturesCalculator anchor span for scroll-to navigation', () => {
    mockState();
    const { container } = render(<FuturesPanel />);
    const anchor = container.querySelector('#sec-futures-calc');
    expect(anchor).toBeInTheDocument();
  });
});
