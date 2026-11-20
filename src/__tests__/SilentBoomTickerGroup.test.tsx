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
import { computeAccessibleName } from 'dom-accessibility-api';
import {
  genericElementsWithAriaLabel,
  srHintText,
  titledElementsNeedingHint,
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
    // aria-label on them would be prohibited and mostly ignored. A short
    // hint is hidden text; the longer aligned / counter key stays in
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

    it('gives the tide chip a short hint as hidden text, not an aria-label', () => {
      renderGroup();
      const chip = screen.getByTestId('silent-boom-ticker-tide-MSFT');
      expect(srHintText(chip)).toBe('Market Tide versus bias');
      expect(chip).not.toHaveAttribute('aria-label');
      expect(chip.getAttribute('title')).toContain('aligned = same direction');
    });

    it('gives the flow chip a short hint as hidden text, not an aria-label', () => {
      renderGroup();
      const chip = screen.getByTestId('silent-boom-ticker-flow-MSFT');
      expect(srHintText(chip)).toBe('ticker net flow versus bias');
      expect(chip).not.toHaveAttribute('aria-label');
      expect(chip.getAttribute('title')).toContain('aligned = same direction');
    });

    it('leaves no aria-label on a role-less, non-interactive header element', () => {
      const { container } = renderGroup();
      expect(genericElementsWithAriaLabel(container)).toEqual([]);
    });
  });

  describe("hidden text inside the group's toggle button", () => {
    // Every chip sits inside the toggle <button>, so its hidden text is part
    // of the button's accessible name, read on every Tab stop. The header
    // shows about 150 characters; hints are budgeted so the whole name stays
    // at most 400. A chip whose visible text explains itself (the count,
    // strikes, premium, last-hit time, best peak) keeps only its `title`;
    // a chip whose text is cryptic (bias, tide, flow, density, gated and the
    // conviction, was-conviction, storm and sweep flags) gets a short hint.
    /** `typical`: the always-on chips. The other variants light every chip:
     *  two strikes (strikes summary and spread), a gated alert, alerts 20
     *  minutes apart (density), and the conviction (`strong` is the ✦✦
     *  cheap pre-PM cluster, `high` the plain ✦), was-conviction (`was`,
     *  which needs live conviction off), storm and sweep flags. */
    function renderFullHeader(variant: 'typical' | 'strong' | 'high' | 'was') {
      const full = variant !== 'typical';
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
          directionGated: full,
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
          conviction={variant === 'strong' || variant === 'high'}
          strongConviction={variant === 'strong'}
          storm={full}
          clusterStrikes={full ? 3 : 0}
          wasConvictionAt={
            variant === 'was' ? Date.parse('2026-05-14T13:40:00Z') : null
          }
          wasConvictionFireCount={variant === 'was' ? 4 : 0}
        />,
      );
    }

    const toggleButtonName = () =>
      computeAccessibleName(screen.getByRole('button'));

    it.each(['typical', 'strong', 'high', 'was'] as const)(
      'header (%s): the toggle button’s accessible name is at most 400 characters',
      (variant) => {
        renderFullHeader(variant);
        const name = toggleButtonName();
        // The hints are part of that name, so the name carries them.
        expect(name).toContain('Market Tide versus bias');
        expect(name.length).toBeLessThanOrEqual(400);
      },
    );

    it('keeps a hint on exactly the chips whose visible text is cryptic', () => {
      const { container } = renderFullHeader('strong');
      // Every titled chip is on screen. The ones left without a hint are
      // the self-explanatory ones, by testid or by the start of the title.
      const unhinted = titledElementsNeedingHint(container)
        .filter((el) => srHintText(el) == null)
        .map(
          (el) =>
            el.getAttribute('data-testid') ??
            (el.getAttribute('title') ?? '').split(' ').slice(0, 3).join(' '),
        )
        .sort();
      expect(unhinted).toEqual(
        [
          'Number of distinct', // count
          'silent-boom-ticker-strikes-TSLA',
          'silent-boom-ticker-premium-TSLA',
          'silent-boom-ticker-last-TSLA',
          'Best peak return', // best-peak label
          'Best peak return', // best-peak value
        ].sort(),
      );
      for (const id of [
        'strong-conviction',
        'storm',
        'cluster',
        'bias',
        'tide',
        'flow',
        'density',
        'gated',
      ]) {
        const chip = screen.getByTestId(`silent-boom-ticker-${id}-TSLA`);
        expect(srHintText(chip), id).not.toBeNull();
        expect(chip, id).toHaveAttribute('title');
      }
    });

    it('words each kept hint short', () => {
      renderFullHeader('strong');
      const hint = (id: string) =>
        srHintText(screen.getByTestId(`silent-boom-ticker-${id}-TSLA`));
      expect(hint('strong-conviction')).toBe('cheap (≤ $1), before 12:30 CT');
      expect(hint('storm')).toBe('8+ alerts, ×100 spike or $500K');
      expect(hint('cluster')).toBe('context only, not conviction');
      expect(hint('bias')).toBe('net calls versus puts');
      expect(hint('tide')).toBe('Market Tide versus bias');
      expect(hint('flow')).toBe('ticker net flow versus bias');
      expect(hint('density')).toBe('first to last alert');
      expect(hint('gated')).toBe('demoted by the tide gate');
    });

    it('words the high-conviction and was-conviction hints short', () => {
      renderFullHeader('high');
      expect(
        srHintText(screen.getByTestId('silent-boom-ticker-conviction-TSLA')),
      ).toBe('3+ alerts, one side, within 15 min');
      cleanup();

      renderFullHeader('was');
      expect(
        srHintText(
          screen.getByTestId('silent-boom-ticker-was-conviction-TSLA'),
        ),
      ).toBe('conviction since dropped');
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
