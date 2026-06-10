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
    underlyingPriceAtSpike: null,
    multiLegShare: null,
    tickerCumNcpAtFire: null,
    tickerCumNppAtFire: null,
    gex: {
      oneCvroflow: null,
      netPutDex: null,
      oneDexoflow: null,
      oneGexoflow: null,
      zcvr: null,
      zeroGamma: null,
      spot: null,
      capturedAt: null,
    },
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
  // The "×N" label splits the multiplication sign and the number into
  // two adjacent text nodes inside one span, so getByText('×N') (single
  // text node) won't match. Match on the span's full textContent instead.
  const ratioMatcher = (label: string) => (_: string, el: Element | null) =>
    el?.tagName === 'SPAN' &&
    el.children.length === 0 &&
    el.textContent === label;

  it('selects the alert with the highest (floored) ratio as loudest', () => {
    // Loudest now ranks by the FLOORED row-badge ratio
    // (spikeVolume / max(baseline, 100)), not the raw stored spikeRatio.
    // Drive the volumes so the floored ratios are 4 / 25 / 14.
    const alerts = [
      makeAlert({
        id: 1,
        underlyingSymbol: 'AAPL',
        spikeVolume: 400,
        baselineVolume: 100,
      }),
      makeAlert({
        id: 2,
        underlyingSymbol: 'TSLA',
        spikeVolume: 2500,
        baselineVolume: 100,
      }),
      makeAlert({
        id: 3,
        underlyingSymbol: 'NVDA',
        spikeVolume: 1400,
        baselineVolume: 100,
      }),
    ];
    render(<SilentBoomDayBanner alerts={alerts} total={3} />);

    // Loudest should be TSLA at ×25 (floored).
    expect(screen.getByText(ratioMatcher('×25'))).toBeInTheDocument();
    const tslaSpans = screen.getAllByText('TSLA');
    expect(tslaSpans.length).toBeGreaterThan(0);
  });

  it('rounds the floored ratio to nearest integer with toFixed(0)', () => {
    // 1770 / max(100, 100) = 17.7 → "18" via toFixed(0).
    const alerts = [
      makeAlert({
        id: 1,
        underlyingSymbol: 'AAPL',
        spikeVolume: 1770,
        baselineVolume: 100,
      }),
    ];
    render(<SilentBoomDayBanner alerts={alerts} total={1} />);

    expect(screen.getByText(ratioMatcher('×18'))).toBeInTheDocument();
  });

  // ── Fix 4 — banner "loudest" must match the FLOORED ratio the row
  //    badge displays (spikeVolume / max(baseline, 100)), NOT the raw
  //    stored spikeRatio (spikeVolume / max(baseline, 1)). Otherwise a
  //    tiny-baseline alert wins "loudest" with a ×8500 that no visible
  //    row badge shows.

  it('renders the loudest ratio floored at the 100-contract baseline (matches row badge)', () => {
    // baseline=2 → raw stored spikeRatio is 8500, but the row badge
    // floors to 17000 / max(2, 100) = 170×. Banner must show ×170.
    const alerts = [
      makeAlert({
        id: 1,
        underlyingSymbol: 'SNDK',
        spikeRatio: 8500,
        spikeVolume: 17_000,
        baselineVolume: 2,
      }),
    ];
    render(<SilentBoomDayBanner alerts={alerts} total={1} />);

    expect(screen.getByText(ratioMatcher('×170'))).toBeInTheDocument();
    // The raw, un-floored number must NOT appear.
    expect(screen.queryByText(ratioMatcher('×8500'))).not.toBeInTheDocument();
  });

  it('ranks loudest by floored ratio, not raw spikeRatio', () => {
    const alerts = [
      // Tiny-baseline ghost: huge raw ratio (8500) but floored = 170×.
      makeAlert({
        id: 1,
        underlyingSymbol: 'SNDK',
        spikeRatio: 8500,
        spikeVolume: 17_000,
        baselineVolume: 2,
      }),
      // Real baseline: raw 300, floored = 60000 / 200 = 300×. This is
      // the genuinely loudest by the displayed metric.
      makeAlert({
        id: 2,
        underlyingSymbol: 'NVDA',
        spikeRatio: 300,
        spikeVolume: 60_000,
        baselineVolume: 200,
      }),
    ];
    render(<SilentBoomDayBanner alerts={alerts} total={2} />);

    // NVDA wins (300× floored > 170× floored), not SNDK (raw 8500).
    expect(screen.getByText(ratioMatcher('×300'))).toBeInTheDocument();
    expect(screen.queryByText(ratioMatcher('×170'))).not.toBeInTheDocument();
    const nvdaSpans = screen.getAllByText('NVDA');
    expect(nvdaSpans.length).toBeGreaterThan(0);
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
