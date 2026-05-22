#!/usr/bin/env node
// Audit the inferred_structure-tagged rows in lottery_finder_fires whose
// realized_flow_inversion_pct is in the right tail (p99+). The EDA found
// medians of 17-59% for structure-tagged rows vs -3% for null — real signal —
// but means of 3,000-4,000% driven by a p99 of 20,000-40,000%. This script
// verifies whether the extreme tail is legitimate (deep-OTM 0DTE that hit,
// e.g. $0.05 → $5 = 9,900%) or an enrichment / math artifact.
//
// Output: docs/tmp/inferred-structure-audit-2026-05-22.md
//
// Spec: docs/superpowers/specs/lottery-rescore-2026-05-22.md (Phase 0)
// EDA: docs/tmp/lottery-rescore-eda-2026-05-22.md (Tier 3 finding)

import { neon } from '@neondatabase/serverless';
import { writeFileSync, mkdirSync } from 'node:fs';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig({ path: '.env.local' });

const sql = neon(process.env.DATABASE_URL);

const THRESHOLD_FLOW_INV_PCT = 1000; // anything above this we want to inspect
const SAMPLE_LIMIT = 100;

const outlierRows = await sql`
  SELECT
    id,
    date,
    underlying_symbol,
    option_chain_id,
    option_type,
    strike,
    expiry,
    dte,
    entry_price,
    inferred_structure,
    is_isolated_leg,
    match_confidence,
    realized_flow_inversion_pct,
    realized_eod_pct,
    realized_trail30_10_pct,
    realized_hard30m_pct,
    peak_ceiling_pct,
    minutes_to_peak
  FROM lottery_finder_fires
  WHERE date >= CURRENT_DATE - INTERVAL '90 days'
    AND inferred_structure IS NOT NULL
    AND realized_flow_inversion_pct >= ${THRESHOLD_FLOW_INV_PCT}
  ORDER BY realized_flow_inversion_pct DESC
  LIMIT ${SAMPLE_LIMIT}
`;

const summary = await sql`
  SELECT
    COALESCE(inferred_structure, 'null') AS structure,
    COUNT(*) AS n,
    SUM(CASE WHEN realized_flow_inversion_pct >= ${THRESHOLD_FLOW_INV_PCT} THEN 1 ELSE 0 END) AS outliers,
    SUM(CASE WHEN entry_price < 0.10 THEN 1 ELSE 0 END) AS cheap_entries,
    SUM(CASE WHEN entry_price < 0.10 AND realized_flow_inversion_pct >= ${THRESHOLD_FLOW_INV_PCT} THEN 1 ELSE 0 END) AS cheap_and_outlier
  FROM lottery_finder_fires
  WHERE date >= CURRENT_DATE - INTERVAL '90 days'
    AND inferred_structure IS NOT NULL
  GROUP BY 1
  ORDER BY n DESC
`;

// Flag patterns:
//   flag_flowinv_exceeds_peak — flow_inv % returned without a matching peak
//     ceiling supporting it. If flow_inversion exits ABOVE the peak ceiling,
//     the math is broken (you can't realize more than the peak you hit).
//   flag_no_eod_match         — flow_inv but missing eod % (enrichment gap)
//   flag_cheap_otm            — entry_price < 0.10 and short DTE. Legitimate
//     huge percentages possible (0.05 → 5.00 = 9,900%). Not a flag, an
//     explainer.
function flag(row) {
  const flags = [];
  const peak = row.peak_ceiling_pct;
  const flowInv = row.realized_flow_inversion_pct;
  const entry = row.entry_price;
  if (peak != null && flowInv != null && Number(flowInv) > Number(peak) * 1.05) {
    flags.push('FLOW_INV_EXCEEDS_PEAK');
  }
  if (row.realized_eod_pct == null) flags.push('NO_EOD');
  if (entry != null && Number(entry) < 0.10) flags.push('cheap_otm');
  if (row.dte === 0 && entry != null && Number(entry) < 0.20) {
    flags.push('cheap_0dte');
  }
  return flags;
}

const lines = [];
lines.push('# Inferred Structure Outlier Audit — 2026-05-22');
lines.push('');
lines.push('Trigger: EDA Phase 4D found structure-tagged rows have median outcomes 17-59%');
lines.push(`vs null -3%, but means of 3,000-4,000% driven by a p99 of 20-40k%. Verifying`);
lines.push('whether the tail is legitimate deep-OTM-hit math or an enrichment artifact.');
lines.push('');
lines.push(`**Method:** pull last 90 days × inferred_structure NOT NULL × flow_inv ≥ ${THRESHOLD_FLOW_INV_PCT}%,`);
lines.push(`sort desc, top ${SAMPLE_LIMIT}. Flag suspicious patterns (flow_inv > peak, missing eod).`);
lines.push('');
lines.push('## Summary by structure');
lines.push('');
lines.push('| structure | n (90d) | n outliers (≥1000%) | n cheap entries (<$0.10) | n cheap AND outlier |');
lines.push('|---|---|---|---|---|');
for (const row of summary) {
  lines.push(
    `| ${row.structure} | ${row.n} | ${row.outliers} | ${row.cheap_entries} | ${row.cheap_and_outlier} |`,
  );
}
lines.push('');
lines.push('## Verdict guidance');
lines.push('');
lines.push('- **If most outlier rows have `cheap_otm` flag and NO `FLOW_INV_EXCEEDS_PEAK`** → tail is');
lines.push('  legitimate (deep-OTM hits). Include inferred_structure in v1 with median-derived weight.');
lines.push('- **If many rows have `FLOW_INV_EXCEEDS_PEAK`** → enrichment math is broken. Don\'t include');
lines.push('  in v1; file a separate enrichment bug.');
lines.push('- **If outliers are NOT concentrated in `cheap_otm`** → tail is suspicious; drop from v1.');
lines.push('');
lines.push(`## Top ${SAMPLE_LIMIT} outlier rows`);
lines.push('');
lines.push('| date | symbol | strike | type | exp | dte | entry $ | flow_inv % | peak % | eod % | structure | flags |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');

let flagFlowInvExceedsPeak = 0;
let flagCheapOtm = 0;
let flagBoth = 0;

for (const row of outlierRows) {
  const flags = flag(row);
  if (flags.includes('FLOW_INV_EXCEEDS_PEAK')) flagFlowInvExceedsPeak++;
  if (flags.includes('cheap_otm')) flagCheapOtm++;
  if (flags.includes('cheap_otm') && !flags.includes('FLOW_INV_EXCEEDS_PEAK')) flagBoth++;

  const entryFmt =
    row.entry_price != null ? `$${Number(row.entry_price).toFixed(2)}` : '—';
  const flowInvFmt =
    row.realized_flow_inversion_pct != null
      ? `${Number(row.realized_flow_inversion_pct).toFixed(0)}`
      : '—';
  const peakFmt =
    row.peak_ceiling_pct != null
      ? `${Number(row.peak_ceiling_pct).toFixed(0)}`
      : '—';
  const eodFmt =
    row.realized_eod_pct != null
      ? `${Number(row.realized_eod_pct).toFixed(0)}`
      : '—';
  lines.push(
    `| ${row.date.toISOString().slice(0, 10)} | ${row.underlying_symbol} | ${row.strike} | ${row.option_type} | ${row.expiry.toISOString().slice(0, 10)} | ${row.dte} | ${entryFmt} | ${flowInvFmt} | ${peakFmt} | ${eodFmt} | ${row.inferred_structure} | ${flags.join(', ') || '—'} |`,
  );
}

lines.push('');
lines.push('## Flag tally');
lines.push('');
lines.push(`- Rows with FLOW_INV_EXCEEDS_PEAK: ${flagFlowInvExceedsPeak} / ${outlierRows.length}`);
lines.push(`- Rows with cheap_otm: ${flagCheapOtm} / ${outlierRows.length}`);
lines.push(`- Rows with cheap_otm AND NO peak-violation: ${flagBoth} / ${outlierRows.length}`);
lines.push('');
lines.push('## Auto-verdict');
lines.push('');
const peakViolationRate = flagFlowInvExceedsPeak / outlierRows.length;
const cheapOtmRate = flagCheapOtm / outlierRows.length;
if (peakViolationRate > 0.3) {
  lines.push(`⚠️  **VERDICT: HOLD** — ${(peakViolationRate * 100).toFixed(0)}% of outliers have flow_inv exceeding peak ceiling. Likely enrichment math bug. **Drop inferred_structure from v1**; file enrichment fix as separate spec.`);
} else if (cheapOtmRate > 0.6) {
  lines.push(`✅  **VERDICT: SHIP** — ${(cheapOtmRate * 100).toFixed(0)}% of outliers are cheap-OTM entries where 1000%+ returns are mathematically legitimate. **Include inferred_structure in v1** with median-derived weight (per Phase 1 design).`);
} else {
  lines.push(`🟡  **VERDICT: INCONCLUSIVE** — ${(cheapOtmRate * 100).toFixed(0)}% cheap-OTM, ${(peakViolationRate * 100).toFixed(0)}% peak-violations. Pattern is mixed. **Drop inferred_structure from v1** out of conservatism; revisit in v2 after manual inspection of a sample.`);
}

mkdirSync('docs/tmp', { recursive: true });
const outPath = 'docs/tmp/inferred-structure-audit-2026-05-22.md';
writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`Wrote ${outPath} (${outlierRows.length} outlier rows, ${summary.length} structure types)`);
