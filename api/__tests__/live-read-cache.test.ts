// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelResponse } from '@vercel/node';

const { mockSetCacheHeaders } = vi.hoisted(() => ({
  mockSetCacheHeaders: vi.fn(),
}));

// Mock at the module the helper imports from, so the test sees the exact
// arguments it passes and no real header is written.
vi.mock('../_lib/api-helpers.js', () => ({
  setCacheHeaders: mockSetCacheHeaders,
}));

// A passthrough: the real conversion runs, and a test can make it answer
// null for one call (the failure path the helper guards against).
vi.mock('../../src/utils/timezone.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/utils/timezone.js')>();
  return {
    ...actual,
    etWallClockToUtcIso: vi.fn(actual.etWallClockToUtcIso),
  };
});

import {
  closedCacheSeconds,
  setClosedReadCache,
  setLiveReadCache,
} from '../_lib/live-read-cache.js';
import { etWallClockToUtcIso } from '../../src/utils/timezone.js';

const res = {} as VercelResponse;

beforeEach(() => {
  mockSetCacheHeaders.mockReset();
  // Back to the real conversion, and drop any once-answer a test left queued.
  vi.mocked(etWallClockToUtcIso).mockReset();
});

describe('setLiveReadCache', () => {
  // A live read that carries data, or any live read during the session, is
  // cached 10 s at the edge with no stale reuse. A historical read (a past
  // minute never changes) and a live no-data read outside the session keep
  // 300 s + 60 s. All eight combinations, grouped by the four outcomes.
  const LIVE_SHORT: [number, number] = [10, 0];
  const LONG: [number, number] = [300, 60];

  it.each([
    ['live, data, in session', false, true, true, LIVE_SHORT],
    ['live, data, pre-open or closed', false, true, false, LIVE_SHORT],
    ['live, no data, in session', false, false, true, LIVE_SHORT],
    ['live, no data, closed', false, false, false, LONG],
    ['historical, data, in session', true, true, true, LONG],
    ['historical, data, closed', true, true, false, LONG],
    ['historical, no data, in session', true, false, true, LONG],
    ['historical, no data, closed', true, false, false, LONG],
  ] as const)(
    '%s',
    (_label, historical, hasData, marketOpen, [edgeSec, swrSec]) => {
      setLiveReadCache(res, { historical, hasData, marketOpen });
      expect(mockSetCacheHeaders).toHaveBeenCalledTimes(1);
      expect(mockSetCacheHeaders).toHaveBeenCalledWith(res, edgeSec, swrSec);
    },
  );
});

describe('closedCacheSeconds', () => {
  // The whole cache life, s-maxage plus stale-while-revalidate, must end
  // before close + 3 min on a trading day (the client's final fetch) and
  // before the next 09:30 ET wall clock, on any calendar day.
  it.each([
    // The close window: close <= now < close + 3 min, on a trading day only.
    ['2026-11-20T21:01:30Z', 0, 0], // Fri 16:01:30 ET, inside close..close+3
    ['2026-11-20T21:03:00Z', 300, 60], // Fri 16:03:00 ET
    ['2026-11-27T18:02:00Z', 0, 0], // half day 13:02 ET
    ['2026-11-26T21:02:00Z', 300, 60], // Thanksgiving: no close window
    ['2026-11-21T21:01:00Z', 300, 60], // Saturday 16:01 ET: no close window
    // Less than a cache life from the open: the open caps it.
    ['2026-11-23T14:24:00Z', 300, 60], // Mon 09:24 ET, 360 s to open
    ['2026-11-23T14:25:00Z', 300, 0], // 300 s to open
    ['2026-11-23T14:28:00Z', 120, 0], // 120 s to open
    ['2026-11-02T14:25:00Z', 300, 0], // the Monday after DST ends: 09:25 EST
  ])('closedCacheSeconds(%s) = %i / %i', (iso, edge, swr) => {
    expect(closedCacheSeconds(new Date(iso))).toEqual({ edgeSec: edge, swr });
  });

  // The edges of each window, to the millisecond.
  it.each([
    // The close window runs from the close instant, inclusive. (1 ms before it
    // is in session, which caches nothing either: see the open race below.)
    ['2026-11-20T21:00:00.000Z', 0, 0], // the close instant
    // Close window end is exclusive.
    ['2026-11-20T21:02:59.999Z', 0, 0], // 1 ms before close + 3 min
    // The half day closes at 13:00 ET, and its window follows.
    ['2026-11-27T18:00:00.000Z', 0, 0],
    ['2026-11-27T18:02:59.999Z', 0, 0],
    ['2026-11-27T18:03:00.000Z', 300, 60], // 13:03 ET, the final fetch
    // A holiday has no close window, even the day before a half day.
    ['2026-11-26T18:01:00Z', 300, 60], // Thanksgiving 13:01 ET
    // The open is the next 09:30 on ANY calendar day, a weekend included.
    ['2026-11-01T14:29:00Z', 60, 0], // Sun 09:29 EST, the day DST ended
    ['2027-03-14T13:29:00Z', 60, 0], // Sun 09:29 EDT, the day DST began
    ['2027-03-15T13:25:00Z', 300, 0], // Mon 09:25 EDT, the day after
    // Whole seconds to the open, rounded down.
    ['2026-11-23T14:24:01Z', 300, 59], // 359 s to open
    ['2026-11-23T14:29:59.500Z', 0, 0], // 0.5 s to open
    // Off a trading day the open has no session behind it: at 09:30 on a
    // weekend or a holiday the next open is tomorrow's, and the life is full.
    ['2026-11-21T14:30:00.000Z', 300, 60], // Saturday 09:30 ET
    ['2026-11-26T15:00:00.000Z', 300, 60], // Thanksgiving 10:00 ET
  ])('edge: closedCacheSeconds(%s) = %i / %i', (iso, edge, swr) => {
    expect(closedCacheSeconds(new Date(iso))).toEqual({ edgeSec: edge, swr });
  });

  // The in-session guard. A handler takes `now` before `isMarketOpen()` and
  // before its reads, and `isMarketOpen()` reads its own clock a moment later.
  // A `now` inside the session that the handler still decided was closed is
  // possible (15:59:59.999 against an `isMarketOpen()` read at 16:00). A closed
  // response must not be cached there: it would answer live polls from the
  // edge for up to 360 s. Nothing is cached from the cash open to the close on
  // a trading day, the half day's 13:00 close included.
  it.each([
    ['2026-11-23T14:30:00.000Z', 0, 0], // the open instant
    ['2026-11-23T14:30:00.001Z', 0, 0], // 1 ms into the session
    ['2026-11-23T17:00:00Z', 0, 0], // mid-session
    ['2026-11-20T20:59:59.999Z', 0, 0], // 1 ms before the Friday close
    ['2026-11-27T17:59:59.999Z', 0, 0], // 1 ms before the half day's close
    ['2026-11-27T14:30:00.001Z', 0, 0], // the half day, 1 ms into the session
    ['2027-03-15T13:30:00.001Z', 0, 0], // Mon 09:30:00.001 EDT
  ])('open race: closedCacheSeconds(%s) = %i / %i', (iso, edge, swr) => {
    expect(closedCacheSeconds(new Date(iso))).toEqual({ edgeSec: edge, swr });
  });

  // The ET date always converts, so a null from the conversion cannot happen
  // in practice. If it does, the helper caches nothing rather than computing
  // a NaN life: each of the three conversions a Friday evening call makes is
  // nulled in turn. The test leans on the order `closedCacheSeconds` converts
  // in: the close (call 1), today's open (call 2), then tomorrow's open
  // (call 3). Reorder the helper and these rows null a different instant. The
  // instant is after the close window, so all three conversions run: earlier,
  // the close window or the open race returns before the third.
  it.each([1, 2, 3])(
    'caches nothing when conversion call %i has no instant',
    async (nulled) => {
      const real = await vi.importActual<
        typeof import('../../src/utils/timezone.js')
      >('../../src/utils/timezone.js');
      for (let call = 1; call <= 3; call++) {
        vi.mocked(etWallClockToUtcIso).mockImplementationOnce(
          call === nulled ? () => null : real.etWallClockToUtcIso,
        );
      }
      // Fri 17:00 ET: past the close window, and tomorrow's open is Saturday's.
      expect(closedCacheSeconds(new Date('2026-11-20T22:00:00Z'))).toEqual({
        edgeSec: 0,
        swr: 0,
      });
      // It stopped at the conversion that answered null.
      expect(etWallClockToUtcIso).toHaveBeenCalledTimes(nulled);
    },
  );
});

describe('setClosedReadCache', () => {
  it('sends the computed pair', () => {
    setClosedReadCache(res, new Date('2026-11-20T21:01:30Z'));
    expect(mockSetCacheHeaders).toHaveBeenCalledTimes(1);
    expect(mockSetCacheHeaders).toHaveBeenCalledWith(res, 0, 0);
  });

  it('sends a cached pair outside the close window', () => {
    setClosedReadCache(res, new Date('2026-11-23T14:28:00Z'));
    expect(mockSetCacheHeaders).toHaveBeenCalledWith(res, 120, 0);
  });

  it('sends nothing cacheable for a closed response answered in the session', () => {
    setClosedReadCache(res, new Date('2026-11-23T14:30:00.001Z'));
    expect(mockSetCacheHeaders).toHaveBeenCalledTimes(1);
    expect(mockSetCacheHeaders).toHaveBeenCalledWith(res, 0, 0);
  });
});
