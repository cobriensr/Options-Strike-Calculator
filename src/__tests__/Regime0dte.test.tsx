import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import Regime0dte from '../components/Regime0dte';
import type { Regime0dteResponse } from '../hooks/useRegime0dte';
import {
  GammaProfileMini,
  type GammaStrike,
} from '../components/Regime0dte/GammaProfileMini';
import {
  IvSparkline,
  type IvSparkPoint,
} from '../components/Regime0dte/IvSparkline';
import {
  CandleStrip,
  type StripCandle,
} from '../components/Regime0dte/CandleStrip';
import { TriggerLights } from '../components/Regime0dte/TriggerLights';
import { formatCtMin } from '../components/Regime0dte/format';
import type { Regime0dteTriggers } from '../hooks/useRegime0dte';

// Mock the data hook so the shell tests drive it directly — the shell only
// reads `displayData`, `isWindowOpen`, and `error` from it.
const { mockUseRegime0dte } = vi.hoisted(() => ({
  mockUseRegime0dte: vi.fn(),
}));
vi.mock('../hooks/useRegime0dte.js', () => ({
  useRegime0dte: mockUseRegime0dte,
}));

const STRIKES: GammaStrike[] = [
  { strike: 5880, netGex: -3.2e10 },
  { strike: 5890, netGex: -1.1e10 },
  { strike: 5900, netGex: 0.5e10 },
  { strike: 5910, netGex: 2.4e10 },
  { strike: 5920, netGex: 4.0e10 },
];

const IV_SERIES: IvSparkPoint[] = [
  { ctMin: 510, iv: 0.28 },
  { ctMin: 540, iv: 0.3 },
  { ctMin: 600, iv: 0.31 },
  { ctMin: 660, iv: 0.36 },
  { ctMin: 690, iv: 0.4 },
];

const CANDLES: StripCandle[] = [
  { ctMin: 510, open: 5900, close: 5895 },
  { ctMin: 540, open: 5895, close: 5888 },
  { ctMin: 570, open: 5888, close: 5882 },
  { ctMin: 600, open: 5882, close: 5879 },
  { ctMin: 660, open: 5879, close: 5884 },
];

const FIRED_TRIGGERS: Regime0dteTriggers = {
  mostlyRed: { fired: true, atCtMin: 660, green: 1, red: 4 },
  ivBreak: { fired: true, atCtMin: 653, magPct: 4.2, refHi: 0.31 },
  middayDeepNeg: { fired: false, atCtMin: null, gexMid: null },
};

const EMPTY_TRIGGERS: Regime0dteTriggers = {
  mostlyRed: { fired: false, atCtMin: null, green: 0, red: 0 },
  ivBreak: { fired: false, atCtMin: null, magPct: null, refHi: null },
  middayDeepNeg: { fired: false, atCtMin: null, gexMid: null },
};

describe('formatCtMin', () => {
  it('formats a CT minute-of-day as HH:MM', () => {
    expect(formatCtMin(653)).toBe('10:53');
    expect(formatCtMin(510)).toBe('08:30');
    expect(formatCtMin(900)).toBe('15:00');
  });

  it('returns an em-dash for null / non-finite', () => {
    expect(formatCtMin(null)).toBe('—');
    expect(formatCtMin(Number.NaN)).toBe('—');
  });
});

describe('GammaProfileMini', () => {
  it('renders an SVG with an accessible label given strikes', () => {
    render(
      <GammaProfileMini
        strikes={STRIKES}
        flipStrike={5895}
        spot={5897}
        bandPct={0.01}
      />,
    );
    expect(screen.getByRole('img')).toHaveAttribute('aria-label');
  });

  it('renders a placeholder (no throw) with empty strikes', () => {
    expect(() =>
      render(
        <GammaProfileMini
          strikes={[]}
          flipStrike={null}
          spot={null}
          bandPct={0.01}
        />,
      ),
    ).not.toThrow();
    expect(screen.getByText(/no gamma profile/i)).toBeInTheDocument();
  });
});

describe('IvSparkline', () => {
  it('renders the IV polyline SVG given a series', () => {
    render(<IvSparkline series={IV_SERIES} refHi={0.31} breakAtCtMin={660} />);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label');
  });

  it('renders a placeholder (no throw) with empty series', () => {
    expect(() =>
      render(<IvSparkline series={[]} refHi={null} breakAtCtMin={null} />),
    ).not.toThrow();
    expect(screen.getByText(/no IV series/i)).toBeInTheDocument();
  });
});

describe('CandleStrip', () => {
  it('renders the candle strip given candles', () => {
    render(<CandleStrip candles={CANDLES} persistEndCtMin={660} />);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label');
  });

  it('renders a placeholder (no throw) with empty candles', () => {
    expect(() =>
      render(<CandleStrip candles={[]} persistEndCtMin={660} />),
    ).not.toThrow();
    expect(screen.getByText(/no candles/i)).toBeInTheDocument();
  });
});

describe('TriggerLights', () => {
  it('shows fired triggers with their CT clock time', () => {
    render(<TriggerLights triggers={FIRED_TRIGGERS} />);
    expect(screen.getByText('mostly-red')).toBeInTheDocument();
    expect(screen.getByText('10:53')).toBeInTheDocument();
    expect(screen.getByText('11:00')).toBeInTheDocument();
  });

  it('renders (no throw) with all triggers unfired', () => {
    expect(() =>
      render(<TriggerLights triggers={EMPTY_TRIGGERS} />),
    ).not.toThrow();
    expect(screen.getByText('IV-break')).toBeInTheDocument();
  });
});

const LEAN_DOWN_DATA: Regime0dteResponse = {
  date: '2026-06-06',
  asOfCtMin: 660,
  gate: 'lean_down',
  gexNearSpot: -3.2e10,
  gexAtOpen: -2.8e10,
  flipStrike: 5895,
  flipMinusOpenPct: -0.3,
  triggers: FIRED_TRIGGERS,
  note: 'downside confirmed by intraday trigger(s)',
  gexStrikes: STRIKES,
  spot: 5897,
  putIv: IV_SERIES,
  candles30: CANDLES,
  bandPct: 0.01,
  persistEndCtMin: 660,
};

function mockHook(
  overrides: Partial<ReturnType<typeof mockUseRegime0dte>>,
): void {
  mockUseRegime0dte.mockReturnValue({
    data: null,
    loading: false,
    error: null,
    fetchedAt: null,
    refresh: vi.fn(),
    isWindowOpen: true,
    displayData: null,
    ...overrides,
  });
}

describe('Regime0dte panel shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the gate label and all four sub-viz from displayData', () => {
    mockHook({ isWindowOpen: true, displayData: LEAN_DOWN_DATA });
    render(<Regime0dte />);

    // Gate chip — text + aria-label convey "lean down" (not colour alone).
    // "Lean down" appears twice (the SectionBox badge + the chip), so the
    // chip is pinned by its descriptive aria-label.
    const chip = screen.getByLabelText(/Gamma gate: lean down/i);
    expect(chip).toHaveTextContent('Lean down');

    // The honest note line.
    expect(
      screen.getByText(/downside confirmed by intraday trigger/i),
    ).toBeInTheDocument();

    // TriggerLights.
    expect(
      screen.getByLabelText(/Down-side confirmation triggers/i),
    ).toBeInTheDocument();

    // GammaProfileMini + IvSparkline + CandleStrip each render an
    // accessible img with their distinctive aria-labels.
    expect(
      screen.getByLabelText(/Net gamma exposure by strike/i),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/put-implied-volatility series/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/30-minute SPX candles/i)).toBeInTheDocument();
  });

  it('shows the waiting-for-open placeholder and no visuals when closed', () => {
    mockHook({ isWindowOpen: false, displayData: LEAN_DOWN_DATA });
    render(<Regime0dte />);

    expect(screen.getByText(/Waiting for the open/i)).toBeInTheDocument();

    // None of the sub-viz should render in the closed state.
    expect(
      screen.queryByLabelText(/Net gamma exposure by strike/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/put-implied-volatility series/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/30-minute SPX candles/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Down-side confirmation triggers/i),
    ).not.toBeInTheDocument();
  });
});
