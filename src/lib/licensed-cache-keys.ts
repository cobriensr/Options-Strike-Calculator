/**
 * The localStorage keys that hold Unusual Whales or GEXBot data, named once.
 * A leaf module on purpose: it imports nothing, so the purge in
 * `licensed-client-caches.ts` (called from App, so in the entry chunk) can
 * name the keys without pulling in the hooks that write them, which sit in
 * lazy chunks. Each writing hook imports its key from here, and the feed
 * components build their slot keys from the feed prefix, so no writer spells
 * a key the purge does not know.
 */

/** `useOpeningFlowSignal`: today's slot, and `<key>:<YYYY-MM-DD>` per date. */
export const OPENING_FLOW_LAST_GOOD_KEY = 'openingFlowSignal.lastGood';

/** `useRegime0dte`, through `usePolledWindowSignal`: the single last-good slot. */
export const REGIME_0DTE_LAST_GOOD_KEY = 'regime0dte:lastgood';

/**
 * `useStickyUnion`: prefix of every day-scoped feed slot, and the token its
 * stale-key sweep parses. LotteryFinder and SilentBoom build the full key from
 * it: `feed-union:<feed>:<date>:<filterSig>`.
 */
export const FEED_UNION_PREFIX = 'feed-union:';
