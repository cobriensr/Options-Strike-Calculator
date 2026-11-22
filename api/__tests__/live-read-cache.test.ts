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

import { setLiveReadCache } from '../_lib/live-read-cache.js';

const res = {} as VercelResponse;

beforeEach(() => {
  mockSetCacheHeaders.mockReset();
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
