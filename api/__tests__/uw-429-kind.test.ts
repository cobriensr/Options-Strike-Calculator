// @vitest-environment node

/**
 * `uw429Kind` sorts a UW 429 message into the sub-type that sentry.ts puts in
 * the fingerprint. The bodies below are UW's: the older concurrency body is
 * the one the retry tests use, and the "in flight" body is the one on Sentry
 * issues SENTRY-EMERALD-DESERT-7Y and G6 (117,559 and 2,765 events, read with
 * `sentry issue view` on 2026-11-14), cut at the 200 characters `uwFetch` keeps.
 */

import { describe, it, expect } from 'vitest';
import {
  UW_CONCURRENT_BODY,
  UW_PER_MINUTE_BODY,
  uw429Kind,
} from '../_lib/uw-429-kind.js';

const IN_FLIGHT_BODY =
  'UW API 429: {"error":"Too many requests in flight. Your account can have 3 API requests running at a time across all of its API tokens, and at least 3 were already running when this one arrived. This is a tempora';

describe('uw429Kind', () => {
  it.each([
    [
      'the older "3 concurrent requests" body',
      'UW API 429: {"error":"You have exceeded 3 concurrent requests"}',
    ],
    ['the "too many requests in flight" body on 7Y and G6', IN_FLIGHT_BODY],
    ['a mixed-case match', 'UW API 429: TOO MANY REQUESTS IN FLIGHT'],
  ])('calls %s a concurrency 429', (_label, message) => {
    expect(uw429Kind(message)).toBe('concurrency');
  });

  it.each([
    [
      'the "rate limit of 120 in 60 seconds" body',
      'UW API 429: {"error":"You have hit the rate limit of 120 in 60 seconds"}',
    ],
    ['a "per minute" body', 'UW API 429: limit is 120 requests per minute'],
  ])('calls %s a per-minute 429', (_label, message) => {
    expect(uw429Kind(message)).toBe('per-minute');
  });

  it.each([
    ['an empty body', 'UW API 429: '],
    ['a bare "Too Many Requests"', 'UW API 429: Too Many Requests'],
    [
      'a daily-limit body',
      'UW API 429: {"error":"You have exceeded your daily limit"}',
    ],
  ])('calls %s other', (_label, message) => {
    expect(uw429Kind(message)).toBe('other');
  });

  it('calls a body that names both limits a concurrency 429', () => {
    // The order withRetry has always tested them in: concurrency first.
    expect(
      uw429Kind('UW API 429: 3 concurrent requests, 120 in 60 seconds'),
    ).toBe('concurrency');
  });

  it('exports the two body patterns the retry delay tests', () => {
    // withRetry's backoff uses these same patterns, not copies.
    expect(UW_CONCURRENT_BODY.test('3 concurrent requests')).toBe(true);
    expect(UW_PER_MINUTE_BODY.test('120 in 60 seconds')).toBe(true);
  });
});
