import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import {
  CohortCountdown,
  computeCountdownRemaining,
} from '../../components/ui/CohortCountdown';

describe('computeCountdownRemaining', () => {
  it('returns full P75 when triggered exactly now', () => {
    const trigger = '2026-05-15T19:30:00.000Z';
    const now = Date.parse(trigger);
    expect(computeCountdownRemaining(trigger, 340, now)).toBe(340);
  });

  it('subtracts elapsed minutes (floor)', () => {
    const trigger = '2026-05-15T19:00:00.000Z';
    const now = Date.parse(trigger) + 12 * 60_000 + 45_000; // 12m45s later
    // floor(12.75) = 12 elapsed → 340 - 12 = 328
    expect(computeCountdownRemaining(trigger, 340, now)).toBe(328);
  });

  it('goes negative when the cohort window has fully elapsed', () => {
    const trigger = '2026-05-15T19:00:00.000Z';
    const now = Date.parse(trigger) + 400 * 60_000;
    expect(computeCountdownRemaining(trigger, 340, now)).toBe(-60);
  });

  it('returns p75 when trigger is unparseable (defensive fallback)', () => {
    expect(computeCountdownRemaining('not-a-date', 100, Date.now())).toBe(100);
  });
});

describe('CohortCountdown component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders "Nm left" with neutral class when comfortably within window', () => {
    const trigger = '2026-05-15T19:00:00.000Z';
    vi.setSystemTime(new Date(Date.parse(trigger) + 100 * 60_000));
    render(<CohortCountdown triggerTimeCt={trigger} p75MinutesToPeak={340} />);
    const chip = screen.getByTestId('cohort-countdown');
    expect(chip).toHaveTextContent('240m left');
    expect(chip.className).toContain('neutral');
  });

  it('renders amber class when remaining ≤ 15 min', () => {
    const trigger = '2026-05-15T19:00:00.000Z';
    vi.setSystemTime(new Date(Date.parse(trigger) + 330 * 60_000)); // 10m left of 340
    render(<CohortCountdown triggerTimeCt={trigger} p75MinutesToPeak={340} />);
    const chip = screen.getByTestId('cohort-countdown');
    expect(chip).toHaveTextContent('10m left');
    expect(chip.className).toContain('amber');
  });

  it('renders red "expired" when remaining ≤ 0', () => {
    const trigger = '2026-05-15T19:00:00.000Z';
    vi.setSystemTime(new Date(Date.parse(trigger) + 400 * 60_000));
    render(<CohortCountdown triggerTimeCt={trigger} p75MinutesToPeak={340} />);
    const chip = screen.getByTestId('cohort-countdown');
    expect(chip).toHaveTextContent('expired');
    expect(chip.className).toContain('red');
  });

  it('omits chip entirely when p75MinutesToPeak is null', () => {
    render(
      <CohortCountdown
        triggerTimeCt="2026-05-15T19:00:00.000Z"
        p75MinutesToPeak={null}
      />,
    );
    expect(screen.queryByTestId('cohort-countdown')).not.toBeInTheDocument();
  });

  it('ticks down by 1 every minute', async () => {
    const trigger = '2026-05-15T19:00:00.000Z';
    vi.setSystemTime(new Date(Date.parse(trigger) + 100 * 60_000));
    render(<CohortCountdown triggerTimeCt={trigger} p75MinutesToPeak={340} />);
    expect(screen.getByTestId('cohort-countdown')).toHaveTextContent(
      '240m left',
    );
    // advanceTimersByTimeAsync advances the fake clock AND fires the
    // scheduled interval at that time. Date.now() inside the interval
    // returns the new clock value, so we only need this one call.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByTestId('cohort-countdown')).toHaveTextContent(
      '239m left',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByTestId('cohort-countdown')).toHaveTextContent(
      '238m left',
    );
  });
});
