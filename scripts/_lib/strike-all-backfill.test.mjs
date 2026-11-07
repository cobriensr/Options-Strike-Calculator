// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import {
  ATM_RANGE,
  MAX_PAGES,
  PAGE_SIZE,
  fiveMinuteBucket,
  newestRowTime,
  newestSpot,
  strikeWindow,
  walkLadderPages,
} from './strike-all-backfill.mjs';

const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ strike: `${i}` }));

describe('constants', () => {
  it('pin the window and the paging rule the cron uses', () => {
    expect(ATM_RANGE).toBe(200);
    expect(PAGE_SIZE).toBe(500);
    expect(MAX_PAGES).toBe(10);
  });
});

describe('strikeWindow', () => {
  it('is spot ± range, rounded outward', () => {
    expect(strikeWindow(5800.5, 200)).toEqual({
      minStrike: 5600,
      maxStrike: 6001,
    });
    expect(strikeWindow(5800, 200)).toEqual({
      minStrike: 5600,
      maxStrike: 6000,
    });
  });
});

describe('newestSpot', () => {
  it('returns the newest row by start_time ?? time, whatever the order', () => {
    expect(
      newestSpot([
        { price: '5801', time: '2026-10-22T19:55:00Z' },
        { price: '5790', time: '2026-10-22T14:30:00Z' },
        {
          price: '5805.25',
          start_time: '2026-10-22T20:00:00Z',
          time: '2026-10-22T13:00:00Z',
        },
      ]),
    ).toEqual({ price: 5805.25, time: '2026-10-22T20:00:00Z' });
  });

  it('is null for no rows, no parseable time, or a newest price that is not positive', () => {
    expect(newestSpot([])).toBeNull();
    expect(newestSpot([{ price: '5800', time: 'garbage' }])).toBeNull();
    expect(
      newestSpot([
        { price: '5700', time: '2026-10-22T14:00:00Z' },
        { price: 'NaN', time: '2026-10-22T15:00:00Z' },
      ]),
    ).toBeNull();
    expect(
      newestSpot([{ price: '0', time: '2026-10-22T15:00:00Z' }]),
    ).toBeNull();
    expect(
      newestSpot([{ price: '-1', time: '2026-10-22T15:00:00Z' }]),
    ).toBeNull();
  });
});

describe('newestRowTime and fiveMinuteBucket', () => {
  it('takes the latest parseable time, not the first row', () => {
    expect(
      newestRowTime([
        { time: '2026-10-22T20:01:00Z' },
        { time: 'garbage' },
        { time: '2026-10-22T20:04:30Z' },
      ]),
    ).toBe('2026-10-22T20:04:30.000Z');
    expect(newestRowTime([])).toBeNull();
    expect(newestRowTime([{ time: 'garbage' }])).toBeNull();
  });

  it('floors to the 5-minute bucket', () => {
    expect(fiveMinuteBucket('2026-10-22T20:04:59Z')).toBe(
      '2026-10-22T20:00:00.000Z',
    );
    expect(fiveMinuteBucket('2026-10-22T20:05:00Z')).toBe(
      '2026-10-22T20:05:00.000Z',
    );
  });
});

describe('walkLadderPages', () => {
  it('continues past a page of exactly PAGE_SIZE rows and stops on the short one', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(rowsOf(500))
      .mockResolvedValueOnce(rowsOf(38));

    const { rows, pages } = await walkLadderPages(fetchPage);

    expect(fetchPage.mock.calls.map(([p]) => p)).toEqual([0, 1]);
    expect(rows).toHaveLength(538);
    expect(pages).toBe(2);
  });

  it('stops after a short first page without asking for a second', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce(rowsOf(499));

    const { rows, pages } = await walkLadderPages(fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(499);
    expect(pages).toBe(1);
  });

  it('asks once more after exactly PAGE_SIZE rows and ends on the empty page', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(rowsOf(500))
      .mockResolvedValueOnce([]);

    const { rows, pages } = await walkLadderPages(fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(500);
    expect(pages).toBe(2);
  });

  it('throws when MAX_PAGES full pages come back, rather than return a cut-off ladder', async () => {
    const fetchPage = vi.fn().mockResolvedValue(rowsOf(500));

    await expect(walkLadderPages(fetchPage)).rejects.toThrow(/10 full pages/);
    expect(fetchPage).toHaveBeenCalledTimes(MAX_PAGES);
  });

  it('lets a page failure propagate with no partial result', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(rowsOf(500))
      .mockRejectedValueOnce(new Error('UW API 422'));

    await expect(walkLadderPages(fetchPage)).rejects.toThrow('UW API 422');
  });
});
