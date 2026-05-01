/**
 * uwFetchPaged — generic UW pagination helper.
 *
 * The previous pattern (see `darkpool.ts`'s old `fetchAllDarkPoolTrades`)
 * opened raw `fetch()` calls in a loop, bypassing `uwFetch()`'s rate +
 * concurrency gates. Under high cron concurrency this silently violates
 * UW's per-second concurrency cap and produces 429 hits we never see in
 * the metrics until the budget burns down.
 *
 * This helper routes every page through `uwFetch()` so both gates apply,
 * while exposing enough cursor-injection seams that callers can keep
 * their existing pagination semantics (older_than cursor, batch-size
 * stop, cross-date guard, etc.).
 *
 * Generic by design — the caller supplies:
 *   - `buildPath(pageIdx, prevRows)` to compute the path for each page,
 *   - `onPage(rows, pageIdx)` to decide whether to continue paginating.
 *
 * Adoption site: `darkpool.ts` (Phase 1e). Future sites: any cron that
 * paginates UW endpoints with custom cursor logic.
 *
 * Phase 1e of docs/superpowers/specs/api-refactor-2026-05-02.md.
 */

import { uwFetch } from './api-helpers.js';

/**
 * Maximum pages a paginated UW call will follow before giving up.
 * 50 pages × 500 rows/page = 25k rows — well above any single-day
 * volume on the endpoints we paginate today (dark-pool tape peaks at
 * ~30k on FOMC days; this is the soft ceiling).
 */
export const UW_PAGED_DEFAULT_MAX_PAGES = 50;

/**
 * Result of `onPage()` — caller's cursor-progress decision.
 *   - `{ done: true }`   — pagination stops; no further pages fetched.
 *   - `{ done: false }`  — pagination continues; the next call uses the
 *     path returned by `buildPath(nextPageIdx, allRows)`.
 */
export type OnPageDecision = { done: boolean };

export interface UwFetchPagedOptions<T> {
  /** UW API key forwarded to `uwFetch()` for each page request. */
  apiKey: string;
  /**
   * Build the path for page `pageIdx` (0-indexed). On page 0, `prevRows`
   * is empty; on subsequent pages it contains all rows accumulated so
   * far so cursor logic (e.g. `older_than = oldest.ts`) can be derived.
   */
  buildPath: (pageIdx: number, prevRows: readonly T[]) => string;
  /**
   * Caller-side after-each-page hook. Returns whether to keep paginating.
   *
   * Use this to evaluate batch-size cutoffs, cross-date guards, cursor
   * stalls, etc. The helper itself only enforces `maxPages` and an empty
   * page break (zero rows always stops).
   */
  onPage?: (rows: readonly T[], pageIdx: number) => OnPageDecision;
  /** Maximum pages to walk. Defaults to UW_PAGED_DEFAULT_MAX_PAGES. */
  maxPages?: number;
  /**
   * Inter-page sleep in ms. Defaults to 0 — `uwFetch()`'s rate gate now
   * does the spacing for us, so callers don't need to add their own.
   * Override only if you have a reason to under-pace beyond the gate.
   */
  betweenPagesMs?: number;
  /**
   * AbortSignal for cancelling the loop. Checked between pages; an
   * aborted signal causes the helper to return whatever it has.
   */
  signal?: AbortSignal;
}

export interface UwFetchPagedResult<T> {
  /** All rows accumulated across pages (no quality filtering — caller's job). */
  rows: T[];
  /** Number of pages actually fetched (≤ `maxPages`). */
  pagesFetched: number;
  /**
   * True when the loop hit `maxPages` rather than an empty page or an
   * `onPage` `done: true`. Surface to telemetry so we know if the safety
   * cap is firing in production.
   */
  reachedPageCap: boolean;
}

/**
 * Walk a UW endpoint page-by-page via `uwFetch()`, accumulating rows
 * until `onPage` says stop, an empty page is returned, the abort signal
 * fires, or `maxPages` is hit.
 *
 * Throws whatever `uwFetch` throws on the FIRST page (so callers can
 * `withRetry()` transient errors). On later pages, throws are
 * propagated to the caller — wrap your own try/catch if you want to
 * keep partial progress on mid-pagination failures.
 */
export async function uwFetchPaged<T>(
  opts: UwFetchPagedOptions<T>,
): Promise<UwFetchPagedResult<T>> {
  const {
    apiKey,
    buildPath,
    onPage,
    maxPages = UW_PAGED_DEFAULT_MAX_PAGES,
    betweenPagesMs = 0,
    signal,
  } = opts;

  if (maxPages <= 0) {
    throw new Error('uwFetchPaged: maxPages must be > 0');
  }

  const rows: T[] = [];
  let pagesFetched = 0;
  let reachedPageCap = true;

  for (let pageIdx = 0; pageIdx < maxPages; pageIdx++) {
    if (signal?.aborted) {
      reachedPageCap = false;
      break;
    }

    const path = buildPath(pageIdx, rows);
    const batch = await uwFetch<T>(apiKey, path);
    pagesFetched++;

    if (batch.length === 0) {
      reachedPageCap = false;
      break;
    }

    rows.push(...batch);

    const decision = onPage?.(batch, pageIdx);
    if (decision?.done) {
      reachedPageCap = false;
      break;
    }

    if (betweenPagesMs > 0 && pageIdx < maxPages - 1) {
      await new Promise((r) => setTimeout(r, betweenPagesMs));
    }
  }

  return { rows, pagesFetched, reachedPageCap };
}
