/**
 * ES Overnight Gap Analysis
 *
 * Formats the manually-entered ES futures overnight data into
 * structured context for Claude. Computes 5 gap signals:
 *
 * 1. Gap Size & Direction (NEGLIGIBLE → EXTREME)
 * 2. Gap Position vs Overnight Range (percentile rank)
 * 3. Overnight Range as % of Straddle Cone
 * 4. Gap vs Overnight VWAP (institutional support/overshoot)
 * 5. Composite Gap Fill Probability (weighted score)
 *
 * Called on-demand at analysis time from pre-market data.
 */

import type { PreMarketData } from '../pre-market.js';

const GAP_THRESHOLDS = {
  NEGLIGIBLE: 5,
  SMALL: 15,
  MODERATE: 30,
  LARGE: 50,
} as const;

const FILL_SCORE = {
  SMALL_GAP: 30,
  MEDIUM_GAP: 15,
  LARGE_GAP_PENALTY: -20,
  EXTREME_POSITION: 20,
  NEAR_EXTREME: 5,
  MID_RANGE_PENALTY: -10,
  SUPPORTED: -15,
  OVERSHOOT: 20,
  HIGH_THRESHOLD: 40,
  MODERATE_THRESHOLD: 15,
} as const;

interface GapAnalysisInput {
  /** ES overnight data from manual entry */
  preMarket: PreMarketData;
  /** SPX cash open price (from candles or calculator) */
  cashOpen: number;
  /** Previous SPX close */
  prevClose: number;
}

/**
 * Format ES overnight data as structured text for Claude.
 * Returns null if insufficient data.
 */
export function formatOvernightForClaude(
  input: GapAnalysisInput,
): string | null {
  const { preMarket, cashOpen, prevClose } = input;

  if (
    preMarket.globexHigh == null ||
    preMarket.globexLow == null ||
    preMarket.globexClose == null
  ) {
    return null;
  }

  const gh = preMarket.globexHigh;
  const gl = preMarket.globexLow;
  const gc = preMarket.globexClose;
  const gv = preMarket.globexVwap;
  const coneUpper = preMarket.straddleConeUpper;
  const coneLower = preMarket.straddleConeLower;

  const lines: string[] = [];

  // ── Session summary ─────────────────────────────────────
  const globexRange = gh - gl;

  lines.push(
    'ES Overnight Session (Globex 5:00 PM – 8:30 AM CT):',
    `  High: ${gh.toFixed(2)} | Low: ${gl.toFixed(2)} | Close: ${gc.toFixed(2)}`,
    `  Range: ${globexRange.toFixed(1)} pts`,
  );
  if (gv != null) {
    lines.push(`  VWAP: ${gv.toFixed(2)}`);
  }

  // ── Cone context ────────────────────────────────────────
  if (coneUpper != null && coneLower != null) {
    const coneWidth = coneUpper - coneLower;
    if (coneWidth > 0) {
      const consumedRatio = (globexRange / coneWidth) * 100;
      const consumedPctStr = consumedRatio.toFixed(0);
      lines.push(
        `  Overnight range consumed ${consumedPctStr}% of straddle cone (${coneWidth.toFixed(0)} pts)`,
      );

      if (consumedRatio > 60) {
        lines.push(
          '  ⚠ >60% of expected move happened overnight — cash session range likely compressed OR extends beyond cone',
        );
      } else if (consumedRatio < 20) {
        lines.push(
          '  Quiet overnight — full straddle cone available for cash session',
        );
      }
    }
  }

  // ── Gap analysis ────────────────────────────────────────
  const gapPts = cashOpen - prevClose;
  const gapPct = (gapPts / prevClose) * 100;
  const gapDir = gapPts > 0 ? 'UP' : gapPts < 0 ? 'DOWN' : 'FLAT';
  const absGap = Math.abs(gapPts);

  // 1. Gap size classification
  let gapSize: string;
  if (absGap < GAP_THRESHOLDS.NEGLIGIBLE) gapSize = 'NEGLIGIBLE';
  else if (absGap < GAP_THRESHOLDS.SMALL) gapSize = 'SMALL';
  else if (absGap < GAP_THRESHOLDS.MODERATE) gapSize = 'MODERATE';
  else if (absGap < GAP_THRESHOLDS.LARGE) gapSize = 'LARGE';
  else gapSize = 'EXTREME';

  lines.push(
    '',
    'Gap Analysis:',
    `  Cash Open: ${cashOpen.toFixed(2)} | Prev Close: ${prevClose.toFixed(2)} | Gap: ${gapDir} ${absGap.toFixed(1)} pts (${Math.abs(gapPct).toFixed(2)}%)`,
    `  Gap Size: ${gapSize}`,
  );

  // Compute percentile rank once for use in position and fill score sections
  const pctRank =
    globexRange > 0 ? ((cashOpen - gl) / globexRange) * 100 : null;

  // 2. Gap position vs overnight range
  if (pctRank !== null) {
    let positionDesc: string;
    if (pctRank > 90)
      positionDesc = 'AT GLOBEX HIGH — overnight longs may take profit at open';
    else if (pctRank > 70)
      positionDesc = 'NEAR HIGH — bullish overnight positioning';
    else if (pctRank > 30)
      positionDesc = 'MID-RANGE — no strong overnight directional bias';
    else if (pctRank > 10)
      positionDesc = 'NEAR LOW — bearish overnight, bounced before cash';
    else positionDesc = 'AT GLOBEX LOW — overnight shorts may cover at open';

    lines.push(
      `  Open Position: ${pctRank.toFixed(0)}th percentile of overnight range (${positionDesc})`,
    );
  }

  // 3. Gap vs VWAP
  if (gv != null) {
    const vwapDist = cashOpen - gv;
    const vwapDir = vwapDist > 0 ? 'above' : 'below';

    let vwapInterp: string;
    if (gapPts > 0 && vwapDist > 0) {
      vwapInterp =
        'Gap UP with open above VWAP — overnight buyers in profit, gap has institutional support';
    } else if (gapPts > 0 && vwapDist <= 0) {
      vwapInterp =
        'Gap UP but open below VWAP — gap is an overshoot above institutional positioning, likely to fade';
    } else if (gapPts < 0 && vwapDist < 0) {
      vwapInterp =
        'Gap DOWN with open below VWAP — overnight sellers in profit, gap likely to extend';
    } else if (gapPts < 0 && vwapDist >= 0) {
      vwapInterp =
        'Gap DOWN but open above VWAP — gap is shallow, institutions bought the dip, likely to fill';
    } else {
      vwapInterp = 'Flat gap';
    }

    lines.push(
      `  Open vs VWAP: ${Math.abs(vwapDist).toFixed(1)} pts ${vwapDir} (${vwapInterp})`,
    );
  }

  // 4. Composite gap fill probability
  let fillScore = 0;

  // Size factor
  if (absGap < 10) fillScore += FILL_SCORE.SMALL_GAP;
  else if (absGap < 20) fillScore += FILL_SCORE.MEDIUM_GAP;
  else if (absGap < 40) fillScore += 0;
  else fillScore += FILL_SCORE.LARGE_GAP_PENALTY;

  // Position factor
  if (pctRank !== null) {
    if (pctRank > 90 || pctRank < 10) fillScore += FILL_SCORE.EXTREME_POSITION;
    else if (pctRank > 70 || pctRank < 30) fillScore += FILL_SCORE.NEAR_EXTREME;
    else fillScore += FILL_SCORE.MID_RANGE_PENALTY;
  }

  // VWAP factor
  if (gv != null) {
    const vwapDist = cashOpen - gv;
    if (gapPts > 0 && vwapDist > 0) fillScore += FILL_SCORE.SUPPORTED;
    if (gapPts > 0 && vwapDist <= 0) fillScore += FILL_SCORE.OVERSHOOT;
    if (gapPts < 0 && vwapDist < 0) fillScore += FILL_SCORE.SUPPORTED;
    if (gapPts < 0 && vwapDist >= 0) fillScore += FILL_SCORE.OVERSHOOT;
  }

  let fillProb: string;
  if (fillScore > FILL_SCORE.HIGH_THRESHOLD) fillProb = 'HIGH';
  else if (fillScore > FILL_SCORE.MODERATE_THRESHOLD) fillProb = 'MODERATE';
  else fillProb = 'LOW';

  lines.push(
    '',
    `  Gap Fill Probability: ${fillProb} (score: ${fillScore})`,
    '',
    '  Implication for 0DTE:',
  );

  if (coneUpper != null && coneLower != null) {
    const coneWidth = coneUpper - coneLower;
    const remainingPct = Math.max(0, 100 - (globexRange / coneWidth) * 100);
    lines.push(
      `    ${remainingPct.toFixed(0)}% of straddle cone remaining for cash session`,
    );
  }

  if (gapDir !== 'FLAT') {
    lines.push(
      `    Gap direction (${gapDir}) ${fillProb === 'HIGH' ? 'likely to fill — watch for reversal in first 30 min' : fillProb === 'LOW' ? 'likely to extend — gap direction aligns with likely trend' : 'ambiguous — wait for opening range confirmation'}`,
    );
  }

  return lines.join('\n');
}
