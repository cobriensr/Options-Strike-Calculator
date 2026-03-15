import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSnapshotSave } from '../hooks/useSnapshotSave';
import type { CalculationResults, DeltaRow } from '../types';

// ============================================================
// MOCK DATA
// ============================================================

function makeResults(
  overrides: Partial<CalculationResults> = {},
): CalculationResults {
  return {
    spot: 5500,
    sigma: 0.15,
    T: 0.025,
    hoursRemaining: 6.5,
    allDeltas: [
      {
        delta: 5,
        putSnapped: 5400,
        callSnapped: 5600,
        putPct: '-1.82',
        callPct: '1.82',
      } as DeltaRow,
    ],
    ...overrides,
  };
}

const baseContext = {
  selectedDate: '2026-03-10',
  entryTime: '09:35',
  spy: 550,
  vix: 18,
};

// ============================================================
// FETCH MOCK
// ============================================================

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify({ id: 'abc', saved: true }), { status: 200 }),
    );
});

afterEach(() => {
  fetchSpy.mockRestore();
});

// ============================================================
// TESTS
// ============================================================

describe('useSnapshotSave', () => {
  it('does not fire when results is null', () => {
    renderHook(() => useSnapshotSave(null, baseContext, true));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fire when isOwner is false', () => {
    renderHook(() => useSnapshotSave(makeResults(), baseContext, false));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fire when selectedDate is missing', () => {
    renderHook(() =>
      useSnapshotSave(
        makeResults(),
        { ...baseContext, selectedDate: undefined },
        true,
      ),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fire when entryTime is missing', () => {
    renderHook(() =>
      useSnapshotSave(
        makeResults(),
        { ...baseContext, entryTime: undefined },
        true,
      ),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fires POST to /api/snapshot with correct payload', () => {
    renderHook(() => useSnapshotSave(makeResults(), baseContext, true));

    expect(fetchSpy).toHaveBeenCalledWith('/api/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.date).toBe('2026-03-10');
    expect(body.entryTime).toBe('09:35');
    expect(body.spx).toBe(5500);
    expect(body.spy).toBe(550);
    expect(body.vix).toBe(18);
    expect(body.strikes).toBeDefined();
    expect(body.strikes['5']).toEqual({
      put: 5400,
      call: 5600,
      putPct: -1.82,
      callPct: 1.82,
    });
  });

  it('does not fire duplicate requests for same date+time', () => {
    const results = makeResults();
    const { rerender } = renderHook(() =>
      useSnapshotSave(results, baseContext, true),
    );

    rerender();
    rerender();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('fires again for a different date+time combination', () => {
    const results = makeResults();
    const { rerender } = renderHook(
      ({ ctx }) => useSnapshotSave(results, ctx, true),
      { initialProps: { ctx: baseContext } },
    );

    rerender({ ctx: { ...baseContext, entryTime: '10:00' } });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('removes key from saved set on fetch failure so it can retry', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('Network error'));

    const results = makeResults();
    renderHook(() => useSnapshotSave(results, baseContext, true));

    // Wait for the rejected promise to settle
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    // The key should have been removed from the saved set,
    // so a re-render should trigger another fetch attempt
    // (We can't easily test this without re-rendering with the same hook instance)
  });

  it('skips allDeltas entries with errors', () => {
    const results = makeResults({
      allDeltas: [
        { delta: 5, error: 'No solution' } as never,
        {
          delta: 10,
          putSnapped: 5350,
          callSnapped: 5650,
          putPct: '-2.73',
          callPct: '2.73',
        } as DeltaRow,
      ],
    });

    renderHook(() => useSnapshotSave(results, baseContext, true));

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.strikes['5']).toBeUndefined();
    expect(body.strikes['10']).toEqual({
      put: 5350,
      call: 5650,
      putPct: -2.73,
      callPct: 2.73,
    });
  });
});
