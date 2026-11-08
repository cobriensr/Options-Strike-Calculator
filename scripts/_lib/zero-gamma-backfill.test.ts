// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { guardDate, parseArgs } from './zero-gamma-backfill.js';

describe('parseArgs', () => {
  it('defaults to 30 days and no override', () => {
    expect(parseArgs([])).toEqual({ days: 30, allowExisting: false });
  });

  it('takes the old positional DAYS', () => {
    expect(parseArgs(['5'])).toEqual({ days: 5, allowExisting: false });
  });

  it('takes --allow-existing before or after DAYS', () => {
    expect(parseArgs(['--allow-existing'])).toEqual({
      days: 30,
      allowExisting: true,
    });
    expect(parseArgs(['7', '--allow-existing'])).toEqual({
      days: 7,
      allowExisting: true,
    });
    expect(parseArgs(['--allow-existing', '7'])).toEqual({
      days: 7,
      allowExisting: true,
    });
  });

  it.each([
    [['--apply'], /Unknown argument: --apply/],
    [['abc'], /DAYS must be a whole number/],
    [['0'], /DAYS must be a whole number/],
    [['2.5'], /DAYS must be a whole number/],
    [['5', '6'], /DAYS given twice/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe('guardDate', () => {
  it('writes a date with no rows of the old kind', () => {
    expect(guardDate(0, false)).toEqual({ write: true });
  });

  it('skips a date that has rows this run would not write, and says why and how to override', () => {
    const guard = guardDate(78, false);
    expect(guard.write).toBe(false);
    if (guard.write) return;
    expect(guard.reason).toContain('78 existing rows');
    expect(guard.reason).toContain('--allow-existing');
    expect(guard.reason).toContain('compute time');
  });

  it('says "row", not "rows", for one', () => {
    const guard = guardDate(1, false);
    if (guard.write) throw new Error('expected a skip');
    expect(guard.reason).toContain('1 existing row with');
  });

  it('writes anyway when --allow-existing is set', () => {
    expect(guardDate(78, true)).toEqual({ write: true });
  });
});
