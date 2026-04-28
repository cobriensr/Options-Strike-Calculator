import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  checkIsOwner,
  clearHintCookies,
  hasHintCookie,
} from '../../utils/auth';

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

describe('hasHintCookie', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false with no hint cookies', () => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('theme=dark');
    expect(hasHintCookie()).toBe(false);
  });

  it('returns true when sc-hint is present', () => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue(
      'theme=dark; sc-hint=1',
    );
    expect(hasHintCookie()).toBe(true);
  });

  it('returns true when sc-guest-hint is present', () => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('sc-guest-hint=1');
    expect(hasHintCookie()).toBe(true);
  });

  it('does not match values that contain the cookie name as a substring', () => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('not-sc-hint=1');
    // present-as-substring would falsely match "sc-hint=" — verify the
    // `${name}=` anchor catches the boundary.
    expect(hasHintCookie()).toBe(false);
  });
});

describe('clearHintCookies', () => {
  let cookieWrites: string[];
  let setSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cookieWrites = [];
    setSpy = vi
      .spyOn(document, 'cookie', 'set')
      .mockImplementation((value: string) => {
        cookieWrites.push(value);
      });
  });

  afterEach(() => {
    setSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('writes Max-Age=0 expirations for both hint cookies', () => {
    clearHintCookies();
    expect(cookieWrites).toHaveLength(2);
    expect(cookieWrites[0]).toMatch(/^sc-hint=; Path=\/; Max-Age=0/);
    expect(cookieWrites[1]).toMatch(/^sc-guest-hint=; Path=\/; Max-Age=0/);
    for (const w of cookieWrites) {
      expect(w).toContain('SameSite=Strict');
    }
  });

  it('appends Secure when location is https', () => {
    Object.defineProperty(window, 'location', {
      value: { protocol: 'https:' },
      writable: true,
    });
    clearHintCookies();
    for (const w of cookieWrites) expect(w).toContain('; Secure');
  });

  it('omits Secure on http (local dev)', () => {
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:' },
      writable: true,
    });
    clearHintCookies();
    for (const w of cookieWrites) expect(w).not.toContain('Secure');
  });
});
