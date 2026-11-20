/**
 * SilentBoomTickerGroup unit tests — header/body rendering, expand
 * gate, click-to-toggle. Stubs SilentBoomRow so the contract-tape /
 * net-flow hook trio isn't pulled in.
 */

import { describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import type {
  SilentBoomAlert,
  SilentBoomExitPolicy,
} from '../components/SilentBoom/types';
import { SilentBoomTickerGroup } from '../components/SilentBoom/SilentBoomTickerGroup';
import {
  genericElementsWithAriaLabel,
  srHintText,
  titledElementsNeedingHint,
  titledElementsWithoutHint,
} from './helpers/aria';

vi.mock('../components/SilentBoom/SilentBoomRow', () => ({
  SilentBoomRow: ({ alert }: { alert: SilentBoomAlert }) => (
    <div
      data-testid={`silent-boom-row-${alert.optionChainId}`}
      data-ticker={alert.underlyingSymbol}
    >
      {alert.underlyingSymbol} {alert.strike}
    </div>
  ),
}));

function makeAlert(overrides: Partial<SilentBoomAlert> = {}): SilentBoomAlert {
  return {
    id: 1,
    date: '2026-05-14',
    bucketCt: '2026-05-14T14:30:00Z',
    optionChainId: 'NOW260515C00086000',
    underlyingSymbol: 'NOW',
    optionType: 'C',
    strike: 86,
    expiry: '2026-05-15',
    dte: 1,
    spikeVolume: 9900,
    baselineVolume: 100,
    spikeRatio: 99,
    askPct: 0.7,
    volOi: 0.12,
    entryPrice: 4.0,
    openInterest: 5000,
    score: 24,
    scoreTier: 'tier1',
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
      peakCeilingPct: 50.0,
      minutesToPeak: 15,
      realized30mPct: 35.0,
      realized60mPct: 20.0,
      realized120mPct: 10.0,
      realizedEodPct: 5.0,
      realizedTrail3010Pct: null,
      enrichedAt: '2026-05-14T15:00:00Z',
    },
    insertedAt: '2026-05-14T14:30:30Z',
    ...overrides,
  };
}

const EXIT_POLICY: SilentBoomExitPolicy = 'realized60mPct';

describe('SilentBoomTickerGroup', () => {
  it('renders the ticker name and alert count', () => {
    const alerts = [
      makeAlert({ optionChainId: 'NOW260515C00086000' }),
      makeAlert({ optionChainId: 'NOW260515C00088000', strike: 88 }),
    ];
    render(
      <SilentBoomTickerGroup
        ticker="NOW"
        alerts={alerts}
        expanded={false}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    expect(screen.getByText('NOW')).toBeInTheDocument();
    expect(screen.getByText('2 alerts')).toBeInTheDocument();
  });

  it('uses singular "alert" wording for a single-alert group', () => {
    render(
      <SilentBoomTickerGroup
        ticker="AMD"
        alerts={[makeAlert({ underlyingSymbol: 'AMD' })]}
        expanded={false}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    expect(screen.getByText('1 alert')).toBeInTheDocument();
  });

  it('hides the alert rows when collapsed (still in DOM but display:none)', () => {
    // Body is kept mounted to preserve aria-controls target + per-row
    // chart-expand state; visibility is toggled via Tailwind `hidden`.
    render(
      <SilentBoomTickerGroup
        ticker="NOW"
        alerts={[makeAlert({ optionChainId: 'NOW260515C00086000' })]}
        expanded={false}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    const row = screen.getByTestId('silent-boom-row-NOW260515C00086000');
    expect(row).toBeInTheDocument();
    expect(row).not.toBeVisible();
  });

  it('renders every alert row when expanded', () => {
    const alerts = [
      makeAlert({ optionChainId: 'NOW260515C00086000', strike: 86 }),
      makeAlert({ optionChainId: 'NOW260515C00088000', strike: 88 }),
      makeAlert({ optionChainId: 'NOW260515C00090000', strike: 90 }),
    ];
    render(
      <SilentBoomTickerGroup
        ticker="NOW"
        alerts={alerts}
        expanded={true}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    expect(
      screen.getByTestId('silent-boom-row-NOW260515C00086000'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('silent-boom-row-NOW260515C00088000'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('silent-boom-row-NOW260515C00090000'),
    ).toBeInTheDocument();
  });

  it('calls onToggle with the ticker name when the header is clicked', () => {
    const onToggle = vi.fn();
    render(
      <SilentBoomTickerGroup
        ticker="NOW"
        alerts={[makeAlert()]}
        expanded={false}
        onToggle={onToggle}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(onToggle).toHaveBeenCalledWith('NOW');
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('exposes aria-expanded reflecting the prop', () => {
    const { rerender } = render(
      <SilentBoomTickerGroup
        ticker="NOW"
        alerts={[makeAlert()]}
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
      <SilentBoomTickerGroup
        ticker="NOW"
        alerts={[makeAlert()]}
        expanded={true}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders best peak% across the group (max non-null)', () => {
    const alerts = [
      makeAlert({
        optionChainId: 'NOW260515C00086000',
        outcomes: {
          peakCeilingPct: 50.0,
          minutesToPeak: 15,
          realized30mPct: null,
          realized60mPct: null,
          realized120mPct: null,
          realizedEodPct: null,
          realizedTrail3010Pct: null,
          enrichedAt: null,
        },
      }),
      makeAlert({
        optionChainId: 'NOW260515C00090000',
        strike: 90,
        outcomes: {
          peakCeilingPct: 189.5,
          minutesToPeak: 30,
          realized30mPct: null,
          realized60mPct: null,
          realized120mPct: null,
          realizedEodPct: null,
          realizedTrail3010Pct: null,
          enrichedAt: null,
        },
      }),
    ];
    render(
      <SilentBoomTickerGroup
        ticker="NOW"
        alerts={alerts}
        expanded={false}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    expect(screen.getByText('+189.5%')).toBeInTheDocument();
  });

  it('shows up to 3 strikes in the header (deduped, input order) with overflow count', () => {
    const alerts = [
      makeAlert({ optionChainId: 'NOW260515C00086000', strike: 86 }),
      makeAlert({ optionChainId: 'NOW260515C00088000', strike: 88 }),
      makeAlert({ optionChainId: 'NOW260515C00090000', strike: 90 }),
      makeAlert({ optionChainId: 'NOW260515C00092000', strike: 92 }),
      makeAlert({ optionChainId: 'NOW260515C00094000', strike: 94 }),
    ];
    render(
      <SilentBoomTickerGroup
        ticker="NOW"
        alerts={alerts}
        expanded={false}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    const strikesEl = screen.getByTestId('silent-boom-ticker-strikes-NOW');
    expect(strikesEl).toHaveTextContent('86C, 88C, 90C +2 more');
  });

  it('dedupes repeated (strike, type) pairs in the strikes summary', () => {
    const alerts = [
      makeAlert({
        optionChainId: 'NOW260515C00086000',
        strike: 86,
        bucketCt: '2026-05-14T14:30:00Z',
      }),
      // Second alert on the same chain but a later bucket — should NOT
      // duplicate "86C" in the summary.
      makeAlert({
        optionChainId: 'NOW260515C00086000',
        strike: 86,
        bucketCt: '2026-05-14T14:48:00Z',
      }),
      makeAlert({ optionChainId: 'NOW260515C00088000', strike: 88 }),
    ];
    render(
      <SilentBoomTickerGroup
        ticker="NOW"
        alerts={alerts}
        expanded={false}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    const strikesEl = screen.getByTestId('silent-boom-ticker-strikes-NOW');
    expect(strikesEl).toHaveTextContent('86C, 88C');
    expect(strikesEl.textContent).not.toContain('+');
  });

  it('shows last-hit time formatted HH:MM CT (latest bucket across the group)', () => {
    const alerts = [
      // 19:30 UTC = 14:30 CT (CDT, May)
      makeAlert({
        optionChainId: 'NOW260515C00086000',
        bucketCt: '2026-05-14T19:30:00Z',
      }),
      // 19:48 UTC = 14:48 CT — should be picked as latest
      makeAlert({
        optionChainId: 'NOW260515C00088000',
        bucketCt: '2026-05-14T19:48:00Z',
      }),
    ];
    render(
      <SilentBoomTickerGroup
        ticker="NOW"
        alerts={alerts}
        expanded={false}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    const lastEl = screen.getByTestId('silent-boom-ticker-last-NOW');
    expect(lastEl).toHaveTextContent('14:48');
  });

  it('preserves the order of the alerts prop when rendered', () => {
    // Spec line: "Within-group rows stay in the user's chosen sort
    // order". Section sorts server-side; group must not re-sort.
    const alerts = [
      makeAlert({ optionChainId: 'NOW260515C00090000', strike: 90 }),
      makeAlert({ optionChainId: 'NOW260515C00086000', strike: 86 }),
      makeAlert({ optionChainId: 'NOW260515C00088000', strike: 88 }),
    ];
    render(
      <SilentBoomTickerGroup
        ticker="NOW"
        alerts={alerts}
        expanded={true}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    const rendered = screen.getAllByTestId(/silent-boom-row-/);
    expect(rendered.map((el) => el.dataset.testid)).toEqual([
      'silent-boom-row-NOW260515C00090000',
      'silent-boom-row-NOW260515C00086000',
      'silent-boom-row-NOW260515C00088000',
    ]);
  });

  describe('aggregate chips', () => {
    it('renders bias=bull and tide=aligned for all-call + positive-tide group', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'NOW260515C00086000',
          optionType: 'C',
          mktTideDiff: 200,
        }),
        makeAlert({
          optionChainId: 'NOW260515C00088000',
          optionType: 'C',
          strike: 88,
          mktTideDiff: 50,
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="NOW"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.getByTestId('silent-boom-ticker-bias-NOW'),
      ).toHaveTextContent('↑ bull');
      expect(
        screen.getByTestId('silent-boom-ticker-tide-NOW'),
      ).toHaveTextContent('tide ↑ aligned');
    });

    it('renders tide=counter when bias and tide point opposite ways', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'NOW260515P00086000',
          optionType: 'P',
          mktTideDiff: 200,
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="NOW"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.getByTestId('silent-boom-ticker-tide-NOW'),
      ).toHaveTextContent('tide ↑ counter');
    });

    it('renders the strikes summary with (Npt) spread suffix when ≥2 distinct strikes', () => {
      const alerts = [
        makeAlert({ optionChainId: 'NOW260515C00086000', strike: 86 }),
        makeAlert({ optionChainId: 'NOW260515C00088000', strike: 88 }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="NOW"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.getByTestId('silent-boom-ticker-strikes-NOW'),
      ).toHaveTextContent('86C, 88C (2pt)');
    });

    it('renders the time-density chip when fires span >0 minutes', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'NOW260515C00086000',
          bucketCt: '2026-05-14T14:30:00Z',
        }),
        makeAlert({
          optionChainId: 'NOW260515C00088000',
          strike: 88,
          bucketCt: '2026-05-14T14:38:00Z',
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="NOW"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.getByTestId('silent-boom-ticker-density-NOW'),
      ).toHaveTextContent('Δ 8min');
    });

    it('omits the time-density chip for a single-fire group', () => {
      const alerts = [makeAlert({ optionChainId: 'NOW260515C00086000' })];
      render(
        <SilentBoomTickerGroup
          ticker="NOW"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.queryByTestId('silent-boom-ticker-density-NOW'),
      ).not.toBeInTheDocument();
    });

    it('renders the gated chip only when at least one alert is direction-gated', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'NOW260515C00086000',
          directionGated: true,
        }),
        makeAlert({
          optionChainId: 'NOW260515C00088000',
          strike: 88,
          directionGated: false,
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="NOW"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.getByTestId('silent-boom-ticker-gated-NOW'),
      ).toHaveTextContent('1 gated');
    });

    it('omits the gated chip when no alerts are direction-gated', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'NOW260515C00086000',
          directionGated: false,
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="NOW"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.queryByTestId('silent-boom-ticker-gated-NOW'),
      ).not.toBeInTheDocument();
    });

    it('renders the cluster badge when clusterStrikes >= 3', () => {
      // Cluster state is now computed upstream by `useTickerGrouping`
      // against the UNFILTERED day-scoped set and pushed in as a prop,
      // mirroring conviction/storm. Component test asserts the badge
      // wiring; the per-ticker reduction is covered in
      // useTickerGrouping.test.ts.
      const alerts = [
        makeAlert({
          optionChainId: 'AMZN260520C00220000',
          underlyingSymbol: 'AMZN',
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="AMZN"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
          clusterStrikes={4}
        />,
      );
      expect(
        screen.getByTestId('silent-boom-ticker-cluster-AMZN'),
      ).toHaveTextContent('OTM SWEEP ×4');
    });

    it('omits the cluster badge when clusterStrikes is 0', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'AMZN260520C00220000',
          underlyingSymbol: 'AMZN',
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="AMZN"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
          clusterStrikes={0}
        />,
      );
      expect(
        screen.queryByTestId('silent-boom-ticker-cluster-AMZN'),
      ).not.toBeInTheDocument();
    });

    it('omits the cluster badge when clusterStrikes is below the 3 threshold', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'AMZN260520C00220000',
          underlyingSymbol: 'AMZN',
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="AMZN"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
          clusterStrikes={2}
        />,
      );
      expect(
        screen.queryByTestId('silent-boom-ticker-cluster-AMZN'),
      ).not.toBeInTheDocument();
    });

    it('omits the cluster badge when clusterStrikes prop is omitted (back-compat default 0)', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'AMZN260520C00220000',
          underlyingSymbol: 'AMZN',
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="AMZN"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.queryByTestId('silent-boom-ticker-cluster-AMZN'),
      ).not.toBeInTheDocument();
    });

    it('renders the conviction badge when the conviction prop is true', () => {
      // The conviction/storm flags are now computed by
      // `useTickerGrouping` against the unfiltered set and pushed in
      // as props. Component-level tests assert the badge wiring; the
      // selection logic is covered in `useTickerGrouping.test.ts` +
      // `ticker-rollup-aggregates.test.ts`.
      const alerts = [
        makeAlert({
          optionChainId: 'XOM260515C00150000',
          underlyingSymbol: 'XOM',
          strike: 150,
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="XOM"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
          conviction={true}
        />,
      );
      expect(
        screen.getByTestId('silent-boom-ticker-conviction-XOM'),
      ).toHaveTextContent('conviction');
    });

    it('renders the ✦✦ strong tier and hides the base ✦ when strongConviction is true', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'XOM260515C00150000',
          underlyingSymbol: 'XOM',
          strike: 150,
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="XOM"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
          conviction={true}
          strongConviction={true}
        />,
      );
      expect(
        screen.getByTestId('silent-boom-ticker-strong-conviction-XOM'),
      ).toHaveTextContent('conviction');
      // The tiers are mutually exclusive — ✦✦ replaces the base ✦.
      expect(
        screen.queryByTestId('silent-boom-ticker-conviction-XOM'),
      ).not.toBeInTheDocument();
    });

    it('renders the base ✦ (not ✦✦) when conviction is true but strongConviction is false', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'XOM260515C00150000',
          underlyingSymbol: 'XOM',
          strike: 150,
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="XOM"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
          conviction={true}
          strongConviction={false}
        />,
      );
      expect(
        screen.getByTestId('silent-boom-ticker-conviction-XOM'),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId('silent-boom-ticker-strong-conviction-XOM'),
      ).not.toBeInTheDocument();
    });

    it('renders the storm badge when the storm prop is true', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'MSFT260518C00550000',
          underlyingSymbol: 'MSFT',
          strike: 550,
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="MSFT"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
          storm={true}
        />,
      );
      expect(
        screen.getByTestId('silent-boom-ticker-storm-MSFT'),
      ).toHaveTextContent('storm');
    });

    it('omits the storm badge when the storm prop is false', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'XOM260515C00150000',
          underlyingSymbol: 'XOM',
          strike: 150,
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="XOM"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.queryByTestId('silent-boom-ticker-storm-XOM'),
      ).not.toBeInTheDocument();
    });

    it('omits the conviction badge when the conviction prop is false', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'SNDK260515P01295000',
          underlyingSymbol: 'SNDK',
          optionType: 'P',
          strike: 1295,
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="SNDK"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.queryByTestId('silent-boom-ticker-conviction-SNDK'),
      ).not.toBeInTheDocument();
    });

    it('renders the was-conviction pill when conviction is off but wasConvictionAt is set', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'MSFT260521P00420000',
          underlyingSymbol: 'MSFT',
          strike: 420,
          optionType: 'P',
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="MSFT"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
          conviction={false}
          wasConvictionAt={Date.parse('2026-05-21T13:40:00Z')}
          wasConvictionFireCount={3}
        />,
      );
      const pill = screen.getByTestId('silent-boom-ticker-was-conviction-MSFT');
      expect(pill.textContent).toContain('was ✦');
      expect(pill.textContent).toContain('(3a)');
    });

    it('suppresses the was-conviction pill when live conviction is true', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'MSFT260521P00420000',
          underlyingSymbol: 'MSFT',
          strike: 420,
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="MSFT"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
          conviction={true}
          wasConvictionAt={Date.parse('2026-05-21T13:40:00Z')}
          wasConvictionFireCount={3}
        />,
      );
      expect(
        screen.queryByTestId('silent-boom-ticker-was-conviction-MSFT'),
      ).not.toBeInTheDocument();
    });

    it('omits the was-conviction pill when wasConvictionAt is null', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'XOM260515C00150000',
          underlyingSymbol: 'XOM',
          strike: 150,
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="XOM"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.queryByTestId('silent-boom-ticker-was-conviction-XOM'),
      ).not.toBeInTheDocument();
    });

    it('renders the aggregate premium chip with $K/$M formatting', () => {
      // 2 alerts, entryPrice $1.22 × spikeVolume 100 × 100 = $12,200 each
      const alert1 = makeAlert({
        optionChainId: 'XOM260515C00150000',
        underlyingSymbol: 'XOM',
        strike: 150,
        entryPrice: 1.22,
        spikeVolume: 100,
      });
      const alert2 = makeAlert({
        optionChainId: 'XOM260515C00155000',
        underlyingSymbol: 'XOM',
        strike: 155,
        entryPrice: 1.22,
        spikeVolume: 100,
      });
      render(
        <SilentBoomTickerGroup
          ticker="XOM"
          alerts={[alert1, alert2]}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.getByTestId('silent-boom-ticker-premium-XOM'),
      ).toHaveTextContent('prem $24K');
    });
  });

  describe('flow rollup chip', () => {
    it('renders "flow ↑ aligned" when bull bias and all positive ticker flow', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'MSFT260515C00400000',
          underlyingSymbol: 'MSFT',
          optionType: 'C',
          tickerCumNcpAtFire: 5_000_000,
          tickerCumNppAtFire: 1_000_000,
        }),
        makeAlert({
          optionChainId: 'MSFT260515C00410000',
          underlyingSymbol: 'MSFT',
          optionType: 'C',
          strike: 410,
          tickerCumNcpAtFire: 3_000_000,
          tickerCumNppAtFire: 2_000_000,
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="MSFT"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.getByTestId('silent-boom-ticker-flow-MSFT'),
      ).toHaveTextContent('flow ↑ aligned');
    });

    it('renders "flow ↓ counter" when bull bias but ticker flow negative', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'MSFT260515C00400000',
          underlyingSymbol: 'MSFT',
          optionType: 'C',
          tickerCumNcpAtFire: 1_000_000,
          tickerCumNppAtFire: 5_000_000,
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="MSFT"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.getByTestId('silent-boom-ticker-flow-MSFT'),
      ).toHaveTextContent('flow ↓ counter');
    });

    it('renders "flow —" when no rows have a fire-time snapshot', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'MSFT260515C00400000',
          underlyingSymbol: 'MSFT',
          optionType: 'C',
          tickerCumNcpAtFire: null,
          tickerCumNppAtFire: null,
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="MSFT"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.getByTestId('silent-boom-ticker-flow-MSFT'),
      ).toHaveTextContent('flow —');
    });

    it('renders "flow mixed" when single-bias group has split flow signs', () => {
      const alerts = [
        makeAlert({
          optionChainId: 'MSFT260515C00400000',
          underlyingSymbol: 'MSFT',
          optionType: 'C',
          tickerCumNcpAtFire: 5_000_000,
          tickerCumNppAtFire: 1_000_000,
        }),
        makeAlert({
          optionChainId: 'MSFT260515C00405000',
          underlyingSymbol: 'MSFT',
          optionType: 'C',
          tickerCumNcpAtFire: 1_000_000,
          tickerCumNppAtFire: 4_000_000,
        }),
      ];
      render(
        <SilentBoomTickerGroup
          ticker="MSFT"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
      expect(
        screen.getByTestId('silent-boom-ticker-flow-MSFT'),
      ).toHaveTextContent('flow mixed');
    });
  });

  describe('screen-reader text on the tide and flow chips', () => {
    // Both chips are bare spans inside the group's toggle button, so an
    // aria-label on them would be prohibited and mostly ignored. Their
    // question is hidden text; the longer aligned / counter key stays in
    // `title`. The text stays short because the toggle button's accessible
    // name is built from its content, these chips included.
    function renderGroup() {
      return render(
        <SilentBoomTickerGroup
          ticker="MSFT"
          alerts={[
            makeAlert({
              optionChainId: 'MSFT260515C00400000',
              underlyingSymbol: 'MSFT',
              mktTideDiff: 200,
              tickerCumNcpAtFire: 5_000_000,
              tickerCumNppAtFire: 1_000_000,
            }),
          ]}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
        />,
      );
    }

    it('gives the tide chip its question as hidden text, not an aria-label', () => {
      renderGroup();
      const chip = screen.getByTestId('silent-boom-ticker-tide-MSFT');
      expect(srHintText(chip)).toBe(
        "Does Market Tide direction agree with this ticker's bias?",
      );
      expect(chip).not.toHaveAttribute('aria-label');
      expect(chip.getAttribute('title')).toContain('aligned = same direction');
    });

    it('gives the flow chip its question as hidden text, not an aria-label', () => {
      renderGroup();
      const chip = screen.getByTestId('silent-boom-ticker-flow-MSFT');
      expect(srHintText(chip)).toBe(
        "Does per-ticker net flow direction at fire time agree with this ticker's bias?",
      );
      expect(chip).not.toHaveAttribute('aria-label');
      expect(chip.getAttribute('title')).toContain('aligned = same direction');
    });

    it('leaves no aria-label on a role-less, non-interactive header element', () => {
      const { container } = renderGroup();
      expect(genericElementsWithAriaLabel(container)).toEqual([]);
    });
  });

  describe('screen-reader hints on every titled header chip', () => {
    /** Every chip the header can show: two strikes (strikes summary and
     *  spread), a gated alert, alerts 20 minutes apart (density), and the
     *  conviction / was-conviction / storm / sweep flags. */
    function renderFullHeader(variant: 'strong' | 'high' | 'was') {
      const tideFields = {
        mktTideDiff: 200,
        tickerCumNcpAtFire: 5_000_000,
        tickerCumNppAtFire: 1_000_000,
      };
      const alerts = [
        makeAlert({
          optionChainId: 'TSLA260514C00250000',
          underlyingSymbol: 'TSLA',
          strike: 250,
          directionGated: true,
          ...tideFields,
        }),
        makeAlert({
          optionChainId: 'TSLA260514C00260000',
          underlyingSymbol: 'TSLA',
          strike: 260,
          bucketCt: '2026-05-14T14:50:00Z',
          ...tideFields,
        }),
      ];
      return render(
        <SilentBoomTickerGroup
          ticker="TSLA"
          alerts={alerts}
          expanded={false}
          onToggle={() => undefined}
          marketOpen={true}
          exitPolicy={EXIT_POLICY}
          conviction={variant !== 'was'}
          strongConviction={variant === 'strong'}
          storm
          clusterStrikes={3}
          wasConvictionAt={Date.parse('2026-05-14T13:40:00Z')}
          wasConvictionFireCount={4}
        />,
      );
    }

    // The rule, precisely: an element with a non-empty `title` needs an
    // SrHint as a direct child, unless it has a role, is natively
    // interactive or already shows its title text.
    it.each(['strong', 'high', 'was'] as const)(
      'a full header (%s): every titled element has an SrHint child unless it has a role, is natively interactive or already shows its title',
      (variant) => {
        const { container } = renderFullHeader(variant);
        // Every chip is on screen, so an empty result can't pass by
        // rendering less.
        for (const id of [
          'silent-boom-ticker-strikes-TSLA',
          'silent-boom-ticker-bias-TSLA',
          'silent-boom-ticker-tide-TSLA',
          'silent-boom-ticker-flow-TSLA',
          'silent-boom-ticker-density-TSLA',
          'silent-boom-ticker-premium-TSLA',
          'silent-boom-ticker-gated-TSLA',
          'silent-boom-ticker-last-TSLA',
          'silent-boom-ticker-storm-TSLA',
          'silent-boom-ticker-cluster-TSLA',
        ]) {
          expect(screen.getByTestId(id), id).toBeInTheDocument();
        }
        expect(titledElementsNeedingHint(container).length).toBeGreaterThan(12);
        expect(titledElementsWithoutHint(container)).toEqual([]);
      },
    );

    it('keeps each header hint under 100 characters: the chips are part of the toggle button’s accessible name', () => {
      for (const variant of ['strong', 'high', 'was'] as const) {
        const { container } = renderFullHeader(variant);
        for (const el of titledElementsNeedingHint(container)) {
          const hint = srHintText(el) ?? '';
          expect(hint.length, hint).toBeLessThan(100);
        }
        cleanup();
      }
    });

    it('words each chip in a short hint', () => {
      const { container } = renderFullHeader('strong');
      const hint = (id: string) =>
        srHintText(screen.getByTestId(`silent-boom-ticker-${id}-TSLA`));
      expect(hint('strong-conviction')).toBe(
        'Conviction cluster that is also cheap (every alert ≤ $1) and pre-PM.',
      );
      expect(hint('storm')).toBe(
        '8 or more alerts, a ×100 or larger spike, or $500K total premium.',
      );
      expect(hint('cluster')).toBe(
        '3 or more cheap OTM ask-side 0DTE strikes. Context only, not a conviction signal.',
      );
      expect(hint('strikes')).toBe(
        'Distinct strike and side pairs; the spread in points is in parentheses.',
      );
      expect(hint('bias')).toBe(
        "Net call versus put bias across this ticker's alerts.",
      );
      expect(hint('density')).toBe(
        'Time from the first to the last alert in this group.',
      );
      expect(hint('premium')).toBe(
        "Sum of spike-bucket premium across this ticker's alerts",
      );
      expect(hint('gated')).toBe(
        'Alerts demoted to tier 3 by the Market Tide direction gate.',
      );
      expect(hint('last')).toBe(
        'Most recent alert spike-bucket time (CT) for this ticker today.',
      );
      // The count, best-peak label and peak value have no testid.
      expect(
        srHintText(container.querySelector('[title^="Number of distinct"]')!),
      ).toBe(
        'Distinct chain and spike-bucket alerts today; a repeat spike counts once.',
      );
      const peakTitled = Array.from(
        container.querySelectorAll('[title^="Best peak return"]'),
      ).map((el) => srHintText(el));
      expect(peakTitled).toEqual([
        'Look-ahead reference, not tradeable.',
        'Best peak return across every alert today.',
      ]);
    });

    it('words the high-conviction and was-conviction chips in short hints', () => {
      renderFullHeader('high');
      expect(
        srHintText(screen.getByTestId('silent-boom-ticker-conviction-TSLA')),
      ).toBe(
        '3 or more alerts, one direction, several strikes, within 15 minutes.',
      );
      cleanup();

      renderFullHeader('was');
      expect(
        srHintText(
          screen.getByTestId('silent-boom-ticker-was-conviction-TSLA'),
        ),
      ).toMatch(
        /^Conviction window began at \d\d:\d\d CT with 4 alerts; no longer live\.$/,
      );
    });
  });

  it('renders an em-dash when every alert has a null peak', () => {
    const alerts = [
      makeAlert({
        optionChainId: 'NOW260515C00086000',
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
      }),
    ];
    render(
      <SilentBoomTickerGroup
        ticker="NOW"
        alerts={alerts}
        expanded={false}
        onToggle={() => undefined}
        marketOpen={true}
        exitPolicy={EXIT_POLICY}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
