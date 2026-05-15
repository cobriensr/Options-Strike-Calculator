/**
 * LotteryFinderTickerGroup unit tests — header/body rendering, expand
 * gate, click-to-toggle. Stubs LotteryRow so the contract-tape /
 * net-flow hook trio isn't pulled in.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type {
  ExitPolicy,
  LotteryFire,
} from '../components/LotteryFinder/types';
import { LotteryFinderTickerGroup } from '../components/LotteryFinder/LotteryFinderTickerGroup';

vi.mock('../components/LotteryFinder/LotteryRow', () => ({
  LotteryRow: ({ fire }: { fire: LotteryFire }) => (
    <div
      data-testid={`lottery-row-${fire.optionChainId}`}
      data-ticker={fire.underlyingSymbol}
    >
      {fire.underlyingSymbol} {fire.strike}
    </div>
  ),
}));

function makeFire(overrides: Partial<LotteryFire> = {}): LotteryFire {
  return {
    id: 1,
    date: '2026-05-14',
    triggerTimeCt: '2026-05-14T19:30:00Z',
    entryTimeCt: '2026-05-14T19:31:00Z',
    optionChainId: 'TSLA260514C00250000',
    underlyingSymbol: 'TSLA',
    optionType: 'C',
    strike: 250,
    expiry: '2026-05-14',
    dte: 0,
    score: 18,
    scoreTier: 'tier1',
    directionGated: false,
    forecastHighPeakPct: '60-100%',
    avgHoldMinutes: 120,
    tickerStats: null,
    fireCount: 1,
    firstFireTimeCt: '2026-05-14T19:30:00Z',
    trigger: {
      volToOiWindow: 1.5,
      volToOiCum: 2.2,
      iv: 0.35,
      delta: 0.25,
      askPct: 0.7,
      windowSize: 5,
      windowPrints: 50,
    },
    entry: {
      price: 0.85,
      openInterest: 5000,
      spotAtFirst: 248.5,
      alertSeq: 7,
      minutesSincePrevFire: 30,
    },
    tags: {
      flowQuad: 'call_ask',
      tod: 'PM',
      mode: 'A_intraday_0DTE',
      reload: false,
      cheapCallPm: true,
      burstRatioVsPrev: null,
      entryDropPctVsPrev: null,
    },
    macro: {
      mktTideNcp: null,
      mktTideNpp: null,
      mktTideDiff: null,
      mktTideOtmDiff: null,
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
    },
    outcomes: {
      realizedTrail30_10Pct: 22.5,
      realizedHard30mPct: null,
      realizedTier50HoldEodPct: null,
      realizedFlowInversionPct: null,
      realizedEodPct: -10,
      peakCeilingPct: 47,
      minutesToPeak: 12,
      enrichedAt: '2026-05-14T20:00:00Z',
    },
    insertedAt: '2026-05-14T19:31:00Z',
    ...overrides,
  };
}

const EXIT_POLICY: ExitPolicy = 'realizedTrail30_10Pct';

describe('LotteryFinderTickerGroup', () => {
  it('renders the ticker name and fire count', () => {
    const fires = [
      makeFire({ optionChainId: 'TSLA260514C00250000' }),
      makeFire({ optionChainId: 'TSLA260514C00260000', strike: 260 }),
    ];
    render(
      <LotteryFinderTickerGroup
        ticker="TSLA"
        fires={fires}
        expanded={false}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    expect(screen.getByText('TSLA')).toBeInTheDocument();
    expect(screen.getByText('2 fires')).toBeInTheDocument();
  });

  it('uses singular "fire" wording for a single-fire group', () => {
    render(
      <LotteryFinderTickerGroup
        ticker="AMD"
        fires={[makeFire({ underlyingSymbol: 'AMD' })]}
        expanded={false}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    expect(screen.getByText('1 fire')).toBeInTheDocument();
  });

  it('hides the fire rows when collapsed (still in DOM but display:none)', () => {
    render(
      <LotteryFinderTickerGroup
        ticker="TSLA"
        fires={[makeFire({ optionChainId: 'TSLA260514C00250000' })]}
        expanded={false}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    const row = screen.getByTestId('lottery-row-TSLA260514C00250000');
    expect(row).toBeInTheDocument();
    expect(row).not.toBeVisible();
  });

  it('renders every fire row when expanded', () => {
    const fires = [
      makeFire({ optionChainId: 'TSLA260514C00250000', strike: 250 }),
      makeFire({ optionChainId: 'TSLA260514C00260000', strike: 260 }),
      makeFire({ optionChainId: 'TSLA260514C00270000', strike: 270 }),
    ];
    render(
      <LotteryFinderTickerGroup
        ticker="TSLA"
        fires={fires}
        expanded={true}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    expect(
      screen.getByTestId('lottery-row-TSLA260514C00250000'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('lottery-row-TSLA260514C00260000'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('lottery-row-TSLA260514C00270000'),
    ).toBeInTheDocument();
  });

  it('calls onToggle with the ticker name when the header is clicked', () => {
    const onToggle = vi.fn();
    render(
      <LotteryFinderTickerGroup
        ticker="TSLA"
        fires={[makeFire()]}
        expanded={false}
        onToggle={onToggle}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(onToggle).toHaveBeenCalledWith('TSLA');
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('exposes aria-expanded reflecting the prop', () => {
    const { rerender } = render(
      <LotteryFinderTickerGroup
        ticker="TSLA"
        fires={[makeFire()]}
        expanded={false}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    rerender(
      <LotteryFinderTickerGroup
        ticker="TSLA"
        fires={[makeFire()]}
        expanded={true}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders best peak% across the group (max non-null)', () => {
    const fires = [
      makeFire({
        optionChainId: 'TSLA260514C00250000',
        outcomes: {
          peakCeilingPct: 50.0,
          minutesToPeak: 15,
          realizedTrail30_10Pct: null,
          realizedHard30mPct: null,
          realizedTier50HoldEodPct: null,
          realizedFlowInversionPct: null,
          realizedEodPct: null,
          enrichedAt: null,
        },
      }),
      makeFire({
        optionChainId: 'TSLA260514C00260000',
        strike: 260,
        outcomes: {
          peakCeilingPct: 303.2,
          minutesToPeak: 30,
          realizedTrail30_10Pct: null,
          realizedHard30mPct: null,
          realizedTier50HoldEodPct: null,
          realizedFlowInversionPct: null,
          realizedEodPct: null,
          enrichedAt: null,
        },
      }),
    ];
    render(
      <LotteryFinderTickerGroup
        ticker="TSLA"
        fires={fires}
        expanded={false}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    expect(screen.getByText('+303.2%')).toBeInTheDocument();
  });

  it('renders an em-dash when every fire has a null peak', () => {
    const fires = [
      makeFire({
        optionChainId: 'TSLA260514C00250000',
        outcomes: {
          peakCeilingPct: null,
          minutesToPeak: null,
          realizedTrail30_10Pct: null,
          realizedHard30mPct: null,
          realizedTier50HoldEodPct: null,
          realizedFlowInversionPct: null,
          realizedEodPct: null,
          enrichedAt: null,
        },
      }),
    ];
    render(
      <LotteryFinderTickerGroup
        ticker="TSLA"
        fires={fires}
        expanded={false}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows up to 3 strikes in the header with overflow count', () => {
    const fires = [
      makeFire({ optionChainId: 'TSLA260514C00250000', strike: 250 }),
      makeFire({ optionChainId: 'TSLA260514C00260000', strike: 260 }),
      makeFire({ optionChainId: 'TSLA260514C00270000', strike: 270 }),
      makeFire({ optionChainId: 'TSLA260514C00280000', strike: 280 }),
    ];
    render(
      <LotteryFinderTickerGroup
        ticker="TSLA"
        fires={fires}
        expanded={false}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    const strikesEl = screen.getByTestId('lottery-ticker-strikes-TSLA');
    expect(strikesEl).toHaveTextContent('250C, 260C, 270C +1 more');
  });

  it('shows last-hit time formatted HH:MM CT (latest trigger across the group)', () => {
    const fires = [
      // 19:30 UTC = 14:30 CT (CDT, May)
      makeFire({
        optionChainId: 'TSLA260514C00250000',
        triggerTimeCt: '2026-05-14T19:30:00Z',
      }),
      // 19:55 UTC = 14:55 CT — should be picked as latest
      makeFire({
        optionChainId: 'TSLA260514C00260000',
        triggerTimeCt: '2026-05-14T19:55:00Z',
      }),
    ];
    render(
      <LotteryFinderTickerGroup
        ticker="TSLA"
        fires={fires}
        expanded={false}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    const lastEl = screen.getByTestId('lottery-ticker-last-TSLA');
    expect(lastEl).toHaveTextContent('14:55');
  });

  it('preserves the order of the fires prop when rendered', () => {
    const fires = [
      makeFire({ optionChainId: 'TSLA260514C00270000', strike: 270 }),
      makeFire({ optionChainId: 'TSLA260514C00250000', strike: 250 }),
      makeFire({ optionChainId: 'TSLA260514C00260000', strike: 260 }),
    ];
    render(
      <LotteryFinderTickerGroup
        ticker="TSLA"
        fires={fires}
        expanded={true}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    const rendered = screen.getAllByTestId(/lottery-row-/);
    expect(rendered.map((el) => el.dataset.testid)).toEqual([
      'lottery-row-TSLA260514C00270000',
      'lottery-row-TSLA260514C00250000',
      'lottery-row-TSLA260514C00260000',
    ]);
  });

  describe('aggregate chips', () => {
    function makeFireWithTide(
      mktTideDiff: number | null,
      overrides: Partial<LotteryFire> = {},
    ): LotteryFire {
      const base = makeFire(overrides);
      return { ...base, macro: { ...base.macro, mktTideDiff } };
    }

    it('renders bias=bull and tide=aligned for all-call + positive-tide group', () => {
      const fires = [
        makeFireWithTide(200, { optionChainId: 'TSLA260514C00250000' }),
        makeFireWithTide(50, {
          optionChainId: 'TSLA260514C00260000',
          strike: 260,
        }),
      ];
      render(
        <LotteryFinderTickerGroup
          ticker="TSLA"
          fires={fires}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(screen.getByTestId('lottery-ticker-bias-TSLA')).toHaveTextContent(
        '↑ bull',
      );
      expect(screen.getByTestId('lottery-ticker-tide-TSLA')).toHaveTextContent(
        'tide ↑ aligned',
      );
    });

    it('renders tide=counter when bias and tide point opposite ways', () => {
      const fires = [
        makeFireWithTide(200, {
          optionChainId: 'TSLA260514P00250000',
          optionType: 'P',
        }),
      ];
      render(
        <LotteryFinderTickerGroup
          ticker="TSLA"
          fires={fires}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(screen.getByTestId('lottery-ticker-tide-TSLA')).toHaveTextContent(
        'tide ↑ counter',
      );
    });

    it('renders the strikes summary with (Npt) spread suffix when ≥2 distinct strikes', () => {
      const fires = [
        makeFire({ optionChainId: 'TSLA260514C00250000', strike: 250 }),
        makeFire({ optionChainId: 'TSLA260514C00260000', strike: 260 }),
      ];
      render(
        <LotteryFinderTickerGroup
          ticker="TSLA"
          fires={fires}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.getByTestId('lottery-ticker-strikes-TSLA'),
      ).toHaveTextContent('250C, 260C (10pt)');
    });

    it('renders the time-density chip when fires span >0 minutes', () => {
      const fires = [
        makeFire({
          optionChainId: 'TSLA260514C00250000',
          triggerTimeCt: '2026-05-14T19:30:00Z',
        }),
        makeFire({
          optionChainId: 'TSLA260514C00260000',
          strike: 260,
          triggerTimeCt: '2026-05-14T19:38:00Z',
        }),
      ];
      render(
        <LotteryFinderTickerGroup
          ticker="TSLA"
          fires={fires}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.getByTestId('lottery-ticker-density-TSLA'),
      ).toHaveTextContent('Δ 8min');
    });

    it('omits the time-density chip for a single-fire group', () => {
      const fires = [makeFire({ optionChainId: 'TSLA260514C00250000' })];
      render(
        <LotteryFinderTickerGroup
          ticker="TSLA"
          fires={fires}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.queryByTestId('lottery-ticker-density-TSLA'),
      ).not.toBeInTheDocument();
    });

    it('renders the gated chip only when at least one fire is direction-gated', () => {
      const fires = [
        makeFire({
          optionChainId: 'TSLA260514C00250000',
          directionGated: true,
        }),
        makeFire({
          optionChainId: 'TSLA260514C00260000',
          strike: 260,
          directionGated: false,
        }),
      ];
      render(
        <LotteryFinderTickerGroup
          ticker="TSLA"
          fires={fires}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(screen.getByTestId('lottery-ticker-gated-TSLA')).toHaveTextContent(
        '1 gated',
      );
    });

    it('omits the gated chip when no fires are direction-gated', () => {
      const fires = [
        makeFire({
          optionChainId: 'TSLA260514C00250000',
          directionGated: false,
        }),
      ];
      render(
        <LotteryFinderTickerGroup
          ticker="TSLA"
          fires={fires}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.queryByTestId('lottery-ticker-gated-TSLA'),
      ).not.toBeInTheDocument();
    });
  });
});
