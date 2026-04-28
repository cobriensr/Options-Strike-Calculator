import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { OpeningBlocksCard } from '../components/InstitutionalProgram/OpeningBlocksCard';
import type { InstitutionalBlock } from '../hooks/useInstitutionalProgram';

// ============================================================
// FACTORIES
// ============================================================

function makeBlock(
  overrides: Partial<InstitutionalBlock> = {},
): InstitutionalBlock {
  return {
    executed_at: '2026-04-27T13:35:00.000Z',
    option_chain_id: 'SPXW260427C5800',
    strike: 5800,
    option_type: 'call',
    dte: 0,
    size: 100,
    premium: 250_000,
    price: 25,
    side: 'BUY',
    condition: 'mfsl',
    exchange: 'CBOE',
    underlying_price: 5800,
    moneyness_pct: 0,
    program_track: 'opening_atm',
    ...overrides,
  };
}

// ============================================================
// OpeningBlocksCard
// ============================================================

describe('OpeningBlocksCard', () => {
  it('renders an empty-state message when there are no opening_atm blocks', () => {
    render(<OpeningBlocksCard blocks={[]} />);
    expect(
      screen.getByText(/No opening-hour institutional blocks/),
    ).toBeInTheDocument();
    expect(screen.getByText(/for today/)).toBeInTheDocument();
  });

  it('uses the dateLabel prop in the empty-state message when provided', () => {
    render(<OpeningBlocksCard blocks={[]} dateLabel="2026-04-25" />);
    expect(screen.getByText(/for 2026-04-25/)).toBeInTheDocument();
  });

  it('filters out non-opening_atm blocks', () => {
    const blocks = [
      makeBlock({ program_track: 'opening_atm', strike: 5790 }),
      makeBlock({ program_track: 'ceiling', strike: 6000 }),
      makeBlock({ program_track: 'other', strike: 5500 }),
    ];
    render(<OpeningBlocksCard blocks={blocks} />);
    // Only the opening_atm row should render → exactly 1 data row.
    const rows = document.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(screen.getByText('5790')).toBeInTheDocument();
    expect(screen.queryByText('6000')).not.toBeInTheDocument();
  });

  it('formats premium under $1M as $k with no decimals (when ≥ $10k)', () => {
    render(<OpeningBlocksCard blocks={[makeBlock({ premium: 250_000 })]} />);
    expect(screen.getByText('$250k')).toBeInTheDocument();
  });

  it('formats premium >= $1M as $M with two decimals', () => {
    render(<OpeningBlocksCard blocks={[makeBlock({ premium: 1_500_000 })]} />);
    expect(screen.getByText('$1.50M')).toBeInTheDocument();
  });

  it('formats premium under $10k with one decimal', () => {
    render(<OpeningBlocksCard blocks={[makeBlock({ premium: 5_500 })]} />);
    expect(screen.getByText('$5.5k')).toBeInTheDocument();
  });

  it('renders an em-dash for non-finite premium (defensive)', () => {
    render(
      <OpeningBlocksCard
        blocks={[makeBlock({ premium: 'NaN' as unknown as number })]}
      />,
    );
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('toggles sort direction when clicking the same column header twice', () => {
    const blocks = [
      makeBlock({ strike: 5750 }),
      makeBlock({ strike: 5800 }),
      makeBlock({ strike: 5775 }),
    ];
    render(<OpeningBlocksCard blocks={blocks} />);
    const strikeHeader = screen.getByText('Strike').closest('th')!;
    fireEvent.click(strikeHeader); // strike asc → 5750, 5775, 5800

    // After click: sort is now strike, the toggle starts new key with desc
    // (per source: setSortDir('desc')). So 5800 first.
    const cellsAfterFirst = within(document.querySelector('tbody')!)
      .getAllByText(/57\d\d|58\d\d/)
      .map((el) => el.textContent);
    expect(cellsAfterFirst[0]).toBe('5800');

    fireEvent.click(strikeHeader); // toggles to asc → 5750 first
    const cellsAfterSecond = within(document.querySelector('tbody')!)
      .getAllByText(/57\d\d|58\d\d/)
      .map((el) => el.textContent);
    expect(cellsAfterSecond[0]).toBe('5750');
  });

  it('marks the active sort header with aria-sort matching the direction', () => {
    render(
      <OpeningBlocksCard blocks={[makeBlock(), makeBlock({ strike: 5810 })]} />,
    );
    // Default sort is "time desc" — Time header should be aria-sort="descending".
    const timeHeader = screen.getByText('Time (CT)').closest('th')!;
    expect(timeHeader).toHaveAttribute('aria-sort', 'descending');

    // Click Strike → becomes the active key, descending.
    const strikeHeader = screen.getByText('Strike').closest('th')!;
    fireEvent.click(strikeHeader);
    expect(strikeHeader).toHaveAttribute('aria-sort', 'descending');
    expect(timeHeader).toHaveAttribute('aria-sort', 'none');
  });

  it('numerically sorts premium (avoids string-lexical bug like "$1.5M" < "$896k")', () => {
    const blocks = [
      makeBlock({ executed_at: '2026-04-27T13:00:00Z', premium: 896_000 }),
      makeBlock({ executed_at: '2026-04-27T13:30:00Z', premium: 1_500_000 }),
      makeBlock({ executed_at: '2026-04-27T13:45:00Z', premium: 250_000 }),
    ];
    render(<OpeningBlocksCard blocks={blocks} />);
    fireEvent.click(screen.getByText('Premium').closest('th')!);
    // Default direction on new key = desc → 1.5M first.
    const tbody = document.querySelector('tbody')!;
    const rows = within(tbody).getAllByRole('row');
    expect(within(rows[0]!).getByText('$1.50M')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('$896k')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('$250k')).toBeInTheDocument();
  });

  it('renders the "1 block" singular header when exactly one block is present', () => {
    render(<OpeningBlocksCard blocks={[makeBlock()]} />);
    expect(screen.getByText(/1 block —/)).toBeInTheDocument();
  });
});
