import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkIsOwner } from '../../utils/auth';

describe('checkIsOwner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true in dev mode', () => {
    // import.meta.env.DEV is true in vitest by default
    expect(checkIsOwner()).toBe(true);
  });

  it('returns false when DEV is false and no sc-hint cookie', () => {
    const origDev = import.meta.env.DEV;
    try {
      (import.meta.env as Record<string, unknown>).DEV = false;
      vi.spyOn(document, 'cookie', 'get').mockReturnValue('');
      expect(checkIsOwner()).toBe(false);
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
      expect(checkIsOwner()).toBe(true);
    } finally {
      (import.meta.env as Record<string, unknown>).DEV = origDev;
    }
  });
});
