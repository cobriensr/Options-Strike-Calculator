import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OptionsFlowTable } from '../../components/OptionsFlow/OptionsFlowTable';
import type { RankedStrike } from '../../hooks/useOptionsFlow';

function makeStrike(overrides: Partial<RankedStrike> = {}): RankedStrike {
  return {
    strike: 6900,
    type: 'call',
    distance_from_spot: 50,
    distance_pct: 0.0073,
    total_premium: 152_300,
    ask_side_ratio: 0.997,
    volume_oi_ratio: 0.31,
    hit_count: 4,
    has_ascending_fill: false,
    has_descending_fill: false,
    has_multileg: false,
    is_itm: false,
    score: 72.4,
    first_seen_at: '2026-04-14T14:30:00Z',
    last_seen_at: '2026-04-14T14:45:23Z',
    ...overrides,
  };
}

const BASE_PROPS = {
  spot: 6850 as number | null,
  lastUpdated: '2026-04-14T14:45:23Z' as string | null,
  alertCount: 12,
  isLoading: false,
  error: null,
} as const;

describe('OptionsFlowTable', () => {
  it('renders a row for every strike in the fixture', () => {
    const strikes = [
      makeStrike({ strike: 6900, score: 72.4 }),
      makeStrike({ strike: 6850, type: 'put', score: 60.1 }),
      makeStrike({ strike: 6800, type: 'put', score: 45.0 }),
    ];
    render(<OptionsFlowTable {...BASE_PROPS} strikes={strikes} />);
    // 3 data rows under the tbody
    const rows = screen.getAllByRole('row');
    // header row + 3 data rows
    expect(rows).toHaveLength(4);
  });

  it('defaults to Score descending', () => {
    const strikes = [
      makeStrike({ strike: 6800, score: 40 }),
      makeStrike({ strike: 6900, score: 90 }),
      makeStrike({ strike: 6850, score: 65 }),
    ];
    render(<OptionsFlowTable {...BASE_PROPS} strikes={strikes} />);

    // First data row should be the 6900 strike (highest score)
    const bodyRows = screen.getAllByRole('row').slice(1) as HTMLElement[];
    expect(within(bodyRows[0]!).getByText('6,900')).toBeInTheDocument();
    expect(within(bodyRows[1]!).getByText('6,850')).toBeInTheDocument();
    expect(within(bodyRows[2]!).getByText('6,800')).toBeInTheDocument();

    // The Score column header should indicate aria-sort=descending
    const scoreHeader = screen.getByRole('columnheader', { name: /score/i });
    expect(scoreHeader).toHaveAttribute('aria-sort', 'descending');
  });

  it('re-sorts by Premium when the Premium header is clicked', async () => {
    const user = userEvent.setup();
    const strikes = [
      makeStrike({ strike: 6800, total_premium: 10_000, score: 90 }),
      makeStrike({ strike: 6900, total_premium: 999_999, score: 10 }),
      makeStrike({ strike: 6850, total_premium: 500_000, score: 50 }),
    ];
    render(<OptionsFlowTable {...BASE_PROPS} strikes={strikes} />);

    await user.click(screen.getByRole('button', { name: /premium/i }));

    const bodyRows = screen.getAllByRole('row').slice(1) as HTMLElement[];
    // Sorted by premium desc: 6900 (999k), 6850 (500k), 6800 (10k)
    expect(within(bodyRows[0]!).getByText('6,900')).toBeInTheDocument();
    expect(within(bodyRows[1]!).getByText('6,850')).toBeInTheDocument();
    expect(within(bodyRows[2]!).getByText('6,800')).toBeInTheDocument();
  });

  it('toggles direction when the same column is clicked twice', async () => {
    const user = userEvent.setup();
    const strikes = [
      makeStrike({ strike: 6800, total_premium: 10_000, score: 90 }),
      makeStrike({ strike: 6900, total_premium: 999_999, score: 10 }),
    ];
    render(<OptionsFlowTable {...BASE_PROPS} strikes={strikes} />);

    const premiumBtn = screen.getByRole('button', { name: /premium/i });
    // First click → desc (6900 first)
    await user.click(premiumBtn);
    let rows = screen.getAllByRole('row').slice(1) as HTMLElement[];
    expect(within(rows[0]!).getByText('6,900')).toBeInTheDocument();

    // Second click → asc (6800 first)
    await user.click(premiumBtn);
    rows = screen.getAllByRole('row').slice(1) as HTMLElement[];
    expect(within(rows[0]!).getByText('6,800')).toBeInTheDocument();

    const premiumHeader = screen.getByRole('columnheader', {
      name: /premium/i,
    });
    expect(premiumHeader).toHaveAttribute('aria-sort', 'ascending');
  });

  it('renders a Multileg badge only when has_multileg=true', () => {
    const strikes = [
      makeStrike({ strike: 6900, has_multileg: true }),
      makeStrike({ strike: 6850, has_multileg: false }),
    ];
    render(<OptionsFlowTable {...BASE_PROPS} strikes={strikes} />);

    const multilegBadges = screen.getAllByText('Multileg');
    expect(multilegBadges).toHaveLength(1);
  });

  it('renders an ascending-fill badge when has_ascending_fill=true', () => {
    const strikes = [
      makeStrike({ strike: 6900, has_ascending_fill: true }),
      makeStrike({ strike: 6850, has_ascending_fill: false }),
    ];
    render(<OptionsFlowTable {...BASE_PROPS} strikes={strikes} />);

    expect(screen.getByText(/Ascending/)).toBeInTheDocument();
  });

  it('shows the empty state when strikes is empty and not loading', () => {
    render(
      <OptionsFlowTable
        {...BASE_PROPS}
        strikes={[]}
        isLoading={false}
        windowMinutes={15}
      />,
    );
    expect(screen.getByText(/no active flow clusters/i)).toBeInTheDocument();
    expect(screen.getByText(/15 minutes/i)).toBeInTheDocument();
  });

  it('shows the loading state when strikes is empty and isLoading=true', () => {
    render(<OptionsFlowTable {...BASE_PROPS} strikes={[]} isLoading={true} />);
    expect(screen.getByText(/loading flow/i)).toBeInTheDocument();
  });

  it('shows a generic error message and does not leak error.message', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <OptionsFlowTable
        {...BASE_PROPS}
        strikes={[]}
        error={new Error('boom-supersecret')}
      />,
    );
    expect(screen.getByText(/couldn't load flow/i)).toBeInTheDocument();
    expect(screen.queryByText(/boom-supersecret/i)).not.toBeInTheDocument();
    consoleSpy.mockRestore();
  });

  it('side badges use distinct color classes for call vs put', () => {
    const strikes = [
      makeStrike({ strike: 6900, type: 'call' }),
      makeStrike({ strike: 6800, type: 'put' }),
    ];
    render(<OptionsFlowTable {...BASE_PROPS} strikes={strikes} />);

    const callBadge = screen.getByLabelText('Call');
    const putBadge = screen.getByLabelText('Put');
    expect(callBadge.className).toMatch(/emerald-400|green-400/);
    expect(putBadge.className).toMatch(/rose-400|red-400/);
  });

  it('displays the alert count in the header', () => {
    render(
      <OptionsFlowTable
        {...BASE_PROPS}
        strikes={[makeStrike()]}
        alertCount={42}
      />,
    );
    expect(screen.getByText(/42 alerts/)).toBeInTheDocument();
  });

  it('displays the spot price in the header when provided', () => {
    render(
      <OptionsFlowTable
        {...BASE_PROPS}
        strikes={[makeStrike()]}
        spot={6850.25}
      />,
    );
    expect(screen.getByText(/6,850\.25/)).toBeInTheDocument();
  });

  it('renders a Net GEX column header', () => {
    render(
      <OptionsFlowTable
        {...BASE_PROPS}
        strikes={[makeStrike({ strike: 6900 })]}
      />,
    );
    expect(
      screen.getByRole('columnheader', { name: /net gex/i }),
    ).toBeInTheDocument();
  });

  it('renders signed-dollar GEX with emerald color when strike is in lookup map', () => {
    const strikes = [makeStrike({ strike: 6900 })];
    render(
      <OptionsFlowTable
        {...BASE_PROPS}
        strikes={strikes}
        gexByStrike={new Map([[6900, 120_000_000]])}
      />,
    );
    const cell = screen.getByText('+$120M');
    expect(cell).toBeInTheDocument();
    expect(cell.className).toMatch(/text-emerald-400/);
  });

  it('renders em-dash when strike is not present in the lookup map', () => {
    const strikes = [
      makeStrike({ strike: 6900, score: 90 }),
      makeStrike({ strike: 6800, score: 50 }),
    ];
    render(
      <OptionsFlowTable
        {...BASE_PROPS}
        strikes={strikes}
        gexByStrike={new Map([[6900, 120_000_000]])}
      />,
    );
    // 6800 has no entry -> em-dash. Find that row's cells and check the
    // Net GEX cell (index 1, 0-based, after Strike).
    const bodyRows = screen.getAllByRole('row').slice(1) as HTMLElement[];
    const row6800 = bodyRows.find((r) => within(r).queryByText('6,800'))!;
    const cells = within(row6800).getAllByRole('cell');
    expect(cells[1]!.textContent).toBe('—');
  });

  it('renders rose-400 color and signed-minus for negative GEX', () => {
    const strikes = [makeStrike({ strike: 6800 })];
    render(
      <OptionsFlowTable
        {...BASE_PROPS}
        strikes={strikes}
        gexByStrike={new Map([[6800, -80_000_000]])}
      />,
    );
    const cell = screen.getByText('-$80M');
    expect(cell).toBeInTheDocument();
    expect(cell.className).toMatch(/text-rose-400/);
  });

  it('renders em-dash in every Net GEX cell when gexByStrike prop is omitted', () => {
    const strikes = [
      makeStrike({ strike: 6900 }),
      makeStrike({ strike: 6800, type: 'put' }),
      makeStrike({ strike: 6700, type: 'put' }),
    ];
    render(<OptionsFlowTable {...BASE_PROPS} strikes={strikes} />);
    const bodyRows = screen.getAllByRole('row').slice(1) as HTMLElement[];
    for (const row of bodyRows) {
      const cells = within(row).getAllByRole('cell');
      // Net GEX is column index 1 (after Strike at 0).
      expect(cells[1]!.textContent).toBe('—');
    }
  });

  it('renders AGG badge and emerald row tint for aggressive strikes', () => {
    const strikes = [
      makeStrike({ strike: 6900, ask_side_ratio: 0.85 }),
      makeStrike({ strike: 6850, ask_side_ratio: 0.45, type: 'put' }),
      makeStrike({ strike: 6800, ask_side_ratio: 0.15, type: 'put' }),
    ];
    render(<OptionsFlowTable {...BASE_PROPS} strikes={strikes} />);

    const bodyRows = screen.getAllByRole('row').slice(1) as HTMLElement[];
    const aggRow = bodyRows.find((r) => within(r).queryByText('6,900'))!;
    expect(within(aggRow).getByText('AGG')).toBeInTheDocument();
    expect(aggRow.className).toMatch(/bg-emerald-500\/\[0\.03\]/);
  });

  it('renders ABS badge and amber row tint for absorbed strikes', () => {
    const strikes = [
      makeStrike({ strike: 6900, ask_side_ratio: 0.85 }),
      makeStrike({ strike: 6850, ask_side_ratio: 0.45, type: 'put' }),
      makeStrike({ strike: 6800, ask_side_ratio: 0.15, type: 'put' }),
    ];
    render(<OptionsFlowTable {...BASE_PROPS} strikes={strikes} />);

    const bodyRows = screen.getAllByRole('row').slice(1) as HTMLElement[];
    const absRow = bodyRows.find((r) => within(r).queryByText('6,800'))!;
    expect(within(absRow).getByText('ABS')).toBeInTheDocument();
    expect(absRow.className).toMatch(/bg-amber-500\/\[0\.03\]/);
  });

  it('renders no aggression badge and no tint for mixed strikes', () => {
    const strikes = [
      makeStrike({ strike: 6900, ask_side_ratio: 0.85 }),
      makeStrike({ strike: 6850, ask_side_ratio: 0.45, type: 'put' }),
      makeStrike({ strike: 6800, ask_side_ratio: 0.15, type: 'put' }),
    ];
    render(<OptionsFlowTable {...BASE_PROPS} strikes={strikes} />);

    const bodyRows = screen.getAllByRole('row').slice(1) as HTMLElement[];
    const mixedRow = bodyRows.find((r) => within(r).queryByText('6,850'))!;
    expect(within(mixedRow).queryByText('AGG')).not.toBeInTheDocument();
    expect(within(mixedRow).queryByText('ABS')).not.toBeInTheDocument();
    expect(mixedRow.className).not.toMatch(/bg-emerald-500\/\[0\.03\]/);
    expect(mixedRow.className).not.toMatch(/bg-amber-500\/\[0\.03\]/);
  });

  it('sort by Net GEX places rows missing a lookup entry at the bottom in both directions', async () => {
    const user = userEvent.setup();
    const strikes = [
      makeStrike({ strike: 6900, score: 10 }),
      makeStrike({ strike: 6800, score: 20 }),
      makeStrike({ strike: 6700, score: 30 }),
    ];
    const gexByStrike = new Map<number, number>([
      [6900, 120_000_000],
      [6800, -80_000_000],
      // 6700 is intentionally absent — must sort last regardless of direction
    ]);
    render(
      <OptionsFlowTable
        {...BASE_PROPS}
        strikes={strikes}
        gexByStrike={gexByStrike}
      />,
    );

    const netGexBtn = screen.getByRole('button', { name: /net gex/i });
    // First click → desc. Present values descending: +120M (6900), -80M (6800),
    // missing (6700) last.
    await user.click(netGexBtn);
    let rows = screen.getAllByRole('row').slice(1) as HTMLElement[];
    expect(within(rows[0]!).getByText('6,900')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('6,800')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('6,700')).toBeInTheDocument();

    // Second click → asc. Present values ascending: -80M (6800), +120M (6900),
    // missing (6700) still last.
    await user.click(netGexBtn);
    rows = screen.getAllByRole('row').slice(1) as HTMLElement[];
    expect(within(rows[0]!).getByText('6,800')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('6,900')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('6,700')).toBeInTheDocument();
  });
});
