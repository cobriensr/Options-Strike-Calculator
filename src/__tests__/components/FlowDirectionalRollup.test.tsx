import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FlowDirectionalRollup } from '../../components/OptionsFlow/FlowDirectionalRollup';
import type { RankedStrike } from '../../hooks/useOptionsFlow';

function makeStrike(overrides: Partial<RankedStrike> = {}): RankedStrike {
  return {
    strike: 6900,
    type: 'call',
    distance_from_spot: 50,
    distance_pct: 0.0073,
    total_premium: 1_000_000,
    ask_side_ratio: 0.85,
    volume_oi_ratio: 0.3,
    hit_count: 3,
    has_ascending_fill: false,
    has_descending_fill: false,
    has_multileg: false,
    is_itm: false,
    score: 70,
    first_seen_at: '2026-04-14T14:30:00Z',
    last_seen_at: '2026-04-14T14:45:00Z',
    ...overrides,
  };
}

describe('FlowDirectionalRollup', () => {
  it('shows "No spot data" when spot is null', () => {
    render(<FlowDirectionalRollup strikes={[]} spot={null} alertCount={10} />);
    expect(screen.getByText(/no spot data/i)).toBeInTheDocument();
  });

  it('shows "No alerts in window" when alertCount is 0', () => {
    render(<FlowDirectionalRollup strikes={[]} spot={6850} alertCount={0} />);
    expect(screen.getByText(/no alerts in window/i)).toBeInTheDocument();
  });

  it('shows "All flow is mixed" when no aggressive and no absorbed flow', () => {
    const strikes = [
      makeStrike({ strike: 6900, ask_side_ratio: 0.5 }),
      makeStrike({ strike: 6850, ask_side_ratio: 0.45, type: 'put' }),
    ];
    render(
      <FlowDirectionalRollup strikes={strikes} spot={6850} alertCount={2} />,
    );
    expect(
      screen.getByText(/all flow is mixed — no clear aggression signal/i),
    ).toBeInTheDocument();
  });

  it('renders CALL-HEAVY AGGRESSION emerald badge when aggressive calls dominate', () => {
    const strikes = [
      makeStrike({
        strike: 6900,
        ask_side_ratio: 0.9,
        type: 'call',
        total_premium: 10_000_000,
      }),
      makeStrike({
        strike: 6910,
        ask_side_ratio: 0.85,
        type: 'call',
        total_premium: 5_000_000,
      }),
      makeStrike({
        strike: 6800,
        ask_side_ratio: 0.8,
        type: 'put',
        total_premium: 500_000,
      }),
    ];
    render(
      <FlowDirectionalRollup strikes={strikes} spot={6850} alertCount={3} />,
    );
    const label = screen.getByText('CALL-HEAVY AGGRESSION');
    expect(label).toBeInTheDocument();
    const badge = label.closest('div');
    expect(badge?.className).toMatch(/emerald-/);
  });

  it('renders PUT-HEAVY AGGRESSION rose badge when aggressive puts dominate', () => {
    const strikes = [
      makeStrike({
        strike: 6800,
        ask_side_ratio: 0.9,
        type: 'put',
        total_premium: 12_000_000,
      }),
      makeStrike({
        strike: 6790,
        ask_side_ratio: 0.8,
        type: 'put',
        total_premium: 3_000_000,
      }),
      makeStrike({
        strike: 6900,
        ask_side_ratio: 0.85,
        type: 'call',
        total_premium: 300_000,
      }),
    ];
    render(
      <FlowDirectionalRollup strikes={strikes} spot={6850} alertCount={3} />,
    );
    const label = screen.getByText('PUT-HEAVY AGGRESSION');
    expect(label).toBeInTheDocument();
    const badge = label.closest('div');
    expect(badge?.className).toMatch(/rose-/);
  });

  it('renders NO AGGRESSIVE FLOW badge when only absorbed flow is present', () => {
    const strikes = [
      makeStrike({
        strike: 6900,
        ask_side_ratio: 0.1,
        type: 'call',
        total_premium: 2_000_000,
      }),
      makeStrike({
        strike: 6800,
        ask_side_ratio: 0.2,
        type: 'put',
        total_premium: 1_500_000,
      }),
    ];
    render(
      <FlowDirectionalRollup strikes={strikes} spot={6850} alertCount={2} />,
    );
    expect(screen.getByText('NO AGGRESSIVE FLOW')).toBeInTheDocument();
  });

  it('renders AGGRESSION BALANCED badge when aggressive calls and puts are comparable', () => {
    const strikes = [
      makeStrike({
        strike: 6900,
        ask_side_ratio: 0.9,
        type: 'call',
        total_premium: 2_000_000,
      }),
      makeStrike({
        strike: 6800,
        ask_side_ratio: 0.85,
        type: 'put',
        total_premium: 2_000_000,
      }),
    ];
    render(
      <FlowDirectionalRollup strikes={strikes} spot={6850} alertCount={2} />,
    );
    const label = screen.getByText('AGGRESSION BALANCED');
    expect(label).toBeInTheDocument();
    const badge = label.closest('div');
    expect(badge?.className).toMatch(/slate-/);
  });

  it('renders both AGGRESSIVE and ABSORBED lines when both populations present', () => {
    const strikes = [
      makeStrike({
        strike: 6900,
        ask_side_ratio: 0.9,
        type: 'call',
        total_premium: 5_000_000,
      }),
      makeStrike({
        strike: 6800,
        ask_side_ratio: 0.15,
        type: 'put',
        total_premium: 8_000_000,
      }),
    ];
    render(
      <FlowDirectionalRollup strikes={strikes} spot={6850} alertCount={2} />,
    );
    expect(screen.getByText('AGGRESSIVE')).toBeInTheDocument();
    expect(screen.getByText('ABSORBED')).toBeInTheDocument();
  });

  it('renders the helper text when data is present', () => {
    const strikes = [
      makeStrike({ strike: 6900, ask_side_ratio: 0.9, type: 'call' }),
    ];
    render(
      <FlowDirectionalRollup strikes={strikes} spot={6850} alertCount={1} />,
    );
    expect(
      screen.getByText(/buyer at ask.*seller at bid/i),
    ).toBeInTheDocument();
  });

  it('formats premium totals in compact form', () => {
    const strikes = [
      makeStrike({
        strike: 6900,
        ask_side_ratio: 0.9,
        type: 'call',
        total_premium: 12_400_000,
      }),
      makeStrike({
        strike: 6800,
        ask_side_ratio: 0.85,
        type: 'put',
        total_premium: 2_100_000,
      }),
    ];
    render(
      <FlowDirectionalRollup strikes={strikes} spot={6850} alertCount={2} />,
    );
    expect(screen.getByText(/\$12\.4M/)).toBeInTheDocument();
    expect(screen.getByText(/\$2\.1M/)).toBeInTheDocument();
  });
});
