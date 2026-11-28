// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import {
  InvalidDateParamError,
  resolveTargetDate,
} from '../_lib/cron-target-date.js';

const TODAY = '2026-04-22';

/** A stand-in for a cron's own default target, so a call is visible. */
function fallbackOf() {
  return vi.fn((today: string) => `fallback-of-${today}`);
}

describe('resolveTargetDate', () => {
  describe('a valid ?date=', () => {
    it.each([
      ['a past date', '2026-04-14'],
      ['yesterday, the newest date allowed', '2026-04-21'],
      // The lib checks the calendar, not the market: a weekend or holiday is
      // the cron's own skip, so it must come back unchanged.
      ['a weekend day', '2026-04-18'],
      ['a date in an earlier year', '2025-12-31'],
      ['a leap day', '2024-02-29'],
    ])('returns %s as given, without asking the fallback', (_label, date) => {
      const fallback = fallbackOf();

      expect(resolveTargetDate(date, TODAY, fallback, 'some-job')).toBe(date);
      expect(fallback).not.toHaveBeenCalled();
    });
  });

  describe('no ?date=', () => {
    it('returns the fallback, handed today', () => {
      const fallback = fallbackOf();

      expect(resolveTargetDate(undefined, TODAY, fallback, 'some-job')).toBe(
        'fallback-of-2026-04-22',
      );
      expect(fallback).toHaveBeenCalledOnce();
      expect(fallback).toHaveBeenCalledWith(TODAY);
    });
  });

  describe('a ?date= that is not a past calendar date', () => {
    it.each([
      ['a non-padded date', '2026-4-14'],
      ['an impossible calendar date', '2026-02-30'],
      ['a leap day in a common year', '2026-02-29'],
      ['garbage', 'yesterday'],
      ['a timestamp', '2026-04-14T00:00:00Z'],
      ['an empty string', ''],
      ['a repeated param', ['2026-04-14', '2026-04-13']],
      // String(['2026-04-14']) is a valid date, so only the type check
      // rejects this one.
      ['an array holding one date', ['2026-04-14']],
      ['a number', 20260414],
      ['null', null],
    ])('rejects %s as invalid, naming the format', (_label, date) => {
      const fallback = fallbackOf();
      const call = () => resolveTargetDate(date, TODAY, fallback, 'some-job');

      expect(call).toThrow(InvalidDateParamError);
      expect(call).toThrow(
        'some-job: invalid date param (expected YYYY-MM-DD)',
      );
      expect(fallback).not.toHaveBeenCalled();
    });

    it.each([
      ['today', '2026-04-22'],
      ['tomorrow', '2026-04-23'],
      ['a date years ahead', '2030-01-01'],
    ])('rejects %s as not before today, naming both dates', (_label, date) => {
      const fallback = fallbackOf();
      const call = () => resolveTargetDate(date, TODAY, fallback, 'some-job');

      expect(call).toThrow(InvalidDateParamError);
      expect(call).toThrow(
        `some-job: date ${date} is not before today (2026-04-22)`,
      );
      expect(fallback).not.toHaveBeenCalled();
    });
  });

  describe('InvalidDateParamError', () => {
    it('is named, so a wrapper can tell it from a failure after the target was chosen', () => {
      let caught: unknown;
      try {
        resolveTargetDate('nope', TODAY, fallbackOf(), 'some-job');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(InvalidDateParamError);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe('InvalidDateParamError');
    });

    it('carries the calling job in its message, so two crons never share a prefix', () => {
      expect(() =>
        resolveTargetDate('nope', TODAY, fallbackOf(), 'fetch-day-ohlc'),
      ).toThrow(/^fetch-day-ohlc: invalid date param/);
      expect(() =>
        resolveTargetDate('nope', TODAY, fallbackOf(), 'embed-yesterday'),
      ).toThrow(/^embed-yesterday: invalid date param/);
    });
  });
});
