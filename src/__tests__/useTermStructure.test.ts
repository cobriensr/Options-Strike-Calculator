import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTermStructure } from '../hooks/useTermStructure';

// useTermStructure is pure computation (useMemo over VIX-curve inputs) — no
// fetch, no polling, no market-open gate — so the smoke test pins the
// input→signal contract directly. Thresholds (from SIGNALS): TERM_SHAPE
// lo=0.97 / hi=1.03, TERM_FLAT=±0.05.

describe('useTermStructure', () => {
  it('returns all-null signals when VIX is missing (default/empty state)', () => {
    const { result } = renderHook(() =>
      useTermStructure({
        vix: undefined,
        vix1d: undefined,
        vix9d: undefined,
        vvix: undefined,
      }),
    );

    expect(result.current).toEqual({
      vixTermSignal: null,
      vixTermShape: null,
      vixTermShapeAdvice: null,
    });
  });

  it('classifies full contango: VIX1D < VIX < VIX9D', () => {
    // r1d = 12/20 = 0.60 (< 0.97), r9d = 22/20 = 1.10 (> 1.03)
    const { result } = renderHook(() =>
      useTermStructure({ vix: 20, vix1d: 12, vix9d: 22, vvix: 90 }),
    );

    expect(result.current.vixTermShape).toBe('contango');
    expect(result.current.vixTermShapeAdvice).toMatch(/contango/i);
    // classifyTermStructure ladders the calm/normal/elevated/extreme signal.
    expect(result.current.vixTermSignal).not.toBeNull();
  });

  it('classifies a near-term fear spike: VIX1D > VIX > VIX9D', () => {
    // r1d = 26/20 = 1.30 (> 1.03), r9d = 16/20 = 0.80 (< 0.97)
    const { result } = renderHook(() =>
      useTermStructure({ vix: 20, vix1d: 26, vix9d: 16, vvix: 130 }),
    );

    expect(result.current.vixTermShape).toBe('fear-spike');
    expect(result.current.vixTermShapeAdvice).toMatch(/fear spike/i);
  });

  it('classifies a flat curve when every ratio is within ±5%', () => {
    // r1d = 20/20 = 1.00, r9d = 20/20 = 1.00 → both flat.
    const { result } = renderHook(() =>
      useTermStructure({ vix: 20, vix1d: 20, vix9d: 20, vvix: 90 }),
    );

    expect(result.current.vixTermShape).toBe('flat');
    expect(result.current.vixTermShapeAdvice).toMatch(/flat/i);
  });

  it('classifies from VIX1D alone when VIX9D is absent', () => {
    // r1d = 26/20 = 1.30 (> 1.03) → backwardation on the VIX1D-only branch.
    const { result } = renderHook(() =>
      useTermStructure({
        vix: 20,
        vix1d: 26,
        vix9d: undefined,
        vvix: undefined,
      }),
    );

    expect(result.current.vixTermShape).toBe('backwardation');
    expect(result.current.vixTermSignal).not.toBeNull();
  });

  it('memoizes — identical inputs across renders return the same object', () => {
    const inputs = { vix: 20, vix1d: 12, vix9d: 22, vvix: 90 };
    const { result, rerender } = renderHook(
      (p: Parameters<typeof useTermStructure>[0]) => useTermStructure(p),
      { initialProps: inputs },
    );
    const first = result.current;
    rerender({ ...inputs });
    expect(result.current).toBe(first);
  });
});
