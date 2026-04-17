import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChainCard from '../../../components/PyramidTracker/ChainCard';
import type { PyramidChain } from '../../../types/pyramid';

// ============================================================
// Fixtures
// ============================================================

function makeChain(overrides: Partial<PyramidChain> = {}): PyramidChain {
  return {
    id: '2026-04-16-MNQ-1',
    trade_date: '2026-04-16',
    instrument: 'MNQ',
    direction: 'long',
    entry_time_ct: '09:15',
    exit_time_ct: '14:30',
    initial_entry_price: 21200.5,
    final_exit_price: 21250.75,
    exit_reason: 'reverse_choch',
    total_legs: 4,
    winning_legs: 3,
    net_points: 50.25,
    session_atr_pct: 0.65,
    day_type: 'trend',
    higher_tf_bias: 'bullish above 21100',
    notes: 'Clean trend day.',
    status: 'closed',
    created_at: '2026-04-16T14:30:00Z',
    updated_at: '2026-04-16T14:30:00Z',
    ...overrides,
  };
}

function makeProps(
  overrides: Partial<React.ComponentProps<typeof ChainCard>> = {},
) {
  const defaults: React.ComponentProps<typeof ChainCard> = {
    chain: makeChain(),
    expanded: false,
    contentId: 'body-1',
    onToggle: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onAddLeg: vi.fn(),
  };
  return { ...defaults, ...overrides };
}

// ============================================================
// Tests
// ============================================================

describe('ChainCard', () => {
  it('renders the chain summary line with color-coded net points', () => {
    render(<ChainCard {...makeProps()} />);

    // Date + instrument + direction + day type appear.
    expect(screen.getByText('2026-04-16')).toBeInTheDocument();
    expect(screen.getByText('MNQ')).toBeInTheDocument();
    expect(screen.getByText('Long')).toBeInTheDocument();
    expect(screen.getByText(/trend/i)).toBeInTheDocument();
    expect(screen.getByText('4 legs, 3W')).toBeInTheDocument();

    const pts = screen.getByText('+50.25 pts');
    expect(pts).toHaveClass('text-success');
  });

  it('colors net points red when negative and gray when zero/null', () => {
    const { rerender } = render(
      <ChainCard {...makeProps({ chain: makeChain({ net_points: -12.5 }) })} />,
    );
    expect(screen.getByText('-12.50 pts')).toHaveClass('text-danger');

    rerender(
      <ChainCard {...makeProps({ chain: makeChain({ net_points: 0 }) })} />,
    );
    // Zero renders with "+0.00 pts" sign-less label? No — we only apply +
    // when > 0, so 0 -> "0.00 pts".
    expect(screen.getByText('0.00 pts')).toHaveClass('text-muted');

    rerender(
      <ChainCard {...makeProps({ chain: makeChain({ net_points: null }) })} />,
    );
    // Null renders as em-dash for the points cell; dash has muted color.
    const dashes = screen.getAllByText('\u2014');
    // At least one dash placeholder for the null points value.
    expect(dashes.length).toBeGreaterThan(0);
  });

  it('fires onToggle when the expand button is clicked', async () => {
    const onToggle = vi.fn();
    render(<ChainCard {...makeProps({ onToggle })} />);

    await userEvent.click(
      screen.getByRole('button', { name: /toggle legs for chain/i }),
    );
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('wires aria-expanded and aria-controls on the toggle', () => {
    render(
      <ChainCard
        {...makeProps({ expanded: true, contentId: 'chain-body-xyz' })}
      />,
    );

    const toggle = screen.getByRole('button', {
      name: /toggle legs for chain/i,
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'chain-body-xyz');
  });

  it('fires onEdit, onDelete, onAddLeg from the action cluster', async () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onAddLeg = vi.fn();
    render(<ChainCard {...makeProps({ onEdit, onDelete, onAddLeg })} />);

    await userEvent.click(screen.getByRole('button', { name: /add leg/i }));
    await userEvent.click(screen.getByRole('button', { name: /edit chain/i }));
    await userEvent.click(
      screen.getByRole('button', { name: /delete chain/i }),
    );

    expect(onAddLeg).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('renders graceful placeholders when optional fields are null', () => {
    render(
      <ChainCard
        {...makeProps({
          chain: makeChain({
            trade_date: null,
            instrument: null,
            direction: null,
            total_legs: null,
            winning_legs: null,
            net_points: null,
            day_type: null,
            exit_reason: null,
          }),
        })}
      />,
    );

    // At least one em-dash placeholder visible in the card.
    expect(screen.getAllByText('\u2014').length).toBeGreaterThan(0);
    // Legs summary falls back to em-dash plus "legs".
    expect(screen.getByText(/\u2014 legs/)).toBeInTheDocument();
  });
});
