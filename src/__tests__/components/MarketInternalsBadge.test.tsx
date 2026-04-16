import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarketInternalsBadge } from '../../components/MarketInternals/MarketInternalsBadge';
import type { InternalBar, InternalSymbol } from '../../types/market-internals';

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

const defaultProps = {
  latestBySymbol: emptyLatest(),
  loading: false,
  error: null,
  asOf: '2026-04-15T18:00:00Z',
  marketOpen: true,
};

// ── Tests ──────────────────────────────────────────────────

describe('MarketInternalsBadge', () => {
  it('renders all four symbol labels', () => {
    render(
      <MarketInternalsBadge
        {...defaultProps}
        latestBySymbol={{
          $TICK: makeBar('$TICK', 100),
          $ADD: makeBar('$ADD', 500),
          $VOLD: makeBar('$VOLD', 250_000_000),
          $TRIN: makeBar('$TRIN', 1.1),
        }}
      />,
    );

    expect(screen.getByText('$TICK')).toBeInTheDocument();
    expect(screen.getByText('$ADD')).toBeInTheDocument();
    expect(screen.getByText('$VOLD')).toBeInTheDocument();
    expect(screen.getByText('$TRIN')).toBeInTheDocument();
  });

  it('renders $TICK at +420 with elevated band', () => {
    render(
      <MarketInternalsBadge
        {...defaultProps}
        latestBySymbol={{
          ...emptyLatest(),
          $TICK: makeBar('$TICK', 420),
        }}
      />,
    );

    const cell = screen.getByTestId('market-internal-tick');
    expect(cell.getAttribute('data-band')).toBe('elevated');
    expect(cell.className).toMatch(/amber/);
  });

  it('renders $TICK at +650 with extreme band', () => {
    render(
      <MarketInternalsBadge
        {...defaultProps}
        latestBySymbol={{
          ...emptyLatest(),
          $TICK: makeBar('$TICK', 650),
        }}
      />,
    );

    const cell = screen.getByTestId('market-internal-tick');
    expect(cell.getAttribute('data-band')).toBe('extreme');
    expect(cell.className).toMatch(/orange/);
  });

  it('renders $TICK at -1050 with blowoff band (negative beyond -1000)', () => {
    render(
      <MarketInternalsBadge
        {...defaultProps}
        latestBySymbol={{
          ...emptyLatest(),
          $TICK: makeBar('$TICK', -1050),
        }}
      />,
    );

    const cell = screen.getByTestId('market-internal-tick');
    expect(cell.getAttribute('data-band')).toBe('blowoff');
    expect(cell.className).toMatch(/red/);
  });

  it('renders $TICK at +100 with neutral band', () => {
    render(
      <MarketInternalsBadge
        {...defaultProps}
        latestBySymbol={{
          ...emptyLatest(),
          $TICK: makeBar('$TICK', 100),
        }}
      />,
    );

    const cell = screen.getByTestId('market-internal-tick');
    expect(cell.getAttribute('data-band')).toBe('neutral');
    // Neutral uses neutral-* classes, not the band colors.
    expect(cell.className).not.toMatch(/amber|orange|red/);
  });

  it('does not assign a color band to $ADD / $VOLD / $TRIN', () => {
    render(
      <MarketInternalsBadge
        {...defaultProps}
        latestBySymbol={{
          $TICK: makeBar('$TICK', 50),
          $ADD: makeBar('$ADD', 1500),
          $VOLD: makeBar('$VOLD', 500_000_000),
          $TRIN: makeBar('$TRIN', 2.5),
        }}
      />,
    );

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
    render(
      <MarketInternalsBadge
        {...defaultProps}
        latestBySymbol={{
          ...emptyLatest(),
          $VOLD: makeBar('$VOLD', 250_000_000),
        }}
      />,
    );

    const cell = screen.getByTestId('market-internal-vold');
    // Intl.NumberFormat compact -> "250M"
    expect(cell.textContent).toMatch(/250M/);
  });

  it('renders $TRIN as a ratio (2-decimal) and $ADD as a signed int', () => {
    render(
      <MarketInternalsBadge
        {...defaultProps}
        latestBySymbol={{
          ...emptyLatest(),
          $ADD: makeBar('$ADD', 1234),
          $TRIN: makeBar('$TRIN', 1.07),
        }}
      />,
    );

    expect(screen.getByTestId('market-internal-trin').textContent).toMatch(
      /1\.07/,
    );
    // Signed-int formatter adds a '+' for positives.
    expect(screen.getByTestId('market-internal-add').textContent).toMatch(
      /\+1,?234/,
    );
  });

  it('renders all four placeholder cells in the loading state', () => {
    render(<MarketInternalsBadge {...defaultProps} loading={true} />);

    // All four cells present with em-dash placeholder.
    expect(screen.getByTestId('market-internal-tick').textContent).toMatch(
      /\u2014/,
    );
    expect(screen.getByTestId('market-internal-add').textContent).toMatch(
      /\u2014/,
    );
    expect(screen.getByTestId('market-internal-vold').textContent).toMatch(
      /\u2014/,
    );
    expect(screen.getByTestId('market-internal-trin').textContent).toMatch(
      /\u2014/,
    );
  });

  it('renders the error state when no bars have loaded', () => {
    render(<MarketInternalsBadge {...defaultProps} error="Network down" />);

    expect(screen.getByTestId('market-internals-error')).toBeInTheDocument();
    expect(screen.getByText(/internals unavailable/i)).toBeInTheDocument();
  });

  it('keeps showing last values outside market hours', () => {
    render(
      <MarketInternalsBadge
        {...defaultProps}
        marketOpen={false}
        latestBySymbol={{
          ...emptyLatest(),
          $TICK: makeBar('$TICK', 250),
        }}
      />,
    );

    expect(screen.getByTestId('market-internal-tick')).toBeInTheDocument();
    expect(screen.getByText(/after hours/i)).toBeInTheDocument();
  });

  it('applies role="status" and aria-live="polite" for screen readers', () => {
    render(<MarketInternalsBadge {...defaultProps} />);
    const container = screen.getByRole('status', {
      name: /market internals/i,
    });
    expect(container.getAttribute('aria-live')).toBe('polite');
  });
});
