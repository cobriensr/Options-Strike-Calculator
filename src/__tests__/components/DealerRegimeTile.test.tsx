import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DealerRegimeTile } from '../../components/DealerRegimeTile';
import type {
  DealerRegimeRow,
  DealerRegimeResponse,
  UseDealerRegimeReturn,
} from '../../hooks/useDealerRegime';

vi.mock('../../hooks/useDealerRegime', async () => {
  const actual = await vi.importActual<
    typeof import('../../hooks/useDealerRegime')
  >('../../hooks/useDealerRegime');
  return { ...actual, useDealerRegime: vi.fn() };
});

import { useDealerRegime } from '../../hooks/useDealerRegime';
const mockHook = vi.mocked(useDealerRegime);

// Pin classifier's "now" so staleness assertions stay deterministic.
const TEST_NOW = Date.parse('2026-05-04T18:00:00Z');
const FRESH_TS = '2026-05-04T17:55:00Z'; // 5 min before TEST_NOW
const STALE_TS = '2026-05-04T17:30:00Z'; // 30 min before TEST_NOW

beforeEach(() => {
  mockHook.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(TEST_NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

function row(
  ticker: 'SPX' | 'SPY' | 'QQQ',
  overrides: Partial<DealerRegimeRow> = {},
): DealerRegimeRow {
  return {
    ticker,
    ts: FRESH_TS,
    spot: 7240,
    zeroGamma: 7180,
    confidence: 0.4,
    netGammaAtSpot: 3_500_000_000,
    ...overrides,
  };
}

function ret(rows: DealerRegimeRow[]): UseDealerRegimeReturn {
  const data: DealerRegimeResponse = {
    date: null,
    at: null,
    rows,
    asOf: '2026-05-04T18:00:00Z',
  };
  return { data, loading: false, error: null, refresh: vi.fn() };
}

describe('DealerRegimeTile', () => {
  it('renders the heading on initial mount', () => {
    mockHook.mockReturnValue({
      data: null,
      loading: true,
      error: null,
      refresh: vi.fn(),
    });
    render(<DealerRegimeTile marketOpen={false} />);
    expect(
      screen.getByRole('heading', { name: /dealer regime/i }),
    ).toBeInTheDocument();
  });

  it('shows loading message before data arrives', () => {
    mockHook.mockReturnValue({
      data: null,
      loading: true,
      error: null,
      refresh: vi.fn(),
    });
    render(<DealerRegimeTile marketOpen={true} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('renders an alert when fetch errors and no data exists', () => {
    mockHook.mockReturnValue({
      data: null,
      loading: false,
      error: 'Network blip',
      refresh: vi.fn(),
    });
    render(<DealerRegimeTile marketOpen={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/network blip/i);
  });

  it('renders all three ticker cells on the happy path', () => {
    mockHook.mockReturnValue(ret([row('SPX'), row('SPY'), row('QQQ')]));
    render(<DealerRegimeTile marketOpen={true} />);
    expect(screen.getByTestId('dealer-regime-cell-SPX')).toBeInTheDocument();
    expect(screen.getByTestId('dealer-regime-cell-SPY')).toBeInTheDocument();
    expect(screen.getByTestId('dealer-regime-cell-QQQ')).toBeInTheDocument();
    expect(
      screen.queryByTestId('dealer-regime-cell-NDX'),
    ).not.toBeInTheDocument();
  });

  it('classifies fresh rows with positive net γ + clear zero-gamma as long-γ', () => {
    mockHook.mockReturnValue(
      ret([
        row('SPX', {
          spot: 7240,
          zeroGamma: 7180, // 0.83% away — well outside boundary
          confidence: 0.4,
          netGammaAtSpot: 3_500_000_000,
        }),
      ]),
    );
    render(<DealerRegimeTile marketOpen={true} />);
    const cell = screen.getByTestId('dealer-regime-cell-SPX');
    expect(cell.textContent).toMatch(/long-γ/);
  });

  it('classifies negative net γ rows as short-γ', () => {
    mockHook.mockReturnValue(
      ret([row('SPX', { netGammaAtSpot: -2_500_000_000 })]),
    );
    render(<DealerRegimeTile marketOpen={true} />);
    const cell = screen.getByTestId('dealer-regime-cell-SPX');
    expect(cell.textContent).toMatch(/short-γ/);
  });

  it('classifies low-confidence rows as uncertain', () => {
    // Gate dropped to 0.05 in the audit-driven tuning — use 0.02 to be
    // unambiguously below.
    mockHook.mockReturnValue(ret([row('SPX', { confidence: 0.02 })]));
    render(<DealerRegimeTile marketOpen={true} />);
    const cell = screen.getByTestId('dealer-regime-cell-SPX');
    expect(cell.textContent).toMatch(/uncertain/);
  });

  it('classifies stale rows as uncertain even when other gates pass', () => {
    mockHook.mockReturnValue(ret([row('SPX', { ts: STALE_TS })]));
    render(<DealerRegimeTile marketOpen={true} />);
    const cell = screen.getByTestId('dealer-regime-cell-SPX');
    expect(cell.textContent).toMatch(/uncertain/);
  });

  it('classifies spot near zero-gamma as transition', () => {
    mockHook.mockReturnValue(
      ret([
        row('SPX', {
          spot: 7240,
          zeroGamma: 7239, // 0.014% — inside 0.3% boundary
        }),
      ]),
    );
    render(<DealerRegimeTile marketOpen={true} />);
    const cell = screen.getByTestId('dealer-regime-cell-SPX');
    expect(cell.textContent).toMatch(/transition/);
  });

  it('shows uncertain placeholder cells for tickers absent from the response', () => {
    // Only SPX returned; SPY/QQQ should still render with uncertain.
    mockHook.mockReturnValue(ret([row('SPX')]));
    render(<DealerRegimeTile marketOpen={true} />);
    const spy = screen.getByTestId('dealer-regime-cell-SPY');
    expect(spy.textContent).toMatch(/uncertain/);
    expect(spy.textContent).toMatch(/—/); // placeholder dash for missing values
  });

  it('formats net gamma as a signed abbreviation', () => {
    mockHook.mockReturnValue(
      ret([row('SPX', { netGammaAtSpot: 3_500_000_000 })]),
    );
    render(<DealerRegimeTile marketOpen={true} />);
    const cell = screen.getByTestId('dealer-regime-cell-SPX');
    expect(cell.textContent).toMatch(/\+3\.5B/);
  });

  // ── Phase 5b: backtest scrubber ────────────────────────────

  it('renders the minute scrubber slider', () => {
    mockHook.mockReturnValue(happyPathReturn());
    render(<DealerRegimeTile marketOpen={true} />);
    expect(screen.getByLabelText(/snapshot minute/i)).toBeInTheDocument();
  });

  it('passes a UTC ISO `at` timestamp to the hook when the scrubber moves', () => {
    mockHook.mockReturnValue(happyPathReturn());
    render(<DealerRegimeTile marketOpen={true} />);
    const slider = screen.getByLabelText(/snapshot minute/i);
    fireEvent.change(slider, { target: { value: '600' } }); // 10:00 CT
    const lastCall = mockHook.mock.calls.at(-1);
    // Hook signature: useDealerRegime(marketOpen, date, at). Third arg
    // should now be a UTC ISO string.
    const at = lastCall?.[2];
    expect(typeof at).toBe('string');
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
  });

  it('uses scrubbed timestamp as classifier `now` so a past row is not flagged stale', () => {
    // Row at FRESH_TS (5 min before TEST_NOW) — would normally pass the
    // staleness gate. But if the test scrubs to a date BEFORE TEST_NOW,
    // the classifier's now should anchor to that date, not wall-clock.
    // With selectedDate=today (default), no scrub → live mode → row
    // remains classified as long-γ (fresh). Verifies the "live" path.
    mockHook.mockReturnValue(happyPathReturn());
    render(<DealerRegimeTile marketOpen={true} />);
    const cell = screen.getByTestId('dealer-regime-cell-SPX');
    expect(cell.textContent).toMatch(/long-γ/);
  });
});

function happyPathReturn(): UseDealerRegimeReturn {
  return ret([row('SPX'), row('SPY'), row('QQQ')]);
}

// ============================================================
// ET MIDNIGHT WHILE THE APP IS OPEN
//
// The tile follows today unless the owner picked another date. It is
// memoized, so it skips App's midnight re-render: only the shared ET clock
// can move it. Every case starts 30 s before an ET midnight; the clock's
// timer is armed for 1 s past it, so 31 s lands just after. The real
// getETToday() reads the faked Date. Owner decision 2026-11-14.
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
])('DealerRegimeTile: across the $zone midnight', (m) => {
  beforeEach(() => {
    vi.setSystemTime(new Date(m.start));
    mockHook.mockReturnValue(happyPathReturn());
  });

  /** The shared clock's timer fires, just past midnight. */
  function crossMidnight() {
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
  }

  const dateInput = () =>
    screen.getByLabelText<HTMLInputElement>('Dealer Regime date');
  const todayButton = () => screen.queryByRole('button', { name: /^today$/i });
  /** The arguments of the tile's latest useDealerRegime call. */
  const lastCall = () => mockHook.mock.calls.at(-1);

  function pick(date: string) {
    fireEvent.change(dateInput(), { target: { value: date } });
  }

  it('follows the new date and stays on the live data path', () => {
    render(<DealerRegimeTile marketOpen={true} />);
    expect(dateInput().value).toBe(m.night);
    expect(lastCall()).toEqual([true, null, null]);

    crossMidnight();

    expect(dateInput().value).toBe(m.morning);
    expect(lastCall()).toEqual([true, null, null]);
    expect(todayButton()).not.toBeInTheDocument();
  });

  it('rolls with no parent re-render', () => {
    let parentRenders = 0;
    function Parent() {
      parentRenders += 1;
      return <DealerRegimeTile marketOpen={true} />;
    }
    render(<Parent />);
    const callsBefore = mockHook.mock.calls.length;

    crossMidnight();

    expect(parentRenders).toBe(1);
    expect(mockHook.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(dateInput().value).toBe(m.morning);
  });

  it('clears a scrubbed minute when the date rolls', () => {
    render(<DealerRegimeTile marketOpen={true} />);
    fireEvent.change(screen.getByLabelText(/snapshot minute/i), {
      target: { value: '600' },
    });
    expect(lastCall()?.[2]).not.toBeNull();

    crossMidnight();

    expect(lastCall()).toEqual([true, null, null]);
  });

  it('judges the date live in a render just past midnight, before the clock ticks', () => {
    const { rerender } = render(<DealerRegimeTile marketOpen={true} />);

    // The wall clock is past midnight; the shared clock has not ticked, so
    // the date is still the night's. A render now (the market-open prop
    // changes) must judge it live by the same clock, not by the wall clock.
    act(() => {
      vi.setSystemTime(new Date(Date.parse(m.start) + 30_500));
    });
    rerender(<DealerRegimeTile marketOpen={false} />);

    expect(dateInput().value).toBe(m.night);
    expect(lastCall()).toEqual([false, null, null]);
    expect(todayButton()).not.toBeInTheDocument();
  });

  it('keeps a picked past date', () => {
    render(<DealerRegimeTile marketOpen={true} />);
    pick('2026-04-20');
    expect(lastCall()).toEqual([false, '2026-04-20', null]);
    expect(todayButton()).toBeInTheDocument();

    crossMidnight();

    expect(dateInput().value).toBe('2026-04-20');
    expect(lastCall()).toEqual([false, '2026-04-20', null]);
    expect(todayButton()).toBeInTheDocument();
  });

  it('turns a picked tomorrow live when midnight reaches it', () => {
    render(<DealerRegimeTile marketOpen={true} />);
    pick(m.morning);
    expect(lastCall()).toEqual([false, m.morning, null]);
    expect(todayButton()).toBeInTheDocument();

    crossMidnight();

    expect(dateInput().value).toBe(m.morning);
    expect(lastCall()).toEqual([true, null, null]);
    expect(todayButton()).not.toBeInTheDocument();
  });

  it('TODAY goes back to following the date', () => {
    render(<DealerRegimeTile marketOpen={true} />);
    pick('2026-04-20');

    fireEvent.click(screen.getByRole('button', { name: /^today$/i }));

    expect(dateInput().value).toBe(m.night);
    expect(lastCall()).toEqual([true, null, null]);
    expect(todayButton()).not.toBeInTheDocument();

    // Following, not pinned to the night's string.
    crossMidnight();

    expect(dateInput().value).toBe(m.morning);
    expect(lastCall()).toEqual([true, null, null]);
    expect(todayButton()).not.toBeInTheDocument();
  });

  it('TODAY clicked just past midnight, before the clock ticks, follows the new day', () => {
    render(<DealerRegimeTile marketOpen={true} />);
    pick('2026-04-20');

    // The wall clock is past midnight; the shared clock has not ticked, so
    // its `today` is still the night's. TODAY must not pin that string.
    act(() => {
      vi.setSystemTime(new Date(Date.parse(m.start) + 30_500));
    });
    fireEvent.click(screen.getByRole('button', { name: /^today$/i }));
    crossMidnight();

    expect(dateInput().value).toBe(m.morning);
    expect(lastCall()).toEqual([true, null, null]);
    expect(todayButton()).not.toBeInTheDocument();
  });

  it('keeps the picked date while the field is empty, and follows today once it is left', () => {
    render(<DealerRegimeTile marketOpen={true} />);
    pick('2026-04-20');

    // Emptying the field (the first "0" of a zero-padded month does it) is
    // mid-edit: the data keeps the picked date.
    pick('');

    expect(dateInput().value).toBe('');
    expect(lastCall()).toEqual([false, '2026-04-20', null]);

    // Leaving it empty follows today.
    fireEvent.blur(dateInput());

    expect(dateInput().value).toBe(m.night);
    expect(lastCall()).toEqual([true, null, null]);

    crossMidnight();

    expect(dateInput().value).toBe(m.morning);
    expect(lastCall()).toEqual([true, null, null]);
  });
});

describe('DealerRegimeTile: typing a date', () => {
  it('takes a date typed key by key over the field', async () => {
    // Real timers: user-event's own waits never resolve under fake ones.
    vi.useRealTimers();
    const user = userEvent.setup();
    mockHook.mockReturnValue(happyPathReturn());
    render(<DealerRegimeTile marketOpen={true} />);
    const input = screen.getByLabelText<HTMLInputElement>('Dealer Regime date');

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
