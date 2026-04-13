// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Sentry mock (must come before importing the module under test) ──

const { mockMetricsIncrement } = vi.hoisted(() => ({
  mockMetricsIncrement: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  metrics: {
    increment: mockMetricsIncrement,
  },
}));

import { getCalibrationExample } from '../_lib/analyze-calibration.js';

// ── Tests ─────────────────────────────────────────────────────

describe('analyze-calibration.ts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ============================================================
  // getCalibrationExample — branch coverage
  // ============================================================

  describe('getCalibrationExample', () => {
    it('returns a non-empty string for the entry mode (default)', () => {
      const result = getCalibrationExample('entry');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns a non-empty string for the midday mode', () => {
      const result = getCalibrationExample('midday');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns a non-empty string for the review mode', () => {
      const result = getCalibrationExample('review');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns the entry calibration as the default for an unknown mode', () => {
      const defaultResult = getCalibrationExample('entry');
      const unknownResult = getCalibrationExample('unknown-mode');
      expect(unknownResult).toBe(defaultResult);
    });

    it('returns the entry calibration for an empty string mode', () => {
      const defaultResult = getCalibrationExample('entry');
      const emptyResult = getCalibrationExample('');
      expect(emptyResult).toBe(defaultResult);
    });

    it('midday calibration differs from entry calibration', () => {
      const entry = getCalibrationExample('entry');
      const midday = getCalibrationExample('midday');
      expect(midday).not.toBe(entry);
    });

    it('review calibration differs from entry calibration', () => {
      const entry = getCalibrationExample('entry');
      const review = getCalibrationExample('review');
      expect(review).not.toBe(entry);
    });

    it('midday and review calibrations differ from each other', () => {
      const midday = getCalibrationExample('midday');
      const review = getCalibrationExample('review');
      expect(midday).not.toBe(review);
    });
  });

  // ============================================================
  // Mojibake repair — catch branch in fixMojibake
  //
  // The catch branch fires when Buffer.from(s, 'latin1').toString('utf8')
  // throws. fixMojibake is an internal helper called by fixObj, which is
  // called by parseAnalysis at MODULE LOAD TIME — the CALIBRATION_* string
  // constants are fully computed before any test runs. Patching Buffer.from
  // after the module is already loaded cannot exercise this path.
  //
  // The only way to cover statement 22-24 (the catch block) would be to
  // either export fixMojibake or force a module reload with a broken Buffer.
  // Both require modifying the source. Skip this branch and document the gap.
  // ============================================================

  describe('mojibake repair error path', () => {
    it.skip(
      'increments Sentry metric when Buffer.from throws — ' +
        'unreachable after module load; fixMojibake runs at import time only',
      () => {
        // If fixMojibake were exported, the test would be:
        //   vi.spyOn(Buffer, 'from').mockImplementationOnce(() => {
        //     throw new Error('latin1 decode failure');
        //   });
        //   fixMojibake('Î test string with mojibake marker');
        //   expect(mockMetricsIncrement).toHaveBeenCalledWith(
        //     'analyze_calibration.mojibake_repair_error',
        //   );
      },
    );
  });

  // ============================================================
  // parseAnalysis — throw branch
  // The throw fires when the outer array has neither .result nor
  // .full_response on its first element.
  //
  // parseAnalysis is not exported, so we exercise it indirectly via
  // the CALIBRATION_* module-level constants that are built at import time.
  // The throw path is only reachable by calling parseAnalysis directly
  // with a malformed payload, which we cannot do without exporting it.
  // Document this gap and note that the branch is unreachable via the
  // public API because all CALIBRATION_* constants are parsed at
  // module-load time with known-good data.
  // ============================================================

  describe('parseAnalysis throw branch (unreachable via public API)', () => {
    it.skip(
      'throws when raw JSON has neither .result nor .full_response — ' +
        'branch only reachable if parseAnalysis is exported; skip until exported',
      () => {
        // If parseAnalysis were exported, the test would be:
        //   expect(() => parseAnalysis('[{"unknown_key": 1}]')).toThrow(
        //     'parseAnalysis: unrecognized shape',
        //   );
      },
    );
  });
});
