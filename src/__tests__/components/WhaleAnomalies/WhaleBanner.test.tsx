// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { WhaleBanner } from '../../../components/WhaleAnomalies/WhaleBanner';
import { whaleBannerStore } from '../../../components/WhaleAnomalies/banner-store';
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
    source: 'live',
    resolved_at: null,
    hit_target: null,
    pct_close_vs_strike: null,
    ...over,
  };
}

describe('WhaleBanner', () => {
  beforeEach(() => {
    // Drain any stale store state from prior tests.
    let entries: { id: number }[] = [];
    const unsub = whaleBannerStore.subscribe((e) => {
      entries = e;
    });
    for (const e of entries) whaleBannerStore.dismiss(e.id);
    unsub();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when the store is empty', () => {
    const { container } = render(<WhaleBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a banner when a whale is pushed', () => {
    render(<WhaleBanner />);
    act(() => {
      whaleBannerStore.push(
        makeWhale({ id: 9001, ticker: 'SPXW', strike: 7150 }),
      );
    });
    expect(screen.getByTestId('whale-banner-9001')).toBeInTheDocument();
    expect(screen.getByText(/SPXW 7150P/)).toBeInTheDocument();
  });

  it('renders the bullish ▲ arrow + Type label', () => {
    render(<WhaleBanner />);
    act(() => {
      whaleBannerStore.push(
        makeWhale({ id: 9002, whale_type: 1, direction: 'bullish' }),
      );
    });
    expect(screen.getByText(/▲/)).toBeInTheDocument();
    expect(screen.getByText(/Type 1/)).toBeInTheDocument();
    expect(screen.getByText(/Floor/)).toBeInTheDocument();
  });

  it('renders the bearish ▼ arrow for bearish whales', () => {
    render(<WhaleBanner />);
    act(() => {
      whaleBannerStore.push(
        makeWhale({
          id: 9003,
          whale_type: 2,
          direction: 'bearish',
          option_type: 'call',
        }),
      );
    });
    expect(screen.getByText(/▼/)).toBeInTheDocument();
  });

  it('shows premium / trade-count / DTE summary', () => {
    render(<WhaleBanner />);
    act(() => {
      whaleBannerStore.push(
        makeWhale({
          id: 9004,
          total_premium: 18_700_000,
          trade_count: 52,
          dte: 7,
        }),
      );
    });
    expect(screen.getByText(/\$18\.7M/)).toBeInTheDocument();
    expect(screen.getByText(/52 trades/)).toBeInTheDocument();
    expect(screen.getByText(/7d/)).toBeInTheDocument();
  });

  it('shows spot + target line when underlying_price is present', () => {
    render(<WhaleBanner />);
    act(() => {
      whaleBannerStore.push(
        makeWhale({ id: 9005, underlying_price: 7120.12, strike: 7150 }),
      );
    });
    expect(screen.getByText(/spot 7120\.12/)).toBeInTheDocument();
    expect(screen.getByText(/target 7150/)).toBeInTheDocument();
  });

  it('omits spot + target line when underlying_price is null', () => {
    render(<WhaleBanner />);
    act(() => {
      whaleBannerStore.push(
        makeWhale({ id: 9006, underlying_price: null, ticker: 'NDXP' }),
      );
    });
    expect(screen.queryByText(/spot/)).not.toBeInTheDocument();
  });

  it('dismisses the banner when × is clicked', () => {
    render(<WhaleBanner />);
    act(() => {
      whaleBannerStore.push(makeWhale({ id: 9007 }));
    });
    expect(screen.getByTestId('whale-banner-9007')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByTestId('whale-banner-9007')).not.toBeInTheDocument();
  });

  it('renders multiple banners stacked', () => {
    render(<WhaleBanner />);
    act(() => {
      whaleBannerStore.push(makeWhale({ id: 9008, ticker: 'SPXW' }));
      whaleBannerStore.push(makeWhale({ id: 9009, ticker: 'NDXP' }));
    });
    expect(screen.getByTestId('whale-banner-9008')).toBeInTheDocument();
    expect(screen.getByTestId('whale-banner-9009')).toBeInTheDocument();
  });
});
