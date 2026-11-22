import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import FuturesGrid from '../../components/FuturesCalculator/FuturesGrid';
import type { FuturesSnapshot } from '../../hooks/useFuturesData';
import {
  genericElementsWithAriaLabel,
  srHintText,
  titledGenericsWithoutHint,
  visibleText,
} from '../helpers/aria';

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

/** All 6 snapshotted symbols with reasonable defaults */
function makeAllSnapshots(
  overrides: Partial<FuturesSnapshot> = {},
): FuturesSnapshot[] {
  return [
    makeSnapshot({ symbol: 'ES', price: 5450.25, ...overrides }),
    makeSnapshot({ symbol: 'NQ', price: 19800.5, ...overrides }),
    makeSnapshot({ symbol: 'ZN', price: 110.234, ...overrides }),
    makeSnapshot({ symbol: 'RTY', price: 2050.0, ...overrides }),
    makeSnapshot({ symbol: 'CL', price: 72.45, ...overrides }),
    makeSnapshot({ symbol: 'GC', price: 2350.1, ...overrides }),
  ];
}

// ============================================================
// RENDERING — ALL 6 SYMBOLS
// ============================================================

describe('FuturesGrid: renders all symbol cards', () => {
  it('renders all 6 symbol cards with correct labels', () => {
    render(<FuturesGrid snapshots={makeAllSnapshots()} esSpxBasis={null} />);

    expect(screen.getByText('/ES')).toBeInTheDocument();
    expect(screen.getByText('/NQ')).toBeInTheDocument();
    expect(screen.getByText('/ZN')).toBeInTheDocument();
    expect(screen.getByText('/RTY')).toBeInTheDocument();
    expect(screen.getByText('/CL')).toBeInTheDocument();
    expect(screen.getByText('/GC')).toBeInTheDocument();
    expect(screen.getByText('Gold')).toBeInTheDocument();
  });

  it('shows each symbol and its name as text, with no aria-label on the bare span', () => {
    const { container } = render(
      <FuturesGrid snapshots={makeAllSnapshots()} esSpxBasis={null} />,
    );

    // The name is already the card's visible subtext, so a hint or a label
    // on the symbol would make a screen reader say it twice.
    const names = [
      ['/ES', 'S&P 500'],
      ['/NQ', 'Nasdaq 100'],
      ['/ZN', '10Y Treasury'],
      ['/RTY', 'Russell 2000'],
      ['/CL', 'Crude Oil'],
      ['/GC', 'Gold'],
    ] as const;
    for (const [symbol, name] of names) {
      expect(screen.getByText(symbol)).not.toHaveAttribute('aria-label');
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(genericElementsWithAriaLabel(container)).toEqual([]);
  });

  it('has no VX or DX labels', () => {
    render(<FuturesGrid snapshots={makeAllSnapshots()} esSpxBasis={null} />);

    expect(screen.queryByText(/\/VX/)).not.toBeInTheDocument();
    expect(screen.queryByText('/DX')).not.toBeInTheDocument();
    expect(screen.queryByText('US Dollar')).not.toBeInTheDocument();
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

  it('renders 6 listitems', () => {
    render(<FuturesGrid snapshots={makeAllSnapshots()} esSpxBasis={null} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(6);
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

  it('formats GC with 2 decimal places and no thousands separator', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ symbol: 'GC', price: 2350.1 })]}
        esSpxBasis={null}
      />,
    );
    expect(screen.getByText('2350.10')).toBeInTheDocument();
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

    // The visible text is pinned exactly, hint left out; the hint is the
    // title's meaning for a screen reader (sites 85 and 86).
    const oneHour = screen.getByTitle('1-hour change');
    expect(visibleText(oneHour)).toBe('1H +0.50%');
    expect(srHintText(oneHour)).toBe('1-hour change');

    const dayChange = screen.getByTitle('Day change');
    expect(visibleText(dayChange)).toBe('D +1.20%');
    expect(srHintText(dayChange)).toBe('day change');
  });

  it('shows red color for negative changes', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ change1hPct: -0.3, changeDayPct: -0.75 })]}
        esSpxBasis={null}
      />,
    );

    const oneHour = screen.getByTitle('1-hour change');
    expect(visibleText(oneHour)).toBe('1H -0.30%');
    expect(srHintText(oneHour)).toBe('1-hour change');

    const dayChange = screen.getByTitle('Day change');
    expect(visibleText(dayChange)).toBe('D -0.75%');
    expect(srHintText(dayChange)).toBe('day change');
  });

  it('shows dash for null change values, and still tells a screen reader which change it is', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ change1hPct: null, changeDayPct: null })]}
        esSpxBasis={null}
      />,
    );

    // Pinned on the visible text: the hint's own " — " separator would
    // satisfy a `toContain('—')` on the whole textContent.
    const oneHour = screen.getByTitle('1-hour change');
    expect(visibleText(oneHour)).toBe('1H —');
    expect(srHintText(oneHour)).toBe('1-hour change');

    const dayChange = screen.getByTitle('Day change');
    expect(visibleText(dayChange)).toBe('D —');
    expect(srHintText(dayChange)).toBe('day change');
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

  it('titles the badge with its ratio and the 20-day average', () => {
    render(
      <FuturesGrid
        snapshots={[makeSnapshot({ volumeRatio: 2.5 })]}
        esSpxBasis={null}
      />,
    );

    const badge = screen.getByText('2.5x');
    expect(badge).toHaveAttribute('title', 'Volume: 2.5x 20-day avg');
  });

  // The HEAVY / ELEVATED level is otherwise only the badge colour, so a
  // screen reader gets it as hidden text (site 84). The NORMAL band (every
  // ratio under 1.5, down to a 0.3x day) names no level: "normal volume"
  // would be wrong at 0.3x, and the ratio the badge shows already says it.
  // The hint never repeats the ratio.
  it.each([
    [2.5, 'heavy volume versus its 20-day average'],
    [2, 'heavy volume versus its 20-day average'],
    [1.7, 'elevated volume versus its 20-day average'],
    [1.5, 'elevated volume versus its 20-day average'],
    [1.49, 'volume versus its 20-day average'],
    [1.2, 'volume versus its 20-day average'],
    [0.3, 'volume versus its 20-day average'],
  ])(
    'tells a screen reader what a %sx ratio means, without repeating the ratio',
    (volumeRatio, hint) => {
      const { container } = render(
        <FuturesGrid
          snapshots={[makeSnapshot({ volumeRatio })]}
          esSpxBasis={null}
        />,
      );

      const badge = screen.getByText(`${volumeRatio.toFixed(1)}x`);
      expect(visibleText(badge)).toBe(`${volumeRatio.toFixed(1)}x`);
      expect(srHintText(badge)).toBe(hint);
      expect(srHintText(badge)).not.toMatch(/normal/i);
      expect(titledGenericsWithoutHint(container)).toEqual([]);
    },
  );

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

  // deriveEsSpxBasis is `es.price - spx` (api/futures/snapshot.ts), with no
  // fair-value adjustment, so the title says "raw basis", not "fair value".
  // The hint is the same meaning without the "(raw basis)" the line's own
  // "Basis:" label already says (site 87).
  it.each([
    [5, 'Basis: +5.00 pts'],
    [-2.25, 'Basis: -2.25 pts'],
  ])(
    'titles a %s basis as the raw ES minus SPX difference and reads that to a screen reader',
    (esSpxBasis, shown) => {
      const { container } = render(
        <FuturesGrid
          snapshots={[makeSnapshot({ symbol: 'ES' })]}
          esSpxBasis={esSpxBasis}
        />,
      );

      const basis = screen.getByTitle('ES price minus SPX (raw basis)');
      expect(visibleText(basis)).toBe(shown);
      expect(srHintText(basis)).toBe('ES price minus SPX');
      expect(screen.queryByTitle(/fair value/i)).not.toBeInTheDocument();
      expect(titledGenericsWithoutHint(container)).toEqual([]);
    },
  );
});

describe('FuturesGrid: every titled element reads to a screen reader', () => {
  it('leaves no titled generic element without a hint on a full grid', () => {
    const { container } = render(
      <FuturesGrid
        snapshots={makeAllSnapshots({ volumeRatio: 2.2 })}
        esSpxBasis={3.2}
      />,
    );

    // 6 cards x (volume badge, 1H change, day change) plus the ES basis.
    expect(container.querySelectorAll('[title]')).toHaveLength(19);
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });
});
