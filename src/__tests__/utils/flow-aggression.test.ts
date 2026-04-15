import { describe, it, expect } from 'vitest';
import {
  AGGRESSION_LABEL,
  AGGRESSION_THRESHOLDS,
  AGGRESSION_TOOLTIP,
  classifyAggression,
} from '../../utils/flow-aggression';

describe('classifyAggression', () => {
  it('classifies 0.95 as aggressive', () => {
    expect(classifyAggression(0.95)).toBe('aggressive');
  });

  it('treats the aggressive threshold (0.70) as inclusive', () => {
    expect(classifyAggression(AGGRESSION_THRESHOLDS.AGGRESSIVE)).toBe(
      'aggressive',
    );
    expect(classifyAggression(0.7)).toBe('aggressive');
  });

  it('classifies 0.50 as mixed', () => {
    expect(classifyAggression(0.5)).toBe('mixed');
  });

  it('treats the absorbed threshold (0.30) as inclusive', () => {
    expect(classifyAggression(AGGRESSION_THRESHOLDS.ABSORBED)).toBe('absorbed');
    expect(classifyAggression(0.3)).toBe('absorbed');
  });

  it('classifies 0.05 as absorbed', () => {
    expect(classifyAggression(0.05)).toBe('absorbed');
  });

  it('classifies the 0 boundary as absorbed', () => {
    expect(classifyAggression(0)).toBe('absorbed');
  });

  it('classifies the 1 boundary as aggressive', () => {
    expect(classifyAggression(1)).toBe('aggressive');
  });

  it('returns null when askSideRatio is null (missing data)', () => {
    // Before this guard, null→0 coerced to "absorbed", making missing-data
    // rows visually indistinguishable from truly-absorbed ones.
    expect(classifyAggression(null)).toBeNull();
  });

  it('exposes labels for every variant', () => {
    expect(AGGRESSION_LABEL.aggressive).toBe('AGG');
    expect(AGGRESSION_LABEL.absorbed).toBe('ABS');
    expect(AGGRESSION_LABEL.mixed).toBe('—');
  });

  it('exposes tooltips for every variant', () => {
    expect(AGGRESSION_TOOLTIP.aggressive).toMatch(/buyer/i);
    expect(AGGRESSION_TOOLTIP.absorbed).toMatch(/seller|hedg/i);
    expect(AGGRESSION_TOOLTIP.mixed).toMatch(/mixed|unclear/i);
  });
});
