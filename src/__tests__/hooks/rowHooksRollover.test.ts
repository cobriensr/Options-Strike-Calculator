/**
 * The three row hooks (useNetFlowHistory, useContractTape, useTickerCandles)
 * across an ET midnight (docs/superpowers/specs/panel-date-rollover-2026-11-14
 * .md, Phase 7c, design item 3).
 *
 * Each polls only while its `date` is today: a past day is an immutable
 * snapshot and is fetched once (`historical` in useFetchedData gates the poll
 * and nothing else: not the URL, not a cache key). "Today" was the CT date,
 * read from the wall clock on each render, which was wrong twice. The rows are
 * fed ET-stamped fire dates, so from 23:00 to 24:00 CT, when ET is already on
 * the new day, a row dated the new day was called historical and not polled.
 * And nothing re-rendered a row at midnight, so a row dated the night kept
 * polling a day that had become yesterday. `today` is the shared ET clock now
 * (useETToday), which re-renders every mounted row in the same commit at the
 * roll. The shared clock's timer is armed for 1 s past midnight, which is
 * 23:00:01 CT the evening before. Every case but the CT-window one starts one
 * poll interval and 10 s before an ET midnight (INTERVAL + POLL_LEAD_MS; all
 * three hooks poll on POLL_INTERVALS.OTM_FLOW), so a change to that constant
 * cannot break a correct row, down to the bound the precondition test below
 * pins. The CT-window case starts at 23:30 CT. No case calls `rerender`. (A
 * row's own fetch result does re-render it, so the stops-polling case puts a
 * poll after the roll: a row that only reads the wall clock on a render would
 * still make that one poll.) Owner decision 2026-11-14.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { POLL_INTERVALS } from '../../constants';
import { useContractTape } from '../../hooks/useContractTape';
import { useNetFlowHistory } from '../../hooks/useNetFlowHistory';
import { useTickerCandles } from '../../hooks/useTickerCandles';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  // Answer each request with the date it asked for, so no response is gated
  // out as another day's.
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => ({
      date: new URL(url, 'http://x').searchParams.get('date'),
      series: [],
      candles: [],
      previousClose: null,
    }),
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The hooks, each mounted open and polling-eligible on `date`. */
const HOOKS = [
  {
    name: 'useNetFlowHistory',
    mount: (date: string) =>
      renderHook(() =>
        useNetFlowHistory({
          ticker: 'SPY',
          date,
          enabled: true,
          marketOpen: true,
        }),
      ),
  },
  {
    name: 'useContractTape',
    mount: (date: string) =>
      renderHook(() =>
        useContractTape({
          chain: 'SPY261110C00500000',
          date,
          enabled: true,
          marketOpen: true,
        }),
      ),
  },
  {
    name: 'useTickerCandles',
    mount: (date: string) =>
      renderHook(() =>
        useTickerCandles({
          ticker: 'SPY',
          date,
          enabled: true,
          marketOpen: true,
        }),
      ),
  },
] as const;

/** The `date` of every request so far, in order. */
const datesRequested = () =>
  fetchMock.mock.calls.map((c) =>
    new URL(c[0] as string, 'http://x').searchParams.get('date'),
  );

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** All three hooks poll on this one constant. */
const INTERVAL = POLL_INTERVALS.OTM_FLOW;
/**
 * The shared clock fires this long after an ET midnight. Mirrors
 * MIDNIGHT_SLACK_MS in src/utils/timezone.ts (private there); change them
 * together.
 */
const ROLL_LAG_MS = 1_000;
/** How long before midnight the polls straddle it: the first poll lands here. */
const POLL_LEAD_MS = 10_000;

// The stops-polling case lands its first poll POLL_LEAD_MS before midnight and
// the roll ROLL_LAG_MS after it, so its second poll, one INTERVAL after the
// first, falls after the roll only if INTERVAL exceeds their sum. At or below
// 11 s the case fails on correct hooks: the second poll comes before the roll
// (and at exactly 11 s it ties with it), so the guard is strictly greater.
it('has a poll interval the stops-polling case can straddle', () => {
  expect(
    INTERVAL,
    'stops-polling needs its second poll after the roll',
  ).toBeGreaterThan(POLL_LEAD_MS + ROLL_LAG_MS);
});

describe.each([
  {
    zone: 'EST (winter)',
    midnight: '2026-11-10T05:00:00Z',
    // 23:30 CT the evening before, ET already on the new day.
    window: '2026-11-10T05:30:00Z',
    night: '2026-11-09',
    morning: '2026-11-10',
  },
  {
    zone: 'EDT (summer)',
    midnight: '2026-07-15T04:00:00Z',
    window: '2026-07-15T04:30:00Z',
    night: '2026-07-14',
    morning: '2026-07-15',
  },
])('row hooks across the $zone midnight', (m) => {
  /** Pin the fake clock `leadMs` before this zone's ET midnight. */
  const startBeforeMidnight = (leadMs: number) =>
    vi.setSystemTime(new Date(Date.parse(m.midnight) - leadMs));

  describe.each(HOOKS)('$name', ({ mount }) => {
    it('stops polling the night once it is yesterday, with no parent re-render', async () => {
      vi.useFakeTimers();
      // Start one interval and 10 s before midnight, so the first poll lands
      // 10 s before it, the roll 1 s after it, and the second poll one
      // interval after the first, which is past the roll for any interval over
      // 11 s. A poll's own result re-renders the row, which would read a
      // wall-clock "today" too late by one poll; only a row that rolled skips
      // the second poll.
      startBeforeMidnight(INTERVAL + POLL_LEAD_MS);
      mount(m.night);
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await advance(INTERVAL);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Through midnight and the roll, to one second past the second poll.
      await advance(INTERVAL + ROLL_LAG_MS);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await advance(INTERVAL * 3);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Every request asked for the night's own data.
      expect(new Set(datesRequested())).toEqual(new Set([m.night]));
    });

    it('starts polling a row dated the new day at the roll, with no parent re-render', async () => {
      vi.useFakeTimers();
      // The same start as above: one interval and 10 s before midnight.
      startBeforeMidnight(INTERVAL + POLL_LEAD_MS);
      // Dated tomorrow while it is still the night: a single fetch, and no
      // poll at the first interval, which a row treated as live would make.
      mount(m.morning);
      await advance(0);
      await advance(INTERVAL);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Through midnight to the roll (23:00:01 CT the evening before): ET is
      // on the new day, CT is not. The first poll of the live row is one
      // interval after the roll.
      await advance(POLL_LEAD_MS + ROLL_LAG_MS);
      const afterRoll = fetchMock.mock.calls.length;
      // No fetch at the roll itself: the row starts polling, it does not
      // refetch. (Without this, the line below reads as a repeat of the check
      // above.)
      expect(afterRoll).toBe(1);
      await advance(INTERVAL);

      expect(fetchMock.mock.calls.length).toBe(afterRoll + 1);
      expect(new Set(datesRequested())).toEqual(new Set([m.morning]));
    });

    it('polls a row dated the new ET day at 23:30 CT, when CT is still on the night', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(m.window));
      mount(m.morning);
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await advance(INTERVAL * 3);

      // A CT comparator calls the new day historical here and never polls.
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(new Set(datesRequested())).toEqual(new Set([m.morning]));
    });

    it('keeps a past-dated row historical across the roll', async () => {
      vi.useFakeTimers();
      startBeforeMidnight(INTERVAL + POLL_LEAD_MS);
      mount('2026-04-20');
      await advance(0);
      // Through midnight and the roll, then three more intervals.
      await advance(INTERVAL + POLL_LEAD_MS + ROLL_LAG_MS);
      await advance(INTERVAL * 3);

      expect(datesRequested()).toEqual(['2026-04-20']);
    });
  });
});
