import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PinRiskAnalysis from '../../components/PinRiskAnalysis';
import type { ChainResponse, ChainStrike } from '../../types/api';

function makeStrike(
  strike: number,
  oi: number,
  overrides: Partial<ChainStrike> = {},
): ChainStrike {
  return {
    strike,
    bid: 1,
    ask: 2,
    mid: 1.5,
    delta: -0.1,
    gamma: 0.001,
    theta: -0.5,
    vega: 0.1,
    iv: 0.2,
    volume: 100,
    oi,
    itm: false,
    ...overrides,
  };
}

function makeChain(puts: ChainStrike[], calls: ChainStrike[]): ChainResponse {
  return {
    underlying: { symbol: '$SPX', price: 5700, prevClose: 5690 },
    expirationDate: '2026-03-15',
    daysToExpiration: 0,
    contractCount: puts.length + calls.length,
    puts,
    calls,
    targetDeltas: {},
    asOf: new Date().toISOString(),
  };
}

describe('PinRiskAnalysis', () => {
  it('renders the OI table with strikes sorted by total OI', () => {
    const chain = makeChain(
      [makeStrike(5650, 5000), makeStrike(5700, 15000)],
      [makeStrike(5650, 3000), makeStrike(5700, 10000)],
    );
    render(<PinRiskAnalysis chain={chain} spot={5700} />);
    expect(screen.getByText('Strike')).toBeInTheDocument();
    expect(screen.getByText('Put OI')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
  });

  it('shows PIN RISK warning when high OI strike is within 0.5% of spot', () => {
    const chain = makeChain(
      [makeStrike(5700, 20000)],
      [makeStrike(5700, 15000)],
    );
    render(<PinRiskAnalysis chain={chain} spot={5700} />);
    expect(screen.getByText('PIN RISK')).toBeInTheDocument();
  });

  it('does not show PIN RISK when high OI strikes are far from spot', () => {
    const chain = makeChain(
      [makeStrike(5500, 20000)],
      [makeStrike(5900, 15000)],
    );
    render(<PinRiskAnalysis chain={chain} spot={5700} />);
    expect(screen.queryByText('PIN RISK')).not.toBeInTheDocument();
  });

  it('shows empty state when no OI data', () => {
    const chain = makeChain([makeStrike(5700, 0)], [makeStrike(5700, 0)]);
    render(<PinRiskAnalysis chain={chain} spot={5700} />);
    expect(screen.getByText(/No open interest data/)).toBeInTheDocument();
  });

  it('limits to top 8 strikes', () => {
    const puts = Array.from({ length: 12 }, (_, i) =>
      makeStrike(5600 + i * 10, 1000 * (12 - i)),
    );
    const calls = puts.map((p) => makeStrike(p.strike, 500));
    const chain = makeChain(puts, calls);
    render(<PinRiskAnalysis chain={chain} spot={5700} />);
    const rows = screen.getAllByRole('row');
    // 1 header + 8 data rows
    expect(rows.length).toBe(9);
  });

  it('shows PIN label on near-spot strikes', () => {
    const chain = makeChain(
      [makeStrike(5700, 10000), makeStrike(5600, 5000)],
      [makeStrike(5700, 8000), makeStrike(5800, 3000)],
    );
    render(<PinRiskAnalysis chain={chain} spot={5700} />);
    expect(screen.getByText('PIN')).toBeInTheDocument();
  });

  it('formats large OI values with K suffix', () => {
    const chain = makeChain(
      [makeStrike(5700, 15000)],
      [makeStrike(5700, 10000)],
    );
    render(<PinRiskAnalysis chain={chain} spot={5700} />);
    expect(screen.getByText('15.0K')).toBeInTheDocument();
    expect(screen.getByText('25.0K')).toBeInTheDocument(); // total
  });
});
