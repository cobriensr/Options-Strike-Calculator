// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { trimUrlEnds } from '../_lib/url-ends.js';

describe('trimUrlEnds', () => {
  it.each([
    ['nothing to trim', 'postgres://h/db', 'postgres://h/db'],
    ['one trailing line feed', 'postgres://h/db\n', 'postgres://h/db'],
    ['a trailing CR LF', 'postgres://h/db\r\n', 'postgres://h/db'],
    [
      'spaces, tabs and breaks at both ends',
      ' \t\r\npostgres://h/db\t \n',
      'postgres://h/db',
    ],
    ['only those four, in any order, at the front', '\n \t\rx', 'x'],
    ['an empty string', '', ''],
    ['a string of only those four', ' \t\r\n \t\r\n', ''],
  ])('trims %s', (_label, url, trimmed) => {
    expect(trimUrlEnds(url)).toBe(trimmed);
  });

  it.each([
    ['a NUL at the end', 'postgres://h/db\0'],
    ['a NUL at the start', '\0postgres://h/db'],
    ['a form feed at the end', 'postgres://h/db\f'],
    ['a vertical tab at the start', '\vpostgres://h/db'],
    [
      'a no-break space at the end',
      `postgres://h/db${String.fromCodePoint(0xa0)}`,
    ],
    ['a line feed inside', 'postgres://h\n/db'],
    ['a tab inside', 'postgres://h\t/db'],
  ])(
    'leaves %s alone: only a tab, LF, CR and space at the ends are trimmed',
    (_label, url) => {
      expect(trimUrlEnds(url)).toBe(url);
    },
  );

  it('is linear on a long run of the characters it trims', () => {
    const run = ' \t\r\n'.repeat(250_000);

    const started = performance.now();
    const trimmed = trimUrlEnds(`${run}postgres://h/db${run}`);

    expect(trimmed).toBe('postgres://h/db');
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
