/**
 * Display formatters for GEX values, percentages, timestamps, and the
 * plain-text bias summary sent to the analyze endpoint.
 */

import { CLASS_META, PRICE_WINDOW, VERDICT_META } from './constants';
import type { BiasMetrics, DriftTarget } from './types';

export function fmtGex(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '+';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '+';
  return abs >= 10 ? `${sign}${abs.toFixed(0)}%` : `${sign}${abs.toFixed(1)}%`;
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  });
}

/** "+x% | −y%" trend line for one window, or null when both are missing. */
function fmtTrendLine(
  window: string,
  above: number | null,
  below: number | null,
): string | null {
  const parts: string[] = [];
  if (above !== null) parts.push(`above spot ${fmtPct(above)}`);
  if (below !== null) parts.push(`below spot ${fmtPct(below)}`);
  return parts.length > 0 ? `${window} γ change: ${parts.join(' | ')}` : null;
}

/**
 * Serializes BiasMetrics to a compact plain-text summary for the analyze
 * prompt. The values are GEXBot taker flow (owner decision D1 revised,
 * 2026-10-29), so the text reports taker positioning and numbers only —
 * no market-maker pull, wall or target reading.
 */
export function formatBiasForClaude(b: BiasMetrics): string {
  const fmtTarget = (t: DriftTarget) => {
    const volTag =
      t.volReinforcement === 'reinforcing'
        ? ', vol reinforcing'
        : t.volReinforcement === 'opposing'
          ? ', vol opposing'
          : '';
    return `${t.strike.toLocaleString()} (${CLASS_META[t.cls].badge}${volTag})`;
  };
  const meta = VERDICT_META[b.verdict];
  const gravDir = b.gravityOffset >= 0 ? 'above' : 'below';
  const gravOffsetDisplay = Math.abs(b.gravityOffset).toLocaleString(
    undefined,
    {
      maximumFractionDigits: 2,
    },
  );
  const netSide = b.regime === 'positive' ? 'long' : 'short';
  const topSide = b.gravityGex >= 0 ? 'taker-long' : 'taker-short';
  const lines = [
    `Verdict: ${meta.label} — ${meta.desc}`,
    `Net taker gamma: ${fmtGex(b.totalNetGex)} within ±${PRICE_WINDOW} pts (traders net ${netSide} gamma) | Largest |γ| strike: ${b.gravityStrike.toLocaleString()} (${gravOffsetDisplay} pts ${gravDir} spot, ${fmtGex(b.gravityGex)}, ${topSide})`,
  ];
  if (b.upsideTargets.length > 0)
    lines.push(
      `Largest |γ| above spot: ${b.upsideTargets.map(fmtTarget).join(', ')}`,
    );
  if (b.downsideTargets.length > 0)
    lines.push(
      `Largest |γ| below spot: ${b.downsideTargets.map(fmtTarget).join(', ')}`,
    );
  for (const line of [
    fmtTrendLine('5m', b.ceilingTrend5m, b.floorTrend5m),
    fmtTrendLine('15m', b.ceilingTrend15m, b.floorTrend15m),
    fmtTrendLine('30m', b.ceilingTrend30m, b.floorTrend30m),
  ]) {
    if (line != null) lines.push(line);
  }
  if (b.priceTrend && b.priceTrend.direction !== 'flat') {
    const dir = b.priceTrend.direction === 'up' ? 'UP' : 'DOWN';
    lines.push(
      `Price trend: DRIFTING ${dir} (${b.priceTrend.changePts > 0 ? '+' : ''}${b.priceTrend.changePts.toFixed(1)} pts, ${fmtPct(b.priceTrend.changePct)} over 30m)`,
    );
  }
  return lines.join('\n');
}
