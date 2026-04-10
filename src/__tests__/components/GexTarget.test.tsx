import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GexTarget } from '../../components/GexTarget';
import type { UseGexTargetReturn } from '../../hooks/useGexTarget';
import type {
  StrikeScore,
  TargetScore,
  MagnetFeatures,
  ComponentScores,
} from '../../utils/gex-target';

// ── Mocks ─────────────────────────────────────────────────

vi.mock('../../hooks/useGexTarget', () => ({
  useGexTarget: vi.fn(),
}));

vi.mock('../../components/GexTarget/TargetTile', () => ({
  TargetTile: () => <div data-testid="target-tile" />,
}));

vi.mock('../../components/GexTarget/UrgencyPanel', () => ({
  UrgencyPanel: () => <div data-testid="urgency-panel" />,
}));

vi.mock('../../components/GexTarget/SparklinePanel', () => ({
  SparklinePanel: () => <div data-testid="sparkline-panel" />,
}));

vi.mock('../../components/GexTarget/StrikeBox', () => ({
  StrikeBox: () => <div data-testid="strike-box" />,
}));

vi.mock('../../components/GexTarget/PriceChart', () => ({
  PriceChart: () => <div data-testid="price-chart" />,
}));

import { useGexTarget } from '../../hooks/useGexTarget';

// ── Fixture helpers ────────────────────────────────────────

function makeFeatures(overrides: Partial<MagnetFeatures> = {}): MagnetFeatures {
  return {
    strike: 5800,
    spot: 5795,
    distFromSpot: 5,
    gexDollars: 1_000_000_000,
    callGexDollars: 600_000_000,
    putGexDollars: 400_000_000,
    callDelta: null,
    putDelta: null,
    deltaGex_1m: 10_000_000,
    deltaGex_5m: 50_000_000,
    deltaGex_20m: 150_000_000,
    deltaGex_60m: 300_000_000,
    prevGexDollars_1m: 990_000_000,
    prevGexDollars_5m: 950_000_000,
    prevGexDollars_20m: 850_000_000,
    prevGexDollars_60m: 700_000_000,
    deltaPct_1m: 0.01,
    deltaPct_5m: 0.053,
    deltaPct_20m: 0.18,
    deltaPct_60m: 0.43,
    callRatio: 0.2,
    charmNet: 1e7,
    deltaNet: 5e8,
    vannaNet: 1e7,
    minutesAfterNoonCT: 60,
    ...overrides,
  };
}

function makeComponents(
  overrides: Partial<ComponentScores> = {},
): ComponentScores {
  return {
    flowConfluence: 0.6,
    priceConfirm: 0.4,
    charmScore: 0.3,
    dominance: 0.7,
    clarity: 0.8,
    proximity: 0.9,
    ...overrides,
  };
}

function makeStrike(overrides: Partial<StrikeScore> = {}): StrikeScore {
  return {
    strike: 5800,
    features: makeFeatures(),
    components: makeComponents(),
    finalScore: 0.55,
    tier: 'HIGH',
    wallSide: 'CALL',
    rankByScore: 1,
    rankBySize: 2,
    isTarget: true,
    ...overrides,
  };
}

function makeTargetScore(overrides: Partial<TargetScore> = {}): TargetScore {
  return {
    target: makeStrike(),
    leaderboard: [makeStrike()],
    ...overrides,
  };
}

/**
 * Returns a fully-populated UseGexTargetReturn suitable for most tests.
 * Override only the fields each test cares about.
 */
function makeHookResult(
  overrides: Partial<UseGexTargetReturn> = {},
): UseGexTargetReturn {
  return {
    oi: makeTargetScore(),
    vol: makeTargetScore(),
    dir: makeTargetScore(),
    spot: 5795,
    timestamp: new Date(Date.now() - 30_000).toISOString(),
    timestamps: [],
    candles: [],
    visibleCandles: [],
    previousClose: 5780,
    openingCallStrike: null,
    openingPutStrike: null,
    selectedDate: '2026-04-07',
    setSelectedDate: vi.fn(),
    availableDates: ['2026-04-07'],
    isLive: true,
    isScrubbed: false,
    canScrubPrev: false,
    canScrubNext: false,
    scrubPrev: vi.fn(),
    scrubNext: vi.fn(),
    scrubLive: vi.fn(),
    loading: false,
    error: null,
    refresh: vi.fn(),
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(useGexTarget).mockReturnValue(makeHookResult());
});

// ── Tests ─────────────────────────────────────────────────

describe('GexTarget: loading state', () => {
  it('renders loading indicator and no panel content', () => {
    vi.mocked(useGexTarget).mockReturnValue(
      makeHookResult({ loading: true, oi: null, vol: null, dir: null }),
    );

    render(<GexTarget marketOpen={false} />);

    expect(screen.getByText(/loading gex target/i)).toBeInTheDocument();
    expect(screen.queryByTestId('target-tile')).not.toBeInTheDocument();
    expect(screen.queryByTestId('urgency-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sparkline-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('strike-box')).not.toBeInTheDocument();
  });
});

describe('GexTarget: error state', () => {
  it('renders the error message and a retry button', () => {
    const refresh = vi.fn();
    vi.mocked(useGexTarget).mockReturnValue(
      makeHookResult({ loading: false, error: 'Network error', refresh }),
    );

    render(<GexTarget marketOpen={false} />);

    expect(screen.getByText('Network error')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: /retry/i });
    fireEvent.click(retryBtn);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('GexTarget: live state', () => {
  it('shows LIVE badge and all four sub-panel testids', () => {
    vi.mocked(useGexTarget).mockReturnValue(
      makeHookResult({ isLive: true, isScrubbed: false }),
    );

    render(<GexTarget marketOpen={true} />);

    expect(screen.getByText(/● live/i)).toBeInTheDocument();
    expect(screen.getByTestId('target-tile')).toBeInTheDocument();
    expect(screen.getByTestId('urgency-panel')).toBeInTheDocument();
    expect(screen.getByTestId('sparkline-panel')).toBeInTheDocument();
    expect(screen.getByTestId('strike-box')).toBeInTheDocument();
  });
});

describe('GexTarget: backtest state', () => {
  it('shows BACKTEST badge when not live and not scrubbed', () => {
    vi.mocked(useGexTarget).mockReturnValue(
      makeHookResult({ isLive: false, isScrubbed: false }),
    );

    render(<GexTarget marketOpen={false} />);

    expect(screen.getByText('BACKTEST')).toBeInTheDocument();
  });
});

describe('GexTarget: scrubbed state', () => {
  it('shows SCRUBBED badge when isScrubbed is true', () => {
    vi.mocked(useGexTarget).mockReturnValue(
      makeHookResult({ isLive: false, isScrubbed: true }),
    );

    render(<GexTarget marketOpen={true} />);

    expect(screen.getByText('SCRUBBED')).toBeInTheDocument();
  });
});

describe('GexTarget: mode toggle', () => {
  it('switches from OI to VOL when VOL chip is clicked', () => {
    render(<GexTarget marketOpen={true} />);

    const volChip = screen.getByRole('button', { name: 'VOL' });
    expect(volChip).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(volChip);

    expect(volChip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'OI' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('switches from OI to DIR when DIR chip is clicked', () => {
    render(<GexTarget marketOpen={true} />);

    const dirChip = screen.getByRole('button', { name: 'DIR' });
    expect(dirChip).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(dirChip);

    expect(dirChip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'OI' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

describe('GexTarget: scrubber controls', () => {
  it('calls scrubPrev when prev button is clicked and canScrubPrev is true', () => {
    const scrubPrev = vi.fn();
    vi.mocked(useGexTarget).mockReturnValue(
      makeHookResult({ canScrubPrev: true, scrubPrev }),
    );

    render(<GexTarget marketOpen={true} />);

    const prevBtn = screen.getByRole('button', {
      name: /previous snapshot/i,
    });
    expect(prevBtn).not.toBeDisabled();
    fireEvent.click(prevBtn);
    expect(scrubPrev).toHaveBeenCalledTimes(1);
  });

  it('disables the next snapshot button when canScrubNext is false', () => {
    vi.mocked(useGexTarget).mockReturnValue(
      makeHookResult({ canScrubNext: false }),
    );

    render(<GexTarget marketOpen={true} />);

    const nextBtn = screen.getByRole('button', { name: /next snapshot/i });
    expect(nextBtn).toBeDisabled();
  });
});

describe('GexTarget: data-availability banner', () => {
  it('shows banner when selectedDate is not in availableDates', () => {
    vi.mocked(useGexTarget).mockReturnValue(
      makeHookResult({
        availableDates: ['2026-04-07'],
        selectedDate: '2026-04-01',
      }),
    );

    render(<GexTarget marketOpen={false} />);

    expect(screen.getByText(/no data for this date/i)).toBeInTheDocument();
  });

  it('hides banner when selectedDate is in availableDates', () => {
    vi.mocked(useGexTarget).mockReturnValue(
      makeHookResult({
        availableDates: ['2026-04-07'],
        selectedDate: '2026-04-07',
      }),
    );

    render(<GexTarget marketOpen={false} />);

    expect(
      screen.queryByText(/no data for this date/i),
    ).not.toBeInTheDocument();
  });
});
