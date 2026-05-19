import { describe, expect, it } from 'vitest';

import { classifyRow } from '../components/Gexbot/strike-mover-ladder/colors';

describe('classifyRow', () => {
  const SPOT = 6750;

  it('classifies below-spot positive Δ as floor strengthening (emerald)', () => {
    const r = classifyRow(6700, SPOT, 1_600);
    expect(r.side).toBe('below');
    expect(r.tone).toBe('strengthening');
    expect(r.toneClass).toBe('text-emerald-300');
    expect(r.marker).toBeNull();
  });

  it('classifies below-spot negative Δ as floor weakening (amber + ▽)', () => {
    const r = classifyRow(6700, SPOT, -199);
    expect(r.side).toBe('below');
    expect(r.tone).toBe('weakening');
    expect(r.toneClass).toBe('text-amber-300');
    expect(r.marker).toBe('▽');
  });

  it('classifies above-spot negative Δ as ceiling strengthening (rose)', () => {
    const r = classifyRow(6800, SPOT, -820);
    expect(r.side).toBe('above');
    expect(r.tone).toBe('strengthening');
    expect(r.toneClass).toBe('text-rose-300');
    expect(r.marker).toBeNull();
  });

  it('classifies above-spot positive Δ as ceiling weakening (yellow + ▽)', () => {
    const r = classifyRow(6800, SPOT, 164);
    expect(r.side).toBe('above');
    expect(r.tone).toBe('weakening');
    expect(r.toneClass).toBe('text-yellow-300');
    expect(r.marker).toBe('▽');
  });

  it('classifies a strike within ±0.25% as ATM magnet (violet + ◈ ATM)', () => {
    // Spot 6750 → band ±16.875. 6760 is inside the band.
    const r = classifyRow(6760, SPOT, 2_100);
    expect(r.side).toBe('atm');
    expect(r.tone).toBe('magnet');
    expect(r.toneClass).toBe('text-violet-300');
    expect(r.marker).toBe('◈ ATM');
  });

  it('classifies the exact-spot strike as ATM regardless of Δ sign', () => {
    const positive = classifyRow(6750, SPOT, 100);
    const negative = classifyRow(6750, SPOT, -100);
    expect(positive.side).toBe('atm');
    expect(negative.side).toBe('atm');
  });

  it('treats Δ === 0 below spot as weakening (no positive contribution)', () => {
    const r = classifyRow(6700, SPOT, 0);
    expect(r.side).toBe('below');
    expect(r.tone).toBe('weakening');
  });

  it('treats Δ === 0 above spot as strengthening (no positive contribution)', () => {
    const r = classifyRow(6800, SPOT, 0);
    expect(r.side).toBe('above');
    expect(r.tone).toBe('strengthening');
  });
});
