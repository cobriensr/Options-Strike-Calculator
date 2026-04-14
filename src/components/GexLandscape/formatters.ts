/**
 * Display formatters for GEX values, percentages, timestamps, and the
 * plain-text bias summary sent to the analyze endpoint.
 */

import { VERDICT_META } from './constants';
import type { BiasMetrics, DriftTarget, GexClassification } from './types';

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

/** Serializes BiasMetrics to a compact plain-text summary for the analyze prompt. */
export function formatBiasForClaude(b: BiasMetrics): string {
  const clsLabel: Record<GexClassification, string> = {
    'max-launchpad': 'Max Launchpad',
    'fading-launchpad': 'Fading Launchpad',
    'sticky-pin': 'Sticky Pin',
    'weakening-pin': 'Weakening Pin',
  };
  const fmtTarget = (t: DriftTarget) => {
    const volTag =
      t.volReinforcement === 'reinforcing'
        ? ', vol reinforcing'
        : t.volReinforcement === 'opposing'
          ? ', vol opposing'
          : '';
    return `${t.strike.toLocaleString()} (${clsLabel[t.cls]}${volTag})`;
  };
  const meta = VERDICT_META[b.verdict];
  const gravDir = b.gravityOffset >= 0 ? 'above' : 'below';
  const lines = [
    `Verdict: ${meta.label} — ${meta.desc}`,
    `Regime: ${b.regime === 'positive' ? 'Positive' : 'Negative'} GEX (${fmtGex(b.totalNetGex)} total) | Gravity: ${b.gravityStrike.toLocaleString()} (${Math.abs(b.gravityOffset)} pts ${gravDir} spot, ${fmtGex(b.gravityGex)})`,
  ];
  if (b.upsideTargets.length > 0)
    lines.push(`Upside targets: ${b.upsideTargets.map(fmtTarget).join(', ')}`);
  if (b.downsideTargets.length > 0)
    lines.push(
      `Downside targets: ${b.downsideTargets.map(fmtTarget).join(', ')}`,
    );
  const t1: string[] = [];
  if (b.ceilingTrend !== null) t1.push(`ceiling ${fmtPct(b.ceilingTrend)}`);
  if (b.floorTrend !== null) t1.push(`floor ${fmtPct(b.floorTrend)}`);
  if (t1.length > 0) lines.push(`1m GEX trend: ${t1.join(' | ')}`);
  const t5: string[] = [];
  if (b.ceilingTrend5m !== null) t5.push(`ceiling ${fmtPct(b.ceilingTrend5m)}`);
  if (b.floorTrend5m !== null) t5.push(`floor ${fmtPct(b.floorTrend5m)}`);
  if (t5.length > 0) lines.push(`5m GEX trend: ${t5.join(' | ')}`);
  return lines.join('\n');
}
