/**
 * PreMarketSignals: the Opening Flow Signal and the 0DTE Pin Setup tile
 * each sit in their own error boundary, so a render error in one leaves
 * the other (and the page) standing.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const { openingFlowImpl, pinTileImpl } = vi.hoisted(() => ({
  openingFlowImpl: vi.fn<() => ReactNode>(),
  pinTileImpl: vi.fn<(props: { marketOpen: boolean }) => ReactNode>(),
}));

vi.mock('../../components/OpeningFlowSignal', () => ({
  OpeningFlowSignal: () => openingFlowImpl(),
}));
vi.mock('../../components/PinSetupTile', () => ({
  default: (props: { marketOpen: boolean }) => pinTileImpl(props),
}));
vi.mock('../../lib/sentry-helpers', () => ({
  captureUnlessAuth: vi.fn(),
}));

import PreMarketSignals from '../../components/PreMarketSignals';

// The boundary logs what it catches; keep the run output readable.
const originalConsoleError = console.error;
afterAll(() => {
  console.error = originalConsoleError;
});

beforeEach(() => {
  console.error = vi.fn();
  openingFlowImpl.mockReset();
  pinTileImpl.mockReset();
  openingFlowImpl.mockImplementation(() => <p>opening flow panel</p>);
  pinTileImpl.mockImplementation(({ marketOpen }) => (
    <p>pin tile, market open: {String(marketOpen)}</p>
  ));
});

describe('PreMarketSignals', () => {
  it('renders both panels in the Pre-Market Signals section', () => {
    render(<PreMarketSignals marketOpen />);

    const section = screen.getByRole('region', { name: 'Pre-Market Signals' });
    expect(section).toHaveTextContent('opening flow panel');
    expect(section).toHaveTextContent('pin tile, market open: true');
  });

  it('keeps the Pin Setup tile when Opening Flow Signal throws', () => {
    openingFlowImpl.mockImplementation(() => {
      throw new TypeError(
        "Cannot read properties of undefined (reading 'SPY')",
      );
    });

    render(<PreMarketSignals marketOpen={false} />);

    expect(
      screen.getByText('Opening Flow Signal failed to render.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('pin tile, market open: false'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('keeps Opening Flow Signal when the Pin Setup tile throws', () => {
    pinTileImpl.mockImplementation(() => {
      throw new TypeError(
        "Cannot read properties of undefined (reading 'replace')",
      );
    });

    render(<PreMarketSignals marketOpen={false} />);

    expect(
      screen.getByText('0DTE Pin Setup failed to render.'),
    ).toBeInTheDocument();
    expect(screen.getByText('opening flow panel')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });
});
