/**
 * gateResponseToDate — the shared cross-day staleness gate that sits at
 * the `useFetchedData` data layer. `useFetchedData` is stale-while-
 * revalidate: on a `date` change it retains the PRIOR day's response
 * until the new fetch resolves. The gate nulls `data` whenever the
 * response's echoed `date` doesn't match the requested day, so the brief
 * window surfaces as "not yet loaded" instead of yesterday's rows/counts
 * under today's date. These tests pin the pure-helper contract; the four
 * consuming hooks have their own wiring tests.
 */
import { describe, it, expect } from 'vitest';
import {
  gateResponseToDate,
  type UseFetchedDataResult,
} from '../hooks/useFetchedData';

interface Dated {
  date: string;
  value: number;
}

function makeResult(data: Dated | null): UseFetchedDataResult<Dated> {
  return {
    data,
    loading: false,
    error: null,
    refresh: () => {},
    fetchedAt: 1234,
  };
}

describe('gateResponseToDate', () => {
  it('returns the result unchanged when the response date matches', () => {
    const result = makeResult({ date: '2026-06-09', value: 42 });
    const gated = gateResponseToDate(result, '2026-06-09');
    // Same reference back — no allocation, data preserved.
    expect(gated).toBe(result);
    expect(gated.data).toEqual({ date: '2026-06-09', value: 42 });
  });

  it('nulls data when the response date does not match, preserving siblings', () => {
    const refresh = () => {};
    const result: UseFetchedDataResult<Dated> = {
      data: { date: '2026-06-08', value: 7 },
      loading: true,
      error: 'prior error',
      refresh,
      fetchedAt: 999,
    };
    const gated = gateResponseToDate(result, '2026-06-09');
    expect(gated.data).toBeNull();
    // Every other field is carried through untouched.
    expect(gated.loading).toBe(true);
    expect(gated.error).toBe('prior error');
    expect(gated.refresh).toBe(refresh);
    expect(gated.fetchedAt).toBe(999);
  });

  it('returns the result unchanged when data is already null', () => {
    const result = makeResult(null);
    const gated = gateResponseToDate(result, '2026-06-09');
    expect(gated).toBe(result);
    expect(gated.data).toBeNull();
  });
});
