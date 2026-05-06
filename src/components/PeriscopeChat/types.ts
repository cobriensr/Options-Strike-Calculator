/**
 * Shared types for the Periscope Chat panel.
 *
 * Mirrors the request/response shapes of `POST /api/periscope-chat`
 * (see api/periscope-chat.ts). Kept on the frontend side so the
 * component, hook, and any future detail/history view share one
 * source of truth.
 */

export type PeriscopeMode = 'pre_trade' | 'intraday' | 'debrief';
export type PeriscopeBias =
  | 'long-only'
  | 'short-only'
  | 'fade-only'
  | 'two-sided'
  | 'no-trade';
export type PeriscopeConfidence = 'low' | 'medium' | 'high';
export type PeriscopeSpotSource = 'db_exact' | 'db_snapped';
export type PeriscopeImageKind = 'chart' | 'gex' | 'charm';
export type PeriscopeImageMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp';

/** A staged image awaiting submission. */
export interface UploadedPeriscopeImage {
  kind: PeriscopeImageKind;
  /** Raw `File` for size + type metadata + revoke-safe object URL preview. */
  file: File;
  /** Object URL for `<img src={preview}>`. Revoked on remove/reset. */
  preview: string;
}

export interface PeriscopeKeyLevels {
  gamma_floor: number | null;
  gamma_ceiling: number | null;
  magnet: number | null;
  charm_zero: number | null;
}

/**
 * Structured fields parsed from the JSON code block at the end of
 * Claude's prose response. Server may set any field to `null` when
 * the chart didn't carry that value (e.g. no cone visible) or when
 * parsing failed. Phase 2 expanded the playbook surface — every new
 * field defaults to null / [] when the model didn't provide it.
 */
export interface PeriscopeStructuredFields {
  spot: number | null;
  cone_lower: number | null;
  cone_upper: number | null;
  long_trigger: number | null;
  short_trigger: number | null;
  regime_tag: string | null;
  bias: PeriscopeBias | null;
  trade_types_recommended: string[];
  trade_types_avoided: string[];
  key_levels: PeriscopeKeyLevels | null;
  expected_dealer_behavior: string | null;
  confidence: PeriscopeConfidence | null;
  confidence_basis: string | null;
}

/** The single final NDJSON envelope from `/api/periscope-chat`. */
export interface PeriscopeChatSuccess {
  ok: true;
  /** New row id in `periscope_analyses`, or `null` if the DB save failed. */
  id: number | null;
  mode: PeriscopeMode;
  prose: string;
  structured: PeriscopeStructuredFields;
  /** Boolean reflecting whether the JSON block parsed cleanly. */
  parseOk: boolean;
  /** SPX spot at read_time as looked up from index_candles_1m. */
  spotAtReadTime: number;
  spotSource: PeriscopeSpotSource;
  /** ISO TIMESTAMPTZ of the read_time the analysis was anchored at. */
  readTime: string;
  model: string;
  durationMs: number;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export interface PeriscopeChatFailure {
  ok: false;
  error: string;
}

export type PeriscopeChatResponse = PeriscopeChatSuccess | PeriscopeChatFailure;

/**
 * Per-kind label + helper text shown under each upload slot. Order
 * controls the visual order in the UI.
 */
export const PERISCOPE_IMAGE_KINDS: ReadonlyArray<{
  kind: PeriscopeImageKind;
  label: string;
  hint: string;
}> = [
  {
    kind: 'chart',
    label: 'Periscope chart',
    hint: 'The 3-panel histogram (Gamma + Charm + Positions).',
  },
  {
    kind: 'gex',
    label: 'Net GEX heat map',
    hint: 'Numeric per-strike gamma table.',
  },
  {
    kind: 'charm',
    label: 'Net Charm heat map',
    hint: 'Numeric per-strike charm table.',
  },
];

export const REGIME_TAG_OPTIONS = [
  'pin',
  'drift-and-cap',
  'gap-and-rip',
  'trap',
  'cone-breach',
  'chop',
  'other',
] as const;
