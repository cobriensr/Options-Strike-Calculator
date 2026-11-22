import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';

// The clock is the real one, pinned: the hook reads the CT window and the ET
// date from `Date`, and the day-boundary cases below move that clock while the
// hook is mounted. Only the access mode is mocked.
vi.mock('../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner'),
}));

import { getAccessMode } from '../utils/auth';
import { useRegime0dte } from '../hooks/useRegime0dte';
import type { Regime0dteResponse } from '../hooks/useRegime0dte';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

const STORAGE_KEY = 'regime0dte:lastgood';

/** CT is UTC-5 from 2026-03-08 to 2026-11-01 (CDT) and UTC-6 outside it. */
function ctOffsetHours(date: string): number {
  return date >= '2026-03-08' && date < '2026-11-01' ? 5 : 6;
}

/** The instant a CT wall clock reads `hh:mm:ss` on the CT calendar `date`. */
function ctInstant(date: string, hh: number, mm: number, ss = 0): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, hh + ctOffsetHours(date), mm, ss));
}

/** Pin the (Date-only) fake clock to a CT wall clock. */
function setCt(date: string, hour: number, minute: number, second = 0) {
  vi.setSystemTime(ctInstant(date, hour, minute, second));
}

function makeResponse(
  overrides: Partial<Regime0dteResponse> = {},
): Regime0dteResponse {
  return {
    date: '2026-06-05',
    asOfCtMin: 600,
    gate: 'calm',
    gexNearSpot: 1.2e10,
    gexAtOpen: 1.0e10,
    flipStrike: 5900,
    flipMinusOpenPct: -0.4,
    triggers: {
      mostlyRed: { fired: false, atCtMin: null, green: 3, red: 2 },
      ivBreak: { fired: false, atCtMin: null, magPct: null, refHi: 0.3 },
      middayDeepNeg: { fired: false, atCtMin: null, gexMid: null },
    },
    note: 'positive gamma — mean-revert / tight range likely',
    ...overrides,
  };
}

/** Seed a last-good cache entry under STORAGE_KEY with the given payload date. */
function seedCache(date: string, overrides: Partial<Regime0dteResponse> = {}) {
  const cached = makeResponse({ date, ...overrides });
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      data: cached,
      savedAt: `${date}T20:00:00Z`,
      date,
    }),
  );
  return cached;
}

describe('useRegime0dte', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // Only Date is faked, so waitFor and the real timers keep running.
    vi.useFakeTimers({ toFake: ['Date'] });
    // Default: inside the 08:30–15:00 CT session, "today" is 2026-06-05.
    setCt('2026-06-05', 10, 0);
    vi.mocked(getAccessMode).mockReturnValue('owner');
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // /api/regime-0dte is owner-or-guest: a public visitor's fetch is a 401 that
  // the panel would show as a red alert, so the hook never asks.
  it('does not fetch, poll or open the window for a public visitor inside the CT session', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    vi.useFakeTimers({ now: ctInstant('2026-06-05', 10, 0) });
    const { result } = renderHook(() => useRegime0dte());
    // The eager fetch, then several 45s poll periods and window-watcher ticks.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000 * 5);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.isWindowOpen).toBe(false);
    expect(result.current.displayData).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('fetches inside the window for a guest, as for an owner', async () => {
    vi.mocked(getAccessMode).mockReturnValue('guest');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeResponse({ gate: 'big_move' }),
    });

    const { result } = renderHook(() => useRegime0dte());

    await waitFor(() => {
      expect(result.current.displayData?.gate).toBe('big_move');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('populates displayData.gate after a successful fetch inside the window', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeResponse({ gate: 'lean_down' }),
    });

    const { result } = renderHook(() => useRegime0dte());

    await waitFor(() => {
      expect(result.current.displayData?.gate).toBe('lean_down');
    });
    expect(result.current.isWindowOpen).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/regime-0dte',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('surfaces an error, and shows nothing, when the server answers with another day’s payload', async () => {
    // The clock is 2026-06-05 10:00 CT and the server stamps 2026-06-04: a
    // payload the date check hides. Silence would leave the panel on "loading".
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeResponse({ date: '2026-06-04' }),
    });

    const { result } = renderHook(() => useRegime0dte());

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.error).toBe(
      'Payload is dated 2026-06-04, but today is 2026-06-05',
    );
    expect(result.current.displayData).toBeNull();
    expect(result.current.isWindowOpen).toBe(true);
  });

  it('makes exactly one fetch for a mount inside the window, then polls at its cadence', async () => {
    vi.useFakeTimers({ now: ctInstant('2026-06-05', 10, 0) });
    fetchMock.mockResolvedValue({ ok: true, json: async () => makeResponse() });

    renderHook(() => useRegime0dte());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not fetch and reports isWindowOpen=false outside the CT session', async () => {
    // 16:00 CT — after the 15:00 close.
    setCt('2026-06-05', 16, 0);

    const { result } = renderHook(() => useRegime0dte());

    // Give any (incorrect) eager fetch a chance to fire.
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isWindowOpen).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.displayData).toBeNull();
  });

  it('does not schedule the polling interval outside the CT window (no fetch churn)', () => {
    // 16:00 CT — closed. With fake timers we can prove no interval ticks
    // fire a fetch even after several poll periods elapse.
    vi.useFakeTimers({ now: ctInstant('2026-06-05', 16, 0) });

    renderHook(() => useRegime0dte());

    // Advance well past the 45s poll cadence (and the 60s window watcher).
    act(() => {
      vi.advanceTimersByTime(45_000 * 5);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('restores the today-dated last-good payload from localStorage on mount', () => {
    // Outside the window so no fetch overwrites the cache. Cache date matches
    // "today" (2026-06-05) so it is surfaced as displayData.
    setCt('2026-06-05', 16, 0);
    seedCache('2026-06-05', { gate: 'big_move' });

    const { result } = renderHook(() => useRegime0dte());

    expect(result.current.displayData?.gate).toBe('big_move');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT surface a prior-session-day cache as displayData (staleness guard)', () => {
    // Closed window, but a cache from YESTERDAY (2026-06-04) is present while
    // "today" is 2026-06-05. The stale-date cache must be ignored for display
    // — it must NOT paint yesterday's payload as live.
    setCt('2026-06-05', 16, 0);
    seedCache('2026-06-04', { gate: 'big_move' });

    const { result } = renderHook(() => useRegime0dte());

    expect(result.current.displayData).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // The stale entry is evicted from storage on read.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('mirrors a fresh payload into the last-good cache', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeResponse({ gate: 'lean_down' }),
    });

    renderHook(() => useRegime0dte());

    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as {
      data: Regime0dteResponse;
      date: string;
    };
    expect(parsed.data.gate).toBe('lean_down');
    expect(parsed.date).toBe('2026-06-05');
  });

  it('keeps a today-dated last-good payload on a fetch error', async () => {
    seedCache('2026-06-05', { gate: 'calm' });
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const { result } = renderHook(() => useRegime0dte());

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    // Last-good (today-dated) survives the transient error.
    expect(result.current.displayData?.gate).toBe('calm');
  });
});

describe('useRegime0dte polling window follows the market calendar', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.mocked(getAccessMode).mockReturnValue('owner');
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Dates (marketHours.ts stays real): Saturday, Thanksgiving (full close).
  it.each([
    ['a Saturday', '2026-11-14'],
    ['Thanksgiving (full-day close)', '2026-11-26'],
  ])('does not fetch at 10:00 CT on %s', async (_label, date) => {
    setCt(date, 10, 0);

    const { result } = renderHook(() => useRegime0dte());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isWindowOpen).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not schedule the polling interval on a Saturday (no fetch churn)', () => {
    vi.useFakeTimers({ now: ctInstant('2026-11-14', 10, 0) });

    renderHook(() => useRegime0dte());
    act(() => {
      vi.advanceTimersByTime(45_000 * 5);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // 2026-11-27 closes at 13:00 ET, which is 12:00 CT.
  it.each([
    ['11:59 CT is open', 11, 59, true],
    ['12:00 CT is closed', 12, 0, false],
    ['14:00 CT is closed', 14, 0, false],
  ])('half-day 2026-11-27: %s', async (_label, hour, minute, expectOpen) => {
    setCt('2026-11-27', hour, minute);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeResponse({ date: '2026-11-27' }),
    });

    const { result } = renderHook(() => useRegime0dte());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isWindowOpen).toBe(expectOpen);
    if (expectOpen) {
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
    } else {
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  // 2026-06-05 is a normal Friday: the session runs 08:30 to 15:00 CT.
  it.each([
    ['08:29 CT is closed', 8, 29, false],
    ['08:30 CT is open', 8, 30, true],
    ['14:59 CT is open', 14, 59, true],
    ['15:00 CT is closed', 15, 0, false],
  ])(
    'normal weekday 2026-06-05: %s',
    async (_label, hour, minute, expectOpen) => {
      setCt('2026-06-05', hour, minute);
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => makeResponse(),
      });

      const { result } = renderHook(() => useRegime0dte());
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.isWindowOpen).toBe(expectOpen);
      if (expectOpen) {
        await waitFor(() => {
          expect(fetchMock).toHaveBeenCalled();
        });
      } else {
        expect(fetchMock).not.toHaveBeenCalled();
      }
    },
  );
});

// ============================================================
// Days crossed while mounted (docs/superpowers/specs/
// panel-date-rollover-2026-11-14.md, Phase 10)
//
// A tab opened before Friday's close and left there. Friday's payload sat in the
// hook's state, which only the cache path date-checked, so it painted as live at
// Monday's open; the only fetch was the mount fetch, so the first Monday read was
// a 45 s poll after the 08:30 CT open (the watcher notices the open on its
// 60 s tick, so 45 to 105 s); and a failed first fetch left Friday's payload up
// for good. Nothing re-rendered the panel at midnight either. These tests mount
// once and move the clock, one `act` per step: a single act around a weekend
// batches the close and the open into one commit and the flag never flips. The
// recorder logs the payload date shown by every COMMITTED render.
// ============================================================

describe('useRegime0dte across days while mounted', () => {
  /** Dates the server stamps (CT) per scenario. */
  let serverDate: string;

  beforeEach(() => {
    fetchMock.mockReset();
    localStorage.clear();
    vi.mocked(getAccessMode).mockReturnValue('owner');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderRecorded() {
    // `at` is the fake clock when the render committed, so a test can ask for
    // every commit at or after an instant, the roll's own included.
    const committed: { open: boolean; date: string | null; at: number }[] = [];
    const hook = renderHook(() => {
      const r = useRegime0dte();
      useEffect(() => {
        committed.push({
          open: r.isWindowOpen,
          date: r.displayData?.date ?? null,
          at: Date.now(),
        });
      });
      return r;
    });
    return { ...hook, committed };
  }

  /**
   * The commits made at or after `instant`. Never empty: the roll itself
   * commits at ET midnight plus the store's 1 s, so a test that filters on
   * time cannot pass by looking at nothing.
   */
  function commitsFrom(
    committed: { open: boolean; date: string | null; at: number }[],
    instant: number,
  ) {
    const late = committed.filter((c) => c.at >= instant);
    expect(late.length).toBeGreaterThan(0);
    return late;
  }

  /** One act per step: advance the fake clock to a CT wall clock. */
  async function advanceTo(date: string, hh: number, mm: number, ss = 0) {
    const ms = ctInstant(date, hh, mm, ss).getTime() - Date.now();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  const serverOk = () =>
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => makeResponse({ date: serverDate }),
    }));

  const FRI = '2026-06-05';
  const SAT = '2026-06-06';
  const SUN = '2026-06-07';
  const MON = '2026-06-08';

  /** Mount at Friday 14:58:30 CT and let the weekend pass up to Monday 08:29:45. */
  async function mountFridayAndSitThroughTheWeekend() {
    vi.useFakeTimers({ now: ctInstant(FRI, 14, 58, 30) });
    serverDate = FRI;
    serverOk();
    const hook = renderRecorded();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(hook.result.current.displayData?.date).toBe(FRI);
    expect(hook.result.current.isWindowOpen).toBe(true);

    // Friday's close: the window shuts, the day's last read stays up.
    await advanceTo(FRI, 15, 5);
    expect(hook.result.current.isWindowOpen).toBe(false);
    expect(hook.result.current.displayData?.date).toBe(FRI);

    // ET midnight is 23:00 CT: the badge source clears, an hour before CT's.
    await advanceTo(FRI, 23, 1);
    expect(hook.result.current.displayData).toBeNull();
    // Saturday 00:00 ET, the instant the clock's own roll comes 1 s after.
    const etMidnight = Date.parse('2026-06-06T04:00:00Z');

    await advanceTo(SAT, 12, 0);
    await advanceTo(SUN, 12, 0);
    const callsBeforeMonday = fetchMock.mock.calls.length;
    await advanceTo(MON, 8, 29, 45);
    expect(hook.result.current.isWindowOpen).toBe(false);
    expect(hook.result.current.displayData).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(callsBeforeMonday);
    return { ...hook, etMidnight, callsBeforeMonday };
  }

  it('shows no payload after ET midnight, and fetches at once when Monday’s window opens', async () => {
    const t = await mountFridayAndSitThroughTheWeekend();
    serverDate = MON;

    // The watcher's tick at 08:30:30 flips the flag; 08:31:00 is before the
    // first poll (08:31:15), so a fetch by then is the one made at the open.
    await advanceTo(MON, 8, 31, 0);

    expect(t.result.current.isWindowOpen).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(t.callsBeforeMonday + 1);
    expect(t.result.current.displayData?.date).toBe(MON);
    // From ET midnight on, the roll's commit included, no committed render
    // showed Friday's payload.
    for (const c of commitsFrom(t.committed, t.etMidnight)) {
      expect(c.date).not.toBe(FRI);
    }
  });

  it('keeps showing nothing, and surfaces the error, when the first fetch after the open fails', async () => {
    const t = await mountFridayAndSitThroughTheWeekend();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await advanceTo(MON, 8, 31, 0);
    expect(t.result.current.isWindowOpen).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(t.result.current.error).toBe('HTTP 500');
    expect(t.result.current.displayData).toBeNull();

    // Twenty minutes of failing polls, in 5-minute steps.
    for (let m = 36; m <= 51; m += 5) {
      await advanceTo(MON, 8, m, 0);
      expect(t.result.current.displayData).toBeNull();
      expect(t.result.current.error).toBe('HTTP 500');
    }
    for (const c of commitsFrom(t.committed, t.etMidnight)) {
      expect(c.date).toBeNull();
    }
  });

  // 2026-09-07 is Labor Day: Monday is a holiday, the window never opens.
  it('on a Monday holiday the window never opens and nothing stale shows after ET midnight', async () => {
    const FRI_H = '2026-09-04';
    const MON_H = '2026-09-07';
    const TUE_H = '2026-09-08';
    vi.useFakeTimers({ now: ctInstant(FRI_H, 14, 58, 30) });
    serverDate = FRI_H;
    serverOk();
    const { result, committed } = renderRecorded();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.displayData?.date).toBe(FRI_H);

    await advanceTo(FRI_H, 15, 5);
    expect(result.current.isWindowOpen).toBe(false);
    await advanceTo(FRI_H, 23, 1);
    expect(result.current.displayData).toBeNull();
    // Saturday 2026-09-05 00:00 ET.
    const etMidnight = Date.parse('2026-09-05T04:00:00Z');
    const calls = fetchMock.mock.calls.length;

    // Monday 08:31, mid-day and the evening: the holiday keeps it shut.
    await advanceTo('2026-09-05', 12, 0);
    await advanceTo('2026-09-06', 12, 0);
    await advanceTo(MON_H, 8, 31);
    expect(result.current.isWindowOpen).toBe(false);
    await advanceTo(MON_H, 12, 0);
    await advanceTo(MON_H, 20, 0);
    expect(result.current.isWindowOpen).toBe(false);
    expect(result.current.displayData).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(calls);
    for (const c of commitsFrom(committed, etMidnight)) {
      expect(c.date).toBeNull();
    }

    // Tuesday is the next session: it opens and fetches at once.
    serverDate = TUE_H;
    await advanceTo(TUE_H, 8, 29, 45);
    expect(fetchMock.mock.calls.length).toBe(calls);
    await advanceTo(TUE_H, 8, 31);
    expect(result.current.isWindowOpen).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(calls + 1);
    expect(result.current.displayData?.date).toBe(TUE_H);
  });
});
