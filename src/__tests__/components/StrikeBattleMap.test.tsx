import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrikeBattleMap } from '../../components/StrikeBattleMap';
import type {
  GexStrikeExpiryResponse,
  GexStrikeExpiryRow,
  UseGexStrikeExpiryReturn,
} from '../../hooks/useGexStrikeExpiry';

vi.mock('../../hooks/useGexStrikeExpiry', async () => {
  const actual = await vi.importActual<
    typeof import('../../hooks/useGexStrikeExpiry')
  >('../../hooks/useGexStrikeExpiry');
  return { ...actual, useGexStrikeExpiry: vi.fn() };
});

// The mocked clock. `getETToday` reads this when called, and the shared ET
// clock (useETToday) and the date helper (useFollowedDate) import it from the
// same module, so moving `clock.today` moves the date they follow. The
// midnight tests below move it; every other test sees the fixed day.
const clock = vi.hoisted(() => ({ today: '2026-05-04' }));

vi.mock('../../utils/timezone', async () => {
  const actual = await vi.importActual<typeof import('../../utils/timezone')>(
    '../../utils/timezone',
  );
  return { ...actual, getETToday: () => clock.today };
});

import { useGexStrikeExpiry } from '../../hooks/useGexStrikeExpiry';

const mockHook = vi.mocked(useGexStrikeExpiry);

function makeRow(
  overrides: Partial<GexStrikeExpiryRow> = {},
): GexStrikeExpiryRow {
  const base: GexStrikeExpiryRow = {
    ticker: 'SPY',
    expiry: '2026-05-04',
    strike: 720,
    ts_minute: '2026-05-04T19:30:00Z',
    price: 720.5,
    call_gamma_oi: 0,
    put_gamma_oi: 0,
    call_charm_oi: null,
    put_charm_oi: null,
    call_vanna_oi: null,
    put_vanna_oi: null,
    call_gamma_vol: null,
    put_gamma_vol: null,
    call_charm_vol: null,
    put_charm_vol: null,
    call_vanna_vol: null,
    put_vanna_vol: null,
    call_gamma_ask_vol: 0,
    call_gamma_bid_vol: 0,
    put_gamma_ask_vol: 0,
    put_gamma_bid_vol: 0,
    call_charm_ask_vol: null,
    call_charm_bid_vol: null,
    put_charm_ask_vol: null,
    put_charm_bid_vol: null,
    call_vanna_ask_vol: null,
    call_vanna_bid_vol: null,
    put_vanna_ask_vol: null,
    put_vanna_bid_vol: null,
    gamma_delta_1m: null,
    gamma_delta_5m: null,
    gamma_delta_10m: null,
    gamma_delta_15m: null,
    gamma_delta_30m: null,
  };
  return { ...base, ...overrides };
}

function makeResponse(
  ticker: 'SPY' | 'QQQ' | 'SPX' | 'NDX',
  rows: GexStrikeExpiryRow[],
): GexStrikeExpiryResponse {
  return {
    ticker,
    expiry: '2026-05-04',
    at: null,
    rows,
    timestamps: [],
    asOf: '2026-05-04T19:35:00Z',
  };
}

function happyPathReturn(): UseGexStrikeExpiryReturn {
  // Spot 720.5; build 5 OTM call strikes (721-725) + 5 OTM put strikes (715-719).
  // Pile customer flow into 723 (a magnet) so concentration triggers the
  // highlighted strike border in the render assertions.
  const spy: GexStrikeExpiryRow[] = [];
  for (const strike of [
    715, 716, 717, 718, 719, 720, 721, 722, 723, 724, 725,
  ]) {
    const isMagnet = strike === 723;
    spy.push(
      makeRow({
        ticker: 'SPY',
        strike,
        price: 720.5,
        // Net dealer gamma swings strike-to-strike so the bottom bar renders.
        call_gamma_oi: strike > 720.5 ? 1000 : 0,
        put_gamma_oi: strike < 720.5 ? -800 : 0,
        // Customer flow concentrated at 723.
        call_gamma_ask_vol: isMagnet ? 5000 : strike > 720.5 ? 100 : 0,
        call_gamma_bid_vol: 0,
        put_gamma_ask_vol: 0,
        put_gamma_bid_vol: 0,
      }),
    );
  }
  const qqq: GexStrikeExpiryRow[] = [];
  // QQQ smeared: equal customer flow on every OTM strike.
  for (const strike of [499, 500, 501, 502, 503, 504, 505, 506, 507, 508]) {
    qqq.push(
      makeRow({
        ticker: 'QQQ',
        strike,
        price: 503.5,
        call_gamma_oi: strike > 503.5 ? 200 : 0,
        put_gamma_oi: strike < 503.5 ? -200 : 0,
        call_gamma_ask_vol: strike > 503.5 ? 100 : 0,
        call_gamma_bid_vol: 0,
        put_gamma_ask_vol: strike < 503.5 ? 100 : 0,
        put_gamma_bid_vol: 0,
      }),
    );
  }
  return {
    data: {
      SPY: makeResponse('SPY', spy),
      QQQ: makeResponse('QQQ', qqq),
      SPX: null,
      NDX: null,
    },
    loading: false,
    error: null,
    errors: { SPY: null, QQQ: null, SPX: null, NDX: null },
    refresh: vi.fn(),
  };
}

beforeEach(() => {
  mockHook.mockReset();
  clock.today = '2026-05-04';
});

describe('StrikeBattleMap', () => {
  it('renders the heading on initial mount', () => {
    mockHook.mockReturnValue({
      data: { SPY: null, QQQ: null, SPX: null, NDX: null },
      loading: true,
      error: null,
      errors: { SPY: null, QQQ: null, SPX: null, NDX: null },
      refresh: vi.fn(),
    });
    render(<StrikeBattleMap marketOpen={false} />);
    expect(
      screen.getByRole('heading', { name: /strike battle map/i }),
    ).toBeInTheDocument();
  });

  it('shows loading message before data arrives', () => {
    mockHook.mockReturnValue({
      data: { SPY: null, QQQ: null, SPX: null, NDX: null },
      loading: true,
      error: null,
      errors: { SPY: null, QQQ: null, SPX: null, NDX: null },
      refresh: vi.fn(),
    });
    render(<StrikeBattleMap marketOpen={true} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows the empty state when no rows are present yet', () => {
    mockHook.mockReturnValue({
      data: {
        SPY: makeResponse('SPY', []),
        QQQ: makeResponse('QQQ', []),
        SPX: null,
        NDX: null,
      },
      loading: false,
      error: null,
      errors: { SPY: null, QQQ: null, SPX: null, NDX: null },
      refresh: vi.fn(),
    });
    render(<StrikeBattleMap marketOpen={true} />);
    expect(screen.getByText(/No strike-level GEX yet/i)).toBeInTheDocument();
  });

  it('renders an alert when fetch errors and no data exists', () => {
    mockHook.mockReturnValue({
      data: { SPY: null, QQQ: null, SPX: null, NDX: null },
      loading: false,
      error: 'Partial fetch failure: SPY, QQQ, SPX, NDX',
      errors: {
        SPY: 'HTTP 500',
        QQQ: 'HTTP 500',
        SPX: 'HTTP 500',
        NDX: 'HTTP 500',
      },
      refresh: vi.fn(),
    });
    render(<StrikeBattleMap marketOpen={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/partial fetch/i);
  });

  it('renders both ticker sections on the happy path', () => {
    mockHook.mockReturnValue(happyPathReturn());
    render(<StrikeBattleMap marketOpen={true} />);
    expect(screen.getByTestId('battle-map-ticker-SPY')).toBeInTheDocument();
    expect(screen.getByTestId('battle-map-ticker-QQQ')).toBeInTheDocument();
  });

  it('renders 10 strike rows (5 OTM call + 5 OTM put) per ticker', () => {
    mockHook.mockReturnValue(happyPathReturn());
    render(<StrikeBattleMap marketOpen={true} />);
    // SPY: nearest puts 716-720, nearest calls 721-725 around spot 720.5
    for (const strike of [716, 717, 718, 719, 720, 721, 722, 723, 724, 725]) {
      expect(screen.getByTestId(`strike-row-${strike}`)).toBeInTheDocument();
    }
  });

  it('flags the magnet strike with the concentration label in the SPY header', () => {
    mockHook.mockReturnValue(happyPathReturn());
    render(<StrikeBattleMap marketOpen={true} />);
    const spy = screen.getByTestId('battle-map-ticker-SPY');
    // SPY has flow piled at 723 → "magnet @ 723"
    expect(spy.textContent).toMatch(/magnet @ 723/);
  });

  it('flags QQQ as smeared when flow is evenly spread', () => {
    mockHook.mockReturnValue(happyPathReturn());
    render(<StrikeBattleMap marketOpen={true} />);
    const qqq = screen.getByTestId('battle-map-ticker-QQQ');
    // QQQ has equal flow on every OTM strike → 'smeared' label
    expect(qqq.textContent).toMatch(/smeared/);
  });

  it('toggles to 20 strikes when the user picks the wider view', () => {
    // Extend the SPY fixture to 21 strikes (711-731) so the wider view
    // has enough material to actually show 20 (10 calls + 10 puts) at
    // spot 720.5.
    const spy: GexStrikeExpiryRow[] = [];
    for (let strike = 711; strike <= 731; strike++) {
      spy.push(
        makeRow({
          ticker: 'SPY',
          strike,
          price: 720.5,
          call_gamma_oi: strike > 720.5 ? 1000 : 0,
          put_gamma_oi: strike < 720.5 ? -800 : 0,
          call_gamma_ask_vol: strike > 720.5 ? 100 : 0,
          put_gamma_ask_vol: strike < 720.5 ? 80 : 0,
        }),
      );
    }
    mockHook.mockReturnValue({
      data: {
        SPY: makeResponse('SPY', spy),
        QQQ: null,
        SPX: null,
        NDX: null,
      },
      loading: false,
      error: null,
      errors: { SPY: null, QQQ: null, SPX: null, NDX: null },
      refresh: vi.fn(),
    });
    render(<StrikeBattleMap marketOpen={true} />);

    // Default view: 10 strikes (716–725 around spot 720.5).
    expect(screen.getByTestId('strike-row-716')).toBeInTheDocument();
    expect(screen.getByTestId('strike-row-725')).toBeInTheDocument();
    expect(screen.queryByTestId('strike-row-715')).not.toBeInTheDocument();
    expect(screen.queryByTestId('strike-row-726')).not.toBeInTheDocument();

    // Click the "20" toggle in the radiogroup.
    const wider = screen.getByRole('radio', { name: '20' });
    fireEvent.click(wider);

    // Now strikes 711–730 should be visible (10 calls + 10 puts).
    expect(screen.getByTestId('strike-row-711')).toBeInTheDocument();
    expect(screen.getByTestId('strike-row-730')).toBeInTheDocument();
  });

  it('does not render a "no data" placeholder when one ticker has rows and the other does not', () => {
    mockHook.mockReturnValue({
      data: {
        SPY: happyPathReturn().data.SPY,
        QQQ: null,
        SPX: null,
        NDX: null,
      },
      loading: false,
      error: null,
      errors: { SPY: null, QQQ: null, SPX: null, NDX: null },
      refresh: vi.fn(),
    });
    render(<StrikeBattleMap marketOpen={true} />);
    expect(screen.getByTestId('battle-map-ticker-SPY')).toBeInTheDocument();
    // QQQ section still renders with its waiting-for-daemon placeholder.
    const qqq = screen.getByText(/Waiting for daemon to deliver QQQ/);
    expect(qqq).toBeInTheDocument();
  });

  it('renders the legend chips for flow / gamma / magnet', () => {
    mockHook.mockReturnValue(happyPathReturn());
    render(<StrikeBattleMap marketOpen={true} />);
    expect(screen.getByText(/bullish flow/i)).toBeInTheDocument();
    expect(screen.getByText(/bearish flow/i)).toBeInTheDocument();
    expect(screen.getByText(/dealer long γ/i)).toBeInTheDocument();
    expect(screen.getByText(/dealer short γ/i)).toBeInTheDocument();
    // 'magnet' also appears in the SPY ticker header — assert at least one.
    expect(screen.getAllByText(/magnet/i).length).toBeGreaterThan(0);
  });

  it('shows "LIVE" on the scrubber when on today during market hours', () => {
    mockHook.mockReturnValue(happyPathReturn());
    render(<StrikeBattleMap marketOpen={true} />);
    // Scrubber default value=null + liveAvailable=true → label "LIVE".
    const slider = screen.getByLabelText(/snapshot minute/i);
    expect(slider).toBeInTheDocument();
    // The scrubber renders the LIVE label as text in its left column.
    expect(screen.getAllByText(/^live$/i).length).toBeGreaterThan(0);
  });

  it('passes a UTC ISO `at` timestamp to the hook when the user scrubs to a minute', () => {
    mockHook.mockReturnValue(happyPathReturn());
    render(<StrikeBattleMap marketOpen={true} />);
    const slider = screen.getByLabelText(/snapshot minute/i);
    fireEvent.change(slider, { target: { value: '600' } }); // 10:00 CT
    const lastCall = mockHook.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    // Third positional arg is the `at` UTC ISO string.
    const at = lastCall?.[2];
    expect(typeof at).toBe('string');
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
  });

  it('resets `at` to null when the LIVE button is clicked after scrubbing', () => {
    mockHook.mockReturnValue(happyPathReturn());
    render(<StrikeBattleMap marketOpen={true} />);
    const slider = screen.getByLabelText(/snapshot minute/i);
    fireEvent.change(slider, { target: { value: '600' } });
    // After scrubbing, a LIVE *button* appears (separate from the LIVE
    // text label). Clicking it should reset minute → null → at null.
    const liveBtn = screen.getByRole('button', { name: /^live$/i });
    fireEvent.click(liveBtn);
    const lastCall = mockHook.mock.calls.at(-1);
    expect(lastCall?.[2]).toBeNull();
  });
});

// ============================================================
// ET MIDNIGHT WHILE THE APP IS OPEN
//
// The panel follows today unless the owner picked another date. It is
// memoized, so it skips App's midnight re-render: only the shared ET clock
// can move it. Every case starts 30 s before an ET midnight; the clock's
// timer is armed for 1 s past it, so 31 s lands just after. Owner decision
// 2026-11-14.
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
])('StrikeBattleMap: across the $zone midnight', (m) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(m.start));
    clock.today = m.night;
    mockHook.mockReturnValue(happyPathReturn());
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
    screen.getByLabelText<HTMLInputElement>('Strike Battle Map date');
  const todayButton = () => screen.queryByRole('button', { name: /^today$/i });
  /** The arguments of the panel's latest useGexStrikeExpiry call. */
  const lastCall = () => mockHook.mock.calls.at(-1);

  function pick(date: string) {
    fireEvent.change(dateInput(), { target: { value: date } });
  }

  it('follows the new date and stays live', () => {
    render(<StrikeBattleMap marketOpen={true} />);
    expect(dateInput().value).toBe(m.night);
    expect(lastCall()).toEqual([true, m.night, null]);

    crossMidnight();

    expect(dateInput().value).toBe(m.morning);
    expect(lastCall()).toEqual([true, m.morning, null]);
    expect(todayButton()).not.toBeInTheDocument();
  });

  it('rolls with no parent re-render', () => {
    let parentRenders = 0;
    function Parent() {
      parentRenders += 1;
      return <StrikeBattleMap marketOpen={true} />;
    }
    render(<Parent />);
    const callsBefore = mockHook.mock.calls.length;

    crossMidnight();

    expect(parentRenders).toBe(1);
    expect(mockHook.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(dateInput().value).toBe(m.morning);
  });

  it('clears a scrubbed minute when the date rolls', () => {
    render(<StrikeBattleMap marketOpen={true} />);
    fireEvent.change(screen.getByLabelText(/snapshot minute/i), {
      target: { value: '600' },
    });
    expect(lastCall()?.[2]).not.toBeNull();

    crossMidnight();

    expect(lastCall()).toEqual([true, m.morning, null]);
  });

  it('never asks for the new date at the old minute when it rolls while scrubbed', () => {
    render(<StrikeBattleMap marketOpen={true} />);
    fireEvent.change(screen.getByLabelText(/snapshot minute/i), {
      target: { value: '600' },
    });
    mockHook.mockClear();

    crossMidnight();

    // Not just the last call: no render, committed or not, may pair the new
    // date with the minute that belonged to the old one.
    const stale = mockHook.mock.calls.filter(
      (c) => c[1] === m.morning && c[2] !== null,
    );
    expect(stale).toEqual([]);
    expect(lastCall()).toEqual([true, m.morning, null]);
  });

  it('never asks for a picked date at the old minute when a date is picked while scrubbed', () => {
    render(<StrikeBattleMap marketOpen={true} />);
    fireEvent.change(screen.getByLabelText(/snapshot minute/i), {
      target: { value: '600' },
    });
    mockHook.mockClear();

    pick('2026-04-20');

    const stale = mockHook.mock.calls.filter(
      (c) => c[1] === '2026-04-20' && c[2] !== null,
    );
    expect(stale).toEqual([]);
    expect(lastCall()).toEqual([false, '2026-04-20', null]);
  });

  it('does not bring a scrubbed minute back when the date returns to the one it belonged to', () => {
    render(<StrikeBattleMap marketOpen={true} />);
    fireEvent.change(screen.getByLabelText(/snapshot minute/i), {
      target: { value: '600' },
    });

    pick('2026-04-20');
    pick(m.night);

    // The minute went with the night it was set on; coming back to that date
    // by hand starts at "latest", not at 10:00 again.
    expect(lastCall()?.[1]).toBe(m.night);
    expect(lastCall()?.[2]).toBeNull();
  });

  it('judges the date live in a render just past midnight, before the clock ticks', () => {
    render(<StrikeBattleMap marketOpen={true} />);

    // The wall clock is past midnight; the shared clock has not ticked, so
    // the date is still the night's. A render now (the strike-count click)
    // must judge it live by the same clock, not by the wall clock.
    clock.today = m.morning;
    fireEvent.click(screen.getByRole('radio', { name: '20' }));

    expect(dateInput().value).toBe(m.night);
    expect(lastCall()).toEqual([true, m.night, null]);
    expect(todayButton()).not.toBeInTheDocument();
  });

  it('keeps a picked past date', () => {
    render(<StrikeBattleMap marketOpen={true} />);
    pick('2026-04-20');
    expect(lastCall()).toEqual([false, '2026-04-20', null]);
    expect(todayButton()).toBeInTheDocument();

    crossMidnight();

    expect(dateInput().value).toBe('2026-04-20');
    expect(lastCall()).toEqual([false, '2026-04-20', null]);
    expect(todayButton()).toBeInTheDocument();
  });

  it('turns a picked tomorrow live when midnight reaches it', () => {
    render(<StrikeBattleMap marketOpen={true} />);
    pick(m.morning);
    expect(lastCall()).toEqual([false, m.morning, null]);
    expect(todayButton()).toBeInTheDocument();

    crossMidnight();

    expect(dateInput().value).toBe(m.morning);
    expect(lastCall()).toEqual([true, m.morning, null]);
    expect(todayButton()).not.toBeInTheDocument();
  });

  it('TODAY goes back to following the date', () => {
    render(<StrikeBattleMap marketOpen={true} />);
    pick('2026-04-20');

    fireEvent.click(screen.getByRole('button', { name: /^today$/i }));

    expect(dateInput().value).toBe(m.night);
    expect(lastCall()).toEqual([true, m.night, null]);
    expect(todayButton()).not.toBeInTheDocument();

    // Following, not pinned to the night's string.
    crossMidnight();

    expect(dateInput().value).toBe(m.morning);
    expect(lastCall()).toEqual([true, m.morning, null]);
    expect(todayButton()).not.toBeInTheDocument();
  });

  it('TODAY clicked just past midnight, before the clock ticks, follows the new day', () => {
    render(<StrikeBattleMap marketOpen={true} />);
    pick('2026-04-20');

    // The wall clock is past midnight; the shared clock has not ticked, so
    // its `today` is still the night's. TODAY must not pin that string.
    clock.today = m.morning;
    fireEvent.click(screen.getByRole('button', { name: /^today$/i }));
    act(() => {
      vi.advanceTimersByTime(31_000);
    });

    expect(dateInput().value).toBe(m.morning);
    expect(lastCall()).toEqual([true, m.morning, null]);
    expect(todayButton()).not.toBeInTheDocument();
  });

  it('keeps the picked date while the field is empty, and follows today once it is left', () => {
    render(<StrikeBattleMap marketOpen={true} />);
    pick('2026-04-20');

    // Emptying the field (the first "0" of a zero-padded month does it) is
    // mid-edit: the data keeps the picked date.
    pick('');

    expect(dateInput().value).toBe('');
    expect(lastCall()).toEqual([false, '2026-04-20', null]);

    // Leaving it empty follows today.
    fireEvent.blur(dateInput());

    expect(dateInput().value).toBe(m.night);
    expect(lastCall()).toEqual([true, m.night, null]);

    crossMidnight();

    expect(dateInput().value).toBe(m.morning);
    expect(lastCall()).toEqual([true, m.morning, null]);
  });
});

// Real timers: user-event's own waits never resolve under fake ones.
describe('StrikeBattleMap: typing a date', () => {
  it('takes a date typed key by key over the field', async () => {
    const user = userEvent.setup();
    mockHook.mockReturnValue(happyPathReturn());
    render(<StrikeBattleMap marketOpen={true} />);
    const input = screen.getByLabelText<HTMLInputElement>(
      'Strike Battle Map date',
    );

    // Emptying the field first must not snap it back to today and lose the
    // typing: the shared DateInput keeps an emptied field as a local draft.
    await user.clear(input);
    await user.type(input, '2026-04-21');

    expect(input.value).toBe('2026-04-21');
    expect(mockHook.mock.calls.at(-1)).toEqual([false, '2026-04-21', null]);
    expect(
      screen.getByRole('button', { name: /^today$/i }),
    ).toBeInTheDocument();
  });
});
