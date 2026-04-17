import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LegTable from '../../../components/PyramidTracker/LegTable';
import type { PyramidLeg } from '../../../types/pyramid';

// ============================================================
// Fixtures
// ============================================================

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
    ob_quality: 4,
    relative_volume: null,
    session_phase: 'open_drive',
    session_high_at_entry: null,
    session_low_at_entry: null,
    retracement_extreme_before_entry: null,
    exit_price: 21230,
    exit_reason: 'trailed_stop',
    points_captured: 30,
    r_multiple: 2,
    was_profitable: true,
    notes: null,
    ob_high: null,
    ob_low: null,
    ob_poc_price: null,
    ob_poc_pct: 34.5,
    ob_secondary_node_pct: null,
    ob_tertiary_node_pct: null,
    ob_total_volume: null,
    created_at: '2026-04-16T14:30:00Z',
    updated_at: '2026-04-16T14:30:00Z',
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('LegTable', () => {
  it('shows the empty-state placeholder when there are no legs', () => {
    render(<LegTable legs={[]} onEditLeg={vi.fn()} onDeleteLeg={vi.fn()} />);

    expect(screen.getByText(/no legs logged yet/i)).toBeInTheDocument();
    // Table element is not rendered in the empty state.
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('renders legs in ascending leg_number order regardless of input order', () => {
    const legs = [
      makeLeg({ id: 'leg-3', leg_number: 3 }),
      makeLeg({ id: 'leg-1', leg_number: 1 }),
      makeLeg({ id: 'leg-2', leg_number: 2 }),
    ];
    render(<LegTable legs={legs} onEditLeg={vi.fn()} onDeleteLeg={vi.fn()} />);

    const rows = screen.getAllByRole('row');
    // First row is the <thead>, so body rows start at index 1.
    const bodyRows = rows.slice(1);
    expect(bodyRows).toHaveLength(3);
    expect(within(bodyRows[0]!).getByText('1')).toBeInTheDocument();
    expect(within(bodyRows[1]!).getByText('2')).toBeInTheDocument();
    expect(within(bodyRows[2]!).getByText('3')).toBeInTheDocument();
  });

  it('formats compression ratio to 2 decimals and leaves it empty when null', () => {
    render(
      <LegTable
        legs={[
          makeLeg({ id: 'a', leg_number: 1, stop_compression_ratio: 0.8 }),
          makeLeg({ id: 'b', leg_number: 2, stop_compression_ratio: null }),
        ]}
        onEditLeg={vi.fn()}
        onDeleteLeg={vi.fn()}
      />,
    );

    expect(screen.getByText('0.80')).toBeInTheDocument();
    // Null compression is an empty cell — asserting absence of "null".
    expect(screen.queryByText('null')).toBeNull();
  });

  it('colors profitable outcomes green and losses red', () => {
    render(
      <LegTable
        legs={[
          makeLeg({
            id: 'win',
            leg_number: 1,
            points_captured: 30,
            r_multiple: 2,
          }),
          makeLeg({
            id: 'loss',
            leg_number: 2,
            points_captured: -10,
            r_multiple: -1,
          }),
          makeLeg({
            id: 'flat',
            leg_number: 3,
            points_captured: null,
            r_multiple: null,
          }),
        ]}
        onEditLeg={vi.fn()}
        onDeleteLeg={vi.fn()}
      />,
    );

    expect(screen.getByText('+30.00 / 2.0R')).toHaveClass('text-success');
    expect(screen.getByText('-10.00 / -1.0R')).toHaveClass('text-danger');
    // Flat row: points_captured null and r null -> em-dash.
    expect(screen.getByText('\u2014')).toHaveClass('text-muted');
  });

  it('formats ob_poc_pct with a % suffix and 1 decimal', () => {
    render(
      <LegTable
        legs={[makeLeg({ ob_poc_pct: 34.5 })]}
        onEditLeg={vi.fn()}
        onDeleteLeg={vi.fn()}
      />,
    );
    expect(screen.getByText('34.5%')).toBeInTheDocument();
  });

  it('fires onEditLeg and onDeleteLeg with the correct arguments', async () => {
    const onEditLeg = vi.fn();
    const onDeleteLeg = vi.fn();
    const leg = makeLeg({ id: 'leg-42', leg_number: 7 });

    render(
      <LegTable legs={[leg]} onEditLeg={onEditLeg} onDeleteLeg={onDeleteLeg} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /edit leg 7/i }));
    expect(onEditLeg).toHaveBeenCalledWith(leg);

    await userEvent.click(
      screen.getByRole('button', { name: /delete leg 7/i }),
    );
    expect(onDeleteLeg).toHaveBeenCalledWith('leg-42');
  });

  it('shows the signal_type badge when present and omits it when null', () => {
    render(
      <LegTable
        legs={[
          makeLeg({ id: 'a', leg_number: 1, signal_type: 'CHoCH' }),
          makeLeg({ id: 'b', leg_number: 2, signal_type: null }),
        ]}
        onEditLeg={vi.fn()}
        onDeleteLeg={vi.fn()}
      />,
    );

    expect(screen.getByText('CHoCH')).toBeInTheDocument();
    expect(screen.queryByText('BOS')).toBeNull();
  });
});
