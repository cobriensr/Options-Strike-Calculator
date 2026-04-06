import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import FuturesGrid from '../../components/futures/FuturesGrid';
import type { FuturesSnapshot } from '../../hooks/useFuturesData';

// ── Helpers ───────────────────────────────────────────────

function makeSnapshot(
  overrides: Partial<FuturesSnapshot> = {},
): FuturesSnapshot {
  return {
    symbol: 'ES',
    price: 5450.25,
    change1hPct: 0.15,
    changeDayPct: 0.42,
    volumeRatio: 1.2,
    ...overrides,
  };
}

/** All 7 symbol snapshots with reasonable defaults */
function makeAllSnapshots(
  overrides: Partial<FuturesSnapshot> = {},
): FuturesSnapshot[] {
  return [
    makeSnapshot({ symbol: 'ES', price: 5450.25, ...overrides }),
    makeSnapshot({ symbol: 'NQ', price: 19800.5, ...overrides }),
    makeSnapshot({ symbol: 'VXM1', price: 18.75, ...overrides }),
    makeSnapshot({ symbol: 'VXM2', price: 20.1, ...overrides }),
    makeSnapshot({ symbol: 'ZN', price: 110.234, ...overrides }),
    makeSnapshot({ symbol: 'RTY', price: 2050.0, ...overrides }),
    makeSnapshot({ symbol: 'CL', price: 72.45, ...overrides }),
  ];
}

// ============================================================
// RENDERING — ALL 7 SYMBOLS
// ============================================================

describe('FuturesGrid: renders all symbol cards', () => {
  it('renders all 7 symbol cards with correct labels', () => {
    render(<FuturesGrid snapshots={makeAllSnapshots()} esSpxBasis={null} />);

    expect(screen.getByText('/ES')).toBeInTheDocument();
    expect(screen.getByText('/NQ')).toBeInTheDocument();
    expect(screen.getByText('/VXM F')).toBeInTheDocument();
    expect(screen.getByText('/VXM B')).toBeInTheDocument();
    expect(screen.getByText('/ZN')).toBeInTheDocument();
    expect(screen.getByText('/RTY')).toBeInTheDocument();
    expect(screen.getByText('/CL')).toBeInTheDocument();
  });

  it('renders nothing when snapshots is empty', () => {
    const { container } = render(
      <FuturesGrid snapshots={[]} esSpxBasis={null} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('has a list role with accessible label', () => {
    render(<FuturesGrid snapshots={makeAllSnapshots()} esSpxBasis={null} />);

    expect(
      screen.getByRole('list', { name: 'Futures prices' }),
    ).toBeInTheDocument();
  });

  it('renders 7 listitems', () => {
    render(<FuturesGrid snapshots={makeAllSnapshots()} esSpxBasis={null} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(7);
  });
});

// ============================================================
// PRICE FORMATTING
// ============================================================

describe('FuturesGrid: price formatting', () => {
  it('formats ZN with 3 decimal places', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ symbol: 'ZN', price: 110.234 })]}
        esSpxBasis={null}
      />,
    );
    expect(screen.getByText('110.234')).toBeInTheDocument();
  });

  it('formats CL with 2 decimal places', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ symbol: 'CL', price: 72.4 })]}
        esSpxBasis={null}
      />,
    );
    expect(screen.getByText('72.40')).toBeInTheDocument();
  });

  it('formats VXM with 2 decimal places', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ symbol: 'VXM1', price: 18.7 })]}
        esSpxBasis={null}
      />,
    );
    expect(screen.getByText('18.70')).toBeInTheDocument();
  });

  it('formats ES with locale-aware 2 decimal places', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ symbol: 'ES', price: 5450.25 })]}
        esSpxBasis={null}
      />,
    );
    expect(screen.getByText('5,450.25')).toBeInTheDocument();
  });
});

// ============================================================
// CHANGE COLORS
// ============================================================

describe('FuturesGrid: change colors', () => {
  it('shows green color for positive changes', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ change1hPct: 0.5, changeDayPct: 1.2 })]}
        esSpxBasis={null}
      />,
    );

    const oneHour = screen.getByTitle('1-hour change');
    expect(oneHour.textContent).toBe('1H +0.50%');

    const dayChange = screen.getByTitle('Day change');
    expect(dayChange.textContent).toBe('D +1.20%');
  });

  it('shows red color for negative changes', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ change1hPct: -0.3, changeDayPct: -0.75 })]}
        esSpxBasis={null}
      />,
    );

    const oneHour = screen.getByTitle('1-hour change');
    expect(oneHour.textContent).toBe('1H -0.30%');

    const dayChange = screen.getByTitle('Day change');
    expect(dayChange.textContent).toBe('D -0.75%');
  });

  it('shows dash for null change values', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ change1hPct: null, changeDayPct: null })]}
        esSpxBasis={null}
      />,
    );

    const oneHour = screen.getByTitle('1-hour change');
    expect(oneHour.textContent).toContain('—');

    const dayChange = screen.getByTitle('Day change');
    expect(dayChange.textContent).toContain('—');
  });
});

// ============================================================
// VOLUME BADGE
// ============================================================

describe('FuturesGrid: volume badge', () => {
  it('shows volume ratio when available', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ volumeRatio: 1.2 })]}
        esSpxBasis={null}
      />,
    );

    expect(screen.getByText('1.2x')).toBeInTheDocument();
  });

  it('does not render volume badge when volumeRatio is null', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ volumeRatio: null })]}
        esSpxBasis={null}
      />,
    );

    expect(screen.queryByText(/x$/)).not.toBeInTheDocument();
  });

  it('shows HEAVY label in title for high volume', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ volumeRatio: 2.5 })]}
        esSpxBasis={null}
      />,
    );

    const badge = screen.getByText('2.5x');
    expect(badge).toHaveAttribute('title', 'Volume: 2.5x 20-day avg');
  });

  it('shows volume badge for elevated volume (1.5x-2x)', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ volumeRatio: 1.7 })]}
        esSpxBasis={null}
      />,
    );

    expect(screen.getByText('1.7x')).toBeInTheDocument();
  });
});

// ============================================================
// ES-SPX BASIS ANNOTATION
// ============================================================

describe('FuturesGrid: ES-SPX basis annotation', () => {
  it('shows basis annotation on ES card when esSpxBasis is provided', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ symbol: 'ES' })]}
        esSpxBasis={3.5}
      />,
    );

    expect(screen.getByText('Basis: +3.50 pts')).toBeInTheDocument();
  });

  it('shows negative basis correctly', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ symbol: 'ES' })]}
        esSpxBasis={-2.25}
      />,
    );

    expect(screen.getByText('Basis: -2.25 pts')).toBeInTheDocument();
  });

  it('hides basis annotation when esSpxBasis is null', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ symbol: 'ES' })]}
        esSpxBasis={null}
      />,
    );

    expect(screen.queryByText(/Basis:/)).not.toBeInTheDocument();
  });

  it('does not show basis annotation on non-ES cards', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ symbol: 'NQ' })]}
        esSpxBasis={3.5}
      />,
    );

    expect(screen.queryByText(/Basis:/)).not.toBeInTheDocument();
  });

  it('has correct title attribute on basis element', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ symbol: 'ES' })]}
        esSpxBasis={5.0}
      />,
    );

    expect(screen.getByTitle('ES - SPX fair value basis')).toBeInTheDocument();
  });
});
