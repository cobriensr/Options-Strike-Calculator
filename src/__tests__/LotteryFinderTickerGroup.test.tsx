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
    hoursToNextMacroEvent: null,
    rangePosAtTrigger: null,
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

  it('renders the Macro Window badge for fires with hoursToNextMacroEvent in [72, 168]', () => {
    // Retuned 2026-05-16 from the original 24-72h spec — the EDA rerun
    // (ml/findings/eda-rerun-2026-05-16/) showed 24-72h is slightly
    // anti-edge (0.92×/0.87×) while 72-168h is the actual edge bucket
    // (1.19×/1.28× lift on N=57,533).
    const fires = [
      makeFire({
        optionChainId: 'TSLA260514C00250000',
        hoursToNextMacroEvent: 96, // 4 days — inside [72, 168]
      }),
      makeFire({
        optionChainId: 'TSLA260514C00260000',
        hoursToNextMacroEvent: null,
      }),
      makeFire({
        optionChainId: 'TSLA260514C00270000',
        hoursToNextMacroEvent: 48, // 2 days — now OUTSIDE the retuned window
      }),
      makeFire({
        optionChainId: 'TSLA260514C00280000',
        hoursToNextMacroEvent: 200, // > 7d — outside
      }),
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
    // Only the 96h fire should get a badge.
    const badges = screen.getAllByTestId('lottery-macro-window-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('MACRO 96h');
  });

  it('renders the Macro Window badge at the 72h lower boundary (inclusive)', () => {
    render(
      <LotteryFinderTickerGroup
        ticker="TSLA"
        fires={[
          makeFire({
            optionChainId: 'TSLA-72h',
            hoursToNextMacroEvent: 72,
          }),
        ]}
        expanded={true}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    expect(
      screen.getByTestId('lottery-macro-window-badge'),
    ).toBeInTheDocument();
  });

  it('renders the Macro Window badge at the 168h upper boundary (inclusive)', () => {
    render(
      <LotteryFinderTickerGroup
        ticker="TSLA"
        fires={[
          makeFire({
            optionChainId: 'TSLA-168h',
            hoursToNextMacroEvent: 168,
          }),
        ]}
        expanded={true}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    expect(
      screen.getByTestId('lottery-macro-window-badge'),
    ).toBeInTheDocument();
  });

  it('renders the NEW HIGH badge when rangePosAtTrigger ≥ 1.0 (saturated clamp)', () => {
    // Retargeted 2026-05-16 from the original "TOP-RANGE ≥ 0.90" badge
    // — the EDA rerun showed only 1.01×/1.11× on top-10%, but the
    // saturated-1.0 sub-bucket (spot punched above session high during
    // the spike) has 2.4× win100 lift on N=143.
    render(
      <LotteryFinderTickerGroup
        ticker="TSLA"
        fires={[
          makeFire({
            optionChainId: 'TSLA-saturated',
            rangePosAtTrigger: 1.0,
          }),
        ]}
        expanded={true}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    expect(screen.getByTestId('lottery-new-high-badge')).toBeInTheDocument();
  });

  it('omits the NEW HIGH badge when rangePosAtTrigger is below 1.0 (including former TOP-RANGE 0.95) or null', () => {
    render(
      <LotteryFinderTickerGroup
        ticker="TSLA"
        fires={[
          makeFire({
            optionChainId: 'TSLA-top10pct',
            rangePosAtTrigger: 0.95, // previously TOP-RANGE; now no badge
          }),
          makeFire({
            optionChainId: 'TSLA-mid',
            rangePosAtTrigger: 0.5,
          }),
          makeFire({
            optionChainId: 'TSLA-null',
            rangePosAtTrigger: null,
          }),
        ]}
        expanded={true}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    expect(
      screen.queryByTestId('lottery-new-high-badge'),
    ).not.toBeInTheDocument();
  });

  it('omits the Macro Window badge when hoursToNextMacroEvent is outside [72, 168]', () => {
    render(
      <LotteryFinderTickerGroup
        ticker="TSLA"
        fires={[
          makeFire({ optionChainId: 'TSLA-71h', hoursToNextMacroEvent: 71 }),
          makeFire({ optionChainId: 'TSLA-169h', hoursToNextMacroEvent: 169 }),
          makeFire({ optionChainId: 'TSLA-null', hoursToNextMacroEvent: null }),
        ]}
        expanded={true}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    expect(
      screen.queryByTestId('lottery-macro-window-badge'),
    ).not.toBeInTheDocument();
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

    it('renders the conviction badge when criteria are met', () => {
      // 3 fires, all calls, 3 distinct strikes, within 15min
      const fires = [
        makeFire({
          optionChainId: 'XOM260515C00150000',
          underlyingSymbol: 'XOM',
          strike: 150,
          triggerTimeCt: '2026-05-15T13:32:00Z',
        }),
        makeFire({
          optionChainId: 'XOM260515C00152500',
          underlyingSymbol: 'XOM',
          strike: 152.5,
          triggerTimeCt: '2026-05-15T13:33:00Z',
        }),
        makeFire({
          optionChainId: 'XOM260515C00155000',
          underlyingSymbol: 'XOM',
          strike: 155,
          triggerTimeCt: '2026-05-15T13:39:00Z',
        }),
      ];
      render(
        <LotteryFinderTickerGroup
          ticker="XOM"
          fires={fires}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.getByTestId('lottery-ticker-conviction-XOM'),
      ).toHaveTextContent('conviction');
    });

    it('renders the storm badge when a chain has ≥20 fireCount', () => {
      // Mixed-bias multi-chain rollup that fails conviction but the
      // one chain has fireCount=22 (matches NVDA 2026-05-15 golden).
      const fires = [
        makeFire({
          optionChainId: 'NVDA260518C00227500',
          underlyingSymbol: 'NVDA',
          optionType: 'C',
          strike: 227.5,
          fireCount: 22,
        }),
        makeFire({
          optionChainId: 'NVDA260518P00227500',
          underlyingSymbol: 'NVDA',
          optionType: 'P',
          strike: 227.5,
          fireCount: 1,
        }),
      ];
      render(
        <LotteryFinderTickerGroup
          ticker="NVDA"
          fires={fires}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(screen.getByTestId('lottery-ticker-storm-NVDA')).toHaveTextContent(
        'storm',
      );
    });

    it('omits the storm badge when none of the three gates pass', () => {
      const fires = [
        makeFire({
          optionChainId: 'XOM260515C00150000',
          underlyingSymbol: 'XOM',
          strike: 150,
          fireCount: 1,
        }),
      ];
      render(
        <LotteryFinderTickerGroup
          ticker="XOM"
          fires={fires}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.queryByTestId('lottery-ticker-storm-XOM'),
      ).not.toBeInTheDocument();
    });

    it('omits the conviction badge when bias is mixed', () => {
      // 5 fires, but a put among calls → mixed bias → no badge
      const fires = [
        makeFire({
          optionChainId: 'SNDK260515P01295000',
          underlyingSymbol: 'SNDK',
          optionType: 'P',
          strike: 1295,
          triggerTimeCt: '2026-05-15T13:38:00Z',
        }),
        makeFire({
          optionChainId: 'SNDK260515C01320000',
          underlyingSymbol: 'SNDK',
          strike: 1320,
          triggerTimeCt: '2026-05-15T13:35:00Z',
        }),
        makeFire({
          optionChainId: 'SNDK260515C01360000',
          underlyingSymbol: 'SNDK',
          strike: 1360,
          triggerTimeCt: '2026-05-15T13:32:00Z',
        }),
      ];
      render(
        <LotteryFinderTickerGroup
          ticker="SNDK"
          fires={fires}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.queryByTestId('lottery-ticker-conviction-SNDK'),
      ).not.toBeInTheDocument();
    });

    it('renders the aggregate premium chip with $K/$M formatting', () => {
      // 2 fires, entry $1.22 × windowSize 100 × 100 = $12,200 each
      const fire1 = makeFire({
        optionChainId: 'XOM260515C00150000',
        underlyingSymbol: 'XOM',
        strike: 150,
      });
      const fire2 = makeFire({
        optionChainId: 'XOM260515C00155000',
        underlyingSymbol: 'XOM',
        strike: 155,
      });
      fire1.entry = { ...fire1.entry, price: 1.22 };
      fire1.trigger = { ...fire1.trigger, windowSize: 100 };
      fire2.entry = { ...fire2.entry, price: 1.22 };
      fire2.trigger = { ...fire2.trigger, windowSize: 100 };
      render(
        <LotteryFinderTickerGroup
          ticker="XOM"
          fires={[fire1, fire2]}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      // Total = 1.22 × 100 × 100 × 2 = $24,400 → "$24K"
      expect(
        screen.getByTestId('lottery-ticker-premium-XOM'),
      ).toHaveTextContent('prem $24K');
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

  describe('flow rollup chip', () => {
    function makeFireWithFlow(
      tickerCumNcpAtFire: number | null,
      tickerCumNppAtFire: number | null,
      overrides: Partial<LotteryFire> = {},
    ): LotteryFire {
      const base = makeFire(overrides);
      return {
        ...base,
        macro: { ...base.macro, tickerCumNcpAtFire, tickerCumNppAtFire },
      };
    }

    it('renders "flow ↑ aligned" when bull bias and all positive ticker flow', () => {
      const fires = [
        makeFireWithFlow(5_000_000, 1_000_000, {
          optionChainId: 'MSFT260515C00400000',
          underlyingSymbol: 'MSFT',
          optionType: 'C',
        }),
        makeFireWithFlow(3_000_000, 2_000_000, {
          optionChainId: 'MSFT260515C00410000',
          underlyingSymbol: 'MSFT',
          optionType: 'C',
          strike: 410,
        }),
      ];
      render(
        <LotteryFinderTickerGroup
          ticker="MSFT"
          fires={fires}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(screen.getByTestId('lottery-ticker-flow-MSFT')).toHaveTextContent(
        'flow ↑ aligned',
      );
    });

    it('renders "flow ↓ counter" when bull bias but ticker flow negative', () => {
      const fires = [
        makeFireWithFlow(1_000_000, 5_000_000, {
          optionChainId: 'MSFT260515C00400000',
          underlyingSymbol: 'MSFT',
          optionType: 'C',
        }),
      ];
      render(
        <LotteryFinderTickerGroup
          ticker="MSFT"
          fires={fires}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(screen.getByTestId('lottery-ticker-flow-MSFT')).toHaveTextContent(
        'flow ↓ counter',
      );
    });

    it('renders "flow —" when no rows have a fire-time snapshot', () => {
      const fires = [
        makeFireWithFlow(null, null, {
          optionChainId: 'MSFT260515C00400000',
          underlyingSymbol: 'MSFT',
          optionType: 'C',
        }),
      ];
      render(
        <LotteryFinderTickerGroup
          ticker="MSFT"
          fires={fires}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(screen.getByTestId('lottery-ticker-flow-MSFT')).toHaveTextContent(
        'flow —',
      );
    });
  });
});
