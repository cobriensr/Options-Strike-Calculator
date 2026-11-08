// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { zeroGammaLabelTs } from '../_lib/zero-gamma-label.js';

describe('zeroGammaLabelTs', () => {
  it.each([
    ['2026-03-24T13:50:00.000Z', '2026-03-24T13:55:00.000Z'],
    ['2026-03-24T13:55:00Z', '2026-03-24T14:00:00.000Z'],
    // The close bucket stays on its own ET day: 15:55 ET -> 16:00 ET.
    ['2026-03-24T19:55:00.000Z', '2026-03-24T20:00:00.000Z'],
    // Across the UTC midnight (20:55 ET in winter).
    ['2026-01-06T23:55:00.000Z', '2026-01-07T00:00:00.000Z'],
  ])('%s -> %s: the end of the bucket', (ladder, label) => {
    expect(zeroGammaLabelTs(ladder)).toBe(label);
  });

  it('is never earlier than a moment inside the bucket, so no reader sees the row before its data', () => {
    // A ladder observed at 13:53:30 is stamped 13:50:00 (the floor); its
    // label 13:55:00 is after the observation.
    const observed = Date.parse('2026-03-24T13:53:30.000Z');
    const label = Date.parse(zeroGammaLabelTs('2026-03-24T13:50:00.000Z'));
    expect(label).toBeGreaterThan(observed);
  });

  it('is deterministic: one ladder, one key', () => {
    const a = zeroGammaLabelTs('2026-03-24T13:50:00.000Z');
    expect(zeroGammaLabelTs('2026-03-24T13:50:00.000Z')).toBe(a);
    expect(zeroGammaLabelTs('2026-03-24T13:55:00.000Z')).not.toBe(a);
  });

  it('throws on an unparseable timestamp rather than minting a key', () => {
    expect(() => zeroGammaLabelTs('garbage')).toThrow(RangeError);
  });
});
