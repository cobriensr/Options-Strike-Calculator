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
 * Guarantees:
 *   - Always returns >= 1.
 *   - Always returns >= currentPage (so the user never sees "1 / 0" on a
 *     page where they're actually looking at content).
 *   - Returns ceil(serverTotal / pageSize) if currentPageRequested is 0
 *     (no signal to extrapolate from).
 *   - Returns ceil(serverTotal / pageSize) if no client filtering occurred
 *     on this page (currentPageVisible === currentPageRequested).
 */
export function estimateFilteredTotalPages(opts: {
  serverTotal: number;
  pageSize: number;
  currentPage: number; // 1-based
  currentPageRequested: number; // rows the server returned for this page
  currentPageVisible: number; // rows still visible after client filters
}): number {
  const {
    serverTotal,
    pageSize,
    currentPage,
    currentPageRequested,
    currentPageVisible,
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

  // Never claim fewer pages than the user is actually viewing.
  return Math.max(currentPage, estimatedPages);
}
