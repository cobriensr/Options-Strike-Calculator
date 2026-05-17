import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ArchiveStats } from '../../components/Tracker/ArchiveStats';
import type {
  TrackerContract,
  ContractStatus,
  OptionSide,
  Direction,
} from '../../components/Tracker/types';

let nextId = 1;
function makeContract(overrides: Partial<TrackerContract> = {}): TrackerContract {
  return {
    id: nextId++,
    occ_symbol: 'NVDA  260522P00225000',
    ticker: 'NVDA',
    expiry: '2026-05-22',
    strike: '225',
    side: 'P' as OptionSide,
    direction: 'long' as Direction,
    entry_price: '5.00',
    quantity: 1,
    notes: null,
    status: 'closed' as ContractStatus,
    closed_at: '2026-05-19T15:30:00.000Z',
    closed_price: '7.50',
    up_thresholds: null,
    down_thresholds: null,
    spot_alerts: null,
    created_at: '2026-05-15T14:30:00.000Z',
    updated_at: '2026-05-19T15:30:00.000Z',
    latest_last: null,
    latest_bid: null,
    latest_ask: null,
    latest_underlying: null,
    latest_fetched_at: null,
    ...overrides,
  };
}

describe('ArchiveStats', () => {
  it('renders all four stat tiles with their labels', () => {
    render(<ArchiveStats contracts={[]} />);
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.getByText('Win rate')).toBeInTheDocument();
    expect(screen.getByText('Avg hold')).toBeInTheDocument();
    expect(screen.getByText('Total PnL')).toBeInTheDocument();
  });

  it('shows em-dashes for win rate + hold + $0 PnL when contracts list is empty', () => {
    render(<ArchiveStats contracts={[]} />);
    // Win rate and hold show '—'
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('$0')).toBeInTheDocument(); // total PnL formats 0 as '$0'
    expect(screen.getByText('0')).toBeInTheDocument(); // closed count
  });

  it('computes win rate as wins/withOutcome*100, rounded', () => {
    // 2 wins, 1 loss, 1 expired without close → 67% (2/3)
    const contracts = [
      makeContract({ entry_price: '5.00', closed_price: '7.00' }), // win
      makeContract({ entry_price: '5.00', closed_price: '6.00' }), // win
      makeContract({ entry_price: '5.00', closed_price: '3.00' }), // loss
      makeContract({
        status: 'expired',
        closed_price: null, // no outcome
        closed_at: null,
      }),
    ];
    render(<ArchiveStats contracts={contracts} />);
    expect(screen.getByText('67%')).toBeInTheDocument();
    expect(screen.getByText('2W / 1L')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument(); // closed count
    expect(screen.getByText('3 with outcome')).toBeInTheDocument();
  });

  it('inverts pnl sign for short direction', () => {
    // Short: closed BELOW entry is a win
    const contracts = [
      makeContract({
        direction: 'short',
        entry_price: '5.00',
        closed_price: '3.00',
        quantity: 1,
      }),
    ];
    render(<ArchiveStats contracts={contracts} />);
    expect(screen.getByText('1W / 0L')).toBeInTheDocument();
    // PnL = (entry - closed) * 1 * 100 = +$200
    expect(screen.getByText('+$200')).toBeInTheDocument();
  });

  it('formats negative PnL with a leading minus and absolute value', () => {
    const contracts = [
      makeContract({ entry_price: '5.00', closed_price: '3.00', quantity: 2 }),
    ];
    render(<ArchiveStats contracts={contracts} />);
    // (3 - 5) * 2 * 100 = -400
    expect(screen.getByText('-$400')).toBeInTheDocument();
  });

  it('computes avg hold days from created_at → closed_at (UTC ms diff / 86400000)', () => {
    const contracts = [
      makeContract({
        created_at: '2026-05-15T00:00:00.000Z',
        closed_at: '2026-05-17T00:00:00.000Z', // 2 days
      }),
      makeContract({
        created_at: '2026-05-15T00:00:00.000Z',
        closed_at: '2026-05-19T00:00:00.000Z', // 4 days
      }),
    ];
    render(<ArchiveStats contracts={contracts} />);
    // (2 + 4) / 2 = 3.0 days
    expect(screen.getByText('3.0d')).toBeInTheDocument();
  });

  it('skips contracts with missing closed_at from hold-days calc', () => {
    const contracts = [
      makeContract({
        created_at: '2026-05-15T00:00:00.000Z',
        closed_at: '2026-05-19T00:00:00.000Z', // 4 days
      }),
      makeContract({
        status: 'expired',
        closed_at: null, // skipped from hold calc
        closed_price: null,
      }),
    ];
    render(<ArchiveStats contracts={contracts} />);
    expect(screen.getByText('4.0d')).toBeInTheDocument();
  });
});
