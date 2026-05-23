// @vitest-environment node

/**
 * Smoke + invariants test for the deterministic Periscope analyzer's
 * rule constants. The file is pure exports — no logic — but those
 * constants drive the analyzer's behavior across every regime, so the
 * test pins the validated values from the historical study so they
 * can't drift silently.
 *
 * Spec: docs/superpowers/specs/periscope-rules-study-2026-05-21.md
 * Study: docs/tmp/periscope-rules-study-findings-2026-05-21.md
 */

import { describe, it, expect } from 'vitest';

import {
  FLOOR_BREAK_RULE,
  FLOOR_BREAK_THRESHOLDS,
  TRIGGER_ARM_RULE,
  TRIGGER_ARM_THRESHOLDS,
  TARGET_ORDER_RULE,
  STOP_FIRE_RULE,
  STOP_FIRE_THRESHOLDS,
  VANNA_FEATURES_ENABLED,
  type TargetKind,
  type RegimeTag,
} from '../_lib/periscope-analyzer-rules.js';

describe('periscope-analyzer-rules', () => {
  describe('Floor-Break rule', () => {
    it('uses F2 as the validated winner', () => {
      expect(FLOOR_BREAK_RULE).toBe('F2');
    });

    it('requires 2 consecutive 1-min closes below the floor', () => {
      expect(FLOOR_BREAK_THRESHOLDS.minHoldBars).toBe(2);
    });

    it('classifies a failure as 10 pts below the floor', () => {
      expect(FLOOR_BREAK_THRESHOLDS.failurePtsBelow).toBe(10);
    });
  });

  describe('Trigger-Arm rule', () => {
    it('uses T2 as the validated winner', () => {
      expect(TRIGGER_ARM_RULE).toBe('T2');
    });

    it('requires a 3-bar hold past the trigger level before arming', () => {
      expect(TRIGGER_ARM_THRESHOLDS.minHoldBars).toBe(3);
    });

    it('defines continuation as ≥0.3% follow-through', () => {
      expect(TRIGGER_ARM_THRESHOLDS.continuationPct).toBeCloseTo(0.003, 6);
    });
  });

  describe('Target-Order rule', () => {
    it('defaults to gamma_wall as T1 (validated 83.3% first-touch)', () => {
      expect(TARGET_ORDER_RULE.defaultT1).toBe('gamma_wall');
    });

    it('defaults to magnet as T2', () => {
      expect(TARGET_ORDER_RULE.defaultT2).toBe('magnet');
    });

    it('pin regime overrides T2 to charm_zero (charm-driven setup)', () => {
      expect(TARGET_ORDER_RULE.regimeOverrides.pin).toEqual({
        t1: 'gamma_wall',
        t2: 'charm_zero',
      });
    });

    it.each(['drift-and-cap', 'cone-breach', 'chop', 'trap'] as const)(
      'regime %s keeps the default {gamma_wall, magnet} ordering',
      (regime) => {
        const override = TARGET_ORDER_RULE.regimeOverrides[regime];
        expect(override).toEqual({ t1: 'gamma_wall', t2: 'magnet' });
      },
    );

    it('every regime override keeps gamma_wall as T1 (no regime promotes another target)', () => {
      for (const override of Object.values(TARGET_ORDER_RULE.regimeOverrides)) {
        expect(override?.t1).toBe('gamma_wall');
      }
    });

    it('uses only the three documented TargetKind values across all overrides', () => {
      const allowed: ReadonlySet<TargetKind> = new Set([
        'gamma_wall',
        'magnet',
        'charm_zero',
      ]);
      for (const override of Object.values(TARGET_ORDER_RULE.regimeOverrides)) {
        if (override == null) continue;
        expect(allowed.has(override.t1)).toBe(true);
        expect(allowed.has(override.t2)).toBe(true);
      }
      expect(allowed.has(TARGET_ORDER_RULE.defaultT1)).toBe(true);
      expect(allowed.has(TARGET_ORDER_RULE.defaultT2)).toBe(true);
    });

    it('overrides only cover documented RegimeTag values', () => {
      const allowed: ReadonlySet<RegimeTag> = new Set([
        'pin',
        'drift-and-cap',
        'gap-and-rip',
        'trap',
        'cone-breach',
        'chop',
        'other',
      ]);
      for (const key of Object.keys(TARGET_ORDER_RULE.regimeOverrides)) {
        expect(allowed.has(key as RegimeTag)).toBe(true);
      }
    });
  });

  describe('Stop-Fire rule', () => {
    it('uses S5 as the validated winner (close + no-recovery)', () => {
      expect(STOP_FIRE_RULE).toBe('S5');
    });

    it('triggers on a single 1-min close past the stop level', () => {
      expect(STOP_FIRE_THRESHOLDS.minHoldBars).toBe(1);
    });

    it('classifies a continuation as 10 pts adverse', () => {
      expect(STOP_FIRE_THRESHOLDS.continuationPtsThreshold).toBe(10);
    });

    it('treats a stop fire as a wick if recovery happens within 5 bars', () => {
      expect(STOP_FIRE_THRESHOLDS.noRecoveryBars).toBe(5);
    });
  });

  describe('Vanna features', () => {
    it('is disabled — study found no F1 lift from vanna features', () => {
      expect(VANNA_FEATURES_ENABLED).toBe(false);
    });
  });
});
