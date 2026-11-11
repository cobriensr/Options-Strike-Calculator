// @vitest-environment node

/**
 * Unit tests for the D1 scope (Phase 5 of the contract-mix repair): which
 * RTY, CL, GC and ZN bars the delete takes. Both tools read it from here, so
 * the boundaries are pinned once.
 */

import { describe, expect, it } from 'vitest';
import {
  CLEAN_TRADING_DAYS,
  THIN_LAST_BAD_MS,
  THIN_ROOTS,
  THIN_WINDOW_START_MS,
  ctTradingDay,
  inThinWindow,
  isThinDeleteBar,
  isThinRoot,
} from './futures-thin-roots.js';

const ms = (iso: string): number => Date.parse(iso);

describe('ctTradingDay', () => {
  it.each([
    // The Globex session that opens at 17:00 CT belongs to the next calendar day.
    ['2026-04-05T22:00:00Z', '2026-04-06'], // Sun 17:00 CDT
    ['2026-04-12T21:59:00Z', '2026-04-12'], // Sun 16:59 CDT
    ['2026-04-12T22:00:00Z', '2026-04-13'], // Sun 17:00 CDT
    ['2026-04-13T21:59:00Z', '2026-04-13'], // Mon 16:59 CDT
    ['2026-04-13T22:00:00Z', '2026-04-14'], // Mon 17:00 CDT
    ['2026-06-15T14:10:00Z', '2026-06-15'], // Mon 09:10 CDT
  ])('%s is trading day %s', (iso, day) => {
    expect(ctTradingDay(ms(iso))).toBe(day);
  });
});

describe('the D1 constants', () => {
  it('names the four roots without a rebuild source', () => {
    expect([...THIN_ROOTS]).toEqual(['RTY', 'CL', 'GC', 'ZN']);
    expect(isThinRoot('GC')).toBe(true);
    expect(isThinRoot('ES')).toBe(false);
    expect(isThinRoot('NQ')).toBe(false);
  });

  it('keeps the seven clean days the Phase 1 detector found', () => {
    expect([...CLEAN_TRADING_DAYS]).toEqual([
      '2026-04-13',
      '2026-04-14',
      '2026-04-15',
      '2026-04-16',
      '2026-04-17',
      '2026-06-01',
      '2026-06-08',
    ]);
  });

  it('starts the window at the first bad evening and ends each root at its last bad bar', () => {
    expect(THIN_WINDOW_START_MS).toBe(ms('2026-04-05T22:00:00Z'));
    expect(THIN_LAST_BAD_MS).toEqual({
      RTY: ms('2026-06-15T14:10:00Z'),
      CL: ms('2026-06-15T14:10:00Z'),
      GC: ms('2026-06-15T14:10:00Z'),
      ZN: ms('2026-06-15T14:11:00Z'),
    });
  });
});

describe('inThinWindow', () => {
  it.each(THIN_ROOTS)('%s: 21:59Z on 04-05 is out and 22:00Z is in', (root) => {
    expect(inThinWindow(root, ms('2026-04-05T21:59:00Z'))).toBe(false);
    expect(inThinWindow(root, ms('2026-04-05T22:00:00Z'))).toBe(true);
  });

  it.each([
    ['RTY', '14:10', '14:11'],
    ['CL', '14:10', '14:11'],
    ['GC', '14:10', '14:11'],
    ['ZN', '14:11', '14:12'],
  ] as const)(
    '%s: %sZ on 06-15 is the last bar in, %sZ is out',
    (root, last, after) => {
      expect(inThinWindow(root, ms(`2026-06-15T${last}:00Z`))).toBe(true);
      expect(inThinWindow(root, ms(`2026-06-15T${after}:00Z`))).toBe(false);
    },
  );
});

describe('isThinDeleteBar', () => {
  it('deletes a window bar on an ordinary day', () => {
    expect(isThinDeleteBar('CL', ms('2026-05-05T15:00:00Z'))).toBe(true);
  });

  it.each([
    '2026-04-12T22:00:00Z', // first bar of trading day 04-13
    '2026-04-13T14:00:00Z',
    '2026-04-17T21:59:00Z', // last bar of trading day 04-17
    '2026-05-31T22:00:00Z', // first bar of trading day 06-01
    '2026-06-01T21:59:00Z',
    '2026-06-07T22:00:00Z', // first bar of trading day 06-08
    '2026-06-08T21:59:00Z',
  ])('keeps %s on a clean day', (iso) => {
    expect(isThinDeleteBar('RTY', ms(iso))).toBe(false);
  });

  it.each([
    '2026-04-12T21:59:00Z', // trading day 04-12, just before the clean block
    '2026-04-17T22:00:00Z', // trading day 04-18, just after it
    '2026-05-31T21:59:00Z', // trading day 05-31
    '2026-06-01T22:00:00Z', // trading day 06-02
    '2026-06-08T22:00:00Z', // trading day 06-09
  ])('deletes %s, one minute outside a clean day', (iso) => {
    expect(isThinDeleteBar('GC', ms(iso))).toBe(true);
  });

  it('keeps a bar outside the window, clean day or not', () => {
    expect(isThinDeleteBar('ZN', ms('2026-04-05T21:59:00Z'))).toBe(false);
    expect(isThinDeleteBar('ZN', ms('2026-06-15T14:12:00Z'))).toBe(false);
    expect(isThinDeleteBar('CL', ms('2026-06-15T14:11:00Z'))).toBe(false);
    expect(isThinDeleteBar('ZN', ms('2026-06-15T14:11:00Z'))).toBe(true);
  });
});
