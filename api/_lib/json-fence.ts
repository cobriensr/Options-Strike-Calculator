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
 *
 * Anchoring rules (Tier 2 review fix):
 *   - The opening fence must start a new line (or sit at start-of-text)
 *     so prose containing a literal ```json token mid-sentence does
 *     not get parsed as a block.
 *   - The character immediately after the opening fence must be a
 *     newline / carriage-return / horizontal whitespace, so language
 *     extensions like ```jsonl or ```jsonABC are rejected — those are
 *     not the JSON block we asked the model for.
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

  // Open fence must be at line-start (or start-of-text). A literal
  // ```json appearing in the middle of a prose sentence — e.g. if the
  // model echoes user content — is not a code block we asked for and
  // would otherwise be picked up by the backward walk.
  if (lastOpen > 0 && text[lastOpen - 1] !== '\n') {
    return null;
  }

  // Reject language-tag overflow such as ```jsonl, ```jsonABC. The
  // character after OPEN_FENCE must be whitespace (newline, CR, space,
  // tab) before we trust this is the JSON block. Anything else means
  // the model emitted a different language identifier whose prefix
  // happens to be `json`.
  const charAfterFence = text[lastOpen + OPEN_FENCE.length];
  if (
    charAfterFence !== '\n' &&
    charAfterFence !== '\r' &&
    charAfterFence !== ' ' &&
    charAfterFence !== '\t'
  ) {
    return null;
  }

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
