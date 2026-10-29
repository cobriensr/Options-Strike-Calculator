/**
 * Words that assert market-maker / dealer behaviour: the UW-era Periscope
 * readings (MMs pull price to the wall, dealers amplify moves, hard floor,
 * breakout risk, drift targets, …).
 *
 * Owner decision D1 revised (2026-10-29): GEXBot is classified taker flow,
 * not a market-maker position, so text built from it must not use them.
 * Tests assert `dealerClaims(text)` is empty; the result names the
 * patterns that matched, so a failure says which word slipped back in.
 */
const DEALER_CLAIM_PATTERNS: readonly RegExp[] = [
  /\bMMs?\b/,
  /market.?maker/i,
  /dealer/i,
  /hedg/i,
  /\bpull/i,
  /amplif|accelerat|\bfuel/i,
  /dampen|absorb|counter/i,
  /\bpin\b|pinned/i,
  /\bwall/i,
  /support|resistance/i,
  /breakout|breakdown/i,
  /launch/i,
  /gravity/i,
  /target/i,
  /ceiling|floor/i,
];

/** The dealer-claim patterns that `text` matches (empty = clean). */
export function dealerClaims(text: string): string[] {
  return DEALER_CLAIM_PATTERNS.filter((re) => re.test(text)).map(String);
}
