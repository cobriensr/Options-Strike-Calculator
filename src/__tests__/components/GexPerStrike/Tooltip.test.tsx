import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GexTooltip } from '../../../components/GexPerStrike/Tooltip';
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
    callGammaAsk: 0,
    callGammaBid: 0,
    putGammaAsk: 0,
    putGammaBid: 0,
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

describe('GexTooltip — strike header', () => {
  it('renders "Strike <n>" with the strike value', () => {
    render(
      <GexTooltip
        data={makeStrike({ strike: 5825 })}
        viewMode="oi"
        x={0}
        y={0}
      />,
    );
    expect(screen.getByText('Strike 5825')).toBeInTheDocument();
  });

  it('renders GEX, Charm, DEX, and Vanna row labels', () => {
    render(<GexTooltip data={makeStrike()} viewMode="oi" x={0} y={0} />);
    expect(screen.getByText('GEX')).toBeInTheDocument();
    expect(screen.getByText('Charm')).toBeInTheDocument();
    expect(screen.getByText('DEX')).toBeInTheDocument();
    expect(screen.getByText('Vanna')).toBeInTheDocument();
  });
});

describe('GexTooltip — volReinforcement switch', () => {
  it('shows "Reinforcing" when volReinforcement is reinforcing', () => {
    render(
      <GexTooltip
        data={makeStrike({ volReinforcement: 'reinforcing' })}
        viewMode="oi"
        x={0}
        y={0}
      />,
    );
    expect(screen.getByText('Reinforcing')).toBeInTheDocument();
  });

  it('shows "Opposing" when volReinforcement is opposing', () => {
    render(
      <GexTooltip
        data={makeStrike({ volReinforcement: 'opposing' })}
        viewMode="oi"
        x={0}
        y={0}
      />,
    );
    expect(screen.getByText('Opposing')).toBeInTheDocument();
  });

  it('shows em dash when volReinforcement is neutral', () => {
    render(
      <GexTooltip
        data={makeStrike({ volReinforcement: 'neutral' })}
        viewMode="oi"
        x={0}
        y={0}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('GexTooltip — charm direction labels', () => {
  it('shows "Strengthening" when netCharm is positive', () => {
    render(
      <GexTooltip
        data={makeStrike({ netCharm: 500_000_000 })}
        viewMode="oi"
        x={0}
        y={0}
      />,
    );
    expect(screen.getByText('Strengthening')).toBeInTheDocument();
  });

  it('shows "Weakening" when netCharm is negative', () => {
    render(
      <GexTooltip
        data={makeStrike({ netCharm: -500_000_000 })}
        viewMode="oi"
        x={0}
        y={0}
      />,
    );
    expect(screen.getByText('Weakening')).toBeInTheDocument();
  });

  it('shows "Weakening" when netCharm is zero (not strictly positive)', () => {
    render(
      <GexTooltip
        data={makeStrike({ netCharm: 0 })}
        viewMode="oi"
        x={0}
        y={0}
      />,
    );
    // charmEffect uses > 0 (strict), so 0 falls into the Weakening branch
    expect(screen.getByText('Weakening')).toBeInTheDocument();
  });
});

describe('GexTooltip — vanna direction labels', () => {
  it('shows "Sell pressure if IV drops" when netVanna is positive', () => {
    render(
      <GexTooltip
        data={makeStrike({ netVanna: 50_000_000 })}
        viewMode="oi"
        x={0}
        y={0}
      />,
    );
    expect(screen.getByText('Sell pressure if IV drops')).toBeInTheDocument();
  });

  it('shows "Buy pressure if IV drops" when netVanna is negative', () => {
    render(
      <GexTooltip
        data={makeStrike({ netVanna: -50_000_000 })}
        viewMode="oi"
        x={0}
        y={0}
      />,
    );
    expect(screen.getByText('Buy pressure if IV drops')).toBeInTheDocument();
  });

  it('shows "Buy pressure if IV drops" when netVanna is zero', () => {
    // vannaDir check uses > 0 (strict), so 0 falls into Buy-pressure
    render(
      <GexTooltip
        data={makeStrike({ netVanna: 0 })}
        viewMode="oi"
        x={0}
        y={0}
      />,
    );
    expect(screen.getByText('Buy pressure if IV drops')).toBeInTheDocument();
  });
});

describe('GexTooltip — viewMode data switching', () => {
  it('uses OI charm values when viewMode is oi', () => {
    render(
      <GexTooltip
        data={makeStrike({
          callCharmOi: 1_000_000_000,
          callCharmVol: 999,
        })}
        viewMode="oi"
        x={0}
        y={0}
      />,
    );
    // callCharmOi = 1B formatted is 1.00B
    expect(screen.getByText('1.00B')).toBeInTheDocument();
  });

  it('uses vol charm values when viewMode is vol', () => {
    render(
      <GexTooltip
        data={makeStrike({
          callCharmOi: 999,
          callCharmVol: 7_123_000_000,
        })}
        viewMode="vol"
        x={0}
        y={0}
      />,
    );
    // callCharmVol = 7.12B formatted
    expect(screen.getByText('7.12B')).toBeInTheDocument();
  });
});

describe('GexTooltip — positioning', () => {
  it('positions tooltip at x + 16 and y - 120', () => {
    render(<GexTooltip data={makeStrike()} viewMode="oi" x={300} y={400} />);
    const tooltip = screen.getByText('Strike 5800').parentElement;
    expect(tooltip).toHaveStyle({ left: '316px', top: '280px' });
  });
});
