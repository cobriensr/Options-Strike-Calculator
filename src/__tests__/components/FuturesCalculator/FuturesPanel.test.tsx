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
    updatedAt: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  };
  mockUseFuturesData.mockReturnValue({ ...defaults, ...overrides });
}

// ============================================================
// formatUpdatedAt edge branches (line 27 uncovered = catch block)
// ============================================================

describe('FuturesPanel — formatUpdatedAt edge cases', () => {
  it('renders panel when updatedAt is null (guard returns null early)', () => {
    mockState({ updatedAt: null });
    render(<FuturesPanel />);
    // Panel still renders; badge is absent
    expect(screen.getByRole('region', { name: 'Futures' })).toBeInTheDocument();
  });

  it('renders panel when updatedAt is an invalid ISO string (catch fallback)', () => {
    // Triggers the try/catch path where toLocaleTimeString throws or Date is
    // Invalid — the function returns null and no badge is shown.
    mockState({ updatedAt: 'completely-invalid-date-string' });
    render(<FuturesPanel />);
    expect(screen.getByRole('region', { name: 'Futures' })).toBeInTheDocument();
  });

  it('renders panel when updatedAt is a valid ISO string', () => {
    mockState({ updatedAt: '2026-04-02T15:30:00.000Z' });
    render(<FuturesPanel />);
    expect(screen.getByRole('region', { name: 'Futures' })).toBeInTheDocument();
  });

  it('still renders panel structure when updatedAt is an empty string', () => {
    // Empty string is falsy → formatUpdatedAt early-returns null
    mockState({ updatedAt: '' });
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
