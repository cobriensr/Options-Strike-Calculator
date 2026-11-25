/**
 * PeriscopeLotteryPanel — dual-column UI for Periscope-derived 0DTE
 * lottery fires. Mocks usePeriscopeLotteryFeed and asserts the
 * sectioning, empty states, badge rendering, and outcome pill.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PeriscopeLotteryPanel } from './PeriscopeLotteryPanel';
import type { PeriscopeLotteryFire } from './types';
import {
  srHintText,
  titledGenericsWithoutHint,
  visibleText,
} from '../../__tests__/helpers/aria';

const mockFeed = vi.fn();
const lastArgs = vi.fn<(args: unknown) => void>();
vi.mock('../../hooks/usePeriscopeLotteryFeed.js', () => ({
  usePeriscopeLotteryFeed: (args: unknown) => {
    lastArgs(args);
    return mockFeed();
  },
}));

beforeEach(() => {
  mockFeed.mockReset();
  lastArgs.mockReset();
});

function baseFire(
  overrides: Partial<PeriscopeLotteryFire>,
): PeriscopeLotteryFire {
  return {
    id: 1,
    fireType: 'call_lottery',
    fireTime: '2026-05-18T18:43:12Z',
    expiry: '2026-05-18',
    eventStrike: 7380,
    tradeStrike: 7430,
    spotAtEvent: 7362.14,
    strikeDist: 17.86,
    greekPost: -7403.4,
    greekDelta: -4513.3,
    greekLvlRank: 0.95,
    greekChgRank: 0.999,
    gexDollars: -974008661,
    callRatio: -3.58,
    qqqNetPremBalance30m: 0.6,
    entryPx: 0.1,
    vix: 18.31,
    v3StrictPass: true,
    v4Badge: true,
    peakPx: 25,
    peakPct: 250,
    peakTime: '2026-05-18T19:01:47Z',
    eodClosePx: 0.05,
    realizedRPeak: 249,
    realizedREod: -0.5,
    outcomeLocked: true,
    createdAt: '2026-05-18T18:43:50Z',
    ...overrides,
  };
}

describe('PeriscopeLotteryPanel', () => {
  it('renders both columns with empty-state messages when no fires', () => {
    mockFeed.mockReturnValue({
      fires: [],
      loading: false,
      error: null,
      fetchedAt: null,
      refresh: vi.fn(),
    });
    render(<PeriscopeLotteryPanel marketOpen={false} />);

    expect(screen.getByText('Call Lottery')).toBeInTheDocument();
    expect(screen.getByText('Put Lottery')).toBeInTheDocument();
    const emptyMsgs = screen.getAllByText(/No fires today yet/);
    expect(emptyMsgs).toHaveLength(2);
  });

  it('splits fires between columns by fireType', () => {
    const callFire = baseFire({
      id: 1,
      fireType: 'call_lottery',
      tradeStrike: 7430,
    });
    const putFire = baseFire({
      id: 2,
      fireType: 'put_lottery',
      tradeStrike: 7055,
      eventStrike: 7100,
      strikeDist: 12.5,
      greekPost: 5500,
      greekDelta: 3200,
      qqqNetPremBalance30m: null,
      entryPx: 0.42,
      v3StrictPass: true,
      v4Badge: false,
      peakPct: 80,
      realizedRPeak: 0.9,
    });
    mockFeed.mockReturnValue({
      fires: [callFire, putFire],
      loading: false,
      error: null,
      fetchedAt: Date.now(),
      refresh: vi.fn(),
    });
    render(<PeriscopeLotteryPanel marketOpen={true} />);

    const callCol = screen.getByLabelText('Call Lottery');
    const putCol = screen.getByLabelText('Put Lottery');
    expect(within(callCol).getByText('7430C')).toBeInTheDocument();
    expect(within(putCol).getByText('7055P')).toBeInTheDocument();
    // Each column shows exactly one row
    expect(
      within(callCol).getAllByTestId('periscope-lottery-row'),
    ).toHaveLength(1);
    expect(within(putCol).getAllByTestId('periscope-lottery-row')).toHaveLength(
      1,
    );
  });

  it('renders V4 badge over V3 when v4Badge=true', () => {
    mockFeed.mockReturnValue({
      fires: [baseFire({ v3StrictPass: true, v4Badge: true })],
      loading: false,
      error: null,
      fetchedAt: Date.now(),
      refresh: vi.fn(),
    });
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    expect(screen.getByText('V4')).toBeInTheDocument();
    expect(screen.queryByText('V3')).not.toBeInTheDocument();
  });

  it('renders V3 badge when only v3StrictPass is true', () => {
    mockFeed.mockReturnValue({
      fires: [baseFire({ v3StrictPass: true, v4Badge: false })],
      loading: false,
      error: null,
      fetchedAt: Date.now(),
      refresh: vi.fn(),
    });
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    expect(screen.getByText('V3')).toBeInTheDocument();
    expect(screen.queryByText('V4')).not.toBeInTheDocument();
  });

  it('renders outcome pill with peak% and EOD R when locked', () => {
    mockFeed.mockReturnValue({
      fires: [
        baseFire({
          outcomeLocked: true,
          peakPct: 250,
          realizedRPeak: 249,
          realizedREod: -0.5,
        }),
      ],
      loading: false,
      error: null,
      fetchedAt: Date.now(),
      refresh: vi.fn(),
    });
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    // peak 250% · eod -0.50R
    expect(screen.getByText(/peak 250%/)).toBeInTheDocument();
    expect(screen.getByText(/-0.50R/)).toBeInTheDocument();
  });

  it('gives the outcome pill its peak R as a screen-reader hint, and keeps the hover title', () => {
    mockFeed.mockReturnValue({
      fires: [
        baseFire({
          outcomeLocked: true,
          peakPct: 250,
          realizedRPeak: 249,
          realizedREod: -0.5,
        }),
      ],
      loading: false,
      error: null,
      fetchedAt: Date.now(),
      refresh: vi.fn(),
    });
    const { container } = render(<PeriscopeLotteryPanel marketOpen={true} />);
    const pill = screen.getByText(/peak 250%/);
    expect(pill).toHaveAttribute('title', 'peak 250% (R=249.0) · eod -0.50R');
    expect(srHintText(pill)).toBe('at peak, R=249.0');
    // The sighted text is unchanged: the R figure is only in the title
    expect(visibleText(pill)).toBe('peak 250% · eod -0.50R');
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });

  it.each([
    { realizedRPeak: 249, hint: 'at peak, R=249.0' },
    { realizedRPeak: 0.9, hint: 'at peak, R=0.9' },
    { realizedRPeak: -0.5, hint: 'at peak, R=-0.5' },
    // A runaway multiple still keeps the per-row hint short
    { realizedRPeak: 12345678.9, hint: 'at peak, R=12345678.9' },
  ])(
    'keeps the outcome pill hint short in a per-row list ($hint)',
    ({ realizedRPeak, hint }) => {
      mockFeed.mockReturnValue({
        fires: [baseFire({ outcomeLocked: true, realizedRPeak })],
        loading: false,
        error: null,
        fetchedAt: Date.now(),
        refresh: vi.fn(),
      });
      render(<PeriscopeLotteryPanel marketOpen={true} />);
      const text = srHintText(screen.getByText(/peak 250%/));
      expect(text).toBe(hint);
      expect(text!.length).toBeLessThanOrEqual(60);
    },
  );

  it('drops the empty R from the outcome pill title when there is no peak R, so the title equals the visible text and needs no hint', () => {
    mockFeed.mockReturnValue({
      fires: [
        baseFire({
          outcomeLocked: true,
          peakPct: 250,
          realizedRPeak: null,
          realizedREod: -0.5,
        }),
      ],
      loading: false,
      error: null,
      fetchedAt: Date.now(),
      refresh: vi.fn(),
    });
    const { container } = render(<PeriscopeLotteryPanel marketOpen={true} />);
    const pill = screen.getByText(/peak 250%/);
    expect(pill).toHaveAttribute('title', 'peak 250% · eod -0.50R');
    expect(visibleText(pill)).toBe('peak 250% · eod -0.50R');
    expect(srHintText(pill)).toBeNull();
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });

  it('keeps the outcome pill title equal to its text when peak and EOD are both missing', () => {
    mockFeed.mockReturnValue({
      fires: [
        baseFire({
          outcomeLocked: true,
          peakPct: null,
          realizedRPeak: null,
          realizedREod: null,
        }),
      ],
      loading: false,
      error: null,
      fetchedAt: Date.now(),
      refresh: vi.fn(),
    });
    const { container } = render(<PeriscopeLotteryPanel marketOpen={true} />);
    const pill = screen.getByText('peak — · eod —');
    expect(pill).toHaveAttribute('title', 'peak — · eod —');
    expect(srHintText(pill)).toBeNull();
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });

  it('keeps the peak R in the title and hint when peak and EOD are missing', () => {
    mockFeed.mockReturnValue({
      fires: [
        baseFire({
          outcomeLocked: true,
          peakPct: null,
          realizedRPeak: 1,
          realizedREod: null,
        }),
      ],
      loading: false,
      error: null,
      fetchedAt: Date.now(),
      refresh: vi.fn(),
    });
    const { container } = render(<PeriscopeLotteryPanel marketOpen={true} />);
    const pill = screen.getByText('peak — · eod —');
    expect(pill).toHaveAttribute('title', 'peak — (R=1.0) · eod —');
    expect(srHintText(pill)).toBe('at peak, R=1.0');
    expect(visibleText(pill)).toBe('peak — · eod —');
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });

  it('omits outcome pill when outcome not yet locked', () => {
    mockFeed.mockReturnValue({
      fires: [
        baseFire({ outcomeLocked: false, peakPct: null, realizedRPeak: null }),
      ],
      loading: false,
      error: null,
      fetchedAt: Date.now(),
      refresh: vi.fn(),
    });
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    expect(screen.queryByText(/peak/i)).not.toBeInTheDocument();
  });

  it('surfaces hook error with role=alert', () => {
    mockFeed.mockReturnValue({
      fires: [],
      loading: false,
      error: 'HTTP 500',
      fetchedAt: null,
      refresh: vi.fn(),
    });
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500');
  });

  it('renders a date picker that defaults to today (ET) and clamps max=today', () => {
    mockFeed.mockReturnValue({
      fires: [],
      loading: false,
      error: null,
      fetchedAt: null,
      refresh: vi.fn(),
    });
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    const picker = screen.getByLabelText(
      'Pick a date to view Periscope Lottery fires',
    ) as HTMLInputElement;
    expect(picker.type).toBe('date');
    // Default value === today (ET). We assert the format rather than
    // the exact string so the test survives day-to-day.
    expect(picker.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(picker.max).toBe(picker.value);
  });

  it('threads the selected date into the hook and marks past dates historical', () => {
    mockFeed.mockReturnValue({
      fires: [],
      loading: false,
      error: null,
      fetchedAt: null,
      refresh: vi.fn(),
    });
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    const picker = screen.getByLabelText(
      'Pick a date to view Periscope Lottery fires',
    ) as HTMLInputElement;
    fireEvent.change(picker, { target: { value: '2024-01-01' } });
    // The hook was called with date='2024-01-01' and historical=true
    expect(lastArgs).toHaveBeenLastCalledWith(
      expect.objectContaining({
        date: '2024-01-01',
        historical: true,
      }),
    );
  });

  it('links the strike label to the UW chain page for SPXW 0DTE', () => {
    mockFeed.mockReturnValue({
      fires: [
        baseFire({
          fireType: 'call_lottery',
          expiry: '2026-05-18',
          tradeStrike: 7430,
        }),
      ],
      loading: false,
      error: null,
      fetchedAt: Date.now(),
      refresh: vi.fn(),
    });
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    const link = screen.getByRole('link', { name: '7430C' });
    // The expiry segment of OCC is YYMMDD from today() (the date the
    // panel runs on). We only assert the deterministic pieces — the
    // root + side + strike — so the test doesn't depend on the mock
    // date matching today's real date.
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('href')).toMatch(
      /unusualwhales\.com\/flow\/option_chains\?chain=SPXW\d{6}C07430000/,
    );
  });
});

// The Δstrike cell shows where the strike sits against spot: + above it,
// − below it. The feed's strikeDist is signed on the fire's own side (call:
// strike − spot, put: spot − strike), so the shown number is +strikeDist for
// a call and −strikeDist for a put, printed with its real sign. A fire whose
// spot was repaired after the fact can have a negative strikeDist (the spot
// moved past the strike); a fixed sign in front of it read "+-10.0".
describe('PeriscopeLotteryPanel Δstrike', () => {
  /** The text of the Δstrike cell of the only row on screen. */
  function strikeOffsetText(): string | null | undefined {
    const row = screen.getByTestId('periscope-lottery-row');
    return within(row).getByText('Δstrike').nextElementSibling?.textContent;
  }

  it.each([
    // What a fire shows today: unchanged.
    { fireType: 'call_lottery', strikeDist: 17.86, shown: '+17.9' },
    { fireType: 'put_lottery', strikeDist: 12.5, shown: '−12.5' },
    // A repaired fire whose spot passed the strike: the real side, one sign.
    { fireType: 'call_lottery', strikeDist: -10, shown: '−10.0' },
    { fireType: 'put_lottery', strikeDist: -10, shown: '+10.0' },
    // Never "−0.0" for a put exactly at spot (−strikeDist would be −0).
    { fireType: 'put_lottery', strikeDist: 0, shown: '+0.0' },
  ] as const)(
    'shows a $fireType at strikeDist $strikeDist as $shown',
    ({ fireType, strikeDist, shown }) => {
      mockFeed.mockReturnValue({
        fires: [baseFire({ fireType, strikeDist })],
        loading: false,
        error: null,
        fetchedAt: Date.now(),
        refresh: vi.fn(),
      });
      render(<PeriscopeLotteryPanel marketOpen={true} />);

      expect(strikeOffsetText()).toBe(shown);
      expect(strikeOffsetText()).not.toMatch(/[+−]-/);
    },
  );
});

describe('PeriscopeLotteryPanel pause on GEXBot data', () => {
  const feed = (over: Record<string, unknown>) =>
    mockFeed.mockReturnValue({
      fires: [],
      loading: false,
      error: null,
      fetchedAt: null,
      paused: false,
      refresh: vi.fn(),
      ...over,
    });

  it('shows the pause banner and a source-neutral subtitle when paused', () => {
    feed({ paused: true });
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    expect(
      screen.getByRole('status', { name: 'Periscope alerts paused' }),
    ).toHaveTextContent(
      'Paused — these alerts were tuned on UW Periscope data; live data is GEXBot. GEXBot-specific rules pending.',
    );
    expect(screen.queryByText(/MM gamma/)).toBeNull();
    expect(screen.getByText(/gamma \+ charm extremes/)).toBeInTheDocument();
  });

  it('keeps stored fires visible while paused', () => {
    feed({ paused: true, fires: [baseFire({ id: 9 })] });
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    expect(screen.getAllByTestId('periscope-lottery-row')).toHaveLength(1);
  });

  it('keeps the MM label and no banner on a scraper-era date', () => {
    feed({ paused: false });
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText(/MM gamma \+ charm extremes/)).toBeInTheDocument();
  });
});

function mockEmptyFeed() {
  mockFeed.mockReturnValue({
    fires: [],
    loading: false,
    error: null,
    fetchedAt: null,
    paused: false,
    refresh: vi.fn(),
  });
}

// ============================================================
// ET MIDNIGHT WHILE THE APP IS OPEN
//
// The panel follows today unless the owner picked another date. It froze
// `today` at mount (useMemo with no deps), so a tab left open past ET
// midnight kept polling yesterday as live through the next session, and
// `max` stopped the owner picking the new day. The shared ET clock now moves
// it. Every case starts 30 s before an ET midnight; the clock's timer is
// armed for 1 s past it, so 31 s lands just after. The real getETToday()
// reads the faked Date. Owner decision 2026-11-14.
// ============================================================

describe.each([
  {
    zone: 'EST (winter)',
    start: '2026-11-10T04:59:30Z',
    night: '2026-11-09',
    morning: '2026-11-10',
  },
  {
    zone: 'EDT (summer)',
    start: '2026-07-15T03:59:30Z',
    night: '2026-07-14',
    morning: '2026-07-15',
  },
])('PeriscopeLotteryPanel: across the $zone midnight', (m) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(m.start));
    mockEmptyFeed();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The shared clock's timer fires, just past midnight. */
  function crossMidnight() {
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
  }

  const picker = () =>
    screen.getByLabelText<HTMLInputElement>(
      'Pick a date to view Periscope Lottery fires',
    );
  /** The arguments of the panel's latest usePeriscopeLotteryFeed call. */
  const lastCall = () =>
    lastArgs.mock.calls.at(-1)?.[0] as {
      date: string;
      marketOpen: boolean;
      historical: boolean;
    };

  function pick(date: string) {
    fireEvent.change(picker(), { target: { value: date } });
  }

  it('follows the new date, keeps it live, and moves the picker max', () => {
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    expect(picker().value).toBe(m.night);
    expect(picker().max).toBe(m.night);
    expect(lastCall()).toMatchObject({ date: m.night, historical: false });

    crossMidnight();

    expect(picker().value).toBe(m.morning);
    expect(picker().max).toBe(m.morning);
    expect(lastCall()).toMatchObject({ date: m.morning, historical: false });
  });

  it('rolls with no parent re-render', () => {
    let parentRenders = 0;
    function Parent() {
      parentRenders += 1;
      return <PeriscopeLotteryPanel marketOpen={true} />;
    }
    render(<Parent />);
    const callsBefore = lastArgs.mock.calls.length;

    crossMidnight();

    expect(parentRenders).toBe(1);
    expect(lastArgs.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(picker().value).toBe(m.morning);
  });

  it('judges the date live in a render just past midnight, before the clock ticks', () => {
    const { rerender } = render(<PeriscopeLotteryPanel marketOpen={true} />);

    // The wall clock is past midnight; the shared clock has not ticked, so
    // the date is still the night's. A render now (the market-open prop
    // changes) must judge it live by the same clock, not by the wall clock.
    act(() => {
      vi.setSystemTime(new Date(Date.parse(m.start) + 30_500));
    });
    rerender(<PeriscopeLotteryPanel marketOpen={false} />);

    expect(picker().value).toBe(m.night);
    expect(lastCall()).toMatchObject({
      date: m.night,
      marketOpen: false,
      historical: false,
    });
  });

  it('keeps a picked past date, historical', () => {
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    pick('2026-04-20');
    expect(lastCall()).toMatchObject({
      date: '2026-04-20',
      historical: true,
    });

    crossMidnight();

    expect(picker().value).toBe('2026-04-20');
    expect(lastCall()).toMatchObject({
      date: '2026-04-20',
      historical: true,
    });
  });

  it('treats a picked tomorrow as not live until midnight reaches it', () => {
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    pick(m.morning);

    // Live means the picked date is today. A future date is not today: it does
    // not poll, and shows what the panel shows for any date that is not live.
    expect(picker().max).toBe(m.night);
    expect(lastCall()).toMatchObject({ date: m.morning, historical: true });
    expect(screen.queryByText(/auto-refreshes every 60s/)).toBeNull();
    expect(
      screen.getByText(/historical — outcomes locked/),
    ).toBeInTheDocument();

    crossMidnight();

    // Now it is today: live, polling, auto-refreshing.
    expect(picker().value).toBe(m.morning);
    expect(picker().max).toBe(m.morning);
    expect(lastCall()).toMatchObject({ date: m.morning, historical: false });
    expect(screen.getByText(/auto-refreshes every 60s/)).toBeInTheDocument();
    expect(screen.queryByText(/historical — outcomes locked/)).toBeNull();
  });

  it('lets the owner pick the new day once it has begun', () => {
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    pick('2026-04-20');

    crossMidnight();
    // `max` is the new day, so the new day itself is a valid pick, and
    // picking it means following today again.
    expect(picker().max).toBe(m.morning);
    pick(m.morning);

    expect(picker().value).toBe(m.morning);
    expect(lastCall()).toMatchObject({ date: m.morning, historical: false });
  });

  it('keeps the picked date while the field is empty, and follows today once it is left', () => {
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    pick('2026-04-20');

    // Emptying the field (the first "0" of a zero-padded month does it) is
    // mid-edit: the data keeps the picked date.
    pick('');

    expect(picker().value).toBe('');
    expect(lastCall()).toMatchObject({
      date: '2026-04-20',
      historical: true,
    });

    // Leaving it empty follows today.
    fireEvent.blur(picker());

    expect(picker().value).toBe(m.night);
    expect(lastCall()).toMatchObject({ date: m.night, historical: false });

    crossMidnight();

    expect(picker().value).toBe(m.morning);
    expect(lastCall()).toMatchObject({ date: m.morning, historical: false });
  });
});

describe('PeriscopeLotteryPanel: typing a date', () => {
  it('takes a date typed key by key over the field', async () => {
    mockEmptyFeed();
    const user = userEvent.setup();
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    const input = screen.getByLabelText<HTMLInputElement>(
      'Pick a date to view Periscope Lottery fires',
    );

    // Emptying the field first must not snap it back to today and lose the
    // typing: the shared DateInput keeps an emptied field as a local draft.
    await user.clear(input);
    await user.type(input, '2026-04-21');

    expect(input.value).toBe('2026-04-21');
    expect(lastArgs.mock.calls.at(-1)?.[0]).toMatchObject({
      date: '2026-04-21',
      historical: true,
    });
  });
});
