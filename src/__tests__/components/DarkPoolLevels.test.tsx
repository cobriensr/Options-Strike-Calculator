import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DarkPoolLevels from '../../components/DarkPoolLevels';
import type { DarkPoolLevel } from '../../hooks/useDarkPoolLevels';

// ── Helpers ───────────────────────────────────────────────

function makeLevel(overrides: Partial<DarkPoolLevel> = {}): DarkPoolLevel {
  return {
    spxLevel: 6575,
    totalPremium: 1_300_000_000,
    tradeCount: 13,
    totalShares: 2_000_000,
    latestTime: '2026-04-02T16:30:00Z',
    updatedAt: '2026-04-02T16:35:00Z',
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
  it('shows no levels message when levels empty', () => {
    render(
      <DarkPoolLevels
        levels={[]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(
      screen.getByText(/no dark pool levels available/i),
    ).toBeInTheDocument();
  });

  it('shows badge with count when levels exist', () => {
    const levels = [
      makeLevel({ totalPremium: 1_000_000 }),
      makeLevel({ spxLevel: 6550, totalPremium: 2_000_000 }),
    ];
    render(
      <DarkPoolLevels
        levels={levels}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    // All levels shown — no premium floor filtering
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
  });
});

// ============================================================
// RENDERING LEVELS
// ============================================================

describe('DarkPoolLevels: rendering levels', () => {
  it('renders levels above threshold', () => {
    const levels = [
      makeLevel({
        spxLevel: 6575,
        totalPremium: 1_300_000_000,
      }),
      makeLevel({
        spxLevel: 6555,
        totalPremium: 248_000_000,
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

  it('respects visible count limit', () => {
    // Default visibleCount is 15 — with 2 levels, both show
    const levels = [
      makeLevel({ spxLevel: 6575, totalPremium: 500_000_000 }),
      makeLevel({ spxLevel: 6540, totalPremium: 1_000_000 }),
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
    expect(screen.getByText('6540')).toBeInTheDocument();
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
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

  it('formats thousands with K suffix', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel({ totalPremium: 750_000 })]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(screen.getByText('$750K')).toBeInTheDocument();
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
      makeLevel({ spxLevel: 6575, totalPremium: 1_000_000_000 }),
      makeLevel({ spxLevel: 6555, totalPremium: 500_000_000 }),
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
      makeLevel({ spxLevel: 6575, totalPremium: 10_000_000_000 }),
      makeLevel({ spxLevel: 6555, totalPremium: 100_000 }),
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
    expect(screen.getByText('Blocks')).toBeInTheDocument();
    expect(screen.getByText('Time')).toBeInTheDocument();
  });

  it('renders rows with role="row"', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel(), makeLevel({ spxLevel: 6550 })]}
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
    expect(screen.queryByText(/of/)).not.toBeInTheDocument();
  });

  it('shows badge with count', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel()]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(screen.getByText('1 of 1')).toBeInTheDocument();
  });
});

// ============================================================
// TIME DISPLAY
// ============================================================

describe('DarkPoolLevels: time display', () => {
  it('shows latest trade time for each level', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel({ latestTime: '2026-04-02T19:30:00Z' })]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    // 19:30 UTC = 2:30 PM CT
    expect(screen.getByText(/2:30/)).toBeInTheDocument();
  });

  it('shows "Updated" with time when updatedAt is provided', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel()]}
        loading={false}
        error={null}
        updatedAt="2026-04-02T19:35:00Z"
      />,
    );
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
  });
});

// ============================================================
// VISIBLE COUNT CONTROL
// ============================================================

describe('DarkPoolLevels: visible count control', () => {
  it('renders +/- buttons', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel()]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    expect(
      screen.getByRole('button', { name: /show fewer/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /show more/i }),
    ).toBeInTheDocument();
  });

  it('shows current visible count', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel()]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    // Default is 15
    expect(screen.getByText('15')).toBeInTheDocument();
  });

  it('disables minus button at minimum', async () => {
    const user = userEvent.setup();
    render(
      <DarkPoolLevels
        levels={[makeLevel()]}
        loading={false}
        error={null}
        updatedAt={null}
      />,
    );
    // Click minus twice: 15 → 10 → 5 (min)
    const minus = screen.getByRole('button', { name: /show fewer/i });
    await user.click(minus);
    await user.click(minus);
    expect(minus).toBeDisabled();
  });
});
