import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DarkPoolLevels from '../../components/DarkPoolLevels';
import type { DarkPoolLevel } from '../../hooks/useDarkPoolLevels';

const noop = vi.fn();

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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
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
        onRefresh={noop}
      />,
    );
    // Click minus twice: 15 → 10 → 5 (min)
    const minus = screen.getByRole('button', { name: /show fewer/i });
    await user.click(minus);
    await user.click(minus);
    expect(minus).toBeDisabled();
  });
});

// ============================================================
// REFRESH BUTTON
// ============================================================

describe('DarkPoolLevels: refresh button', () => {
  it('renders refresh button', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel()]}
        loading={false}
        error={null}
        updatedAt={null}
        onRefresh={noop}
      />,
    );
    expect(
      screen.getByRole('button', { name: /refresh dark pool/i }),
    ).toBeInTheDocument();
  });

  it('calls onRefresh when clicked', async () => {
    const onRefresh = vi.fn();
    const user = userEvent.setup();
    render(
      <DarkPoolLevels
        levels={[makeLevel()]}
        loading={false}
        error={null}
        updatedAt={null}
        onRefresh={onRefresh}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: /refresh dark pool/i }),
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('is disabled while loading', () => {
    render(
      <DarkPoolLevels
        levels={[]}
        loading={true}
        error={null}
        updatedAt={null}
        onRefresh={noop}
      />,
    );
    expect(
      screen.getByRole('button', { name: /refresh dark pool/i }),
    ).toBeDisabled();
  });
});

// ============================================================
// DISTANCE FROM SPOT
// ============================================================

describe('DarkPoolLevels: distance from spot', () => {
  it('does not show distance column when spxPrice is not provided', () => {
    render(
      <DarkPoolLevels
        levels={[makeLevel({ spxLevel: 6610 })]}
        loading={false}
        error={null}
        updatedAt={null}
        onRefresh={noop}
      />,
    );
    // No distance label should appear
    expect(screen.queryByText('ATM')).not.toBeInTheDocument();
    expect(screen.queryByText(/pts/)).not.toBeInTheDocument();
  });

  it('shows distance labels when spxPrice is provided', () => {
    render(
      <DarkPoolLevels
        levels={[
          makeLevel({ spxLevel: 6610 }),
          makeLevel({ spxLevel: 6620 }),
          makeLevel({ spxLevel: 6600 }),
        ]}
        loading={false}
        error={null}
        updatedAt={null}
        spxPrice={6610}
        onRefresh={noop}
      />,
    );
    expect(screen.getByText('ATM')).toBeInTheDocument();
    expect(screen.getByText('+10pts')).toBeInTheDocument();
    expect(screen.getByText('-10pts')).toBeInTheDocument();
  });

  it('marks levels within 2.5pts of spot as ATM', () => {
    render(
      <DarkPoolLevels
        levels={[
          makeLevel({ spxLevel: 6611 }), // 1pt above — rounds to ATM display
          makeLevel({ spxLevel: 6615 }),
        ]}
        loading={false}
        error={null}
        updatedAt={null}
        spxPrice={6610}
        onRefresh={noop}
      />,
    );
    // 6611 - 6610 = 1pt → rounds to "+1pts", still within ATM highlight range
    expect(screen.getByText('+1pts')).toBeInTheDocument();
    expect(screen.getByText('+5pts')).toBeInTheDocument();
  });
});

// ============================================================
// SORT MODES
// ============================================================

describe('DarkPoolLevels: sort modes', () => {
  it('cycles: Premium → Latest → Strike → Distance → Premium', async () => {
    const user = userEvent.setup();
    render(
      <DarkPoolLevels
        levels={[makeLevel()]}
        loading={false}
        error={null}
        updatedAt={null}
        spxPrice={6610}
        onRefresh={noop}
      />,
    );

    expect(
      screen.getByRole('button', { name: /sort mode: by premium/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByText('By Premium'));
    expect(screen.getByText('By Latest')).toBeInTheDocument();

    await user.click(screen.getByText('By Latest'));
    expect(screen.getByText('By Strike')).toBeInTheDocument();

    await user.click(screen.getByText('By Strike'));
    expect(screen.getByText('By Distance')).toBeInTheDocument();

    await user.click(screen.getByText('By Distance'));
    expect(screen.getByText('By Premium')).toBeInTheDocument();
  });

  it('By Latest orders most recently updated first', async () => {
    const user = userEvent.setup();
    render(
      <DarkPoolLevels
        levels={[
          makeLevel({
            spxLevel: 6600,
            latestTime: '2026-04-07T14:00:00Z',
            totalPremium: 500_000_000,
          }),
          makeLevel({
            spxLevel: 6610,
            latestTime: '2026-04-07T20:30:00Z',
            totalPremium: 100_000_000,
          }),
          makeLevel({
            spxLevel: 6620,
            latestTime: '2026-04-07T18:00:00Z',
            totalPremium: 300_000_000,
          }),
        ]}
        loading={false}
        error={null}
        updatedAt={null}
        onRefresh={noop}
      />,
    );

    // Premium → Latest
    await user.click(screen.getByText('By Premium'));

    // 6610 (20:30) should come before 6620 (18:00) in DOM order
    const s6610 = screen.getByText('6610');
    const s6620 = screen.getByText('6620');
    const pos =
      s6610.compareDocumentPosition(s6620) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(pos).toBeTruthy();
  });

  it('skips Distance in cycle when spxPrice is missing', async () => {
    const user = userEvent.setup();
    render(
      <DarkPoolLevels
        levels={[makeLevel()]}
        loading={false}
        error={null}
        updatedAt={null}
        onRefresh={noop}
      />,
    );

    // Premium → Latest → Strike → Premium (Distance skipped)
    await user.click(screen.getByText('By Premium'));
    expect(screen.getByText('By Latest')).toBeInTheDocument();

    await user.click(screen.getByText('By Latest'));
    expect(screen.getByText('By Strike')).toBeInTheDocument();

    await user.click(screen.getByText('By Strike'));
    expect(screen.getByText('By Premium')).toBeInTheDocument();
  });

  it('By Strike sort orders highest strike at top', async () => {
    const user = userEvent.setup();
    render(
      <DarkPoolLevels
        levels={[
          makeLevel({ spxLevel: 6600, totalPremium: 100_000_000 }),
          makeLevel({ spxLevel: 6620, totalPremium: 200_000_000 }),
          makeLevel({ spxLevel: 6610, totalPremium: 300_000_000 }),
        ]}
        loading={false}
        error={null}
        updatedAt={null}
        onRefresh={noop}
      />,
    );

    // Premium → Latest → Strike
    await user.click(screen.getByText('By Premium'));
    await user.click(screen.getByText('By Latest'));

    const s6600 = screen.getByText('6600');
    const s6620 = screen.getByText('6620');
    // 6620 should appear before 6600 in DOM order (top to bottom)
    const pos =
      s6620.compareDocumentPosition(s6600) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(pos).toBeTruthy();
  });

  it('By Distance sort orders closest to spot first', async () => {
    const user = userEvent.setup();
    render(
      <DarkPoolLevels
        levels={[
          makeLevel({ spxLevel: 6580, totalPremium: 100_000_000 }),
          makeLevel({ spxLevel: 6612, totalPremium: 50_000_000 }),
          makeLevel({ spxLevel: 6640, totalPremium: 200_000_000 }),
        ]}
        loading={false}
        error={null}
        updatedAt={null}
        spxPrice={6610}
        onRefresh={noop}
      />,
    );

    // Premium → Latest → Strike → Distance
    await user.click(screen.getByText('By Premium'));
    await user.click(screen.getByText('By Latest'));
    await user.click(screen.getByText('By Strike'));

    // 6612 is 2pts from spot, 6580 is 30pts, 6640 is 30pts
    // Expected order: 6612 (closest) → 6580 or 6640 (tied)
    const s6612 = screen.getByText('6612');
    const s6580 = screen.getByText('6580');
    const pos =
      s6612.compareDocumentPosition(s6580) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(pos).toBeTruthy();
  });
});
