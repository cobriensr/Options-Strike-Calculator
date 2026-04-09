import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GexPerStrike from '../../components/GexPerStrike';
import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';

const noop = vi.fn();

// Default non-content props — most tests don't care about scrub state or the
// date picker, so they get "live with no history, today" defaults. Tests that
// exercise scrub controls or the date input override these.
const defaultScrubProps = {
  selectedDate: '2026-04-02',
  onDateChange: noop,
  isLive: true,
  isScrubbed: false,
  canScrubPrev: false,
  canScrubNext: false,
  onScrubPrev: noop,
  onScrubNext: noop,
  onScrubLive: noop,
};

// ── Helpers ───────────────────────────────────────────────

function makeStrike(overrides: Partial<GexStrikeLevel> = {}): GexStrikeLevel {
  return {
    strike: 5800,
    price: 5795,
    callGammaOi: 500_000_000_000,
    putGammaOi: -300_000_000_000,
    netGamma: 200_000_000_000,
    callGammaVol: 100_000_000_000,
    putGammaVol: -50_000_000_000,
    netGammaVol: 50_000_000_000,
    volReinforcement: 'reinforcing' as const,
    callGammaAsk: -100_000_000,
    callGammaBid: 200_000_000,
    putGammaAsk: 50_000_000,
    putGammaBid: -150_000_000,
    callCharmOi: 1_000_000_000,
    putCharmOi: -800_000_000,
    netCharm: 200_000_000,
    callCharmVol: 500_000_000,
    putCharmVol: -400_000_000,
    netCharmVol: 100_000_000,
    callDeltaOi: 5_000_000_000,
    putDeltaOi: -3_000_000_000,
    netDelta: 2_000_000_000,
    callVannaOi: 100_000_000,
    putVannaOi: -60_000_000,
    netVanna: 40_000_000,
    callVannaVol: 50_000_000,
    putVannaVol: -30_000_000,
    netVannaVol: 20_000_000,
    ...overrides,
  };
}

// ============================================================
// LOADING STATE
// ============================================================

describe('GexPerStrike: loading state', () => {
  it('shows loading message when loading', () => {
    render(
      <GexPerStrike
        strikes={[]}
        loading={true}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText(/loading gex/i)).toBeInTheDocument();
  });

  it('renders inside a SectionBox with label', () => {
    render(
      <GexPerStrike
        strikes={[]}
        loading={true}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(
      screen.getByRole('region', { name: /0dte gex per strike/i }),
    ).toBeInTheDocument();
  });
});

// ============================================================
// ERROR STATE
// ============================================================

describe('GexPerStrike: error state', () => {
  it('shows error message', () => {
    render(
      <GexPerStrike
        strikes={[]}
        loading={false}
        error="Failed to load GEX data"
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText('Failed to load GEX data')).toBeInTheDocument();
  });
});

// ============================================================
// EMPTY STATE
// ============================================================

describe('GexPerStrike: empty state', () => {
  it('shows no data message when strikes empty', () => {
    render(
      <GexPerStrike
        strikes={[]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText(/no 0dte gex data available/i)).toBeInTheDocument();
  });
});

// ============================================================
// RENDERING STRIKES
// ============================================================

describe('GexPerStrike: rendering strikes', () => {
  it('renders strike labels', () => {
    const strikes = [
      makeStrike({ strike: 5800 }),
      makeStrike({ strike: 5805 }),
    ];
    render(
      <GexPerStrike
        strikes={strikes}
        loading={false}
        error={null}
        timestamp="2026-04-02T15:00:00Z"
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText('5800')).toBeInTheDocument();
    expect(screen.getByText('5805')).toBeInTheDocument();
  });

  it('shows badge with count', () => {
    const strikes = [
      makeStrike({ strike: 5800, netGamma: 200_000_000_000 }),
      makeStrike({ strike: 5805, netGamma: 100_000_000_000 }),
    ];
    render(
      <GexPerStrike
        strikes={strikes}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
  });
});

// ============================================================
// OVERLAYS
// ============================================================

describe('GexPerStrike: overlay toggles', () => {
  it('renders CHARM, VANNA, and DEX toggle buttons', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText('CHARM')).toBeInTheDocument();
    expect(screen.getByText('VANNA')).toBeInTheDocument();
    expect(screen.getByText('DEX')).toBeInTheDocument();
  });

  it('renders OI, VOL, and DIR mode buttons', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText('OI')).toBeInTheDocument();
    expect(screen.getByText('VOL')).toBeInTheDocument();
    expect(screen.getByText('DIR')).toBeInTheDocument();
  });
});

// ============================================================
// LEGEND
// ============================================================

describe('GexPerStrike: legend', () => {
  it('shows gamma legend when data present', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText('+Gamma')).toBeInTheDocument();
    expect(screen.getByText('-Gamma')).toBeInTheDocument();
    expect(screen.getByText('SPOT')).toBeInTheDocument();
  });

  it('shows Charm in legend when overlay is active', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText('Charm')).toBeInTheDocument();
    expect(screen.getByText('Vanna')).toBeInTheDocument();
  });

  it('hides Charm/Vanna from legend when toggled off', async () => {
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    // Toggle charm off
    await user.click(screen.getByText('CHARM'));
    expect(screen.queryByText('Charm')).not.toBeInTheDocument();

    // Toggle vanna off
    await user.click(screen.getByText('VANNA'));
    expect(screen.queryByText('Vanna')).not.toBeInTheDocument();
  });
});

// ============================================================
// SUMMARY CARDS
// ============================================================

describe('GexPerStrike: summary cards', () => {
  it('shows total net GEX', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike({ netGamma: 200_000_000_000 })]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText('TOTAL NET GEX')).toBeInTheDocument();
  });

  it('shows net charm card', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText('NET CHARM')).toBeInTheDocument();
  });

  it('shows net vanna card', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText('NET VANNA')).toBeInTheDocument();
  });

  it('shows GEX flip card', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText('GEX FLIP')).toBeInTheDocument();
  });

  it('shows flow pressure card', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText('FLOW PRESSURE')).toBeInTheDocument();
  });

  it('shows charm burn rate card', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText('CHARM BURN/MIN')).toBeInTheDocument();
  });
});

// ============================================================
// ACCESSIBILITY
// ============================================================

describe('GexPerStrike: accessibility', () => {
  it('has SectionBox with aria-label', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(
      screen.getByRole('region', { name: /0dte gex per strike/i }),
    ).toBeInTheDocument();
  });

  it('has chart area with role img', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(
      screen.getByRole('img', { name: /gamma exposure/i }),
    ).toBeInTheDocument();
  });
});

// ============================================================
// HEADER CONTROLS
// ============================================================

describe('GexPerStrike: header controls', () => {
  it('renders refresh button', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(
      screen.getByRole('button', { name: /refresh gex/i }),
    ).toBeInTheDocument();
  });

  it('calls onRefresh when clicked', async () => {
    const onRefresh = vi.fn();
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={onRefresh}
        {...defaultScrubProps}
      />,
    );
    await user.click(screen.getByRole('button', { name: /refresh gex/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('is disabled while loading', () => {
    render(
      <GexPerStrike
        strikes={[]}
        loading={true}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByRole('button', { name: /refresh gex/i })).toBeDisabled();
  });

  it('renders visible count controls', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(
      screen.getByRole('button', { name: /show fewer/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /show more/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
  });
});

// ============================================================
// SCRUB CONTROLS
// ============================================================

describe('GexPerStrike: scrub controls', () => {
  it('renders prev/next/live buttons', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp="2026-04-02T19:00:00Z"
        onRefresh={noop}
        selectedDate="2026-04-02"
        onDateChange={noop}
        isLive={true}
        isScrubbed={false}
        canScrubPrev={true}
        canScrubNext={false}
        onScrubPrev={noop}
        onScrubNext={noop}
        onScrubLive={noop}
      />,
    );
    expect(
      screen.getByRole('button', { name: /previous snapshot/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /next snapshot/i }),
    ).toBeInTheDocument();
  });

  it('shows LIVE pill (not button) when on the latest snapshot', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp="2026-04-02T19:00:00Z"
        onRefresh={noop}
        selectedDate="2026-04-02"
        onDateChange={noop}
        isLive={true}
        isScrubbed={false}
        canScrubPrev={true}
        canScrubNext={false}
        onScrubPrev={noop}
        onScrubNext={noop}
        onScrubLive={noop}
      />,
    );
    // LIVE label is shown but not as a clickable button
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /resume live/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('BACKTEST')).not.toBeInTheDocument();
  });

  it('shows LIVE button when scrubbed', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp="2026-04-02T18:30:00Z"
        onRefresh={noop}
        selectedDate="2026-04-02"
        onDateChange={noop}
        isLive={false}
        isScrubbed={true}
        canScrubPrev={true}
        canScrubNext={true}
        onScrubPrev={noop}
        onScrubNext={noop}
        onScrubLive={noop}
      />,
    );
    expect(
      screen.getByRole('button', { name: /resume live/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText('BACKTEST')).not.toBeInTheDocument();
  });

  it('shows BACKTEST pill when not live and not scrubbed', () => {
    // After-hours, or viewing a past day. Neither isLive nor isScrubbed.
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp="2026-04-02T19:00:00Z"
        onRefresh={noop}
        selectedDate="2026-04-02"
        onDateChange={noop}
        isLive={false}
        isScrubbed={false}
        canScrubPrev={true}
        canScrubNext={false}
        onScrubPrev={noop}
        onScrubNext={noop}
        onScrubLive={noop}
      />,
    );
    expect(screen.getByText('BACKTEST')).toBeInTheDocument();
    // The clickable resume-live button only appears while scrubbed
    expect(
      screen.queryByRole('button', { name: /resume live/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
  });

  it('disables prev when canScrubPrev is false', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp="2026-04-02T19:00:00Z"
        onRefresh={noop}
        selectedDate="2026-04-02"
        onDateChange={noop}
        isLive={true}
        isScrubbed={false}
        canScrubPrev={false}
        canScrubNext={false}
        onScrubPrev={noop}
        onScrubNext={noop}
        onScrubLive={noop}
      />,
    );
    expect(
      screen.getByRole('button', { name: /previous snapshot/i }),
    ).toBeDisabled();
  });

  it('disables next when canScrubNext is false (on live)', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp="2026-04-02T19:00:00Z"
        onRefresh={noop}
        selectedDate="2026-04-02"
        onDateChange={noop}
        isLive={true}
        isScrubbed={false}
        canScrubPrev={true}
        canScrubNext={false}
        onScrubPrev={noop}
        onScrubNext={noop}
        onScrubLive={noop}
      />,
    );
    expect(
      screen.getByRole('button', { name: /next snapshot/i }),
    ).toBeDisabled();
  });

  it('calls onScrubPrev when prev button clicked', async () => {
    const onScrubPrev = vi.fn();
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp="2026-04-02T19:00:00Z"
        onRefresh={noop}
        selectedDate="2026-04-02"
        onDateChange={noop}
        isLive={true}
        isScrubbed={false}
        canScrubPrev={true}
        canScrubNext={false}
        onScrubPrev={onScrubPrev}
        onScrubNext={noop}
        onScrubLive={noop}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: /previous snapshot/i }),
    );
    expect(onScrubPrev).toHaveBeenCalledTimes(1);
  });

  it('calls onScrubNext when next button clicked', async () => {
    const onScrubNext = vi.fn();
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp="2026-04-02T18:30:00Z"
        onRefresh={noop}
        selectedDate="2026-04-02"
        onDateChange={noop}
        isLive={false}
        isScrubbed={true}
        canScrubPrev={true}
        canScrubNext={true}
        onScrubPrev={noop}
        onScrubNext={onScrubNext}
        onScrubLive={noop}
      />,
    );
    await user.click(screen.getByRole('button', { name: /next snapshot/i }));
    expect(onScrubNext).toHaveBeenCalledTimes(1);
  });

  it('calls onScrubLive when LIVE button clicked while scrubbed', async () => {
    const onScrubLive = vi.fn();
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp="2026-04-02T18:30:00Z"
        onRefresh={noop}
        selectedDate="2026-04-02"
        onDateChange={noop}
        isLive={false}
        isScrubbed={true}
        canScrubPrev={true}
        canScrubNext={true}
        onScrubPrev={noop}
        onScrubNext={noop}
        onScrubLive={onScrubLive}
      />,
    );
    await user.click(screen.getByRole('button', { name: /resume live/i }));
    expect(onScrubLive).toHaveBeenCalledTimes(1);
  });

  it('disables both scrub buttons while loading', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={true}
        error={null}
        timestamp="2026-04-02T19:00:00Z"
        onRefresh={noop}
        selectedDate="2026-04-02"
        onDateChange={noop}
        isLive={false}
        isScrubbed={true}
        canScrubPrev={true}
        canScrubNext={true}
        onScrubPrev={noop}
        onScrubNext={noop}
        onScrubLive={noop}
      />,
    );
    // Loading state renders the loading view, not the chart, so the scrub
    // controls should still be present in the header but disabled.
    expect(
      screen.getByRole('button', { name: /previous snapshot/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /next snapshot/i }),
    ).toBeDisabled();
  });
});

// ============================================================
// TIME DISPLAY
// ============================================================

describe('GexPerStrike: time display', () => {
  it('shows timestamp when provided', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp="2026-04-02T19:00:00Z"
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    // 19:00 UTC = 2:00 PM CT
    expect(screen.getByText(/2:00/)).toBeInTheDocument();
  });

  it('handles invalid timestamp gracefully', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp="not-a-valid-iso-date"
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    // Component should still render without crashing
    expect(
      screen.getByRole('region', { name: /0dte gex per strike/i }),
    ).toBeInTheDocument();
  });
});

// ============================================================
// MODE SWITCHING (OI / VOL / DIR)
// ============================================================

describe('GexPerStrike: mode switching', () => {
  it('shows OI values in TOTAL NET GEX card by default', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike({ strike: 5795, price: 5795 })]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    // formatNum(200B) = "200.00B"
    const gexCard = screen.getByText('TOTAL NET GEX').parentElement;
    expect(gexCard?.textContent).toContain('200.00B');
  });

  it('switches to VOL mode and shows vol-based totals', async () => {
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            netGamma: 200_000_000_000,
            netGammaVol: 50_000_000_000,
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    await user.click(screen.getByText('VOL'));

    // TOTAL NET GEX now shows VOL (50B)
    const gexCard = screen.getByText('TOTAL NET GEX').parentElement;
    expect(gexCard?.textContent).toContain('50.00B');
  });

  it('switches to DIR mode using bid/ask gamma sum', async () => {
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            // Directional sum: -100M + 300M + 50M + -150M = +100M
            callGammaAsk: -100_000_000,
            callGammaBid: 300_000_000,
            putGammaAsk: 50_000_000,
            putGammaBid: -150_000_000,
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    await user.click(screen.getByText('DIR'));

    const gexCard = screen.getByText('TOTAL NET GEX').parentElement;
    expect(gexCard?.textContent).toContain('100.00M');
  });

  it('VOL mode uses charm_vol for charm card', async () => {
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            netCharm: 200_000_000,
            netCharmVol: 800_000_000,
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    await user.click(screen.getByText('VOL'));

    const charmCard = screen.getByText('NET CHARM').parentElement;
    expect(charmCard?.textContent).toContain('800.00M');
  });
});

// ============================================================
// TOOLTIP (hover behavior)
// ============================================================

describe('GexPerStrike: tooltip', () => {
  it('shows tooltip with strike label on hover', async () => {
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[makeStrike({ strike: 5795, price: 5795 })]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    await user.hover(screen.getByLabelText(/Strike 5795 row/));

    // Tooltip header shows "Strike 5795"
    expect(screen.getByText(/^Strike 5795$/)).toBeInTheDocument();
  });

  it('tooltip shows Charm Effect analysis', async () => {
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            netCharm: 500_000_000, // positive = strengthening
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    await user.hover(screen.getByLabelText(/Strike 5795 row/));

    expect(screen.getByText('Strengthening')).toBeInTheDocument();
  });

  it('tooltip shows Weakening when charm is negative', async () => {
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            netCharm: -500_000_000,
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    await user.hover(screen.getByLabelText(/Strike 5795 row/));

    expect(screen.getByText('Weakening')).toBeInTheDocument();
  });

  it('tooltip shows Vanna Hedge direction', async () => {
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            netVanna: 100_000_000, // positive
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    await user.hover(screen.getByLabelText(/Strike 5795 row/));

    expect(screen.getByText(/Sell pressure if IV drops/)).toBeInTheDocument();
  });

  it('tooltip shows Buy pressure when vanna is negative', async () => {
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            netVanna: -100_000_000,
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    await user.hover(screen.getByLabelText(/Strike 5795 row/));

    expect(screen.getByText(/Buy pressure if IV drops/)).toBeInTheDocument();
  });

  it('tooltip shows Vol Flow: Reinforcing', async () => {
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            volReinforcement: 'reinforcing',
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    await user.hover(screen.getByLabelText(/Strike 5795 row/));

    expect(screen.getByText('Reinforcing')).toBeInTheDocument();
  });

  it('tooltip exercises call/put split in VOL mode', async () => {
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            callGammaVol: 999_000_000,
            putGammaVol: -333_000_000,
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    // Switch to VOL mode first
    await user.click(screen.getByText('VOL'));
    // Then hover the row — tooltip renders call/put using getCallGamma/getPutGamma in VOL branch
    await user.hover(screen.getByLabelText(/Strike 5795 row/));

    expect(screen.getByText(/^Strike 5795$/)).toBeInTheDocument();
    // Tooltip should show the VOL-based call/put values
    expect(screen.getByText('999.00M')).toBeInTheDocument();
    expect(screen.getByText('-333.00M')).toBeInTheDocument();
  });

  it('tooltip exercises call/put split in DIR mode', async () => {
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            callGammaAsk: 100_000_000,
            callGammaBid: 200_000_000,
            putGammaAsk: -50_000_000,
            putGammaBid: -150_000_000,
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    await user.click(screen.getByText('DIR'));
    await user.hover(screen.getByLabelText(/Strike 5795 row/));

    expect(screen.getByText(/^Strike 5795$/)).toBeInTheDocument();
    // Tooltip call = 100M + 200M = 300M, put = -50M + -150M = -200M
    expect(screen.getByText('300.00M')).toBeInTheDocument();
    expect(screen.getByText('-200.00M')).toBeInTheDocument();
  });

  it('tooltip disappears on mouse leave', async () => {
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[makeStrike({ strike: 5795, price: 5795 })]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    const row = screen.getByLabelText(/Strike 5795 row/);
    await user.hover(row);
    expect(screen.getByText(/^Strike 5795$/)).toBeInTheDocument();

    await user.unhover(row);
    expect(screen.queryByText(/^Strike 5795$/)).not.toBeInTheDocument();
  });

  it('tooltip shows Vol Flow: Opposing', async () => {
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            volReinforcement: 'opposing',
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    await user.hover(screen.getByLabelText(/Strike 5795 row/));

    expect(screen.getByText('Opposing')).toBeInTheDocument();
  });
});

// ============================================================
// FLOW PRESSURE (reinforcing / opposing / neutral branches)
// ============================================================

describe('GexPerStrike: flow pressure calculation', () => {
  it('shows reinforcing when vol and OI have same sign', () => {
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            netGamma: 200_000_000_000, // +
            netGammaVol: 50_000_000_000, // +
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText('reinforcing')).toBeInTheDocument();
  });

  it('shows opposing when vol and OI have opposite signs', () => {
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            netGamma: 200_000_000_000, // +
            netGammaVol: -50_000_000_000, // -
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText('opposing')).toBeInTheDocument();
  });

  it('shows neutral when vol gex is zero', () => {
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            netGamma: 200_000_000_000,
            netGammaVol: 0,
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText('neutral')).toBeInTheDocument();
  });

  it('shows percentage format when ratio is ≤ 100%', () => {
    // vol = 50B, oi = 200B → 25% reinforcing
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            netGamma: 200_000_000_000,
            netGammaVol: 50_000_000_000,
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    const flowCard = screen.getByText('FLOW PRESSURE').parentElement;
    expect(flowCard?.textContent).toContain('25%');
  });

  it('shows multiplier format when ratio is > 100%', () => {
    // vol = 800B, oi = 11B → 7272.7% → "72.7×"
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            netGamma: 11_000_000_000,
            netGammaVol: 800_000_000_000,
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    const flowCard = screen.getByText('FLOW PRESSURE').parentElement;
    // Should show "72.7×" not "7273%"
    expect(flowCard?.textContent).toMatch(/72\.7×/);
    expect(flowCard?.textContent).not.toMatch(/7273%/);
  });

  it('shows 100% exactly (boundary case)', () => {
    // vol == oi exactly
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            netGamma: 100_000_000_000,
            netGammaVol: 100_000_000_000,
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    const flowCard = screen.getByText('FLOW PRESSURE').parentElement;
    expect(flowCard?.textContent).toContain('100%');
  });
});

// ============================================================
// CHARM BURN RATE (sign branches)
// ============================================================

describe('GexPerStrike: charm burn rate', () => {
  it('shows selling pressure when net charm is negative', () => {
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            netCharm: -390_000_000, // -1M / min
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText('selling pressure')).toBeInTheDocument();
  });

  it('shows buying pressure when net charm is positive', () => {
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            netCharm: 390_000_000,
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    expect(screen.getByText('buying pressure')).toBeInTheDocument();
  });
});

// ============================================================
// GEX FLIP CALCULATION
// ============================================================

describe('GexPerStrike: GEX flip', () => {
  it('finds flip strike when gamma changes sign', () => {
    const strikes = [
      makeStrike({
        strike: 5790,
        price: 5795,
        netGamma: -500_000_000_000,
      }),
      makeStrike({
        strike: 5800,
        price: 5795,
        netGamma: 500_000_000_000,
      }),
    ];
    render(
      <GexPerStrike
        strikes={strikes}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    // The "GEX FLIP" card should show 5800 as its value
    const flipCard = screen.getByText('GEX FLIP').parentElement;
    expect(flipCard?.textContent).toContain('5800');
  });

  it('shows — when no flip exists (all same sign)', () => {
    const strikes = [
      makeStrike({ strike: 5790, price: 5795, netGamma: 100_000_000 }),
      makeStrike({ strike: 5800, price: 5795, netGamma: 200_000_000 }),
      makeStrike({ strike: 5810, price: 5795, netGamma: 150_000_000 }),
    ];
    render(
      <GexPerStrike
        strikes={strikes}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    const flipCard = screen.getByText('GEX FLIP').parentElement;
    expect(flipCard?.textContent).toContain('—');
  });

  it('picks flip closest to spot when multiple exist', () => {
    // Multiple sign changes — should pick the one nearest spot (5795)
    const strikes = [
      makeStrike({ strike: 5700, price: 5795, netGamma: 100_000_000 }),
      makeStrike({ strike: 5710, price: 5795, netGamma: -100_000_000 }), // flip 1 (dist 85)
      makeStrike({ strike: 5790, price: 5795, netGamma: 100_000_000 }), // flip 2 (dist 5)
      makeStrike({ strike: 5800, price: 5795, netGamma: -100_000_000 }), // flip 3 (dist 5)
    ];
    render(
      <GexPerStrike
        strikes={strikes}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );
    const flipCard = screen.getByText('GEX FLIP').parentElement;
    // Should pick 5790 or 5800 (both dist 5) — first one found is 5790
    // (scan goes in ascending order, takes first match at closestDist)
    expect(flipCard?.textContent).toMatch(/579|580/);
  });
});

// ============================================================
// OVERLAY TOGGLES (chart-level behavior)
// ============================================================

describe('GexPerStrike: overlay behavior', () => {
  it('DEX toggle adds DEX values to right panel', async () => {
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            strike: 5795,
            price: 5795,
            netDelta: 5_000_000_000,
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    // Before toggling DEX on, DEX legend item should not appear
    expect(screen.queryByText(/^DEX$/)).toBeInTheDocument(); // button exists

    // Click DEX button
    await user.click(screen.getByText('DEX'));

    // After DEX is on, the legend should show DEX entry
    // The button is still there, but now also a legend entry
    const dexMatches = screen.getAllByText(/DEX/);
    expect(dexMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('charm toggle off hides charm from legend', async () => {
    const user = userEvent.setup();
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    // Charm is on by default — legend shows it
    expect(screen.getByText('Charm')).toBeInTheDocument();

    // Turn it off
    await user.click(screen.getByText('CHARM'));
    expect(screen.queryByText('Charm')).not.toBeInTheDocument();
  });

  it('visible count +/- controls adjust the count', async () => {
    const user = userEvent.setup();
    // Make 30 strikes so +/- is meaningful
    const strikes = Array.from({ length: 30 }, (_, i) =>
      makeStrike({ strike: 5700 + i * 5, price: 5795 }),
    );
    render(
      <GexPerStrike
        strikes={strikes}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    expect(screen.getByText('15')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /show more/i }));
    expect(screen.getByText('20')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /show fewer/i }));
    expect(screen.getByText('15')).toBeInTheDocument();
  });
});

// ============================================================
// STRIKE ORDERING
// ============================================================

describe('GexPerStrike: strike ordering', () => {
  it('renders highest strike at top in price-ladder order', () => {
    const strikes = [
      makeStrike({ strike: 5790, price: 5795 }),
      makeStrike({ strike: 5800, price: 5795 }),
      makeStrike({ strike: 5810, price: 5795 }),
    ];
    render(
      <GexPerStrike
        strikes={strikes}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    // All three strikes render
    const s5790 = screen.getByText('5790');
    const s5810 = screen.getByText('5810');
    // 5810 should appear before 5790 in DOM order (top to bottom)
    const pos5810 = s5810.compareDocumentPosition(s5790);
    // If 5790 follows 5810 in the DOM, this returns DOCUMENT_POSITION_FOLLOWING (4)
    expect(pos5810 & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// ============================================================
// ATM CENTERING
// ============================================================

describe('GexPerStrike: ATM centering', () => {
  it('centers visible window around spot price', () => {
    // 30 strikes spanning 5650-5795 (price 5725, mid)
    const strikes = Array.from({ length: 30 }, (_, i) =>
      makeStrike({ strike: 5650 + i * 5, price: 5725 }),
    );
    render(
      <GexPerStrike
        strikes={strikes}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
      />,
    );

    // With default visibleCount=15 centered around 5725, we should see
    // approximately strikes 5690-5760 (7 below + spot + 7 above)
    expect(screen.getByText('5725')).toBeInTheDocument();
    // Far strikes should be excluded
    expect(screen.queryByText('5650')).not.toBeInTheDocument();
    expect(screen.queryByText('5795')).not.toBeInTheDocument();
  });
});

// ============================================================
// DATE PICKER
// ============================================================

describe('GexPerStrike: date picker', () => {
  it('renders a date input seeded from selectedDate prop', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
        selectedDate="2026-03-28"
      />,
    );

    const input = screen.getByLabelText(
      /gex per strike date/i,
    ) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.type).toBe('date');
    expect(input.value).toBe('2026-03-28');
  });

  it('calls onDateChange when the user picks a new date', () => {
    const onDateChange = vi.fn();

    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
        {...defaultScrubProps}
        selectedDate="2026-04-02"
        onDateChange={onDateChange}
      />,
    );

    // Date inputs don't emit per-keystroke change events the way text
    // inputs do — browsers fire a single change when the user commits a
    // full date. fireEvent.change simulates that commit directly.
    const input = screen.getByLabelText(/gex per strike date/i);
    fireEvent.change(input, { target: { value: '2026-03-28' } });

    expect(onDateChange).toHaveBeenCalledWith('2026-03-28');
  });
});
