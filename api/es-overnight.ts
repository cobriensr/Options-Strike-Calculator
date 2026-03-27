/**
 * Formats pre-computed ES overnight summary for Claude analysis context.
 * Pattern follows formatIvTermStructureForClaude() in iv-term-structure.ts.
 */

export interface EsOvernightSummaryRow {
  trade_date: string;
  globex_open: string;
  globex_high: string;
  globex_low: string;
  globex_close: string;
  vwap: string;
  total_volume: string;
  bar_count: string;
  range_pts: string;
  range_pct: string;
  cash_open: string;
  prev_cash_close: string;
  gap_pts: string;
  gap_pct: string;
  gap_direction: string;
  gap_size_class: string;
  cash_open_pct_rank: string;
  position_class: string;
  vol_20d_avg: string;
  vol_ratio: string;
  vol_class: string;
  gap_vs_vwap_pts: string;
  vwap_signal: string;
  fill_score: string;
  fill_probability: string;
}

function formatVolume(vol: number): string {
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000) return `${Math.round(vol / 1_000)}K`;
  return String(vol);
}

export function formatEsOvernightForClaude(
  row: EsOvernightSummaryRow,
  coneUpper?: number | null,
  coneLower?: number | null,
): string | null {
  if (!row) return null;

  const rangePts = parseFloat(row.range_pts);
  const totalVol = parseInt(row.total_volume);
  const volRatio = parseFloat(row.vol_ratio);
  const gapPts = parseFloat(row.gap_pts);
  const gapPct = parseFloat(row.gap_pct);
  const pctRank = parseFloat(row.cash_open_pct_rank);
  const vwapPts = parseFloat(row.gap_vs_vwap_pts);
  const fillScore = parseInt(row.fill_score);

  const lines: string[] = [];

  // Header with range
  let rangeSuffix = '';
  if (coneUpper != null && coneLower != null) {
    const coneWidth = coneUpper - coneLower;
    if (coneWidth > 0) {
      const conePct = (rangePts / coneWidth) * 100;
      rangeSuffix = `, ${conePct.toFixed(0)}% of straddle cone`;
    }
  }
  lines.push('ES Overnight Session (Globex 6:00 PM – 9:30 AM ET):');
  lines.push(
    `  Range: ${parseFloat(row.globex_low).toFixed(2)} – ${parseFloat(row.globex_high).toFixed(2)} (${rangePts.toFixed(2)} pts${rangeSuffix})`,
  );
  lines.push(
    `  Volume: ${formatVolume(totalVol)} contracts (${row.vol_class}, ${volRatio.toFixed(2)}x 20-day avg)`,
  );
  lines.push(`  VWAP: ${parseFloat(row.vwap).toFixed(2)}`);

  // Gap analysis
  lines.push('');
  lines.push('  Gap Analysis:');
  const sign = gapPts >= 0 ? '+' : '';
  lines.push(
    `    Cash Open: ${parseFloat(row.cash_open).toFixed(2)} | Previous Close: ${parseFloat(row.prev_cash_close).toFixed(2)} | Gap: ${sign}${gapPts.toFixed(1)} pts ${row.gap_direction} (${gapPct.toFixed(2)}%)`,
  );
  lines.push(`    Gap Size: ${row.gap_size_class}`);

  const positionLabel = row.position_class.replace(/_/g, ' ');
  lines.push(
    `    Open Position: ${pctRank.toFixed(0)}th percentile of overnight range (${positionLabel})`,
  );

  const vwapDir = vwapPts >= 0 ? 'above' : 'below';
  const vwapLabel =
    row.vwap_signal === 'SUPPORTED' ? 'gap has support' : 'fade likely';
  lines.push(
    `    Open vs VWAP: ${vwapPts >= 0 ? '+' : ''}${vwapPts.toFixed(1)} pts ${vwapDir} overnight VWAP (${vwapLabel})`,
  );

  // Fill probability
  lines.push('');
  lines.push(`  Gap Fill Probability: ${row.fill_probability} (score: ${fillScore})`);

  // 0DTE implications (only with cone data)
  if (coneUpper != null && coneLower != null) {
    const coneWidth = coneUpper - coneLower;
    if (coneWidth > 0) {
      const conePct = (rangePts / coneWidth) * 100;
      const remaining = 100 - conePct;
      lines.push('');
      lines.push('  Implication for 0DTE:');
      lines.push(
        `    Overnight range consumed ${conePct.toFixed(0)}% of straddle cone — ${remaining.toFixed(0)}% remaining.`,
      );
      if (row.gap_direction === 'UP') {
        lines.push(
          '    Gap direction (UP) aligns with bullish flow if confirmed at open.',
        );
      } else if (row.gap_direction === 'DOWN') {
        lines.push(
          '    Gap direction (DOWN) aligns with bearish flow if confirmed at open.',
        );
      }
      if (row.fill_probability === 'HIGH') {
        lines.push(
          '    Watch for gap fill in first 30 min — consider fade structures.',
        );
      } else if (row.fill_probability === 'LOW') {
        lines.push(
          '    Gap extension likely — favor directional structures with the gap.',
        );
      }
    }
  }

  return lines.join('\n');
}
