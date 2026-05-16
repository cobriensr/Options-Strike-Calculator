/**
 * Unit tests for tooltipFor — the (greek × sign) tooltip lookup. The
 * function is small but load-bearing: it's wired to the heatmap
 * cells' hover text + screen-reader `title`, so a wrong-string bug
 * would be silently misleading.
 */

import { describe, expect, it } from 'vitest';

import {
  GREEK_TOOLTIPS,
  tooltipFor,
} from '../../components/GreekHeatmap/tooltipText';

describe('tooltipFor', () => {
  it('returns the gamma-positive copy for a positive gamma value', () => {
    expect(tooltipFor('gamma', 67_300_000)).toBe(GREEK_TOOLTIPS.gammaPositive);
  });

  it('returns the gamma-negative copy for a negative gamma value', () => {
    expect(tooltipFor('gamma', -2_900_000)).toBe(GREEK_TOOLTIPS.gammaNegative);
  });

  it('returns the charm-positive copy for a positive charm value', () => {
    expect(tooltipFor('charm', 4_470_000_000)).toBe(
      GREEK_TOOLTIPS.charmPositive,
    );
  });

  it('returns the charm-negative copy for a negative charm value', () => {
    expect(tooltipFor('charm', -377_570_000_000)).toBe(
      GREEK_TOOLTIPS.charmNegative,
    );
  });

  it('returns the vanna-positive copy for a positive vanna value', () => {
    expect(tooltipFor('vanna', 492_000)).toBe(GREEK_TOOLTIPS.vannaPositive);
  });

  it('returns the vanna-negative copy for a negative vanna value', () => {
    expect(tooltipFor('vanna', -491)).toBe(GREEK_TOOLTIPS.vannaNegative);
  });

  it('returns the zero copy for null or exact-zero values', () => {
    expect(tooltipFor('gamma', null)).toBe(GREEK_TOOLTIPS.zero);
    expect(tooltipFor('charm', 0)).toBe(GREEK_TOOLTIPS.zero);
    expect(tooltipFor('vanna', null)).toBe(GREEK_TOOLTIPS.zero);
  });
});
