import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PreTradeSignals from '../components/PreTradeSignals';
import { lightTheme } from '../themes';
import type {
  QuotesResponse,
  YesterdayResponse,
  MoversResponse,
  QuoteSlice,
  MoverSlice,
} from '../types/api';

const th = lightTheme;

// ============================================================
// HELPERS
// ============================================================

function makeQuote(overrides: Partial<QuoteSlice> = {}): QuoteSlice {
  return {
    price: 5800,
    open: 5790,
    high: 5820,
    low: 5770,
    prevClose: 5780,
    change: 10,
    changePct: 0.17,
    ...overrides,
  };
}

function makeQuotes(
  overrides: Partial<{
    spx: Partial<QuoteSlice>;
    vix: Partial<QuoteSlice>;
  }> = {},
): QuotesResponse {
  return {
    spy: makeQuote(),
    spx: makeQuote(overrides.spx ?? {}),
    vix: makeQuote({ price: 18, open: 18, prevClose: 17, ...overrides.vix }),
    vix1d: null,
    vix9d: null,
    vvix: null,
    marketOpen: true,
    asOf: '2026-03-12T10:00:00Z',
  };
}

function makeYesterday(rangePct = 0.5): YesterdayResponse {
  return {
    yesterday: {
      date: '2026-03-11',
      open: 5780,
      high: 5810,
      low: 5770,
      close: 5800,
      rangePct,
      rangePts: 40,
    },
    twoDaysAgo: null,
    asOf: '2026-03-12T10:00:00Z',
  };
}

function makeMover(overrides: Partial<MoverSlice> = {}): MoverSlice {
  return {
    symbol: 'AAPL',
    name: 'Apple Inc',
    change: 2.5,
    price: 220,
    volume: 5_000_000,
    ...overrides,
  };
}

function makeMovers(
  overrides: Partial<MoversResponse['analysis']> = {},
): MoversResponse {
  return {
    up: [
      makeMover(),
      makeMover({ symbol: 'MSFT', name: 'Microsoft', change: 1.8 }),
    ],
    down: [makeMover({ symbol: 'TSLA', name: 'Tesla', change: -3.1 })],
    analysis: {
      concentrated: false,
      megaCapCount: 2,
      megaCapSymbols: ['AAPL', 'MSFT'],
      bias: 'bullish',
      topUp: makeMover(),
      topDown: makeMover({ symbol: 'TSLA', change: -3.1 }),
      ...overrides,
    },
    marketOpen: true,
    asOf: '2026-03-12T10:00:00Z',
  };
}

// ============================================================
// RENDER TESTS
// ============================================================

describe('PreTradeSignals', () => {
  it('renders nothing when all data is null', () => {
    const { container } = render(
      <PreTradeSignals th={th} quotes={null} yesterday={null} movers={null} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders the section heading when signals exist', () => {
    render(
      <PreTradeSignals
        th={th}
        quotes={makeQuotes()}
        yesterday={makeYesterday()}
        movers={null}
      />,
    );
    expect(screen.getByText('Pre-Trade Signals')).toBeInTheDocument();
  });

  // --------------------------------------------------------
  // Realized vs Implied Vol (#5)
  // --------------------------------------------------------
  describe('RV/IV signal', () => {
    it('shows green / PREMIUM RICH when ratio < 0.8', () => {
      // VIX prevClose = 20 → predicted daily = 20/15.874 ≈ 1.261%
      // rangePct = 0.5 → ratio ≈ 0.397 → green
      render(
        <PreTradeSignals
          th={th}
          quotes={makeQuotes({ vix: { prevClose: 20 } })}
          yesterday={makeYesterday(0.5)}
          movers={null}
        />,
      );
      expect(screen.getByText('PREMIUM RICH')).toBeInTheDocument();
      expect(screen.getByText('Realized vs. Implied Vol')).toBeInTheDocument();
    });

    it('shows yellow / FAIR VALUE when ratio 0.8–1.2', () => {
      // VIX prevClose = 15 → predicted = 0.945%
      // rangePct = 0.9 → ratio ≈ 0.952 → yellow
      render(
        <PreTradeSignals
          th={th}
          quotes={makeQuotes({ vix: { prevClose: 15 } })}
          yesterday={makeYesterday(0.9)}
          movers={null}
        />,
      );
      expect(screen.getByText('FAIR VALUE')).toBeInTheDocument();
    });

    it('shows red / PREMIUM CHEAP when ratio > 1.2', () => {
      // VIX prevClose = 12 → predicted = 0.756%
      // rangePct = 1.5 → ratio ≈ 1.984 → red
      render(
        <PreTradeSignals
          th={th}
          quotes={makeQuotes({ vix: { prevClose: 12 } })}
          yesterday={makeYesterday(1.5)}
          movers={null}
        />,
      );
      expect(screen.getByText('PREMIUM CHEAP')).toBeInTheDocument();
    });

    it('does not render when yesterday data is missing', () => {
      render(
        <PreTradeSignals
          th={th}
          quotes={makeQuotes()}
          yesterday={null}
          movers={null}
        />,
      );
      expect(
        screen.queryByText('Realized vs. Implied Vol'),
      ).not.toBeInTheDocument();
    });
  });

  // --------------------------------------------------------
  // Overnight Gap (#6)
  // --------------------------------------------------------
  describe('Overnight Gap signal', () => {
    it('shows green / FLAT OPEN when gap < 0.3%', () => {
      // prevClose = 5780, open = 5790 → gap ≈ 0.17% → green
      render(
        <PreTradeSignals
          th={th}
          quotes={makeQuotes({ spx: { open: 5790, prevClose: 5780 } })}
          yesterday={null}
          movers={null}
        />,
      );
      expect(screen.getByText('FLAT OPEN')).toBeInTheDocument();
      expect(screen.getByText('Overnight Gap')).toBeInTheDocument();
    });

    it('shows yellow / MODERATE GAP for 0.3–0.7% gap up', () => {
      // prevClose = 5000, open = 5025 → gap = 0.5% → yellow
      render(
        <PreTradeSignals
          th={th}
          quotes={makeQuotes({ spx: { open: 5025, prevClose: 5000 } })}
          yesterday={null}
          movers={null}
        />,
      );
      expect(screen.getByText('MODERATE GAP')).toBeInTheDocument();
      expect(screen.getByText(/gapped up/)).toBeInTheDocument();
    });

    it('shows red / LARGE GAP for > 0.7% gap down', () => {
      // prevClose = 5000, open = 4950 → gap = -1.0% → red
      render(
        <PreTradeSignals
          th={th}
          quotes={makeQuotes({ spx: { open: 4950, prevClose: 5000 } })}
          yesterday={null}
          movers={null}
        />,
      );
      expect(screen.getByText('LARGE GAP')).toBeInTheDocument();
      expect(screen.getByText(/gap of/)).toBeInTheDocument();
      expect(screen.getByText(/put/)).toBeInTheDocument();
    });

    it('shows LARGE GAP up and mentions call side', () => {
      // prevClose = 5000, open = 5050 → gap = +1.0% → red, up
      render(
        <PreTradeSignals
          th={th}
          quotes={makeQuotes({ spx: { open: 5050, prevClose: 5000 } })}
          yesterday={null}
          movers={null}
        />,
      );
      expect(screen.getByText('LARGE GAP')).toBeInTheDocument();
      expect(screen.getByText(/call/)).toBeInTheDocument();
    });

    it('does not render when spx data is missing', () => {
      const quotes: QuotesResponse = {
        spy: null,
        spx: null,
        vix: null,
        vix1d: null,
        vix9d: null,
        vvix: null,
        marketOpen: true,
        asOf: '2026-03-12T10:00:00Z',
      };
      render(
        <PreTradeSignals
          th={th}
          quotes={quotes}
          yesterday={null}
          movers={null}
        />,
      );
      expect(screen.queryByText('Overnight Gap')).not.toBeInTheDocument();
    });
  });

  // --------------------------------------------------------
  // Move Breadth (#7)
  // --------------------------------------------------------
  describe('Move Breadth signal', () => {
    it('shows green / CONCENTRATED when move is concentrated', () => {
      render(
        <PreTradeSignals
          th={th}
          quotes={null}
          yesterday={null}
          movers={makeMovers({ concentrated: true, megaCapCount: 1 })}
        />,
      );
      expect(screen.getByText('CONCENTRATED')).toBeInTheDocument();
      expect(screen.getByText('Move Breadth')).toBeInTheDocument();
    });

    it('shows yellow / BROAD / MIXED when not concentrated and bias is mixed', () => {
      render(
        <PreTradeSignals
          th={th}
          quotes={null}
          yesterday={null}
          movers={makeMovers({ concentrated: false, bias: 'mixed' })}
        />,
      );
      expect(screen.getByText('BROAD / MIXED')).toBeInTheDocument();
    });

    it('shows red / BROAD RALLY for broad bullish', () => {
      render(
        <PreTradeSignals
          th={th}
          quotes={null}
          yesterday={null}
          movers={makeMovers({ concentrated: false, bias: 'bullish' })}
        />,
      );
      expect(screen.getByText('BROAD RALLY')).toBeInTheDocument();
      expect(screen.getByText(/call/)).toBeInTheDocument();
    });

    it('shows red / BROAD SELLOFF for broad bearish', () => {
      render(
        <PreTradeSignals
          th={th}
          quotes={null}
          yesterday={null}
          movers={makeMovers({ concentrated: false, bias: 'bearish' })}
        />,
      );
      expect(screen.getByText('BROAD SELLOFF')).toBeInTheDocument();
      expect(screen.getByText(/put/)).toBeInTheDocument();
    });

    it('does not render when movers is null', () => {
      render(
        <PreTradeSignals
          th={th}
          quotes={null}
          yesterday={null}
          movers={null}
        />,
      );
      expect(screen.queryByText('Move Breadth')).not.toBeInTheDocument();
    });

    it('does not render when movers has zero total movers', () => {
      const emptyMovers: MoversResponse = {
        up: [],
        down: [],
        analysis: {
          concentrated: false,
          megaCapCount: 0,
          megaCapSymbols: [],
          bias: 'mixed',
          topUp: null,
          topDown: null,
        },
        marketOpen: true,
        asOf: '2026-03-12T10:00:00Z',
      };
      render(
        <PreTradeSignals
          th={th}
          quotes={null}
          yesterday={null}
          movers={emptyMovers}
        />,
      );
      expect(screen.queryByText('Move Breadth')).not.toBeInTheDocument();
    });
  });

  // --------------------------------------------------------
  // All three signals together
  // --------------------------------------------------------
  it('renders all three signal cards when all data is provided', () => {
    render(
      <PreTradeSignals
        th={th}
        quotes={makeQuotes({
          vix: { prevClose: 20 },
          spx: { open: 5790, prevClose: 5780 },
        })}
        yesterday={makeYesterday(0.5)}
        movers={makeMovers({ concentrated: true })}
      />,
    );
    expect(screen.getByText('Realized vs. Implied Vol')).toBeInTheDocument();
    expect(screen.getByText('Overnight Gap')).toBeInTheDocument();
    expect(screen.getByText('Move Breadth')).toBeInTheDocument();
  });
});
