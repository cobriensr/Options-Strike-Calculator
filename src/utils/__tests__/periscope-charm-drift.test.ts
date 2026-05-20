/**
 * Unit tests for computeCharmDriftRead.
 *
 * Covers the three output lines (position / drift / weight) across the
 * spot-vs-zero geometry, the noise threshold, the post-close branch,
 * and every time-of-day weight bucket.
 *
 * Timestamps below were validated against America/Chicago via Intl
 * before writing — see commit message for the mapping table:
 *   13:00Z → 08:00 CT (pre-market)
 *   14:30Z → 09:30 CT (morning)
 *   15:30Z → 10:30 CT (midday)
 *   17:00Z → 12:00 CT (midday)
 *   19:00Z → 14:00 CT (charm-window)
 *   19:45Z → 14:45 CT (final 30m)
 *   20:30Z → 15:30 CT (post-close)
 */

import { describe, it, expect } from 'vitest';
import {
  CHARM_DRIFT_NOISE_THRESHOLD,
  computeCharmDriftRead,
} from '../periscope-charm-drift';
import { theme } from '../../themes';

// A non-noise tally so we exercise drift branches rather than fall into
// the noise bucket. Stays well above CHARM_DRIFT_NOISE_THRESHOLD.
const NON_NOISE_TALLY = 5_000_000;

// A safely-noise tally — under the threshold by an order of magnitude.
const NOISE_TALLY = 100_000;

describe('computeCharmDriftRead — position line', () => {
  it('marks spot as pinned when |spot − zero| < 1 pt', () => {
    const result = computeCharmDriftRead({
      spot: 5800.4,
      charmZeroStrike: 5800,
      tallyWide100: NON_NOISE_TALLY,
      capturedAt: '2026-05-19T17:00:00Z', // 12:00 CT — midday
    });
    expect(result.position.text).toContain('pinned at charm-zero');
    expect(result.position.text).toContain('5800');
  });

  it('describes spot above charm-zero with rounded pts', () => {
    const result = computeCharmDriftRead({
      spot: 5817.6,
      charmZeroStrike: 5800,
      tallyWide100: NON_NOISE_TALLY,
      capturedAt: '2026-05-19T17:00:00Z',
    });
    expect(result.position.text).toBe('Spot 18 pts above charm-zero (5800)');
  });

  it('describes spot below charm-zero with rounded pts', () => {
    const result = computeCharmDriftRead({
      spot: 5782.4,
      charmZeroStrike: 5800,
      tallyWide100: NON_NOISE_TALLY,
      capturedAt: '2026-05-19T17:00:00Z',
    });
    expect(result.position.text).toBe('Spot 18 pts below charm-zero (5800)');
  });

  it('always uses textSecondary for the position color', () => {
    const result = computeCharmDriftRead({
      spot: 5800,
      charmZeroStrike: 5800,
      tallyWide100: NON_NOISE_TALLY,
      capturedAt: '2026-05-19T17:00:00Z',
    });
    expect(result.position.color).toBe(theme.textSecondary);
  });
});

describe('computeCharmDriftRead — drift line', () => {
  it('returns the aftermarket message when CT time ≥ 15:00', () => {
    const result = computeCharmDriftRead({
      spot: 5800,
      charmZeroStrike: 5800,
      tallyWide100: NON_NOISE_TALLY,
      capturedAt: '2026-05-19T20:30:00Z', // 15:30 CT
    });
    expect(result.drift.text).toContain('aftermarket reading');
    expect(result.drift.color).toBe(theme.textMuted);
  });

  it('flags noise when |tally| < CHARM_DRIFT_NOISE_THRESHOLD', () => {
    // Sanity: keep this test green if the constant is tweaked
    expect(Math.abs(NOISE_TALLY)).toBeLessThan(CHARM_DRIFT_NOISE_THRESHOLD);
    const result = computeCharmDriftRead({
      spot: 5800,
      charmZeroStrike: 5800,
      tallyWide100: NOISE_TALLY,
      capturedAt: '2026-05-19T17:00:00Z', // 12:00 CT
    });
    expect(result.drift.text).toContain('flat, no mechanical drift');
    expect(result.drift.color).toBe(theme.textMuted);
  });

  it('reports BUY-into-close for positive tallies during the session', () => {
    const result = computeCharmDriftRead({
      spot: 5800,
      charmZeroStrike: 5800,
      tallyWide100: NON_NOISE_TALLY,
      capturedAt: '2026-05-19T17:00:00Z', // 12:00 CT
    });
    expect(result.drift.text).toContain('mechanical /ES BUY into close');
    expect(result.drift.text).toContain('drift up');
    expect(result.drift.color).toBe(theme.green);
  });

  it('reports SELL-into-close for negative tallies during the session', () => {
    const result = computeCharmDriftRead({
      spot: 5800,
      charmZeroStrike: 5800,
      tallyWide100: -NON_NOISE_TALLY,
      capturedAt: '2026-05-19T17:00:00Z',
    });
    expect(result.drift.text).toContain('mechanical /ES SELL into close');
    expect(result.drift.text).toContain('drift down');
    expect(result.drift.color).toBe(theme.red);
  });

  it('prefixes drift line with the formatted tally', () => {
    const result = computeCharmDriftRead({
      spot: 5800,
      charmZeroStrike: 5800,
      tallyWide100: 5_000_000,
      capturedAt: '2026-05-19T17:00:00Z',
    });
    expect(result.drift.text.startsWith('Tally +5.00M')).toBe(true);
  });
});

describe('computeCharmDriftRead — weight line (time-of-day buckets)', () => {
  it('marks pre-market when CT < 08:30', () => {
    const result = computeCharmDriftRead({
      spot: 5800,
      charmZeroStrike: 5800,
      tallyWide100: NON_NOISE_TALLY,
      capturedAt: '2026-05-19T13:00:00Z', // 08:00 CT
    });
    expect(result.weight.text).toBe('Pre-market — charm impact minimal');
    expect(result.weight.color).toBe(theme.textMuted);
  });

  it('marks morning bucket for 08:30–10:29 CT', () => {
    const result = computeCharmDriftRead({
      spot: 5800,
      charmZeroStrike: 5800,
      tallyWide100: NON_NOISE_TALLY,
      capturedAt: '2026-05-19T14:30:00Z', // 09:30 CT
    });
    expect(result.weight.text).toBe('Morning — gamma dominates, charm light');
    expect(result.weight.color).toBe(theme.textMuted);
  });

  it('marks midday for 10:30–12:59 CT', () => {
    const result = computeCharmDriftRead({
      spot: 5800,
      charmZeroStrike: 5800,
      tallyWide100: NON_NOISE_TALLY,
      capturedAt: '2026-05-19T15:30:00Z', // 10:30 CT
    });
    expect(result.weight.text).toBe('Midday — charm building, dual-force');
    expect(result.weight.color).toBe(theme.textSecondary);
  });

  it('marks the charm window for 13:00–14:29 CT', () => {
    const result = computeCharmDriftRead({
      spot: 5800,
      charmZeroStrike: 5800,
      tallyWide100: NON_NOISE_TALLY,
      capturedAt: '2026-05-19T19:00:00Z', // 14:00 CT
    });
    expect(result.weight.text).toBe(
      'Charm window — mechanical drift dominates',
    );
    expect(result.weight.color).toBe(theme.text);
  });

  it('marks the final 30m bucket for 14:30–14:59 CT', () => {
    const result = computeCharmDriftRead({
      spot: 5800,
      charmZeroStrike: 5800,
      tallyWide100: NON_NOISE_TALLY,
      capturedAt: '2026-05-19T19:45:00Z', // 14:45 CT
    });
    expect(result.weight.text).toBe('Final 30m — pin / acceleration');
    expect(result.weight.color).toBe(theme.accent);
  });

  it('marks post-close for ≥ 15:00 CT', () => {
    const result = computeCharmDriftRead({
      spot: 5800,
      charmZeroStrike: 5800,
      tallyWide100: NON_NOISE_TALLY,
      capturedAt: '2026-05-19T20:30:00Z', // 15:30 CT
    });
    expect(result.weight.text).toBe('Post-close');
    expect(result.weight.color).toBe(theme.textMuted);
  });
});
