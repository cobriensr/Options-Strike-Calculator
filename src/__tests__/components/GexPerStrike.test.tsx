import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GexPerStrike from '../../components/GexPerStrike';
import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';

const noop = vi.fn();

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
      />,
    );
    // 19:00 UTC = 2:00 PM CT
    expect(screen.getByText(/2:00/)).toBeInTheDocument();
  });
});
