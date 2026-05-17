/**
 * ReignitionSection unit tests — Phase 3 of
 * docs/superpowers/specs/lottery-reignition-ui-2026-05-17.md.
 *
 * Stubs LotteryRow so the section's structural behavior (empty state,
 * row count, header, getFlowSnapshot fan-out) is observable without
 * pulling in the row's full chart stack.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type {
  LotteryFire,
  LotteryFireMacro,
} from '../components/LotteryFinder/types';

// Stub LotteryRow so the test focuses on the section's own behavior.
// The stub exposes the fire id + the snapshot it received so we can
// assert correct fan-out without rendering the full row.
vi.mock('../components/LotteryFinder/LotteryRow', () => ({
  LotteryRow: ({
    fire,
    liveFlowSnapshot,
    exitPolicy,
    marketOpen,
  }: {
    fire: LotteryFire;
    liveFlowSnapshot?: unknown;
    exitPolicy: string;
    marketOpen: boolean;
  }) => (
    <div
      data-testid={`row-${fire.id}`}
      data-snapshot={JSON.stringify(liveFlowSnapshot)}
      data-exit-policy={exitPolicy}
      data-market-open={String(marketOpen)}
    >
      {fire.underlyingSymbol}-{fire.id}
    </div>
  ),
}));

// Static import AFTER the mock.
import { ReignitionSection } from '../components/LotteryFinder/ReignitionSection';

function makeMacro(
  overrides: Partial<LotteryFireMacro> = {},
): LotteryFireMacro {
  return {
    mktTideNcp: null,
    mktTideNpp: null,
    mktTideDiff: null,
    mktTideOtmDiff: null,
    tickerCumNcpAtFire: null,
    tickerCumNppAtFire: null,
    spxFlowDiff: null,
    spyEtfDiff: null,
    qqqEtfDiff: null,
    zeroDteDiff: null,
    spxSpotGammaOi: null,
    spxSpotGammaVol: null,
    spxSpotCharmOi: null,
    spxSpotVannaOi: null,
    gexStrikeCallMinusPut: null,
    gexStrikeCallAskMinusBid: null,
    gexStrikePutAskMinusBid: null,
    gexStrikeActualStrike: null,
    ...overrides,
  };
}

function makeFire(overrides: Partial<LotteryFire> = {}): LotteryFire {
  return {
    id: 1,
    date: '2026-05-15',
    triggerTimeCt: '2026-05-15T19:30:00Z',
    entryTimeCt: '2026-05-15T19:31:00Z',
    optionChainId: 'QQQ260515P00708000',
    underlyingSymbol: 'QQQ',
    optionType: 'P',
    strike: 708,
    expiry: '2026-05-15',
    dte: 0,
    score: 18,
    scoreTier: 'tier1',
    directionGated: false,
    forecastHighPeakPct: '30-50%',
    avgHoldMinutes: 120,
    tickerStats: null,
    fireCount: 21,
    firstFireTimeCt: '2026-05-15T13:30:00Z',
    reignited: true,
    trigger: {
      volToOiWindow: 2,
      volToOiCum: 3,
      iv: 1.0,
      delta: -0.21,
      askPct: 0.95,
      windowSize: 5,
      windowPrints: 12,
    },
    entry: {
      price: 0.16,
      openInterest: 2872,
      spotAtFirst: 708.64,
      alertSeq: 1,
      minutesSincePrevFire: 0,
    },
    tags: {
      flowQuad: 'put_ask',
      tod: 'PM',
      mode: 'A_intraday_0DTE',
      reload: false,
      cheapCallPm: false,
      burstRatioVsPrev: null,
      entryDropPctVsPrev: null,
    },
    macro: makeMacro(),
    outcomes: {
      realizedTrail30_10Pct: 42.9,
      realizedHard30mPct: null,
      realizedTier50HoldEodPct: null,
      realizedFlowInversionPct: null,
      realizedEodPct: null,
      peakCeilingPct: 578,
      minutesToPeak: 30,
      enrichedAt: '2026-05-15T20:00:00Z',
    },
    hoursToNextMacroEvent: null,
    rangePosAtTrigger: null,
    insertedAt: '2026-05-15T19:31:00Z',
    ...overrides,
  };
}

describe('ReignitionSection: empty state', () => {
  it('returns null when fires is empty (no DOM rendered)', () => {
    const { container } = render(
      <ReignitionSection
        fires={[]}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
        getFlowSnapshot={() => null}
      />,
    );
    expect(
      container.querySelector('[data-testid="reignition-section"]'),
    ).toBeNull();
  });
});

describe('ReignitionSection: populated', () => {
  it('renders one row per fire with the section heading + count badge', () => {
    const fires = [
      makeFire({ id: 1, underlyingSymbol: 'QQQ' }),
      makeFire({ id: 2, underlyingSymbol: 'AMD' }),
      makeFire({ id: 3, underlyingSymbol: 'TSLA' }),
    ];
    render(
      <ReignitionSection
        fires={fires}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={true}
        getFlowSnapshot={() => null}
      />,
    );
    expect(screen.getByTestId('reignition-section')).toBeInTheDocument();
    expect(screen.getByText('Hot Right Now')).toBeInTheDocument();
    // Count badge shows the section's fire count.
    expect(screen.getByText('3')).toBeInTheDocument();
    // Each fire renders its stubbed row.
    expect(screen.getByTestId('row-1')).toBeInTheDocument();
    expect(screen.getByTestId('row-2')).toBeInTheDocument();
    expect(screen.getByTestId('row-3')).toBeInTheDocument();
  });

  it('forwards per-ticker liveFlowSnapshot from getFlowSnapshot to each row', () => {
    const snapshots = new Map<string, { ts: string; cumNcp: number }>([
      ['QQQ', { ts: 'qqq-snap', cumNcp: 1 }],
      ['AMD', { ts: 'amd-snap', cumNcp: 2 }],
    ]);
    const getFlowSnapshot = vi.fn(
      (ticker: string) =>
        // The component's TickerNetFlowSnapshot type is narrower than this
        // test fixture, but the stubbed LotteryRow accepts unknown — the
        // identity of the value is what matters for the assertion.
        (snapshots.get(ticker) ?? null) as unknown as null,
    );
    const fires = [
      makeFire({ id: 1, underlyingSymbol: 'QQQ' }),
      makeFire({ id: 2, underlyingSymbol: 'AMD' }),
    ];
    render(
      <ReignitionSection
        fires={fires}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={true}
        getFlowSnapshot={getFlowSnapshot}
      />,
    );
    expect(getFlowSnapshot).toHaveBeenCalledWith('QQQ');
    expect(getFlowSnapshot).toHaveBeenCalledWith('AMD');
    const qqqRow = screen.getByTestId('row-1') as HTMLElement;
    const amdRow = screen.getByTestId('row-2') as HTMLElement;
    expect(qqqRow.dataset.snapshot).toContain('qqq-snap');
    expect(amdRow.dataset.snapshot).toContain('amd-snap');
  });

  it('exposes an accessible heading with the correct aria-labelledby relationship', () => {
    render(
      <ReignitionSection
        fires={[makeFire()]}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
        getFlowSnapshot={() => null}
      />,
    );
    const section = screen.getByTestId('reignition-section');
    expect(section.getAttribute('aria-labelledby')).toBe('reignition-heading');
    const heading = section.querySelector('#reignition-heading');
    expect(heading).not.toBeNull();
  });

  it('preserves parent-supplied fire order (does NOT re-sort internally)', () => {
    // The parent (LotteryFinderSection) owns the sort — most-recent
    // triggerTimeCt DESC — so the section must render in the order it
    // receives. Two fires with intentionally out-of-time order confirm
    // the section doesn't reach back into the array and re-order.
    const fires = [
      makeFire({
        id: 1,
        underlyingSymbol: 'QQQ',
        triggerTimeCt: '2026-05-15T13:00:00Z', // earlier
      }),
      makeFire({
        id: 2,
        underlyingSymbol: 'AMD',
        triggerTimeCt: '2026-05-15T19:00:00Z', // later
      }),
    ];
    render(
      <ReignitionSection
        fires={fires}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={true}
        getFlowSnapshot={() => null}
      />,
    );
    const rendered = screen
      .getAllByTestId(/^row-/)
      .map((el) => (el as HTMLElement).dataset.testid);
    expect(rendered).toEqual(['row-1', 'row-2']);
  });

  it('forwards exitPolicy and marketOpen to every row', () => {
    const fires = [
      makeFire({ id: 1, underlyingSymbol: 'QQQ' }),
      makeFire({ id: 2, underlyingSymbol: 'AMD' }),
    ];
    render(
      <ReignitionSection
        fires={fires}
        exitPolicy="realizedHard30mPct"
        marketOpen={true}
        getFlowSnapshot={() => null}
      />,
    );
    for (const row of screen.getAllByTestId(/^row-/)) {
      const ds = (row as HTMLElement).dataset;
      expect(ds.exitPolicy).toBe('realizedHard30mPct');
      expect(ds.marketOpen).toBe('true');
    }
  });
});
