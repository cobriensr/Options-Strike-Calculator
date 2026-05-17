// @vitest-environment node

import { describe, it, expect } from 'vitest';

import {
  flowAtFireTime,
  type TickerFlowSeries,
} from '../_lib/ticker-flow-snapshot.js';

function series(
  rows: Array<{ ts: string; cumNcp: number; cumNpp: number }>,
): TickerFlowSeries {
  return {
    ts: rows.map((r) => Date.parse(r.ts)),
    cumNcp: rows.map((r) => r.cumNcp),
    cumNpp: rows.map((r) => r.cumNpp),
  };
}

describe('flowAtFireTime', () => {
  it('returns {null, null} on empty series', () => {
    const empty: TickerFlowSeries = { ts: [], cumNcp: [], cumNpp: [] };
    expect(flowAtFireTime(empty, new Date('2026-05-12T14:00:00Z'))).toEqual({
      cumNcp: null,
      cumNpp: null,
    });
  });

  it('returns {null, null} when fireTs precedes the earliest tick', () => {
    const s = series([
      { ts: '2026-05-12T14:00:00Z', cumNcp: 100, cumNpp: -50 },
      { ts: '2026-05-12T14:05:00Z', cumNcp: 200, cumNpp: -80 },
    ]);
    expect(flowAtFireTime(s, new Date('2026-05-12T13:59:59Z'))).toEqual({
      cumNcp: null,
      cumNpp: null,
    });
  });

  it('returns the exact-match tick', () => {
    const s = series([
      { ts: '2026-05-12T14:00:00Z', cumNcp: 100, cumNpp: -50 },
      { ts: '2026-05-12T14:05:00Z', cumNcp: 200, cumNpp: -80 },
      { ts: '2026-05-12T14:10:00Z', cumNcp: 350, cumNpp: -120 },
    ]);
    expect(flowAtFireTime(s, new Date('2026-05-12T14:05:00Z'))).toEqual({
      cumNcp: 200,
      cumNpp: -80,
    });
  });

  it('returns the largest tick at or before fireTs', () => {
    const s = series([
      { ts: '2026-05-12T14:00:00Z', cumNcp: 100, cumNpp: -50 },
      { ts: '2026-05-12T14:05:00Z', cumNcp: 200, cumNpp: -80 },
      { ts: '2026-05-12T14:10:00Z', cumNcp: 350, cumNpp: -120 },
    ]);
    expect(flowAtFireTime(s, new Date('2026-05-12T14:07:30Z'))).toEqual({
      cumNcp: 200,
      cumNpp: -80,
    });
  });

  it('returns the last tick when fireTs is past the series', () => {
    const s = series([
      { ts: '2026-05-12T14:00:00Z', cumNcp: 100, cumNpp: -50 },
      { ts: '2026-05-12T14:05:00Z', cumNcp: 200, cumNpp: -80 },
    ]);
    expect(flowAtFireTime(s, new Date('2026-05-12T21:00:00Z'))).toEqual({
      cumNcp: 200,
      cumNpp: -80,
    });
  });

  it('handles a single-row series', () => {
    const s = series([{ ts: '2026-05-12T14:00:00Z', cumNcp: 42, cumNpp: -7 }]);
    expect(flowAtFireTime(s, new Date('2026-05-12T14:00:00Z'))).toEqual({
      cumNcp: 42,
      cumNpp: -7,
    });
    expect(flowAtFireTime(s, new Date('2026-05-12T14:00:01Z'))).toEqual({
      cumNcp: 42,
      cumNpp: -7,
    });
    expect(flowAtFireTime(s, new Date('2026-05-12T13:59:59Z'))).toEqual({
      cumNcp: null,
      cumNpp: null,
    });
  });
});
