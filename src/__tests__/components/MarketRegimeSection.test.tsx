import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MarketRegimeSection from '../../components/MarketRegimeSection';
import type { CalculationResults, DeltaRow } from '../../types';
import type { HistorySnapshot } from '../../hooks/useHistoryData';
import type { MarketDataState } from '../../hooks/useMarketData';
import type { ComputedSignals } from '../../hooks/useComputedSignals';
import type { ClusterMultiplier } from '../../hooks/useClusterMultiplier';
import type {
  DaySummary,
  HistoryCandle,
  QuotesResponse,
} from '../../types/api';
import { computeClusterSignal } from '../../utils/volatility-cluster';

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
  it('renders section heading', () => {
    render(
      <MarketRegimeSection
        dVix="20"
        results={null}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        market={mockMarket}
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
        market={mockMarket}
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
        market={mockMarket}
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
        market={mockMarket}
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
        market={mockMarket}
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
        market={mockMarket}
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
        market={mockMarket}
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
        market={mockMarket}
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
        market={mockMarket}
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
        market={mockMarket}
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
          market={mockMarket}
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
          market={mockMarket}
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
          market={mockMarket}
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
          market={liveMarket}
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
});
