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
  images: Array<{
    kind: 'chart' | 'gex' | 'charm';
    data: string;
    mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  }>;
}): Anthropic.Messages.ContentBlockParam[] {
  const { mode, parentId, parentRead, heatMapBlock, flowBlock, images } = args;

  const blocks: Anthropic.Messages.ContentBlockParam[] = [];

  // Mode-specific preamble. The skill's worked examples include hindsight
  // checkmarks and outcome data ("Day rallied... settled 7,209.01") which
  // the model otherwise copies into fresh Read responses — even when the
  // chart's date matches a worked-example date by coincidence. The Read
  // override below stops that leak. Debrief mode keeps the original
  // behavior since hindsight/scoring IS the point there.
  const headerLines = [`Mode: ${mode}`];
  if (parentId != null) headerLines.push(`Parent read id: ${parentId}`);

  const bodyLines =
    mode === 'read' ? buildReadModeBody() : buildDebriefModeBody(parentRead);

  blocks.push({
    type: 'text',
    text: [...headerLines, '', ...bodyLines].join('\n'),
  });

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

function buildReadModeBody(): string[] {
  return [
    'YOU ARE IN READ MODE. Produce a forward-looking real-time read of the chart in front of you. Output ONLY:',
    '  - Setup at slice end (current spot + immediate context)',
    '  - Structural map (gamma + charm + positions levels)',
    '  - Charm flow tally → directional bias',
    '  - Trade thesis with bilateral triggers (long + short), stops, targets, R:R, no-trade zone',
    '  - Regime label',
    '  - The required JSON block at the very end',
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
export function parseStructuredFields(text: string): ParsedStructuredOutput {
  const nullStructured: PeriscopeStructuredFields = {
    spot: null,
    cone_lower: null,
    cone_upper: null,
    long_trigger: null,
    short_trigger: null,
    regime_tag: null,
  };

  const block = parseTrailingJsonBlock(text);
  if (block == null) {
    logger.warn('periscope-chat: no JSON code block in response');
    return { prose: text, structured: nullStructured, parseOk: false };
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
    return { prose: text, structured: nullStructured, parseOk: false };
  }

  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;

  const structured: PeriscopeStructuredFields = {
    spot: num(parsed.spot),
    cone_lower: num(parsed.cone_lower),
    cone_upper: num(parsed.cone_upper),
    long_trigger: num(parsed.long_trigger),
    short_trigger: num(parsed.short_trigger),
    regime_tag: str(parsed.regime_tag),
  };

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
