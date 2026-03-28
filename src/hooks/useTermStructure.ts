/**
 * useTermStructure — VIX term structure classification and shape analysis.
 *
 * Extracted from useComputedSignals for composability.
 * Pure computation — no side effects, no API calls.
 */

import { useMemo } from 'react';
import { SIGNALS } from '../constants';

// ============================================================
// TYPES
// ============================================================

export interface TermStructureSignals {
  // VIX term structure
  vixTermSignal: string | null;
  /** Shape of the VIX term structure curve */
  vixTermShape: string | null;
  /** Actionable advice based on term structure shape */
  vixTermShapeAdvice: string | null;
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Classifies the VIX term structure shape from the three-point curve.
 * Returns both the shape name and actionable trading advice.
 *
 * Shapes:
 *   contango:       VIX1D < VIX < VIX9D  → near-term calm, premium selling sweet spot
 *   fear-spike:     VIX1D > VIX > VIX9D  → near-term fear, event-driven, IC dangerous
 *   flat:           all within ±5%       → no edge from term structure
 *   backwardation:  VIX1D > VIX          → near-term stress but longer-term calm
 *   front-calm:     VIX1D < VIX, 9D < VIX → near-term relief, longer-term worry
 */
function classifyTermShape(
  vix1d: number | undefined,
  vix9d: number | undefined,
  vix: number,
): { shape: string; advice: string } | null {
  // Need at least VIX1D to determine shape
  if (!vix1d || vix <= 0) return null;

  const r1d = vix1d / vix;
  const r9d = vix9d ? vix9d / vix : null;
  const lo = 1 - SIGNALS.TERM_SHAPE_THRESHOLD; // 0.97
  const hi = 1 + SIGNALS.TERM_SHAPE_THRESHOLD; // 1.03

  // Check for flat first: all ratios within ±TERM_FLAT_THRESHOLD
  const isFlat1d = Math.abs(r1d - 1) < SIGNALS.TERM_FLAT_THRESHOLD;
  const isFlat9d =
    r9d == null || Math.abs(r9d - 1) < SIGNALS.TERM_FLAT_THRESHOLD;
  if (isFlat1d && isFlat9d) {
    return {
      shape: 'flat',
      advice:
        'Term structure is flat — no directional edge from vol curve. Follow standard delta guide.',
    };
  }

  // With both VIX1D and VIX9D
  if (r9d != null) {
    // Contango: VIX1D < VIX < VIX9D (or VIX1D < VIX and VIX9D > VIX)
    if (r1d < lo && r9d > hi) {
      return {
        shape: 'contango',
        advice:
          'Full contango — near-term calm with longer-term uncertainty. Premium selling sweet spot. Full position size.',
      };
    }
    // Fear spike: VIX1D > VIX > VIX9D (or VIX1D > VIX and VIX9D < VIX)
    if (r1d > hi && r9d < lo) {
      return {
        shape: 'fear-spike',
        advice:
          'Near-term fear spike — likely event-driven. IC dangerous, but if the event passes, rapid mean-reversion creates opportunity. Wait for resolution or use single-side spreads only.',
      };
    }
    // Backwardation: VIX1D > VIX, VIX9D ≈ VIX or > VIX
    if (r1d > hi) {
      return {
        shape: 'backwardation',
        advice:
          'Short-term stress exceeding 30-day — elevated intraday risk. Reduce size or widen deltas. Watch for mean-reversion after event clears.',
      };
    }
    // Inverted hump: VIX1D < VIX > VIX9D (both near-term and 9-day below 30-day)
    // Often appears around FOMC — event vol is priced into 30-day but not near-term
    if (r1d < lo && r9d < lo) {
      return {
        shape: 'hump',
        advice:
          'Inverted hump — VIX elevated above both VIX1D and VIX9D. Likely event-driven (FOMC/CPI priced into 30-day). Near-term is calm but 30-day IV is inflated. Premium selling is attractive if the event has passed or is priced in. If the event is upcoming, IV crush post-event creates opportunity but pre-event risk is asymmetric.',
      };
    }
    // Front-calm: VIX1D < VIX, VIX9D ≈ VIX or > VIX (not both below)
    if (r1d < lo) {
      return {
        shape: 'front-calm',
        advice:
          'Near-term calm but longer-term worry persists — transitional environment. Standard positioning with slight bullish tilt.',
      };
    }
  }

  // VIX1D only (no VIX9D)
  if (r1d > hi) {
    return {
      shape: 'backwardation',
      advice:
        'VIX1D above VIX — today expected hotter than average. Widen deltas or reduce size.',
    };
  }
  if (r1d < lo) {
    return {
      shape: 'contango',
      advice:
        'VIX1D below VIX — today expected calmer than average. Favorable for selling premium.',
    };
  }

  return {
    shape: 'flat',
    advice:
      'Term structure is roughly flat — no strong directional signal from vol curve.',
  };
}

function classifyTermStructure(
  vix1d: number | undefined,
  vix9d: number | undefined,
  vvix: number | undefined,
  vix: number,
): string | null {
  const signals: string[] = [];

  if (vix1d && vix > 0) {
    const ratio = vix1d / vix;
    if (ratio < SIGNALS.VIX1D_RATIO_CALM) signals.push('calm');
    else if (ratio < SIGNALS.VIX1D_RATIO_NORMAL) signals.push('normal');
    else if (ratio < SIGNALS.VIX1D_RATIO_ELEVATED) signals.push('elevated');
    else signals.push('extreme');
  }

  if (vix9d && vix > 0) {
    const ratio = vix9d / vix;
    if (ratio > SIGNALS.VIX9D_RATIO_CALM) signals.push('calm');
    else if (ratio > SIGNALS.VIX9D_RATIO_NORMAL) signals.push('normal');
    else if (ratio > SIGNALS.VIX9D_RATIO_ELEVATED) signals.push('elevated');
    else signals.push('extreme');
  }

  if (vvix) {
    if (vvix < SIGNALS.VVIX_CALM) signals.push('calm');
    else if (vvix < SIGNALS.VVIX_NORMAL) signals.push('normal');
    else if (vvix < SIGNALS.VVIX_ELEVATED) signals.push('elevated');
    else signals.push('extreme');
  }

  if (signals.length === 0) return null;

  const order = ['calm', 'normal', 'elevated', 'extreme'];
  return signals.reduce(
    (worst, s) => (order.indexOf(s) > order.indexOf(worst) ? s : worst),
    'calm',
  );
}

// ============================================================
// HOOK
// ============================================================

interface TermStructureInputs {
  vix: number | undefined;
  vix1d: number | undefined;
  vix9d: number | undefined;
  vvix: number | undefined;
}

export function useTermStructure(
  inputs: TermStructureInputs,
): TermStructureSignals {
  const { vix, vix1d, vix9d, vvix } = inputs;

  return useMemo(() => {
    const result: TermStructureSignals = {
      vixTermSignal: null,
      vixTermShape: null,
      vixTermShapeAdvice: null,
    };

    if (!vix) return result;

    // ── VIX term structure ───────────────────────────────────
    result.vixTermSignal = classifyTermStructure(vix1d, vix9d, vvix, vix);
    const termShape = classifyTermShape(vix1d, vix9d, vix);
    if (termShape) {
      result.vixTermShape = termShape.shape;
      result.vixTermShapeAdvice = termShape.advice;
    }

    return result;
  }, [vix, vix1d, vix9d, vvix]);
}
