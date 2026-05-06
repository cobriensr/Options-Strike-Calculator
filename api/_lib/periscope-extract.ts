/**
 * Vision-only structural extraction calls for /api/periscope-chat.
 *
 * Two passes share this module:
 *
 *   - Pass 1A — `extractChartStructure`: reads spot + cone bounds + the
 *     chart's labeled date from the price-action panel. Drives the
 *     retrieval embedding so we match past reads by chart topology, not
 *     by user prose.
 *
 *   - Pass 1B — `extractHeatMapStrikes`: OCRs UW's MM-attributed Net GEX
 *     and Net Charm per-strike values from the heat-map panels. Returns
 *     top 5 positive + top 5 negative per metric. Skipped entirely when
 *     no heat-map images are uploaded (pre_trade can fall back to the
 *     `greek_exposure_strike` morning snapshot — handled by the caller).
 *
 * Why two Opus calls (not Haiku for the extraction pass):
 *   The user reported quality issues with Sonnet on Periscope reads,
 *   so Haiku was rejected as too risky. Cost trade-off accepted:
 *   ~3× Opus per submission, in exchange for retrieval that actually
 *   reflects today's chart shape AND structured per-strike values.
 *
 * Failure mode: each function returns null on any error. Extraction is
 * best-effort; the main analysis path proceeds without it.
 *
 * The Anthropic client is passed in as a parameter rather than
 * constructed at module scope. This keeps client lifecycle (timeouts,
 * retries, sentry breadcrumbs) the responsibility of the caller and
 * avoids a duplicate `new Anthropic(...)` for code paths that already
 * have one.
 */

import type Anthropic from '@anthropic-ai/sdk';
import logger from './logger.js';
import { Sentry } from './sentry.js';
import { parseTrailingJsonBlock } from './json-fence.js';
import type { PeriscopeStructuredFields } from './periscope-db.js';

const MODEL = 'claude-opus-4-7';

// 2048 tokens is plenty for the small JSON response and the model's
// brief internal reasoning. Higher caps just risk runaway prose.
const MAX_TOKENS = 2048;

// 4096 tokens for heat-map OCR — slightly more headroom than the spot
// extraction since each panel can yield up to 10 strikes (5 pos + 5 neg)
// across two metrics, but the JSON shape is still small.
const HEATMAP_MAX_TOKENS = 4096;

// Stable, cacheable system prompt for extraction. Cache hit on repeat
// submissions saves the system-prompt input cost on the extraction
// path — small absolute saving, but free.
//
// Cone OCR enhancement (Phase 1B): cone bounds are visible in TWO
// places on a Periscope chart:
//   - the diverging triangular dashed lines drawn over the price-action
//     panel; and
//   - horizontal labeled dashed lines on the heat-map panels (often with
//     the exact value labeled, e.g. "7,266.66" upper / "7,218.46" lower).
// Use whichever is clearer. When both are visible they should match —
// the heat-map labels are typed text and therefore more reliable.
const EXTRACTION_SYSTEM_PROMPT = `You are a vision-extraction assistant for a 0DTE SPX trading tool. Your only job is to read four values from a Periscope chart screenshot:

- chart_date: the trading date the chart is FOR, in ISO YYYY-MM-DD form. Periscope chart headers display this as a labelled date (e.g. "Thu, Apr 30" + a year, or a short "4/30/2026" label, often near the chart title or top toolbar). Read whatever the chart actually shows, then normalize to YYYY-MM-DD. If the year is implied but ambiguous, use the most recent year that makes the date a real trading day.
- spot: the current price (typically a white or highlighted horizontal line near the middle of the chart)
- cone_lower: the 0DTE straddle Cone lower bound. Two visible cues: (a) the lower edge of the diverging triangular dashed lines drawn over the price-action panel, and (b) a horizontal labeled dashed line on the heat-map panels — typically with the exact value printed next to it (e.g. "7,218.46"). Prefer the labeled horizontal line on the heat-map when visible; fall back to the price-action triangle. If both are visible they should match.
- cone_upper: the 0DTE straddle Cone upper bound. Same dual-cue rule as cone_lower (e.g. "7,266.66" upper). Prefer the labeled horizontal heat-map line; fall back to the upper edge of the price-action triangle.

You do NOT analyze, predict, recommend, or comment on the chart. You only extract these values from the chart.

Return ONLY a single fenced JSON code block at the end of your response and nothing else:

\`\`\`json
{
  "chart_date": "YYYY-MM-DD" or null,
  "spot": <number or null>,
  "cone_lower": <number or null>,
  "cone_upper": <number or null>
}
\`\`\`

Rules:
- If a value is not clearly visible, use null. Do not guess.
- Use the actual numeric price level (e.g. 5710.5), not a description.
- When all three numerics are visible, cone_lower < spot < cone_upper.
- No prose before or after the JSON block.`;

// Pass 1B: OCR per-strike Net GEX / Net Charm values from the heat-map
// panels. Each cell on a UW Periscope heat map is labeled with a strike
// (left-side y-axis) and a numeric value with a sign — the values are
// UW's MM-attributed Net GEX / Net Charm (NOT naive). Do NOT compute
// anything; just read what's printed.
const EXTRACTION_HEATMAP_SYSTEM_PROMPT = `You are a vision-OCR assistant for a 0DTE SPX trading tool. You will be shown one or both of the following heat-map screenshots:

- gex: the Net Gamma Exposure (Net GEX) heat map
- charm: the Net Charm heat map

Each heat-map cell is rendered as a horizontal bar on a per-strike row. The strike (e.g. "7,275") is labeled at the left-axis. The numeric value is printed inside or next to the bar, with a sign (e.g. "+1.45M", "-1.37M", "72,521.31", "-43,210.87"). GREEN bars/values are positive; RED bars/values are negative.

The values shown are UW's MM-attributed Net GEX and Net Charm — DO NOT compute, infer, derive, or estimate anything. Read each cell exactly as labeled. Convert "M" suffixes to absolute numbers (e.g. "+1.45M" → 1450000; "-1.37M" → -1370000). Convert "K" suffixes likewise (e.g. "+72.5K" → 72500).

For EACH metric provided, return:
- top 5 positive strikes by value (largest positive first)
- top 5 negative strikes by absolute value (most negative first)

If a metric's image is NOT provided, return an empty array for that side. Do NOT make up values.

Return ONLY a single fenced JSON code block at the end of your response and nothing else:

\`\`\`json
{
  "gex": [
    {"strike": 7275, "value": 1450000, "color": "green"},
    {"strike": 7280, "value": 720000, "color": "green"},
    {"strike": 7295, "value": -1370000, "color": "red"}
  ],
  "charm": [
    {"strike": 7240, "value": 72521, "color": "green"},
    {"strike": 7260, "value": -43210, "color": "red"}
  ]
}
\`\`\`

Rules:
- Strike is a number (no commas, no quotes).
- Value is a signed number; positive when color=green, negative when color=red.
- Color must be "green" or "red" (lowercase) and must match the value's sign.
- Skip a strike if you can't read its value cleanly.
- Skip the metric (return []) if its image isn't provided.
- No prose before or after the JSON block.`;

interface ExtractionInput {
  images: Array<{
    kind: 'chart' | 'gex' | 'charm';
    data: string;
    mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  }>;
}

/**
 * Result of a successful Pass 1A extraction. Carries the structured
 * field shape the main analysis pipeline expects, plus the chart's
 * actual trading date pulled from its date label — used to stamp
 * `trading_date` so back-reads aren't mis-tagged with the capture
 * time's date.
 */
export interface PeriscopeExtractionResult {
  structured: PeriscopeStructuredFields;
  /** ISO YYYY-MM-DD if read off the chart; null if not visible. */
  chartDate: string | null;
}

/** Single OCR'd cell from a heat-map panel. */
export interface HeatMapStrike {
  strike: number;
  value: number;
  /** Color matches sign: positive → green, negative → red. */
  color: 'green' | 'red';
}

/** Heat-map image input for Pass 1B. */
export interface HeatMapImage {
  data: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

/** Result of a successful Pass 1B heat-map OCR. */
export interface HeatMapExtraction {
  gex: HeatMapStrike[];
  charm: HeatMapStrike[];
}

/**
 * Run the Pass 1A vision-only extraction. Returns a result with
 * structured fields + chart_date on success. Returns null on any
 * failure (timeout, parse error, refusal, network).
 */
export async function extractChartStructure(
  input: ExtractionInput,
  anthropic: Anthropic,
): Promise<PeriscopeExtractionResult | null> {
  // Only the chart screenshot has spot + cone. Heat maps are useful for
  // the main analysis but irrelevant for structural extraction. Prefer
  // an image labeled 'chart'; fall back to the first image when no
  // image is so labeled (defensive — frontend always labels them).
  const chartImage =
    input.images.find((img) => img.kind === 'chart') ?? input.images[0];
  if (!chartImage) return null;

  let text: string;
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: 'text',
          text: EXTRACTION_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: chartImage.mediaType,
                data: chartImage.data,
              },
            },
            {
              type: 'text',
              text: 'Extract spot, cone_lower, and cone_upper from this Periscope chart.',
            },
          ],
        },
      ],
    });
    text = response.content
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''))
      .join('');
  } catch (err) {
    logger.error({ err }, 'extractChartStructure: Anthropic call failed');
    Sentry.captureException(err);
    return null;
  }

  return parseExtraction(text);
}

/**
 * Run the Pass 1B heat-map OCR. Accepts gex and/or charm heat-map
 * images and returns top 5 positive + top 5 negative strikes per metric.
 * Returns null on any failure or when neither image is provided.
 *
 * The single Anthropic call sees both images at once so the model can
 * label them consistently — splitting into two calls would double cost
 * with no quality gain.
 */
export async function extractHeatMapStrikes(
  input: { gex?: HeatMapImage; charm?: HeatMapImage },
  anthropic: Anthropic,
): Promise<HeatMapExtraction | null> {
  if (!input.gex && !input.charm) return null;

  const userBlocks: Anthropic.Messages.ContentBlockParam[] = [];
  const provided: string[] = [];
  if (input.gex) {
    userBlocks.push({ type: 'text', text: '[gex heat map]' });
    userBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: input.gex.mediaType,
        data: input.gex.data,
      },
    });
    provided.push('gex');
  }
  if (input.charm) {
    userBlocks.push({ type: 'text', text: '[charm heat map]' });
    userBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: input.charm.mediaType,
        data: input.charm.data,
      },
    });
    provided.push('charm');
  }
  userBlocks.push({
    type: 'text',
    text: `Extract the top 5 positive + top 5 negative per-strike values for: ${provided.join(' and ')}. Return only the JSON block.`,
  });

  let text: string;
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: HEATMAP_MAX_TOKENS,
      system: [
        {
          type: 'text',
          text: EXTRACTION_HEATMAP_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: userBlocks,
        },
      ],
    });
    text = response.content
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''))
      .join('');
  } catch (err) {
    logger.error({ err }, 'extractHeatMapStrikes: Anthropic call failed');
    Sentry.captureException(err);
    return null;
  }

  return parseHeatMapExtraction(text);
}

/** Loose ISO-date matcher used to validate the model's date string. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse the LAST fenced ```json...``` block from the response into
 * the extraction result. Returns null on any parse failure (no block,
 * malformed JSON, missing/non-numeric fields).
 *
 * Block-finding is delegated to `parseTrailingJsonBlock`; this function
 * owns field coercion only.
 */
function parseExtraction(text: string): PeriscopeExtractionResult | null {
  const block = parseTrailingJsonBlock(text);
  if (block == null) {
    logger.warn('extractChartStructure: no JSON code block in response');
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(block.body) as Record<string, unknown>;
  } catch (err) {
    logger.error(
      { err, blockBody: block.body.slice(0, 200) },
      'extractChartStructure: failed to parse JSON block',
    );
    return null;
  }

  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  // Each field must coerce to a finite number or explicit null. If
  // everything is null the model couldn't read the chart; fall back to
  // context-based retrieval rather than embedding an empty fingerprint.
  const spot = num(parsed.spot);
  const coneLower = num(parsed.cone_lower);
  const coneUpper = num(parsed.cone_upper);
  if (spot == null && coneLower == null && coneUpper == null) return null;

  // chart_date is best-effort. Validate as ISO YYYY-MM-DD so we never
  // pass a malformed date downstream into the DB. A null here means the
  // caller falls back to capture-day-as-trading-day.
  const rawDate =
    typeof parsed.chart_date === 'string' ? parsed.chart_date : null;
  const chartDate =
    rawDate != null && ISO_DATE_PATTERN.test(rawDate) ? rawDate : null;

  return {
    structured: {
      spot,
      cone_lower: coneLower,
      cone_upper: coneUpper,
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
    },
    chartDate,
  };
}

/**
 * Parse the LAST fenced ```json...``` block as a heat-map extraction
 * result. Returns null on parse failure. Accepts but trims malformed
 * cell entries — partial OCR is more useful than nothing.
 */
function parseHeatMapExtraction(text: string): HeatMapExtraction | null {
  const block = parseTrailingJsonBlock(text);
  if (block == null) {
    logger.warn('extractHeatMapStrikes: no JSON code block in response');
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(block.body) as Record<string, unknown>;
  } catch (err) {
    logger.error(
      { err, blockBody: block.body.slice(0, 200) },
      'extractHeatMapStrikes: failed to parse JSON block',
    );
    return null;
  }

  const gex = coerceHeatMapStrikes(parsed.gex);
  const charm = coerceHeatMapStrikes(parsed.charm);

  // If both metrics are empty the model couldn't read either heat map;
  // null tells the caller to skip the injection block entirely.
  if (gex.length === 0 && charm.length === 0) return null;

  return { gex, charm };
}

/**
 * Coerce the model's per-cell array into well-typed `HeatMapStrike[]`.
 * Drops any entries that don't match the expected shape so a single
 * malformed cell doesn't sink the whole extraction.
 */
function coerceHeatMapStrikes(raw: unknown): HeatMapStrike[] {
  if (!Array.isArray(raw)) return [];
  const out: HeatMapStrike[] = [];
  for (const cell of raw) {
    if (typeof cell !== 'object' || cell == null) continue;
    const c = cell as Record<string, unknown>;
    const strike =
      typeof c.strike === 'number' && Number.isFinite(c.strike)
        ? c.strike
        : null;
    const value =
      typeof c.value === 'number' && Number.isFinite(c.value) ? c.value : null;
    const color = c.color === 'green' || c.color === 'red' ? c.color : null;
    if (strike == null || value == null || color == null) continue;
    // Color must match sign — drop the cell if the model contradicts
    // itself rather than guess which side is right.
    if (color === 'green' && value < 0) continue;
    if (color === 'red' && value > 0) continue;
    out.push({ strike, value, color });
  }
  return out;
}
