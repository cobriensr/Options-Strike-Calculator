import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WhalePositioningTable } from '../../components/OptionsFlow/WhalePositioningTable';
import type { WhaleAlert } from '../../types/flow';

function makeAlert(overrides: Partial<WhaleAlert> = {}): WhaleAlert {
  return {
    option_chain: 'SPXW 2026-04-20 C5700',
    strike: 5700,
    type: 'call',
    expiry: '2026-04-20',
    dte_at_alert: 5,
    created_at: '2026-04-14T14:30:00Z',
    age_minutes: 15,
    total_premium: 2_500_000,
    total_ask_side_prem: 2_300_000,
    total_bid_side_prem: 200_000,
    ask_side_ratio: 0.921,
    total_size: 5000,
    volume: 6000,
    open_interest: 1200,
    volume_oi_ratio: 5.0,
    has_sweep: false,
    has_floor: false,
    has_multileg: false,
    alert_rule: 'RepeatedHits',
    underlying_price: 5680,
    distance_from_spot: 20,
    distance_pct: 0.0035,
    is_itm: false,
    ...overrides,
  };
}

const BASE_PROPS = {
  totalPremium: 15_000_000,
  alertCount: 12,
  isLoading: false,
  error: null,
} as const;

describe('WhalePositioningTable', () => {
  it('renders a row for every alert in the fixture', () => {
    const alerts = [
      makeAlert({ option_chain: 'A', strike: 5700, total_premium: 2_000_000 }),
      makeAlert({
        option_chain: 'B',
        strike: 5650,
        type: 'put',
        total_premium: 5_000_000,
      }),
      makeAlert({ option_chain: 'C', strike: 5800, total_premium: 1_500_000 }),
    ];
    render(<WhalePositioningTable {...BASE_PROPS} alerts={alerts} />);
    const rows = screen.getAllByRole('row');
    // header row + 3 data rows
    expect(rows).toHaveLength(4);
  });

  it('defaults to Premium descending (biggest premium at top)', () => {
    const alerts = [
      makeAlert({ option_chain: 'A', strike: 5700, total_premium: 2_000_000 }),
      makeAlert({
        option_chain: 'B',
        strike: 5650,
        total_premium: 206_500_000,
      }),
      makeAlert({ option_chain: 'C', strike: 5800, total_premium: 1_400_000 }),
    ];
    render(<WhalePositioningTable {...BASE_PROPS} alerts={alerts} />);

    const bodyRows = screen.getAllByRole('row').slice(1) as HTMLElement[];
    expect(within(bodyRows[0]!).getByText('5,650')).toBeInTheDocument();
    expect(within(bodyRows[1]!).getByText('5,700')).toBeInTheDocument();
    expect(within(bodyRows[2]!).getByText('5,800')).toBeInTheDocument();

    const premiumHeader = screen.getByRole('columnheader', {
      name: /premium/i,
    });
    expect(premiumHeader).toHaveAttribute('aria-sort', 'descending');
  });

  it('re-sorts by Strike when the Strike header is clicked', async () => {
    const user = userEvent.setup();
    const alerts = [
      makeAlert({ option_chain: 'A', strike: 5800, total_premium: 2_000_000 }),
      makeAlert({ option_chain: 'B', strike: 5650, total_premium: 5_000_000 }),
      makeAlert({ option_chain: 'C', strike: 5700, total_premium: 1_500_000 }),
    ];
    render(<WhalePositioningTable {...BASE_PROPS} alerts={alerts} />);

    await user.click(screen.getByRole('button', { name: /strike/i }));

    // First click on new column → desc (highest strike first).
    const bodyRows = screen.getAllByRole('row').slice(1) as HTMLElement[];
    expect(within(bodyRows[0]!).getByText('5,800')).toBeInTheDocument();
    expect(within(bodyRows[1]!).getByText('5,700')).toBeInTheDocument();
    expect(within(bodyRows[2]!).getByText('5,650')).toBeInTheDocument();
  });

  it('toggles direction when the same column is clicked twice', async () => {
    const user = userEvent.setup();
    const alerts = [
      makeAlert({ option_chain: 'A', strike: 5800, total_premium: 2_000_000 }),
      makeAlert({ option_chain: 'B', strike: 5650, total_premium: 5_000_000 }),
    ];
    render(<WhalePositioningTable {...BASE_PROPS} alerts={alerts} />);

    const strikeBtn = screen.getByRole('button', { name: /strike/i });
    // First click → desc (5800 first)
    await user.click(strikeBtn);
    let rows = screen.getAllByRole('row').slice(1) as HTMLElement[];
    expect(within(rows[0]!).getByText('5,800')).toBeInTheDocument();

    // Second click → asc (5650 first)
    await user.click(strikeBtn);
    rows = screen.getAllByRole('row').slice(1) as HTMLElement[];
    expect(within(rows[0]!).getByText('5,650')).toBeInTheDocument();

    const strikeHeader = screen.getByRole('columnheader', { name: /strike/i });
    expect(strikeHeader).toHaveAttribute('aria-sort', 'ascending');
  });

  it('renders a multileg badge only when has_multileg=true', () => {
    const alerts = [
      makeAlert({ option_chain: 'A', strike: 5700, has_multileg: true }),
      makeAlert({ option_chain: 'B', strike: 5650, has_multileg: false }),
    ];
    render(<WhalePositioningTable {...BASE_PROPS} alerts={alerts} />);

    const badges = screen.getAllByLabelText('Multileg');
    expect(badges).toHaveLength(1);
  });

  it('shows the empty state when alerts is empty and not loading', () => {
    render(
      <WhalePositioningTable {...BASE_PROPS} alerts={[]} isLoading={false} />,
    );
    expect(screen.getByText(/no whale-sized flow today/i)).toBeInTheDocument();
  });

  it('shows the loading state when alerts is empty and isLoading=true', () => {
    render(
      <WhalePositioningTable {...BASE_PROPS} alerts={[]} isLoading={true} />,
    );
    expect(screen.getByText(/loading whale positioning/i)).toBeInTheDocument();
  });

  it('shows a generic error message and does not leak error.message', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <WhalePositioningTable
        {...BASE_PROPS}
        alerts={[]}
        error={new Error('boom-supersecret')}
      />,
    );
    expect(screen.getByText(/couldn't load whale flow/i)).toBeInTheDocument();
    expect(screen.queryByText(/boom-supersecret/i)).not.toBeInTheDocument();
    consoleSpy.mockRestore();
  });

  it('formats premium in compact form (e.g. $206.5M, not 206500000)', () => {
    const alerts = [
      makeAlert({
        option_chain: 'A',
        strike: 5700,
        total_premium: 206_500_000,
      }),
    ];
    render(<WhalePositioningTable {...BASE_PROPS} alerts={alerts} />);
    expect(screen.getByText('$206.5M')).toBeInTheDocument();
    expect(screen.queryByText('206500000')).not.toBeInTheDocument();
  });

  it('call/put side badges have distinct color classes', () => {
    const alerts = [
      makeAlert({ option_chain: 'A', strike: 5700, type: 'call' }),
      makeAlert({ option_chain: 'B', strike: 5650, type: 'put' }),
    ];
    render(<WhalePositioningTable {...BASE_PROPS} alerts={alerts} />);

    const callBadge = screen.getByLabelText('Call');
    const putBadge = screen.getByLabelText('Put');
    expect(callBadge.className).toMatch(/emerald-400|green-400/);
    expect(putBadge.className).toMatch(/rose-400|red-400/);
  });

  it('displays the visible-alert count alongside the slider', () => {
    const alerts = [
      makeAlert({ option_chain: 'A', strike: 5700, total_premium: 2_000_000 }),
      makeAlert({ option_chain: 'B', strike: 5710, total_premium: 1_500_000 }),
      makeAlert({ option_chain: 'C', strike: 5720, total_premium: 5_000_000 }),
    ];
    render(<WhalePositioningTable {...BASE_PROPS} alerts={alerts} />);
    // All 3 alerts are ≥ $1M (default slider value), so unfiltered count shown.
    const countEl = screen.getByTestId('whale-alert-count');
    expect(countEl.textContent).toMatch(/3 alerts ≥ \$1\.0M/);
  });

  it('renders the slider with a default value of $1M', () => {
    const alerts = [makeAlert({ option_chain: 'A', total_premium: 2_500_000 })];
    render(<WhalePositioningTable {...BASE_PROPS} alerts={alerts} />);
    const slider = screen.getByLabelText(
      /minimum whale premium/i,
    ) as HTMLInputElement;
    expect(slider).toBeInTheDocument();
    expect(slider.type).toBe('range');
    expect(slider.value).toBe('1000000');
    expect(slider).toHaveAttribute('min', '500000');
    expect(slider).toHaveAttribute('max', '10000000');
    // Visible label echoes the slider value
    const label = screen.getByText(/Premium ≥/i);
    expect(label.textContent).toContain('$1.0M');
  });

  it('filters alerts below the slider value after a drag', () => {
    const alerts = [
      makeAlert({
        option_chain: 'BIG',
        strike: 5700,
        total_premium: 6_000_000,
      }),
      makeAlert({
        option_chain: 'MID',
        strike: 5650,
        total_premium: 2_000_000,
      }),
      makeAlert({
        option_chain: 'SMALL',
        strike: 5750,
        total_premium: 750_000,
      }),
    ];
    render(<WhalePositioningTable {...BASE_PROPS} alerts={alerts} />);

    // At default $1M, SMALL (750K) is filtered out → 2 rows remain.
    expect(screen.getAllByRole('row')).toHaveLength(1 + 2);

    const slider = screen.getByLabelText(
      /minimum whale premium/i,
    ) as HTMLInputElement;
    // fireEvent.change simulates the drag endpoint — userEvent v14 doesn't
    // reliably move range inputs with discrete drags.
    fireEvent.change(slider, { target: { value: '5000000' } });

    // Only BIG (6M) ≥ $5M → 1 data row + 1 header row.
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(1 + 1);
    const countEl = screen.getByTestId('whale-alert-count');
    expect(countEl.textContent).toMatch(/1 of 3 alerts ≥ \$5\.0M/);
  });

  it('shows all returned alerts when slider is at the $500K floor', () => {
    const alerts = [
      makeAlert({
        option_chain: 'BIG',
        strike: 5700,
        total_premium: 6_000_000,
      }),
      makeAlert({
        option_chain: 'SMALL',
        strike: 5750,
        total_premium: 600_000,
      }),
    ];
    render(<WhalePositioningTable {...BASE_PROPS} alerts={alerts} />);

    const slider = screen.getByLabelText(
      /minimum whale premium/i,
    ) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '500000' } });

    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(1 + 2);
    const countEl = screen.getByTestId('whale-alert-count');
    // At floor, display collapses to the "N alerts" form (no "X of Y")
    expect(countEl.textContent).toMatch(/^2 alerts ≥ \$500K$/);
  });

  it('shows a filtered-empty message when slider cuts all alerts', () => {
    const alerts = [
      makeAlert({ option_chain: 'A', total_premium: 1_200_000 }),
    ];
    render(<WhalePositioningTable {...BASE_PROPS} alerts={alerts} />);

    const slider = screen.getByLabelText(
      /minimum whale premium/i,
    ) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '10000000' } });

    expect(screen.getByText(/drag the slider left/i)).toBeInTheDocument();
    // The underlying table is not rendered when nothing matches the filter.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the rule badge with short abbreviated label', () => {
    const alerts = [
      makeAlert({
        option_chain: 'A',
        strike: 5700,
        alert_rule: 'RepeatedHitsAscendingFill',
      }),
      makeAlert({
        option_chain: 'B',
        strike: 5650,
        alert_rule: 'FloorTradeLargeCap',
      }),
    ];
    render(<WhalePositioningTable {...BASE_PROPS} alerts={alerts} />);
    expect(screen.getByText('RHITS↑')).toBeInTheDocument();
    expect(screen.getByText('FLOOR')).toBeInTheDocument();
  });

  it('renders expiry column in short m/d (Nd) format', () => {
    const alerts = [
      makeAlert({
        option_chain: 'A',
        strike: 5700,
        expiry: '2026-04-20',
        dte_at_alert: 5,
      }),
    ];
    render(<WhalePositioningTable {...BASE_PROPS} alerts={alerts} />);
    expect(screen.getByText('4/20 (5d)')).toBeInTheDocument();
  });

  it('renders age column in humanized minutes-ago format', () => {
    const alerts = [
      makeAlert({ option_chain: 'A', strike: 5700, age_minutes: 15 }),
    ];
    render(<WhalePositioningTable {...BASE_PROPS} alerts={alerts} />);
    expect(screen.getByText('15m ago')).toBeInTheDocument();
  });

  describe('ask_side_ratio null-handling in sort', () => {
    // Server returns ask_side_ratio: null when total_premium is 0 / non-finite.
    // Those rows must sink to the bottom regardless of sort direction — a
    // null can't be meaningfully compared against a signed ratio.
    //
    // Make all three rows pass the default $1M slider so nothing is filtered
    // out before sorting. Use distinct strikes so we can identify row order.
    const buildMixedAlerts = (): WhaleAlert[] => [
      makeAlert({
        option_chain: 'HIGH',
        strike: 5700,
        total_premium: 1_500_000,
        ask_side_ratio: 0.9,
      }),
      makeAlert({
        option_chain: 'NULL',
        strike: 5710,
        total_premium: 1_500_000,
        ask_side_ratio: null,
      }),
      makeAlert({
        option_chain: 'LOW',
        strike: 5720,
        total_premium: 1_500_000,
        ask_side_ratio: 0.5,
      }),
    ];

    it('sinks null ask_side_ratio to the bottom on desc sort', async () => {
      const user = userEvent.setup();
      render(
        <WhalePositioningTable {...BASE_PROPS} alerts={buildMixedAlerts()} />,
      );

      // Click once → desc. null row should be last, 0.9 first, 0.5 middle.
      await user.click(screen.getByRole('button', { name: /ask %/i }));

      const bodyRows = screen.getAllByRole('row').slice(1) as HTMLElement[];
      expect(bodyRows).toHaveLength(3);
      expect(within(bodyRows[0]!).getByText('5,700')).toBeInTheDocument(); // 0.9
      expect(within(bodyRows[1]!).getByText('5,720')).toBeInTheDocument(); // 0.5
      // null row renders em-dash in the Ask % cell and sorts to the bottom.
      expect(within(bodyRows[2]!).getByText('5,710')).toBeInTheDocument();
    });

    it('keeps null ask_side_ratio at the bottom on asc sort', async () => {
      const user = userEvent.setup();
      render(
        <WhalePositioningTable {...BASE_PROPS} alerts={buildMixedAlerts()} />,
      );

      const btn = screen.getByRole('button', { name: /ask %/i });
      // First click → desc, second click → asc.
      await user.click(btn);
      await user.click(btn);

      const bodyRows = screen.getAllByRole('row').slice(1) as HTMLElement[];
      expect(bodyRows).toHaveLength(3);
      expect(within(bodyRows[0]!).getByText('5,720')).toBeInTheDocument(); // 0.5
      expect(within(bodyRows[1]!).getByText('5,700')).toBeInTheDocument(); // 0.9
      // Null still last — direction doesn't flip the partition.
      expect(within(bodyRows[2]!).getByText('5,710')).toBeInTheDocument();
    });

    it('renders em-dash for null ask_side_ratio rows', () => {
      const alerts = [
        makeAlert({
          option_chain: 'A',
          strike: 5700,
          total_premium: 1_500_000,
          ask_side_ratio: null,
        }),
      ];
      render(<WhalePositioningTable {...BASE_PROPS} alerts={alerts} />);
      // The Ask % cell for this single row should render an em-dash.
      const bodyRow = screen.getAllByRole('row').slice(1)[0]!;
      expect(within(bodyRow).getByText('—')).toBeInTheDocument();
    });
  });
});
