import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TargetTile } from '../../components/GexTarget/TargetTile';
import type {
  TargetScore,
  StrikeScore,
  MagnetFeatures,
} from '../../utils/gex-target';

// ── Fixture helpers ───────────────────────────────────────────────────

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
    deltaGex_1m: null,
    deltaGex_5m: null,
    deltaGex_20m: null,
    deltaGex_60m: null,
    prevGexDollars_1m: null,
    prevGexDollars_5m: null,
    prevGexDollars_20m: null,
    prevGexDollars_60m: null,
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

function makeStrike(overrides: Partial<StrikeScore> = {}): StrikeScore {
  return {
    strike: 5800,
    features: makeFeatures(),
    components: {
      flowConfluence: 0.6,
      priceConfirm: 0.4,
      charmScore: 0.3,
      dominance: 0.7,
      clarity: 0.8,
      proximity: 0.9,
    },
    finalScore: 0.55,
    tier: 'HIGH',
    wallSide: 'CALL',
    rankByScore: 1,
    rankBySize: 1,
    isTarget: true,
    ...overrides,
  };
}

function makeScore(overrides: Partial<TargetScore> = {}): TargetScore {
  return {
    target: makeStrike(),
    leaderboard: [makeStrike()],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('TargetTile: null score', () => {
  it('shows — — placeholder when score is null', () => {
    render(<TargetTile score={null} />);
    expect(screen.getByText('— —')).toBeInTheDocument();
  });

  it('shows waiting message when score is null', () => {
    render(<TargetTile score={null} />);
    expect(screen.getByText(/waiting for scoring data/i)).toBeInTheDocument();
  });

  it('shows No Target label when score is null', () => {
    render(<TargetTile score={null} />);
    expect(screen.getByText(/no target/i)).toBeInTheDocument();
  });

  it('shows — — placeholder when score.target is null', () => {
    render(<TargetTile score={makeScore({ target: null })} />);
    expect(screen.getByText('— —')).toBeInTheDocument();
    expect(screen.getByText(/waiting for scoring data/i)).toBeInTheDocument();
  });
});

describe('TargetTile: NONE tier', () => {
  it('shows — — placeholder when target tier is NONE', () => {
    const score = makeScore({ target: makeStrike({ tier: 'NONE' }) });
    render(<TargetTile score={score} />);
    expect(screen.getByText('— —')).toBeInTheDocument();
  });

  it('shows No Target wall label when tier is NONE', () => {
    const score = makeScore({ target: makeStrike({ tier: 'NONE' }) });
    render(<TargetTile score={score} />);
    expect(screen.getByText(/no target/i)).toBeInTheDocument();
  });

  it('does not show Waiting message for NONE tier (stats row still renders)', () => {
    const score = makeScore({ target: makeStrike({ tier: 'NONE' }) });
    render(<TargetTile score={score} />);
    expect(
      screen.queryByText(/waiting for scoring data/i),
    ).not.toBeInTheDocument();
  });

  it('renders the stats row for NONE tier strikes', () => {
    const score = makeScore({
      target: makeStrike({
        tier: 'NONE',
        features: makeFeatures({ distFromSpot: 15 }),
      }),
    });
    render(<TargetTile score={score} />);
    expect(screen.getByText('15 pts')).toBeInTheDocument();
  });
});

describe('TargetTile: CALL wall', () => {
  it('shows the strike price', () => {
    const score = makeScore({
      target: makeStrike({ strike: 5800, tier: 'HIGH', wallSide: 'CALL' }),
    });
    render(<TargetTile score={score} />);
    expect(screen.getByText('5800')).toBeInTheDocument();
  });

  it('shows Call Wall label', () => {
    const score = makeScore({
      target: makeStrike({ tier: 'HIGH', wallSide: 'CALL' }),
    });
    render(<TargetTile score={score} />);
    expect(screen.getByText(/call wall/i)).toBeInTheDocument();
  });
});

describe('TargetTile: PUT wall', () => {
  it('shows Put Wall label', () => {
    const score = makeScore({
      target: makeStrike({ wallSide: 'PUT', tier: 'MEDIUM' }),
    });
    render(<TargetTile score={score} />);
    expect(screen.getByText(/put wall/i)).toBeInTheDocument();
  });
});

describe('TargetTile: tier badges', () => {
  it('shows HIGH tier badge', () => {
    const score = makeScore({ target: makeStrike({ tier: 'HIGH' }) });
    render(<TargetTile score={score} />);
    expect(screen.getByText('HIGH')).toBeInTheDocument();
  });

  it('shows MEDIUM tier badge', () => {
    const score = makeScore({ target: makeStrike({ tier: 'MEDIUM' }) });
    render(<TargetTile score={score} />);
    expect(screen.getByText('MEDIUM')).toBeInTheDocument();
  });

  it('shows LOW tier badge', () => {
    const score = makeScore({ target: makeStrike({ tier: 'LOW' }) });
    render(<TargetTile score={score} />);
    expect(screen.getByText('LOW')).toBeInTheDocument();
  });

  it('does not show a tier badge for NONE tier', () => {
    const score = makeScore({ target: makeStrike({ tier: 'NONE' }) });
    render(<TargetTile score={score} />);
    expect(screen.queryByText('NONE')).not.toBeInTheDocument();
  });
});

describe('TargetTile: stats row values', () => {
  it('shows formatted positive 5m delta percentage', () => {
    const score = makeScore({
      target: makeStrike({ features: makeFeatures({ deltaPct_5m: 0.053 }) }),
    });
    render(<TargetTile score={score} />);
    expect(screen.getByText('+5.3%')).toBeInTheDocument();
  });

  it('shows formatted negative 5m delta percentage', () => {
    const score = makeScore({
      target: makeStrike({ features: makeFeatures({ deltaPct_5m: -0.12 }) }),
    });
    render(<TargetTile score={score} />);
    expect(screen.getByText('-12.0%')).toBeInTheDocument();
  });

  it('shows — for null 5m delta', () => {
    const score = makeScore({
      target: makeStrike({ features: makeFeatures({ deltaPct_5m: null }) }),
    });
    render(<TargetTile score={score} />);
    // Multiple — values can appear from nulls in the stats row
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows formatted 20m delta percentage', () => {
    const score = makeScore({
      target: makeStrike({ features: makeFeatures({ deltaPct_20m: 0.18 }) }),
    });
    render(<TargetTile score={score} />);
    expect(screen.getByText('+18.0%')).toBeInTheDocument();
  });

  it('shows distance from spot', () => {
    const score = makeScore({
      target: makeStrike({ features: makeFeatures({ distFromSpot: 25 }) }),
    });
    render(<TargetTile score={score} />);
    expect(screen.getByText('25 pts')).toBeInTheDocument();
  });

  it('shows the final score formatted to 2 decimal places', () => {
    const score = makeScore({ target: makeStrike({ finalScore: 0.73 }) });
    render(<TargetTile score={score} />);
    expect(screen.getByText('0.73')).toBeInTheDocument();
  });
});
