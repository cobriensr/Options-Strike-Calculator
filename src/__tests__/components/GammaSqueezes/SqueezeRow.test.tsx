import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SqueezeRow } from '../../../components/GammaSqueezes/SqueezeRow';
import type {
  ActiveSqueeze,
  GammaSqueezeRow,
} from '../../../components/GammaSqueezes/types';

function makeRow(over: Partial<GammaSqueezeRow> = {}): GammaSqueezeRow {
  return {
    id: 1,
    ticker: 'NVDA',
    strike: 212.5,
    side: 'call',
    expiry: '2026-04-28',
    ts: '2026-04-28T15:35:00Z',
    spotAtDetect: 211.4,
    pctFromStrike: -0.0052,
    spotTrend5m: 0.0012,
    volOi15m: 8.4,
    volOi15mPrior: 3.1,
    volOiAcceleration: 5.3,
    volOiTotal: 11.5,
    netGammaSign: 'unknown',
    squeezePhase: 'forming',
    contextSnapshot: null,
    spotAtClose: null,
    reachedStrike: null,
    maxCallPnlPct: null,
    freshnessMin: 0,
    progressPct: null,
    isStale: false,
    ...over,
  };
}

function makeActive(over: Partial<GammaSqueezeRow> = {}): ActiveSqueeze {
  const row = makeRow(over);
  return {
    compoundKey: `${row.ticker}:${row.strike}:${row.side}:${row.expiry}`,
    ticker: row.ticker as ActiveSqueeze['ticker'],
    strike: row.strike,
    side: row.side,
    expiry: row.expiry,
    latest: row,
    firstSeenTs: row.ts,
    lastFiredTs: row.ts,
    firingCount: 1,
  };
}

describe('SqueezeRow', () => {
  it('renders ticker / strike / side identity for a call', () => {
    render(<SqueezeRow squeeze={makeActive()} />);
    expect(screen.getByText(/NVDA/)).toBeInTheDocument();
    expect(screen.getByText(/212\.5/)).toBeInTheDocument();
    expect(screen.getByText(/↑/)).toBeInTheDocument();
  });

  it('renders down-arrow for puts', () => {
    render(<SqueezeRow squeeze={makeActive({ side: 'put', strike: 100 })} />);
    expect(screen.getByText(/↓/)).toBeInTheDocument();
  });

  it('renders forming phase pill in amber and active in rose', () => {
    const { rerender } = render(
      <SqueezeRow squeeze={makeActive({ squeezePhase: 'forming' })} />,
    );
    expect(screen.getByTestId('squeeze-phase-forming')).toHaveClass(
      'bg-amber-500/25',
    );
    rerender(<SqueezeRow squeeze={makeActive({ squeezePhase: 'active' })} />);
    expect(screen.getByTestId('squeeze-phase-active')).toHaveClass(
      'bg-rose-500/25',
    );
  });

  it('renders velocity and acceleration', () => {
    render(<SqueezeRow squeeze={makeActive()} />);
    expect(screen.getByText(/vel 8\.4×/)).toBeInTheDocument();
    expect(screen.getByText(/accel \+5\.3×/)).toBeInTheDocument();
  });

  it('renders net-gamma sign with the correct title', () => {
    render(<SqueezeRow squeeze={makeActive({ netGammaSign: 'short' })} />);
    const ndg = screen.getByText(/γ short/);
    expect(ndg).toHaveAttribute(
      'title',
      expect.stringContaining('Dealers net SHORT gamma'),
    );
  });
});
