// @vitest-environment node

/**
 * `dbHost` names the database host in the first line a script prints, before
 * any query has run, so it works from the raw DATABASE_URL and must never print
 * the user or any part of the password. A URL with an `@`, or a `/`, `?` or `#`,
 * in the wrong place parses so that the user or part of the password lands in
 * the "host" (`postgres://owner:12/34@host/db` gives the host `owner`), so the
 * parsed host is trusted only when it is exactly what follows the last `@`.
 */

import { describe, expect, it } from 'vitest';

import { dbHost, readableUrl } from './db-host.js';

const UNREADABLE = '(DATABASE_URL not readable)';

describe('dbHost', () => {
  it.each([
    [
      'a Neon URL with query parameters',
      'postgresql://owner:s3cret@ep-plan-123.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
      'ep-plan-123.us-east-2.aws.neon.tech',
    ],
    [
      'a port',
      'postgres://owner:pw@ep-plan.neon.tech:5432/neondb',
      'ep-plan.neon.tech',
    ],
    [
      'a mixed-case host, left as it is',
      'postgres://owner:pw@EP-Plan.Neon.Tech/neondb',
      'EP-Plan.Neon.Tech',
    ],
    ['an IPv6 host', 'postgres://owner:pw@[::1]:5432/neondb', '[::1]'],
    [
      'an @ in the password, the host after the last one',
      'postgres://owner:p@ss@ep-plan.neon.tech/neondb',
      'ep-plan.neon.tech',
    ],
    [
      'a percent-encoded password',
      'postgres://owner:p%40ss@ep-plan.neon.tech/neondb',
      'ep-plan.neon.tech',
    ],
    [
      'a user and no password',
      'postgres://owner@ep-plan.neon.tech/neondb',
      'ep-plan.neon.tech',
    ],
    [
      'a password and no user',
      'postgres://:pw@ep-plan.neon.tech/neondb',
      'ep-plan.neon.tech',
    ],
    [
      'no credentials at all',
      'postgres://ep-plan.neon.tech/neondb',
      'ep-plan.neon.tech',
    ],
    [
      'text after the database name (the host is still the host, and only it is printed)',
      'postgres://owner:pw@ep-plan.neon.tech/neondb;password=x',
      'ep-plan.neon.tech',
    ],
  ])('gives the host, and only it, for %s', (_label, url, host) => {
    const result = dbHost(url);

    expect(result).toBe(host);
    expect(result).not.toMatch(/owner|s3cret|pw|p@ss|%40|password/);
  });

  it.each([
    [
      'a slash after a numeric password prefix',
      'postgres://owner:12/34@ep-plan.neon.tech/neondb',
      ['owner', '12', '34'],
    ],
    [
      'an @ in the password, then a slash',
      'postgres://owner:p@ss/34@ep-plan.neon.tech/neondb',
      ['owner', 'ss', '34'],
    ],
    [
      'an @ in the password, then a question mark',
      'postgres://owner:p@ss?34@ep-plan.neon.tech/neondb',
      ['owner', 'ss', '34'],
    ],
    [
      'an @ in the password, then a hash',
      'postgres://owner:p@ss#34@ep-plan.neon.tech/neondb',
      ['owner', 'ss', '34'],
    ],
    [
      'an @ in the user',
      'postgres://ow@ner/34@ep-plan.neon.tech/neondb',
      ['ow', 'ner', '34'],
    ],
    [
      'an @ after the database name',
      'postgres://owner:pw@ep-plan.neon.tech/neondb@x',
      ['owner', 'pw', '@x'],
    ],
    [
      'an @ in a query parameter, which the last-@ rule cannot place',
      'postgres://owner:pw@ep-plan.neon.tech/neondb?options=a@b',
      ['owner', 'pw'],
    ],
    ['no host after the scheme', 'postgres:owner:pw/neondb', ['owner', 'pw']],
    [
      'a host the parser lower-cases, since nothing is case-folded to match it',
      'https://owner:pw@EP-Plan.Neon.Tech/neondb',
      ['owner', 'pw'],
    ],
  ])(
    'gives the placeholder, none of the user or password, for %s',
    (_label, url, tokens) => {
      const result = dbHost(url);

      expect(result).toBe(UNREADABLE);
      for (const token of tokens) expect(result).not.toContain(token);
    },
  );

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['not a URL', 'not a url'],
  ])('gives the placeholder when DATABASE_URL is %s', (_label, url) => {
    expect(dbHost(url)).toBe(UNREADABLE);
  });
});

/**
 * `readableUrl` is the predicate `dbHost` and the stale-range tool's
 * `databaseOf` share: the parsed URL, when its host is what the raw string
 * says it is, else null. `dbHost` and `databaseOf` read the host and the path
 * from what it returns, so what they print can never disagree with each other
 * about which URLs are readable.
 */
describe('readableUrl', () => {
  it.each([
    [
      'postgresql://owner:s3cret@ep-plan-123.us-east-2.aws.neon.tech/neondb?sslmode=require',
      'ep-plan-123.us-east-2.aws.neon.tech',
      '/neondb',
    ],
    [
      'postgres://owner:p@ss@ep-plan.neon.tech/neondb',
      'ep-plan.neon.tech',
      '/neondb',
    ],
    ['postgres://ep-plan.neon.tech/neondb', 'ep-plan.neon.tech', '/neondb'],
    [
      'postgres://owner:pw@ep-plan.neon.tech/neondb;password=x',
      'ep-plan.neon.tech',
      '/neondb;password=x',
    ],
  ])('gives the parsed URL of %s', (url, hostname, pathname) => {
    const parsed = readableUrl(url);

    expect(parsed?.hostname).toBe(hostname);
    expect(parsed?.pathname).toBe(pathname);
  });

  it.each([
    undefined,
    '',
    'not a url',
    'postgres:owner:pw/neondb',
    'postgres://owner:12/34@ep-plan.neon.tech/neondb',
    'postgres://owner:p@ss/34@ep-plan.neon.tech/neondb',
    'postgres://owner:p@ss?34@ep-plan.neon.tech/neondb',
    'postgres://owner:p@ss#34@ep-plan.neon.tech/neondb',
    'postgres://ow@ner/34@ep-plan.neon.tech/neondb',
    'postgres://owner:pw@ep-plan.neon.tech/neondb@x',
    'https://owner:pw@EP-Plan.Neon.Tech/neondb',
  ])('gives null for %j', (url) => {
    expect(readableUrl(url)).toBeNull();
  });
});
