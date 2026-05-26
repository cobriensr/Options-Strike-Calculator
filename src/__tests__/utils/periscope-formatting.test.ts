import { describe, it, expect } from 'vitest';
import {
  fmtSigned,
  fmtPts,
  colorForValue,
  asymmetryLabel,
  verdictColor,
  regimeColor,
  fmtLevel,
} from '../../utils/periscope-formatting';
import { theme } from '../../themes';

describe('fmtSigned', () => {
  it('formats >=1M positive with +M suffix', () => {
    expect(fmtSigned(2_500_000)).toBe('+2.50M');
  });
  it('formats >=1M negative with leading minus and M suffix', () => {
    expect(fmtSigned(-2_500_000)).toBe('-2.50M');
  });
  it('formats >=1K positive with +K suffix', () => {
    expect(fmtSigned(12_345)).toBe('+12.3K');
  });
  it('formats >=1K negative with leading minus and K suffix', () => {
    expect(fmtSigned(-12_345)).toBe('-12.3K');
  });
  it('formats sub-1K positive with no suffix', () => {
    expect(fmtSigned(42)).toBe('+42');
  });
  it('formats sub-1K negative with no suffix', () => {
    expect(fmtSigned(-42)).toBe('-42');
  });
  it('formats zero as +0 (matches >=0 sign branch)', () => {
    expect(fmtSigned(0)).toBe('+0');
  });
  it('uses M suffix at exactly 1M', () => {
    expect(fmtSigned(1_000_000)).toBe('+1.00M');
  });
  it('uses K suffix at exactly 1K', () => {
    expect(fmtSigned(1_000)).toBe('+1.0K');
  });
});

describe('fmtPts', () => {
  it('renders positive points with leading +', () => {
    expect(fmtPts(7)).toBe('+7');
  });
  it('renders negative points with leading minus (no extra +)', () => {
    expect(fmtPts(-3)).toBe('-3');
  });
  it('renders zero as +0', () => {
    expect(fmtPts(0)).toBe('+0');
  });
  it('rounds to integer', () => {
    expect(fmtPts(2.7)).toBe('+3');
    expect(fmtPts(-2.7)).toBe('-3');
  });
});

describe('colorForValue', () => {
  it('returns green for positive', () => {
    expect(colorForValue(5)).toBe(theme.green);
  });
  it('returns red for negative', () => {
    expect(colorForValue(-5)).toBe(theme.red);
  });
  it('returns textSecondary for zero', () => {
    expect(colorForValue(0)).toBe(theme.textSecondary);
  });
});

describe('asymmetryLabel', () => {
  it('labels positive pts as lower-skewed', () => {
    expect(asymmetryLabel(3)).toBe('lower-skewed (downside priced richer)');
  });
  it('labels negative pts as upper-skewed', () => {
    expect(asymmetryLabel(-3)).toBe('upper-skewed (upside priced richer)');
  });
  it('labels zero as symmetric', () => {
    expect(asymmetryLabel(0)).toBe('symmetric');
  });
});

describe('verdictColor', () => {
  it('maps safe to green', () => {
    expect(verdictColor('safe')).toBe(theme.green);
  });
  it('maps conditional to caution', () => {
    expect(verdictColor('conditional')).toBe(theme.caution);
  });
  it('maps avoid to red', () => {
    expect(verdictColor('avoid')).toBe(theme.red);
  });
});

describe('regimeColor', () => {
  it('maps cone-breach-up to green', () => {
    expect(regimeColor('cone-breach-up')).toBe(theme.green);
  });
  it('maps cone-breach-down to red', () => {
    expect(regimeColor('cone-breach-down')).toBe(theme.red);
  });
  it('maps pin to accent', () => {
    expect(regimeColor('pin')).toBe(theme.accent);
  });
  it('maps drift-and-cap to text', () => {
    expect(regimeColor('drift-and-cap')).toBe(theme.text);
  });
  it('falls through to textMuted for chop', () => {
    expect(regimeColor('chop')).toBe(theme.textMuted);
  });
  it('falls through to textMuted for no-data', () => {
    expect(regimeColor('no-data')).toBe(theme.textMuted);
  });
});

describe('fmtLevel', () => {
  it('renders em-dash for null', () => {
    expect(fmtLevel(null)).toBe('—');
  });
  it('rounds non-null to integer string', () => {
    expect(fmtLevel(6912.7)).toBe('6913');
  });
  it('renders zero as 0', () => {
    expect(fmtLevel(0)).toBe('0');
  });
  it('renders negative levels with leading minus', () => {
    expect(fmtLevel(-42.3)).toBe('-42');
  });
});
