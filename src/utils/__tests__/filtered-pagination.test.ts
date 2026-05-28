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
        hasMore: true,
      }),
    ).toBe(15); // ceil(736 / 50)
  });

  it('scales total down by the visible ratio when still within estimate', () => {
    // 42/50 visible on this page → ~84% visibility ratio
    // 736 * 0.84 = 618.24, ceil(618.24 / 50) = 13
    // currentPage=1 is below estimate=13 → return the estimate
    expect(
      estimateFilteredTotalPages({
        serverTotal: 736,
        pageSize: 50,
        currentPage: 1,
        currentPageRequested: 50,
        currentPageVisible: 42,
        hasMore: true,
      }),
    ).toBe(13);
  });

  it('returns null when hasMore=true and currentPage has reached the estimate', () => {
    // Extreme: 1 visible out of 50 on page 3 → estimate is well below 3.
    // Server says more pages remain, so the denominator is unknown —
    // return null so the caller renders "page 3" not a lying "3 / 3".
    expect(
      estimateFilteredTotalPages({
        serverTotal: 736,
        pageSize: 50,
        currentPage: 3,
        currentPageRequested: 50,
        currentPageVisible: 1,
        hasMore: true,
      }),
    ).toBeNull();
  });

  it('returns currentPage when hasMore=false even past the estimate', () => {
    // Same shape as the previous test, but the server says we're on the
    // last page — we KNOW the total, so floor at currentPage and return it.
    expect(
      estimateFilteredTotalPages({
        serverTotal: 736,
        pageSize: 50,
        currentPage: 3,
        currentPageRequested: 50,
        currentPageVisible: 1,
        hasMore: false,
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
        hasMore: true,
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
        hasMore: false,
      }),
    ).toBe(1);
  });

  it('handles a partial last page correctly (requested < pageSize)', () => {
    // 50 alerts total, page 1, server returned 49 (one short of pageSize)
    // 35 visible after filters → 35/49 = ~71%
    // 50 * 0.7142 = 35.71, ceil(35.71/50) = 1 → max(1, 1) = 1
    expect(
      estimateFilteredTotalPages({
        serverTotal: 50,
        pageSize: 50,
        currentPage: 1,
        currentPageRequested: 49,
        currentPageVisible: 35,
        hasMore: false,
      }),
    ).toBe(1);
  });

  it('returns estimate when hasMore=true and currentPage is strictly below it', () => {
    // 25/50 visible → ratio 0.5, estimate = ceil(736*0.5/50) = 8
    // currentPage=2 < estimate=8 → return 8
    expect(
      estimateFilteredTotalPages({
        serverTotal: 736,
        pageSize: 50,
        currentPage: 2,
        currentPageRequested: 50,
        currentPageVisible: 25,
        hasMore: true,
      }),
    ).toBe(8);
  });

  it('returns null when hasMore=true and currentPage equals the estimate', () => {
    // 25/50 visible → estimate = 8. User is on page 8 with more remaining.
    // The estimate was wrong; we don't know the real total.
    expect(
      estimateFilteredTotalPages({
        serverTotal: 736,
        pageSize: 50,
        currentPage: 8,
        currentPageRequested: 50,
        currentPageVisible: 25,
        hasMore: true,
      }),
    ).toBeNull();
  });
});
