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
    callDeltaOi: 5_000_000_000,
    putDeltaOi: -3_000_000_000,
    netDelta: 2_000_000_000,
    callVannaOi: 100_000_000,
    putVannaOi: -60_000_000,
    netVanna: 40_000_000,
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
  it('renders strike levels', () => {
    const strikes = [
      makeStrike({ strike: 5800, netGamma: 200_000_000_000 }),
      makeStrike({ strike: 5805, netGamma: 100_000_000_000 }),
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

  it('shows distance from ATM', () => {
    const strikes = [
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
      />,
    );
    expect(screen.getByText('+5pts')).toBeInTheDocument();
    expect(screen.getByText('+15pts')).toBeInTheDocument();
  });

  it('marks ATM strike', () => {
    const strikes = [makeStrike({ strike: 5795, price: 5795 })];
    render(
      <GexPerStrike
        strikes={strikes}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
      />,
    );
    expect(screen.getByText('ATM')).toBeInTheDocument();
  });

  it('shows call and put gamma breakdown', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
      />,
    );
    // Call and Put labels exist
    expect(screen.getByText('C')).toBeInTheDocument();
    expect(screen.getByText('P')).toBeInTheDocument();
  });
});

// ============================================================
// CHARM EFFECT
// ============================================================

describe('GexPerStrike: charm effect', () => {
  it('shows ▲ when charm strengthens gamma (same sign)', () => {
    // Positive gamma + positive charm = strengthening
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            netGamma: 200_000_000_000,
            netCharm: 50_000_000_000,
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
      />,
    );
    expect(screen.getByText('▲')).toBeInTheDocument();
  });

  it('shows ▼ when charm erodes gamma (opposite sign)', () => {
    // Positive gamma + negative charm = weakening
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            netGamma: 200_000_000_000,
            netCharm: -50_000_000_000,
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
      />,
    );
    expect(screen.getByText('▼')).toBeInTheDocument();
  });

  it('shows charm tooltip with effect description', () => {
    render(
      <GexPerStrike
        strikes={[
          makeStrike({
            netGamma: 200_000_000_000,
            netCharm: 50_000_000_000,
          }),
        ]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
      />,
    );
    expect(screen.getByTitle(/reinforcing gamma/)).toBeInTheDocument();
  });
});

// ============================================================
// VOL vs OI REINFORCEMENT
// ============================================================

describe('GexPerStrike: vol reinforcement', () => {
  it('shows filled dot when flow reinforces level', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike({ volReinforcement: 'reinforcing' })]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
      />,
    );
    expect(screen.getByTitle(/flow reinforces/)).toBeInTheDocument();
  });

  it('shows hollow dot when flow opposes level', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike({ volReinforcement: 'opposing' })]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
      />,
    );
    expect(screen.getByTitle(/flow opposes/)).toBeInTheDocument();
  });
});

// ============================================================
// DEX AND VANNA
// ============================================================

describe('GexPerStrike: DEX and vanna', () => {
  it('shows net delta with call/put tooltip', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
      />,
    );
    expect(screen.getByTitle(/DEX: C/)).toBeInTheDocument();
  });

  it('shows net vanna with call/put tooltip', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
      />,
    );
    expect(screen.getByTitle(/Vanna: C/)).toBeInTheDocument();
  });
});

// ============================================================
// GEX FORMATTING
// ============================================================

describe('GexPerStrike: GEX formatting', () => {
  it('formats trillions with T suffix', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike({ netGamma: 1_500_000_000_000 })]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
      />,
    );
    expect(screen.getByText('+$1.5T')).toBeInTheDocument();
  });

  it('formats billions with B suffix', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike({ netGamma: 200_000_000_000 })]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
      />,
    );
    expect(screen.getByText('+$200.0B')).toBeInTheDocument();
  });

  it('formats negative values with minus sign', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike({ netGamma: -500_000_000_000 })]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
      />,
    );
    expect(screen.getByText('-$500.0B')).toBeInTheDocument();
  });
});

// ============================================================
// GEX BAR
// ============================================================

describe('GexPerStrike: GEX bar', () => {
  it('renders bars with aria-label', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike({ netGamma: 100_000_000_000 })]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
      />,
    );
    expect(
      screen.getByLabelText(/^\+\$100\.0B gamma exposure$/),
    ).toBeInTheDocument();
  });

  it('renders proportional bar widths', () => {
    const strikes = [
      makeStrike({
        strike: 5800,
        netGamma: 1_000_000_000_000,
      }),
      makeStrike({
        strike: 5805,
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
      />,
    );

    const bars = screen.getAllByLabelText(/gamma exposure$/);
    // Filter out the table itself (only get bar divs)
    const barDivs = bars.filter((el) => el.tagName.toLowerCase() === 'div');
    expect(barDivs).toHaveLength(2);

    const bar1 = barDivs[0] as HTMLElement;
    const bar2 = barDivs[1] as HTMLElement;
    expect(bar1.style.width).toBe('100%');
    expect(bar2.style.width).toBe('50%');
  });
});

// ============================================================
// SORTING
// ============================================================

describe('GexPerStrike: sorting', () => {
  it('default sort is by GEX magnitude', () => {
    const strikes = [
      makeStrike({ strike: 5800, netGamma: 100_000_000 }),
      makeStrike({ strike: 5805, netGamma: 500_000_000 }),
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
    // 5805 (larger GEX) should appear first
    const rows = screen.getAllByRole('row');
    // Row 0 = header (sr-only), Row 1 = first data row
    expect(rows[1]!.textContent).toContain('5805');
  });

  it('renders sort toggle button', () => {
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
      screen.getByRole('button', { name: /sort by strike/i }),
    ).toBeInTheDocument();
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

  it('has table role for screen readers', () => {
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
      screen.getByRole('table', { name: /0dte gamma exposure/i }),
    ).toBeInTheDocument();
  });

  it('has column headers for screen readers', () => {
    render(
      <GexPerStrike
        strikes={[makeStrike()]}
        loading={false}
        error={null}
        timestamp={null}
        onRefresh={noop}
      />,
    );
    expect(screen.getByText('Strike')).toBeInTheDocument();
    expect(screen.getByText('Dist')).toBeInTheDocument();
    expect(screen.getByText('Net $')).toBeInTheDocument();
    expect(screen.getByText('Charm')).toBeInTheDocument();
    expect(screen.getByText('DEX')).toBeInTheDocument();
    expect(screen.getByText('Vanna')).toBeInTheDocument();
    expect(screen.getByText('Vol')).toBeInTheDocument();
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

  it('renders OI/Dir toggle button', () => {
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
      screen.getByRole('button', { name: /switch to directional/i }),
    ).toBeInTheDocument();
  });

  it('toggles between OI and directional view', async () => {
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

    const toggle = screen.getByRole('button', {
      name: /switch to directional/i,
    });
    expect(toggle).toHaveTextContent('OI');

    await user.click(toggle);

    expect(
      screen.getByRole('button', { name: /switch to oi/i }),
    ).toHaveTextContent('Dir');
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
    // Default is 15
    expect(screen.getByText('15')).toBeInTheDocument();
  });

  it('disables minus button at minimum', async () => {
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
    // Click minus twice: 15 → 10 → 5 (min)
    const minus = screen.getByRole('button', { name: /show fewer/i });
    await user.click(minus);
    await user.click(minus);
    expect(minus).toBeDisabled();
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
