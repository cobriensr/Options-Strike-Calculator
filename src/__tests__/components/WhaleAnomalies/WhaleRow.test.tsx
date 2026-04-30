import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WhaleRow } from '../../../components/WhaleAnomalies/WhaleRow';
import type { WhaleAnomaly } from '../../../components/WhaleAnomalies/types';

function makeWhale(over: Partial<WhaleAnomaly> = {}): WhaleAnomaly {
  return {
    id: 1,
    ticker: 'SPXW',
    option_chain: 'SPXW260429P07150000',
    strike: 7150,
    option_type: 'put',
    expiry: '2026-04-29',
    first_ts: '2026-04-29T16:56:52Z',
    last_ts: '2026-04-29T19:33:07Z',
    detected_at: '2026-04-29T16:57:00Z',
    side: 'BID',
    ask_pct: 0.05,
    total_premium: 12_037_400,
    trade_count: 5,
    vol_oi_ratio: 10.2,
    underlying_price: 7120.12,
    moneyness: 0.0042,
    dte: 0,
    whale_type: 1,
    direction: 'bullish',
    pairing_status: 'sequential',
    source: 'eod_backfill',
    resolved_at: null,
    hit_target: null,
    pct_to_target: null,
    ...over,
  };
}

describe('WhaleRow', () => {
  it('renders ticker, strike, and option type', () => {
    render(<WhaleRow whale={makeWhale()} />);
    expect(screen.getByText('SPXW 7150P')).toBeInTheDocument();
  });

  it('renders the contract link to UW with the OCC symbol', () => {
    render(<WhaleRow whale={makeWhale()} />);
    const link = screen.getByTestId('whale-row-contract-link');
    expect(link).toHaveAttribute(
      'href',
      'https://unusualwhales.com/option-chain/SPXW260429P07150000',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders the Type label and bullish arrow for Type 1', () => {
    render(<WhaleRow whale={makeWhale({ whale_type: 1, direction: 'bullish' })} />);
    expect(screen.getByText(/▲ Type 1 — Floor/)).toBeInTheDocument();
  });

  it('renders the Type label and bearish arrow for Type 2', () => {
    render(
      <WhaleRow
        whale={makeWhale({ whale_type: 2, direction: 'bearish', option_type: 'call' })}
      />,
    );
    expect(screen.getByText(/▼ Type 2 — Ceiling$/)).toBeInTheDocument();
  });

  it('shows the BID side badge', () => {
    render(<WhaleRow whale={makeWhale({ side: 'BID' })} />);
    expect(screen.getByText('BID')).toBeInTheDocument();
  });

  it('shows the ASK side badge', () => {
    render(<WhaleRow whale={makeWhale({ side: 'ASK' })} />);
    expect(screen.getByText('ASK')).toBeInTheDocument();
  });

  it('shows the ROLL badge for sequential pairing', () => {
    render(<WhaleRow whale={makeWhale({ pairing_status: 'sequential' })} />);
    expect(screen.getByText('ROLL')).toBeInTheDocument();
  });

  it('does not show the ROLL badge for alone pairing', () => {
    render(<WhaleRow whale={makeWhale({ pairing_status: 'alone' })} />);
    expect(screen.queryByText('ROLL')).not.toBeInTheDocument();
  });

  it('shows the EOD badge for backfilled rows', () => {
    render(<WhaleRow whale={makeWhale({ source: 'eod_backfill' })} />);
    expect(screen.getByText('EOD')).toBeInTheDocument();
  });

  it('does not show the EOD badge for live rows', () => {
    render(<WhaleRow whale={makeWhale({ source: 'live' })} />);
    expect(screen.queryByText('EOD')).not.toBeInTheDocument();
  });

  it('formats premium as $XX.XM for millions', () => {
    render(<WhaleRow whale={makeWhale({ total_premium: 12_037_400 })} />);
    expect(screen.getByText('$12.0M')).toBeInTheDocument();
  });

  it('renders pending resolution by default', () => {
    render(<WhaleRow whale={makeWhale({ resolved_at: null, hit_target: null })} />);
    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  it('renders hit resolution when hit_target=true', () => {
    render(
      <WhaleRow
        whale={makeWhale({
          resolved_at: '2026-04-29T20:00:00Z',
          hit_target: true,
          pct_to_target: 0.0042,
        })}
      />,
    );
    expect(screen.getByText('hit')).toBeInTheDocument();
  });

  it('renders miss resolution when hit_target=false', () => {
    render(
      <WhaleRow
        whale={makeWhale({
          resolved_at: '2026-04-29T20:00:00Z',
          hit_target: false,
          pct_to_target: -0.012,
        })}
      />,
    );
    expect(screen.getByText('miss')).toBeInTheDocument();
  });

  it('handles missing underlying_price gracefully (NDXP case)', () => {
    render(
      <WhaleRow
        whale={makeWhale({
          ticker: 'NDXP',
          underlying_price: null,
          moneyness: null,
        })}
      />,
    );
    // Spot and moneyness columns should both show '—'.
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });
});
