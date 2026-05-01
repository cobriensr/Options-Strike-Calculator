/**
 * Tests for `useTableSort` — generic sort state + sort derivation hook.
 *
 * Covers the contract Phase 2a consumers (`OptionsFlowTable`,
 * `WhalePositioningTable`) will rely on:
 *
 *   - default key + direction respected on initial render
 *   - same-key click toggles direction (asc ↔ desc)
 *   - new-key click switches column and resets direction to defaultDir
 *   - null extractor results always sort to the END regardless of dir
 *   - stable sort: tied values preserve original input order in BOTH dirs
 *   - asc / desc semantics (numeric and string)
 *   - the returned `sortedRows` is a fresh array (never mutates input)
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useTableSort,
  type KeyExtractors,
  type SortDirection,
} from '../../hooks/useTableSort';

interface Row {
  id: string;
  premium: number;
  side: 'call' | 'put';
  /** May be null — exercises the null-tail partition. */
  gex: number | null;
}

type ColKey = 'id' | 'premium' | 'side' | 'gex';

const extractors: KeyExtractors<Row, ColKey> = {
  id: (r) => r.id,
  premium: (r) => r.premium,
  side: (r) => r.side,
  gex: (r) => r.gex,
};

function makeRow(overrides: Partial<Row> & { id: string }): Row {
  return {
    premium: 0,
    side: 'call',
    gex: null,
    ...overrides,
  };
}

describe('useTableSort: defaults', () => {
  it('honors the default key + direction on first render', () => {
    const rows: Row[] = [
      makeRow({ id: 'a', premium: 100 }),
      makeRow({ id: 'b', premium: 300 }),
      makeRow({ id: 'c', premium: 200 }),
    ];
    const { result } = renderHook(() =>
      useTableSort<Row, ColKey>({
        rows,
        keyExtractors: extractors,
        defaultKey: 'premium',
        defaultDir: 'desc',
      }),
    );

    expect(result.current.sortKey).toBe('premium');
    expect(result.current.sortDir).toBe('desc');
    expect(result.current.sortedRows.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('honors defaultDir = "asc"', () => {
    const rows: Row[] = [
      makeRow({ id: 'a', premium: 100 }),
      makeRow({ id: 'b', premium: 300 }),
      makeRow({ id: 'c', premium: 200 }),
    ];
    const { result } = renderHook(() =>
      useTableSort<Row, ColKey>({
        rows,
        keyExtractors: extractors,
        defaultKey: 'premium',
        defaultDir: 'asc',
      }),
    );

    expect(result.current.sortDir).toBe('asc');
    expect(result.current.sortedRows.map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('useTableSort: setSort transitions', () => {
  it('toggles direction when called with the current key', () => {
    const rows: Row[] = [
      makeRow({ id: 'a', premium: 100 }),
      makeRow({ id: 'b', premium: 200 }),
    ];
    const { result } = renderHook(() =>
      useTableSort<Row, ColKey>({
        rows,
        keyExtractors: extractors,
        defaultKey: 'premium',
        defaultDir: 'desc',
      }),
    );

    expect(result.current.sortDir).toBe('desc');

    act(() => result.current.setSort('premium'));
    expect(result.current.sortKey).toBe('premium');
    expect(result.current.sortDir).toBe('asc');

    act(() => result.current.setSort('premium'));
    expect(result.current.sortDir).toBe('desc');
  });

  it('switches key and resets direction to defaultDir', () => {
    const rows: Row[] = [
      makeRow({ id: 'a', premium: 100 }),
      makeRow({ id: 'b', premium: 200 }),
    ];
    const { result } = renderHook(() =>
      useTableSort<Row, ColKey>({
        rows,
        keyExtractors: extractors,
        defaultKey: 'premium',
        defaultDir: 'desc',
      }),
    );

    // First flip the direction to asc so we can confirm the reset.
    act(() => result.current.setSort('premium'));
    expect(result.current.sortDir).toBe('asc');

    // Now switch column — direction must snap back to defaultDir = desc.
    act(() => result.current.setSort('id'));
    expect(result.current.sortKey).toBe('id');
    expect(result.current.sortDir).toBe('desc');
  });

  it('respects defaultDir = "asc" on key switch', () => {
    const rows: Row[] = [
      makeRow({ id: 'a', premium: 100 }),
      makeRow({ id: 'b', premium: 200 }),
    ];
    const { result } = renderHook(() =>
      useTableSort<Row, ColKey>({
        rows,
        keyExtractors: extractors,
        defaultKey: 'premium',
        defaultDir: 'asc',
      }),
    );

    // Toggle to desc on the same key.
    act(() => result.current.setSort('premium'));
    expect(result.current.sortDir).toBe('desc');

    // Switch column — must reset to defaultDir = asc.
    act(() => result.current.setSort('id'));
    expect(result.current.sortDir).toBe('asc');
  });
});

describe('useTableSort: numeric sort semantics', () => {
  it('sorts ascending', () => {
    const rows: Row[] = [
      makeRow({ id: 'a', premium: 30 }),
      makeRow({ id: 'b', premium: 10 }),
      makeRow({ id: 'c', premium: 20 }),
    ];
    const { result } = renderHook(() =>
      useTableSort<Row, ColKey>({
        rows,
        keyExtractors: extractors,
        defaultKey: 'premium',
        defaultDir: 'asc',
      }),
    );
    expect(result.current.sortedRows.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts descending', () => {
    const rows: Row[] = [
      makeRow({ id: 'a', premium: 30 }),
      makeRow({ id: 'b', premium: 10 }),
      makeRow({ id: 'c', premium: 20 }),
    ];
    const { result } = renderHook(() =>
      useTableSort<Row, ColKey>({
        rows,
        keyExtractors: extractors,
        defaultKey: 'premium',
        defaultDir: 'desc',
      }),
    );
    expect(result.current.sortedRows.map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('useTableSort: string sort semantics', () => {
  it('sorts strings lexicographically (asc)', () => {
    const rows: Row[] = [
      makeRow({ id: 'banana' }),
      makeRow({ id: 'apple' }),
      makeRow({ id: 'cherry' }),
    ];
    const { result } = renderHook(() =>
      useTableSort<Row, ColKey>({
        rows,
        keyExtractors: extractors,
        defaultKey: 'id',
        defaultDir: 'asc',
      }),
    );
    expect(result.current.sortedRows.map((r) => r.id)).toEqual([
      'apple',
      'banana',
      'cherry',
    ]);
  });

  it('sorts strings lexicographically (desc)', () => {
    const rows: Row[] = [
      makeRow({ id: 'banana' }),
      makeRow({ id: 'apple' }),
      makeRow({ id: 'cherry' }),
    ];
    const { result } = renderHook(() =>
      useTableSort<Row, ColKey>({
        rows,
        keyExtractors: extractors,
        defaultKey: 'id',
        defaultDir: 'desc',
      }),
    );
    expect(result.current.sortedRows.map((r) => r.id)).toEqual([
      'cherry',
      'banana',
      'apple',
    ]);
  });
});

describe('useTableSort: null-tail partition', () => {
  it('places null extractor values at the end on asc', () => {
    const rows: Row[] = [
      makeRow({ id: 'a', gex: 100 }),
      makeRow({ id: 'b', gex: null }),
      makeRow({ id: 'c', gex: 50 }),
      makeRow({ id: 'd', gex: null }),
    ];
    const { result } = renderHook(() =>
      useTableSort<Row, ColKey>({
        rows,
        keyExtractors: extractors,
        defaultKey: 'gex',
        defaultDir: 'asc',
      }),
    );
    expect(result.current.sortedRows.map((r) => r.id)).toEqual([
      'c',
      'a',
      'b',
      'd',
    ]);
  });

  it('places null extractor values at the end on desc', () => {
    const rows: Row[] = [
      makeRow({ id: 'a', gex: 100 }),
      makeRow({ id: 'b', gex: null }),
      makeRow({ id: 'c', gex: 50 }),
      makeRow({ id: 'd', gex: null }),
    ];
    const { result } = renderHook(() =>
      useTableSort<Row, ColKey>({
        rows,
        keyExtractors: extractors,
        defaultKey: 'gex',
        defaultDir: 'desc',
      }),
    );
    // Present values descending (a, c), then null-tail in input order (b, d).
    expect(result.current.sortedRows.map((r) => r.id)).toEqual([
      'a',
      'c',
      'b',
      'd',
    ]);
  });

  it('preserves null-tail input order regardless of direction', () => {
    const rows: Row[] = [
      makeRow({ id: 'first-null', gex: null }),
      makeRow({ id: 'a', gex: 100 }),
      makeRow({ id: 'second-null', gex: null }),
      makeRow({ id: 'b', gex: 50 }),
    ];
    const { result } = renderHook(() =>
      useTableSort<Row, ColKey>({
        rows,
        keyExtractors: extractors,
        defaultKey: 'gex',
        defaultDir: 'asc',
      }),
    );
    const ids = result.current.sortedRows.map((r) => r.id);
    // Nulls always last and in input order.
    expect(ids.slice(-2)).toEqual(['first-null', 'second-null']);

    act(() => result.current.setSort('gex')); // toggle to desc
    const idsDesc = result.current.sortedRows.map((r) => r.id);
    expect(idsDesc.slice(-2)).toEqual(['first-null', 'second-null']);
  });

  it('handles all-null column without error', () => {
    const rows: Row[] = [
      makeRow({ id: 'a', gex: null }),
      makeRow({ id: 'b', gex: null }),
      makeRow({ id: 'c', gex: null }),
    ];
    const { result } = renderHook(() =>
      useTableSort<Row, ColKey>({
        rows,
        keyExtractors: extractors,
        defaultKey: 'gex',
        defaultDir: 'desc',
      }),
    );
    // Input order preserved.
    expect(result.current.sortedRows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('useTableSort: stability on tied values', () => {
  it('preserves input order for tied numeric values (asc)', () => {
    const rows: Row[] = [
      makeRow({ id: 'first', premium: 100 }),
      makeRow({ id: 'second', premium: 100 }),
      makeRow({ id: 'third', premium: 100 }),
      makeRow({ id: 'lower', premium: 50 }),
    ];
    const { result } = renderHook(() =>
      useTableSort<Row, ColKey>({
        rows,
        keyExtractors: extractors,
        defaultKey: 'premium',
        defaultDir: 'asc',
      }),
    );
    expect(result.current.sortedRows.map((r) => r.id)).toEqual([
      'lower',
      'first',
      'second',
      'third',
    ]);
  });

  it('preserves input order for tied numeric values (desc)', () => {
    // The desc-stability case is the one a naive `.reverse()` impl breaks.
    // Tied values must remain in input order for both directions.
    const rows: Row[] = [
      makeRow({ id: 'first', premium: 100 }),
      makeRow({ id: 'second', premium: 100 }),
      makeRow({ id: 'third', premium: 100 }),
      makeRow({ id: 'higher', premium: 200 }),
    ];
    const { result } = renderHook(() =>
      useTableSort<Row, ColKey>({
        rows,
        keyExtractors: extractors,
        defaultKey: 'premium',
        defaultDir: 'desc',
      }),
    );
    expect(result.current.sortedRows.map((r) => r.id)).toEqual([
      'higher',
      'first',
      'second',
      'third',
    ]);
  });

  it('preserves input order for tied string values (desc)', () => {
    const rows: Row[] = [
      makeRow({ id: '1', side: 'call' }),
      makeRow({ id: '2', side: 'put' }),
      makeRow({ id: '3', side: 'call' }),
      makeRow({ id: '4', side: 'put' }),
    ];
    const { result } = renderHook(() =>
      useTableSort<Row, ColKey>({
        rows,
        keyExtractors: extractors,
        defaultKey: 'side',
        defaultDir: 'desc',
      }),
    );
    // 'put' > 'call' lexicographically, so puts come first; tied within
    // each group must keep input order.
    expect(result.current.sortedRows.map((r) => r.id)).toEqual([
      '2',
      '4',
      '1',
      '3',
    ]);
  });
});

describe('useTableSort: input immutability', () => {
  it('does not mutate the rows array', () => {
    const rows: Row[] = [
      makeRow({ id: 'a', premium: 30 }),
      makeRow({ id: 'b', premium: 10 }),
      makeRow({ id: 'c', premium: 20 }),
    ];
    const original = rows.map((r) => r.id);
    renderHook(() =>
      useTableSort<Row, ColKey>({
        rows,
        keyExtractors: extractors,
        defaultKey: 'premium',
        defaultDir: 'asc',
      }),
    );
    expect(rows.map((r) => r.id)).toEqual(original);
  });

  it('returns a new array distinct from the input', () => {
    const rows: Row[] = [makeRow({ id: 'a' })];
    const { result } = renderHook(() =>
      useTableSort<Row, ColKey>({
        rows,
        keyExtractors: extractors,
        defaultKey: 'premium',
        defaultDir: 'asc',
      }),
    );
    expect(result.current.sortedRows).not.toBe(rows);
  });
});

describe('useTableSort: empty input', () => {
  it('returns an empty sortedRows for empty input', () => {
    const { result } = renderHook(() =>
      useTableSort<Row, ColKey>({
        rows: [],
        keyExtractors: extractors,
        defaultKey: 'premium',
        defaultDir: 'desc',
      }),
    );
    expect(result.current.sortedRows).toEqual([]);
  });
});

// Type-level sanity check — purely compile-time, no runtime assertions
// needed. If the `SortDirection` union narrows or the generic constraint
// drifts, this assertion fails to type-check.
describe('useTableSort: type exports', () => {
  it('exports SortDirection as the expected literal union', () => {
    const asc: SortDirection = 'asc';
    const desc: SortDirection = 'desc';
    expect(asc).toBe('asc');
    expect(desc).toBe('desc');
  });
});
