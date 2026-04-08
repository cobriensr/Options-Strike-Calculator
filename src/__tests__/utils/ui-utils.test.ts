import { describe, it, expect, vi } from 'vitest';
import {
  buildChevronUrl,
  mkTh,
  mkTd,
  fmtDollar,
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

  it('resolves CSS var() via getComputedStyle', () => {
    const spy = vi
      .spyOn(globalThis, 'getComputedStyle')
      .mockReturnValue({ getPropertyValue: () => '  #abcdef  ' } as any);
    const result = buildChevronUrl('var(--color-chevron)');
    expect(result).toContain(encodeURIComponent('#abcdef'));
    spy.mockRestore();
  });

  it('falls back to original var() when computed value is empty', () => {
    const spy = vi
      .spyOn(globalThis, 'getComputedStyle')
      .mockReturnValue({ getPropertyValue: () => '  ' } as any);
    const result = buildChevronUrl('var(--missing)');
    expect(result).toContain(encodeURIComponent('var(--missing)'));
    spy.mockRestore();
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

describe('fmtDollar', () => {
  it('rounds and formats large values without cents', () => {
    expect(fmtDollar(1234)).toBe('1,234');
  });

  it('formats small values with two decimal places', () => {
    expect(fmtDollar(42.5)).toBe('42.50');
  });

  it('formats exactly 100 without cents', () => {
    expect(fmtDollar(100)).toBe('100');
  });

  it('formats 99.99 with cents', () => {
    expect(fmtDollar(99.99)).toBe('99.99');
  });

  it('handles negative large values', () => {
    expect(fmtDollar(-500)).toBe('-500');
  });

  it('handles negative small values', () => {
    expect(fmtDollar(-42.5)).toBe('-42.50');
  });

  it('handles zero', () => {
    expect(fmtDollar(0)).toBe('0.00');
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
