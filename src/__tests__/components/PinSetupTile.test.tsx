import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockUsePinSetupStatus = vi.fn();
vi.mock('../../hooks/usePinSetupStatus', () => ({
  usePinSetupStatus: () => mockUsePinSetupStatus(),
}));

import PinSetupTile from '../../components/PinSetupTile';
import type { PinSetupStatus } from '../../hooks/usePinSetupStatus';

const SETDATE = vi.fn();
const REFRESH = vi.fn();

function makeStatus(overrides: Partial<PinSetupStatus> = {}): PinSetupStatus {
  return {
    evaluatedAt: '2026-05-14T20:30:00.000Z',
    date: null,
    mode: 'live',
    snapshotTs: '2026-05-14T20:29:00.000Z',
    staleMinutes: 1,
    state: 'ARMED',
    conditions: {
      netGammaAtMagnetM: 41751,
      netGammaThresholdM: 20000,
      netGammaMet: true,
      magnetStrike: 7500,
      isRound50: true,
      distanceToMagnet: -0.9,
      distanceThreshold: 15,
      distanceMet: true,
    },
    spot: 7499.1,
    bias: 'full-pin',
    recommendedTradeTypes: [
      'iron_condor',
      'iron_butterfly',
      'broken_wing_butterfly',
    ],
    avoidedTradeTypes: ['directional_long_call'],
    trajectory: [
      { ts: '13:31', gammaDirM: 1000, spot: 7460 },
      { ts: '14:00', gammaDirM: 5000, spot: 7480 },
      { ts: '14:30', gammaDirM: 9000, spot: 7500 },
    ],
    outcome: null,
    asOf: '2026-05-14T20:30:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  SETDATE.mockReset();
  REFRESH.mockReset();
  mockUsePinSetupStatus.mockReset();
});

function mockHook(
  data: PinSetupStatus | null,
  overrides: Partial<{
    loading: boolean;
    error: string | null;
    date: string | null;
  }> = {},
) {
  mockUsePinSetupStatus.mockReturnValue({
    data,
    loading: overrides.loading ?? false,
    error: overrides.error ?? null,
    date: overrides.date ?? null,
    setDate: SETDATE,
    refresh: REFRESH,
  });
}

describe('PinSetupTile', () => {
  // ── Loading / error ────────────────────────────────────────

  it('shows loading state when no data and loading=true', () => {
    mockHook(null, { loading: true });
    render(<PinSetupTile marketOpen={false} />);
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it('shows error message when fetch fails and no data', () => {
    mockHook(null, { error: 'HTTP 500' });
    render(<PinSetupTile marketOpen={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500');
  });

  // ── ARMED full-pin (today's example) ────────────────────────

  it('renders ARMED state with magnet, γ, spot, distance, bias', () => {
    mockHook(makeStatus());
    render(<PinSetupTile marketOpen={true} />);
    expect(screen.getByTestId('pin-setup-state-badge')).toHaveTextContent(
      'ARMED',
    );
    expect(screen.getByText('7500')).toBeInTheDocument();
    const detail = screen.getByTestId('pin-setup-detail');
    expect(detail).toHaveTextContent('41.8B γ');
    expect(detail).toHaveTextContent('spot 7499.1');
    expect(detail).toHaveTextContent('-0.9 from magnet');
    expect(screen.getByText('FULL PIN')).toBeInTheDocument();
    expect(screen.getByText(/Iron condors and BWBs/)).toBeInTheDocument();
  });

  it('shows recommended trade-type chips (max 3)', () => {
    mockHook(makeStatus());
    render(<PinSetupTile marketOpen={true} />);
    expect(screen.getByText(/iron condor/)).toBeInTheDocument();
    expect(screen.getByText(/iron butterfly/)).toBeInTheDocument();
    expect(screen.getByText(/broken wing butterfly/)).toBeInTheDocument();
  });

  // ── WATCH ──────────────────────────────────────────────────

  it('renders WATCH state with caution color and fade bias', () => {
    mockHook(
      makeStatus({
        state: 'WATCH',
        bias: 'fade-rips',
        conditions: {
          netGammaAtMagnetM: 25000,
          netGammaThresholdM: 20000,
          netGammaMet: true,
          magnetStrike: 7415,
          isRound50: false,
          distanceToMagnet: 4,
          distanceThreshold: 15,
          distanceMet: true,
        },
        spot: 7419,
      }),
    );
    render(<PinSetupTile marketOpen={true} />);
    expect(screen.getByTestId('pin-setup-state-badge')).toHaveTextContent(
      'WATCH',
    );
    expect(screen.getByText('FADE RIPS')).toBeInTheDocument();
    expect(screen.getByText('7415')).toBeInTheDocument();
  });

  // ── NOT_TRIGGERED ──────────────────────────────────────────

  it('renders NOT_TRIGGERED with no-signal explanation', () => {
    mockHook(
      makeStatus({
        state: 'NOT_TRIGGERED',
        bias: 'no-signal',
        conditions: {
          netGammaAtMagnetM: 0,
          netGammaThresholdM: 20000,
          netGammaMet: false,
          magnetStrike: null,
          isRound50: false,
          distanceToMagnet: null,
          distanceThreshold: 15,
          distanceMet: false,
        },
        recommendedTradeTypes: [
          'directional_long_call',
          'directional_long_put',
        ],
      }),
    );
    render(<PinSetupTile marketOpen={true} />);
    expect(screen.getByTestId('pin-setup-state-badge')).toHaveTextContent(
      'NOT TRIGGERED',
    );
    expect(screen.getByText('NO SIGNAL')).toBeInTheDocument();
    expect(screen.getByText(/No structural wall today/)).toBeInTheDocument();
  });

  // ── Stale indicator ────────────────────────────────────────

  it('shows STALE badge when staleMinutes > 30 during market', () => {
    mockHook(makeStatus({ staleMinutes: 45 }));
    render(<PinSetupTile marketOpen={true} />);
    expect(screen.getByText(/stale 45m/i)).toBeInTheDocument();
  });

  it('does NOT show STALE badge when market is closed', () => {
    mockHook(makeStatus({ staleMinutes: 999 }));
    render(<PinSetupTile marketOpen={false} />);
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument();
  });

  it('flags the last good status when the latest fetch failed', () => {
    // A failed or malformed poll keeps the last good status (the hook's
    // contract); without a flag the tile looks live while frozen.
    mockHook(makeStatus({ staleMinutes: 1 }), {
      error: 'invalid response shape',
    });
    render(<PinSetupTile marketOpen={true} />);

    const flag = screen.getByText(/update failed/i);
    expect(flag).toHaveAttribute('title', 'invalid response shape');
    // The last good status still renders, and the no-data alert doesn't.
    expect(screen.getByText('7500')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows no update-failed flag when the latest fetch succeeded', () => {
    mockHook(makeStatus());
    render(<PinSetupTile marketOpen={true} />);
    expect(screen.queryByText(/update failed/i)).not.toBeInTheDocument();
  });

  it('does NOT show STALE badge in historical mode even with market open', () => {
    mockHook(
      makeStatus({
        mode: 'historical',
        date: '2026-05-14',
        staleMinutes: 9999,
        outcome: { settle: 7499.1, settleVsMagnet: -0.9 },
      }),
      { date: '2026-05-14' },
    );
    render(<PinSetupTile marketOpen={true} />);
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument();
  });

  // ── Historical mode ────────────────────────────────────────

  it('renders outcome row in historical mode', () => {
    mockHook(
      makeStatus({
        mode: 'historical',
        date: '2026-05-14',
        outcome: { settle: 7499.1, settleVsMagnet: -0.9 },
      }),
      { date: '2026-05-14' },
    );
    render(<PinSetupTile marketOpen={false} />);
    expect(screen.getByText(/settled/i)).toBeInTheDocument();
    expect(screen.getByText('7499.10')).toBeInTheDocument();
    expect(screen.getByText(/-0.90 from magnet/)).toBeInTheDocument();
  });

  it('shows Live button only when a historical date is set', () => {
    mockHook(makeStatus(), { date: null });
    const { rerender } = render(<PinSetupTile marketOpen={true} />);
    expect(screen.queryByRole('button', { name: /^Live$/i })).toBeNull();

    mockHook(makeStatus({ date: '2026-05-14', mode: 'historical' }), {
      date: '2026-05-14',
    });
    rerender(<PinSetupTile marketOpen={false} />);
    expect(screen.getByRole('button', { name: /^Live$/i })).toBeInTheDocument();
  });

  // ── Date picker interactions ───────────────────────────────

  it('invokes setDate when the user picks a past date', () => {
    mockHook(makeStatus());
    render(<PinSetupTile marketOpen={false} />);
    const input = screen.getByLabelText(/^Date$/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2026-05-14' } });
    expect(SETDATE).toHaveBeenCalledWith('2026-05-14');
  });

  it('defaults the picker to today (ET) and clamps max=today', () => {
    // Today (ET) is computed inside the component; we don't fix the
    // clock, we just assert that the picker is non-empty and that
    // max === the rendered value (i.e. today).
    mockHook(makeStatus(), { date: null });
    render(<PinSetupTile marketOpen={true} />);
    const input = screen.getByLabelText(/^Date$/i) as HTMLInputElement;
    expect(input.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(input.max).toBe(input.value);
    // …and the Live button is NOT visible because we're still in live
    // mode (hook date is null even though the picker shows today).
    expect(screen.queryByRole('button', { name: /^Live$/i })).toBeNull();
  });

  it('returns to live mode (setDate(null)) when the user re-picks today from a historical view', () => {
    // Start in a historical view so the picker is showing a past
    // date — then change it back to today. The component should call
    // setDate(null) so the server treats it as live, not historical.
    mockHook(makeStatus({ mode: 'historical', date: '2026-05-14' }), {
      date: '2026-05-14',
    });
    render(<PinSetupTile marketOpen={true} />);
    const input = screen.getByLabelText(/^Date$/i) as HTMLInputElement;
    // The component computes today from getETDateStr(new Date()); we
    // pluck it from a freshly-rendered live picker via a sibling
    // render. Cleaner alternative: render a second instance with
    // date=null and read its value.
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });
    fireEvent.change(input, { target: { value: today } });
    expect(SETDATE).toHaveBeenCalledWith(null);
  });

  it('invokes setDate(null) when Live button is clicked', async () => {
    mockHook(makeStatus({ date: '2026-05-14', mode: 'historical' }), {
      date: '2026-05-14',
    });
    render(<PinSetupTile marketOpen={false} />);
    await userEvent.click(screen.getByRole('button', { name: /^Live$/i }));
    expect(SETDATE).toHaveBeenCalledWith(null);
  });

  it('invokes refresh when refresh button is clicked', async () => {
    mockHook(makeStatus());
    render(<PinSetupTile marketOpen={true} />);
    await userEvent.click(
      screen.getByRole('button', { name: /Refresh pin setup data/i }),
    );
    expect(REFRESH).toHaveBeenCalled();
  });
});

// ============================================================
// ET MIDNIGHT WHILE THE APP IS OPEN
//
// The hook's `date` keeps its sentinel: null is live, and the data follows
// the day on its own. What the panel owns is the display: the picker shows
// `date ?? today` and clamps `max` to today. Both used to be latched at
// mount, so an open tab showed yesterday and `max` blocked the new day. They
// come from the shared ET clock now, and the panel is memoized, so only that
// clock re-renders it at the roll. Every case starts 30 s before an ET
// midnight; the clock's timer is armed for 1 s past it, so 31 s lands just
// after. The real getETToday() reads the faked Date. Owner decision
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
])('PinSetupTile: across the $zone midnight', (m) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(m.start));
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

  const dateInput = () => screen.getByLabelText<HTMLInputElement>(/^Date$/i);

  function pick(date: string) {
    fireEvent.change(dateInput(), { target: { value: date } });
  }

  it('shows today in the picker and clamps max to it, and both move to the new day', () => {
    mockHook(makeStatus(), { date: null });
    render(<PinSetupTile marketOpen={true} />);
    expect(dateInput().value).toBe(m.night);
    expect(dateInput().max).toBe(m.night);

    crossMidnight();

    expect(dateInput().value).toBe(m.morning);
    expect(dateInput().max).toBe(m.morning);
    expect(SETDATE).not.toHaveBeenCalled();
  });

  it('rolls with no parent re-render', () => {
    mockHook(makeStatus(), { date: null });
    let parentRenders = 0;
    function Parent() {
      parentRenders += 1;
      return <PinSetupTile marketOpen={true} />;
    }
    render(<Parent />);
    const callsBefore = mockUsePinSetupStatus.mock.calls.length;

    crossMidnight();

    expect(parentRenders).toBe(1);
    expect(mockUsePinSetupStatus.mock.calls.length).toBeGreaterThan(
      callsBefore,
    );
    expect(dateInput().value).toBe(m.morning);
  });

  it('shows the night in a render just past midnight, before the clock ticks', () => {
    mockHook(makeStatus(), { date: null });
    const { rerender } = render(<PinSetupTile marketOpen={true} />);

    // The wall clock is past midnight; the shared clock has not ticked. A
    // render now (the market-open prop changes) reads the same clock the
    // rest of the app does, not the wall clock.
    act(() => {
      vi.setSystemTime(new Date(Date.parse(m.start) + 30_500));
    });
    rerender(<PinSetupTile marketOpen={false} />);

    expect(dateInput().value).toBe(m.night);
    expect(dateInput().max).toBe(m.night);
  });

  it('keeps a picked past date in the picker across the roll, and moves max', () => {
    mockHook(makeStatus({ date: '2026-04-20', mode: 'historical' }), {
      date: '2026-04-20',
    });
    render(<PinSetupTile marketOpen={true} />);
    expect(dateInput().value).toBe('2026-04-20');

    crossMidnight();

    expect(dateInput().value).toBe('2026-04-20');
    expect(dateInput().max).toBe(m.morning);
    expect(SETDATE).not.toHaveBeenCalled();
  });

  it('hands a picked past date to the hook', () => {
    mockHook(makeStatus(), { date: null });
    render(<PinSetupTile marketOpen={true} />);

    pick('2026-04-20');

    expect(SETDATE.mock.calls).toEqual([['2026-04-20']]);
  });

  // A hook that keeps its date, as the real one does (the other tests hand the
  // panel a fixed date).
  function useStatefulHook() {
    const [date, setDate] = useState<string | null>(null);
    return {
      data: makeStatus(),
      loading: false,
      error: null,
      date,
      setDate: (d: string | null) => {
        SETDATE(d);
        setDate(d);
      },
      refresh: REFRESH,
    };
  }

  it('passes a future date on and keeps it in the field', () => {
    mockUsePinSetupStatus.mockImplementation(useStatefulHook);
    render(<PinSetupTile marketOpen={true} />);

    pick(m.morning);

    // `max` is a hint the browser does not enforce on typing. A typed future
    // date is the owner's pick, and a partial date on the way to a past one
    // (below) is often a future one.
    expect(SETDATE.mock.calls).toEqual([[m.morning]]);
    expect(dateInput().value).toBe(m.morning);
  });

  it('keeps every step of a month-later past date typed over the field', () => {
    // Chrome forwards a complete date after each segment and keeps the old
    // year: 12152025 over today goes 2026-01-.., 2026-12-.. (a future date),
    // 2026-12-01, 2026-12-15, then the year lands. Refusing the future step
    // snapped the field back and lost the month.
    mockUsePinSetupStatus.mockImplementation(useStatefulHook);
    render(<PinSetupTile marketOpen={true} />);

    for (const step of [
      '2026-01-16',
      '2026-12-16',
      '2026-12-01',
      '2026-12-15',
      '2025-12-15',
    ]) {
      pick(step);
      expect(SETDATE.mock.calls.at(-1)).toEqual([step]);
      expect(dateInput().value).toBe(step);
    }
  });

  it('goes live when the new today is picked just past midnight, before the clock ticks', () => {
    mockHook(makeStatus({ date: '2026-04-20', mode: 'historical' }), {
      date: '2026-04-20',
    });
    render(<PinSetupTile marketOpen={true} />);

    // The wall clock is past midnight; the shared clock has not ticked, so
    // its `today` is still the night's. The pick is compared with the clock
    // at the moment of the pick, so it still means live, not a historical
    // request for today.
    act(() => {
      vi.setSystemTime(new Date(Date.parse(m.start) + 30_500));
    });
    pick(m.morning);

    expect(SETDATE.mock.calls).toEqual([[null]]);
  });

  it('returns to live when the field is left empty, not when it empties', () => {
    mockHook(makeStatus({ date: '2026-04-20', mode: 'historical' }), {
      date: '2026-04-20',
    });
    render(<PinSetupTile marketOpen={true} />);

    // Emptying the field (the first "0" of a zero-padded month does it) is
    // mid-edit.
    pick('');
    expect(SETDATE).not.toHaveBeenCalled();
    expect(dateInput().value).toBe('');

    fireEvent.blur(dateInput());

    expect(SETDATE.mock.calls).toEqual([[null]]);
  });
});

describe('PinSetupTile: typing a date', () => {
  it('takes a date typed key by key over the field', async () => {
    mockHook(makeStatus(), { date: null });
    const user = userEvent.setup();
    render(<PinSetupTile marketOpen={true} />);
    const input = screen.getByLabelText<HTMLInputElement>(/^Date$/i);

    // Emptying the field first must not go live and lose the typing: the
    // shared DateInput keeps an emptied field as a local draft.
    await user.clear(input);
    await user.type(input, '2026-04-21');

    expect(SETDATE.mock.calls).toEqual([['2026-04-21']]);
  });
});
