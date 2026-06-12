import { describe, it, expect } from 'vitest';
import {
  buildChevronUrl,
  chevronColorForTheme,
  CHEVRON_COLOR_LIGHT,
  CHEVRON_COLOR_DARK,
  mkTh,
  mkTd,
  tinyLbl,
  tintedSurface,
} from '../../utils/ui-utils';

describe('buildChevronUrl', () => {
  it('returns a data URI string', () => {
    const result = buildChevronUrl('#333');
    expect(result).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(result).toContain(encodeURIComponent('#333'));
  });

  it('encodes the color into the SVG', () => {
    const result = buildChevronUrl('#ff0000');
    expect(result).toContain(encodeURIComponent('#ff0000'));
  });

  it('does not read getComputedStyle (no render-time style read)', () => {
    // AUD-M21: the chevron color must be passed in already-resolved, never
    // read from computed styles during render. Fail loudly if anything tries.
    const original = globalThis.getComputedStyle;
    globalThis.getComputedStyle = (() => {
      throw new Error('buildChevronUrl must not call getComputedStyle');
    }) as typeof globalThis.getComputedStyle;
    try {
      expect(() => buildChevronUrl('var(--color-chevron)')).not.toThrow();
    } finally {
      globalThis.getComputedStyle = original;
    }
  });
});

describe('chevronColorForTheme (AUD-M21: reflects CURRENT theme)', () => {
  it('returns the dark chevron color when darkMode is true', () => {
    expect(chevronColorForTheme(true)).toBe(CHEVRON_COLOR_DARK);
  });

  it('returns the light chevron color when darkMode is false', () => {
    expect(chevronColorForTheme(false)).toBe(CHEVRON_COLOR_LIGHT);
  });

  it('the two theme colors are distinct', () => {
    expect(CHEVRON_COLOR_DARK).not.toBe(CHEVRON_COLOR_LIGHT);
  });

  it('toggling the theme flips the baked chevron color on the SAME call', () => {
    // Pins the fix: the URL is derived from the darkMode flag, so flipping
    // the flag immediately yields the other theme's color — no lag behind
    // the `.dark` class toggle (which is applied in a post-render effect).
    const darkUrl = buildChevronUrl(chevronColorForTheme(true));
    const lightUrl = buildChevronUrl(chevronColorForTheme(false));

    expect(darkUrl).toContain(encodeURIComponent(CHEVRON_COLOR_DARK));
    expect(darkUrl).not.toContain(encodeURIComponent(CHEVRON_COLOR_LIGHT));
    expect(lightUrl).toContain(encodeURIComponent(CHEVRON_COLOR_LIGHT));
    expect(lightUrl).not.toContain(encodeURIComponent(CHEVRON_COLOR_DARK));
    expect(darkUrl).not.toBe(lightUrl);
  });
});

describe('mkTh', () => {
  it('returns text-center for center alignment', () => {
    expect(mkTh('center')).toContain('text-center');
  });

  it('returns text-right for right alignment', () => {
    expect(mkTh('right')).toContain('text-right');
  });

  it('returns text-left for left alignment', () => {
    expect(mkTh('left')).toContain('text-left');
  });

  it('uses text-tertiary by default', () => {
    expect(mkTh('center')).toContain('text-tertiary');
  });

  it('uses custom color class when provided', () => {
    const result = mkTh('center', 'text-danger');
    expect(result).toContain('text-danger');
    expect(result).not.toContain('text-tertiary');
  });
});

describe('mkTd', () => {
  it('returns table cell classes', () => {
    const result = mkTd();
    expect(result).toContain('px-3');
    expect(result).toContain('py-2.5');
    expect(result).toContain('border-b');
  });
});

describe('tinyLbl', () => {
  it('is a string with label classes', () => {
    expect(typeof tinyLbl).toBe('string');
    expect(tinyLbl).toContain('text-[10px]');
    expect(tinyLbl).toContain('font-bold');
    expect(tinyLbl).toContain('uppercase');
  });
});

describe('tintedSurface', () => {
  it('returns a color-mix expression in srgb', () => {
    const result = tintedSurface('#ff0000', 20, '#ffffff');
    expect(result).toMatch(/^color-mix\(in srgb,/);
  });

  it('mixes the accent toward the surface color (not transparent)', () => {
    // This is the key behavioral difference from tint() — the second color
    // in the mix must be the surface, not `transparent`. Without this
    // guarantee the result would be a transparency cutout, not a readable
    // opaque panel.
    const result = tintedSurface('#ff0000', 20, '#ffffff');
    expect(result).toContain('#ffffff');
    expect(result).not.toContain('transparent');
  });

  it('preserves the percentage on the accent color', () => {
    expect(tintedSurface('#ff0000', 16, '#242430')).toBe(
      'color-mix(in srgb, #ff0000 16%, #242430)',
    );
  });

  it('accepts CSS var() references for both accent and surface', () => {
    const result = tintedSurface(
      'var(--color-danger)',
      28,
      'var(--color-surface)',
    );
    expect(result).toBe(
      'color-mix(in srgb, var(--color-danger) 28%, var(--color-surface))',
    );
  });

  it('handles 0% and 100% without special-casing', () => {
    expect(tintedSurface('#ff0000', 0, '#ffffff')).toBe(
      'color-mix(in srgb, #ff0000 0%, #ffffff)',
    );
    expect(tintedSurface('#ff0000', 100, '#ffffff')).toBe(
      'color-mix(in srgb, #ff0000 100%, #ffffff)',
    );
  });
});
