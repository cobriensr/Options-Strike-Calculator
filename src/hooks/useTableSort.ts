/**
 * useTableSort — generic sort state machine for sortable tables.
 *
 * Owns the "which column / which direction" state and the toggle / switch
 * transitions, plus the actual sort. Extracted from the verbatim
 * duplication that previously lived in `OptionsFlowTable` and
 * `WhalePositioningTable`. Designed to be parameterized over any row type
 * via a `keyExtractors` map, so each consumer keeps its own typed column
 * union without leaking row internals into this primitive.
 *
 * Semantics (preserved bit-for-bit from the original inline code):
 *   - Same key → toggle direction (`asc` ↔ `desc`).
 *   - New key → set the new key, reset direction to `defaultDir`.
 *   - Null extractor results always sort to the END of the list,
 *     regardless of direction (the "null-tail partition trick"). A null
 *     can't be meaningfully compared against signed magnitudes in either
 *     direction, so we partition first, sort the present values per
 *     direction, then append the null tail untouched.
 *   - Stable: when extractor values tie, original input order is
 *     preserved (`Array.prototype.sort` is spec-required to be stable
 *     since ES2019, and we only use that primitive).
 *
 * String keys sort lexicographically; numeric keys sort numerically.
 * Mixing string and number returns within a single key extractor is
 * undefined behavior — pick one per column.
 */

import { useCallback, useMemo, useState } from 'react';

export type SortDirection = 'asc' | 'desc';

/**
 * Maps a column key to a function returning the row's sort value for
 * that column. Returning `null` opts the row into the null-tail (always
 * sorted to the end of the visible list, regardless of direction).
 */
export type KeyExtractors<T, K extends string> = Record<
  K,
  (row: T) => number | string | null
>;

export interface UseTableSortOptions<T, K extends string> {
  /** Rows to sort. Must not be mutated; the hook returns a new array. */
  rows: readonly T[];
  /** Map from column key → row → comparable value (or null for tail). */
  keyExtractors: KeyExtractors<T, K>;
  /** Initial column key. */
  defaultKey: K;
  /** Initial direction; also the direction reset target on key switch. */
  defaultDir: SortDirection;
}

export interface TableSortController<T, K extends string> {
  /** Sorted copy of `rows`. Stable for tied values. */
  sortedRows: T[];
  /** Currently active sort column. */
  sortKey: K;
  /** Currently active sort direction. */
  sortDir: SortDirection;
  /**
   * Set the sort column. If `key` matches the current column, toggles
   * direction; otherwise switches to `key` and resets direction to
   * `defaultDir`.
   */
  setSort: (key: K) => void;
}

/**
 * Compare two non-null sort values. Returns negative if `a < b`, positive
 * if `a > b`, zero on tie. Pure — no `localeCompare`, no Intl. Strings
 * use the JS lexicographic ordering operators directly so the same
 * extractor produces deterministic output regardless of host locale.
 */
function compareValues(a: number | string, b: number | string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Generic sort state machine. The hook owns column + direction state
 * and the `setSort` transition; the sort itself is a pure `useMemo`
 * derivation off `rows`, the active key, and direction.
 */
export function useTableSort<T, K extends string>(
  options: UseTableSortOptions<T, K>,
): TableSortController<T, K> {
  const { rows, keyExtractors, defaultKey, defaultDir } = options;

  const [sortKey, setSortKey] = useState<K>(defaultKey);
  const [sortDir, setSortDir] = useState<SortDirection>(defaultDir);

  const setSort = useCallback(
    (key: K) => {
      if (key === sortKey) {
        setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir(defaultDir);
      }
    },
    [sortKey, defaultDir],
  );

  const sortedRows = useMemo(() => {
    const extractor = keyExtractors[sortKey];
    // Partition first: anything that returns null for the active column
    // sinks to the end regardless of direction. Pre-extract so we don't
    // call the extractor twice per row in the comparator.
    const present: { row: T; value: number | string }[] = [];
    const tail: T[] = [];
    for (const row of rows) {
      const value = extractor(row);
      if (value == null) {
        tail.push(row);
      } else {
        present.push({ row, value });
      }
    }
    // `Array.prototype.sort` has been stable since ES2019, holding ties
    // in original input order. We invert the comparator for `desc`
    // rather than `.reverse()`-ing the asc result — `.reverse()` would
    // flip the order of tied values too, breaking stability for the
    // desc case. Per-direction comparator preserves input order on ties
    // in both directions.
    const sign = sortDir === 'asc' ? 1 : -1;
    present.sort((a, b) => sign * compareValues(a.value, b.value));
    return [...present.map((x) => x.row), ...tail];
  }, [rows, keyExtractors, sortKey, sortDir]);

  return { sortedRows, sortKey, sortDir, setSort };
}
