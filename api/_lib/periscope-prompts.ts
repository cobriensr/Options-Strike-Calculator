/**
 * Pure helpers for the periscope-chat handler.
 *
 * Extracted from `api/periscope-chat.ts` so the parsing / formatting
 * primitives can be unit-tested in isolation. The handler imports
 * everything from this module rather than defining the helpers inline.
 *
 * Functions live here when they are:
 *   - pure (no DB, no network, no SDK call)
 *   - no closure dependency on the handler module
 *   - useful to test on their own
 *
 * Phase 5h of docs/superpowers/specs/api-refactor-2026-05-02.md.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { Sentry } from './sentry.js';
import logger from './logger.js';
import { parseTrailingJsonBlock } from './json-fence.js';
import type {
  ParentChainRow,
  PeriscopeBias,
  PeriscopeConfidence,
  PeriscopeKeyLevels,
  PeriscopeMode,
  PeriscopeParentRead,
  PeriscopeStructuredFields,
} from './periscope-db.js';

// ── User message construction ─────────────────────────────────

/**
 * Build the user message content blocks: a small text preamble
 * (mode + linkage) followed by labelled image blocks. Periscope
 * screenshots are PNG/JPEG/GIF/WEBP base64.
 *
 * In debrief mode, when `parentRead` is supplied the parent's prose +
 * structured fields are inlined into the preamble. Without this Claude
 * sees only `Parent read id: N` (a bare integer) and has no actual open
 * read to score against — the debrief just describes the EOD chart.
 */
export function buildUserContent(args: {
  mode: PeriscopeMode;
  parentId: number | null | undefined;
  parentRead?: PeriscopeParentRead | null;
  /**
   * Oldest-first parent chain (root pre_trade ... immediate parent).
   * Used by `intraday` and `debrief` modes to inject a chain summary
   * block AFTER the mode header and BEFORE the heat-map block.
   * Pre_trade mode ignores this entirely (no parent context).
   */
  parentChain?: ParentChainRow[] | null;
  /**
   * Optional pre-formatted text injected as its own user-content block
   * BEFORE the image blocks. Used by the periscope-chat handler to
   * surface Pass 1B heat-map OCR results so Claude has typed strike
   * values alongside the visual heat maps.
   */
  heatMapBlock?: string | null;
  /**
   * Optional pre-formatted text injected as its own user-content block
   * BETWEEN the heat-map block and the image blocks. Used by the
   * periscope-chat handler to surface ws_flow_alerts informed-flow
   * context (Phase 1.5 of the periscope-chat overhaul spec). Mode-
   * specific framing is built upstream by buildFlowContextBlock().
   */
  flowBlock?: string | null;
  /**
   * Optional pre-formatted text describing the authoritative SPX spot
   * at read time, including its source (db_exact / db_snapped). Built
   * by the periscope-chat handler from {@link fetchSPXSpotAtTimestamp}
   * and injected so Claude binds analysis to the typed value rather
   * than the chart's red dotted line.
   */
  spotDirective?: string | null;
  images: Array<{
    kind: 'chart' | 'gex' | 'charm';
    data: string;
    mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  }>;
}): Anthropic.Messages.ContentBlockParam[] {
  const {
    mode,
    parentId,
    parentRead,
    parentChain,
    heatMapBlock,
    flowBlock,
    spotDirective,
    images,
  } = args;

  const blocks: Anthropic.Messages.ContentBlockParam[] = [];

  // Mode-specific preamble. The skill's worked examples include hindsight
  // checkmarks and outcome data ("Day rallied... settled 7,209.01") which
  // the model otherwise copies into fresh intraday responses — even when
  // the chart's date matches a worked-example date by coincidence. The
  // pre_trade and intraday overrides below stop that leak. Debrief mode
  // keeps hindsight allowed since scoring IS the point there.
  const headerLines = [`Mode: ${mode}`];
  if (parentId != null) headerLines.push(`Parent read id: ${parentId}`);

  let bodyLines: string[];
  switch (mode) {
    case 'pre_trade': {
      bodyLines = buildPreTradeModeBody();
      break;
    }
    case 'intraday': {
      bodyLines = buildIntradayModeBody();
      break;
    }
    case 'debrief': {
      bodyLines = buildDebriefModeBody(parentRead);
      break;
    }
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown periscope mode: ${String(_exhaustive)}`);
    }
  }

  blocks.push({
    type: 'text',
    text: [...headerLines, '', ...bodyLines].join('\n'),
  });

  // Authoritative spot directive (Phase 6B). The handler computes this
  // from index_candles_1m so Claude binds analysis to the DB-verified
  // price rather than reading the chart's red dotted spot line.
  if (spotDirective != null && spotDirective.length > 0) {
    blocks.push({ type: 'text', text: spotDirective });
  }

  // Parent-chain summary (Phase 6C). Only intraday + debrief see prior
  // reads; pre_trade is forward-looking and has no chain.
  if (mode !== 'pre_trade') {
    const chainBlock = formatParentChainBlock(parentChain ?? null);
    if (chainBlock != null) {
      blocks.push({ type: 'text', text: chainBlock });
    }
  }

  // Heat-map OCR results (Pass 1B) go BEFORE the image blocks so Claude
  // sees the typed values first and uses the visual heat maps as a
  // cross-check rather than the primary signal.
  if (heatMapBlock != null && heatMapBlock.length > 0) {
    blocks.push({ type: 'text', text: heatMapBlock });
  }

  // Flow-alert context (Phase 1.5) sits between the heat-map block and
  // the images so it's read after the structured heat-map values but
  // before Claude attends to the actual screenshots.
  if (flowBlock != null && flowBlock.length > 0) {
    blocks.push({ type: 'text', text: flowBlock });
  }

  // Each image gets a label header + the image block, so Claude knows
  // which view it's looking at.
  for (const img of images) {
    blocks.push({ type: 'text', text: `[${img.kind} screenshot]` });
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType,
        data: img.data,
      },
    });
  }

  return blocks;
}

/**
 * Render the oldest-first parent chain as a small headed bullet list.
 * Returns null when the chain is empty so the caller can skip the
 * injection entirely. Each ancestor renders mode + regime + bias + a
 * one-line excerpt of its prose so Claude can reason about the chain
 * without inflating the user content past usefulness.
 */
export function formatParentChainBlock(
  chain: ParentChainRow[] | null,
): string | null {
  if (chain == null || chain.length === 0) return null;

  const lines: string[] = ['## Parent chain (oldest first)'];
  lines.push('');
  lines.push(
    "Earlier reads in today's chain. Read your new bias against this — if you reverse the chain's posture, state the structural reason. Do NOT silently invert.",
  );
  lines.push('');

  for (const row of chain) {
    const meta = [
      `mode=${row.mode}`,
      row.regime_tag ? `regime=${row.regime_tag}` : null,
      row.bias ? `bias=${row.bias}` : null,
    ]
      .filter((s): s is string => s != null)
      .join(' · ');
    lines.push(`- #${row.id} (${meta})`);
    if (row.prose_excerpt.length > 0) {
      lines.push(`  ${row.prose_excerpt}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format a heat-map extraction result as a user-content text block.
 * Returns null when both metric arrays are empty so the caller can
 * skip the injection entirely.
 *
 * The block is labeled clearly so Claude knows the values are MM-
 * attributed Net GEX / Net Charm from UW (not naive). Color is
 * implied by the value's sign and elided to keep the block compact.
 */
export function formatHeatMapBlock(args: {
  gex: Array<{ strike: number; value: number }>;
  charm: Array<{ strike: number; value: number }>;
}): string | null {
  const { gex, charm } = args;
  if (gex.length === 0 && charm.length === 0) return null;

  const lines: string[] = [
    '[Heat-map extracted strikes (MM-attributed Net GEX / Net Charm from UW)]',
  ];

  if (gex.length > 0) {
    lines.push('');
    lines.push('Net GEX (top strikes by absolute value):');
    for (const cell of gex) {
      lines.push(`  ${cell.strike}: ${formatSigned(cell.value)}`);
    }
  }
  if (charm.length > 0) {
    lines.push('');
    lines.push('Net Charm (top strikes by absolute value):');
    for (const cell of charm) {
      lines.push(`  ${cell.strike}: ${formatSigned(cell.value)}`);
    }
  }

  return lines.join('\n');
}

/** Format a number with explicit sign so green/red is unambiguous. */
function formatSigned(n: number): string {
  if (n > 0) return `+${n.toLocaleString('en-US')}`;
  return n.toLocaleString('en-US');
}

/**
 * Pre-trade preamble. No parent context — this is the day's first read,
 * forward-looking, prior to any intraday price action. Hindsight is
 * forbidden in the same way as intraday; only price visible up to
 * read_time on the chart counts.
 */
function buildPreTradeModeBody(): string[] {
  return [
    'YOU ARE IN PRE-TRADE MODE. Produce the day playbook BEFORE the open: setup → structural map → charm flow tally → trade thesis with bilateral triggers (long + short, stops, targets, R:R, no-trade zone) → regime label → the required JSON block at the very end.',
    '',
    'No prior intraday reads exist for today — there is no chain to reconcile against. Treat this as a fresh forward-looking read.',
    '',
    'DO NOT include any worked-example outcomes, "the day delivered", settlement values, ✓ check-marks, "what triggered", "what actually happened", or any hindsight scoring. Stop the response after the JSON block.',
    '',
    "If the chart's date or structure resembles a worked example in the skill, treat this as a fresh real-time read. The user already knows the worked-example outcomes — do not repeat them.",
  ];
}

/**
 * Intraday preamble. Has a parent chain (today's pre_trade plus any
 * earlier intraday reads). Must reconcile against the chain rather
 * than silently inverting a prior bias.
 */
function buildIntradayModeBody(): string[] {
  return [
    'YOU ARE IN INTRADAY MODE. Produce a forward-looking thesis-maintenance read of the chart in front of you. Output ONLY:',
    '  - Setup at slice end (current spot + immediate context)',
    '  - Structural map (gamma + charm + positions levels)',
    '  - Charm flow tally → directional bias',
    '  - Trade thesis with bilateral triggers (long + short), stops, targets, R:R, no-trade zone',
    '  - Regime label',
    '  - The required JSON block at the very end',
    '',
    "Reconcile against the parent chain. If you reverse the chain's bias, state the structural reason explicitly (a specific gamma / charm / positions change in this slice). Do NOT silently invert.",
    '',
    'DO NOT include any "## Debrief", "what triggered", "what actually happened", "the day delivered", settlement values, ✓ check-marks, or any hindsight scoring. Stop the response after the JSON block.',
    '',
    "If the chart's date or structure resembles a worked example in the skill, treat this as a fresh real-time read. The user already knows the worked-example outcomes — do not repeat them.",
  ];
}

/**
 * Render the parent read as a labelled prose section that Claude can score
 * against. Structured fields go first as a compact summary, then the full
 * prose. Both are needed: structured fields give Claude the exact trigger
 * levels for an unambiguous score; prose carries the thesis / regime
 * reasoning so the debrief can reference *why* the read called what it
 * called, not just whether the price hit a number.
 */
function buildDebriefModeBody(
  parent: PeriscopeParentRead | null | undefined,
): string[] {
  const head = [
    'YOU ARE IN DEBRIEF MODE. Score the open read below against actual price action visible in the candle chart. Honest facts only — no retroactive justification.',
  ];
  if (parent == null) return head;

  const s = parent.structured;
  const fmt = (n: number | null) => (n == null ? 'n/a' : n.toString());
  return [
    ...head,
    '',
    `## Open read to score (id ${parent.id}, ${parent.tradingDate})`,
    '',
    'Structured fields from the open read:',
    `- spot: ${fmt(s.spot)}`,
    `- cone: ${fmt(s.cone_lower)} – ${fmt(s.cone_upper)}`,
    `- long trigger: ${fmt(s.long_trigger)}`,
    `- short trigger: ${fmt(s.short_trigger)}`,
    `- regime: ${s.regime_tag ?? 'n/a'}`,
    '',
    'Full prose of the open read:',
    '',
    parent.proseText.length > 0 ? parent.proseText : '(no prose recorded)',
  ];
}

// ── Structured-output extraction ──────────────────────────────

/**
 * Result of `parseStructuredFields`. `parseOk` is true iff a JSON block
 * was found AND JSON.parse succeeded. We surface it as a sibling field
 * (rather than mixing it into `PeriscopeStructuredFields`) because the
 * structured shape models the model's typed output; `parseOk` is parser
 * metadata. Phase 6A migration adds the DB column; for Phase 1 the
 * caller propagates it through the response payload only.
 */
export interface ParsedStructuredOutput {
  prose: string;
  structured: PeriscopeStructuredFields;
  parseOk: boolean;
}

/**
 * Extract the LAST fenced ```json...``` block from the response. Returns
 * { prose, structured, parseOk }. On any parse failure: prose is the full
 * text unchanged, structured is all-null, parseOk is false, and a Sentry
 * event is recorded for JSON.parse errors.
 *
 * Why "last" block: Claude may include illustrative JSON snippets earlier
 * in the prose (e.g. quoting a sample column shape). The structured-output
 * block is appended at the very end per the skill instruction, so we
 * always pick the last match.
 *
 * Block-finding is delegated to `parseTrailingJsonBlock` (json-fence.ts);
 * this function owns field coercion + Sentry reporting only.
 */
/** Empty / null payload used when no JSON block was found or parsed. */
function emptyStructured(): PeriscopeStructuredFields {
  return {
    spot: null,
    cone_lower: null,
    cone_upper: null,
    long_trigger: null,
    short_trigger: null,
    regime_tag: null,
    bias: null,
    trade_types_recommended: [],
    trade_types_avoided: [],
    key_levels: null,
    expected_dealer_behavior: null,
    confidence: null,
    confidence_basis: null,
    futures_plan: null,
  };
}

const BIAS_VALUES = new Set<PeriscopeBias>([
  'long-only',
  'short-only',
  'fade-only',
  'two-sided',
  'no-trade',
]);

const CONFIDENCE_VALUES = new Set<PeriscopeConfidence>([
  'low',
  'medium',
  'high',
]);

function coerceStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

function coerceKeyLevels(raw: unknown): PeriscopeKeyLevels | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  // Only emit a key_levels object if at least ONE field came back numeric;
  // otherwise the column would carry an all-null shape that's no more
  // informative than NULL.
  const out: PeriscopeKeyLevels = {
    gamma_floor: num(o.gamma_floor),
    gamma_ceiling: num(o.gamma_ceiling),
    magnet: num(o.magnet),
    charm_zero: num(o.charm_zero),
  };
  if (
    out.gamma_floor == null &&
    out.gamma_ceiling == null &&
    out.magnet == null &&
    out.charm_zero == null
  ) {
    return null;
  }
  return out;
}

/**
 * Anthropic tool definition for the structured playbook fields.
 *
 * Forced via `tool_choice: { type: 'tool', name: STRUCTURED_TOOL_NAME }`
 * so Claude is required to emit a valid `tool_use` block on every
 * call. Anthropic constrains generation against the `input_schema`,
 * which eliminates the JSON.parse failure mode that occurred when
 * free-text prose fields contained unescaped control characters
 * (Sentry: "Bad control character in string literal in JSON" — fixed
 * 2026-05-11 by migrating away from fenced ```json blocks).
 *
 * Field descriptions act as implicit prompt instructions per the
 * llm-structured-output skill — keep them prescriptive.
 */
export const STRUCTURED_TOOL_NAME = 'emit_playbook_structured';

export const STRUCTURED_TOOL: Anthropic.Messages.Tool = {
  name: STRUCTURED_TOOL_NAME,
  description:
    'Emit the structured fields of the playbook (typed parallel to the prose narrative). Call this exactly once per read with all fields populated to the best of your ability; use null / empty arrays when a field is genuinely unavailable for the current read.',
  input_schema: {
    type: 'object',
    properties: {
      spot: {
        type: ['number', 'null'],
        description:
          'SPX cash spot at read time. The system overwrites this with the authoritative DB-resolved spot; emit your best read of the panel here for prose consistency.',
      },
      cone_lower: {
        type: ['number', 'null'],
        description:
          'Lower bound of the 0DTE straddle breakeven cone (cone.lower).',
      },
      cone_upper: {
        type: ['number', 'null'],
        description:
          'Upper bound of the 0DTE straddle breakeven cone (cone.upper).',
      },
      long_trigger: {
        type: ['number', 'null'],
        description:
          'Long-side trigger price. MUST be strictly below gamma_ceiling (the structural target). If the chart has no clean upside structural target above the trigger zone, emit null.',
      },
      short_trigger: {
        type: ['number', 'null'],
        description:
          'Short-side trigger price. MUST be strictly above gamma_floor (the structural target). If the chart has no clean downside structural target below the trigger zone, emit null.',
      },
      regime_tag: {
        type: ['string', 'null'],
        description:
          'Regime label. Common values: pin, drift-and-cap, cone-breach, cone-breach-up, cone-breach-down, chop, gap-and-rip, trap.',
      },
      bias: {
        type: ['string', 'null'],
        enum: [
          'long-only',
          'short-only',
          'fade-only',
          'two-sided',
          'no-trade',
          null,
        ],
        description: 'Directional bias for the read.',
      },
      trade_types_recommended: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Recommended structures, e.g. iron_condor, debit_call_spread, broken_wing_butterfly. For iron_condor / iron_butterfly the wings are gamma_floor / gamma_ceiling — NOT the cone bounds.',
      },
      trade_types_avoided: {
        type: 'array',
        items: { type: 'string' },
        description: 'Structures explicitly to avoid given the current read.',
      },
      key_levels: {
        type: ['object', 'null'],
        properties: {
          gamma_floor: { type: ['number', 'null'] },
          gamma_ceiling: { type: ['number', 'null'] },
          magnet: { type: ['number', 'null'] },
          charm_zero: { type: ['number', 'null'] },
        },
        description: 'Structural level map. Floor / ceiling are the IC wings.',
      },
      expected_dealer_behavior: {
        type: ['string', 'null'],
        description:
          'One-paragraph prose describing how dealers are expected to behave given the current gamma / charm topology. Multi-sentence is fine; the tool channel handles control characters correctly.',
      },
      confidence: {
        type: ['string', 'null'],
        enum: ['low', 'medium', 'high', null],
        description: 'Conviction level for the directional / structural call.',
      },
      confidence_basis: {
        type: ['string', 'null'],
        description:
          'Short prose explaining what justifies the confidence level. May span multiple sentences.',
      },
      futures_plan: {
        type: ['string', 'null'],
        description:
          'LONG / SHORT / WAIT framing in prose, tying futures execution to the structural levels above. May span multiple paragraphs.',
      },
    },
    required: [],
  },
};

/**
 * Extract structured fields from a `tool_use` block's `input` (already
 * parsed by Anthropic — no JSON.parse needed). Reuses the coercion +
 * enum-validation logic from {@link parseStructuredFields} so the
 * runtime output shape is identical regardless of channel.
 *
 * Use this when the runner forces `tool_choice` on the call. The
 * function returns `parseOk: false` only when the tool input is
 * absent or shape-malformed (e.g. wrong asset name) — never on the
 * control-character-in-string failure mode that plagued JSON.parse.
 */
export function parseStructuredFieldsFromToolInput(
  toolInput: unknown,
  prose: string,
): ParsedStructuredOutput {
  if (toolInput == null || typeof toolInput !== 'object') {
    logger.warn(
      { toolInputType: typeof toolInput },
      'periscope-chat: tool_use block missing or not an object',
    );
    return { prose, structured: emptyStructured(), parseOk: false };
  }
  const structured = coerceStructured(toolInput as Record<string, unknown>);
  return { prose, structured, parseOk: true };
}

/**
 * Shared field coercion. Extracted so both `parseStructuredFields`
 * (legacy JSON-block path, kept for back-compat with periscope-chat
 * manual flows) and `parseStructuredFieldsFromToolInput` (tool_use
 * path, used by the auto-playbook) produce identical typed output.
 */
function coerceStructured(
  parsed: Record<string, unknown>,
): PeriscopeStructuredFields {
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;

  const biasRaw = parsed.bias;
  const bias =
    typeof biasRaw === 'string' && BIAS_VALUES.has(biasRaw as PeriscopeBias)
      ? (biasRaw as PeriscopeBias)
      : null;

  const confidenceRaw = parsed.confidence;
  const confidence =
    typeof confidenceRaw === 'string' &&
    CONFIDENCE_VALUES.has(confidenceRaw as PeriscopeConfidence)
      ? (confidenceRaw as PeriscopeConfidence)
      : null;

  return {
    spot: num(parsed.spot),
    cone_lower: num(parsed.cone_lower),
    cone_upper: num(parsed.cone_upper),
    long_trigger: num(parsed.long_trigger),
    short_trigger: num(parsed.short_trigger),
    regime_tag: str(parsed.regime_tag),
    bias,
    trade_types_recommended: coerceStringArray(parsed.trade_types_recommended),
    trade_types_avoided: coerceStringArray(parsed.trade_types_avoided),
    key_levels: coerceKeyLevels(parsed.key_levels),
    expected_dealer_behavior: str(parsed.expected_dealer_behavior),
    confidence,
    confidence_basis: str(parsed.confidence_basis),
    futures_plan: str(parsed.futures_plan),
  };
}

export function parseStructuredFields(text: string): ParsedStructuredOutput {
  const block = parseTrailingJsonBlock(text);
  if (block == null) {
    logger.warn('periscope-chat: no JSON code block in response');
    return { prose: text, structured: emptyStructured(), parseOk: false };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(block.body) as Record<string, unknown>;
  } catch (err) {
    logger.error(
      { err, blockBody: block.body.slice(0, 200) },
      'periscope-chat: failed to parse JSON block',
    );
    Sentry.captureException(err);
    return { prose: text, structured: emptyStructured(), parseOk: false };
  }

  const structured = coerceStructured(parsed);

  // Reassemble prose around the stripped block. `before` is the text up
  // to the open fence; `after` is rare trailing prose past the close
  // fence. trimEnd matches the prior behavior so callers don't see
  // dangling whitespace.
  const prose = (block.before + block.after).trimEnd();

  return { prose, structured, parseOk: true };
}

/**
 * Build a short prose-shaped sentence carrying the extracted structural
 * levels. Used as the proseText input to buildPeriscopeSummary when
 * constructing the retrieval query, so the query embedding overlaps
 * semantically with stored rows whose actual prose discusses similar
 * spot / cone levels. Drops fields that came back null to keep the
 * sentence terse and avoid embedding the literal word "null".
 */
export function synthesizeStructuralProse(
  s: PeriscopeStructuredFields,
): string {
  const parts: string[] = [];
  if (s.spot != null) parts.push(`spot at ${s.spot}`);
  if (s.cone_lower != null && s.cone_upper != null) {
    parts.push(
      `the 0DTE straddle cone bounded between ${s.cone_lower} and ${s.cone_upper}`,
    );
  } else if (s.cone_lower != null) {
    parts.push(`cone lower bound at ${s.cone_lower}`);
  } else if (s.cone_upper != null) {
    parts.push(`cone upper bound at ${s.cone_upper}`);
  }
  if (parts.length === 0) return '';
  return `0DTE SPX Periscope read with ${parts.join(' and ')}.`;
}
