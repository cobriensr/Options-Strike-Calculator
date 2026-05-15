/**
 * SilentBoomTickerGroup unit tests — header/body rendering, expand
 * gate, click-to-toggle. Stubs SilentBoomRow so the contract-tape /
 * net-flow hook trio isn't pulled in.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type {
  SilentBoomAlert,
  SilentBoomExitPolicy,
} from '../components/SilentBoom/types';
import { SilentBoomTickerGroup } from '../components/SilentBoom/SilentBoomTickerGroup';

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
