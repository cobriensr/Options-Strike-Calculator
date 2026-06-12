import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseDow } from '../../utils/time';

describe('parseDow', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // 2026-03-16 is Monday, 2026-03-17 is Tuesday, ... 2026-03-20 is Friday
  it('returns 0 for Monday', () => {
    expect(parseDow('2026-03-16')).toBe(0);
  });

  it('returns 1 for Tuesday', () => {
    expect(parseDow('2026-03-17')).toBe(1);
  });

  it('returns 2 for Wednesday', () => {
    expect(parseDow('2026-03-18')).toBe(2);
  });

  it('returns 3 for Thursday', () => {
    expect(parseDow('2026-03-19')).toBe(3);
  });

  it('returns 4 for Friday', () => {
    expect(parseDow('2026-03-20')).toBe(4);
  });

  it('returns null for Saturday', () => {
    // 2026-03-21 is Saturday
    expect(parseDow('2026-03-21')).toBeNull();
  });

  it('returns null for Sunday', () => {
    // 2026-03-22 is Sunday
    expect(parseDow('2026-03-22')).toBeNull();
  });

  it("returns today's dow when no argument is provided (weekday)", () => {
    // Fake Wednesday 2026-03-18 at noon ET (17:00 UTC during EDT)
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-18T17:00:00Z'));
    expect(parseDow()).toBe(2); // Wednesday = 2
  });

  it('returns null when no argument is provided and today is Saturday', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T17:00:00Z')); // Saturday in ET
    expect(parseDow()).toBeNull();
  });

  it('returns null when no argument is provided and today is Sunday', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-22T17:00:00Z')); // Sunday in ET
    expect(parseDow()).toBeNull();
  });

  it("handles invalid date strings by falling through to today's date", () => {
    // parseDow with a string that doesn't split into 3 parts
    // falls through to the no-argument branch
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-18T17:00:00Z')); // Wednesday
    expect(parseDow('not-a-valid-date')).toBe(2);
  });

  it("handles empty string by falling through to today's date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-19T17:00:00Z')); // Thursday
    // empty string is falsy, so skips the `if (selectedDate)` branch entirely
    expect(parseDow('')).toBe(3);
  });

  // ── ET-anchored no-arg fallback (AUD-L10) ────────────────────────────
  // The no-arg branch must derive "today" in Eastern Time, not in the host
  // machine's local timezone. These cases pick UTC instants where the ET
  // calendar day differs from the UTC calendar day, so a host-local or UTC
  // implementation would return a different (wrong) weekday.
  it('uses ET day, not UTC day, when UTC has already rolled to the next day', () => {
    vi.useFakeTimers();
    // 2026-03-17T02:30:00Z is Tuesday in UTC, but 22:30 ET on Monday
    // 2026-03-16 (EDT, UTC-4). ET-correct answer is Monday = 0.
    vi.setSystemTime(new Date('2026-03-17T02:30:00Z'));
    expect(parseDow()).toBe(0);
  });

  it('uses ET day for a Sunday-evening instant that is Monday in UTC', () => {
    vi.useFakeTimers();
    // 2026-03-23T02:00:00Z is Monday in UTC, but 22:00 ET on Sunday
    // 2026-03-22 (EDT). ET-correct answer is Sunday → null (weekend).
    vi.setSystemTime(new Date('2026-03-23T02:00:00Z'));
    expect(parseDow()).toBeNull();
  });
});
