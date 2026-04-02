import { describe, it, expect, vi, afterEach } from 'vitest';
import { useIsOwner } from '../../hooks/useIsOwner';

describe('useIsOwner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true in dev mode', () => {
    // import.meta.env.DEV is true in vitest by default
    expect(useIsOwner()).toBe(true);
  });

  it('returns false when DEV is false and no sc-hint cookie', () => {
    const origDev = import.meta.env.DEV;
    try {
      (import.meta.env as Record<string, unknown>).DEV = false;
      vi.spyOn(document, 'cookie', 'get').mockReturnValue('');
      expect(useIsOwner()).toBe(false);
    } finally {
      (import.meta.env as Record<string, unknown>).DEV = origDev;
    }
  });

  it('returns true when DEV is false but sc-hint cookie exists', () => {
    const origDev = import.meta.env.DEV;
    try {
      (import.meta.env as Record<string, unknown>).DEV = false;
      vi.spyOn(document, 'cookie', 'get').mockReturnValue(
        'theme=dark; sc-hint=1',
      );
      expect(useIsOwner()).toBe(true);
    } finally {
      (import.meta.env as Record<string, unknown>).DEV = origDev;
    }
  });
});
