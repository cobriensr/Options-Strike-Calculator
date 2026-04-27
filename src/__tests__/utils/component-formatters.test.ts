import { describe, it, expect } from 'vitest';
import { formatTimeCT, formatDeltaPct } from '../../utils/component-formatters';

// Match any whitespace separator the host ICU might insert between the
// time and meridiem (regular space, U+00A0 NBSP, or U+202F narrow NBSP).
const TIME_SEP = '[\\s\\u00A0\\u202F]?';

describe('formatTimeCT', () => {
  it('formats an ISO as Central Time wall-clock', () => {
    // 2026-04-17 19:45 UTC -> 2:45 PM CDT
    const out = formatTimeCT('2026-04-17T19:45:00Z');
    expect(out).toMatch(new RegExp(`^2:45${TIME_SEP}PM$`));
  });

  it('formats correctly across DST (CST winter)', () => {
    // 2026-01-15 19:45 UTC -> 1:45 PM CST (UTC-6)
    const out = formatTimeCT('2026-01-15T19:45:00Z');
    expect(out).toMatch(new RegExp(`^1:45${TIME_SEP}PM$`));
  });

  it('returns fallback for null/undefined/empty', () => {
    expect(formatTimeCT(null)).toBe('');
    expect(formatTimeCT(undefined)).toBe('');
    expect(formatTimeCT('')).toBe('');
  });

  it('returns fallback for unparseable input', () => {
    expect(formatTimeCT('not-a-date')).toBe('');
  });

  it('respects custom fallback', () => {
    expect(formatTimeCT(null, { fallback: '—' })).toBe('—');
    expect(formatTimeCT('garbage', { fallback: 'n/a' })).toBe('n/a');
  });
});

describe('formatDeltaPct', () => {
  it('formats positive deltas with explicit + sign', () => {
    expect(formatDeltaPct(0.045)).toBe('+4.5%');
    expect(formatDeltaPct(0.1234)).toBe('+12.3%');
  });

  it('formats negative deltas without an extra + sign', () => {
    expect(formatDeltaPct(-0.045)).toBe('-4.5%');
  });

  it('treats zero as positive (renders +0.0%)', () => {
    expect(formatDeltaPct(0)).toBe('+0.0%');
  });

  it('returns em-dash fallback for null/undefined/NaN/Infinity', () => {
    expect(formatDeltaPct(null)).toBe('—');
    expect(formatDeltaPct(undefined)).toBe('—');
    expect(formatDeltaPct(Number.NaN)).toBe('—');
    expect(formatDeltaPct(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('respects custom digits', () => {
    expect(formatDeltaPct(0.0456, { digits: 2 })).toBe('+4.56%');
    expect(formatDeltaPct(0.045, { digits: 0 })).toBe('+5%');
  });

  it('respects custom fallback', () => {
    expect(formatDeltaPct(null, { fallback: 'n/a' })).toBe('n/a');
  });
});
