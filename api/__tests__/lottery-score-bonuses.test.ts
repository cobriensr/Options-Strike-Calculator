// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  applyEmpiricalBonuses,
  VOL_TO_OI_WINDOW_BONUS_THRESHOLD,
  VOL_TO_OI_WINDOW_BONUS_POINTS,
  RANGE_KILL_THRESHOLD,
  RANGE_KILL_PENALTY_POINTS,
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

  it('leaves the score unchanged when rangePosAtTrigger is null', () => {
    expect(
      applyEmpiricalBonuses({
        baseScore: 15,
        triggerVolToOiWindow: null,
        rangePosAtTrigger: null,
      }),
    ).toBe(15);
  });

  it('leaves the score unchanged when rangePosAtTrigger is at the threshold', () => {
    // Threshold is strict < 0.10, so 0.10 itself is NOT penalized.
    expect(
      applyEmpiricalBonuses({
        baseScore: 15,
        triggerVolToOiWindow: null,
        rangePosAtTrigger: RANGE_KILL_THRESHOLD,
      }),
    ).toBe(15);
  });

  it('applies the -3 penalty when rangePosAtTrigger is below 0.10', () => {
    expect(
      applyEmpiricalBonuses({
        baseScore: 15,
        triggerVolToOiWindow: null,
        rangePosAtTrigger: 0.05,
      }),
    ).toBe(15 - RANGE_KILL_PENALTY_POINTS);
  });

  it('combines vol/OI bonus and range-kill penalty additively', () => {
    // +1 vol/OI bonus, -3 range-kill penalty → net -2.
    expect(
      applyEmpiricalBonuses({
        baseScore: 15,
        triggerVolToOiWindow: 1.5,
        rangePosAtTrigger: 0.02,
      }),
    ).toBe(15 + VOL_TO_OI_WINDOW_BONUS_POINTS - RANGE_KILL_PENALTY_POINTS);
  });

  it('can demote a tier-2 fire below the tier-3 cutoff via range-kill', () => {
    // Base 14 (tier 2) - 3 → 11 (tier 3 — below the 12 cutoff). This
    // is the suppression mechanism: bottom-10% range fires drop out
    // of the tier-2 conviction filter without explicit code paths.
    expect(
      applyEmpiricalBonuses({
        baseScore: 14,
        triggerVolToOiWindow: null,
        rangePosAtTrigger: 0,
      }),
    ).toBe(11);
  });
});
