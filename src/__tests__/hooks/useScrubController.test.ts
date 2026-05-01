/**
 * Tests for `useScrubController` — generic scrub state machine.
 *
 * Covers the same transitions exercised by the original inline scrub state
 * in `useGexPerStrike` and `useGexTarget`, plus a few extra edge cases the
 * generic version surfaces:
 *   - empty timestamp list (everything is a no-op)
 *   - single-element list (scrubPrev is a no-op, scrubNext from null is a no-op)
 *   - scrub past end (scrubNext from idx >= length-2 clears scrub)
 *   - scrubTo unknown ts (no-op)
 *   - timestamps shrinking out from under a pinned scrub (defensive clear)
 *   - numeric timestamp generic instantiation
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useScrubController } from '../../hooks/useScrubController';

describe('useScrubController: empty / single-element', () => {
  it('returns live defaults for an empty list', () => {
    const { result } = renderHook(() => useScrubController<string>([]));
    expect(result.current.scrubTimestamp).toBeNull();
    expect(result.current.isScrubbed).toBe(false);
    expect(result.current.canScrubPrev).toBe(false);
    expect(result.current.canScrubNext).toBe(false);
  });

  it('scrubPrev on empty list is a no-op', () => {
    const { result } = renderHook(() => useScrubController<string>([]));
    act(() => {
      result.current.scrubPrev();
    });
    expect(result.current.scrubTimestamp).toBeNull();
    expect(result.current.isScrubbed).toBe(false);
  });

  it('scrubPrev on single-element list is a no-op', () => {
    const { result } = renderHook(() => useScrubController(['t1']));
    act(() => {
      result.current.scrubPrev();
    });
    expect(result.current.scrubTimestamp).toBeNull();
  });

  it('canScrubPrev is false on single-element list', () => {
    const { result } = renderHook(() => useScrubController(['t1']));
    expect(result.current.canScrubPrev).toBe(false);
  });
});

describe('useScrubController: scrubPrev / scrubNext (string ts)', () => {
  const TS = ['t1', 't2', 't3', 't4'] as const;

  it('scrubPrev from live steps to second-to-last (t3)', () => {
    const { result } = renderHook(() => useScrubController([...TS]));
    act(() => {
      result.current.scrubPrev();
    });
    expect(result.current.scrubTimestamp).toBe('t3');
    expect(result.current.isScrubbed).toBe(true);
  });

  it('scrubPrev from a scrubbed position steps one earlier', () => {
    const { result } = renderHook(() => useScrubController([...TS]));
    act(() => {
      result.current.scrubPrev(); // → t3
    });
    act(() => {
      result.current.scrubPrev(); // → t2
    });
    expect(result.current.scrubTimestamp).toBe('t2');
    act(() => {
      result.current.scrubPrev(); // → t1
    });
    expect(result.current.scrubTimestamp).toBe('t1');
  });

  it('scrubPrev at idx=0 is a no-op (cannot go below first ts)', () => {
    const { result } = renderHook(() => useScrubController([...TS]));
    act(() => {
      result.current.scrubPrev(); // → t3
      result.current.scrubPrev(); // → t2
      result.current.scrubPrev(); // → t1
    });
    expect(result.current.scrubTimestamp).toBe('t1');
    expect(result.current.canScrubPrev).toBe(false);
    act(() => {
      result.current.scrubPrev();
    });
    expect(result.current.scrubTimestamp).toBe('t1');
  });

  it('scrubNext from a mid-list scrub advances by one', () => {
    // Need a 5-element list so idx=0 < length-2 (=3) lets scrubNext step,
    // not clear. With 4 elements, scrubPrev from t4→t3, scrubNext idx=2,
    // length-2=2 → clears. We use 5 to exercise the "step forward" branch.
    const FIVE = ['t1', 't2', 't3', 't4', 't5'];
    const { result } = renderHook(() => useScrubController(FIVE));
    act(() => {
      result.current.scrubPrev(); // → t4
      result.current.scrubPrev(); // → t3
      result.current.scrubPrev(); // → t2
      result.current.scrubPrev(); // → t1
    });
    expect(result.current.scrubTimestamp).toBe('t1');
    act(() => {
      result.current.scrubNext(); // idx=0 < length-2=3, advances → t2
    });
    expect(result.current.scrubTimestamp).toBe('t2');
  });

  it('scrubNext at idx >= length-2 clears scrub (resumes live)', () => {
    const { result } = renderHook(() => useScrubController([...TS]));
    act(() => {
      result.current.scrubPrev(); // → t3 (idx=2, length=4, length-2=2 → clears next)
    });
    expect(result.current.scrubTimestamp).toBe('t3');
    act(() => {
      result.current.scrubNext();
    });
    expect(result.current.scrubTimestamp).toBeNull();
    expect(result.current.isScrubbed).toBe(false);
  });

  it('scrubNext from live (null) stays at null', () => {
    const { result } = renderHook(() => useScrubController([...TS]));
    act(() => {
      result.current.scrubNext();
    });
    expect(result.current.scrubTimestamp).toBeNull();
  });
});

describe('useScrubController: scrubTo', () => {
  const TS = ['a', 'b', 'c'];

  it('jumping to the latest ts resumes live', () => {
    const { result } = renderHook(() => useScrubController(TS));
    act(() => {
      result.current.scrubPrev(); // → 'b'
    });
    act(() => {
      result.current.scrubTo('c'); // latest → live
    });
    expect(result.current.scrubTimestamp).toBeNull();
  });

  it('jumping to a known mid-list ts pins it', () => {
    const { result } = renderHook(() => useScrubController(TS));
    act(() => {
      result.current.scrubTo('a');
    });
    expect(result.current.scrubTimestamp).toBe('a');
  });

  it('jumping to an unknown ts is a no-op', () => {
    const { result } = renderHook(() => useScrubController(TS));
    act(() => {
      result.current.scrubTo('zzz');
    });
    expect(result.current.scrubTimestamp).toBeNull();
  });
});

describe('useScrubController: scrubLive', () => {
  it('clears scrub state', () => {
    const { result } = renderHook(() => useScrubController(['t1', 't2', 't3']));
    act(() => {
      result.current.scrubPrev();
    });
    expect(result.current.isScrubbed).toBe(true);
    act(() => {
      result.current.scrubLive();
    });
    expect(result.current.scrubTimestamp).toBeNull();
    expect(result.current.isScrubbed).toBe(false);
  });

  it('is a no-op when already live', () => {
    const { result } = renderHook(() => useScrubController(['t1', 't2', 't3']));
    expect(result.current.scrubTimestamp).toBeNull();
    act(() => {
      result.current.scrubLive();
    });
    expect(result.current.scrubTimestamp).toBeNull();
  });
});

describe('useScrubController: timestamps churn defensive clear', () => {
  it('clears scrub when the pinned ts disappears from the list', () => {
    const { result, rerender } = renderHook(
      ({ ts }: { ts: string[] }) => useScrubController(ts),
      { initialProps: { ts: ['t1', 't2', 't3'] } },
    );
    act(() => {
      result.current.scrubPrev(); // → t2
    });
    expect(result.current.scrubTimestamp).toBe('t2');

    // Date change in the consumer hooks shrinks/swaps the timestamps array.
    // Defensive clear should null the scrub since 't2' is no longer present.
    rerender({ ts: ['x1', 'x2'] });
    expect(result.current.scrubTimestamp).toBeNull();
  });

  it('preserves scrub when pinned ts is still present after churn', () => {
    const { result, rerender } = renderHook(
      ({ ts }: { ts: string[] }) => useScrubController(ts),
      { initialProps: { ts: ['t1', 't2', 't3'] } },
    );
    act(() => {
      result.current.scrubPrev(); // → t2
    });
    rerender({ ts: ['t1', 't2', 't3', 't4'] }); // a new ts appended
    expect(result.current.scrubTimestamp).toBe('t2');
  });
});

describe('useScrubController: numeric timestamp generic', () => {
  it('works with numeric epoch ms timestamps', () => {
    const TS = [1000, 2000, 3000];
    const { result } = renderHook(() => useScrubController<number>(TS));
    act(() => {
      result.current.scrubPrev(); // → 2000
    });
    expect(result.current.scrubTimestamp).toBe(2000);
    act(() => {
      result.current.scrubTo(1000);
    });
    expect(result.current.scrubTimestamp).toBe(1000);
    act(() => {
      result.current.scrubTo(3000); // latest → live
    });
    expect(result.current.scrubTimestamp).toBeNull();
  });
});

describe('useScrubController: canScrubPrev / canScrubNext flags', () => {
  it('canScrubPrev is true on live with multi-element list', () => {
    const { result } = renderHook(() => useScrubController(['t1', 't2']));
    expect(result.current.canScrubPrev).toBe(true);
    expect(result.current.canScrubNext).toBe(false);
  });

  it('canScrubNext is true while scrubbed', () => {
    const { result } = renderHook(() => useScrubController(['t1', 't2', 't3']));
    act(() => {
      result.current.scrubPrev();
    });
    expect(result.current.canScrubNext).toBe(true);
  });
});
