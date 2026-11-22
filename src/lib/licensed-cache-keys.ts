/**
 * The localStorage keys that hold Unusual Whales or GEXBot data, named once.
 * A leaf module on purpose: it imports nothing, so the purge in
 * `licensed-client-caches.ts` (called from App, so in the entry chunk) can
 * name the keys without pulling in the hooks that write them, which sit in
 * lazy chunks. Each writer imports its key from here.
 */

/** `useOpeningFlowSignal`: today's slot, and `<key>:<YYYY-MM-DD>` per date. */
export const OPENING_FLOW_LAST_GOOD_KEY = 'openingFlowSignal.lastGood';

/** `useRegime0dte`, through `usePolledWindowSignal`: the single last-good slot. */
export const REGIME_0DTE_LAST_GOOD_KEY = 'regime0dte:lastgood';

/**
 * `useStickyUnion`: prefix of every day-scoped feed slot. LotteryFinder and
 * SilentBoom build the full key, `feed-union:<feed>:<date>:<filterSig>`.
 */
export const FEED_UNION_PREFIX = 'feed-union:';
