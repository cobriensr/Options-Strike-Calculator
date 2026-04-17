import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import ProgressCounter from '../../../components/PyramidTracker/ProgressCounter';
import type { PyramidProgress } from '../../../types/pyramid';

// ============================================================
// Fixtures
// ============================================================

function makeProgress(
  overrides: Partial<PyramidProgress> = {},
): PyramidProgress {
  return {
    total_chains: 0,
    chains_by_day_type: {
      trend: 0,
      chop: 0,
      news: 0,
      mixed: 0,
      unspecified: 0,
    },
    elapsed_calendar_days: null,
    fill_rates: {},
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('ProgressCounter', () => {
  it('shows 0 / 30 / 50 / 100 headline before any chains are logged', () => {
    render(<ProgressCounter progress={makeProgress()} />);

    expect(screen.getByTestId('pyramid-progress-total')).toHaveTextContent('0');
    // Threshold suffix rendered as a single string.
    expect(
      screen.getByText(/30 min \/ 50 target \/ 100 robust/i),
    ).toBeInTheDocument();

    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');

    // Empty state message for elapsed days.
    expect(screen.getByText(/no chains logged yet/i)).toBeInTheDocument();
  });

  it.each([
    [15, 15, 'progress at 15%'],
    [30, 30, 'progress at 30%'],
    [50, 50, 'progress at 50%'],
    [100, 100, 'progress at 100%'],
    [150, 100, 'capped at 100% when over robust target'],
  ])('scales the headline total %i to valuenow %i (%s)', (total, expected) => {
    render(
      <ProgressCounter progress={makeProgress({ total_chains: total })} />,
    );
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      String(total),
    );
    // The visible percentage label mirrors the capped width.
    expect(screen.getByText(`${expected}%`)).toBeInTheDocument();
  });

  it('formats "Collected over N days" with singular/plural correctly', () => {
    const { rerender } = render(
      <ProgressCounter
        progress={makeProgress({ total_chains: 1, elapsed_calendar_days: 1 })}
      />,
    );
    expect(screen.getByText(/collected over 1 day/i)).toBeInTheDocument();

    rerender(
      <ProgressCounter
        progress={makeProgress({ total_chains: 2, elapsed_calendar_days: 14 })}
      />,
    );
    expect(screen.getByText(/collected over 14 days/i)).toBeInTheDocument();
  });

  it('renders one pill per day_type bucket with its count', () => {
    render(
      <ProgressCounter
        progress={makeProgress({
          total_chains: 10,
          chains_by_day_type: {
            trend: 5,
            chop: 3,
            news: 1,
            mixed: 1,
            unspecified: 0,
          },
        })}
      />,
    );

    const pillsContainer = screen.getByTestId('pyramid-progress-day-types');
    const trendPill = within(pillsContainer).getByText(/trend/i);
    expect(trendPill).toBeInTheDocument();
    // Within the pills container there should be all five buckets.
    expect(within(pillsContainer).getByText(/chop/i)).toBeInTheDocument();
    expect(
      within(pillsContainer).getByText(/unspecified/i),
    ).toBeInTheDocument();
  });

  it('color-bands per-feature fill rates and sorts lowest first', () => {
    render(
      <ProgressCounter
        progress={makeProgress({
          total_chains: 20,
          fill_rates: {
            high_filled: 0.95,
            medium_filled: 0.6,
            low_filled: 0.2,
          },
        })}
      />,
    );

    const list = screen.getByTestId('pyramid-progress-fill-rates');
    const items = within(list).getAllByRole('listitem');

    // Sorted lowest-first: low_filled (20%), medium_filled (60%), high_filled (95%).
    expect(items[0]).toHaveAttribute('data-testid', 'pyramid-fill-low_filled');
    expect(items[0]).toHaveAttribute('data-band', 'red');
    expect(items[1]).toHaveAttribute(
      'data-testid',
      'pyramid-fill-medium_filled',
    );
    expect(items[1]).toHaveAttribute('data-band', 'amber');
    expect(items[2]).toHaveAttribute('data-testid', 'pyramid-fill-high_filled');
    expect(items[2]).toHaveAttribute('data-band', 'green');
  });

  it('treats exactly 0.80 as green (ready) and exactly 0.50 as amber', () => {
    render(
      <ProgressCounter
        progress={makeProgress({
          total_chains: 20,
          fill_rates: {
            exactly_80: 0.8,
            exactly_50: 0.5,
            just_below_50: 0.4999,
          },
        })}
      />,
    );

    const list = screen.getByTestId('pyramid-progress-fill-rates');
    expect(within(list).getByTestId('pyramid-fill-exactly_80')).toHaveAttribute(
      'data-band',
      'green',
    );
    expect(within(list).getByTestId('pyramid-fill-exactly_50')).toHaveAttribute(
      'data-band',
      'amber',
    );
    expect(
      within(list).getByTestId('pyramid-fill-just_below_50'),
    ).toHaveAttribute('data-band', 'red');
  });

  it('shows the fill-rates empty state when no features are tracked', () => {
    render(<ProgressCounter progress={makeProgress()} />);
    expect(screen.queryByTestId('pyramid-progress-fill-rates')).toBeNull();
    expect(
      screen.getByText(/fill rates appear once legs are logged/i),
    ).toBeInTheDocument();
  });
});
