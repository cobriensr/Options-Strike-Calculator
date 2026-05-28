import { describe, it, expect } from 'vitest';
import { estimateFilteredTotalPages } from '../filtered-pagination.js';

describe('estimateFilteredTotalPages', () => {
  it('returns raw pages when no client filtering occurred (visible == requested)', () => {
    expect(
      estimateFilteredTotalPages({
        serverTotal: 736,
        pageSize: 50,
        currentPage: 1,
        currentPageRequested: 50,
        currentPageVisible: 50,
      }),
    ).toBe(15); // ceil(736 / 50)
  });

  it('scales total down by the visible ratio', () => {
    // 42/50 visible on this page → ~84% visibility ratio
    // 736 * 0.84 = 618.24, ceil(618.24 / 50) = 13
    expect(
      estimateFilteredTotalPages({
        serverTotal: 736,
        pageSize: 50,
        currentPage: 1,
        currentPageRequested: 50,
        currentPageVisible: 42,
      }),
    ).toBe(13);
  });

  it('floors at currentPage so the user never sees "1 / 0"', () => {
    // Extreme: 1 visible out of 50 on page 3 → very few estimated pages,
    // but the user IS on page 3, so the floor kicks in.
    expect(
      estimateFilteredTotalPages({
        serverTotal: 736,
        pageSize: 50,
        currentPage: 3,
        currentPageRequested: 50,
        currentPageVisible: 1,
      }),
    ).toBe(3);
  });

  it('falls back to raw when the current page had 0 server rows (no signal)', () => {
    expect(
      estimateFilteredTotalPages({
        serverTotal: 736,
        pageSize: 50,
        currentPage: 1,
        currentPageRequested: 0,
        currentPageVisible: 0,
      }),
    ).toBe(15);
  });

  it('returns 1 when serverTotal is 0', () => {
    expect(
      estimateFilteredTotalPages({
        serverTotal: 0,
        pageSize: 50,
        currentPage: 1,
        currentPageRequested: 0,
        currentPageVisible: 0,
      }),
    ).toBe(1);
  });

  it('handles a partial last page correctly (requested < pageSize)', () => {
    // 50 alerts total, page 1, server returned 49 (one short of pageSize for some reason)
    // 35 visible after filters → 35/49 = ~71%
    // 50 * 0.7142 = 35.71, ceil(35.71/50) = 1 → max(1, 1) = 1
    expect(
      estimateFilteredTotalPages({
        serverTotal: 50,
        pageSize: 50,
        currentPage: 1,
        currentPageRequested: 49,
        currentPageVisible: 35,
      }),
    ).toBe(1);
  });
});
