import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../hooks/useAccessSession', () => ({
  useAccessSession: vi.fn(),
}));

import { ContractRow } from '../../components/Tracker/ContractRow';
import type { TrackerContract } from '../../components/Tracker/types';
import { useAccessSession } from '../../hooks/useAccessSession';
import type { AccessMode } from '../../utils/auth';

function setAccessMode(mode: AccessMode) {
  vi.mocked(useAccessSession).mockReturnValue({
    mode,
    refresh: vi.fn(),
    logout: vi.fn(),
  });
}

beforeEach(() => {
  setAccessMode('owner');
});

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

  it('renders PositionSizeEntryEditor in expanded details and saves changes', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const row = makeRow();
    render(
      wrap(
        <ContractRow
          contract={row}
          hasUnreadAlert={false}
          onUpdate={onUpdate}
          onClose={vi.fn()}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Details/i }));

    // Editor is pre-filled with the current size + entry.
    const sizeInput = screen.getByLabelText(/Position size/i);
    const entryInput = screen.getByLabelText(/Entry price/i);
    expect(sizeInput).toHaveValue(5);
    expect(entryInput).toHaveValue(4.3);

    // Bump size and entry, then save.
    fireEvent.change(sizeInput, { target: { value: '8' } });
    fireEvent.change(entryInput, { target: { value: '5.75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate).toHaveBeenCalledWith(42, {
      quantity: 8,
      entry_price: 5.75,
    });
  });

  it('hides PositionSizeEntryEditor for closed contracts', () => {
    const row = makeRow({ status: 'closed' });
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
    fireEvent.click(screen.getByRole('button', { name: /Details/i }));
    expect(screen.queryByLabelText(/Position size/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Entry price/i)).not.toBeInTheDocument();
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

  it('disables every edit and close control for guests', () => {
    setAccessMode('guest');
    render(
      wrap(
        <ContractRow
          contract={makeRow()}
          hasUnreadAlert={false}
          onUpdate={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    );
    const details = screen.getByRole('button', { name: /Details/i });
    expect(details).toBeEnabled();
    fireEvent.click(details);

    expect(
      screen.getByText('Owner only \u2014 guest mode is read-only'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Position size/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Add up threshold' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Add spot alert' }),
    ).toBeDisabled();
    expect(screen.getByLabelText(/Closed price/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  });

  it('does not call onClose or onUpdate when a guest clicks the disabled controls', () => {
    setAccessMode('guest');
    const onClose = vi.fn();
    const onUpdate = vi.fn();
    render(
      wrap(
        <ContractRow
          contract={makeRow()}
          hasUnreadAlert={false}
          onUpdate={onUpdate}
          onClose={onClose}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Details/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(
      screen.getAllByRole('button', { name: /Remove up threshold/ })[0]!,
    );
    fireEvent.change(screen.getByLabelText(/Position size/i), {
      target: { value: '8' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('leaves the controls enabled for the owner, with no owner-only note', () => {
    render(
      wrap(
        <ContractRow
          contract={makeRow()}
          hasUnreadAlert={false}
          onUpdate={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Details/i }));
    expect(screen.queryByText(/Owner only/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Add up threshold' }),
    ).toBeEnabled();
  });

  it('shows the error when a threshold update is rejected (e.g. 401)', async () => {
    const onUpdate = vi.fn().mockRejectedValue(new Error('Not authenticated'));
    render(
      wrap(
        <ContractRow
          contract={makeRow()}
          hasUnreadAlert={false}
          onUpdate={onUpdate}
          onClose={vi.fn()}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Details/i }));
    fireEvent.change(screen.getByLabelText('New up threshold percentage'), {
      target: { value: '75' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add up threshold' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Not authenticated'),
    );
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('shows the error when a spot-alert update is rejected (e.g. 401)', async () => {
    const onUpdate = vi.fn().mockRejectedValue(new Error('Not authenticated'));
    render(
      wrap(
        <ContractRow
          contract={makeRow()}
          hasUnreadAlert={false}
          onUpdate={onUpdate}
          onClose={vi.fn()}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Details/i }));
    fireEvent.change(screen.getByLabelText('Spot alert level'), {
      target: { value: '230' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add spot alert' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Not authenticated'),
    );
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});
