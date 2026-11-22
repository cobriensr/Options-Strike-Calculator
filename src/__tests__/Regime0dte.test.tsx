import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import Regime0dte from '../components/Regime0dte';
import { genericElementsWithAriaLabel, srHintText } from './helpers/aria';
import type { Regime0dteResponse } from '../hooks/useRegime0dte';
import { getAccessMode, type AccessMode } from '../utils/auth';
import { ctWallClockToUtcIso } from '../utils/timezone';
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
// The access mode is read from a cookie (and is always 'owner' in a dev build).
vi.mock('../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner'),
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

/** Pin the (Date-only) fake clock to a CT wall clock. */
function setCt(date: string, hour: number, minute: number): void {
  vi.setSystemTime(
    new Date(ctWallClockToUtcIso(date, hour * 60 + minute) as string),
  );
}

/**
 * The gate chip. A gate's label is shown twice (the SectionBox badge and the
 * chip), and only the chip carries a hidden hint.
 */
function gateChip(label: string): HTMLElement {
  const chip = screen.getAllByText(label).find((el) => srHintText(el) !== null);
  if (chip == null) throw new Error(`no gate chip with a hint for ${label}`);
  return chip;
}

describe('Regime0dte panel shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The closed-window copy reads the clock. Default: a trading Monday, before
    // the open, for an owner.
    vi.useFakeTimers({ toFake: ['Date'] });
    setCt('2026-06-08', 7, 0);
    vi.mocked(getAccessMode).mockReturnValue('owner');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the gate label and all four sub-viz from displayData', () => {
    mockHook({ isWindowOpen: true, displayData: LEAN_DOWN_DATA });
    render(<Regime0dte />);

    // Gate chip — text + a hidden hint convey "lean down" (not colour alone).
    // "Lean down" appears twice (the SectionBox badge + the chip), so the
    // chip is the one carrying the hint.
    const chip = gateChip('Lean down');
    expect(chip).toHaveTextContent('Lean down');
    expect(srHintText(chip)).toBe(
      'gamma gate, deep negative gamma, downside risk',
    );
    expect(chip).not.toHaveAttribute('aria-label');

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

  it('does not mask a trigger that fires within the same as-of minute (content-keyed memo)', () => {
    const unfired: Regime0dteTriggers = {
      mostlyRed: { fired: false, atCtMin: null, green: 2, red: 3 },
      ivBreak: { fired: false, atCtMin: null, magPct: null, refHi: 0.21 },
      middayDeepNeg: { fired: false, atCtMin: null, gexMid: null },
    };
    // Same as-of minute (667) across both polls — a memo keyed on date:asOfCtMin
    // alone would freeze the first (unfired) triggers and hide the fired one.
    const base = { ...LEAN_DOWN_DATA, asOfCtMin: 667, triggers: unfired };
    mockHook({ isWindowOpen: true, displayData: base });
    const { rerender } = render(<Regime0dte />);
    expect(screen.queryByText('10:53')).not.toBeInTheDocument();

    const fired: Regime0dteResponse = {
      ...base,
      triggers: {
        ...unfired,
        ivBreak: { fired: true, atCtMin: 653, magPct: 4, refHi: 0.21 },
      },
    };
    mockHook({ isWindowOpen: true, displayData: fired });
    rerender(<Regime0dte />);
    expect(screen.getByText('10:53')).toBeInTheDocument();
  });

  it('renders the unknown gate as a distinct "no read" state, not a calm verdict', () => {
    const UNKNOWN_DATA: Regime0dteResponse = {
      ...LEAN_DOWN_DATA,
      gate: 'unknown',
      gexNearSpot: null,
      note: 'insufficient strikes near spot',
    };
    mockHook({ isWindowOpen: true, displayData: UNKNOWN_DATA });
    render(<Regime0dte />);

    // The chip is the "No read" one carrying a hint, and shows the no-read copy.
    const chip = gateChip('No read');
    expect(chip).toHaveTextContent(/No read/i);
    expect(srHintText(chip)).toBe('gamma gate, insufficient data');

    // Honest "this is not a calm/neutral verdict" note is surfaced.
    expect(
      screen.getByText(/not a calm\/neutral verdict/i),
    ).toBeInTheDocument();

    // It must NOT present as any of the three real verdicts.
    expect(chip).not.toHaveTextContent(/Calm/i);
    expect(screen.queryByText(/Calm \/ mean-revert/)).not.toBeInTheDocument();
    expect(screen.queryByText('Lean down')).not.toBeInTheDocument();
    expect(screen.queryByText(/positive gamma/)).not.toBeInTheDocument();
    expect(screen.queryByText(/downside risk/)).not.toBeInTheDocument();
  });

  it.each([
    ['calm', 'Calm / mean-revert', 'gamma gate, positive gamma, tight range'],
    ['big_move', 'Big move likely', 'gamma gate, direction unconfirmed'],
    [
      'lean_down',
      'Lean down',
      'gamma gate, deep negative gamma, downside risk',
    ],
    ['unknown', 'No read', 'gamma gate, insufficient data'],
  ] as const)(
    'gives the %s gate chip a hidden hint and no aria-label on its bare span',
    (gate, label, hint) => {
      mockHook({
        isWindowOpen: true,
        displayData: { ...LEAN_DOWN_DATA, gate },
      });
      const { container } = render(<Regime0dte />);

      const chip = gateChip(label);
      expect(srHintText(chip)).toBe(hint);
      expect(chip).not.toHaveAttribute('aria-label');
      expect(genericElementsWithAriaLabel(container)).toEqual([]);
    },
  );

  it('leaves the inner wrapper unnamed: the 0DTE Gamma Regime region names the panel', () => {
    mockHook({ isWindowOpen: true, displayData: LEAN_DOWN_DATA });
    render(<Regime0dte />);

    // ARIA 1.2 prohibits naming a generic div. The SectionBox region carries
    // the name, and the sr-only h3 still gives the panel a heading.
    const region = screen.getByRole('region', { name: '0DTE Gamma Regime' });
    const heading = within(region).getByRole('heading', {
      level: 3,
      name: '0DTE Gamma Regime',
    });
    expect(heading.parentElement).not.toHaveAttribute('aria-labelledby');
    expect(heading.parentElement).not.toHaveAttribute('aria-label');
    expect(region.querySelector('[aria-labelledby]')).toBeNull();
  });

  it('renders without throwing when all series are absent (empty-constant path)', () => {
    const NO_SERIES_DATA: Regime0dteResponse = {
      date: '2026-06-06',
      asOfCtMin: 540,
      gate: 'unknown',
      gexNearSpot: null,
      gexAtOpen: null,
      flipStrike: null,
      flipMinusOpenPct: null,
      triggers: EMPTY_TRIGGERS,
      note: 'pre-open',
      // gexStrikes / putIv / candles30 intentionally omitted → frozen empties.
    };
    mockHook({ isWindowOpen: true, displayData: NO_SERIES_DATA });

    expect(() => render(<Regime0dte />)).not.toThrow();
    // The graceful sub-viz placeholders render off the stable empty constants.
    expect(screen.getByText(/no gamma profile/i)).toBeInTheDocument();
    expect(screen.getByText(/no IV series/i)).toBeInTheDocument();
    expect(screen.getByText(/no candles/i)).toBeInTheDocument();
  });

  // With the window open and no read for today (the first fetch of the day is in
  // flight, or it failed), "waiting for the open" is wrong: it is past 08:30.
  it('says it is loading, not waiting for the open, when the window is open and no read has landed', () => {
    mockHook({ isWindowOpen: true, displayData: null, error: null });
    render(<Regime0dte />);

    expect(
      screen.getByText(/Loading today.s regime read/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for the open/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the error and says there is no read yet, not waiting for the open, when the window is open and the fetch failed', () => {
    mockHook({ isWindowOpen: true, displayData: null, error: 'HTTP 500' });
    render(<Regime0dte />);

    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500');
    expect(
      screen.getByText(/No regime read for today yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for the open/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Loading today/i)).not.toBeInTheDocument();
  });

  it('shows no gate badge and waits for the open when the window is closed and nothing is dated today', () => {
    mockHook({ isWindowOpen: false, displayData: null });
    render(<Regime0dte />);

    expect(screen.getByText(/Waiting for the open/i)).toBeInTheDocument();
    expect(screen.queryByText(/Loading today/i)).not.toBeInTheDocument();
    for (const gate of [/lean down/i, /big move/i, /calm/i]) {
      expect(screen.queryByText(gate)).not.toBeInTheDocument();
    }
  });

  // The window is closed for three different reasons, and "Waiting for the
  // open" is true for only some of them. Each case is pinned by its full text.
  describe('closed-window copy', () => {
    const WAITING_FOR_THE_OPEN =
      'Waiting for the open. The 0DTE gamma regime auto-updates between 08:30 and 15:00 CT on trading days.';
    const CLOSED_FOR_THE_DAY =
      'Closed for the day. The next read starts at the next 08:30 CT open.';
    const NEEDS_ACCESS = 'The regime read needs owner or guest access.';

    interface ClosedCase {
      name: string;
      date: string;
      hour: number;
      minute: number;
      access?: AccessMode;
      copy: string;
    }
    const cases: ClosedCase[] = [
      {
        name: 'at the close on a trading day',
        date: '2026-06-08',
        hour: 15,
        minute: 0,
        copy: CLOSED_FOR_THE_DAY,
      },
      {
        name: 'late evening of a trading day',
        date: '2026-06-08',
        hour: 23,
        minute: 59,
        copy: CLOSED_FOR_THE_DAY,
      },
      {
        name: 'after the early close on a half-day',
        date: '2026-11-27',
        hour: 12,
        minute: 0,
        copy: CLOSED_FOR_THE_DAY,
      },
      {
        name: 'after the close on a trading day, for a guest',
        date: '2026-06-08',
        hour: 16,
        minute: 0,
        access: 'guest',
        copy: CLOSED_FOR_THE_DAY,
      },
      {
        name: 'a minute before the open on a trading day',
        date: '2026-06-08',
        hour: 8,
        minute: 29,
        copy: WAITING_FOR_THE_OPEN,
      },
      {
        name: 'a Saturday, in the hours after a normal close',
        date: '2026-06-06',
        hour: 16,
        minute: 0,
        copy: WAITING_FOR_THE_OPEN,
      },
      {
        name: 'an NYSE holiday, in the hours after a normal close',
        date: '2026-11-26',
        hour: 16,
        minute: 0,
        copy: WAITING_FOR_THE_OPEN,
      },
      {
        name: 'a public visitor in the middle of the session',
        date: '2026-06-08',
        hour: 10,
        minute: 0,
        access: 'public',
        copy: NEEDS_ACCESS,
      },
      {
        name: 'a public visitor after the close',
        date: '2026-06-08',
        hour: 16,
        minute: 0,
        access: 'public',
        copy: NEEDS_ACCESS,
      },
      {
        name: 'a public visitor before the open',
        date: '2026-06-08',
        hour: 7,
        minute: 0,
        access: 'public',
        copy: NEEDS_ACCESS,
      },
    ];

    it.each(cases)('says the right thing: $name', (c) => {
      setCt(c.date, c.hour, c.minute);
      vi.mocked(getAccessMode).mockReturnValue(c.access ?? 'owner');
      mockHook({ isWindowOpen: false, displayData: null });
      render(<Regime0dte />);

      const all = [WAITING_FOR_THE_OPEN, CLOSED_FOR_THE_DAY, NEEDS_ACCESS];
      expect(screen.getByText(c.copy)).toBeInTheDocument();
      for (const other of all.filter((copy) => copy !== c.copy)) {
        expect(screen.queryByText(other)).not.toBeInTheDocument();
      }
    });

    it('keeps the day’s gate badge on the closed copy after the close', () => {
      setCt('2026-06-08', 15, 30);
      mockHook({ isWindowOpen: false, displayData: LEAN_DOWN_DATA });
      render(<Regime0dte />);

      expect(screen.getByText(CLOSED_FOR_THE_DAY)).toBeInTheDocument();
      // The chip is not drawn (no panel), so the one "Lean down" is the badge.
      expect(screen.getByText('Lean down')).toBeInTheDocument();
    });

    // Inside the window the closed copy never applies, whatever the clock says.
    it('does not use the closed copy while the window is open', () => {
      setCt('2026-06-08', 16, 0);
      mockHook({ isWindowOpen: true, displayData: null, error: null });
      render(<Regime0dte />);

      expect(
        screen.getByText(/Loading today.s regime read/i),
      ).toBeInTheDocument();
      expect(screen.queryByText(CLOSED_FOR_THE_DAY)).not.toBeInTheDocument();
    });
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
