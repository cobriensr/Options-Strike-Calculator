// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  applyEmpiricalBonuses,
  VOL_TO_OI_WINDOW_BONUS_THRESHOLD,
  VOL_TO_OI_WINDOW_BONUS_POINTS,
} from '../_lib/lottery-score-bonuses.js';

describe('applyEmpiricalBonuses', () => {
  it('returns the base score unchanged when triggerVolToOiWindow is null', () => {
    expect(
      applyEmpiricalBonuses({ baseScore: 15, triggerVolToOiWindow: null }),
    ).toBe(15);
  });

  it('returns the base score unchanged when triggerVolToOiWindow is below threshold', () => {
    expect(
      applyEmpiricalBonuses({
        baseScore: 15,
        triggerVolToOiWindow: VOL_TO_OI_WINDOW_BONUS_THRESHOLD - 0.01,
      }),
    ).toBe(15);
  });

  it('adds the bonus when triggerVolToOiWindow equals the threshold', () => {
    expect(
      applyEmpiricalBonuses({
        baseScore: 15,
        triggerVolToOiWindow: VOL_TO_OI_WINDOW_BONUS_THRESHOLD,
      }),
    ).toBe(15 + VOL_TO_OI_WINDOW_BONUS_POINTS);
  });

  it('adds the bonus when triggerVolToOiWindow is well above the threshold', () => {
    expect(
      applyEmpiricalBonuses({ baseScore: 12, triggerVolToOiWindow: 5.0 }),
    ).toBe(13);
  });

  it('can push a tier-3-boundary score into tier 2', () => {
    // Base 11 (tier 3 — threshold is ≥12) + vol/OI bonus → 12 (tier 2).
    const adjusted = applyEmpiricalBonuses({
      baseScore: 11,
      triggerVolToOiWindow: 0.8,
    });
    expect(adjusted).toBe(12);
  });
});
