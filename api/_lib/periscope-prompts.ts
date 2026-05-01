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
import type {
  PeriscopeMode,
  PeriscopeStructuredFields,
} from './periscope-db.js';

// ── User message construction ─────────────────────────────────

/**
 * Build the user message content blocks: a small text preamble
 * (mode + linkage) followed by labelled image blocks. Periscope
 * screenshots are PNG/JPEG/GIF/WEBP base64.
 */
export function buildUserContent(args: {
  mode: PeriscopeMode;
  parentId: number | null | undefined;
  images: Array<{
    kind: 'chart' | 'gex' | 'charm';
    data: string;
    mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  }>;
}): Anthropic.Messages.ContentBlockParam[] {
  const { mode, parentId, images } = args;

  const blocks: Anthropic.Messages.ContentBlockParam[] = [];

  // Mode-specific preamble. The skill's worked examples include hindsight
  // checkmarks and outcome data ("Day rallied... settled 7,209.01") which
  // the model otherwise copies into fresh Read responses — even when the
  // chart's date matches a worked-example date by coincidence. The Read
  // override below stops that leak. Debrief mode keeps the original
  // behavior since hindsight/scoring IS the point there.
  const preambleLines: string[] = [`Mode: ${mode}`];
  if (parentId != null) preambleLines.push(`Parent read id: ${parentId}`);
  if (mode === 'read') {
    preambleLines.push(
      '',
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
    );
  } else {
    preambleLines.push(
      '',
      'YOU ARE IN DEBRIEF MODE. Score the open read against actual price action visible in the candle chart. Honest facts only — no retroactive justification.',
    );
  }
  blocks.push({ type: 'text', text: preambleLines.join('\n') });

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

// ── Structured-output extraction ──────────────────────────────

/**
 * Extract the LAST fenced ```json...``` block from the response. Returns
 * { prose: text-with-block-stripped, structured: parsed-fields-or-nulls }.
 * On any parse failure: prose is the full text unchanged, structured is
 * all-null, and a Sentry event is recorded.
 *
 * Why "last" block: Claude may include illustrative JSON snippets earlier
 * in the prose (e.g. quoting a sample column shape). The structured-output
 * block is appended at the very end per the skill instruction, so we
 * always pick the last match.
 *
 * Implementation: uses lastIndexOf rather than a regex so the parse is
 * O(n) and immune to ReDoS backtracking on adversarial input.
 */
export function parseStructuredFields(text: string): {
  prose: string;
  structured: PeriscopeStructuredFields;
} {
  const nullStructured: PeriscopeStructuredFields = {
    spot: null,
    cone_lower: null,
    cone_upper: null,
    long_trigger: null,
    short_trigger: null,
    regime_tag: null,
  };

  const OPEN_FENCE = '```json';
  const CLOSE_FENCE = '```';

  // Walk backward to find the LAST closing fence, then look behind it
  // for its matching opening fence. We need to skip the open fence's own
  // closing-`` ``` `` characters when scanning, hence the search-backward
  // from `(lastClose - 1)`.
  const lastClose = text.lastIndexOf(CLOSE_FENCE);
  if (lastClose < 0) {
    logger.warn('periscope-chat: no JSON code block in response');
    return { prose: text, structured: nullStructured };
  }
  const lastOpen = text.lastIndexOf(OPEN_FENCE, lastClose - 1);
  if (lastOpen < 0 || lastOpen >= lastClose) {
    logger.warn('periscope-chat: no JSON code block in response');
    return { prose: text, structured: nullStructured };
  }

  // Body starts after the first newline following ```json (skipping any
  // trailing whitespace on the open-fence line) and ends at the close
  // fence (we trim trailing whitespace from the body itself).
  const bodyStartNewline = text.indexOf('\n', lastOpen + OPEN_FENCE.length);
  if (bodyStartNewline < 0 || bodyStartNewline >= lastClose) {
    logger.warn('periscope-chat: malformed JSON code block');
    return { prose: text, structured: nullStructured };
  }
  const blockBody = text.slice(bodyStartNewline + 1, lastClose).trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(blockBody) as Record<string, unknown>;
  } catch (err) {
    logger.error(
      { err, blockBody: blockBody.slice(0, 200) },
      'periscope-chat: failed to parse JSON block',
    );
    Sentry.captureException(err);
    return { prose: text, structured: nullStructured };
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

  // Strip the matched JSON block from the prose. Slice off everything
  // from the opening fence through the closing fence (3 chars long).
  const prose = text
    .slice(0, lastOpen)
    .concat(text.slice(lastClose + CLOSE_FENCE.length))
    .trimEnd();

  return { prose, structured };
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
