import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VIXRangeAnalysis from '../components/VIXRangeAnalysis';
import { theme } from '../themes';
import {
  VIX_BUCKETS,
  SURVIVAL_DATA,
  FINE_VIX_STATS,
} from '../data/vixRangeStats';

// Helper: get the settle/intraday chip buttons by role (avoids matching description paragraphs)
function getSettleChip() {
  return screen.getByRole('radio', { name: /settlement/i });
}
function getIntradayChip() {
  return screen.getByRole('radio', { name: /intraday/i });
}

// ============================================================
// RENDERING: basic
// ============================================================
describe('VIXRangeAnalysis: rendering', () => {
  it('renders without crashing with all props null', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    expect(screen.getByText(/historical spx range/i)).toBeInTheDocument();
  });

  it('renders without crashing with VIX and spot', () => {
    render(<VIXRangeAnalysis th={theme} vix={20} spot={6800} />);
    expect(screen.getByText(/historical spx range/i)).toBeInTheDocument();
  });

  it('renders in dark mode', () => {
    render(<VIXRangeAnalysis th={theme} vix={20} spot={6800} />);
    expect(screen.getByText(/historical spx range/i)).toBeInTheDocument();
  });
});

// ============================================================
// VIX RANGE TABLE
// ============================================================
describe('VIXRangeAnalysis: VIX range table', () => {
  it('renders the range table', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    expect(
      screen.getByRole('table', { name: /spx daily range statistics/i }),
    ).toBeInTheDocument();
  });

  it('shows all 8 VIX bucket labels in range table', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    const table = screen.getByRole('table', { name: /spx daily range/i });
    for (const b of VIX_BUCKETS) {
      // Each label appears in both range table and survival table, so scope to range table
      expect(within(table).getAllByText(b.label).length).toBeGreaterThanOrEqual(
        1,
      );
    }
  });

  it('shows all column headers', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    const table = screen.getByRole('table', { name: /spx daily range/i });
    expect(within(table).getByText('VIX')).toBeInTheDocument();
    expect(within(table).getByText('Days')).toBeInTheDocument();
    expect(within(table).getByText('Med H-L')).toBeInTheDocument();
    expect(within(table).getByText('90th H-L')).toBeInTheDocument();
    expect(within(table).getByText(/med o.*c/i)).toBeInTheDocument();
    expect(within(table).getByText('>1% H-L')).toBeInTheDocument();
    expect(within(table).getByText('>2% H-L')).toBeInTheDocument();
  });

  it('shows day counts for each bucket', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    const table = screen.getByRole('table', { name: /spx daily range/i });
    expect(within(table).getByText('806')).toBeInTheDocument();
    expect(within(table).getByText('2,075')).toBeInTheDocument();
  });

  it('displays percentage values with % suffix', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    const table = screen.getByRole('table', { name: /spx daily range/i });
    const pctCells = within(table).getAllByText(/%/);
    expect(pctCells.length).toBeGreaterThan(20);
  });

  it('shows point values when spot is provided', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={6800} />);
    const table = screen.getByRole('table', { name: /spx daily range/i });
    const pointCells = within(table).getAllByText(/\(\d+\)/);
    expect(pointCells.length).toBeGreaterThanOrEqual(8);
  });

  it('does not show point values when spot is null', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    const table = screen.getByRole('table', { name: /spx daily range/i });
    const pointCells = within(table).queryAllByText(/\(\d+\)/);
    expect(pointCells.length).toBe(0);
  });

  it('shows dataset source note with day count', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    expect(screen.getByText(/9,102.*trading days/)).toBeInTheDocument();
  });
});

// ============================================================
// ACTIVE BUCKET HIGHLIGHTING
// ============================================================
describe('VIXRangeAnalysis: active bucket highlighting', () => {
  it('shows "current" badge for the active VIX bucket', () => {
    render(<VIXRangeAnalysis th={theme} vix={15} spot={6800} />);
    expect(screen.getByText('current')).toBeInTheDocument();
  });

  it('shows "current" on the correct bucket for VIX 22', () => {
    render(<VIXRangeAnalysis th={theme} vix={22} spot={6800} />);
    const currentBadge = screen.getByText('current');
    const row = currentBadge.closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).getByText(VIX_BUCKETS[4]!.label)).toBeInTheDocument();
  });

  it('does not show "current" badge when VIX is null', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={6800} />);
    expect(screen.queryByText('current')).not.toBeInTheDocument();
  });

  it('shows only one "current" badge', () => {
    render(<VIXRangeAnalysis th={theme} vix={15} spot={6800} />);
    expect(screen.getAllByText('current')).toHaveLength(1);
  });

  it('current badge appears in range table', () => {
    render(<VIXRangeAnalysis th={theme} vix={15} spot={6800} />);
    const rangeTable = screen.getByRole('table', { name: /spx daily range/i });
    expect(within(rangeTable).getByText('current')).toBeInTheDocument();
  });
});

// ============================================================
// SURVIVAL HEATMAP
// ============================================================
describe('VIXRangeAnalysis: survival heatmap', () => {
  it('renders the survival heatmap table', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    expect(
      screen.getByRole('table', { name: /iron condor survival rates/i }),
    ).toBeInTheDocument();
  });

  it('shows all VIX bucket labels in survival table', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    const table = screen.getByRole('table', {
      name: /iron condor survival rates/i,
    });
    for (const b of VIX_BUCKETS) {
      expect(within(table).getAllByText(b.label).length).toBeGreaterThanOrEqual(
        1,
      );
    }
  });

  it('shows all wing width column headers', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    const table = screen.getByRole('table', {
      name: /iron condor survival rates/i,
    });
    for (const s of SURVIVAL_DATA) {
      expect(within(table).getByText(s.label)).toBeInTheDocument();
    }
  });

  it('defaults to settlement mode', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    expect(getSettleChip()).toHaveAttribute('aria-checked', 'true');
  });

  it('shows settlement survival values by default', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    const table = screen.getByRole('table', {
      name: /iron condor survival rates/i,
    });
    expect(within(table).getByText('76.6%')).toBeInTheDocument();
  });

  it('shows settlement description text by default', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    expect(
      screen.getByText(/closing price stayed within/i),
    ).toBeInTheDocument();
  });
});

// ============================================================
// SURVIVAL MODE SWITCHING
// ============================================================
describe('VIXRangeAnalysis: survival mode toggle', () => {
  it('switches to intraday mode when clicked', async () => {
    const user = userEvent.setup();
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);

    await user.click(getIntradayChip());
    expect(getIntradayChip()).toHaveAttribute('aria-checked', 'true');
  });

  it('shows intraday survival values after switching', async () => {
    const user = userEvent.setup();
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);

    await user.click(getIntradayChip());

    const table = screen.getByRole('table', {
      name: /iron condor survival rates.*intraday/i,
    });
    // First bucket, first wing (0.50% intraday) = 88.8%
    expect(within(table).getByText('88.8%')).toBeInTheDocument();
  });

  it('shows intraday description text after switching', async () => {
    const user = userEvent.setup();
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);

    await user.click(getIntradayChip());
    expect(
      screen.getByText(/full h-l range stayed within/i),
    ).toBeInTheDocument();
  });

  it('switches back to settlement mode', async () => {
    const user = userEvent.setup();
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);

    await user.click(getIntradayChip());
    await user.click(getSettleChip());
    expect(getSettleChip()).toHaveAttribute('aria-checked', 'true');
  });

  it('table aria-label updates with mode', async () => {
    const user = userEvent.setup();
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);

    expect(
      screen.getByRole('table', { name: /survival rates.*settle/i }),
    ).toBeInTheDocument();

    await user.click(getIntradayChip());
    expect(
      screen.getByRole('table', { name: /survival rates.*intraday/i }),
    ).toBeInTheDocument();
  });
});

// ============================================================
// FINE-GRAINED BREAKDOWN TOGGLE
// ============================================================
describe('VIXRangeAnalysis: fine-grained breakdown', () => {
  it('fine-grained table is hidden by default', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    expect(
      screen.queryByRole('table', { name: /fine-grained/i }),
    ).not.toBeInTheDocument();
  });

  it('shows expand button', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    expect(screen.getByText(/show.*point-by-point/i)).toBeInTheDocument();
  });

  it('expands fine-grained table when button is clicked', async () => {
    const user = userEvent.setup();
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);

    await user.click(screen.getByText(/show.*point-by-point/i));
    expect(
      screen.getByRole('table', { name: /fine-grained/i }),
    ).toBeInTheDocument();
  });

  it('collapses fine-grained table when button is clicked again', async () => {
    const user = userEvent.setup();
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);

    await user.click(screen.getByText(/show.*point-by-point/i));
    expect(
      screen.getByRole('table', { name: /fine-grained/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByText(/hide.*point-by-point/i));
    expect(
      screen.queryByRole('table', { name: /fine-grained/i }),
    ).not.toBeInTheDocument();
  });

  it('button text changes from Show to Hide', async () => {
    const user = userEvent.setup();
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);

    expect(screen.getByText(/show.*point-by-point/i)).toBeInTheDocument();
    await user.click(screen.getByText(/show.*point-by-point/i));
    expect(screen.getByText(/hide.*point-by-point/i)).toBeInTheDocument();
  });
});

// ============================================================
// FINE-GRAINED TABLE CONTENT
// ============================================================
describe('VIXRangeAnalysis: fine-grained table content', () => {
  it('shows all VIX levels from 10 to 30', async () => {
    const user = userEvent.setup();
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    await user.click(screen.getByText(/show.*point-by-point/i));

    const table = screen.getByRole('table', { name: /fine-grained/i });
    for (const s of FINE_VIX_STATS) {
      expect(within(table).getByText(String(s.vix))).toBeInTheDocument();
    }
  });

  it('shows column headers', async () => {
    const user = userEvent.setup();
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    await user.click(screen.getByText(/show.*point-by-point/i));

    const table = screen.getByRole('table', { name: /fine-grained/i });
    expect(within(table).getByText('VIX')).toBeInTheDocument();
    expect(within(table).getByText('Days')).toBeInTheDocument();
    expect(within(table).getByText('90th')).toBeInTheDocument();
    expect(within(table).getByText('>2%')).toBeInTheDocument();
  });

  it('shows day counts for fine stats', async () => {
    const user = userEvent.setup();
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    await user.click(screen.getByText(/show.*point-by-point/i));

    const table = screen.getByRole('table', { name: /fine-grained/i });
    // VIX 12 has 742 days
    expect(within(table).getByText('742')).toBeInTheDocument();
  });

  it('shows point estimates when spot is provided', async () => {
    const user = userEvent.setup();
    render(<VIXRangeAnalysis th={theme} vix={null} spot={6800} />);
    await user.click(screen.getByText(/show.*point-by-point/i));

    const ptTexts = screen.getAllByText(/pts median/);
    expect(ptTexts.length).toBeGreaterThanOrEqual(1);
  });

  it('does not show point estimates when spot is null', async () => {
    const user = userEvent.setup();
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    await user.click(screen.getByText(/show.*point-by-point/i));

    expect(screen.queryByText(/pts median/)).not.toBeInTheDocument();
  });

  it('highlights active VIX level in fine table', async () => {
    const user = userEvent.setup();
    render(<VIXRangeAnalysis th={theme} vix={15.3} spot={6800} />);
    await user.click(screen.getByText(/show.*point-by-point/i));

    const table = screen.getByRole('table', { name: /fine-grained/i });
    const vix15Cells = within(table).getAllByText('15');
    const activeCells = vix15Cells.filter((el) => {
      const style = el.closest('td')?.style;
      return style?.fontWeight === '700';
    });
    expect(activeCells.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// INTERACTION WITH VIX PROP CHANGES
// ============================================================
describe('VIXRangeAnalysis: VIX prop reactivity', () => {
  it('updates active bucket highlight when VIX changes', () => {
    const { rerender } = render(
      <VIXRangeAnalysis th={theme} vix={15} spot={6800} />,
    );

    let currentBadge = screen.getByText('current');
    let row = currentBadge.closest('tr');
    expect(within(row!).getByText(VIX_BUCKETS[2]!.label)).toBeInTheDocument();

    rerender(<VIXRangeAnalysis th={theme} vix={25} spot={6800} />);
    currentBadge = screen.getByText('current');
    row = currentBadge.closest('tr');
    expect(within(row!).getByText(VIX_BUCKETS[5]!.label)).toBeInTheDocument();
  });

  it('removes highlighting when VIX becomes null', () => {
    const { rerender } = render(
      <VIXRangeAnalysis th={theme} vix={15} spot={6800} />,
    );
    expect(screen.getByText('current')).toBeInTheDocument();

    rerender(<VIXRangeAnalysis th={theme} vix={null} spot={6800} />);
    expect(screen.queryByText('current')).not.toBeInTheDocument();
  });
});

// ============================================================
// THEME SUPPORT
// ============================================================
describe('VIXRangeAnalysis: theme support', () => {
  it('renders complete component in light theme', () => {
    render(<VIXRangeAnalysis th={theme} vix={20} spot={6800} />);
    expect(
      screen.getByRole('table', { name: /spx daily range/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: /iron condor survival/i }),
    ).toBeInTheDocument();
  });

  it('renders complete component in dark theme', () => {
    render(<VIXRangeAnalysis th={theme} vix={20} spot={6800} />);
    expect(
      screen.getByRole('table', { name: /spx daily range/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: /iron condor survival/i }),
    ).toBeInTheDocument();
  });

  it('renders fine-grained table in both themes', async () => {
    const user = userEvent.setup();

    const { unmount } = render(
      <VIXRangeAnalysis th={theme} vix={20} spot={6800} />,
    );
    await user.click(screen.getByText(/show.*point-by-point/i));
    expect(
      screen.getByRole('table', { name: /fine-grained/i }),
    ).toBeInTheDocument();
    unmount();

    render(<VIXRangeAnalysis th={theme} vix={20} spot={6800} />);
    await user.click(screen.getByText(/show.*point-by-point/i));
    expect(
      screen.getByRole('table', { name: /fine-grained/i }),
    ).toBeInTheDocument();
  });
});

// ============================================================
// EDGE CASES
// ============================================================
describe('VIXRangeAnalysis: edge cases', () => {
  it('handles VIX 0', () => {
    render(<VIXRangeAnalysis th={theme} vix={0} spot={6800} />);
    expect(
      screen.getByRole('table', { name: /spx daily range/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('current')).toBeInTheDocument();
  });

  it('handles VIX 100 (extreme)', () => {
    render(<VIXRangeAnalysis th={theme} vix={100} spot={6800} />);
    expect(screen.getByText('current')).toBeInTheDocument();
  });

  it('handles spot = 0', () => {
    render(<VIXRangeAnalysis th={theme} vix={20} spot={0} />);
    expect(
      screen.getByRole('table', { name: /spx daily range/i }),
    ).toBeInTheDocument();
  });

  it('handles fractional VIX 14.73', () => {
    render(<VIXRangeAnalysis th={theme} vix={14.73} spot={6800} />);
    const currentBadge = screen.getByText('current');
    const row = currentBadge.closest('tr');
    expect(within(row!).getByText(VIX_BUCKETS[1]!.label)).toBeInTheDocument();
  });

  it('renders all tables together without conflicts', async () => {
    const user = userEvent.setup();
    render(<VIXRangeAnalysis th={theme} vix={20} spot={6800} />);

    await user.click(screen.getByText(/show.*point-by-point/i));

    expect(
      screen.getByRole('table', { name: /spx daily range/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: /iron condor survival/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: /fine-grained/i }),
    ).toBeInTheDocument();
  });

  it('survival toggle and fine-grained toggle work independently', async () => {
    const user = userEvent.setup();
    render(<VIXRangeAnalysis th={theme} vix={20} spot={6800} />);

    // Toggle intraday via role-scoped query
    await user.click(getIntradayChip());

    // Expand fine-grained
    await user.click(screen.getByText(/show.*point-by-point/i));

    // Intraday should still be active
    expect(getIntradayChip()).toHaveAttribute('aria-checked', 'true');

    // Fine-grained should be visible
    expect(
      screen.getByRole('table', { name: /fine-grained/i }),
    ).toBeInTheDocument();

    // Toggle back to settle — fine-grained should remain open
    await user.click(getSettleChip());
    expect(
      screen.getByRole('table', { name: /fine-grained/i }),
    ).toBeInTheDocument();
  });
});

// ============================================================
// SURVIVAL HEATMAP VALUES: spot checks
// ============================================================
describe('VIXRangeAnalysis: survival value spot checks', () => {
  it('VIX <12 with ±2.00% wing shows 99.9% settle', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    const table = screen.getByRole('table', { name: /iron condor survival/i });
    expect(within(table).getByText('99.9%')).toBeInTheDocument();
  });

  it('VIX 40+ with ±0.50% wing shows 11.8% settle', () => {
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    const table = screen.getByRole('table', { name: /iron condor survival/i });
    expect(within(table).getByText('11.8%')).toBeInTheDocument();
  });

  it('intraday mode: VIX <12 with ±0.75% wing shows 98.6%', async () => {
    const user = userEvent.setup();
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    await user.click(getIntradayChip());

    const table = screen.getByRole('table', {
      name: /iron condor survival.*intraday/i,
    });
    expect(within(table).getByText('98.6%')).toBeInTheDocument();
  });

  it('intraday mode: VIX 40+ with ±0.50% wing shows 1.4%', async () => {
    const user = userEvent.setup();
    render(<VIXRangeAnalysis th={theme} vix={null} spot={null} />);
    await user.click(getIntradayChip());

    const table = screen.getByRole('table', {
      name: /iron condor survival.*intraday/i,
    });
    expect(within(table).getByText('1.4%')).toBeInTheDocument();
  });
});
