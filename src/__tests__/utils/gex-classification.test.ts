import { describe, it, expect } from 'vitest';
import {
  classSignal,
  type GexClassification,
  type Direction,
} from '../../utils/gex-classification';

describe('classSignal', () => {
  it('returns Max Launchpad signals for max-launchpad', () => {
    expect(classSignal('max-launchpad', 'ceiling')).toBe(
      'Ceiling Breakout Risk',
    );
    expect(classSignal('max-launchpad', 'floor')).toBe('Floor Collapse Risk');
    expect(classSignal('max-launchpad', 'atm')).toBe('Launch Zone');
  });

  it('returns Fading Launchpad signals for fading-launchpad', () => {
    expect(classSignal('fading-launchpad', 'ceiling')).toBe(
      'Weakening Ceiling',
    );
    expect(classSignal('fading-launchpad', 'floor')).toBe('Weakening Floor');
    expect(classSignal('fading-launchpad', 'atm')).toBe('Fading Launch');
  });

  it('returns Sticky Pin signals for sticky-pin', () => {
    expect(classSignal('sticky-pin', 'ceiling')).toBe('Hard Ceiling');
    expect(classSignal('sticky-pin', 'floor')).toBe('Hard Floor');
    expect(classSignal('sticky-pin', 'atm')).toBe('Pin Zone');
  });

  it('returns Weakening Pin signals for weakening-pin', () => {
    expect(classSignal('weakening-pin', 'ceiling')).toBe('Softening Ceiling');
    expect(classSignal('weakening-pin', 'floor')).toBe('Softening Floor');
    expect(classSignal('weakening-pin', 'atm')).toBe('Weak Pin');
  });

  it('covers all 12 (classification × direction) combinations distinctly', () => {
    // Drift guard: every (cls, dir) pair must produce a unique label.
    // Catches accidental collapse (e.g., all four ceiling labels becoming
    // identical) which would silently break the GexLandscape strike-table
    // semantics or the daemon's persisted signal field.
    const classes: GexClassification[] = [
      'max-launchpad',
      'fading-launchpad',
      'sticky-pin',
      'weakening-pin',
    ];
    const directions: Direction[] = ['ceiling', 'floor', 'atm'];
    const labels = new Set<string>();
    for (const cls of classes) {
      for (const dir of directions) {
        labels.add(classSignal(cls, dir));
      }
    }
    expect(labels.size).toBe(12);
  });
});
