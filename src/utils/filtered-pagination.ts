/**
 * Estimate the post-filter total page count for a paginated feed where some
 * filters apply client-side and the server total reflects only server-applied
 * filters.
 *
 * Strategy: the current page tells us what fraction of rows the client-side
 * filters hide. We extrapolate that ratio across the rest of the dataset.
 * Imperfect when the hidden density varies by page (e.g. low-conviction rows
 * cluster late in the day), but a strict improvement over using the raw
 * server total.
 *
 * Returns `null` when the count is genuinely unknown — the server says more
 * pages exist (hasMore=true) AND our extrapolation has already been exceeded
 * by the current page. The display should render "page N" instead of
 * "N / total" in that case rather than lying about a denominator.
 *
 * Returns a number when:
 *   - hasMore=false (we know currentPage is the last; return exact)
 *   - no client filtering occurred (raw count is exact)
 *   - we have signal AND currentPage is still within the estimate
 */
export function estimateFilteredTotalPages(opts: {
  serverTotal: number;
  pageSize: number;
  currentPage: number; // 1-based
  currentPageRequested: number; // rows the server returned for this page
  currentPageVisible: number; // rows still visible after client filters
  hasMore: boolean; // server signal — more pages remain beyond this one
}): number | null {
  const {
    serverTotal,
    pageSize,
    currentPage,
    currentPageRequested,
    currentPageVisible,
    hasMore,
  } = opts;

  if (pageSize <= 0) return Math.max(1, currentPage);

  const rawPages = Math.max(1, Math.ceil(serverTotal / pageSize));

  // No signal to extrapolate from — fall back to raw.
  if (currentPageRequested <= 0) return Math.max(currentPage, rawPages);

  // No client filtering hit on this page — raw is exact.
  if (currentPageVisible >= currentPageRequested) {
    return Math.max(currentPage, rawPages);
  }

  const visibleRatio = currentPageVisible / currentPageRequested;
  const estimatedVisibleTotal = serverTotal * visibleRatio;
  const estimatedPages = Math.max(
    1,
    Math.ceil(estimatedVisibleTotal / pageSize),
  );

  // Server has no more pages — currentPage IS the last page, exact.
  if (!hasMore) return Math.max(currentPage, estimatedPages);

  // Server has more, and the estimate underestimated — denominator is
  // unknown. Signal that to the caller so the label drops to "page N".
  if (currentPage >= estimatedPages) return null;

  return estimatedPages;
}
