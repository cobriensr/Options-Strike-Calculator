import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ContractRow } from '../../components/Tracker/ContractRow';
import type { TrackerContract } from '../../components/Tracker/types';

function makeRow(overrides: Partial<TrackerContract> = {}): TrackerContract {
  return {
    id: 42,
    occ_symbol: 'NVDA  260522P00225000',
    ticker: 'NVDA',
    expiry: '2026-05-22',
    strike: '225',
    side: 'P',
    direction: 'long',
    entry_price: '4.30',
    quantity: 5,
    notes: 'whale flow',
    status: 'active',
    closed_at: null,
    closed_price: null,
    up_thresholds: null,
    down_thresholds: null,
    spot_alerts: null,
    created_at: '2026-05-17T15:00:00Z',
    updated_at: '2026-05-17T15:00:00Z',
    latest_last: '6.45',
    latest_bid: '6.40',
    latest_ask: '6.50',
    latest_underlying: '225.10',
    latest_fetched_at: '2026-05-17T15:05:00Z',
    ...overrides,
  };
}

function wrap(children: React.ReactNode) {
  return (
    <table>
      <tbody>{children}</tbody>
    </table>
  );
}

describe('ContractRow', () => {
  it('renders ticker, contract label, and computed PnL columns', () => {
    const row = makeRow();
    render(
      wrap(
        <ContractRow
          contract={row}
          hasUnreadAlert={false}
          onUpdate={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    );
    expect(screen.getByText('NVDA')).toBeInTheDocument();
    expect(screen.getByText('225P 05/22')).toBeInTheDocument();
    expect(screen.getByText('$4.30')).toBeInTheDocument();
    expect(screen.getByText('$6.45')).toBeInTheDocument();
    // Δ$ = 6.45 - 4.30 = +$2.15 for a long
    expect(screen.getByText('+$2.15')).toBeInTheDocument();
    // Δ% = +50.0%
    expect(screen.getByText('+50.0%')).toBeInTheDocument();
  });

  it('flips PnL sign for short direction', () => {
    const row = makeRow({ direction: 'short' });
    render(
      wrap(
        <ContractRow
          contract={row}
          hasUnreadAlert={false}
          onUpdate={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    );
    // Δ% = -50.0% for short when the option went UP
    expect(screen.getByText('-50.0%')).toBeInTheDocument();
  });

  it('expands details and calls onClose with the parsed price', async () => {
    const onClose = vi.fn().mockResolvedValue(undefined);
    const row = makeRow();
    render(
      wrap(
        <ContractRow
          contract={row}
          hasUnreadAlert={false}
          onUpdate={vi.fn()}
          onClose={onClose}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Details/i }));
    fireEvent.change(screen.getByLabelText(/Closed price/i), {
      target: { value: '8.40' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledWith(42, 8.4);
  });

  it('rejects close when price is non-positive', async () => {
    const onClose = vi.fn();
    render(
      wrap(
        <ContractRow
          contract={makeRow()}
          hasUnreadAlert={false}
          onUpdate={vi.fn()}
          onClose={onClose}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Details/i }));
    fireEvent.change(screen.getByLabelText(/Closed price/i), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(screen.queryByRole('alert')).toHaveTextContent(
        /positive close price/i,
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
