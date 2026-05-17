/**
 * Unit tests for the pure helpers in `src/components/Tracker/helpers.ts`.
 *
 * Scope: formatters and the watchlist predicate. The PnL math is exercised
 * indirectly via ContractRow.test.tsx; this file pins behavior of the
 * isolated string-builders so future refactors don't silently drift the
 * toast / list display.
 */

import { describe, expect, it } from 'vitest';

import {
  buildAlertToast,
  dteFromExpiry,
  formatSpotLevel,
} from '../../components/Tracker/helpers';
import type { TrackerAlert } from '../../components/Tracker/types';

describe('formatSpotLevel', () => {
  it('renders an integer level without a decimal (no trailing zeros)', () => {
    // The buggy original used `toFixed(2)` and produced "595.00" — which
    // is noisy when the user typed "595". Pin the cleaner output here.
    expect(formatSpotLevel(595)).toBe('595');
    expect(formatSpotLevel(0)).toBe('0');
    expect(formatSpotLevel(-42)).toBe('-42');
  });

  it('renders a fractional level with the minimal precision', () => {
    expect(formatSpotLevel(595.5)).toBe('595.5');
    expect(formatSpotLevel(225.25)).toBe('225.25');
  });

  it('drops a trailing zero in the decimal portion', () => {
    // 595.50 should display as 595.5, not 595.50.
    expect(formatSpotLevel(595.5)).toBe('595.5');
  });

  it('rounds beyond 2 decimal places (display precision)', () => {
    // The alerts pipeline writes thresholds at 2dp; if a higher-precision
    // value ever leaks in, render the rounded form rather than the
    // full float.
    expect(formatSpotLevel(595.567)).toBe('595.57');
  });

  it('returns a stringified fallback for non-finite inputs', () => {
    // Defensive — alerts.threshold should never be NaN/Infinity, but
    // the formatter should still return something printable.
    expect(formatSpotLevel(Number.NaN)).toBe('NaN');
    expect(formatSpotLevel(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });
});

describe('buildAlertToast — spot_level', () => {
  function makeSpotAlert(threshold: string): TrackerAlert {
    return {
      id: 7,
      contract_id: 42,
      fired_at: '2026-05-17T15:30:00Z',
      alert_type: 'spot_level',
      threshold,
      price_at_fire: '4.45',
      underlying_at_fire: '595.10',
      acknowledged: false,
      occ_symbol: 'SPY   260620C00595000',
      ticker: 'SPY',
      expiry: '2026-06-20',
      strike: '595',
      side: 'C',
      direction: 'long',
      entry_price: '4.30',
      quantity: 5,
      contract_status: 'active',
    };
  }

  it('formats an integer threshold without `.00`', () => {
    const { message, type } = buildAlertToast(makeSpotAlert('595'));
    expect(type).toBe('info');
    expect(message).toContain('crossed 595 ');
    expect(message).not.toContain('595.00');
  });

  it('keeps fractional precision on a non-integer threshold', () => {
    const { message } = buildAlertToast(makeSpotAlert('595.5'));
    expect(message).toContain('crossed 595.5 ');
  });
});

describe('dteFromExpiry (regression: Date-vs-string)', () => {
  // The Phase 3 reviewer caught that Neon hydrates Postgres DATE columns
  // as JS Date objects, which JSON-serialize to an ISO timestamp. If the
  // SQL handler ever forgets the TO_CHAR cast, dteFromExpiry will see
  // "2026-05-22T00:00:00.000Z" and split-by-`-` will produce NaN. Pin
  // the contract: the helper accepts a clean YYYY-MM-DD only, and
  // returns 0 for malformed input.
  it('parses a clean YYYY-MM-DD against a fixed `now`', () => {
    // 7 days between 2026-05-15 and 2026-05-22.
    const now = new Date('2026-05-15T00:00:00Z');
    expect(dteFromExpiry('2026-05-22', now)).toBe(7);
  });

  it('returns 0 for an ISO-timestamp expiry (regression)', () => {
    const now = new Date('2026-05-15T00:00:00Z');
    // If the SQL boundary regresses, the frontend gets this shape — the
    // helper must produce a safe fallback rather than throw or NaN.
    expect(dteFromExpiry('2026-05-22T00:00:00.000Z', now)).toBe(0);
  });
});
