import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CeilingChart } from '../components/InstitutionalProgram/CeilingChart';
import type { DailyProgramSummary } from '../hooks/useInstitutionalProgram';

function makeDay(
  overrides: Partial<DailyProgramSummary> = {},
): DailyProgramSummary {
  return {
    date: '2026-04-20',
    dominant_pair: null,
    avg_spot: 5800,
    ceiling_pct_above_spot: 0.012,
    n_blocks: 5,
    n_call_blocks: 3,
    n_put_blocks: 2,
    ...overrides,
  };
}

describe('CeilingChart', () => {
  it('renders an unavailable message when there are zero ceiling values', () => {
    const days: DailyProgramSummary[] = [
      makeDay({ ceiling_pct_above_spot: null }),
    ];
    render(<CeilingChart days={days} />);
    expect(screen.getByText(/Ceiling chart unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/have 0/)).toBeInTheDocument();
  });

  it('renders the unavailable message when only one valid ceiling exists', () => {
    const days = [
      makeDay({ date: '2026-04-19', ceiling_pct_above_spot: 0.012 }),
      makeDay({ date: '2026-04-20', ceiling_pct_above_spot: null }),
    ];
    render(<CeilingChart days={days} />);
    expect(screen.getByText(/have 1/)).toBeInTheDocument();
  });

  it('renders an SVG with one circle per valid day when there are 2+ values', () => {
    const days = [
      makeDay({ date: '2026-04-18', ceiling_pct_above_spot: 0.01 }),
      makeDay({ date: '2026-04-19', ceiling_pct_above_spot: 0.015 }),
      makeDay({ date: '2026-04-20', ceiling_pct_above_spot: 0.02 }),
    ];
    const { container } = render(<CeilingChart days={days} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(container.querySelectorAll('circle')).toHaveLength(3);
    // SVG has a single drawn path connecting the points.
    expect(container.querySelectorAll('path')).toHaveLength(1);
  });

  it('skips days with null ceiling_pct_above_spot when drawing points', () => {
    const days = [
      makeDay({ date: '2026-04-18', ceiling_pct_above_spot: 0.01 }),
      makeDay({ date: '2026-04-19', ceiling_pct_above_spot: null }),
      makeDay({ date: '2026-04-20', ceiling_pct_above_spot: 0.02 }),
    ];
    const { container } = render(<CeilingChart days={days} />);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
  });

  it('puts first and last valid date labels in the X-axis text labels', () => {
    const days = [
      makeDay({ date: '2026-04-18', ceiling_pct_above_spot: 0.01 }),
      makeDay({ date: '2026-04-19', ceiling_pct_above_spot: 0.015 }),
      makeDay({ date: '2026-04-20', ceiling_pct_above_spot: 0.02 }),
    ];
    render(<CeilingChart days={days} />);
    expect(screen.getByText('2026-04-18')).toBeInTheDocument();
    expect(screen.getByText('2026-04-20')).toBeInTheDocument();
  });

  it('renders an aria-label describing the chart range', () => {
    const days = [
      makeDay({ ceiling_pct_above_spot: 0.01 }),
      makeDay({ ceiling_pct_above_spot: 0.025 }),
    ];
    render(<CeilingChart days={days} />);
    const svg = screen.getByRole('img');
    expect(svg).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/Ceiling percentage across 2 days/),
    );
    expect(svg.getAttribute('aria-label')).toMatch(/1\.0% to 2\.5%/);
  });

  it('renders a tooltip <title> for each point with the spot value when present', () => {
    const days = [
      makeDay({
        date: '2026-04-18',
        ceiling_pct_above_spot: 0.01,
        avg_spot: 5800,
      }),
      makeDay({
        date: '2026-04-19',
        ceiling_pct_above_spot: 0.015,
        avg_spot: 5825,
      }),
    ];
    const { container } = render(<CeilingChart days={days} />);
    const titles = container.querySelectorAll('title');
    expect(titles).toHaveLength(2);
    expect(titles[0]?.textContent).toMatch(/2026-04-18: 1\.00% \(spot 5800\)/);
  });

  it('renders "n/a" in the tooltip when avg_spot is null', () => {
    const days = [
      makeDay({ ceiling_pct_above_spot: 0.01, avg_spot: null }),
      makeDay({ ceiling_pct_above_spot: 0.015, avg_spot: 5825 }),
    ];
    const { container } = render(<CeilingChart days={days} />);
    const firstTitle = container.querySelector('title');
    expect(firstTitle?.textContent).toMatch(/spot n\/a/);
  });

  it('handles a flat series (max equals min) without dividing by zero', () => {
    const days = [
      makeDay({ ceiling_pct_above_spot: 0.012 }),
      makeDay({ ceiling_pct_above_spot: 0.012 }),
    ];
    const { container } = render(<CeilingChart days={days} />);
    // Should render without throwing — both circles get a finite y coord.
    const circles = container.querySelectorAll('circle');
    for (const c of circles) {
      const cy = c.getAttribute('cy');
      expect(cy).not.toBeNull();
      expect(Number.isFinite(Number.parseFloat(cy ?? ''))).toBe(true);
    }
  });
});
