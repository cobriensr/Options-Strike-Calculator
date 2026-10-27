import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IVInputSection from '../../components/IVInputSection';
import type { MarketDataState } from '../../hooks/useMarketData';
import type { HistorySnapshot } from '../../hooks/useHistoryData';
import { useVixTrajectory } from '../../hooks/useVixTrajectory';
import { getETToday } from '../../utils/timezone';

// The term-structure card's intraday trajectory poll (today's VIX
// snapshots). Mocked so a test can see whether the card asks for it.
vi.mock('../../hooks/useVixTrajectory', () => ({
  useVixTrajectory: vi.fn(() => ({
    hasData: false,
    ratio1d: null,
    ratio9d: null,
    spx: null,
  })),
}));

const mockMarket: MarketDataState = {
  data: {
    quotes: null,
    yesterday: null,
    movers: null,
    intraday: null,
    events: null,
  },
  loading: false,
  hasData: false,
  needsAuth: false,
  fetchedAt: null,
  // FE-STATE-001 quote freshness (staleness derives from it in
  // useQuoteStaleness).
  quotesFetchedAt: null,
  // FE-STATE-002 tri-state session.
  session: 'closed' as const,
  marketOpen: false,
};

function renderSection(overrides: Record<string, unknown> = {}) {
  const defaults = {
    ivMode: 'vix' as const,
    onIvModeChange: vi.fn(),
    vixInput: '',
    onVixChange: vi.fn(),
    multiplier: '1.15',
    onMultiplierChange: vi.fn(),
    directIVInput: '',
    onDirectIVChange: vi.fn(),
    dVix: '',
    results: null,
    errors: {} as Record<string, string>,
    market: mockMarket,
    selectedDate: getETToday(),
    onUseVix1dAsSigma: vi.fn(),
  };
  const props = { ...defaults, ...overrides };
  return { ...render(<IVInputSection {...props} />), props };
}

// ============================================================
// RENDERING
// ============================================================

describe('IVInputSection', () => {
  it('renders section heading "Implied Volatility"', () => {
    renderSection();
    expect(screen.getByText('Implied Volatility')).toBeInTheDocument();
  });

  it('renders VIX mode inputs when ivMode="vix"', () => {
    renderSection({ ivMode: 'vix' });
    expect(screen.getByLabelText('VIX Value')).toBeInTheDocument();
    expect(screen.getByLabelText('0DTE Adj.')).toBeInTheDocument();
  });

  it('renders Direct IV mode inputs when ivMode="direct"', () => {
    renderSection({ ivMode: 'direct' });
    expect(screen.getByLabelText(/σ.*Direct IV/)).toBeInTheDocument();
    expect(screen.getByLabelText('VIX (regime only)')).toBeInTheDocument();
  });

  // ============================================================
  // CALLBACKS
  // ============================================================

  it('calls onVixChange when VIX input changes', async () => {
    const user = userEvent.setup();
    const { props } = renderSection({ ivMode: 'vix' });
    await user.type(screen.getByLabelText('VIX Value'), '2');
    expect(props.onVixChange).toHaveBeenCalledWith('2');
  });

  it('calls onMultiplierChange when adj input changes', async () => {
    const user = userEvent.setup();
    const { props } = renderSection({ ivMode: 'vix' });
    await user.type(screen.getByLabelText('0DTE Adj.'), '5');
    expect(props.onMultiplierChange).toHaveBeenCalled();
  });

  it('calls onDirectIVChange when direct IV input changes', async () => {
    const user = userEvent.setup();
    const { props } = renderSection({ ivMode: 'direct' });
    await user.type(screen.getByLabelText(/σ.*Direct IV/), '0');
    expect(props.onDirectIVChange).toHaveBeenCalledWith('0');
  });

  it('calls onIvModeChange when mode chip clicked', async () => {
    const user = userEvent.setup();
    const { props } = renderSection({ ivMode: 'vix' });
    await user.click(screen.getByText('Direct IV'));
    expect(props.onIvModeChange).toHaveBeenCalledWith('direct');
  });

  // ============================================================
  // TOOLTIP
  // ============================================================

  it('shows tooltip when ? button clicked', async () => {
    const user = userEvent.setup();
    renderSection({ ivMode: 'vix' });
    const btn = screen.getByRole('button', {
      name: /what is the 0dte adjustment/i,
    });
    await user.click(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(screen.getByText('0DTE IV Adjustment')).toBeInTheDocument();
  });

  it('closes tooltip on outside click', async () => {
    const user = userEvent.setup();
    renderSection({ ivMode: 'vix' });
    const btn = screen.getByRole('button', {
      name: /what is the 0dte adjustment/i,
    });
    await user.click(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    // Click outside the tooltip
    await user.click(document.body);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('closes tooltip on Escape key', async () => {
    const user = userEvent.setup();
    renderSection({ ivMode: 'vix' });
    const btn = screen.getByRole('button', {
      name: /what is the 0dte adjustment/i,
    });
    await user.click(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('"?" tooltip button has type="button"', () => {
    renderSection({ ivMode: 'vix' });
    const tooltipBtn = screen.getByRole('button', {
      name: /what is the 0dte adjustment/i,
    });
    expect(tooltipBtn).toHaveAttribute('type', 'button');
  });

  it('calls onVixChange in direct IV mode (regime-only VIX input)', async () => {
    const user = userEvent.setup();
    const { props } = renderSection({ ivMode: 'direct' });
    await user.type(screen.getByLabelText('VIX (regime only)'), '2');
    expect(props.onVixChange).toHaveBeenCalledWith('2');
  });

  // ============================================================
  // ERRORS
  // ============================================================

  it('shows error for vix', () => {
    renderSection({ errors: { vix: 'VIX is required' } });
    expect(screen.getByText('VIX is required')).toBeInTheDocument();
  });

  it('shows error for multiplier', () => {
    renderSection({ errors: { multiplier: 'Invalid multiplier' } });
    expect(screen.getByText('Invalid multiplier')).toBeInTheDocument();
  });

  it('shows error for iv', () => {
    renderSection({ ivMode: 'direct', errors: { iv: 'IV out of range' } });
    expect(screen.getByText('IV out of range')).toBeInTheDocument();
  });

  it('does not show errors when none exist', () => {
    const { container } = renderSection({ errors: {} });
    // ErrorMsg components should not be present
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(
      screen.queryByText(/required|invalid|out of range/i),
    ).not.toBeInTheDocument();
  });

  it('VIX input references its error via aria-describedby when invalid', () => {
    renderSection({ errors: { vix: 'VIX is required' } });
    const input = screen.getByLabelText('VIX Value');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'err-vix');
    expect(screen.getByRole('alert')).toHaveTextContent('VIX is required');
  });

  it('VIX input has no aria-describedby when no error', () => {
    renderSection({ errors: {} });
    const input = screen.getByLabelText('VIX Value');
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('multiplier input combines tooltip and error in aria-describedby when invalid', () => {
    renderSection({ errors: { multiplier: 'Invalid multiplier' } });
    const input = screen.getByLabelText('0DTE Adj.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute(
      'aria-describedby',
      'adj-tooltip-content err-mult',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid multiplier');
  });

  it('multiplier input references only tooltip when no error', () => {
    renderSection({ errors: {} });
    const input = screen.getByLabelText('0DTE Adj.');
    expect(input).toHaveAttribute('aria-describedby', 'adj-tooltip-content');
  });

  it('Direct IV input references its error via aria-describedby when invalid', () => {
    renderSection({
      ivMode: 'direct',
      errors: { iv: 'IV out of range' },
    });
    const input = screen.getByLabelText(/σ.*Direct IV/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'err-iv');
    expect(screen.getByRole('alert')).toHaveTextContent('IV out of range');
  });

  it('Direct IV input has no aria-describedby when no error', () => {
    renderSection({ ivMode: 'direct', errors: {} });
    const input = screen.getByLabelText(/σ.*Direct IV/);
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  // ============================================================
  // SUB-COMPONENTS
  // ============================================================

  it('renders VIXRegimeCard when dVix is valid with results and no errors', () => {
    renderSection({
      dVix: '18',
      results: {
        allDeltas: [],
        sigma: 0.15,
        T: 0.03,
        hoursRemaining: 7,
        spot: 5700,
      },
      errors: {},
    });
    // VIXRegimeCard renders regime zone content (may appear in multiple elements)
    expect(screen.getAllByText(/regime/i).length).toBeGreaterThanOrEqual(1);
  });

  it('renders Term Structure section when dVix is valid', () => {
    renderSection({ dVix: '18', errors: {} });
    expect(screen.getByText('Term Structure')).toBeInTheDocument();
  });

  // ============================================================
  // TERM STRUCTURE: LIVE QUOTES VS THE SELECTED DATE
  // ============================================================

  describe("term structure and today's live quotes", () => {
    const quote = (price: number) => ({
      price,
      open: price,
      high: price,
      low: price,
      prevClose: price,
      change: 0,
      changePct: 0,
    });
    // Today's live quotes: the owner's mount fetch loads them on any date.
    const liveMarket: MarketDataState = {
      ...mockMarket,
      data: {
        ...mockMarket.data,
        quotes: {
          spy: quote(580),
          spx: quote(5820),
          vix: quote(18.5),
          vix1d: quote(14.2),
          vix9d: quote(16.3),
          vvix: quote(95),
          marketOpen: false,
          asOf: '2026-03-17T16:30:00Z',
        },
      },
      hasData: true,
    };

    /** The card on a date with no VIX1D, VIX9D or VVIX: empty, nothing to apply. */
    function expectNothingOffered() {
      expect(screen.getByLabelText(/VIX1D/)).toHaveValue('');
      expect(screen.getByLabelText(/VIX9D/)).toHaveValue('');
      expect(screen.queryByText('VVIX')).not.toBeInTheDocument();
      expect(screen.queryByText('VIX1D / VIX')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /use vix1d as/i }),
      ).not.toBeInTheDocument();
    }

    /** A history snapshot at `datetime`, with no VIX1D, VIX9D or VVIX. */
    function snapshotAt(datetime: number): HistorySnapshot {
      return {
        spot: 5750,
        spy: 575,
        runningOHLC: { open: 5740, high: 5760, low: 5730, last: 5750 },
        openingRange: null,
        yesterday: null,
        vix: 20.5,
        vixPrevClose: 21,
        vix1d: null,
        vix9d: null,
        vvix: null,
        previousClose: 5740,
        candle: {
          datetime,
          time: '11:30',
          open: 5748,
          high: 5752,
          low: 5746,
          close: 5750,
        },
        candleIndex: 24,
        totalCandles: 78,
      };
    }

    // 2026-03-10 11:30 ET
    const PAST_CANDLE = Date.parse('2026-03-10T15:30:00Z');

    it('does not fill a past date without VIX1D, VIX9D or VVIX from live quotes', () => {
      renderSection({
        dVix: '20.5',
        market: liveMarket,
        selectedDate: '2026-03-10',
        historySnapshot: snapshotAt(PAST_CANDLE),
      });

      expectNothingOffered();
    });

    it('does not fill a past date without intraday history from live quotes', () => {
      // Older than ~60 days, a failed history fetch, a weekend or a
      // holiday: no snapshot, and the selected date alone says "past".
      renderSection({
        dVix: '20.5',
        market: liveMarket,
        selectedDate: '2026-03-10',
        historySnapshot: null,
      });

      expectNothingOffered();
    });

    it("drops today's live values when the date moves to a past date without history", () => {
      const { props, rerender } = renderSection({
        dVix: '18.5',
        market: liveMarket,
        selectedDate: getETToday(),
      });
      expect(screen.getByLabelText(/VIX1D/)).toHaveValue('14.20');

      rerender(
        <IVInputSection
          {...props}
          dVix="20.5"
          selectedDate="2026-03-10"
          historySnapshot={null}
        />,
      );

      expectNothingOffered();
      expect(props.onUseVix1dAsSigma).not.toHaveBeenCalled();
    });

    it('drops a VIX1D typed on one past date without history when the date moves to another', async () => {
      const user = userEvent.setup();
      const { props, rerender } = renderSection({
        dVix: '20.5',
        market: liveMarket,
        selectedDate: '2026-03-10',
        historySnapshot: null,
      });
      await user.type(screen.getByLabelText(/VIX1D/), '15.5');
      expect(
        screen.getByRole('button', { name: /use vix1d as/i }),
      ).toBeInTheDocument();

      rerender(
        <IVInputSection
          {...props}
          selectedDate="2026-03-09"
          historySnapshot={null}
        />,
      );

      expectNothingOffered();
    });

    it("does not poll today's VIX trajectory for a past date without history", () => {
      renderSection({
        dVix: '20.5',
        market: { ...liveMarket, marketOpen: true },
        selectedDate: '2026-03-10',
        historySnapshot: null,
      });

      expect(vi.mocked(useVixTrajectory)).toHaveBeenLastCalledWith(false);
    });

    it("polls today's VIX trajectory on today while the market is open", () => {
      renderSection({
        dVix: '18.5',
        market: { ...liveMarket, marketOpen: true },
        selectedDate: getETToday(),
      });

      expect(vi.mocked(useVixTrajectory)).toHaveBeenLastCalledWith(true);
    });

    it('fills today from live quotes, with no snapshot yet', async () => {
      const user = userEvent.setup();
      const { props } = renderSection({
        dVix: '18.5',
        market: liveMarket,
        selectedDate: getETToday(),
      });

      expect(screen.getByLabelText(/VIX1D/)).toHaveValue('14.20');
      expect(screen.getByLabelText(/VIX9D/)).toHaveValue('16.30');
      expect(screen.getByText('VVIX')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /use vix1d as/i }));
      expect(props.onUseVix1dAsSigma).toHaveBeenCalledWith(0.142);
    });

    it("still falls back to live quotes for today's own snapshot", () => {
      // Today's intraday candles make a snapshot too, once the session has
      // some; a field missing from it still comes from the live quote.
      renderSection({
        dVix: '18.5',
        market: liveMarket,
        selectedDate: getETToday(),
        historySnapshot: snapshotAt(Date.now()),
      });

      expect(screen.getByLabelText(/VIX1D/)).toHaveValue('14.20');
      expect(screen.getByLabelText(/VIX9D/)).toHaveValue('16.30');
      expect(screen.getByText('VVIX')).toBeInTheDocument();
    });
  });
});
