import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import ChainList, {
  type ChainListHandle,
} from '../../../components/PyramidTracker/ChainList';
import type {
  PyramidChain,
  PyramidChainWithLegs,
  PyramidLeg,
} from '../../../types/pyramid';

// ============================================================
// Fixtures
// ============================================================

function makeChain(overrides: Partial<PyramidChain> = {}): PyramidChain {
  return {
    id: 'chain-1',
    trade_date: '2026-04-16',
    instrument: 'MNQ',
    direction: 'long',
    entry_time_ct: '09:15',
    exit_time_ct: '14:30',
    initial_entry_price: 21200,
    final_exit_price: 21250,
    exit_reason: 'reverse_choch',
    total_legs: 2,
    winning_legs: 2,
    net_points: 50,
    session_atr_pct: null,
    day_type: 'trend',
    higher_tf_bias: null,
    notes: null,
    status: 'closed',
    created_at: '2026-04-16T14:30:00Z',
    updated_at: '2026-04-16T14:30:00Z',
    ...overrides,
  };
}

function makeLeg(overrides: Partial<PyramidLeg> = {}): PyramidLeg {
  return {
    id: 'leg-1',
    chain_id: 'chain-1',
    leg_number: 1,
    signal_type: 'CHoCH',
    entry_time_ct: '09:30',
    entry_price: 21200,
    stop_price: 21185,
    stop_distance_pts: 15,
    stop_compression_ratio: 1,
    vwap_at_entry: null,
    vwap_1sd_upper: null,
    vwap_1sd_lower: null,
    vwap_band_position: null,
    vwap_band_distance_pts: null,
    minutes_since_chain_start: 0,
    minutes_since_prior_bos: null,
    ob_quality: null,
    relative_volume: null,
    session_phase: null,
    session_high_at_entry: null,
    session_low_at_entry: null,
    retracement_extreme_before_entry: null,
    exit_price: null,
    exit_reason: null,
    points_captured: 30,
    r_multiple: 2,
    was_profitable: true,
    notes: null,
    ob_high: null,
    ob_low: null,
    ob_poc_price: null,
    ob_poc_pct: null,
    ob_secondary_node_pct: null,
    ob_tertiary_node_pct: null,
    ob_total_volume: null,
    created_at: '2026-04-16T09:30:00Z',
    updated_at: '2026-04-16T09:30:00Z',
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('ChainList', () => {
  it('renders the empty state when chains is empty', () => {
    render(
      <ChainList
        chains={[]}
        getChainWithLegs={vi.fn()}
        onEditChain={vi.fn()}
        onDeleteChain={vi.fn()}
        onEditLeg={vi.fn()}
        onDeleteLeg={vi.fn()}
        onAddLeg={vi.fn()}
      />,
    );

    expect(screen.getByTestId('pyramid-chain-list-empty')).toHaveTextContent(
      /no chains logged yet/i,
    );
  });

  it('renders one ChainCard per chain', () => {
    const chains = [
      makeChain({ id: 'chain-a' }),
      makeChain({ id: 'chain-b', trade_date: '2026-04-15' }),
    ];
    render(
      <ChainList
        chains={chains}
        getChainWithLegs={vi.fn()}
        onEditChain={vi.fn()}
        onDeleteChain={vi.fn()}
        onEditLeg={vi.fn()}
        onDeleteLeg={vi.fn()}
        onAddLeg={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId('pyramid-chain-card-chain-a'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('pyramid-chain-card-chain-b'),
    ).toBeInTheDocument();
  });

  it('fetches legs on first expand and caches them on subsequent expands', async () => {
    const getChainWithLegs = vi.fn<
      (id: string) => Promise<PyramidChainWithLegs>
    >(async (id) => ({
      chain: makeChain({ id }),
      legs: [makeLeg({ chain_id: id })],
    }));

    render(
      <ChainList
        chains={[makeChain({ id: 'chain-a' })]}
        getChainWithLegs={getChainWithLegs}
        onEditChain={vi.fn()}
        onDeleteChain={vi.fn()}
        onEditLeg={vi.fn()}
        onDeleteLeg={vi.fn()}
        onAddLeg={vi.fn()}
      />,
    );

    const toggle = screen.getByRole('button', {
      name: /toggle legs for chain chain-a/i,
    });

    // Expand -> fetch.
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByTestId('pyramid-leg-table')).toBeInTheDocument(),
    );
    expect(getChainWithLegs).toHaveBeenCalledTimes(1);

    // Collapse then re-expand -> cache hit, no second fetch.
    await userEvent.click(toggle);
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByTestId('pyramid-leg-table')).toBeInTheDocument(),
    );
    expect(getChainWithLegs).toHaveBeenCalledTimes(1);
  });

  it('shows the loading placeholder while legs are fetching', async () => {
    let resolve: ((v: PyramidChainWithLegs) => void) | null = null;
    const getChainWithLegs = vi.fn<
      (id: string) => Promise<PyramidChainWithLegs>
    >(
      () =>
        new Promise<PyramidChainWithLegs>((r) => {
          resolve = r;
        }),
    );

    render(
      <ChainList
        chains={[makeChain({ id: 'chain-a' })]}
        getChainWithLegs={getChainWithLegs}
        onEditChain={vi.fn()}
        onDeleteChain={vi.fn()}
        onEditLeg={vi.fn()}
        onDeleteLeg={vi.fn()}
        onAddLeg={vi.fn()}
      />,
    );

    await userEvent.click(
      screen.getByRole('button', {
        name: /toggle legs for chain chain-a/i,
      }),
    );

    // Loading indicator shows while the promise is pending.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/loading legs/i),
    );

    // Resolve the fetch; the table replaces the loading indicator.
    resolve!({
      chain: makeChain({ id: 'chain-a' }),
      legs: [makeLeg()],
    });
    await waitFor(() =>
      expect(screen.getByTestId('pyramid-leg-table')).toBeInTheDocument(),
    );
  });

  it('shows an error row with a Retry button when the leg fetch fails', async () => {
    let reject: ((err: Error) => void) | null = null;
    let fetchCount = 0;
    const getChainWithLegs = vi.fn<
      (id: string) => Promise<PyramidChainWithLegs>
    >(() => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Promise<PyramidChainWithLegs>((_, r) => {
          reject = r;
        });
      }
      return Promise.resolve({
        chain: makeChain({ id: 'chain-a' }),
        legs: [makeLeg()],
      });
    });

    render(
      <ChainList
        chains={[makeChain({ id: 'chain-a' })]}
        getChainWithLegs={getChainWithLegs}
        onEditChain={vi.fn()}
        onDeleteChain={vi.fn()}
        onEditLeg={vi.fn()}
        onDeleteLeg={vi.fn()}
        onAddLeg={vi.fn()}
      />,
    );

    await userEvent.click(
      screen.getByRole('button', {
        name: /toggle legs for chain chain-a/i,
      }),
    );

    reject!(new Error('network down'));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/network down/i),
    );

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() =>
      expect(screen.getByTestId('pyramid-leg-table')).toBeInTheDocument(),
    );
    expect(getChainWithLegs).toHaveBeenCalledTimes(2);
  });

  it('exposes clearLegsCache via the ref so parents can invalidate after mutations', async () => {
    const getChainWithLegs = vi.fn<
      (id: string) => Promise<PyramidChainWithLegs>
    >(async (id) => ({
      chain: makeChain({ id }),
      legs: [makeLeg({ chain_id: id })],
    }));

    const ref = createRef<ChainListHandle>();
    render(
      <ChainList
        ref={ref}
        chains={[makeChain({ id: 'chain-a' })]}
        getChainWithLegs={getChainWithLegs}
        onEditChain={vi.fn()}
        onDeleteChain={vi.fn()}
        onEditLeg={vi.fn()}
        onDeleteLeg={vi.fn()}
        onAddLeg={vi.fn()}
      />,
    );

    const toggle = screen.getByRole('button', {
      name: /toggle legs for chain chain-a/i,
    });

    // Expand (fetch #1).
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByTestId('pyramid-leg-table')).toBeInTheDocument(),
    );
    // Collapse.
    await userEvent.click(toggle);

    // Invalidate cache, then re-expand should trigger fetch #2.
    ref.current?.clearLegsCache('chain-a');
    await userEvent.click(toggle);
    await waitFor(() => expect(getChainWithLegs).toHaveBeenCalledTimes(2));
  });
});
