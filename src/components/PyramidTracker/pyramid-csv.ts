/**
 * Pyramid CSV helpers — pure string / DOM utilities extracted from
 * ExportCSVButton so the component file exports only a component (satisfies
 * the react-refresh single-responsibility rule) and the helpers are unit-
 * testable in isolation.
 *
 * Scope: RFC 4180 quoting, row serialisation, blob-based browser download.
 * Column ordering for `pyramid_chains.csv` and `pyramid_legs.csv` lives next
 * to the helpers because those arrays drive CSV layout and are part of the
 * same "how we export" concern.
 */

import type { PyramidChain, PyramidLeg } from '../../types/pyramid';

// ============================================================
// Column ordering — matches DB column order for downstream parity
// ============================================================

export const CHAIN_COLUMNS: ReadonlyArray<keyof PyramidChain> = [
  'id',
  'trade_date',
  'instrument',
  'direction',
  'entry_time_ct',
  'exit_time_ct',
  'initial_entry_price',
  'final_exit_price',
  'exit_reason',
  'total_legs',
  'winning_legs',
  'net_points',
  'session_atr_pct',
  'day_type',
  'higher_tf_bias',
  'notes',
  'status',
  'created_at',
  'updated_at',
];

export const LEG_COLUMNS: ReadonlyArray<keyof PyramidLeg> = [
  'id',
  'chain_id',
  'leg_number',
  'signal_type',
  'entry_time_ct',
  'entry_price',
  'stop_price',
  'stop_distance_pts',
  'stop_compression_ratio',
  'vwap_at_entry',
  'vwap_1sd_upper',
  'vwap_1sd_lower',
  'vwap_band_position',
  'vwap_band_distance_pts',
  'minutes_since_chain_start',
  'minutes_since_prior_bos',
  'ob_quality',
  'relative_volume',
  'session_phase',
  'session_high_at_entry',
  'session_low_at_entry',
  'retracement_extreme_before_entry',
  'exit_price',
  'exit_reason',
  'points_captured',
  'r_multiple',
  'was_profitable',
  'notes',
  'ob_high',
  'ob_low',
  'ob_poc_price',
  'ob_poc_pct',
  'ob_secondary_node_pct',
  'ob_tertiary_node_pct',
  'ob_total_volume',
  'created_at',
  'updated_at',
];

// ============================================================
// Helpers
// ============================================================

/**
 * RFC 4180 quoting. Null -> empty string. Numbers, strings, and booleans
 * become their `String(...)` representation. Only cells containing `,`,
 * `"`, `\n`, or `\r` are wrapped in double quotes (with internal quotes
 * doubled).
 */
export function csvEscape(value: unknown): string {
  if (value == null) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

/**
 * Serialise an array of rows to CSV text. Emits a header line in the order
 * of `columns`, then one `\r\n`-separated row per input (RFC 4180 ending so
 * Excel opens the file correctly on all platforms).
 *
 * No `Record<string, unknown>` constraint on `T` — the pyramid domain types
 * (PyramidChain, PyramidLeg) are interfaces without an index signature, and
 * adding one to the shared types would be a viral change unrelated to
 * export. Indexing via `keyof T` is type-safe here; `unknown` at the value
 * level matches what `csvEscape` actually handles.
 */
export function buildCsv<T>(
  columns: ReadonlyArray<keyof T>,
  rows: ReadonlyArray<T>,
): string {
  const header = columns.map((c) => csvEscape(String(c))).join(',');
  const body = rows
    .map((row) => columns.map((c) => csvEscape(row[c])).join(','))
    .join('\r\n');
  return body.length > 0 ? `${header}\r\n${body}\r\n` : `${header}\r\n`;
}

/** ISO date (YYYY-MM-DD) in the user's local timezone for filename stamps. */
export function todayForFilename(): string {
  const d = new Date();
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Trigger a browser download for the given CSV text. Uses a Blob + anchor
 * + synthetic click; the anchor is detached immediately so no DOM nodes
 * leak. Guarded against SSR contexts (no-op when `document` is undefined).
 */
export function downloadCsv(filename: string, content: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
