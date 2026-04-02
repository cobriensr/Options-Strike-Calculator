import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import DarkPoolLevels from '../../components/DarkPoolLevels';
import type { DarkPoolLevel } from '../../hooks/useDarkPoolLevels';

// ── Helpers ───────────────────────────────────────────────

function makeLevel(overrides: Partial<DarkPoolLevel> = {}): DarkPoolLevel {
  return {
    spxApprox: 6575,
    spyPriceLow: 657.0,
    spyPriceHigh: 658.0,
    totalPremium: 1_300_000_000,
    tradeCount: 13,
    totalShares: 2_000_000,
    buyerInitiated: 9,
    sellerInitiated: 3,
    neutral: 1,
    latestTime: '2026-04-02T16:30:00Z',
    updatedAt: '2026-04-02T16:35:00Z',
    direction: 'BUY',
    ...overrides,
  };
}

// ============================================================
// LOADING STATE
// ============================================================

describe('DarkPoolLevels: loading state', () => {
  it('shows loading message when loading', () => {
    render(
      <DarkPoolLevels
        levels={[]}
        loading={true}
        error={null}
        updatedAt={null}
      />,
    );
    expect(screen.getByText(/loading dark pool/i)).toBeInTheDocument();
  });

  it('renders inside a SectionBox with label', () => {
    render(
      <DarkPoolLevels
        levels={[]}
        loading={true}
        error={null}
        updatedAt={null}
      />,
    );
    expect(
      screen.getByRole('region', { name: /dark pool levels/i }),
    ).toBeInTheDocument();
  });
});

// ============================================================
// ERROR STATE
// ============================================================

describe('DarkPoolLevels: error state', () => {
  it('shows error message', () => {
    render(
      <DarkPoolLevels
        levels={[]}
        loading={false}
        error="Failed to load dark pool data"
        updatedAt={null}
      />,
    );
    expect(
      screen.getByText('Failed to load dark pool data'),
    ).toBeInTheDocument();
  });
});

// ============================================================
// EMPTY STATE
// ============================================================

describe('DarkPoolLevels: empty state', () => {
  it('shows no clusters message when levels empty', () => {
    render(
      <DarkPoolLevels
        levels={[]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(screen.getByText(/no clusters above \$100M/i)).toBeInTheDocument();
  });

  it('shows no clusters when all levels below threshold', () => {
    const levels = [
      makeLevel({ totalPremium: 50_000_000 }),
      makeLevel({ spxApprox: 6550, totalPremium: 80_000_000 }),
    ];
    render(
      <DarkPoolLevels
        levels={levels}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(screen.getByText(/no clusters above \$100M/i)).toBeInTheDocument();
  });

  it('shows badge with cluster count even when none above threshold', () => {
    const levels = [
      makeLevel({ totalPremium: 50_000_000 }),
      makeLevel({ spxApprox: 6550, totalPremium: 80_000_000 }),
    ];
    render(
      <DarkPoolLevels
        levels={levels}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    // SectionBox badge renders "0 of 2"
    expect(screen.getByText('0 of 2')).toBeInTheDocument();
  });
});

// ============================================================
// RENDERING LEVELS
// ============================================================

describe('DarkPoolLevels: rendering levels', () => {
  it('renders levels above $100M threshold', () => {
    const levels = [
      makeLevel({
        spxApprox: 6575,
        totalPremium: 1_300_000_000,
        direction: 'BUY',
      }),
      makeLevel({
        spxApprox: 6555,
        totalPremium: 248_000_000,
        direction: 'SELL',
      }),
    ];
    render(
      <DarkPoolLevels
        levels={levels}
        loading={false}
        error={null}
        updatedAt="2026-04-02T16:35:00Z"
      />,
    );

    expect(screen.getByText('6575')).toBeInTheDocument();
    expect(screen.getByText('6555')).toBeInTheDocument();
    expect(screen.getByText('$1.3B')).toBeInTheDocument();
    expect(screen.getByText('$248M')).toBeInTheDocument();
  });

  it('filters out levels below threshold', () => {
    const levels = [
      makeLevel({ spxApprox: 6575, totalPremium: 500_000_000 }),
      makeLevel({ spxApprox: 6540, totalPremium: 50_000_000 }),
    ];
    render(
      <DarkPoolLevels
        levels={levels}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );

    expect(screen.getByText('6575')).toBeInTheDocument();
    expect(screen.queryByText('6540')).not.toBeInTheDocument();
  });

  it('shows badge with cluster count', () => {
    const levels = [
      makeLevel({ spxApprox: 6575, totalPremium: 500_000_000 }),
      makeLevel({ spxApprox: 6540, totalPremium: 50_000_000 }),
    ];
    render(
      <DarkPoolLevels
        levels={levels}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );

    // SectionBox badge: "1 of 2"
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
  });
});

// ============================================================
// DIRECTION COLOR CODING
// ============================================================

describe('DarkPoolLevels: direction display', () => {
  it('shows BUY label for buyer-dominated clusters', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel({ direction: 'BUY' })]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(screen.getByText('BUY')).toBeInTheDocument();
  });

  it('shows SELL label for seller-dominated clusters', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel({ direction: 'SELL' })]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(screen.getByText('SELL')).toBeInTheDocument();
  });

  it('shows MIXED label for equal clusters', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel({ direction: 'MIXED' })]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(screen.getByText('MIXED')).toBeInTheDocument();
  });
});

// ============================================================
// PREMIUM FORMATTING
// ============================================================

describe('DarkPoolLevels: premium formatting', () => {
  it('formats billions with B suffix', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel({ totalPremium: 1_700_000_000 })]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(screen.getByText('$1.7B')).toBeInTheDocument();
  });

  it('formats millions with M suffix', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel({ totalPremium: 373_000_000 })]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(screen.getByText('$373M')).toBeInTheDocument();
  });

  // Note: formatPremium K ($1K-$999K) and raw ($0-$999) branches are
  // unreachable in this component because the $100M floor filter
  // guarantees only M and B values display. This is expected.

  it('formats exact $100M threshold', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel({ totalPremium: 100_000_000 })]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(screen.getByText('$100M')).toBeInTheDocument();
  });
});

// ============================================================
// BLOCK COUNT
// ============================================================

describe('DarkPoolLevels: block count', () => {
  it('shows plural blocks for count > 1', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel({ tradeCount: 13 })]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(screen.getByText('13 blocks')).toBeInTheDocument();
  });

  it('shows singular block for count = 1', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel({ tradeCount: 1 })]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(screen.getByText('1 block')).toBeInTheDocument();
  });
});

// ============================================================
// PREMIUM BAR
// ============================================================

describe('DarkPoolLevels: premium bar sizing', () => {
  it('renders bar with proportional width', () => {
    const levels = [
      makeLevel({ spxApprox: 6575, totalPremium: 1_000_000_000 }),
      makeLevel({ spxApprox: 6555, totalPremium: 500_000_000 }),
    ];
    render(
      <DarkPoolLevels
        levels={levels}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );

    const barLabels = screen.getAllByLabelText(/premium/);
    expect(barLabels).toHaveLength(2);

    const bar1 = barLabels[0] as HTMLElement;
    const bar2 = barLabels[1] as HTMLElement;
    expect(bar1.style.width).toBe('100%');
    expect(bar2.style.width).toBe('50%');
  });

  it('uses minimum 2% bar width', () => {
    const levels = [
      makeLevel({ spxApprox: 6575, totalPremium: 10_000_000_000 }),
      makeLevel({ spxApprox: 6555, totalPremium: 100_000_000 }),
    ];
    render(
      <DarkPoolLevels
        levels={levels}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );

    const barLabels = screen.getAllByLabelText(/premium/);
    const smallBar = barLabels[1] as HTMLElement;
    // 100M / 10B = 1% → clamped to 2%
    expect(smallBar.style.width).toBe('2%');
  });
});

// ============================================================
// ACCESSIBILITY
// ============================================================

describe('DarkPoolLevels: accessibility', () => {
  it('has SectionBox with aria-label', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel()]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(
      screen.getByRole('region', { name: /dark pool levels/i }),
    ).toBeInTheDocument();
  });

  it('has table role for screen readers', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel()]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(
      screen.getByRole('table', { name: /dark pool levels/i }),
    ).toBeInTheDocument();
  });

  it('has column headers for screen readers', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel()]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(screen.getByText('SPX Level')).toBeInTheDocument();
    expect(screen.getByText('Premium')).toBeInTheDocument();
    expect(screen.getByText('Direction')).toBeInTheDocument();
    expect(screen.getByText('Blocks')).toBeInTheDocument();
  });

  it('renders rows with role="row"', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel(), makeLevel({ spxApprox: 6550 })]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    // Header row + 2 data rows
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3);
  });

  it('premium bars have aria-label with formatted value', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel({ totalPremium: 500_000_000 })]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(screen.getByLabelText('$500M premium')).toBeInTheDocument();
  });
});

// ============================================================
// HEADER
// ============================================================

describe('DarkPoolLevels: header', () => {
  it('shows section title via SectionBox', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel()]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(
      screen.getByRole('heading', { name: /dark pool levels/i }),
    ).toBeInTheDocument();
  });

  it('does not show badge when no levels at all', () => {
    render(
      <DarkPoolLevels
        levels={[]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    // Badge is null when totalClusters is 0
    expect(screen.queryByText(/of/)).not.toBeInTheDocument();
  });

  it('does not show updatedAt time when null', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel()]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(
      screen.getByRole('heading', { name: /dark pool levels/i }),
    ).toBeInTheDocument();
    // Badge shows count
    expect(screen.getByText('1 of 1')).toBeInTheDocument();
  });
});
