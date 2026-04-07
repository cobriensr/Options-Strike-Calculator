import { describe, it, expect } from 'vitest';
import {
  signalColor,
  confidenceColor,
  structureColor,
} from '../../components/ChartAnalysis/analysis-helpers';
import { theme } from '../../themes';

describe('signalColor', () => {
  describe('bearish-coded signals → red', () => {
    it.each([
      'BEARISH',
      'CONTRADICTS',
      'UNFAVORABLE',
      'DECAYING',
      'NEGATIVE',
      'RISK_OFF',
      'HEADWIND',
      'HIGH',
      'STEEP_PUT',
    ])('maps %s to red', (signal) => {
      expect(signalColor(signal)).toBe(theme.red);
    });
  });

  describe('bullish-coded signals → green', () => {
    it.each([
      'BULLISH',
      'CONFIRMS',
      'FAVORABLE',
      'SUPPORTIVE',
      'POSITIVE',
      'RISK_ON',
      'TAILWIND',
      'LOW',
      'FLAT',
    ])('maps %s to green', (signal) => {
      expect(signalColor(signal)).toBe(theme.green);
    });
  });

  describe('neutral signals → muted', () => {
    it.each(['NEUTRAL', 'NOT PROVIDED'])('maps %s to textMuted', (signal) => {
      expect(signalColor(signal)).toBe(theme.textMuted);
    });
  });

  describe('ambiguous signals → caution (default)', () => {
    // These signal values are non-directional or context-dependent.
    // They fall through to the caution color so the user reads the note.
    it.each([
      'MIXED',
      'CONFLICTED',
      'SYMMETRIC',
      'MODERATE',
      'GAP_EXTENDS',
      'GAP_FILL_LIKELY',
    ])('maps %s to caution', (signal) => {
      expect(signalColor(signal)).toBe(theme.caution);
    });
  });

  it('maps unknown signals to caution as a safe default', () => {
    expect(signalColor('SOMETHING_UNEXPECTED')).toBe(theme.caution);
    expect(signalColor('')).toBe(theme.caution);
  });
});

describe('confidenceColor', () => {
  it('maps HIGH to green', () => {
    expect(confidenceColor('HIGH')).toBe(theme.green);
  });

  it('maps MODERATE to caution', () => {
    expect(confidenceColor('MODERATE')).toBe(theme.caution);
  });

  it('maps LOW (and any other value) to red', () => {
    expect(confidenceColor('LOW')).toBe(theme.red);
    expect(confidenceColor('UNKNOWN')).toBe(theme.red);
  });
});

describe('structureColor', () => {
  it('maps IRON CONDOR to accent', () => {
    expect(structureColor('IRON CONDOR')).toBe(theme.accent);
  });

  it('maps PUT CREDIT SPREAD to red', () => {
    expect(structureColor('PUT CREDIT SPREAD')).toBe(theme.red);
  });

  it('maps CALL CREDIT SPREAD to green', () => {
    expect(structureColor('CALL CREDIT SPREAD')).toBe(theme.green);
  });

  it('maps SIT OUT (and unknown values) to caution', () => {
    expect(structureColor('SIT OUT')).toBe(theme.caution);
    expect(structureColor('UNKNOWN')).toBe(theme.caution);
  });
});
