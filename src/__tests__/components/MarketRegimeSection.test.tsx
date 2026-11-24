import type { ComponentProps } from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MarketRegimeSection from '../../components/MarketRegimeSection';
import type { CalculationResults, DeltaRow } from '../../types';
import type { HistorySnapshot } from '../../hooks/useHistoryData';
import type { MarketDataState } from '../../hooks/useMarketData';
import type { ComputedSignals } from '../../hooks/useComputedSignals';
import type { ClusterMultiplier } from '../../hooks/useClusterMultiplier';
import type {
  ChainResponse,
  ChainStrike,
  DaySummary,
  HistoryCandle,
  QuotesResponse,
} from '../../types/api';
import { computeClusterSignal } from '../../utils/volatility-cluster';

// The badge polls /api/flow-regime (owner-or-guest). Replaced by a spy on its
// props so the section's own wiring is what is read, and so no render here
// fires that fetch.
const { flowRegimeBadge } = vi.hoisted(() => ({ flowRegimeBadge: vi.fn() }));
vi.mock('../../components/FlowRegimeBadge', () => ({
  default: (props: unknown) => {
    flowRegimeBadge(props);
    return null;
  },
}));

const defaultSignals: ComputedSignals = {
  vix1d: undefined,
  vix9d: undefined,
  vvix: undefined,
  sigmaSource: 'VIX × 1.15',
  etHour: 10,
  etMinute: 0,
  regimeZone: null,
  dowLabel: null,
  dowMultHL: null,
  dowMultOC: null,
  icCeiling: null,
  putSpreadCeiling: null,
  callSpreadCeiling: null,
  moderateDelta: null,
  conservativeDelta: null,
  medianOcPct: null,
  medianHlPct: null,
  p90OcPct: null,
  p90HlPct: null,
  p90OcPts: null,
  p90HlPts: null,
  openingRangeAvailable: false,
  openingRangeHigh: null,
  openingRangeLow: null,
  openingRangePctConsumed: null,
  openingRangeSignal: null,
  vixTermSignal: null,
  vixTermShape: null,
  vixTermShapeAdvice: null,
  clusterPutMult: null,
  clusterCallMult: null,
  rvIvRatio: null,
  rvIvLabel: null,
  rvAnnualized: null,
  spxOpen: null,
  spxHigh: null,
  spxLow: null,
  prevClose: null,
  overnightGap: null,
  isEarlyClose: false,
  isEventDay: false,
  eventNames: [],
  dataNote: undefined,
};

function makeDeltaRow(delta: 5 | 8 | 10 | 12 | 15 | 20 = 10): DeltaRow {
  return {
    delta,
    z: 1.28,
    putStrike: 5630.5,
    callStrike: 5769.5,
    putSnapped: 5630,
    callSnapped: 5770,
    putSpySnapped: 563,
    callSpySnapped: 577,
    spyPut: '563',
    spyCall: '577',
    putDistance: 69.5,
    callDistance: 69.5,
    putPct: '1.22%',
    callPct: '1.22%',
    putPremium: 1.85,
    callPremium: 1.72,
    putSigma: 0.2,
    callSigma: 0.18,
    basePutSigma: 0.19,
    baseCallSigma: 0.17,
    putActualDelta: 0.098,
    callActualDelta: 0.095,
    putGamma: 0.0012,
    callGamma: 0.0011,
    putTheta: -1500,
    callTheta: -1400,
    ivAccelMult: 1,
  };
}

function makeResults(): CalculationResults {
  return {
    allDeltas: [makeDeltaRow(5), makeDeltaRow(10)],
    sigma: 0.23,
    T: 0.003,
    hoursRemaining: 4.87,
    spot: 5700,
    marketHours: 6.5,
  };
}

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

/** App's cluster multiplier before yesterday's range is known: 1, no inputs. */
const noCluster: ClusterMultiplier = {
  signal: { rangePct: null, cluster: null, mult: 1 },
  inputs: { open: '', high: '', low: '' },
  isEdited: false,
  setInput: vi.fn(),
  reset: vi.fn(),
};

describe('MarketRegimeSection', () => {
  it.each([true, false])(
    'hands the flow-regime badge the marketOpen prop (%s), not market.marketOpen',
    (open) => {
      // The prop is App's clock AND owner-or-guest flag. market.marketOpen is
      // the clock alone, so it is set to the opposite to tell them apart.
      render(
        <MarketRegimeSection
          dVix="20"
          results={null}
          errors={{}}
          skewPct={0}
          selectedDate="2026-03-12"
          etToday="2026-03-12"
          market={{ ...mockMarket, marketOpen: !open }}
          marketOpen={open}
          showFlowRegime={true}
          cluster={noCluster}
          signals={defaultSignals}
          chain={null}
        />,
      );

      expect(flowRegimeBadge).toHaveBeenLastCalledWith({ marketOpen: open });
    },
  );

  // /api/flow-regime is owner-or-guest: for a public visitor the badge could
  // only say "No flow regime read yet", which is not true, so it is left out.
  it.each([
    [true, 1],
    [false, 0],
  ])(
    'renders the flow-regime badge only when showFlowRegime is set (%s)',
    (showFlowRegime, renders) => {
      flowRegimeBadge.mockClear();

      render(
        <MarketRegimeSection
          dVix="20"
          results={null}
          errors={{}}
          skewPct={0}
          selectedDate="2026-03-12"
          etToday="2026-03-12"
          market={mockMarket}
          marketOpen={true}
          showFlowRegime={showFlowRegime}
          cluster={noCluster}
          signals={defaultSignals}
          chain={null}
        />,
      );

      expect(flowRegimeBadge).toHaveBeenCalledTimes(renders);
    },
  );

  it('renders section heading', () => {
    render(
      <MarketRegimeSection
        dVix="20"
        results={null}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        etToday="2026-03-12"
        market={mockMarket}
        marketOpen={false}
        showFlowRegime={true}
        cluster={noCluster}
        signals={defaultSignals}
        chain={null}
      />,
    );
    expect(screen.getByText('Market Regime')).toBeInTheDocument();
  });

  it('shows description text', () => {
    render(
      <MarketRegimeSection
        dVix="20"
        results={null}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        etToday="2026-03-12"
        market={mockMarket}
        marketOpen={false}
        showFlowRegime={true}
        cluster={noCluster}
        signals={defaultSignals}
        chain={null}
      />,
    );
    expect(
      screen.getByText(/Historical VIX-to-SPX range correlation/),
    ).toBeInTheDocument();
  });

  it('shows Hide/Show analysis toggle button', () => {
    render(
      <MarketRegimeSection
        dVix="20"
        results={null}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        etToday="2026-03-12"
        market={mockMarket}
        marketOpen={false}
        showFlowRegime={true}
        cluster={noCluster}
        signals={defaultSignals}
        chain={null}
      />,
    );
    // Default is showRegime=true so button says "Hide Analysis"
    expect(screen.getByText('Hide Analysis')).toBeInTheDocument();
  });

  it('toggles analysis visibility', async () => {
    const user = userEvent.setup();
    render(
      <MarketRegimeSection
        dVix="20"
        results={null}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        etToday="2026-03-12"
        market={mockMarket}
        marketOpen={false}
        showFlowRegime={true}
        cluster={noCluster}
        signals={defaultSignals}
        chain={null}
      />,
    );
    await user.click(screen.getByText('Hide Analysis'));
    expect(screen.getByText('Show Analysis')).toBeInTheDocument();
  });

  it('shows VIX bucket badge when results exist', () => {
    render(
      <MarketRegimeSection
        dVix="18.5"
        results={makeResults()}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        etToday="2026-03-12"
        market={mockMarket}
        marketOpen={false}
        showFlowRegime={true}
        cluster={noCluster}
        signals={defaultSignals}
        chain={null}
      />,
    );
    // VIX 18.5 falls in the 18–20 bucket (en-dash). Badge surfaces the
    // bucket label so the collapsed-section header shows the regime band
    // rather than just the raw value. The label also appears in the
    // expanded VIX-bucket table, so two matches are expected.
    expect(screen.getAllByText('VIX 18–20').length).toBeGreaterThanOrEqual(1);
  });

  it('shows dash in VIX badge when dVix is not parseable', () => {
    render(
      <MarketRegimeSection
        dVix=""
        results={makeResults()}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        etToday="2026-03-12"
        market={mockMarket}
        marketOpen={false}
        showFlowRegime={true}
        cluster={noCluster}
        signals={defaultSignals}
        chain={null}
      />,
    );
    expect(screen.getByText('VIX \u2014')).toBeInTheDocument();
  });

  it('passes null vix to VIXRangeAnalysis when dVix is empty', () => {
    // This exercises L74: dVix ? Number.parseFloat(dVix) : null
    render(
      <MarketRegimeSection
        dVix=""
        results={null}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        etToday="2026-03-12"
        market={mockMarket}
        marketOpen={false}
        showFlowRegime={true}
        cluster={noCluster}
        signals={defaultSignals}
        chain={null}
      />,
    );
    // VIXRangeAnalysis still renders (with null vix)
    expect(screen.getByText('Market Regime')).toBeInTheDocument();
  });

  it('renders with historySnapshot for backtest mode', () => {
    const snapshot: HistorySnapshot = {
      spot: 5700,
      spy: 570,
      runningOHLC: { open: 5690, high: 5720, low: 5680, last: 5700 },
      openingRange: { high: 5715, low: 5685, rangePts: 30, complete: true },
      yesterday: {
        date: '2026-03-11',
        open: 5680,
        high: 5710,
        low: 5670,
        close: 5695,
        rangePct: 0.7,
        rangePts: 40,
      },
      vix: 18,
      vixPrevClose: 17.5,
      vix1d: 14,
      vix9d: 16,
      vvix: 90,
      previousClose: 5695,
      candle: {
        datetime: 1710000000000,
        time: '10:00',
        open: 5695,
        high: 5705,
        low: 5690,
        close: 5700,
      },
      candleIndex: 1,
      totalCandles: 4,
    };

    const candles: HistoryCandle[] = [
      {
        datetime: 1710000000000,
        time: '09:30',
        open: 5690,
        high: 5700,
        low: 5685,
        close: 5695,
      },
      {
        datetime: 1710000300000,
        time: '09:35',
        open: 5695,
        high: 5705,
        low: 5690,
        close: 5700,
      },
      {
        datetime: 1710000600000,
        time: '09:40',
        open: 5700,
        high: 5710,
        low: 5695,
        close: 5705,
      },
      {
        datetime: 1710000900000,
        time: '15:55',
        open: 5705,
        high: 5708,
        low: 5698,
        close: 5702,
      },
    ];

    render(
      <MarketRegimeSection
        dVix="18"
        results={makeResults()}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        etToday="2026-03-12"
        market={mockMarket}
        marketOpen={false}
        showFlowRegime={true}
        cluster={noCluster}
        historySnapshot={snapshot}
        historyCandles={candles}
        entryTimeLabel="10:00 AM ET"
        signals={defaultSignals}
        chain={null}
      />,
    );
    expect(screen.getByText('Market Regime')).toBeInTheDocument();
    // SettlementCheck should render since historySnapshot + candles + allDeltas exist
    expect(screen.getByText('Settlement Check')).toBeInTheDocument();
  });

  it('Hide/Show Analysis button has type="button"', () => {
    render(
      <MarketRegimeSection
        dVix="20"
        results={null}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        etToday="2026-03-12"
        market={mockMarket}
        marketOpen={false}
        showFlowRegime={true}
        cluster={noCluster}
        signals={defaultSignals}
        chain={null}
      />,
    );
    // Default showRegime=true so the button reads "Hide Analysis"
    const btn = screen.getByRole('button', { name: 'Hide Analysis' });
    expect(btn).toHaveAttribute('type', 'button');
  });

  it('does not render SettlementCheck when historyCandles is empty', () => {
    const snapshot: HistorySnapshot = {
      spot: 5700,
      spy: 570,
      runningOHLC: { open: 5690, high: 5720, low: 5680, last: 5700 },
      openingRange: null,
      yesterday: null,
      vix: 18,
      vixPrevClose: 17.5,
      vix1d: 14,
      vix9d: 16,
      vvix: 90,
      previousClose: 5695,
      candle: {
        datetime: 1710000000000,
        time: '10:00',
        open: 5695,
        high: 5705,
        low: 5690,
        close: 5700,
      },
      candleIndex: 6,
      totalCandles: 78,
    };

    render(
      <MarketRegimeSection
        dVix="18"
        results={makeResults()}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        etToday="2026-03-12"
        market={mockMarket}
        marketOpen={false}
        showFlowRegime={true}
        cluster={noCluster}
        historySnapshot={snapshot}
        historyCandles={[]}
        signals={defaultSignals}
        chain={null}
      />,
    );
    expect(screen.queryByText('Settlement Check')).not.toBeInTheDocument();
  });

  describe('cluster multiplier (F24)', () => {
    // VIX 20, 174.4 pts / 6681.78 = 2.61% → above p90 → Hot → 1.203.
    const hotCluster: ClusterMultiplier = {
      signal: computeClusterSignal({
        vix: 20,
        spot: 5700,
        open: 6681.78,
        high: 6810.44,
        low: 6636.04,
      }),
      inputs: { open: '6681.78', high: '6810.44', low: '6636.04' },
      isEdited: false,
      setInput: vi.fn(),
      reset: vi.fn(),
    };

    function renderWith(cluster: ClusterMultiplier) {
      render(
        <MarketRegimeSection
          dVix="20"
          results={makeResults()}
          errors={{}}
          skewPct={0}
          selectedDate="2026-03-12"
          etToday="2026-03-12"
          market={mockMarket}
          marketOpen={false}
          showFlowRegime={true}
          cluster={cluster}
          signals={defaultSignals}
          chain={null}
        />,
      );
    }

    it('shows the cluster result and its inputs in the panel', () => {
      renderWith(hotCluster);
      expect(screen.getByText('HIGH CLUSTERING')).toBeInTheDocument();
      expect(screen.getByText('1.203x')).toBeInTheDocument();
      expect(screen.getByLabelText(/yesterday high/i)).toHaveValue('6810.44');
    });

    it('applies the same multiplier in the delta guide', () => {
      renderWith(hotCluster);
      expect(screen.getByText(/1\.20x cluster/)).toBeInTheDocument();
    });

    it('shows no clustering without a range', () => {
      renderWith(noCluster);
      expect(screen.queryByText('HIGH CLUSTERING')).not.toBeInTheDocument();
      expect(screen.queryByText(/x cluster/)).not.toBeInTheDocument();
    });

    it('reports typing in the panel to cluster.setInput', async () => {
      const setInput = vi.fn();
      renderWith({ ...hotCluster, setInput });
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/yesterday low/i), '1');
      expect(setInput).toHaveBeenCalledWith('low', '6636.041');
    });

    it('marks the header badge while an edit is held, with the card closed', () => {
      render(
        <MarketRegimeSection
          dVix="20"
          results={makeResults()}
          errors={{}}
          skewPct={0}
          selectedDate="2026-03-12"
          etToday="2026-03-12"
          market={mockMarket}
          marketOpen={false}
          showFlowRegime={true}
          cluster={{ ...hotCluster, isEdited: true }}
          signals={defaultSignals}
          chain={null}
          defaultCollapsed
        />,
      );
      expect(screen.getByText(/ · cluster edited$/)).toBeInTheDocument();
    });

    it('shows the marker even without a VIX badge', () => {
      render(
        <MarketRegimeSection
          dVix=""
          results={null}
          errors={{}}
          skewPct={0}
          selectedDate="2026-03-12"
          etToday="2026-03-12"
          market={mockMarket}
          marketOpen={false}
          showFlowRegime={true}
          cluster={{ ...noCluster, isEdited: true }}
          signals={defaultSignals}
          chain={null}
          defaultCollapsed
        />,
      );
      expect(screen.getByText('cluster edited')).toBeInTheDocument();
    });

    it('has no marker when nothing is edited', () => {
      renderWith(hotCluster);
      expect(screen.queryByText(/cluster edited/)).not.toBeInTheDocument();
    });

    it('wires the panel Reset to cluster.reset', () => {
      const reset = vi.fn();
      renderWith({ ...hotCluster, isEdited: true, reset });
      fireEvent.click(screen.getByRole('button', { name: 'Reset to data' }));
      expect(reset).toHaveBeenCalledTimes(1);
    });
  });

  // The live feed's yesterday is the day before TODAY. Like quotes and
  // movers, it must not stand in for a history snapshot's.
  describe('Pre-Trade Signals yesterday', () => {
    const RV_IV_CARD = 'Realized vs. Implied Vol';
    const liveYesterday: DaySummary = {
      date: '2026-03-11',
      open: 5700,
      high: 5760,
      low: 5675,
      close: 5740,
      rangePct: 1.5,
      rangePts: 85,
    };
    const quote = (price: number) => ({
      price,
      open: price,
      high: price,
      low: price,
      prevClose: price,
      change: 0,
      changePct: 0,
    });
    const liveQuotes: QuotesResponse = {
      spy: quote(570),
      spx: quote(5700),
      vix: quote(18),
      vix1d: null,
      vix9d: null,
      vvix: null,
      marketOpen: true,
      asOf: '2026-03-12T15:00:00Z',
    };
    const liveMarket: MarketDataState = {
      ...mockMarket,
      data: {
        ...mockMarket.data,
        quotes: liveQuotes,
        yesterday: { yesterday: liveYesterday, twoDaysAgo: null, asOf: '' },
      },
    };
    const snapshotWith = (
      yesterday: HistorySnapshot['yesterday'],
    ): HistorySnapshot => ({
      spot: 5700,
      spy: 570,
      runningOHLC: { open: 5690, high: 5720, low: 5680, last: 5700 },
      openingRange: null,
      yesterday,
      vix: 18,
      vixPrevClose: 18,
      vix1d: 14,
      vix9d: 16,
      vvix: 90,
      previousClose: 5695,
      candle: {
        datetime: 1710000000000,
        time: '10:00',
        open: 5695,
        high: 5705,
        low: 5690,
        close: 5700,
      },
      candleIndex: 6,
      totalCandles: 78,
    });

    function renderWith(historySnapshot?: HistorySnapshot) {
      render(
        <MarketRegimeSection
          dVix="18"
          results={makeResults()}
          errors={{}}
          skewPct={0}
          selectedDate="2026-03-12"
          etToday="2026-03-12"
          market={liveMarket}
          marketOpen={false}
          showFlowRegime={true}
          cluster={noCluster}
          historySnapshot={historySnapshot}
          signals={defaultSignals}
          chain={null}
        />,
      );
    }

    it("shows the snapshot's own previous day", () => {
      renderWith(snapshotWith({ ...liveYesterday, date: '2026-03-10' }));
      expect(screen.getByText(RV_IV_CARD)).toBeInTheDocument();
    });

    it('shows nothing, not the live feed’s day, when the snapshot has no previous day', () => {
      renderWith(snapshotWith(null));
      expect(screen.queryByText(RV_IV_CARD)).not.toBeInTheDocument();
    });

    it('uses the live feed when there is no snapshot (today)', () => {
      renderWith();
      expect(screen.getByText(RV_IV_CARD)).toBeInTheDocument();
    });
  });

  // The opening-range card and the live feed on a past date. At the 8:30 CT
  // open no opening-range bar has ended, so the snapshot's range is null. The
  // card must then be empty: not today's live range, and not a made-up
  // default. Its edits reset at the next slot, which the slot label tells apart
  // where the candle does not (8:30 and 8:35 CT share the first bar, and so do
  // the two slots around a missing SPX bar). A past date with no history
  // snapshot (a weekend, a holiday, a failed fetch, a date older than the
  // history reaches) takes no live values either: the feed is today's.
  describe('the selected date and slot', () => {
    const CANDLE = {
      datetime: 1710000000000,
      time: '09:30',
      open: 6000,
      high: 6003,
      low: 5998,
      close: 6001,
    };
    const PARTIAL_RANGE = {
      high: 6003,
      low: 5998,
      rangePts: 5,
      complete: false,
    };
    const COMPLETE_RANGE = {
      high: 6008,
      low: 5998,
      rangePts: 10,
      complete: true,
    };
    const snapshotAt = (
      openingRange: HistorySnapshot['openingRange'],
      candleIndex: number,
      candle: HistorySnapshot['candle'] = CANDLE,
    ): HistorySnapshot => ({
      spot: 6001,
      spy: 600.1,
      runningOHLC: { open: 6000, high: 6003, low: 5998, last: 6001 },
      openingRange,
      yesterday: null,
      vix: 18,
      vixPrevClose: 18,
      vix1d: 14,
      vix9d: 16,
      vvix: 90,
      previousClose: 5995,
      candle,
      candleIndex,
      totalCandles: 78,
    });
    const quote = (price: number, open: number, prevClose: number) => ({
      price,
      open,
      high: price,
      low: price,
      prevClose,
      change: price - prevClose,
      changePct: ((price - prevClose) / prevClose) * 100,
    });
    const nvda = {
      symbol: 'NVDA',
      name: 'NVIDIA',
      change: 2.1,
      price: 130,
      volume: 1_000_000,
    };
    // Today's live feed, deliberately far from every snapshot here: a 7000/6900
    // opening range, a 1.05% overnight gap and a concentrated move.
    const liveMarket: MarketDataState = {
      ...mockMarket,
      data: {
        ...mockMarket.data,
        quotes: {
          spy: quote(576, 576, 570),
          spx: quote(5780, 5760, 5700),
          vix: quote(18, 18, 17.5),
          vix1d: null,
          vix9d: null,
          vvix: null,
          marketOpen: true,
          asOf: '2026-03-12T15:00:00Z',
        },
        movers: {
          up: [nvda],
          down: [],
          analysis: {
            concentrated: true,
            megaCapCount: 1,
            megaCapSymbols: ['NVDA'],
            bias: 'bullish',
            topUp: nvda,
            topDown: null,
          },
          marketOpen: true,
          asOf: '2026-03-12T15:00:00Z',
        },
        intraday: {
          today: { open: 6950, high: 7000, low: 6900, last: 6980 },
          openingRange: {
            high: 7000,
            low: 6900,
            rangePts: 100,
            minutes: 30,
            complete: true,
          },
          sessionDate: '2026-03-12',
          previousClose: 6940,
          candleCount: 6,
          marketOpen: true,
          asOf: '2026-03-12T15:00:00Z',
        },
      },
    };

    type SectionProps = ComponentProps<typeof MarketRegimeSection>;
    function renderCard(overrides: Partial<SectionProps>) {
      const element = (extra: Partial<SectionProps>) => (
        <MarketRegimeSection
          dVix="18"
          results={makeResults()}
          errors={{}}
          skewPct={0}
          selectedDate="2026-03-12"
          etToday="2026-03-12"
          market={liveMarket}
          marketOpen={false}
          showFlowRegime={false}
          cluster={noCluster}
          signals={defaultSignals}
          chain={null}
          {...overrides}
          {...extra}
        />
      );
      const view = render(element({}));
      return {
        rerenderWith: (extra: Partial<SectionProps>) =>
          view.rerender(element(extra)),
      };
    }

    const highInput = () =>
      screen.getByLabelText(/30-min high/i) as HTMLInputElement;
    const lowInput = () =>
      screen.getByLabelText(/30-min low/i) as HTMLInputElement;

    it('is empty at the open, with no live range and no error, on a past date', () => {
      renderCard({
        historySnapshot: snapshotAt(null, -1),
        entryTimeLabel: '8:30 AM CT',
      });

      expect(highInput().value).toBe('');
      expect(lowInput().value).toBe('');
      expect(
        screen.queryByText(/high must be greater/i),
      ).not.toBeInTheDocument();
      expect(screen.queryByText('RANGE INTACT')).not.toBeInTheDocument();
    });

    it("shows the snapshot's range, not today's live one, when the snapshot has one", () => {
      renderCard({
        historySnapshot: snapshotAt(PARTIAL_RANGE, 0),
        entryTimeLabel: '8:35 AM CT',
      });

      expect(highInput().value).toBe('6003.00');
      expect(lowInput().value).toBe('5998.00');
    });

    it("fills from today's live range when there is no history snapshot", () => {
      renderCard({});

      expect(highInput().value).toBe('7000.00');
      expect(lowInput().value).toBe('6900.00');
    });

    it('drops a range typed at 8:30 CT at the next slot, on the same candle', async () => {
      const user = userEvent.setup();
      const { rerenderWith } = renderCard({
        historySnapshot: snapshotAt(null, -1),
        entryTimeLabel: '8:30 AM CT',
      });
      await user.type(highInput(), '6010');
      await user.type(lowInput(), '5990');
      expect(highInput().value).toBe('6010');
      expect(lowInput().value).toBe('5990');

      rerenderWith({
        historySnapshot: snapshotAt(PARTIAL_RANGE, 0),
        entryTimeLabel: '8:35 AM CT',
      });

      expect(highInput().value).toBe('6003.00');
      expect(lowInput().value).toBe('5998.00');
    });

    it('drops an edit when only the slot label changes, on the same candle and index', async () => {
      // The two slots around a missing SPX bar: the last ended bar does not
      // change, so neither do the candle and its index.
      const user = userEvent.setup();
      const snapshot = snapshotAt(COMPLETE_RANGE, 5);
      const { rerenderWith } = renderCard({
        historySnapshot: snapshot,
        entryTimeLabel: '9:00 AM CT',
      });
      await user.clear(highInput());
      await user.type(highInput(), '6050');
      expect(highInput().value).toBe('6050');

      rerenderWith({ entryTimeLabel: '9:05 AM CT' });

      expect(highInput().value).toBe('6008.00');
    });

    it('keeps an edit while the slot label stays the same, though the candle moves', async () => {
      // A new candle and index under the same label: only the label can be
      // what keeps the card, so the old candle key would drop the edit here.
      const user = userEvent.setup();
      const { rerenderWith } = renderCard({
        historySnapshot: snapshotAt(COMPLETE_RANGE, 5),
        entryTimeLabel: '9:00 AM CT',
      });
      await user.clear(highInput());
      await user.type(highInput(), '6050');

      rerenderWith({
        historySnapshot: snapshotAt(COMPLETE_RANGE, 6, {
          ...CANDLE,
          datetime: CANDLE.datetime + 300_000,
        }),
      });

      expect(highInput().value).toBe('6050');
    });

    it('drops an edit when only the date moves on, at the same slot label', async () => {
      // Two past dates with history, the time picker unchanged.
      const user = userEvent.setup();
      const { rerenderWith } = renderCard({
        selectedDate: '2026-03-10',
        historySnapshot: snapshotAt(COMPLETE_RANGE, 5),
        entryTimeLabel: '9:00 AM CT',
      });
      await user.clear(highInput());
      await user.type(highInput(), '6050');

      rerenderWith({
        selectedDate: '2026-03-09',
        historySnapshot: snapshotAt(COMPLETE_RANGE, 5, {
          ...CANDLE,
          datetime: CANDLE.datetime - 86_400_000,
        }),
      });

      expect(highInput().value).toBe('6008.00');
    });

    it('falls back to the candle and its index when there is no slot label', async () => {
      const user = userEvent.setup();
      const { rerenderWith } = renderCard({
        historySnapshot: snapshotAt(PARTIAL_RANGE, 0),
      });
      await user.clear(highInput());
      await user.type(highInput(), '6050');

      rerenderWith({ historySnapshot: snapshotAt(COMPLETE_RANGE, 5) });

      expect(highInput().value).toBe('6008.00');
    });

    describe('a past date with no history snapshot', () => {
      // A weekend, a holiday, a failed history fetch, or a date older than the
      // history reaches: nothing says what the range was, and today's live
      // range is not it.
      const past = { selectedDate: '2026-03-10', etToday: '2026-03-12' };

      it("is empty, not today's live range", () => {
        renderCard(past);

        expect(highInput().value).toBe('');
        expect(lowInput().value).toBe('');
        expect(
          screen.queryByText(/high must be greater/i),
        ).not.toBeInTheDocument();
        expect(screen.queryByText('RANGE INTACT')).not.toBeInTheDocument();
      });

      it('drops a range typed on one such date when the date moves to another', async () => {
        const user = userEvent.setup();
        const { rerenderWith } = renderCard(past);
        await user.type(highInput(), '6010');
        await user.type(lowInput(), '5990');
        expect(highInput().value).toBe('6010');

        rerenderWith({ selectedDate: '2026-03-09' });

        expect(highInput().value).toBe('');
        expect(lowInput().value).toBe('');
      });

      it("keeps today's live fill when the date is today", () => {
        renderCard({ selectedDate: '2026-03-12', etToday: '2026-03-12' });

        expect(highInput().value).toBe('7000.00');
        expect(lowInput().value).toBe('6900.00');
      });
    });

    // Pre-Trade Signals reads today's quotes (the overnight gap) and today's
    // movers (the breadth). Both are today's, so a past date shows neither,
    // and the card, which renders nothing when it has no signal, is absent.
    describe('Pre-Trade Signals and the live feed', () => {
      const GAP_CARD = 'Overnight Gap';
      const BREADTH_CARD = 'Move Breadth';

      it("shows today's gap and breadth on today", () => {
        renderCard({});

        expect(screen.getByText(GAP_CARD)).toBeInTheDocument();
        expect(screen.getByText(BREADTH_CARD)).toBeInTheDocument();
      });

      it('shows neither on a past date with no history snapshot', () => {
        renderCard({ selectedDate: '2026-03-10', etToday: '2026-03-12' });

        expect(screen.queryByText(GAP_CARD)).not.toBeInTheDocument();
        expect(screen.queryByText(BREADTH_CARD)).not.toBeInTheDocument();
        expect(screen.queryByText('Pre-Trade Signals')).not.toBeInTheDocument();
      });

      it('shows no live gap or breadth on a past date with a snapshot, as before', () => {
        renderCard({
          selectedDate: '2026-03-10',
          etToday: '2026-03-12',
          historySnapshot: snapshotAt(COMPLETE_RANGE, 5),
        });

        expect(screen.queryByText(BREADTH_CARD)).not.toBeInTheDocument();
        // The snapshot's own open and previous close give its own gap.
        expect(screen.getByText(GAP_CARD)).toBeInTheDocument();
        expect(screen.queryByText('+1.05%')).not.toBeInTheDocument();
      });
    });

    // The badge polls today's /api/flow-regime, so a snapshot or a past date
    // (with or without one) shows no badge at all.
    describe('the flow-regime badge', () => {
      beforeEach(() => flowRegimeBadge.mockClear());

      it.each([
        ['renders on today', {}, 1],
        [
          'does not render on a past date with no history snapshot',
          { selectedDate: '2026-03-10' },
          0,
        ],
        [
          'does not render on a past date with a history snapshot',
          {
            selectedDate: '2026-03-10',
            historySnapshot: snapshotAt(COMPLETE_RANGE, 5),
          },
          0,
        ],
        [
          'does not render on today at an earlier slot (a history snapshot)',
          { historySnapshot: snapshotAt(COMPLETE_RANGE, 5) },
          0,
        ],
      ])('the badge %s', (_label, props, renders) => {
        renderCard({ showFlowRegime: true, etToday: '2026-03-12', ...props });

        expect(flowRegimeBadge).toHaveBeenCalledTimes(renders);
      });
    });

    // The Settlement Pin Risk card reads today's option chain: its top-OI
    // strikes are today's, so against a past date's spot it could raise a
    // PIN RISK that is not that date's.
    describe("Settlement Pin Risk and today's option chain", () => {
      const strike = (price: number, oi: number): ChainStrike => ({
        strike: price,
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
      });
      // The spot in these renders is 5700: a high-OI strike right on it.
      const CHAIN: ChainResponse = {
        underlying: { symbol: '$SPX', price: 5700, prevClose: 5690 },
        expirationDate: '2026-03-12',
        daysToExpiration: 0,
        contractCount: 2,
        puts: [strike(5700, 20000)],
        calls: [strike(5700, 15000)],
        targetDeltas: {},
        asOf: '2026-03-12T15:00:00Z',
      };

      it('shows the card, and its PIN RISK, on today', () => {
        renderCard({ chain: CHAIN });

        expect(screen.getByText('Settlement Pin Risk')).toBeInTheDocument();
        expect(screen.getByText('PIN RISK')).toBeInTheDocument();
      });

      it.each([
        [
          'a past date with no history snapshot',
          { selectedDate: '2026-03-10' },
        ],
        [
          'a past date with a history snapshot',
          {
            selectedDate: '2026-03-10',
            historySnapshot: snapshotAt(COMPLETE_RANGE, 5),
          },
        ],
        [
          'today at an earlier slot (a history snapshot)',
          { historySnapshot: snapshotAt(COMPLETE_RANGE, 5) },
        ],
      ])('shows no card on %s', (_label, props) => {
        renderCard({ chain: CHAIN, etToday: '2026-03-12', ...props });

        expect(
          screen.queryByText('Settlement Pin Risk'),
        ).not.toBeInTheDocument();
        expect(screen.queryByText('PIN RISK')).not.toBeInTheDocument();
      });
    });
  });
});
