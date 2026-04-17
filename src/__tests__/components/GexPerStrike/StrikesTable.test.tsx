import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrikesTable } from '../../../components/GexPerStrike/StrikesTable';
import type { GexStrikeLevel } from '../../../hooks/useGexPerStrike';

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
    volReinforcement: 'reinforcing',
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

function defaultProps(
  overrides: Partial<Parameters<typeof StrikesTable>[0]> = {},
) {
  const filtered: GexStrikeLevel[] = [
    makeStrike({ strike: 5810 }),
    makeStrike({ strike: 5800 }),
    makeStrike({ strike: 5790, netGamma: -150_000_000_000 }),
  ];
  return {
    filtered,
    price: 5800,
    viewMode: 'oi' as const,
    showCharm: false,
    showVanna: false,
    showDex: false,
    maxGex: 500_000_000_000,
    maxCharm: 1_000_000_000,
    maxVanna: 100_000_000,
    maxDelta: 5_000_000_000,
    hovered: null,
    onHoverEnter: vi.fn(),
    onHoverMove: vi.fn(),
    onHoverLeave: vi.fn(),
    onFocusRow: vi.fn(),
    onBlurRow: vi.fn(),
    ...overrides,
  };
}

describe('StrikesTable — rendering', () => {
  it('renders one row per filtered strike', () => {
    render(<StrikesTable {...defaultProps()} />);
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('renders each strike label', () => {
    render(<StrikesTable {...defaultProps()} />);
    expect(screen.getByText('5810')).toBeInTheDocument();
    expect(screen.getByText('5800')).toBeInTheDocument();
    expect(screen.getByText('5790')).toBeInTheDocument();
  });

  it('renders with an accessible role="img" label', () => {
    render(<StrikesTable {...defaultProps()} />);
    expect(
      screen.getByRole('img', { name: /0dte gamma exposure per strike/i }),
    ).toBeInTheDocument();
  });

  it('renders nothing when filtered is empty (no rows)', () => {
    render(<StrikesTable {...defaultProps({ filtered: [] })} />);
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });
});

describe('StrikesTable — overlay toggles', () => {
  it('does not render charm value text when showCharm is false', () => {
    render(<StrikesTable {...defaultProps({ showCharm: false })} />);
    // The ▲/▼ characters only render inside overlay spans; when off, none appear
    expect(screen.queryByText(/[▲▼]/)).not.toBeInTheDocument();
  });

  it('renders charm value text when showCharm is true', () => {
    render(<StrikesTable {...defaultProps({ showCharm: true })} />);
    expect(screen.getAllByText(/[▲▼]/).length).toBeGreaterThan(0);
  });

  it('renders vanna overlay when showVanna is true', () => {
    render(<StrikesTable {...defaultProps({ showVanna: true })} />);
    expect(screen.getAllByText(/[▲▼]/).length).toBeGreaterThan(0);
  });

  it('renders dex overlay when showDex is true', () => {
    render(<StrikesTable {...defaultProps({ showDex: true })} />);
    expect(screen.getAllByText(/[▲▼]/).length).toBeGreaterThan(0);
  });

  it('renders all overlays when all flags enabled', () => {
    render(
      <StrikesTable
        {...defaultProps({
          showCharm: true,
          showVanna: true,
          showDex: true,
        })}
      />,
    );
    // 3 rows × 3 overlays = 9 glyphs in the right panel
    expect(screen.getAllByText(/[▲▼]/).length).toBe(9);
  });
});

describe('StrikesTable — hover callbacks', () => {
  it('calls onHoverEnter with index and coords when row hovered', async () => {
    const user = userEvent.setup();
    const onHoverEnter = vi.fn();
    render(<StrikesTable {...defaultProps({ onHoverEnter })} />);
    const rows = screen.getAllByRole('row');
    await user.hover(rows[0]!);
    expect(onHoverEnter).toHaveBeenCalled();
    expect(onHoverEnter.mock.calls[0]![0]).toBe(0);
  });

  it('calls onHoverLeave when row unhovered', async () => {
    const user = userEvent.setup();
    const onHoverLeave = vi.fn();
    render(<StrikesTable {...defaultProps({ onHoverLeave })} />);
    const rows = screen.getAllByRole('row');
    await user.hover(rows[0]!);
    await user.unhover(rows[0]!);
    expect(onHoverLeave).toHaveBeenCalled();
  });

  it('calls onFocusRow when row focused', () => {
    const onFocusRow = vi.fn();
    render(<StrikesTable {...defaultProps({ onFocusRow })} />);
    const rows = screen.getAllByRole('row');
    rows[1]!.focus();
    expect(onFocusRow).toHaveBeenCalled();
    expect(onFocusRow.mock.calls[0]![0]).toBe(1);
  });

  it('calls onBlurRow when row loses focus', () => {
    const onBlurRow = vi.fn();
    render(<StrikesTable {...defaultProps({ onBlurRow })} />);
    const rows = screen.getAllByRole('row');
    rows[0]!.focus();
    rows[0]!.blur();
    expect(onBlurRow).toHaveBeenCalled();
  });

  it('applies highlight background to hovered row', () => {
    render(<StrikesTable {...defaultProps({ hovered: 1 })} />);
    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveStyle({ background: 'rgba(255,255,255,0.02)' });
  });

  it('renders hover value label for hovered row only', () => {
    render(<StrikesTable {...defaultProps({ hovered: 0 })} />);
    // formatNum(200B) → "200.00B"
    expect(screen.getByText('200.00B')).toBeInTheDocument();
  });
});

describe('StrikesTable — spot line positioning', () => {
  it('renders a spot line when spot falls within the strike window', () => {
    const { container } = render(
      <StrikesTable {...defaultProps({ price: 5800 })} />,
    );
    // Spot line is an absolute positioned h-px div with top offset and boxShadow.
    const spotLines = container.querySelectorAll('div.z-\\[2\\].h-px');
    expect(spotLines.length).toBe(1);
  });

  it('does not render spot line when price is above all strikes', () => {
    const { container } = render(
      <StrikesTable {...defaultProps({ price: 99999 })} />,
    );
    const spotLines = container.querySelectorAll('div.z-\\[2\\].h-px');
    expect(spotLines.length).toBe(0);
  });

  it('does not render spot line when price is below all strikes', () => {
    const { container } = render(
      <StrikesTable {...defaultProps({ price: 1 })} />,
    );
    const spotLines = container.querySelectorAll('div.z-\\[2\\].h-px');
    expect(spotLines.length).toBe(0);
  });

  it('does not render spot line when filtered is empty', () => {
    const { container } = render(
      <StrikesTable {...defaultProps({ filtered: [], price: 5800 })} />,
    );
    const spotLines = container.querySelectorAll('div.z-\\[2\\].h-px');
    expect(spotLines.length).toBe(0);
  });

  it('spot line renders at position 0 when price equals highest strike', () => {
    const { container } = render(
      <StrikesTable {...defaultProps({ price: 5810 })} />,
    );
    const spotLine = container.querySelector(
      'div.z-\\[2\\].h-px',
    ) as HTMLElement | null;
    expect(spotLine).not.toBeNull();
    // First strike at top → spotIdx === 0 → offset 0
    expect(spotLine!.style.top).toBe('0px');
  });
});

describe('StrikesTable — strike label styling', () => {
  it('bolds the strike label nearest to spot price', () => {
    render(<StrikesTable {...defaultProps({ price: 5800 })} />);
    const label = screen.getByText('5800');
    expect(label).toHaveStyle({ fontWeight: '700' });
  });

  it('uses normal weight for strikes far from spot', () => {
    render(<StrikesTable {...defaultProps({ price: 5800 })} />);
    const label = screen.getByText('5810');
    expect(label).toHaveStyle({ fontWeight: '400' });
  });
});
