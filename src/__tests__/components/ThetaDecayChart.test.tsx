import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ThetaDecayChart from '../../components/ThetaDecayChart';

// Mock calcThetaCurve so tests don't depend on BS pricing math
vi.mock('../../utils/calculator', () => ({
  calcThetaCurve: vi.fn(),
}));

import { calcThetaCurve } from '../../utils/calculator';

const mockCurve = [
  { hoursRemaining: 6.5, premiumPct: 100, thetaPerHour: 0 },
  { hoursRemaining: 6, premiumPct: 91.2, thetaPerHour: 8.8 },
  { hoursRemaining: 5.5, premiumPct: 82.1, thetaPerHour: 9.1 },
  { hoursRemaining: 5, premiumPct: 72.5, thetaPerHour: 9.6 },
  { hoursRemaining: 4.5, premiumPct: 62.3, thetaPerHour: 10.2 },
  { hoursRemaining: 4, premiumPct: 51.8, thetaPerHour: 10.5 },
  { hoursRemaining: 3.5, premiumPct: 41.0, thetaPerHour: 10.8 },
  { hoursRemaining: 3, premiumPct: 30.5, thetaPerHour: 10.5 },
  { hoursRemaining: 2.5, premiumPct: 21.0, thetaPerHour: 9.5 },
  { hoursRemaining: 2, premiumPct: 13.0, thetaPerHour: 8.0 },
  { hoursRemaining: 1.5, premiumPct: 7.0, thetaPerHour: 6.0 },
  { hoursRemaining: 1, premiumPct: 3.0, thetaPerHour: 4.0 },
  { hoursRemaining: 0.5, premiumPct: 0.8, thetaPerHour: 2.2 },
];

function defaultProps(
  overrides: Partial<Parameters<typeof ThetaDecayChart>[0]> = {},
) {
  return {
    spot: 5800,
    sigma: 0.2,
    strikeDistance: 100,
    hoursRemaining: 3.2,
    ...overrides,
  };
}

describe('ThetaDecayChart', () => {
  beforeEach(() => {
    vi.mocked(calcThetaCurve).mockReturnValue(mockCurve);
  });

  it('renders section header', () => {
    render(<ThetaDecayChart {...defaultProps()} />);
    expect(screen.getByText(/theta decay/i)).toBeInTheDocument();
  });

  it('renders SVG element', () => {
    const { container } = render(<ThetaDecayChart {...defaultProps()} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('viewBox', '0 0 300 60');
  });

  it('renders now marker when hoursRemaining is in range', () => {
    const { container } = render(
      <ThetaDecayChart {...defaultProps({ hoursRemaining: 3.2 })} />,
    );
    const circles = container.querySelectorAll('circle');
    const amberCircle = Array.from(circles).find(
      (c) => c.getAttribute('fill') === '#f59e0b',
    );
    expect(amberCircle).toBeInTheDocument();
  });

  it('hides now marker when hoursRemaining > 6.5', () => {
    const { container } = render(
      <ThetaDecayChart {...defaultProps({ hoursRemaining: 7 })} />,
    );
    const circles = container.querySelectorAll('circle');
    const amberCircle = Array.from(circles).find(
      (c) => c.getAttribute('fill') === '#f59e0b',
    );
    expect(amberCircle).toBeUndefined();
  });

  it('hides now marker when hoursRemaining < 0.5', () => {
    const { container } = render(
      <ThetaDecayChart {...defaultProps({ hoursRemaining: 0.3 })} />,
    );
    const circles = container.querySelectorAll('circle');
    const amberCircle = Array.from(circles).find(
      (c) => c.getAttribute('fill') === '#f59e0b',
    );
    expect(amberCircle).toBeUndefined();
  });

  it('renders three stat cards', () => {
    render(<ThetaDecayChart {...defaultProps()} />);
    expect(screen.getByText(/peak/i)).toBeInTheDocument();
    expect(screen.getByText(/prem now/i)).toBeInTheDocument();
    expect(screen.getByText(/entry/i)).toBeInTheDocument();
  });

  it('shows peak theta value from curve', () => {
    render(<ThetaDecayChart {...defaultProps()} />);
    expect(screen.getByText('10.8%')).toBeInTheDocument();
    expect(screen.getByText('@ 3.5h')).toBeInTheDocument();
  });

  it('interpolates premium at current hoursRemaining', () => {
    render(<ThetaDecayChart {...defaultProps({ hoursRemaining: 3.2 })} />);
    expect(screen.getByText('34.7%')).toBeInTheDocument();
  });

  it('shows em-dash for prem now when hoursRemaining out of range', () => {
    render(<ThetaDecayChart {...defaultProps({ hoursRemaining: 7 })} />);
    const dashes = screen.getAllByText('\u2014');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it('computes entry window as ET clock times', () => {
    render(<ThetaDecayChart {...defaultProps()} />);
    expect(screen.getByText('10a\u20132p')).toBeInTheDocument();
  });

  it('does not render when curve is empty', () => {
    vi.mocked(calcThetaCurve).mockReturnValue([]);
    const { container } = render(<ThetaDecayChart {...defaultProps()} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders caption text', () => {
    render(<ThetaDecayChart {...defaultProps()} />);
    expect(
      screen.getByText(/premium remaining for 10-delta/i),
    ).toBeInTheDocument();
  });

  // ── FE-MATH-006: marketHours prop ──────────────────────────────

  it('FE-MATH-006: defaults to 6.5h scale when marketHours prop is omitted', () => {
    // hoursRemaining = 6 is in range for a 6.5h day → marker visible
    const { container } = render(
      <ThetaDecayChart {...defaultProps({ hoursRemaining: 6 })} />,
    );
    const circles = container.querySelectorAll('circle');
    const amberCircle = Array.from(circles).find(
      (c) => c.getAttribute('fill') === '#f59e0b',
    );
    expect(amberCircle).toBeInTheDocument();
  });

  it('FE-MATH-006: hides now marker when hoursRemaining exceeds half-day session', () => {
    // 3.5h half-day session: hoursRemaining = 4 is OUT of range.
    // Under the old hardcoded-6.5 logic this would have shown the marker.
    const halfDayCurve = [
      { hoursRemaining: 3.5, premiumPct: 100, thetaPerHour: 0 },
      { hoursRemaining: 3, premiumPct: 80, thetaPerHour: 20 },
      { hoursRemaining: 2.5, premiumPct: 60, thetaPerHour: 20 },
      { hoursRemaining: 2, premiumPct: 42, thetaPerHour: 18 },
      { hoursRemaining: 1.5, premiumPct: 26, thetaPerHour: 16 },
      { hoursRemaining: 1, premiumPct: 12, thetaPerHour: 14 },
      { hoursRemaining: 0.5, premiumPct: 3, thetaPerHour: 9 },
    ];
    vi.mocked(calcThetaCurve).mockReturnValue(halfDayCurve);
    const { container } = render(
      <ThetaDecayChart
        {...defaultProps({ hoursRemaining: 4, marketHours: 3.5 })}
      />,
    );
    const circles = container.querySelectorAll('circle');
    const amberCircle = Array.from(circles).find(
      (c) => c.getAttribute('fill') === '#f59e0b',
    );
    expect(amberCircle).toBeUndefined();
  });

  it('FE-MATH-006: shows now marker for hoursRemaining within half-day session', () => {
    // hoursRemaining = 2 is in range for a 3.5h half-day session
    const halfDayCurve = [
      { hoursRemaining: 3.5, premiumPct: 100, thetaPerHour: 0 },
      { hoursRemaining: 3, premiumPct: 80, thetaPerHour: 20 },
      { hoursRemaining: 2.5, premiumPct: 60, thetaPerHour: 20 },
      { hoursRemaining: 2, premiumPct: 42, thetaPerHour: 18 },
      { hoursRemaining: 1.5, premiumPct: 26, thetaPerHour: 16 },
      { hoursRemaining: 1, premiumPct: 12, thetaPerHour: 14 },
      { hoursRemaining: 0.5, premiumPct: 3, thetaPerHour: 9 },
    ];
    vi.mocked(calcThetaCurve).mockReturnValue(halfDayCurve);
    const { container } = render(
      <ThetaDecayChart
        {...defaultProps({ hoursRemaining: 2, marketHours: 3.5 })}
      />,
    );
    const circles = container.querySelectorAll('circle');
    const amberCircle = Array.from(circles).find(
      (c) => c.getAttribute('fill') === '#f59e0b',
    );
    expect(amberCircle).toBeInTheDocument();
  });

  it('FE-MATH-006: entry window label uses 1 PM close for half-day', () => {
    // formatETRange uses closeHour = 9.5 + marketHours.
    // For marketHours = 3.5, closeHour = 13 (1 PM).
    // The half-day curve's "best run" of high theta is roughly 3.0..1.0h
    // remaining → ET clock 10a..12p (closeHour 13 - hoursRemaining).
    const halfDayCurve = [
      { hoursRemaining: 3.5, premiumPct: 100, thetaPerHour: 0 },
      { hoursRemaining: 3, premiumPct: 80, thetaPerHour: 20 },
      { hoursRemaining: 2.5, premiumPct: 60, thetaPerHour: 20 },
      { hoursRemaining: 2, premiumPct: 42, thetaPerHour: 18 },
      { hoursRemaining: 1.5, premiumPct: 26, thetaPerHour: 16 },
      { hoursRemaining: 1, premiumPct: 12, thetaPerHour: 14 },
      { hoursRemaining: 0.5, premiumPct: 3, thetaPerHour: 9 },
    ];
    vi.mocked(calcThetaCurve).mockReturnValue(halfDayCurve);
    render(
      <ThetaDecayChart
        {...defaultProps({ hoursRemaining: 2, marketHours: 3.5 })}
      />,
    );
    // Entry window should be in the morning (9a..12p range) since the
    // closeHour is 1 PM. Specifically, the high-theta run is hours 3..1
    // → 10a..12p ET. Verify the label contains a "p" suffix from the
    // 12p endpoint and starts with the morning hour.
    const entryLabels = screen.getAllByText(/\d+[ap]\u2013\d+[ap]/);
    expect(entryLabels.length).toBeGreaterThanOrEqual(1);
    // Confirm at least one label uses an early-afternoon hour (12p)
    // which can only happen with the half-day close calculation.
    const labelsText = entryLabels.map((el) => el.textContent ?? '').join(' ');
    expect(labelsText).toMatch(/12p/);
  });
});
