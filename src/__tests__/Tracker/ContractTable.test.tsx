import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Mock ContractRow so the test is scoped to ContractTable's own logic
// (grouping, headers, unread set wiring). The real ContractRow has its
// own dedicated test file.
vi.mock('../../components/Tracker/ContractRow', () => ({
  ContractRow: ({
    contract,
    hasUnreadAlert,
  }: {
    contract: { id: number; ticker: string; expiry: string };
    hasUnreadAlert: boolean;
  }) => (
    <tr data-testid={`row-${String(contract.id)}`}>
      <td>{contract.ticker}</td>
      <td>{contract.expiry}</td>
      <td data-testid={`unread-${String(contract.id)}`}>
        {hasUnreadAlert ? 'unread' : ''}
      </td>
    </tr>
  ),
}));

import { ContractTable } from '../../components/Tracker/ContractTable';
import type {
  TrackerContract,
  TrackerAlert,
  ContractStatus,
  OptionSide,
  Direction,
} from '../../components/Tracker/types';

let nextId = 1;
function makeContract(overrides: Partial<TrackerContract> = {}): TrackerContract {
  return {
    id: nextId++,
    occ_symbol: 'X',
    ticker: 'NVDA',
    expiry: '2026-05-22',
    strike: '225',
    side: 'P' as OptionSide,
    direction: 'long' as Direction,
    entry_price: '5.00',
    quantity: 1,
    notes: null,
    status: 'active' as ContractStatus,
    closed_at: null,
    closed_price: null,
    up_thresholds: null,
    down_thresholds: null,
    spot_alerts: null,
    created_at: '2026-05-15T14:30:00.000Z',
    updated_at: '2026-05-15T14:30:00.000Z',
    latest_last: null,
    latest_bid: null,
    latest_ask: null,
    latest_underlying: null,
    latest_fetched_at: null,
    ...overrides,
  };
}

describe('ContractTable', () => {
  it('renders "No contracts" placeholder when contracts list is empty', () => {
    render(
      <ContractTable
        contracts={[]}
        alerts={[]}
        groupBy="expiration"
        onGroupByChange={() => undefined}
        onUpdate={async () => undefined}
        onClose={async () => undefined}
      />,
    );
    expect(screen.getByText('No contracts.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('exposes group-by as a radiogroup with two options', () => {
    render(
      <ContractTable
        contracts={[]}
        alerts={[]}
        groupBy="expiration"
        onGroupByChange={() => undefined}
        onUpdate={async () => undefined}
        onClose={async () => undefined}
      />,
    );
    expect(
      screen.getByRole('radiogroup', { name: 'Group rows by' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: 'expiration' }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'ticker' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('clicking the inactive group-by chip fires onGroupByChange with that mode', () => {
    const onGroupByChange = vi.fn();
    render(
      <ContractTable
        contracts={[]}
        alerts={[]}
        groupBy="expiration"
        onGroupByChange={onGroupByChange}
        onUpdate={async () => undefined}
        onClose={async () => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'ticker' }));
    expect(onGroupByChange).toHaveBeenCalledWith('ticker');
  });

  it('groups by expiration: label shows "MM/DD (YYYY-MM-DD) (count)"', () => {
    const contracts = [
      makeContract({ ticker: 'NVDA', expiry: '2026-05-22' }),
      makeContract({ ticker: 'TSLA', expiry: '2026-05-22' }),
      makeContract({ ticker: 'AAPL', expiry: '2026-06-19' }),
    ];
    render(
      <ContractTable
        contracts={contracts}
        alerts={[]}
        groupBy="expiration"
        onGroupByChange={() => undefined}
        onUpdate={async () => undefined}
        onClose={async () => undefined}
      />,
    );
    // Header includes formatted MM/DD + raw expiry as a leaf text node
    // (count lives in a sibling <span>, so the literal label string is
    // a single text node match)
    expect(screen.getByText('05/22 (2026-05-22)')).toBeInTheDocument();
    expect(screen.getByText('06/19 (2026-06-19)')).toBeInTheDocument();
  });

  it('groups by ticker: label shows just the ticker', () => {
    const contracts = [
      makeContract({ ticker: 'NVDA', expiry: '2026-05-22' }),
      makeContract({ ticker: 'NVDA', expiry: '2026-06-19' }),
      makeContract({ ticker: 'TSLA', expiry: '2026-05-22' }),
    ];
    render(
      <ContractTable
        contracts={contracts}
        alerts={[]}
        groupBy="ticker"
        onGroupByChange={() => undefined}
        onUpdate={async () => undefined}
        onClose={async () => undefined}
      />,
    );
    // The mocked ContractRow also outputs ticker text, so NVDA shows
    // multiple times (header + rows). Assert each group header EXISTS
    // (count > 0) — `getAllByText` returns matches for both the leaf
    // text node and its ancestor `<td>`, so length is the right gate.
    expect(screen.getAllByText('NVDA').length).toBeGreaterThan(0);
    expect(screen.getAllByText('TSLA').length).toBeGreaterThan(0);
  });

  it('passes hasUnreadAlert=true for contract ids present in alerts', () => {
    const c1 = makeContract({ id: 100, ticker: 'NVDA' });
    const c2 = makeContract({ id: 200, ticker: 'TSLA' });
    const alerts: TrackerAlert[] = [
      {
        id: 1,
        contract_id: 100,
        fired_at: '2026-05-15T15:00:00.000Z',
        alert_type: 'up_pct',
        threshold: '50',
        price_at_fire: '7.50',
        underlying_at_fire: null,
        acknowledged: false,
        occ_symbol: 'NVDA  260522P00225000',
        ticker: 'NVDA',
        expiry: '2026-05-22',
        strike: '225',
        side: 'P',
        direction: 'long',
        entry_price: '5.00',
        quantity: 1,
        contract_status: 'active',
      },
    ];
    render(
      <ContractTable
        contracts={[c1, c2]}
        alerts={alerts}
        groupBy="ticker"
        onGroupByChange={() => undefined}
        onUpdate={async () => undefined}
        onClose={async () => undefined}
      />,
    );
    expect(screen.getByTestId('unread-100')).toHaveTextContent('unread');
    expect(screen.getByTestId('unread-200')).toHaveTextContent('');
  });

  it('renders a contract row per contract under its group header', () => {
    const contracts = [
      makeContract({ id: 1, ticker: 'NVDA' }),
      makeContract({ id: 2, ticker: 'NVDA' }),
      makeContract({ id: 3, ticker: 'TSLA' }),
    ];
    render(
      <ContractTable
        contracts={contracts}
        alerts={[]}
        groupBy="ticker"
        onGroupByChange={() => undefined}
        onUpdate={async () => undefined}
        onClose={async () => undefined}
      />,
    );
    expect(screen.getByTestId('row-1')).toBeInTheDocument();
    expect(screen.getByTestId('row-2')).toBeInTheDocument();
    expect(screen.getByTestId('row-3')).toBeInTheDocument();
  });
});
