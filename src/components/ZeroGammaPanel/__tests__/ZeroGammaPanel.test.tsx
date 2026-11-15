import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ZeroGammaPanel } from '../index';
import type {
  UseZeroGammaReturn,
  ZeroGammaRow,
} from '../../../hooks/useZeroGamma';

// The panel orchestrates four per-ticker hook calls and renders four
// TickerCards plus a date scrubber. We mock the hook so the panel never
// hits the real /api/zero-gamma endpoint and we can drive each scenario
// (loading, error, data, empty) deterministically.
const useZeroGammaMock = vi.fn();
vi.mock('../../../hooks/useZeroGamma', () => ({
  useZeroGamma: (...args: unknown[]) => useZeroGammaMock(...args),
}));

// Pin "today" in ET so the LIVE button visibility logic is deterministic
// regardless of when the test runs. The panel follows the shared ET clock
// (useETToday), which reads getETToday(). `getETToday` reads `clock.today`
// when called, and the clock and the date helper (useFollowedDate) import it
// from this same module, so moving `clock.today` moves the date they follow.
// The midnight tests below move it; every other test sees the fixed day.
const clock = vi.hoisted(() => ({ today: '2026-04-28' }));

vi.mock('../../../utils/timezone', async () => {
  const actual = await vi.importActual<
    typeof import('../../../utils/timezone')
  >('../../../utils/timezone');
  return {
    ...actual,
    getETToday: () => clock.today,
  };
});

function row(overrides: Partial<ZeroGammaRow> = {}): ZeroGammaRow {
  return {
    ticker: 'SPX',
    spot: 7100,
    zeroGamma: 7050,
    confidence: 0.7,
    netGammaAtSpot: -1e9,
    gammaCurve: null,
    ts: '2026-04-28T20:10:00.000Z',
    ...overrides,
  };
}

function makeReturn(
  overrides: Partial<UseZeroGammaReturn> = {},
): UseZeroGammaReturn {
  return {
    latest: null,
    history: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  useZeroGammaMock.mockReset();
  clock.today = '2026-04-28';
});

describe('ZeroGammaPanel orchestration', () => {
  it('renders the section with an accessible name', () => {
    useZeroGammaMock.mockReturnValue(makeReturn({ loading: true }));
    render(<ZeroGammaPanel marketOpen={true} />);
    // SectionBox renders <section aria-label="Zero Gamma">.
    expect(
      screen.getByRole('region', { name: /zero gamma/i }),
    ).toBeInTheDocument();
  });

  it('renders a TickerCard for each of the three tickers', () => {
    // Drive every per-ticker hook call into the loading branch so each
    // card prints its own header and we can count them by ticker label.
    useZeroGammaMock.mockReturnValue(makeReturn({ loading: true }));
    render(<ZeroGammaPanel marketOpen={true} />);
    // Three mock hook calls — one per TickerCardContainer.
    expect(useZeroGammaMock).toHaveBeenCalledTimes(3);
    for (const ticker of ['SPX', 'SPY', 'QQQ']) {
      expect(screen.getByText(ticker)).toBeInTheDocument();
    }
    // NDX was dropped 2026-05-16 — its card must not render.
    expect(screen.queryByText('NDX')).not.toBeInTheDocument();
    // Loading is the per-card placeholder; should appear three times.
    expect(screen.getAllByText('Loading…')).toHaveLength(3);
  });

  it('surfaces per-ticker errors via TickerCard alert role', () => {
    useZeroGammaMock.mockReturnValue(
      makeReturn({ loading: false, error: 'Failed to load zero-gamma data' }),
    );
    render(<ZeroGammaPanel marketOpen={true} />);
    // Each card renders its own alert when error is set.
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(3);
    expect(alerts[0]).toHaveTextContent(/failed to load/i);
  });

  it('renders a TickerCard with data when the hook returns a snapshot', () => {
    const snapshot = row({ spot: 7100, zeroGamma: 7050 });
    useZeroGammaMock.mockReturnValue(
      makeReturn({ latest: snapshot, history: [snapshot], loading: false }),
    );
    render(<ZeroGammaPanel marketOpen={true} />);
    // At least one regime label means a data card actually rendered. All
    // three cards share the same mock return so we expect three labels.
    expect(screen.getAllByText('SUPPRESSION')).toHaveLength(3);
  });

  it('renders the empty "No data yet" state when latest is null without error/loading', () => {
    // This is the deserted-dashboard branch — easy to silently regress
    // into a blank panel or a crash if the hook ever returns latest=null
    // with loading=false and no error (e.g. archived day with no rows).
    useZeroGammaMock.mockReturnValue(
      makeReturn({ latest: null, history: [], loading: false, error: null }),
    );
    render(<ZeroGammaPanel marketOpen={true} />);
    expect(screen.getAllByText('No data yet')).toHaveLength(3);
  });

  it('starts with the LIVE button hidden when the date input is today', () => {
    useZeroGammaMock.mockReturnValue(makeReturn({ loading: true }));
    render(<ZeroGammaPanel marketOpen={true} />);
    // isLive=true by default → no LIVE reset button shown.
    expect(
      screen.queryByRole('button', { name: /^live$/i }),
    ).not.toBeInTheDocument();
    // Calls pass `null` for date when live (omits ?date=... in the hook).
    for (const call of useZeroGammaMock.mock.calls) {
      expect(call[2]).toBeNull();
    }
  });

  it('switches the date scrubber and reveals a LIVE button that snaps back', async () => {
    const user = userEvent.setup();
    useZeroGammaMock.mockReturnValue(makeReturn({ loading: true }));
    render(<ZeroGammaPanel marketOpen={true} />);

    const region = screen.getByRole('region', { name: /zero gamma/i });
    const dateInput = within(region).getByLabelText(/zero gamma date/i);

    // Scrub to a past date — LIVE button appears, hooks re-call with date.
    useZeroGammaMock.mockClear();
    // Typed key by key over the field, as the owner does. Emptying it first
    // must not snap it back to today and lose the typing: regression for the
    // shared DateInput, which keeps an emptied field as a local draft.
    await user.clear(dateInput);
    await user.type(dateInput, '2026-04-21');

    const liveBtn = await screen.findByRole('button', { name: /^live$/i });
    expect(liveBtn).toBeInTheDocument();

    // After scrubbing, the per-ticker hook calls should pass the date arg
    // and force marketOpen=false (no polling on a frozen historical day).
    const lastCall = useZeroGammaMock.mock.calls.at(-1);
    expect(lastCall?.[1]).toBe(false);
    expect(lastCall?.[2]).toBe('2026-04-21');

    // LIVE click resets to today and removes itself.
    await user.click(liveBtn);
    expect(
      screen.queryByRole('button', { name: /^live$/i }),
    ).not.toBeInTheDocument();
  });
});

// ============================================================
// ET MIDNIGHT WHILE THE APP IS OPEN
//
// The panel follows today unless the owner picked another date, and one date
// feeds all three ticker cards. It is memoized, so it skips App's midnight
// re-render: only the shared ET clock can move it. Every case starts 30 s
// before an ET midnight; the clock's timer is armed for 1 s past it, so 31 s
// lands just after. Owner decision 2026-11-14.
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
])('ZeroGammaPanel: across the $zone midnight', (m) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(m.start));
    clock.today = m.night;
    useZeroGammaMock.mockReturnValue(makeReturn({ loading: true }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The wall clock passes midnight, then the shared clock's timer fires. */
  function crossMidnight() {
    clock.today = m.morning;
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
  }

  const dateInput = () =>
    screen.getByLabelText<HTMLInputElement>('Zero gamma date');
  const liveButton = () => screen.queryByRole('button', { name: /^live$/i });
  /** The three latest per-ticker hook calls: (ticker, marketOpen, date). */
  const lastRender = () => useZeroGammaMock.mock.calls.slice(-3);
  const liveRender = (marketOpen: boolean) => [
    ['SPX', marketOpen, null],
    ['SPY', marketOpen, null],
    ['QQQ', marketOpen, null],
  ];
  const pastRender = (date: string) => [
    ['SPX', false, date],
    ['SPY', false, date],
    ['QQQ', false, date],
  ];

  function pick(date: string) {
    fireEvent.change(dateInput(), { target: { value: date } });
  }

  it('follows the new date and keeps all three cards on the live data path', () => {
    render(<ZeroGammaPanel marketOpen={true} />);
    expect(dateInput().value).toBe(m.night);
    expect(lastRender()).toEqual(liveRender(true));

    crossMidnight();

    expect(dateInput().value).toBe(m.morning);
    expect(lastRender()).toEqual(liveRender(true));
    expect(liveButton()).not.toBeInTheDocument();
  });

  it('follows marketOpen on the live path when the market is closed', () => {
    render(<ZeroGammaPanel marketOpen={false} />);
    expect(lastRender()).toEqual(liveRender(false));

    crossMidnight();

    expect(dateInput().value).toBe(m.morning);
    expect(lastRender()).toEqual(liveRender(false));
  });

  it('rolls with no parent re-render', () => {
    let parentRenders = 0;
    function Parent() {
      parentRenders += 1;
      return <ZeroGammaPanel marketOpen={true} />;
    }
    render(<Parent />);
    const callsBefore = useZeroGammaMock.mock.calls.length;

    crossMidnight();

    expect(parentRenders).toBe(1);
    expect(useZeroGammaMock.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(dateInput().value).toBe(m.morning);
  });

  it('judges the date live in a render just past midnight, before the clock ticks', () => {
    const { rerender } = render(<ZeroGammaPanel marketOpen={true} />);

    // The wall clock is past midnight; the shared clock has not ticked, so
    // the date is still the night's. A render now (the market-open prop
    // changes) must judge it live by the same clock, not by the wall clock.
    clock.today = m.morning;
    rerender(<ZeroGammaPanel marketOpen={false} />);

    expect(dateInput().value).toBe(m.night);
    expect(lastRender()).toEqual(liveRender(false));
    expect(liveButton()).not.toBeInTheDocument();
  });

  it('keeps a picked past date', () => {
    render(<ZeroGammaPanel marketOpen={true} />);
    pick('2026-04-20');
    expect(lastRender()).toEqual(pastRender('2026-04-20'));
    expect(liveButton()).toBeInTheDocument();

    crossMidnight();

    expect(dateInput().value).toBe('2026-04-20');
    expect(lastRender()).toEqual(pastRender('2026-04-20'));
    expect(liveButton()).toBeInTheDocument();
  });

  it('LIVE goes back to following today', () => {
    render(<ZeroGammaPanel marketOpen={true} />);
    pick('2026-04-20');

    fireEvent.click(screen.getByRole('button', { name: /^live$/i }));

    expect(dateInput().value).toBe(m.night);
    expect(lastRender()).toEqual(liveRender(true));
    expect(liveButton()).not.toBeInTheDocument();

    // Following, not pinned to the night's string.
    crossMidnight();

    expect(dateInput().value).toBe(m.morning);
    expect(lastRender()).toEqual(liveRender(true));
    expect(liveButton()).not.toBeInTheDocument();
  });

  it('LIVE clicked just past midnight, before the clock ticks, follows the new day', () => {
    render(<ZeroGammaPanel marketOpen={true} />);
    pick('2026-04-20');

    // The wall clock is past midnight; the shared clock has not ticked, so
    // its `today` is still the night's. LIVE must not pin that string.
    clock.today = m.morning;
    fireEvent.click(screen.getByRole('button', { name: /^live$/i }));
    act(() => {
      vi.advanceTimersByTime(31_000);
    });

    expect(dateInput().value).toBe(m.morning);
    expect(lastRender()).toEqual(liveRender(true));
    expect(liveButton()).not.toBeInTheDocument();
  });

  it('keeps the picked date while the field is empty, and follows today once it is left', () => {
    render(<ZeroGammaPanel marketOpen={true} />);
    pick('2026-04-20');

    // Emptying the field (the first "0" of a zero-padded month does it) is
    // mid-edit: the three cards keep the picked date.
    pick('');

    expect(dateInput().value).toBe('');
    expect(lastRender()).toEqual(pastRender('2026-04-20'));

    // Leaving it empty follows today.
    fireEvent.blur(dateInput());

    expect(dateInput().value).toBe(m.night);
    expect(lastRender()).toEqual(liveRender(true));

    crossMidnight();

    expect(dateInput().value).toBe(m.morning);
    expect(lastRender()).toEqual(liveRender(true));
  });

  it('takes a date typed over an emptied field, not today', () => {
    render(<ZeroGammaPanel marketOpen={true} />);

    pick('');
    pick('2026-04-09');

    expect(dateInput().value).toBe('2026-04-09');
    expect(lastRender()).toEqual(pastRender('2026-04-09'));
  });
});
