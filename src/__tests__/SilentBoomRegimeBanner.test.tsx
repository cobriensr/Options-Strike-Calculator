import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SilentBoomRegimeBanner } from '../components/SilentBoom/SilentBoomRegimeBanner';
import type { SilentBoomAlert } from '../components/SilentBoom/types';

// ── Fixture factory ──────────────────────────────────────────

function makeAlert(overrides: Partial<SilentBoomAlert> = {}): SilentBoomAlert {
  return {
    id: 1,
    date: '2026-05-08',
    bucketCt: '2026-05-08T14:30:00Z',
    optionChainId: 'AAPL260508C00200000',
    underlyingSymbol: 'AAPL',
    optionType: 'C',
    strike: 200,
    expiry: '2026-05-08',
    dte: 0,
    spikeVolume: 1000,
    baselineVolume: 100,
    spikeRatio: 10,
    askPct: 0.7,
    volOi: 0.5,
    entryPrice: 1.5,
    openInterest: 5000,
    score: 12,
    scoreTier: 'tier2',
    directionGated: false,
    mktTideDiff: null,
    zeroDteDiff: null,
    spxSpotGammaOi: null,
    avgHoldMinutes: 197,
    outcomes: {
      peakCeilingPct: null,
      minutesToPeak: null,
      realized30mPct: null,
      realized60mPct: null,
      realized120mPct: null,
      realizedEodPct: null,
      realizedTrail3010Pct: null,
      enrichedAt: null,
    },
    insertedAt: '2026-05-08T14:31:00Z',
    ...overrides,
  };
}

// ============================================================
// EMPTY STATE
// ============================================================

describe('SilentBoomRegimeBanner: empty state', () => {
  it('renders the empty-state line when alerts is empty', () => {
    render(<SilentBoomRegimeBanner alerts={[]} />);
    expect(
      screen.getByText(
        'Regime context will appear with the first alert of the day.',
      ),
    ).toBeInTheDocument();
  });

  it('does not render the headline when there are no alerts', () => {
    render(<SilentBoomRegimeBanner alerts={[]} />);
    expect(screen.queryByText('Regime today')).not.toBeInTheDocument();
  });
});

// ============================================================
// POPULATED STATE
// ============================================================

describe('SilentBoomRegimeBanner: populated state', () => {
  it('renders the "Regime today" headline', () => {
    render(
      <SilentBoomRegimeBanner
        alerts={[
          makeAlert({
            mktTideDiff: 1500,
            zeroDteDiff: -250,
            spxSpotGammaOi: 1,
          }),
        ]}
      />,
    );
    expect(screen.getByText('Regime today')).toBeInTheDocument();
  });

  it('renders the display-only methodology footer', () => {
    render(<SilentBoomRegimeBanner alerts={[makeAlert()]} />);
    expect(
      screen.getByText('display-only — see methodology'),
    ).toBeInTheDocument();
  });

  it('uses the latest alert by bucketCt for macro context', () => {
    const earlier = makeAlert({
      id: 1,
      bucketCt: '2026-05-08T13:00:00Z',
      mktTideDiff: 999_999,
    });
    const later = makeAlert({
      id: 2,
      bucketCt: '2026-05-08T15:00:00Z',
      mktTideDiff: -2500,
    });
    render(<SilentBoomRegimeBanner alerts={[earlier, later]} />);
    // Later alert's value should be the one displayed.
    expect(screen.getByText(/Market Tide ⬇ -2\.5k/)).toBeInTheDocument();
    expect(screen.queryByText(/\+1\.0M/)).not.toBeInTheDocument();
  });
});

// ============================================================
// RegimeMetric: signed format — positive / negative / zero
// ============================================================

describe('SilentBoomRegimeBanner: signed format branches', () => {
  it('renders positive signed value with up arrow and green class', () => {
    render(
      <SilentBoomRegimeBanner alerts={[makeAlert({ mktTideDiff: 1500 })]} />,
    );
    const el = screen.getByText(/Market Tide ⬆ \+1\.5k/);
    expect(el).toBeInTheDocument();
    expect(el.className).toContain('text-green-300');
  });

  it('renders negative signed value with down arrow and red class', () => {
    render(
      <SilentBoomRegimeBanner
        alerts={[makeAlert({ mktTideDiff: -2_500_000 })]}
      />,
    );
    const el = screen.getByText(/Market Tide ⬇ -2\.5M/);
    expect(el).toBeInTheDocument();
    expect(el.className).toContain('text-red-300');
  });

  it('renders zero signed value with rightward arrow and neutral class', () => {
    render(<SilentBoomRegimeBanner alerts={[makeAlert({ mktTideDiff: 0 })]} />);
    const el = screen.getByText(/Market Tide → \+0/);
    expect(el).toBeInTheDocument();
    expect(el.className).toContain('text-neutral-300');
  });
});

// ============================================================
// RegimeMetric: sign-only format — positive / negative / zero
// ============================================================

describe('SilentBoomRegimeBanner: sign-only format branches', () => {
  it('renders positive sign-only with green dot', () => {
    render(
      <SilentBoomRegimeBanner alerts={[makeAlert({ spxSpotGammaOi: 1 })]} />,
    );
    expect(screen.getByText(/SPX Gamma 🟢/)).toBeInTheDocument();
  });

  it('renders negative sign-only with red dot', () => {
    render(
      <SilentBoomRegimeBanner alerts={[makeAlert({ spxSpotGammaOi: -1 })]} />,
    );
    expect(screen.getByText(/SPX Gamma 🔴/)).toBeInTheDocument();
  });

  it('renders zero sign-only with white dot', () => {
    render(
      <SilentBoomRegimeBanner alerts={[makeAlert({ spxSpotGammaOi: 0 })]} />,
    );
    expect(screen.getByText(/SPX Gamma ⚪/)).toBeInTheDocument();
  });
});

// ============================================================
// RegimeMetric: null value (no-data branch)
// ============================================================

describe('SilentBoomRegimeBanner: no-data branch', () => {
  it('renders an em-dash placeholder when value is null', () => {
    render(
      <SilentBoomRegimeBanner
        alerts={[
          makeAlert({
            mktTideDiff: null,
            zeroDteDiff: null,
            spxSpotGammaOi: null,
          }),
        ]}
      />,
    );
    expect(screen.getByText('Market Tide —')).toBeInTheDocument();
    expect(screen.getByText('0DTE Flow —')).toBeInTheDocument();
    expect(screen.getByText('SPX Gamma —')).toBeInTheDocument();
  });

  it('null-value placeholder has the no-data tooltip suffix', () => {
    render(
      <SilentBoomRegimeBanner alerts={[makeAlert({ mktTideDiff: null })]} />,
    );
    const el = screen.getByText('Market Tide —');
    expect(el.getAttribute('title')).toContain(
      'no data — alert fired outside the macro window',
    );
  });
});

// ============================================================
// formatLarge: 3 magnitude branches (>=1M, >=1k, <1k)
// ============================================================

describe('SilentBoomRegimeBanner: formatLarge magnitude branches', () => {
  it('formats values >= 1M with M suffix and 1 decimal', () => {
    render(
      <SilentBoomRegimeBanner
        alerts={[makeAlert({ mktTideDiff: 1_500_000 })]}
      />,
    );
    expect(screen.getByText(/Market Tide ⬆ \+1\.5M/)).toBeInTheDocument();
  });

  it('formats values >= 1k (and < 1M) with k suffix and 1 decimal', () => {
    render(
      <SilentBoomRegimeBanner alerts={[makeAlert({ mktTideDiff: 12_500 })]} />,
    );
    expect(screen.getByText(/Market Tide ⬆ \+12\.5k/)).toBeInTheDocument();
  });

  it('formats small values (< 1k) without a magnitude suffix', () => {
    render(
      <SilentBoomRegimeBanner alerts={[makeAlert({ mktTideDiff: 42 })]} />,
    );
    expect(screen.getByText(/Market Tide ⬆ \+42/)).toBeInTheDocument();
  });
});
