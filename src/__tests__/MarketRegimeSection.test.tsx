import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MarketRegimeSection from '../components/MarketRegimeSection';
import { lightTheme } from '../themes';
import type { CalculationResults, DeltaRow } from '../types';

const th = lightTheme;

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
      />,
    );
    expect(screen.getByText('VIX 18.5')).toBeInTheDocument();
  });
});
