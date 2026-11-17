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
 * roll. Cases start 30 s before an ET midnight (or, for the CT window, at
 * 23:30 CT); the clock's timer is armed for 1 s past midnight, so 31 s lands
 * just after, which is 23:00:31 CT the evening before. No case calls
 * `rerender`. (A row's own fetch result does re-render it, so the case that
 * stops polling is timed to put a poll after the roll: a row that only reads
 * the wall clock on a render would still make that one poll.) Owner decision
 * 2026-11-14.
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

describe.each([
  {
    zone: 'EST (winter)',
    start: '2026-11-10T04:59:30Z',
    // 23:30 CT the evening before, ET already on the new day.
    window: '2026-11-10T05:30:00Z',
    night: '2026-11-09',
    morning: '2026-11-10',
  },
  {
    zone: 'EDT (summer)',
    start: '2026-07-15T03:59:30Z',
    window: '2026-07-15T04:30:00Z',
    night: '2026-07-14',
    morning: '2026-07-15',
  },
])('row hooks across the $zone midnight', (m) => {
  describe.each(HOOKS)('$name', ({ mount }) => {
    it('stops polling the night once it is yesterday, with no parent re-render', async () => {
      vi.useFakeTimers();
      // 40 s before midnight, so the polls fall 10 s before it (30 s) and 20 s
      // after it (60 s), the roll at 41 s in between. A poll's own result
      // re-renders the row, which would read a wall-clock "today" too late by
      // one poll; only a row that rolled at 41 s skips the poll at 60 s.
      vi.setSystemTime(new Date(Date.parse(m.start) - 10_000));
      mount(m.night);
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await advance(POLL_INTERVALS.OTM_FLOW);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Midnight at 40 s, the roll at 41 s, the poll that would be at 60 s.
      await advance(31_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await advance(POLL_INTERVALS.OTM_FLOW * 3);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Every request asked for the night's own data.
      expect(new Set(datesRequested())).toEqual(new Set([m.night]));
    });

    it('starts polling a row dated the new day at the roll, with no parent re-render', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(m.start));
      // Dated tomorrow while it is still the night: a single fetch.
      mount(m.morning);
      await advance(0);
      await advance(POLL_INTERVALS.OTM_FLOW);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // 23:00:31 CT the evening before: ET is on the new day, CT is not.
      await advance(31_000);
      const afterRoll = fetchMock.mock.calls.length;
      await advance(POLL_INTERVALS.OTM_FLOW);

      expect(fetchMock.mock.calls.length).toBe(afterRoll + 1);
      expect(new Set(datesRequested())).toEqual(new Set([m.morning]));
    });

    it('polls a row dated the new ET day at 23:30 CT, when CT is still on the night', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(m.window));
      mount(m.morning);
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await advance(POLL_INTERVALS.OTM_FLOW * 3);

      // A CT comparator calls the new day historical here and never polls.
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(new Set(datesRequested())).toEqual(new Set([m.morning]));
    });

    it('keeps a past-dated row historical across the roll', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(m.start));
      mount('2026-04-20');
      await advance(0);
      await advance(31_000);
      await advance(POLL_INTERVALS.OTM_FLOW * 3);

      expect(datesRequested()).toEqual(['2026-04-20']);
    });
  });
});
