/**
 * User-message assembler for /api/trace-live-analyze.
 *
 * Mirrors `analyze-context.ts` but much simpler — there's no DB I/O, no
 * embeddings, no historical lookback. Just turn the per-tick payload
 * (3 chart images + structured GEX landscape + session context) into the
 * Anthropic `messages[0].content` array, with the GEX text injected as a
 * text block alongside the three image blocks.
 *
 * Pattern:
 *   [
 *     { type: 'text',  text: SESSION CONTEXT block },
 *     { type: 'text',  text: GEX LANDSCAPE block (with override-rule pre-computed) },
 *     { type: 'text',  text: '[Gamma Heatmap — slot=now ...]' },
 *     { type: 'image', source: { type: 'base64', data: ..., media_type: 'image/png' } },
 *     { type: 'text',  text: '[Charm Pressure Heatmap — ...]' },
 *     { type: 'image', source: { ... } },
 *     { type: 'text',  text: '[Delta Pressure Heatmap — ...]' },
 *     { type: 'image', source: { ... } },
 *   ]
 *
 * Order matters: GEX text BEFORE the chart images, so Claude reads the
 * deterministic per-strike magnitudes (and the dominant-node calculation)
 * before scanning the heatmaps for topology.
 */

import type {
  ContentBlockParam,
  ImageBlockParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { TraceLiveAnalyzeBody } from './trace-live-types.js';
import {
  formatGexLandscapeForClaude,
  formatImageLabel,
  formatSessionContext,
} from './trace-live-context-formatters.js';

/**
 * Build the per-tick user-message content array. Each tick produces a fresh
 * content array; nothing here should be cached (it changes every call). The
 * stable system prompt is the cache boundary — see trace-live-prompts.ts.
 */
export function buildTraceLiveUserContent(
  body: TraceLiveAnalyzeBody,
): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];

  // 1. Session context — timestamp, spot, stability — first so Claude
  //    knows the "now" reference for everything that follows.
  blocks.push({
    type: 'text',
    text: formatSessionContext({
      capturedAt: body.capturedAt,
      etTimeLabel: body.etTimeLabel,
      spot: body.spot,
      stabilityPct: body.stabilityPct,
    }),
  } satisfies TextBlockParam);

  // 2. Structured GEX landscape — read magnitudes from this, not from
  //    the GEX sidebar in the images. The formatter computes the
  //    dominant-node ratio and emits the override-rule verdict inline.
  blocks.push({
    type: 'text',
    text: formatGexLandscapeForClaude(body.gex, body.spot),
  } satisfies TextBlockParam);

  // 3. Three chart images, each preceded by a label so Claude knows
  //    which heatmap is which. Anthropic's vision pipeline reads images
  //    in array order; the label-then-image pattern keeps interpretation
  //    unambiguous when multiple images are present.
  //    Order: gamma → charm → delta (the canonical reading order from
  //    the override hierarchy in the system prompt).
  const orderedCharts: Array<'gamma' | 'charm' | 'delta'> = [
    'gamma',
    'charm',
    'delta',
  ];
  for (const chart of orderedCharts) {
    const img = body.images.find((i) => i.chart === chart);
    if (!img) continue; // skip if a chart wasn't captured this tick
    blocks.push({
      type: 'text',
      text: formatImageLabel(img, body.spot),
    } satisfies TextBlockParam);
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType,
        data: img.data,
      },
    } satisfies ImageBlockParam);
  }

  // 4. Closing instruction — not strictly needed since the system prompt
  //    already specifies the schema, but a final nudge keeps Claude from
  //    drifting into prose mode when the analysis is uncertain.
  blocks.push({
    type: 'text',
    text:
      'Read the gamma chart first per the override hierarchy, then charm, then delta. ' +
      'Apply the gamma override rule using the structured per-strike data above ' +
      '(do not estimate magnitudes from the heatmap pixels). ' +
      'Return a single JSON object matching the TraceAnalysis schema.',
  } satisfies TextBlockParam);

  return blocks;
}
