import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { TodayProgramCard } from '../components/InstitutionalProgram/TodayProgramCard';
import type {
  DailyProgramSummary,
  InstitutionalBlock,
} from '../hooks/useInstitutionalProgram';

// ============================================================
// FACTORIES
// ============================================================

function makeToday(
  overrides: Partial<DailyProgramSummary> = {},
): DailyProgramSummary {
  return {
    date: '2026-04-27',
    dominant_pair: {
      low_strike: 5790,
      high_strike: 5810,
      spread_width: 20,
      total_size: 500,
      total_premium: 250_000,
      direction: 'sell',
    },
    avg_spot: 5800,
    ceiling_pct_above_spot: 0.012,
    n_blocks: 5,
    n_call_blocks: 3,
    n_put_blocks: 2,
    ...overrides,
  };
}

function makeBlock(
  overrides: Partial<InstitutionalBlock> = {},
): InstitutionalBlock {
  return {
    executed_at: '2026-04-27T13:35:00.000Z',
    option_chain_id: 'SPXW260427C5800',
    strike: 5800,
    option_type: 'call',
    dte: 30,
    size: 100,
    premium: 250_000,
    price: 25,
    side: 'BUY',
    condition: 'mfsl',
    exchange: 'CBOE',
    underlying_price: 5800,
    moneyness_pct: 0,
    program_track: 'ceiling',
    ...overrides,
  };
}

// ============================================================
// TodayProgramCard
// ============================================================

describe('TodayProgramCard', () => {
  it('renders the empty-state message when today is null', () => {
    render(<TodayProgramCard today={null} blocks={[]} />);
    expect(
      screen.getByText(/No paired institutional ceiling blocks/),
    ).toBeInTheDocument();
  });

  it('renders the empty-state message when today exists but dominant_pair is null', () => {
    render(
      <TodayProgramCard
        today={makeToday({ dominant_pair: null })}
        blocks={[]}
      />,
    );
    expect(
      screen.getByText(/No paired institutional ceiling blocks/),
    ).toBeInTheDocument();
  });

  it('renders the spread, direction, contracts, premium, spot, and ceiling metrics', () => {
    render(<TodayProgramCard today={makeToday()} blocks={[]} />);
    expect(screen.getByText('5790 / 5810')).toBeInTheDocument();
    expect(screen.getByText('SELL')).toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();
    expect(screen.getByText('$250k')).toBeInTheDocument();
    expect(screen.getByText('5800.00')).toBeInTheDocument();
    expect(screen.getByText('1.2%')).toBeInTheDocument();
  });

  it('shows green tone for SELL direction', () => {
    const { container } = render(
      <TodayProgramCard
        today={makeToday({
          dominant_pair: {
            low_strike: 5790,
            high_strike: 5810,
            spread_width: 20,
            total_size: 100,
            total_premium: 50_000,
            direction: 'sell',
          },
        })}
        blocks={[]}
      />,
    );
    const sellMetric = container.querySelector('.text-green-300');
    expect(sellMetric?.textContent).toBe('SELL');
  });

  it('shows red tone for BUY direction', () => {
    const { container } = render(
      <TodayProgramCard
        today={makeToday({
          dominant_pair: {
            low_strike: 5790,
            high_strike: 5810,
            spread_width: 20,
            total_size: 100,
            total_premium: 50_000,
            direction: 'buy',
          },
        })}
        blocks={[]}
      />,
    );
    const buyMetric = container.querySelector('.text-red-300');
    expect(buyMetric?.textContent).toBe('BUY');
  });

  it('shows gray tone for MIXED direction', () => {
    const { container } = render(
      <TodayProgramCard
        today={makeToday({
          dominant_pair: {
            low_strike: 5790,
            high_strike: 5810,
            spread_width: 20,
            total_size: 100,
            total_premium: 50_000,
            direction: 'mixed',
          },
        })}
        blocks={[]}
      />,
    );
    const mixedMetric = container.querySelector(
      '.text-slate-400.text-lg.font-semibold',
    );
    expect(mixedMetric?.textContent).toBe('MIXED');
  });

  it('only includes ceiling-track blocks in the expandable details', () => {
    const blocks = [
      makeBlock({ program_track: 'ceiling', strike: 5900 }),
      makeBlock({ program_track: 'opening_atm', strike: 5800 }),
      makeBlock({ program_track: 'other', strike: 5500 }),
    ];
    render(<TodayProgramCard today={makeToday()} blocks={blocks} />);
    expect(
      screen.getByText(/All ceiling blocks today \(1\)/),
    ).toBeInTheDocument();
  });

  it('renders an em-dash for blocks with null side', () => {
    const blocks = [makeBlock({ side: null, program_track: 'ceiling' })];
    render(<TodayProgramCard today={makeToday()} blocks={blocks} />);
    // Open the details so the table is queryable.
    fireEvent.click(screen.getByText(/All ceiling blocks today/));
    const tbody = document.querySelector('tbody')!;
    // The "—" is in the side column; AnomalyRow / Metric also use em-dash —
    // scope to the table body to avoid false-matches elsewhere.
    expect(within(tbody).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('numerically sorts the ceiling table by premium descending on first click', () => {
    const blocks = [
      makeBlock({
        program_track: 'ceiling',
        strike: 5900,
        executed_at: '2026-04-27T13:00:00Z',
        premium: 800_000,
      }),
      makeBlock({
        program_track: 'ceiling',
        strike: 5910,
        executed_at: '2026-04-27T13:30:00Z',
        premium: 1_500_000,
      }),
      makeBlock({
        program_track: 'ceiling',
        strike: 5920,
        executed_at: '2026-04-27T13:45:00Z',
        premium: 250_000,
      }),
    ];
    render(<TodayProgramCard today={makeToday()} blocks={blocks} />);
    fireEvent.click(screen.getByText(/All ceiling blocks today/));
    // "Premium" appears twice in the DOM (metric label + table header).
    // Scope to the table thead so we click the header.
    const thead = document.querySelector('thead')!;
    fireEvent.click(within(thead).getByText('Premium').closest('th')!);

    const tbody = document.querySelector('tbody')!;
    const rows = within(tbody).getAllByRole('row');
    expect(within(rows[0]!).getByText('$1.50M')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('$800k')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('$250k')).toBeInTheDocument();
  });

  it('toggles to ascending when clicking the active sort column twice', () => {
    const blocks = [
      makeBlock({
        program_track: 'ceiling',
        executed_at: '2026-04-27T13:00:00Z',
        strike: 5800,
      }),
      makeBlock({
        program_track: 'ceiling',
        executed_at: '2026-04-27T13:30:00Z',
        strike: 5810,
      }),
    ];
    render(<TodayProgramCard today={makeToday()} blocks={blocks} />);
    fireEvent.click(screen.getByText(/All ceiling blocks today/));
    const strikeHeader = screen.getByText('Strike').closest('th')!;
    fireEvent.click(strikeHeader); // active=strike, dir=desc
    expect(strikeHeader).toHaveAttribute('aria-sort', 'descending');
    fireEvent.click(strikeHeader); // toggle to asc
    expect(strikeHeader).toHaveAttribute('aria-sort', 'ascending');
  });

  it('coerces string-typed Neon DOUBLE PRECISION values for display', () => {
    const today = makeToday({
      dominant_pair: {
        low_strike: '5790' as unknown as number,
        high_strike: '5810' as unknown as number,
        spread_width: 20,
        total_size: '500' as unknown as number,
        total_premium: '250000' as unknown as number,
        direction: 'sell',
      },
      avg_spot: '5800' as unknown as number,
      ceiling_pct_above_spot: '0.012' as unknown as number,
    });
    render(<TodayProgramCard today={today} blocks={[]} />);
    expect(screen.getByText('5790 / 5810')).toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();
    expect(screen.getByText('$250k')).toBeInTheDocument();
    expect(screen.getByText('5800.00')).toBeInTheDocument();
    expect(screen.getByText('1.2%')).toBeInTheDocument();
  });
});
