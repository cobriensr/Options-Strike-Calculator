import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import VixTermStructure from '../../components/futures/VixTermStructure';
import type { FuturesSnapshot } from '../../hooks/useFuturesData';

// ── Helpers ───────────────────────────────────────────────

function makeSnapshot(
  overrides: Partial<FuturesSnapshot> = {},
): FuturesSnapshot {
  return {
    symbol: 'VXM1',
    price: 18.75,
    change1hPct: null,
    changeDayPct: -1.5,
    volumeRatio: null,
    ...overrides,
  };
}

function frontMonth(overrides: Partial<FuturesSnapshot> = {}): FuturesSnapshot {
  return makeSnapshot({ symbol: 'VXM1', price: 18.75, ...overrides });
}

function backMonth(overrides: Partial<FuturesSnapshot> = {}): FuturesSnapshot {
  return makeSnapshot({ symbol: 'VXM2', price: 20.1, ...overrides });
}

// ============================================================
// RENDERING — FRONT AND BACK MONTH
// ============================================================

describe('VixTermStructure (futures): front and back month', () => {
  it('renders front month price', () => {
    render(
      <VixTermStructure
        snapshots={[frontMonth(), backMonth()]}
        vxTermSpread={-1.35}
        vxTermStructure="CONTANGO"
      />,
    );

    expect(screen.getByText('18.75')).toBeInTheDocument();
    expect(screen.getByText('Front')).toBeInTheDocument();
  });

  it('renders back month price', () => {
    render(
      <VixTermStructure
        snapshots={[frontMonth(), backMonth()]}
        vxTermSpread={-1.35}
        vxTermStructure="CONTANGO"
      />,
    );

    expect(screen.getByText('20.10')).toBeInTheDocument();
    expect(screen.getByText('Back')).toBeInTheDocument();
  });

  it('shows N/A when front month is missing', () => {
    render(
      <VixTermStructure
        snapshots={[backMonth()]}
        vxTermSpread={null}
        vxTermStructure="CONTANGO"
      />,
    );

    const naElements = screen.getAllByText('N/A');
    expect(naElements.length).toBeGreaterThanOrEqual(1);
  });

  it('shows N/A when back month is missing', () => {
    render(
      <VixTermStructure
        snapshots={[frontMonth()]}
        vxTermSpread={null}
        vxTermStructure="CONTANGO"
      />,
    );

    const naElements = screen.getAllByText('N/A');
    expect(naElements.length).toBeGreaterThanOrEqual(1);
  });

  it('renders nothing when no snapshots and no structure', () => {
    const { container } = render(
      <VixTermStructure
        snapshots={[]}
        vxTermSpread={null}
        vxTermStructure={null}
      />,
    );

    expect(container.innerHTML).toBe('');
  });
});

// ============================================================
// TERM STRUCTURE BADGES
// ============================================================

describe('VixTermStructure (futures): structure badges', () => {
  it('shows CONTANGO badge', () => {
    render(
      <VixTermStructure
        snapshots={[frontMonth(), backMonth()]}
        vxTermSpread={-1.35}
        vxTermStructure="CONTANGO"
      />,
    );

    expect(screen.getByText('CONTANGO')).toBeInTheDocument();
  });

  it('shows BACKWARDATION badge', () => {
    render(
      <VixTermStructure
        snapshots={[frontMonth({ price: 22.0 }), backMonth({ price: 20.0 })]}
        vxTermSpread={2.0}
        vxTermStructure="BACKWARDATION"
      />,
    );

    expect(screen.getByText('BACKWARDATION')).toBeInTheDocument();
  });

  it('shows FLAT badge', () => {
    render(
      <VixTermStructure
        snapshots={[frontMonth({ price: 20.0 }), backMonth({ price: 20.05 })]}
        vxTermSpread={-0.05}
        vxTermStructure="FLAT"
      />,
    );

    expect(screen.getByText('FLAT')).toBeInTheDocument();
  });

  it('does not show structure badge when vxTermStructure is null', () => {
    render(
      <VixTermStructure
        snapshots={[frontMonth()]}
        vxTermSpread={null}
        vxTermStructure={null}
      />,
    );

    expect(screen.queryByText('CONTANGO')).not.toBeInTheDocument();
    expect(screen.queryByText('BACKWARDATION')).not.toBeInTheDocument();
    expect(screen.queryByText('FLAT')).not.toBeInTheDocument();
  });
});

// ============================================================
// SPREAD VALUE
// ============================================================

describe('VixTermStructure (futures): spread value', () => {
  it('shows negative spread in contango', () => {
    render(
      <VixTermStructure
        snapshots={[frontMonth(), backMonth()]}
        vxTermSpread={-1.35}
        vxTermStructure="CONTANGO"
      />,
    );

    expect(screen.getByText('-1.35')).toBeInTheDocument();
    expect(screen.getByText('Spread')).toBeInTheDocument();
  });

  it('shows positive spread in backwardation', () => {
    render(
      <VixTermStructure
        snapshots={[frontMonth({ price: 22.0 }), backMonth({ price: 20.0 })]}
        vxTermSpread={2.0}
        vxTermStructure="BACKWARDATION"
      />,
    );

    expect(screen.getByText('+2.00')).toBeInTheDocument();
  });

  it('shows N/A for spread when vxTermSpread is null', () => {
    render(
      <VixTermStructure
        snapshots={[frontMonth()]}
        vxTermSpread={null}
        vxTermStructure={null}
      />,
    );

    // At least one N/A from spread column (and possibly from missing back month)
    const naElements = screen.getAllByText('N/A');
    expect(naElements.length).toBeGreaterThanOrEqual(1);
  });

  it('shows spread label pts (front - back)', () => {
    render(
      <VixTermStructure
        snapshots={[frontMonth(), backMonth()]}
        vxTermSpread={-1.35}
        vxTermStructure="CONTANGO"
      />,
    );

    expect(screen.getByText('pts (front - back)')).toBeInTheDocument();
  });
});

// ============================================================
// CHANGE PERCENTAGES
// ============================================================

describe('VixTermStructure (futures): change percentages', () => {
  it('shows day change percentage for front month', () => {
    render(
      <VixTermStructure
        snapshots={[
          frontMonth({ changeDayPct: -1.5 }),
          backMonth({ changeDayPct: -0.8 }),
        ]}
        vxTermSpread={-1.35}
        vxTermStructure="CONTANGO"
      />,
    );

    expect(screen.getByText('-1.50%')).toBeInTheDocument();
    expect(screen.getByText('-0.80%')).toBeInTheDocument();
  });

  it('shows positive change with + sign', () => {
    render(
      <VixTermStructure
        snapshots={[
          frontMonth({ changeDayPct: 2.3 }),
          backMonth({ changeDayPct: 1.1 }),
        ]}
        vxTermSpread={-1.35}
        vxTermStructure="CONTANGO"
      />,
    );

    expect(screen.getByText('+2.30%')).toBeInTheDocument();
    expect(screen.getByText('+1.10%')).toBeInTheDocument();
  });

  it('does not show change percentage when changeDayPct is null', () => {
    render(
      <VixTermStructure
        snapshots={[
          frontMonth({ changeDayPct: null }),
          backMonth({ changeDayPct: null }),
        ]}
        vxTermSpread={-1.35}
        vxTermStructure="CONTANGO"
      />,
    );

    // No percentage text should appear
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });
});

// ============================================================
// ACCESSIBILITY
// ============================================================

describe('VixTermStructure (futures): accessibility', () => {
  it('has role=status with accessible label', () => {
    render(
      <VixTermStructure
        snapshots={[frontMonth(), backMonth()]}
        vxTermSpread={-1.35}
        vxTermStructure="CONTANGO"
      />,
    );

    expect(
      screen.getByRole('status', { name: 'VIX term structure' }),
    ).toBeInTheDocument();
  });

  it('shows VIX Term Structure heading text', () => {
    render(
      <VixTermStructure
        snapshots={[frontMonth(), backMonth()]}
        vxTermSpread={-1.35}
        vxTermStructure="CONTANGO"
      />,
    );

    expect(screen.getByText('VIX Term Structure')).toBeInTheDocument();
  });
});
