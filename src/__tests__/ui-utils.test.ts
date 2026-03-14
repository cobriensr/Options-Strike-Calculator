import { describe, it, expect } from 'vitest';
import {
  buildChevronUrl,
  mkTh,
  mkTd,
  fmtDollar,
  tinyLbl,
} from '../utils/ui-utils';

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
