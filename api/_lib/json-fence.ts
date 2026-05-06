/**
 * Shared trailing-JSON-fence parser.
 *
 * Used by `periscope-prompts.ts` (structured-fields parser) and
 * `periscope-extract.ts` (vision-extraction parser). Both consume Anthropic
 * responses where the model is instructed to emit a single fenced
 * ```json...``` block at the very end of its prose. Earlier blocks may
 * appear in the prose as illustrative samples; we always pick the LAST
 * one.
 *
 * Implementation notes:
 *   - O(n) via `lastIndexOf`. No regex — keeps us ReDoS-safe on
 *     adversarial input.
 *   - We require a newline AFTER the opening fence so we know exactly
 *     where the JSON body begins. This matches both call sites' previous
 *     behavior; lone single-line fences (e.g. ```json{...}```) are
 *     rejected on purpose.
 *   - On any structural defect (missing fences, open after close, no
 *     newline after open) we return null and let the caller decide how
 *     to surface the failure.
 */

export interface TrailingJsonBlock {
  /** Raw JSON content between the fences, with surrounding whitespace trimmed. */
  body: string;
  /** Text before the opening fence (often the model's prose). */
  before: string;
  /** Text after the closing fence (rare — usually empty). */
  after: string;
}

const OPEN_FENCE = '```json';
const CLOSE_FENCE = '```';

/**
 * Locate the last ```json...``` block in `text` and split the input
 * around it. Returns null when no well-formed block is present.
 */
export function parseTrailingJsonBlock(text: string): TrailingJsonBlock | null {
  // Walk backward to find the LAST closing fence, then look behind it
  // for its matching opening fence. The opening fence is itself a
  // superstring of the closing fence (```json starts with ```), so we
  // search strictly before `lastClose - 1` to avoid matching the open
  // as its own close.
  const lastClose = text.lastIndexOf(CLOSE_FENCE);
  if (lastClose < 0) return null;

  const lastOpen = text.lastIndexOf(OPEN_FENCE, lastClose - 1);
  if (lastOpen < 0 || lastOpen >= lastClose) return null;

  // Body starts after the first newline following ```json. Without that
  // newline we cannot reliably determine the body slice and reject the
  // input rather than guess.
  const bodyStartNewline = text.indexOf('\n', lastOpen + OPEN_FENCE.length);
  if (bodyStartNewline < 0 || bodyStartNewline >= lastClose) return null;

  const body = text.slice(bodyStartNewline + 1, lastClose).trim();
  const before = text.slice(0, lastOpen);
  const after = text.slice(lastClose + CLOSE_FENCE.length);

  return { body, before, after };
}
