/**
 * Vision-only structural extraction call for /api/periscope-chat.
 *
 * Phase 9: a separate Opus 4.7 call runs BEFORE the main analysis to
 * pull a structural fingerprint (spot + cone bounds) directly from
 * the screenshots. That fingerprint feeds the retrieval embedding, so
 * we match past reads by chart topology rather than by the user's
 * prose context note.
 *
 * Why two Opus calls (not Haiku for the extraction pass):
 *   The user reported quality issues with Sonnet on Periscope reads,
 *   so Haiku was rejected as too risky. Cost trade-off accepted:
 *   ~2× Opus per submission, in exchange for retrieval that actually
 *   reflects today's chart shape.
 *
 * Failure mode: returns null. The endpoint then falls back to the
 * legacy prose-context-based retrieval (or skips retrieval entirely
 * when no context). Extraction is best-effort, not load-bearing on
 * the user-visible analysis path.
 *
 * Differences vs the main analysis call:
 *   - Only the 'chart' image is sent (heat maps don't carry spot/cone).
 *   - No thinking config, no high-effort output config — extraction is
 *     mechanical reading, not reasoning. Smaller token footprint, faster.
 *   - Non-streaming: completes in seconds, doesn't need keepalives.
 *   - Returns the same `PeriscopeStructuredFields` shape as the main
 *     parser, with triggers and regime_tag null (those need analysis,
 *     not just chart reading).
 */

import Anthropic from '@anthropic-ai/sdk';
import logger from './logger.js';
import { Sentry } from './sentry.js';
import type { PeriscopeStructuredFields } from './periscope-db.js';

const MODEL = 'claude-opus-4-7';

// 2048 tokens is plenty for the small JSON response and the model's
// brief internal reasoning. Higher caps just risk runaway prose.
const MAX_TOKENS = 2048;

// Stable, cacheable system prompt for extraction. Cache hit on repeat
// submissions saves the system-prompt input cost on the extraction
// path — small absolute saving, but free.
const EXTRACTION_SYSTEM_PROMPT = `You are a vision-extraction assistant for a 0DTE SPX trading tool. Your only job is to read four values from a Periscope chart screenshot:

- chart_date: the trading date the chart is FOR, in ISO YYYY-MM-DD form. Periscope chart headers display this as a labelled date (e.g. "Thu, Apr 30" + a year, or a short "4/30/2026" label, often near the chart title or top toolbar). Read whatever the chart actually shows, then normalize to YYYY-MM-DD. If the year is implied but ambiguous, use the most recent year that makes the date a real trading day.
- spot: the current price (typically a white or highlighted horizontal line near the middle of the chart)
- cone_lower: the lower yellow dashed line bounding price (the 0DTE straddle Cone lower bound)
- cone_upper: the upper yellow dashed line bounding price (the 0DTE straddle Cone upper bound)

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

interface ExtractionInput {
  images: Array<{
    kind: 'chart' | 'gex' | 'charm';
    data: string;
    mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  }>;
}

const anthropic = new Anthropic({
  // 120s ceiling — extraction usually completes in 5-15s. The cap
  // protects the parent function's 780s budget when Anthropic is slow.
  timeout: 120_000,
  maxRetries: 1,
});

/**
 * Result of a successful extraction. Carries the structured field shape
 * the main analysis pipeline expects, plus the chart's actual trading
 * date pulled from its date label — used to stamp `trading_date` so
 * back-reads aren't mis-tagged with the capture time's date.
 */
export interface PeriscopeExtractionResult {
  structured: PeriscopeStructuredFields;
  /** ISO YYYY-MM-DD if read off the chart; null if not visible. */
  chartDate: string | null;
}

/**
 * Run the vision-only extraction. Returns a result with structured
 * fields + chart_date on success. Returns null on any failure (timeout,
 * parse error, refusal, network).
 */
export async function extractChartStructure(
  input: ExtractionInput,
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

/** Loose ISO-date matcher used to validate the model's date string. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse the LAST fenced ```json...``` block from the response into
 * the extraction result. Returns null on any parse failure (no block,
 * malformed JSON, missing/non-numeric fields).
 *
 * Uses lastIndexOf walks rather than a regex so the parse is O(n) and
 * immune to ReDoS backtracking — same approach as periscope-chat.ts.
 */
function parseExtraction(text: string): PeriscopeExtractionResult | null {
  const OPEN_FENCE = '```json';
  const CLOSE_FENCE = '```';

  const lastClose = text.lastIndexOf(CLOSE_FENCE);
  if (lastClose < 0) {
    logger.warn('extractChartStructure: no JSON code block in response');
    return null;
  }
  const lastOpen = text.lastIndexOf(OPEN_FENCE, lastClose - 1);
  if (lastOpen < 0 || lastOpen >= lastClose) {
    logger.warn('extractChartStructure: no JSON code block in response');
    return null;
  }
  const bodyStartNewline = text.indexOf('\n', lastOpen + OPEN_FENCE.length);
  if (bodyStartNewline < 0 || bodyStartNewline >= lastClose) {
    logger.warn('extractChartStructure: malformed JSON code block');
    return null;
  }
  const blockBody = text.slice(bodyStartNewline + 1, lastClose).trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(blockBody) as Record<string, unknown>;
  } catch (err) {
    logger.error(
      { err, blockBody: blockBody.slice(0, 200) },
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
    },
    chartDate,
  };
}
