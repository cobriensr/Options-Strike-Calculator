import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MarketRegimeSection from '../components/MarketRegimeSection';
import { lightTheme } from '../themes';
import type { CalculationResults, DeltaRow } from '../types';
import type { HistorySnapshot } from '../hooks/useHistoryData';
import type { ComputedSignals } from '../hooks/useComputedSignals';
import type { HistoryCandle } from '../types/api';

const th = lightTheme;

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
    putActualDelta: 0.098,
    callActualDelta: 0.095,
    putGamma: 0.0012,
    callGamma: 0.0011,
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
  };
}

const mockMarket = {
  data: {
    quotes: null,
    yesterday: null,
    movers: null,
    intraday: null,
    events: null,
  },
  loading: false,
  error: null,
  hasData: false,
  needsAuth: false,
  refresh: async () => {},
  lastUpdated: null,
};

describe('MarketRegimeSection', () => {
  it('renders section heading', () => {
    render(
      <MarketRegimeSection
        th={th}
        dVix="20"
        results={null}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        market={mockMarket}
        onClusterMultChange={vi.fn()}
        clusterMult={1.0}
        signals={defaultSignals}
        chain={null}
      />,
    );
    expect(screen.getByText('Market Regime')).toBeInTheDocument();
  });

  it('shows description text', () => {
    render(
      <MarketRegimeSection
        th={th}
        dVix="20"
        results={null}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        market={mockMarket}
        onClusterMultChange={vi.fn()}
        clusterMult={1.0}
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
        th={th}
        dVix="20"
        results={null}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        market={mockMarket}
        onClusterMultChange={vi.fn()}
        clusterMult={1.0}
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
        th={th}
        dVix="20"
        results={null}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        market={mockMarket}
        onClusterMultChange={vi.fn()}
        clusterMult={1.0}
        signals={defaultSignals}
        chain={null}
      />,
    );
    await user.click(screen.getByText('Hide Analysis'));
    expect(screen.getByText('Show Analysis')).toBeInTheDocument();
  });

  it('shows VIX badge when results exist', () => {
    render(
      <MarketRegimeSection
        th={th}
        dVix="18.5"
        results={makeResults()}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        market={mockMarket}
        onClusterMultChange={vi.fn()}
        clusterMult={1.0}
        signals={defaultSignals}
        chain={null}
      />,
    );
    expect(screen.getByText('VIX 18.5')).toBeInTheDocument();
  });

  it('shows dash in VIX badge when dVix is not parseable', () => {
    render(
      <MarketRegimeSection
        th={th}
        dVix=""
        results={makeResults()}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        market={mockMarket}
        onClusterMultChange={vi.fn()}
        clusterMult={1.0}
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
        th={th}
        dVix=""
        results={null}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        market={mockMarket}
        onClusterMultChange={vi.fn()}
        clusterMult={1.0}
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
        th={th}
        dVix="18"
        results={makeResults()}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        market={mockMarket}
        onClusterMultChange={vi.fn()}
        clusterMult={1.0}
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
        th={th}
        dVix="18"
        results={makeResults()}
        errors={{}}
        skewPct={0}
        selectedDate="2026-03-12"
        market={mockMarket}
        onClusterMultChange={vi.fn()}
        clusterMult={1.0}
        historySnapshot={snapshot}
        historyCandles={[]}
        signals={defaultSignals}
        chain={null}
      />,
    );
    expect(screen.queryByText('Settlement Check')).not.toBeInTheDocument();
  });
});
