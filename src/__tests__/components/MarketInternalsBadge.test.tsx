import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarketInternalsBadge } from '../../components/MarketInternals/MarketInternalsBadge';
import type { InternalBar, InternalSymbol } from '../../types/market-internals';
import type { UseMarketInternalsResult } from '../../hooks/useMarketInternals';

// ── Hook mock ──────────────────────────────────────────────

const mockResult = vi.hoisted(() => ({
  current: null as UseMarketInternalsResult | null,
}));

vi.mock('../../hooks/useMarketInternals', () => ({
  useMarketInternals: () => mockResult.current,
}));

// ── Helpers ────────────────────────────────────────────────

function makeBar(
  symbol: InternalSymbol,
  close: number,
  ts = '2026-04-15T18:00:00Z',
): InternalBar {
  return { ts, symbol, open: close, high: close, low: close, close };
}

function emptyLatest(): Record<InternalSymbol, InternalBar | null> {
  return { $TICK: null, $ADD: null, $VOLD: null, $TRIN: null };
}

function setHook(partial: Partial<UseMarketInternalsResult>): void {
  mockResult.current = {
    bars: [],
    latestBySymbol: emptyLatest(),
    loading: false,
    error: null,
    asOf: '2026-04-15T18:00:00Z',
    ...partial,
  };
}

beforeEach(() => {
  setHook({});
});

// ── Tests ──────────────────────────────────────────────────

describe('MarketInternalsBadge', () => {
  it('renders all four symbol labels', () => {
    setHook({
      latestBySymbol: {
        $TICK: makeBar('$TICK', 100),
        $ADD: makeBar('$ADD', 500),
        $VOLD: makeBar('$VOLD', 250_000_000),
        $TRIN: makeBar('$TRIN', 1.1),
      },
    });
    render(<MarketInternalsBadge marketOpen={true} />);

    expect(screen.getByText('$TICK')).toBeInTheDocument();
    expect(screen.getByText('$ADD')).toBeInTheDocument();
    expect(screen.getByText('$VOLD')).toBeInTheDocument();
    expect(screen.getByText('$TRIN')).toBeInTheDocument();
  });

  it('renders $TICK at +420 with elevated band', () => {
    setHook({
      latestBySymbol: {
        ...emptyLatest(),
        $TICK: makeBar('$TICK', 420),
      },
    });
    render(<MarketInternalsBadge marketOpen={true} />);

    const cell = screen.getByTestId('market-internal-tick');
    expect(cell.getAttribute('data-band')).toBe('elevated');
    expect(cell.className).toMatch(/amber/);
  });

  it('renders $TICK at +650 with extreme band', () => {
    setHook({
      latestBySymbol: {
        ...emptyLatest(),
        $TICK: makeBar('$TICK', 650),
      },
    });
    render(<MarketInternalsBadge marketOpen={true} />);

    const cell = screen.getByTestId('market-internal-tick');
    expect(cell.getAttribute('data-band')).toBe('extreme');
    expect(cell.className).toMatch(/orange/);
  });

  it('renders $TICK at -1050 with blowoff band (negative beyond −1000)', () => {
    setHook({
      latestBySymbol: {
        ...emptyLatest(),
        $TICK: makeBar('$TICK', -1050),
      },
    });
    render(<MarketInternalsBadge marketOpen={true} />);

    const cell = screen.getByTestId('market-internal-tick');
    expect(cell.getAttribute('data-band')).toBe('blowoff');
    expect(cell.className).toMatch(/red/);
  });

  it('renders $TICK at +100 with neutral band', () => {
    setHook({
      latestBySymbol: {
        ...emptyLatest(),
        $TICK: makeBar('$TICK', 100),
      },
    });
    render(<MarketInternalsBadge marketOpen={true} />);

    const cell = screen.getByTestId('market-internal-tick');
    expect(cell.getAttribute('data-band')).toBe('neutral');
    // Neutral uses neutral-* classes, not the band colors.
    expect(cell.className).not.toMatch(/amber|orange|red/);
  });

  it('does not assign a color band to $ADD / $VOLD / $TRIN', () => {
    setHook({
      latestBySymbol: {
        $TICK: makeBar('$TICK', 50),
        $ADD: makeBar('$ADD', 1500),
        $VOLD: makeBar('$VOLD', 500_000_000),
        $TRIN: makeBar('$TRIN', 2.5),
      },
    });
    render(<MarketInternalsBadge marketOpen={true} />);

    expect(
      screen.getByTestId('market-internal-add').getAttribute('data-band'),
    ).toBeNull();
    expect(
      screen.getByTestId('market-internal-vold').getAttribute('data-band'),
    ).toBeNull();
    expect(
      screen.getByTestId('market-internal-trin').getAttribute('data-band'),
    ).toBeNull();
  });

  it('formats $VOLD in compact notation', () => {
    setHook({
      latestBySymbol: {
        ...emptyLatest(),
        $VOLD: makeBar('$VOLD', 250_000_000),
      },
    });
    render(<MarketInternalsBadge marketOpen={true} />);

    const cell = screen.getByTestId('market-internal-vold');
    // Intl.NumberFormat compact → "250M"
    expect(cell.textContent).toMatch(/250M/);
  });

  it('renders $TRIN as a ratio (2-decimal) and $ADD as a signed int', () => {
    setHook({
      latestBySymbol: {
        ...emptyLatest(),
        $ADD: makeBar('$ADD', 1234),
        $TRIN: makeBar('$TRIN', 1.07),
      },
    });
    render(<MarketInternalsBadge marketOpen={true} />);

    expect(screen.getByTestId('market-internal-trin').textContent).toMatch(
      /1\.07/,
    );
    // Signed-int formatter adds a '+' for positives.
    expect(screen.getByTestId('market-internal-add').textContent).toMatch(
      /\+1,?234/,
    );
  });

  it('renders all four placeholder cells in the loading state', () => {
    setHook({ loading: true });
    render(<MarketInternalsBadge marketOpen={true} />);

    // All four cells present with em-dash placeholder.
    expect(screen.getByTestId('market-internal-tick').textContent).toMatch(/—/);
    expect(screen.getByTestId('market-internal-add').textContent).toMatch(/—/);
    expect(screen.getByTestId('market-internal-vold').textContent).toMatch(/—/);
    expect(screen.getByTestId('market-internal-trin').textContent).toMatch(/—/);
  });

  it('renders the error state when no bars have loaded', () => {
    setHook({
      loading: false,
      error: 'Network down',
    });
    render(<MarketInternalsBadge marketOpen={true} />);

    expect(screen.getByTestId('market-internals-error')).toBeInTheDocument();
    expect(screen.getByText(/internals unavailable/i)).toBeInTheDocument();
  });

  it('keeps showing last values outside market hours', () => {
    setHook({
      latestBySymbol: {
        ...emptyLatest(),
        $TICK: makeBar('$TICK', 250),
      },
    });
    render(<MarketInternalsBadge marketOpen={false} />);

    expect(screen.getByTestId('market-internal-tick')).toBeInTheDocument();
    expect(screen.getByText(/after hours/i)).toBeInTheDocument();
  });

  it('applies role="status" and aria-live="polite" for screen readers', () => {
    render(<MarketInternalsBadge marketOpen={true} />);
    const container = screen.getByRole('status', {
      name: /market internals/i,
    });
    expect(container.getAttribute('aria-live')).toBe('polite');
  });
});
