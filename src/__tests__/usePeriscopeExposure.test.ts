/**
 * usePeriscopeExposure unit tests — fetch-on-mount, polling cadence,
 * empty-reason routing, error paths, spot-hint URL behavior, and
 * unmount-mid-fetch safety. Mirrors the existing useNopeIntraday +
 * useContractTape hook test patterns.
 *
 * After the close (spec: gexbot-after-close-design) the live route
 * (/api/periscope-map) serves the last session's map with a capture-time
 * `asOf` (null on `no_slot`) and the session's `availableSlots`. The
 * "after the close" groups below cover, on the live route only: `asOf`
 * exposed and checked; a body from before today's open dropped at render once
 * the market is open; one fetch on the open flip; the final fetch at close +
 * 3 min; a failed fetch while closed keeping the held view with no error and
 * retrying 5 x 30 s. A picked slot (/api/periscope-exposure) ignores all of it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { AccessMode } from '../utils/auth';
import type { PeriscopeView } from '../hooks/usePeriscopeExposure';

vi.mock('../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner' as AccessMode),
}));

import { usePeriscopeExposure } from '../hooks/usePeriscopeExposure';
import { getAccessMode } from '../utils/auth';
import { POLL_INTERVALS } from '../constants';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function makeView(overrides: Partial<PeriscopeView> = {}): PeriscopeView {
  return {
    capturedAt: '2026-05-08T13:30:00Z',
    priorCapturedAt: '2026-05-08T13:20:00Z',
    expiry: '2026-05-08',
    spot: 5800,
    gamma: {
      ceiling: { strike: 5825, value: 5_000_000, ptsFromSpot: 25 },
      floor: { strike: 5775, value: 4_000_000, ptsFromSpot: -25 },
      accelTop: [],
      topByAbsNear: [],
    },
    charm: {
      tallyNear50: 1_500_000,
      tallyWide100: 2_000_000,
      topByAbs: [],
      charmZeroStrike: null,
    },
    vanna: { topByAbs: [] },
    signFlips: [],
    cone: null,
    breaches: [],
    ...overrides,
  };
}

// Fri 2026-05-08 14:45 ET, mid-session, the day the fixtures below are
// stamped. The hook drops a live body from before today's open once the market
// is open, and arms a timer for 16:03 ET, so a test on the wall clock would
// change with the hour and day it ran at.
const IN_SESSION = '2026-05-08T18:45:00.000Z';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(IN_SESSION) });
  mockFetch.mockReset();
  vi.mocked(getAccessMode).mockReturnValue('owner');
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// Access-mode gating
// ============================================================

describe('usePeriscopeExposure: access mode', () => {
  it('does not fetch when access mode is public', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: true }),
    );
    await act(async () => {});
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.view).toBeNull();
  });

  it('does not poll the live endpoint when access mode is public', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    renderHook(() => usePeriscopeExposure({ marketOpen: true }));
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.PERISCOPE * 3);
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not fetch a picked slot or refresh when access mode is public', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    const { result } = renderHook(() =>
      usePeriscopeExposure({
        marketOpen: true,
        selectedSlot: { date: '2026-05-08', time: '09:30' },
      }),
    );
    await act(async () => {});
    expect(mockFetch).not.toHaveBeenCalled();

    await act(async () => {
      result.current.refresh();
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches when access mode is owner', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    renderHook(() => usePeriscopeExposure({ marketOpen: true }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  });

  it('fetches when access mode is guest', async () => {
    vi.mocked(getAccessMode).mockReturnValue('guest');
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    renderHook(() => usePeriscopeExposure({ marketOpen: true }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  });
});

// ============================================================
// Successful fetch + state
// ============================================================

describe('usePeriscopeExposure: successful fetch', () => {
  it('populates view, asOf, and clears emptyReason on a populated response', async () => {
    const view = makeView({ spot: 5777 });
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: view,
      }),
    );
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.view).not.toBeNull());
    expect(result.current.view?.spot).toBe(5777);
    expect(result.current.asOf).toBe('2026-05-08T13:30:00Z');
    expect(result.current.emptyReason).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('sets emptyReason to no_slot when server returns reason no_slot', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: null,
        reason: 'no_slot',
      }),
    );
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.emptyReason).toBe('no_slot'));
    expect(result.current.view).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('sets emptyReason to no_spot when server returns reason no_spot', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: null,
        reason: 'no_spot',
      }),
    );
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.emptyReason).toBe('no_spot'));
    expect(result.current.view).toBeNull();
  });
});

// ============================================================
// Error paths
// ============================================================

describe('usePeriscopeExposure: errors', () => {
  it('sets error string on non-2xx HTTP response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 500));
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.error).toBe('HTTP 500'));
    expect(result.current.view).toBeNull();
  });

  it('sets error message when fetch rejects', async () => {
    mockFetch.mockRejectedValue(new Error('Network down'));
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.error).toBe('Network down'));
    expect(result.current.view).toBeNull();
  });
});

// ============================================================
// spotHint URL behavior
// ============================================================

describe('usePeriscopeExposure: spot hint', () => {
  it('passes spot query param when spotHint is finite & positive', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    renderHook(() =>
      usePeriscopeExposure({ marketOpen: false, spotHint: 4500 }),
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(mockFetch.mock.calls[0]![0]).toBe('/api/periscope-map?spot=4500');
  });

  it('omits spot param when spotHint is null', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    renderHook(() =>
      usePeriscopeExposure({ marketOpen: false, spotHint: null }),
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(mockFetch.mock.calls[0]![0]).toBe('/api/periscope-map');
  });

  it('omits spot param when spotHint is 0', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    renderHook(() => usePeriscopeExposure({ marketOpen: false, spotHint: 0 }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(mockFetch.mock.calls[0]![0]).toBe('/api/periscope-map');
  });

  it('omits spot param when spotHint is NaN', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    renderHook(() =>
      usePeriscopeExposure({ marketOpen: false, spotHint: Number.NaN }),
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(mockFetch.mock.calls[0]![0]).toBe('/api/periscope-map');
  });

  it('omits spot param when spotHint is negative', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    renderHook(() => usePeriscopeExposure({ marketOpen: false, spotHint: -1 }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(mockFetch.mock.calls[0]![0]).toBe('/api/periscope-map');
  });
});

// ============================================================
// URL routing — live vs. historical
// ============================================================

describe('usePeriscopeExposure: URL routing', () => {
  it('routes historical reads (any selectedSlot) to /api/periscope-exposure', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
        availableSlots: [],
      }),
    );
    renderHook(() =>
      usePeriscopeExposure({
        marketOpen: false,
        selectedSlot: { date: '2026-05-19', time: '13:30' },
      }),
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toMatch(/\/api\/periscope-exposure/);
    expect(url).toMatch(/time=13%3A30/);
  });
});

// ============================================================
// Polling
// ============================================================

describe('usePeriscopeExposure: polling', () => {
  it('polls at PERISCOPE cadence while market is open', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    renderHook(() => usePeriscopeExposure({ marketOpen: true }));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.PERISCOPE);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.PERISCOPE);
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not poll when market is closed (initial fetch only)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: false,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    renderHook(() => usePeriscopeExposure({ marketOpen: false }));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.PERISCOPE * 5);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('cleans up the interval on unmount', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    const { unmount } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: true }),
    );
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.PERISCOPE * 3);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// refresh()
// ============================================================

describe('usePeriscopeExposure: refresh', () => {
  it('refresh() triggers a fresh fetch', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: false,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });
});

// ============================================================
// Unmount-mid-fetch guard
// ============================================================

describe('usePeriscopeExposure: unmount safety', () => {
  it('does not setState when fetch resolves after unmount', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const pending = new Promise<unknown>((res) => {
      resolveFetch = res;
    });
    mockFetch.mockReturnValueOnce(pending);

    const { result, unmount } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    unmount();
    resolveFetch(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView({ spot: 9999 }),
      }),
    );
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.view).toBeNull();
    expect(result.current.asOf).toBeNull();
  });

  it('does not set error when fetch rejects after unmount', async () => {
    let rejectFetch: (err: Error) => void = () => {};
    const pending = new Promise<unknown>((_resolve, reject) => {
      rejectFetch = reject;
    });
    mockFetch.mockReturnValueOnce(pending);

    const { result, unmount } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    unmount();
    rejectFetch(new Error('late fail'));
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.error).toBeNull();
  });
});

// ============================================================
// After the close
// ============================================================
// After the close /api/periscope-map serves the last session's map with a
// capture-time `asOf` (null on `no_slot`) and the session's `availableSlots`.
// Fixtures: Fri 2026-11-20, a full session in EST (open 14:30Z, close 21:00Z,
// the final fetch due 21:03Z), and the Monday after.

const FRI_CLOSE_AT = '2026-11-20T21:00:50.036Z'; // the session's last capture
const FRI_SLOTS = [
  '2026-11-20T20:58:00.000Z',
  '2026-11-20T20:59:00.000Z',
  '2026-11-20T21:00:00.000Z',
];
const FRI_EVENING = '2026-11-20T21:01:00.000Z'; // 16:01:00 ET: 120 s to the final fetch
const FRI_LATER = '2026-11-20T22:00:00.000Z'; // 17:00 ET: the final fetch is days off
const FINAL_FETCH_IN_MS = 120_000;
const MON_BEFORE_OPEN = '2026-11-23T14:29:50.000Z'; // 09:29:50 ET
const MON_JUST_OPEN = '2026-11-23T14:30:05.000Z'; // 09:30:05 ET
const MON_10_CT = '2026-11-23T16:00:00.000Z'; // 10:00 CT, 11:00 ET

/** Fake timers on a fixed clock, for tests that move time. */
function fakeClock(now: string): void {
  vi.useRealTimers();
  vi.useFakeTimers({ now: new Date(now) });
}

// Advance the fake clock inside act so state updates render between ticks.
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** What the endpoint answers after the close: the last session, with `asOf`. */
function closedBody(over: Record<string, unknown> = {}) {
  return {
    marketOpen: false,
    asOf: FRI_CLOSE_AT,
    data: makeView({ capturedAt: FRI_CLOSE_AT, spot: 6000 }),
    availableSlots: FRI_SLOTS,
    ...over,
  };
}

/** A body from today's session, captured `asOf`. */
function liveBody(asOf: string, spot = 6010) {
  return {
    marketOpen: true,
    asOf,
    data: makeView({ capturedAt: asOf, spot }),
    availableSlots: [asOf],
  };
}

type Answer = () => Response | Promise<Response>;
const answerWith =
  (body: unknown): Answer =>
  () =>
    jsonResponse(body);
const unavailable: Answer = () => jsonResponse({}, 503);
const refused =
  (status: number): Answer =>
  () =>
    jsonResponse({}, status);

/** Answer call n with answers[n], and the last answer from then on. */
function mockFetchSequence(...answers: Answer[]): void {
  let call = 0;
  mockFetch.mockImplementation(async () => {
    const answer = answers[Math.min(call, answers.length - 1)]!;
    call += 1;
    return answer();
  });
}

type OpenProps = { open: boolean };
const useLiveRoute = ({ open }: OpenProps) =>
  usePeriscopeExposure({ marketOpen: open });

describe('usePeriscopeExposure: a closed map', () => {
  it('exposes the last session’s view, asOf and slots while the market is closed', async () => {
    fakeClock(FRI_LATER);
    mockFetchSequence(answerWith(closedBody()));
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toBe('/api/periscope-map');
    expect(result.current.view?.spot).toBe(6000);
    expect(result.current.asOf).toBe(FRI_CLOSE_AT);
    expect(result.current.availableSlots).toEqual(FRI_SLOTS);
    expect(result.current.emptyReason).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('exposes asOf on a no_spot body too, with no view and the slots', async () => {
    fakeClock(FRI_LATER);
    mockFetchSequence(
      answerWith(closedBody({ data: null, reason: 'no_spot' })),
    );
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    await advance(0);
    expect(result.current.asOf).toBe(FRI_CLOSE_AT);
    expect(result.current.emptyReason).toBe('no_spot');
    expect(result.current.view).toBeNull();
    expect(result.current.availableSlots).toEqual(FRI_SLOTS);
  });

  it('has no asOf on a closed no_slot body, and keeps the session’s slots', async () => {
    fakeClock(FRI_LATER);
    mockFetchSequence(
      answerWith(closedBody({ data: null, reason: 'no_slot', asOf: null })),
    );
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    await advance(0);
    expect(result.current.asOf).toBeNull();
    expect(result.current.emptyReason).toBe('no_slot');
    expect(result.current.view).toBeNull();
    expect(result.current.availableSlots).toEqual(FRI_SLOTS);
    expect(result.current.error).toBeNull();
  });

  // R4: the body is an unchecked cast, so asOf can be anything. It is read as
  // no asOf, and the view still renders.
  it.each([
    ['a number', 1_764_000_000],
    // Date.parse reads both of these as a date.
    ['a number that reads as a year', 2026],
    ['a string that reads as a year', '2026'],
    ['a string that reads as a month', '5'],
    ['an empty string', ''],
    ['text that is not a date', 'yesterday'],
    ['an object', { at: FRI_CLOSE_AT }],
    ['an array holding a timestamp', [FRI_CLOSE_AT]],
  ])('reads %s as no asOf and still returns the view', async (_n, asOf) => {
    fakeClock(FRI_LATER);
    mockFetchSequence(answerWith(closedBody({ asOf })));
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    await advance(0);
    expect(result.current.asOf).toBeNull();
    expect(result.current.view?.spot).toBe(6000);
    expect(result.current.error).toBeNull();
  });

  it('reads an availableSlots that is no array as no slots, and does not crash the render', async () => {
    fakeClock(MON_JUST_OPEN);
    mockFetchSequence(
      answerWith(
        closedBody({
          asOf: null,
          data: null,
          reason: 'no_slot',
          availableSlots: { last: FRI_SLOTS[2] },
        }),
      ),
    );
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: true },
    });
    await advance(0);
    expect(result.current.availableSlots).toEqual([]);
    expect(result.current.emptyReason).toBe('no_slot');
    expect(result.current.error).toBeNull();
  });

  it('surfaces a 2xx body that is null as an error, not a crash', async () => {
    fakeClock(MON_10_CT);
    mockFetchSequence(answerWith(null));
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: true },
    });
    await advance(0);
    expect(result.current.error).toMatch(/null/);
    expect(result.current.view).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});

describe('usePeriscopeExposure: a body from before today’s open, once the market is open', () => {
  it('is dropped at 09:30:05 ET: no view, slots or asOf, reason no_slot, and no error', async () => {
    fakeClock(MON_JUST_OPEN);
    mockFetchSequence(answerWith(closedBody()));
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: true },
    });
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.current.view).toBeNull();
    expect(result.current.availableSlots).toEqual([]);
    expect(result.current.asOf).toBeNull();
    expect(result.current.emptyReason).toBe('no_slot');
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('is dropped by its last listed slot when asOf is null (a closed no_slot)', async () => {
    fakeClock(MON_JUST_OPEN);
    mockFetchSequence(
      answerWith(closedBody({ data: null, reason: 'no_slot', asOf: null })),
    );
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: true },
    });
    await advance(0);
    expect(result.current.availableSlots).toEqual([]);
    expect(result.current.emptyReason).toBe('no_slot');
  });

  it('is dropped by its last listed slot when asOf is not a timestamp', async () => {
    fakeClock(MON_JUST_OPEN);
    mockFetchSequence(answerWith(closedBody({ asOf: 'yesterday' })));
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: true },
    });
    await advance(0);
    expect(result.current.view).toBeNull();
    expect(result.current.availableSlots).toEqual([]);
  });

  it('is kept when captured at the open instant, dropped a millisecond before', async () => {
    fakeClock(MON_JUST_OPEN);
    mockFetchSequence(
      answerWith(liveBody('2026-11-23T14:30:00.000Z')),
      answerWith(liveBody('2026-11-23T14:29:59.999Z')),
    );
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: true },
    });
    await advance(0);
    expect(result.current.view?.spot).toBe(6010);
    expect(result.current.asOf).toBe('2026-11-23T14:30:00.000Z');

    act(() => result.current.refresh());
    await advance(0);
    expect(result.current.view).toBeNull();
    expect(result.current.asOf).toBeNull();
  });

  it('is kept while the market is closed', async () => {
    fakeClock(MON_BEFORE_OPEN);
    mockFetchSequence(answerWith(closedBody()));
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: false },
    });
    await advance(0);
    expect(result.current.view?.spot).toBe(6000);
    expect(result.current.asOf).toBe(FRI_CLOSE_AT);
  });

  it('keeps an in-session no_slot’s slots: asOf null, today’s slots', async () => {
    fakeClock(MON_10_CT);
    const slots = ['2026-11-23T15:53:00.000Z', '2026-11-23T15:54:00.000Z'];
    mockFetchSequence(
      answerWith({
        marketOpen: true,
        asOf: null,
        data: null,
        reason: 'no_slot',
        availableSlots: slots,
      }),
    );
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: true },
    });
    await advance(0);
    expect(result.current.availableSlots).toEqual(slots);
    expect(result.current.emptyReason).toBe('no_slot');
    expect(result.current.asOf).toBeNull();
    expect(result.current.view).toBeNull();
  });

  it('keeps an in-session no_slot that lists no slots yet', async () => {
    fakeClock(MON_JUST_OPEN);
    mockFetchSequence(
      answerWith({
        marketOpen: true,
        asOf: null,
        data: null,
        reason: 'no_slot',
        availableSlots: [],
      }),
    );
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: true },
    });
    await advance(0);
    expect(result.current.emptyReason).toBe('no_slot');
    expect(result.current.availableSlots).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  // The panel must never show Friday's map as today's: a response held across
  // the open is dropped on the render of the flip itself, before the refetch
  // that the flip starts has landed.
  it('is dropped on the render of the flip, before the refetch lands', async () => {
    fakeClock(MON_BEFORE_OPEN);
    let landLive: ((r: Response) => void) | undefined;
    mockFetchSequence(
      answerWith(closedBody()),
      () =>
        new Promise<Response>((resolve) => {
          landLive = resolve;
        }),
    );
    const renders: Array<{ open: boolean; view: boolean; slots: number }> = [];
    const { result, rerender } = renderHook(
      ({ open }: OpenProps) => {
        const out = useLiveRoute({ open });
        renders.push({
          open,
          view: out.view != null,
          slots: out.availableSlots.length,
        });
        return out;
      },
      { initialProps: { open: false } },
    );
    await advance(0);
    expect(result.current.view?.spot).toBe(6000);

    // 09:30:00 ET: the market opens and the refetch is still out.
    await advance(10_000);
    rerender({ open: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.current.view).toBeNull();
    expect(result.current.availableSlots).toEqual([]);
    expect(result.current.asOf).toBeNull();
    // No render with the market open ever carried Friday's map.
    const openRenders = renders.filter((r) => r.open);
    expect(openRenders.length).toBeGreaterThan(0);
    expect(openRenders.filter((r) => r.view || r.slots > 0)).toEqual([]);

    // The live answer lands and replaces the empty panel.
    await act(async () => {
      landLive?.(jsonResponse(liveBody('2026-11-23T14:30:02.000Z')));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.view?.spot).toBe(6010);
    expect(result.current.asOf).toBe('2026-11-23T14:30:02.000Z');
  });

  it('stays empty when the read at the open still answers with the last session, then takes the next live poll', async () => {
    fakeClock(MON_BEFORE_OPEN);
    mockFetchSequence(
      answerWith(closedBody()),
      // An edge cache that still holds Friday's close.
      answerWith(closedBody()),
      answerWith(liveBody('2026-11-23T14:30:50.000Z')),
    );
    const { result, rerender } = renderHook(useLiveRoute, {
      initialProps: { open: false },
    });
    await advance(10_000);
    rerender({ open: true });
    await advance(0);
    expect(result.current.view).toBeNull();
    expect(result.current.error).toBeNull();

    // The first poll after the open lands today's capture.
    await advance(POLL_INTERVALS.PERISCOPE);
    expect(result.current.view?.spot).toBe(6010);
    expect(result.current.asOf).toBe('2026-11-23T14:30:50.000Z');
  });
});

describe('usePeriscopeExposure: the open flip', () => {
  it('fetches once at the flip: not at mount, on a rerender or at the close', async () => {
    fakeClock(MON_BEFORE_OPEN);
    mockFetchSequence(
      answerWith(closedBody()),
      answerWith(liveBody('2026-11-23T14:30:02.000Z')),
    );
    const { result, rerender } = renderHook(useLiveRoute, {
      initialProps: { open: false },
    });
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // The open: the fetch is issued as the effect runs, before any timer.
    await advance(10_000);
    rerender({ open: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1]![0]).toBe('/api/periscope-map');
    await advance(0);
    expect(result.current.view?.spot).toBe(6010);

    // A rerender that changes nothing is not an edge, and neither is the close.
    rerender({ open: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    rerender({ open: false });
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('makes no extra fetch when the hook mounts open', async () => {
    fakeClock(MON_10_CT);
    mockFetchSequence(answerWith(liveBody('2026-11-23T15:59:30.000Z')));
    renderHook(useLiveRoute, { initialProps: { open: true } });
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('makes one read when the spot hint changes after the open: the edge is over', async () => {
    fakeClock(MON_BEFORE_OPEN);
    mockFetchSequence(
      answerWith(closedBody()),
      answerWith(liveBody('2026-11-23T14:30:02.000Z')),
    );
    const { rerender } = renderHook(
      ({ open, spot }: { open: boolean; spot: number }) =>
        usePeriscopeExposure({ marketOpen: open, spotHint: spot }),
      { initialProps: { open: false, spot: 6000 } },
    );
    await advance(10_000);
    rerender({ open: true, spot: 6000 });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    rerender({ open: true, spot: 6005 });
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[2]![0]).toBe('/api/periscope-map?spot=6005');
  });

  it('shows the error over the held view when the read at the open fails, and starts no retry series: the poll is the retry', async () => {
    fakeClock(MON_BEFORE_OPEN);
    mockFetchSequence(
      answerWith(closedBody()),
      unavailable,
      answerWith(liveBody('2026-11-23T14:30:55.000Z', 6020)),
    );
    const { result, rerender } = renderHook(useLiveRoute, {
      initialProps: { open: false },
    });
    await advance(10_000);
    rerender({ open: true });
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe('HTTP 503');

    // No retry 30 s later; the next poll is at +60 s.
    await advance(30_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await advance(30_000);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBeNull();
    expect(result.current.view?.spot).toBe(6020);
  });
});

describe('usePeriscopeExposure: a picked slot ignores the after-close rules', () => {
  const SLOT = { date: '2026-11-20', time: '15:00' };

  it('keeps a body from before today’s open, with its asOf and slots, and reads /api/periscope-exposure', async () => {
    fakeClock(MON_JUST_OPEN);
    mockFetchSequence(answerWith(closedBody()));
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: true, selectedSlot: SLOT }),
    );
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toMatch(/^\/api\/periscope-exposure\?/);
    expect(result.current.view?.spot).toBe(6000);
    expect(result.current.asOf).toBe(FRI_CLOSE_AT);
    expect(result.current.availableSlots).toEqual(FRI_SLOTS);
    expect(result.current.emptyReason).toBeNull();
  });

  it('does not poll while the market is open: the slice is immutable', async () => {
    fakeClock(MON_10_CT);
    mockFetchSequence(answerWith(closedBody()));
    renderHook(() =>
      usePeriscopeExposure({ marketOpen: true, selectedSlot: SLOT }),
    );
    await advance(0);
    await advance(POLL_INTERVALS.PERISCOPE * 3);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not fetch at the open flip', async () => {
    fakeClock(MON_BEFORE_OPEN);
    mockFetchSequence(answerWith(closedBody()));
    const { rerender } = renderHook(
      ({ open }: OpenProps) =>
        usePeriscopeExposure({ marketOpen: open, selectedSlot: SLOT }),
      { initialProps: { open: false } },
    );
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await advance(10_000);
    rerender({ open: true });
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('arms no final fetch', async () => {
    fakeClock(FRI_EVENING);
    mockFetchSequence(answerWith(closedBody()));
    renderHook(() =>
      usePeriscopeExposure({ marketOpen: false, selectedSlot: SLOT }),
    );
    await advance(FINAL_FETCH_IN_MS + 10 * 60_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('shows a failed read, though the market is closed and a view is held, and does not retry it', async () => {
    fakeClock(FRI_LATER);
    mockFetchSequence(answerWith(closedBody()), unavailable);
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false, selectedSlot: SLOT }),
    );
    await advance(0);
    expect(result.current.view?.spot).toBe(6000);

    act(() => result.current.refresh());
    await advance(0);
    expect(result.current.error).toBe('HTTP 503');
    expect(result.current.view?.spot).toBe(6000);

    await advance(10 * 60_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('shows a failed live read when only a picked slot’s view is held, not the held view', async () => {
    fakeClock(FRI_LATER);
    mockFetchSequence(answerWith(closedBody()), unavailable);
    const { result, rerender } = renderHook(
      ({ slot }: { slot: typeof SLOT | null }) =>
        usePeriscopeExposure({ marketOpen: false, selectedSlot: slot }),
      { initialProps: { slot: SLOT as typeof SLOT | null } },
    );
    await advance(0);
    expect(result.current.view?.spot).toBe(6000);

    // Back to live: the stored response is still the picked slot's.
    rerender({ slot: null });
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1]![0]).toBe('/api/periscope-map');
    expect(result.current.error).toBe('HTTP 503');
  });

  it('shows a failed picked-slot read over a held live view, though the market is closed, and does not retry it', async () => {
    fakeClock(FRI_LATER);
    mockFetchSequence(answerWith(closedBody()), unavailable);
    const { result, rerender } = renderHook(
      ({ slot }: { slot: typeof SLOT | null }) =>
        usePeriscopeExposure({ marketOpen: false, selectedSlot: slot }),
      { initialProps: { slot: null as typeof SLOT | null } },
    );
    await advance(0);
    expect(result.current.view?.spot).toBe(6000);

    // The user picks a slot: the live view is still held when its read fails.
    rerender({ slot: SLOT });
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1]![0]).toMatch(/^\/api\/periscope-exposure\?/);
    expect(result.current.error).toBe('HTTP 503');

    await advance(10 * 60_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('usePeriscopeExposure: the final fetch', () => {
  it('fires once at 16:03 ET, not before, and shows what it finds', async () => {
    fakeClock(FRI_EVENING);
    mockFetchSequence(
      answerWith(closedBody()),
      answerWith(
        closedBody({
          asOf: '2026-11-20T21:02:10.000Z',
          data: makeView({ spot: 6001 }),
        }),
      ),
    );
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: false },
    });
    await advance(FINAL_FETCH_IN_MS - 1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.current.asOf).toBe(FRI_CLOSE_AT);

    await advance(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1]![0]).toBe('/api/periscope-map');
    expect(result.current.asOf).toBe('2026-11-20T21:02:10.000Z');
    expect(result.current.view?.spot).toBe(6001);
  });

  it('re-arms for the next trading day', async () => {
    fakeClock(FRI_EVENING);
    mockFetchSequence(answerWith(closedBody()));
    renderHook(useLiveRoute, { initialProps: { open: false } });
    await advance(FINAL_FETCH_IN_MS);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Mon 16:03 ET is 72 h after Fri 16:03 ET: the same EST offset.
    await advance(72 * 3_600_000 - 1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('fires for a tab that stayed open through the close', async () => {
    fakeClock('2026-11-20T20:59:50.000Z');
    mockFetchSequence(
      answerWith(liveBody('2026-11-20T20:59:20.000Z')),
      answerWith(closedBody()),
    );
    const { result, rerender } = renderHook(useLiveRoute, {
      initialProps: { open: true },
    });
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // The close at 21:00:00; 21:03:00 is the final fetch, 180 s after it.
    await advance(10_000);
    rerender({ open: false });
    await advance(179_999);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.current.asOf).toBe(FRI_CLOSE_AT);
  });

  it('makes no request for a public visitor', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    fakeClock(FRI_EVENING);
    mockFetchSequence(answerWith(closedBody()));
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: false },
    });
    await advance(FINAL_FETCH_IN_MS + 10 * 60_000);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('arms no timer for a public visitor: no final fetch, no poll', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    fakeClock(FRI_EVENING);
    mockFetchSequence(answerWith(closedBody()));
    renderHook(useLiveRoute, { initialProps: { open: true } });
    await advance(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops when the hook unmounts', async () => {
    fakeClock(FRI_EVENING);
    mockFetchSequence(answerWith(closedBody()));
    const { unmount } = renderHook(useLiveRoute, {
      initialProps: { open: false },
    });
    await advance(0);
    unmount();
    await advance(FINAL_FETCH_IN_MS + 10 * 60_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('usePeriscopeExposure: a failed fetch while the market is closed', () => {
  it('keeps the held view with no error when the final fetch fails, and retries 30 s later', async () => {
    fakeClock(FRI_EVENING);
    mockFetchSequence(
      answerWith(closedBody()),
      unavailable,
      answerWith(closedBody({ asOf: '2026-11-20T21:02:10.000Z' })),
    );
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: false },
    });
    await advance(FINAL_FETCH_IN_MS);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.view?.spot).toBe(6000);
    expect(result.current.asOf).toBe(FRI_CLOSE_AT);

    await advance(29_999);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.current.asOf).toBe('2026-11-20T21:02:10.000Z');
    expect(result.current.error).toBeNull();
  });

  it('keeps the held view through every retry of a final fetch, then stops after the fifth', async () => {
    fakeClock(FRI_EVENING);
    mockFetchSequence(answerWith(closedBody()), unavailable);
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: false },
    });
    await advance(FINAL_FETCH_IN_MS);
    for (let retry = 1; retry <= 5; retry += 1) {
      await advance(30_000);
      expect(mockFetch).toHaveBeenCalledTimes(2 + retry);
      expect(result.current.error).toBeNull();
      expect(result.current.view?.spot).toBe(6000);
    }
    await advance(10 * 60_000);
    expect(mockFetch).toHaveBeenCalledTimes(7);
    expect(result.current.error).toBeNull();
    expect(result.current.view?.spot).toBe(6000);
  });

  it('retries a failed refresh of a held view 5 times, 30 s apart, with no error', async () => {
    fakeClock(FRI_LATER);
    mockFetchSequence(answerWith(closedBody()), unavailable);
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: false },
    });
    await advance(0);
    act(() => result.current.refresh());
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.view?.spot).toBe(6000);
    for (let retry = 1; retry <= 5; retry += 1) {
      await advance(30_000);
      expect(mockFetch).toHaveBeenCalledTimes(2 + retry);
    }
    await advance(10 * 60_000);
    expect(mockFetch).toHaveBeenCalledTimes(7);
    expect(result.current.error).toBeNull();
  });

  it('shows the error while it retries when nothing is held: 1 + 5 requests, then stops', async () => {
    fakeClock(FRI_LATER);
    mockFetchSequence(unavailable);
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: false },
    });
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe('HTTP 503');
    expect(result.current.view).toBeNull();
    expect(result.current.loading).toBe(false);

    await advance(29_999);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (let retry = 2; retry <= 5; retry += 1) {
      await advance(30_000);
      expect(mockFetch).toHaveBeenCalledTimes(1 + retry);
    }
    await advance(10 * 60_000);
    expect(mockFetch).toHaveBeenCalledTimes(6);
    expect(result.current.error).toBe('HTTP 503');
  });

  it('makes the same 1 + 5 requests under StrictMode, whose first mount read is superseded', async () => {
    fakeClock(FRI_LATER);
    mockFetchSequence(unavailable);
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: false },
      wrapper: StrictMode,
    });
    await advance(0);
    // StrictMode mounts twice: two requests, the first one superseded.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (let retry = 1; retry <= 5; retry += 1) {
      await advance(30_000);
      expect(mockFetch).toHaveBeenCalledTimes(2 + retry);
    }
    await advance(10 * 60_000);
    expect(mockFetch).toHaveBeenCalledTimes(7);
    expect(result.current.error).toBe('HTTP 503');
  });

  it('shows the map and clears the error once a retry succeeds, then stops', async () => {
    fakeClock(FRI_LATER);
    mockFetchSequence(unavailable, answerWith(closedBody()));
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: false },
    });
    await advance(0);
    expect(result.current.error).toBe('HTTP 503');

    await advance(30_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.view?.spot).toBe(6000);

    await advance(10 * 60_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries a dropped connection, whose fetch rejects, as a transient failure', async () => {
    fakeClock(FRI_LATER);
    mockFetchSequence(() => {
      throw new TypeError('Failed to fetch');
    }, answerWith(closedBody()));
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: false },
    });
    await advance(0);
    expect(result.current.error).toBe('Failed to fetch');
    await advance(30_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.view?.spot).toBe(6000);
  });

  it('retries a 2xx body that is not JSON, and names it', async () => {
    fakeClock(FRI_LATER);
    mockFetchSequence(
      () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token <');
          },
        }) as unknown as Response,
      answerWith(closedBody()),
    );
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: false },
    });
    await advance(0);
    expect(result.current.error).toBe('Unexpected token <');
    await advance(30_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
  });

  it.each([400, 401, 403, 404])(
    'does not retry a refused request (status %i), and shows it when nothing is held',
    async (status) => {
      fakeClock(FRI_LATER);
      mockFetchSequence(refused(status));
      const { result } = renderHook(useLiveRoute, {
        initialProps: { open: false },
      });
      await advance(0);
      await advance(6 * 30_000);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.current.error).toBe(`HTTP ${status}`);
    },
  );

  it('does not retry a refused final fetch, and keeps the held view with no error', async () => {
    fakeClock(FRI_EVENING);
    mockFetchSequence(answerWith(closedBody()), refused(403));
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: false },
    });
    await advance(FINAL_FETCH_IN_MS);
    await advance(6 * 30_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.view?.spot).toBe(6000);
  });

  it('shows the error when only an empty response is held: a view is what a closed failure keeps', async () => {
    fakeClock(FRI_LATER);
    mockFetchSequence(
      answerWith(closedBody({ data: null, reason: 'no_spot' })),
      unavailable,
    );
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: false },
    });
    await advance(0);
    act(() => result.current.refresh());
    await advance(0);
    expect(result.current.error).toBe('HTTP 503');
    expect(result.current.emptyReason).toBe('no_spot');
  });

  it('stops retrying when the hook unmounts', async () => {
    fakeClock(FRI_LATER);
    mockFetchSequence(unavailable);
    const { unmount } = renderHook(useLiveRoute, {
      initialProps: { open: false },
    });
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    unmount();
    await advance(10 * 60_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('starts no retry series for a read that a newer one superseded, though it fails late', async () => {
    fakeClock(FRI_LATER);
    let failLate: ((r: Response) => void) | undefined;
    mockFetchSequence(
      () =>
        new Promise<Response>((resolve) => {
          failLate = resolve;
        }),
      answerWith(closedBody()),
    );
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: false },
    });
    await advance(0);
    act(() => result.current.refresh());
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.current.view?.spot).toBe(6000);

    // The superseded read answers 503 late: no error, no retry series.
    failLate?.(jsonResponse({}, 503));
    await advance(0);
    expect(result.current.error).toBeNull();
    await advance(10 * 60_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('usePeriscopeExposure: reads that overlap', () => {
  it('shows the error of the newest read only: a superseded read’s late failure is ignored', async () => {
    fakeClock(MON_10_CT);
    let failLate: ((r: Response) => void) | undefined;
    mockFetchSequence(
      () =>
        new Promise<Response>((resolve) => {
          failLate = resolve;
        }),
      answerWith(liveBody('2026-11-23T15:59:30.000Z')),
    );
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: true },
    });
    await advance(0);
    act(() => result.current.refresh());
    await advance(0);
    expect(result.current.view?.spot).toBe(6010);

    failLate?.(jsonResponse({}, 503));
    await advance(0);
    expect(result.current.error).toBeNull();
    expect(result.current.view?.spot).toBe(6010);
  });

  it('does not let a superseded read overwrite a newer one when it lands late', async () => {
    fakeClock(MON_10_CT);
    let landLate: ((r: Response) => void) | undefined;
    mockFetchSequence(
      () =>
        new Promise<Response>((resolve) => {
          landLate = resolve;
        }),
      answerWith(liveBody('2026-11-23T15:59:30.000Z', 6020)),
    );
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: true },
    });
    await advance(0);
    act(() => result.current.refresh());
    await advance(0);
    expect(result.current.view?.spot).toBe(6020);

    landLate?.(jsonResponse(liveBody('2026-11-23T15:58:30.000Z', 6001)));
    await advance(0);
    expect(result.current.view?.spot).toBe(6020);
    expect(result.current.asOf).toBe('2026-11-23T15:59:30.000Z');
  });

  it('stays loading until the newest read lands, not when a superseded one does', async () => {
    fakeClock(MON_10_CT);
    const landers: Array<(r: Response) => void> = [];
    const pending: Answer = () =>
      new Promise<Response>((resolve) => {
        landers.push(resolve);
      });
    mockFetchSequence(pending);
    const { result } = renderHook(useLiveRoute, {
      initialProps: { open: true },
    });
    await advance(0);
    act(() => result.current.refresh());
    await advance(0);
    expect(landers).toHaveLength(2);
    expect(result.current.loading).toBe(true);

    landers[0]!(jsonResponse(liveBody('2026-11-23T15:58:30.000Z', 6001)));
    await advance(0);
    expect(result.current.loading).toBe(true);
    expect(result.current.view).toBeNull();

    landers[1]!(jsonResponse(liveBody('2026-11-23T15:59:30.000Z', 6020)));
    await advance(0);
    expect(result.current.loading).toBe(false);
    expect(result.current.view?.spot).toBe(6020);
  });
});
