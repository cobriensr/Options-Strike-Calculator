/**
 * Pure formatters for /api/trace-live-analyze.
 *
 * Turn structured GEX-landscape data (already produced by the strike-calculator's
 * 1-min cron pipeline) into compact text blocks Claude can read alongside the
 * three chart images. The split mirrors the pattern in
 * `api/_lib/analyze-context-formatters.ts` — pure functions only, easy to test.
 *
 * No I/O here. Only data → string transformations.
 */

import type {
  TraceGexLandscape,
  TraceImage,
  TraceStrikeRow,
} from './trace-live-types.js';

// ============================================================
// Number formatting
// ============================================================

/**
 * Format a dollar magnitude as a compact string with B/M/K suffix.
 * Examples: 3_400_000_000 → "+3.40B", -712_000_000 → "−712.00M".
 * Negative sign uses U+2212 minus for visual clarity in fixed-width output.
 */
export function formatGammaMagnitude(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '−' : '+';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(2)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

/** Compute the dominant +γ node and ratio to next-nearest +γ within ±band$. */
export function computeDominantNode(
  strikes: TraceStrikeRow[],
  spot: number,
  band: number = 30,
): { strike: number; magnitude: number; ratio: number } | null {
  const nearby = strikes.filter(
    (s) => Math.abs(s.strike - spot) <= band && s.dollarGamma > 0,
  );
  if (nearby.length === 0) return null;
  const sorted = [...nearby].sort((a, b) => b.dollarGamma - a.dollarGamma);
  const top = sorted[0]!;
  const next = sorted[1];
  const ratio =
    next && next.dollarGamma > 0
      ? top.dollarGamma / next.dollarGamma
      : Infinity;
  return { strike: top.strike, magnitude: top.dollarGamma, ratio };
}

// ============================================================
// Block formatters
// ============================================================

/**
 * Render the GEX landscape as a compact, monospaced text block. Claude reads
 * the magnitudes deterministically (no OCR ambiguity from the chart) and the
 * heatmap topology from the accompanying images.
 */
export function formatGexLandscapeForClaude(
  gex: TraceGexLandscape,
  spot: number,
): string {
  const lines: string[] = [];
  lines.push('=== GEX LANDSCAPE (structured, 1-min cron) ===');
  lines.push(`Regime: ${gex.regime}`);
  if (gex.regimeText) lines.push(`Note: ${gex.regimeText}`);
  if (gex.netGex !== undefined) {
    lines.push(`Net GEX: ${formatGammaMagnitude(gex.netGex)}`);
  }
  if (gex.totalPosGex !== undefined && gex.totalNegGex !== undefined) {
    lines.push(
      `+γ total: ${formatGammaMagnitude(gex.totalPosGex)} | −γ total: ${formatGammaMagnitude(gex.totalNegGex)}`,
    );
  }
  lines.push(`ATM strike: ${gex.atmStrike} (spot ${spot.toFixed(2)})`);
  if (gex.driftTargetsUp?.length) {
    lines.push(`Drift targets ↑: ${gex.driftTargetsUp.join(', ')}`);
  }
  if (gex.driftTargetsDown?.length) {
    lines.push(`Drift targets ↓: ${gex.driftTargetsDown.join(', ')}`);
  }

  // Dominant-node calculation (the override-rule input)
  const dom = computeDominantNode(gex.strikes, spot, 30);
  if (dom) {
    const ratioStr =
      dom.ratio === Infinity ? '∞ (no +γ neighbor)' : dom.ratio.toFixed(1);
    lines.push(
      `Dominant +γ within ±$30: ${dom.strike} = ${formatGammaMagnitude(dom.magnitude)} ` +
        `(ratio to next-nearest +γ = ${ratioStr})`,
    );
    lines.push(
      dom.ratio >= 10 || dom.magnitude >= 5e9
        ? '  → Override rule FIRES (≥10× OR ≥5B). Pin level = this strike.'
        : '  → Override rule does not fire (no dominant node).',
    );
  }

  lines.push('');
  lines.push('Per-strike rows (sorted by strike, descending):');
  lines.push(
    '  STRIKE   $Γ          1mΔ%   5mΔ%   CHARM        CLASS                SIGNAL',
  );
  for (const r of gex.strikes) {
    const pin = r.strike === gex.atmStrike ? ' *ATM*' : '';
    lines.push(
      [
        `  ${r.strike.toString().padStart(6)}`,
        `${formatGammaMagnitude(r.dollarGamma).padStart(9)}`,
        `${(r.delta1m ?? 0).toFixed(1).padStart(5)}%`,
        `${(r.delta5m ?? 0).toFixed(1).padStart(5)}%`,
        `${formatGammaMagnitude(r.charm ?? 0).padStart(11)}`,
        `${(r.classification ?? '—').padEnd(20)}`,
        `${r.signal ?? '—'}`,
        pin,
      ].join('  '),
    );
  }
  return lines.join('\n');
}

/**
 * One-line image header so Claude knows which screenshot is which.
 * The user message will then send the corresponding base64 image block.
 */
export function formatImageLabel(img: TraceImage, spot: number): string {
  const chartName =
    img.chart === 'gamma'
      ? 'Gamma Heatmap'
      : img.chart === 'charm'
        ? 'Charm Pressure Heatmap'
        : 'Delta Pressure Heatmap';
  return `[${chartName} — slot=${img.slot}, captured ${img.capturedAt}, spot=${spot.toFixed(2)}]`;
}

/** Render a session/timing summary for the user message.
 *
 * The model is bad at converting a UTC ISO string to ET clock time
 * (it tends to read the HH:MM portion as already-ET, ignoring the Z
 * suffix). Always emit the ET clock and minutes-to-close as
 * pre-computed labels so it has no math to do.
 *
 * Reference: capture at 11:32 ET on 2026-04-27 was being narrated as
 * "15:32 ET, 28 minutes to close" — model read the UTC time portion
 * as ET. Fixed by passing both formats explicitly.
 */
export function formatSessionContext(args: {
  capturedAt: string;
  etTimeLabel?: string;
  spot: number;
  stabilityPct: number | null | undefined;
}): string {
  const lines: string[] = [];
  lines.push('=== SESSION CONTEXT ===');

  // Convert UTC ISO to ET clock + minutes-to-close so the model
  // doesn't need to do the conversion itself.
  const captured = new Date(args.capturedAt);
  if (Number.isFinite(captured.getTime())) {
    const etTime = captured.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const etDate = captured.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // Cash close at 16:00 ET. Compute minutes remaining for THIS day.
    const closeEt = new Date(args.capturedAt);
    // Get ET hour/minute via Intl, then build a same-day 16:00 ET
    // anchor in UTC and subtract.
    const etHourStr = captured.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hour12: false,
    });
    const etMinStr = captured.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      minute: '2-digit',
    });
    const etHour = Number.parseInt(etHourStr, 10);
    const etMin = Number.parseInt(etMinStr, 10);
    const minutesIntoDay = etHour * 60 + etMin;
    const minutesToClose = 16 * 60 - minutesIntoDay;
    closeEt.setTime(captured.getTime()); // unused; kept for clarity
    const phaseLabel =
      etHour < 10
        ? 'OPEN (early session)'
        : etHour < 12
          ? 'MORNING SESSION'
          : etHour < 14
            ? 'MIDDAY'
            : etHour < 15
              ? 'LATE-MORNING / EARLY-AFTERNOON'
              : etHour < 16
                ? 'LATE SESSION (last hour)'
                : 'POST-CLOSE';
    lines.push(`Capture date (ET): ${etDate}`);
    lines.push(`Capture time (ET clock): ${etTime}  [${phaseLabel}]`);
    lines.push(
      `Minutes to 4:00 PM ET cash close: ${minutesToClose >= 0 ? minutesToClose : 0}`,
    );
    lines.push(`(Raw UTC for reference only: ${args.capturedAt})`);
  } else {
    // Fallback for malformed timestamps — preserve old behavior so
    // we don't lose the field entirely.
    const etSuffix = args.etTimeLabel ? ` (${args.etTimeLabel})` : '';
    lines.push(`Capture time: ${args.capturedAt}${etSuffix}`);
  }

  lines.push(`SPX spot: ${args.spot.toFixed(2)}`);
  const stabilityStr =
    args.stabilityPct == null
      ? 'not visible / pre-2025-Q2 capture'
      : `${args.stabilityPct.toFixed(1)}%`;
  lines.push(`Stability%: ${stabilityStr}`);
  return lines.join('\n');
}
