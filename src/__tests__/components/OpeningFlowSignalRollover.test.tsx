import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The hook is mocked so the test can read, call by call, the date the panel
// hands it. The panel's own state is what these tests exercise.
const mockUseOpeningFlowSignal = vi.fn();
vi.mock('../../hooks/useOpeningFlowSignal', () => ({
  useOpeningFlowSignal: (date?: string) => mockUseOpeningFlowSignal(date),
}));

import { OpeningFlowSignal } from '../../components/OpeningFlowSignal';

beforeEach(() => {
  mockUseOpeningFlowSignal.mockReset();
  mockUseOpeningFlowSignal.mockImplementation((date?: string) => ({
    data: null,
    loading: false,
    error: null,
    isWindowOpen: false,
    displayData: null,
    isHistorical: date != null && date !== '',
    refresh: vi.fn(),
  }));
});

/** The dates the panel handed the hook, one per render, in order. */
function datesHanded(): unknown[] {
  return mockUseOpeningFlowSignal.mock.calls.map((c) => c[0]);
}

const dateInput = () => screen.getByLabelText<HTMLInputElement>(/^Date$/i);

/** The mode label beside the picker (the Live button has the same text). */
const liveLabel = () => screen.getByText('Live', { selector: 'span' });

function pick(date: string) {
  fireEvent.change(dateInput(), { target: { value: date } });
}

// ============================================================
// Midnight rollover (docs/superpowers/specs/panel-date-rollover-2026-11-14.md,
// design item 4)
//
// `''` is the panel's live sentinel and the data follows the day on its own:
// live mode asks the server for its own date. What the panel owns is `max`,
// the latest day the picker takes. It was read from the wall clock on each
// render, so an open tab only moved it when something else re-rendered the
// panel. It comes from the shared ET clock now, and the clock re-renders only
// this panel at the roll. The live field is empty by design, so there is no
// display date to roll. A pick is judged against the clock at the moment of
// the pick: a pick of today goes live (`''`), anything else is passed on.
// Every case starts 30 s before an ET midnight; the clock's timer is armed
// for 1 s past it, so 31 s lands just after. The real getETToday() reads the
// faked Date. Owner decision 2026-11-14.
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
])('OpeningFlowSignal: across the $zone midnight', (m) => {
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

  /** The wall clock passes midnight; the shared clock has not ticked yet. */
  function wallClockPastMidnight() {
    act(() => {
      vi.setSystemTime(new Date(Date.parse(m.start) + 30_500));
    });
  }

  it('clamps max to today and moves it to the new day, with the field staying live', () => {
    render(<OpeningFlowSignal />);
    expect(dateInput().max).toBe(m.night);
    expect(dateInput().value).toBe('');

    crossMidnight();

    expect(dateInput().max).toBe(m.morning);
    expect(dateInput().value).toBe('');
    expect(liveLabel()).toBeInTheDocument();
    expect(new Set(datesHanded())).toEqual(new Set(['']));
  });

  it('rolls with no parent re-render', () => {
    let parentRenders = 0;
    function Parent() {
      parentRenders += 1;
      return <OpeningFlowSignal />;
    }
    render(<Parent />);
    const callsBefore = mockUseOpeningFlowSignal.mock.calls.length;

    crossMidnight();

    expect(parentRenders).toBe(1);
    expect(mockUseOpeningFlowSignal.mock.calls.length).toBeGreaterThan(
      callsBefore,
    );
    expect(dateInput().max).toBe(m.morning);
  });

  it('keeps the night in a render just past midnight, before the clock ticks', () => {
    render(<OpeningFlowSignal />);

    // The wall clock is past midnight; the shared clock has not ticked. A
    // render now (a pick) reads the same clock the rest of the app does, not
    // the wall clock.
    wallClockPastMidnight();
    pick('2026-04-20');

    expect(dateInput().max).toBe(m.night);
  });

  it('keeps a picked past date across the roll, and moves max', () => {
    render(<OpeningFlowSignal />);
    pick('2026-04-20');
    expect(screen.getByText('Historical · 2026-04-20')).toBeInTheDocument();

    crossMidnight();

    expect(dateInput().value).toBe('2026-04-20');
    expect(dateInput().max).toBe(m.morning);
    expect(screen.getByText('Historical · 2026-04-20')).toBeInTheDocument();
    expect(new Set(datesHanded())).toEqual(new Set(['', '2026-04-20']));
    expect(datesHanded().at(-1)).toBe('2026-04-20');
  });

  it('hands a picked past date to the hook, and the Live button takes it back', () => {
    render(<OpeningFlowSignal />);

    pick('2026-04-20');
    expect(datesHanded().at(-1)).toBe('2026-04-20');
    expect(dateInput().value).toBe('2026-04-20');

    fireEvent.click(screen.getByRole('button', { name: /live/i }));

    expect(datesHanded().at(-1)).toBe('');
    expect(dateInput().value).toBe('');
  });

  it('turns a pick of today into live, not a request for today', () => {
    render(<OpeningFlowSignal />);
    pick('2026-04-20');

    pick(m.night);

    // `?date=today` would put the hook in historical mode: one read, no
    // polling.
    expect(datesHanded().at(-1)).toBe('');
    expect(dateInput().value).toBe('');
    expect(liveLabel()).toBeInTheDocument();
  });

  it('turns a pick of the new today into live in a render before the clock ticks', () => {
    render(<OpeningFlowSignal />);
    pick('2026-04-20');

    // The wall clock is past midnight; the shared clock's `today` is still
    // the night's. The pick is compared with the clock at the moment of the
    // pick, so it still means live.
    wallClockPastMidnight();
    pick(m.morning);

    expect(datesHanded().at(-1)).toBe('');
    expect(liveLabel()).toBeInTheDocument();
  });

  it('keeps the night a past date when it is picked just past midnight, before the clock ticks', () => {
    render(<OpeningFlowSignal />);

    // By the wall clock the night is yesterday. Judged against the render's
    // stale `today` it would pass for live.
    wallClockPastMidnight();
    pick(m.night);

    expect(datesHanded().at(-1)).toBe(m.night);
    expect(dateInput().value).toBe(m.night);
  });

  it('keeps the night a past date when it is picked after the roll', () => {
    render(<OpeningFlowSignal />);
    crossMidnight();

    pick(m.night);

    expect(datesHanded().at(-1)).toBe(m.night);
    expect(screen.getByText(`Historical · ${m.night}`)).toBeInTheDocument();
  });

  it('passes a future date on and keeps it in the field', () => {
    render(<OpeningFlowSignal />);

    pick(m.morning);

    // `max` is a hint the browser does not enforce on typing. A typed future
    // date is the owner's pick, and a partial date on the way to a past one
    // (below) is often a future one.
    expect(datesHanded().at(-1)).toBe(m.morning);
    expect(dateInput().value).toBe(m.morning);
  });

  it('keeps every step of a month-later past date typed over the field', () => {
    // Chrome forwards a complete date after each segment and keeps the old
    // year: 12152025 over today goes 2026-01-.., 2026-12-.. (a future date),
    // 2026-12-01, 2026-12-15, then the year lands. Refusing the future step
    // snapped the field back and lost the month.
    render(<OpeningFlowSignal />);

    for (const step of [
      '2026-01-16',
      '2026-12-16',
      '2026-12-01',
      '2026-12-15',
      '2025-12-15',
    ]) {
      pick(step);
      expect(datesHanded().at(-1)).toBe(step);
      expect(dateInput().value).toBe(step);
    }
  });

  it('returns to live when the field is left empty, not when it empties', () => {
    render(<OpeningFlowSignal />);
    pick('2026-04-20');

    // Emptying the field (the first "0" of a zero-padded month does it) is
    // mid-edit.
    pick('');
    expect(datesHanded().at(-1)).toBe('2026-04-20');
    expect(dateInput().value).toBe('');

    fireEvent.blur(dateInput());

    expect(datesHanded().at(-1)).toBe('');
    expect(liveLabel()).toBeInTheDocument();
  });
});

describe('OpeningFlowSignal: typing a date', () => {
  it('takes a date typed key by key over the field', async () => {
    const user = userEvent.setup();
    render(<OpeningFlowSignal />);
    pick('2026-04-20');
    const before = datesHanded().length;

    // Emptying the field first must not go live and lose the typing: the
    // shared DateInput keeps an emptied field as a local draft.
    await user.clear(dateInput());
    await user.type(dateInput(), '2026-04-21');

    // The draft stays in the field, so the panel renders once more: with the
    // typed date. It never went live in between.
    expect(datesHanded().slice(before)).toEqual(['2026-04-21']);
    expect(dateInput().value).toBe('2026-04-21');
  });
});
