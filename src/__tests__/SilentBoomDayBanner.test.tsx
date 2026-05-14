import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SilentBoomDayBanner } from '../components/SilentBoom/SilentBoomDayBanner';
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

describe('SilentBoomDayBanner: empty state', () => {
  it('renders empty-state line when alerts array is empty', () => {
    render(<SilentBoomDayBanner alerts={[]} total={0} />);
    expect(
      screen.getByText(
        'No silent-boom alerts yet today — banner populates with the first fire.',
      ),
    ).toBeInTheDocument();
  });

  it('does not render the headline when there are no alerts', () => {
    render(<SilentBoomDayBanner alerts={[]} total={0} />);
    expect(screen.queryByText(/Day so far/)).not.toBeInTheDocument();
  });
});

// ============================================================
// SINGULAR vs PLURAL
// ============================================================

describe('SilentBoomDayBanner: singular vs plural', () => {
  it('renders "1 alert" (no s) when total === 1', () => {
    render(
      <SilentBoomDayBanner
        alerts={[makeAlert({ scoreTier: 'tier1', score: 22 })]}
        total={1}
      />,
    );
    expect(screen.getByText(/Day so far · 1 alert$/)).toBeInTheDocument();
  });

  it('renders "N alerts" (with s) when total > 1', () => {
    render(
      <SilentBoomDayBanner
        alerts={[
          makeAlert({ id: 1, scoreTier: 'tier1', score: 22 }),
          makeAlert({ id: 2, scoreTier: 'tier2', score: 14 }),
        ]}
        total={2}
      />,
    );
    expect(screen.getByText(/Day so far · 2 alerts/)).toBeInTheDocument();
  });

  it('formats large totals with toLocaleString', () => {
    render(
      <SilentBoomDayBanner
        alerts={[makeAlert({ scoreTier: 'tier3', score: 5 })]}
        total={2500}
      />,
    );
    expect(screen.getByText(/Day so far · 2,500 alerts/)).toBeInTheDocument();
  });
});

// ============================================================
// TIER COUNTS
// ============================================================

describe('SilentBoomDayBanner: tier counts', () => {
  it('counts tier1, tier2, tier3 across mixed alerts', () => {
    const alerts = [
      makeAlert({ id: 1, scoreTier: 'tier1', score: 22 }),
      makeAlert({ id: 2, scoreTier: 'tier2', score: 14 }),
      makeAlert({ id: 3, scoreTier: 'tier2', score: 12 }),
      makeAlert({ id: 4, scoreTier: 'tier3', score: 6 }),
      makeAlert({ id: 5, scoreTier: 'tier3', score: 5 }),
      makeAlert({ id: 6, scoreTier: 'tier3', score: 4 }),
    ];
    render(<SilentBoomDayBanner alerts={alerts} total={6} />);

    expect(screen.getByText('🔥🔥🔥 1')).toBeInTheDocument();
    expect(screen.getByText('🔥🔥 2')).toBeInTheDocument();
    expect(screen.getByText('🔥 3')).toBeInTheDocument();
  });

  it('treats null scoreTier as tier3 (else branch)', () => {
    const alerts = [
      // null tier — should fall into tier3 bucket.
      makeAlert({ id: 1, scoreTier: null, score: null }),
      makeAlert({ id: 2, scoreTier: null, score: null }),
    ];
    render(<SilentBoomDayBanner alerts={alerts} total={2} />);

    expect(screen.getByText('🔥🔥🔥 0')).toBeInTheDocument();
    expect(screen.getByText('🔥🔥 0')).toBeInTheDocument();
    expect(screen.getByText('🔥 2')).toBeInTheDocument();
  });
});

// ============================================================
// DOMINANT TICKER
// ============================================================

describe('SilentBoomDayBanner: dominant ticker', () => {
  it('picks the ticker with the highest alert count as dominant', () => {
    const alerts = [
      makeAlert({ id: 1, underlyingSymbol: 'NVDA', spikeRatio: 10 }),
      makeAlert({ id: 2, underlyingSymbol: 'NVDA', spikeRatio: 12 }),
      makeAlert({ id: 3, underlyingSymbol: 'NVDA', spikeRatio: 9 }),
      makeAlert({ id: 4, underlyingSymbol: 'TSLA', spikeRatio: 5 }),
      makeAlert({ id: 5, underlyingSymbol: 'AAPL', spikeRatio: 6 }),
    ];
    render(<SilentBoomDayBanner alerts={alerts} total={5} />);

    // NVDA appears 3x, dominant
    expect(screen.getByText('×3')).toBeInTheDocument();
    // The dominant-ticker pill renders NVDA in the font-semibold span.
    const nvdaSpans = screen.getAllByText('NVDA');
    expect(nvdaSpans.length).toBeGreaterThan(0);
  });
});

// ============================================================
// LOUDEST ALERT (top spikeRatio)
// ============================================================

describe('SilentBoomDayBanner: loudest alert', () => {
  it('selects the alert with the highest spikeRatio as loudest', () => {
    const alerts = [
      makeAlert({ id: 1, underlyingSymbol: 'AAPL', spikeRatio: 4 }),
      makeAlert({ id: 2, underlyingSymbol: 'TSLA', spikeRatio: 25 }),
      makeAlert({ id: 3, underlyingSymbol: 'NVDA', spikeRatio: 14 }),
    ];
    render(<SilentBoomDayBanner alerts={alerts} total={3} />);

    // Loudest should be TSLA at ×25.
    expect(screen.getByText('×25')).toBeInTheDocument();
    const tslaSpans = screen.getAllByText('TSLA');
    expect(tslaSpans.length).toBeGreaterThan(0);
  });

  it('rounds spikeRatio to nearest integer with toFixed(0)', () => {
    const alerts = [
      makeAlert({ id: 1, underlyingSymbol: 'AAPL', spikeRatio: 17.7 }),
    ];
    render(<SilentBoomDayBanner alerts={alerts} total={1} />);

    // 17.7 → "18" via toFixed(0)
    expect(screen.getByText('×18')).toBeInTheDocument();
  });
});

// ============================================================
// FOOTER
// ============================================================

describe('SilentBoomDayBanner: footer', () => {
  it('renders the "counts on current page" footer', () => {
    render(
      <SilentBoomDayBanner
        alerts={[makeAlert({ scoreTier: 'tier2' })]}
        total={1}
      />,
    );
    expect(screen.getByText('counts on current page')).toBeInTheDocument();
  });
});
