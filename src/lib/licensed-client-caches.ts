/**
 * Removes the Unusual Whales and GEXBot data a browser has cached in
 * localStorage. A visitor with no owner or guest session must keep none of it
 * (the data-licensing rule in CLAUDE.md), and nothing else removes it when a
 * session ends: the cookie can lapse between visits, the auth interceptor can
 * drop the session mid-visit, and a guest can sign out.
 *
 * Three families of key hold licensed data. Every other key the app writes is
 * a preference or flag (filter settings, panel layout, the VIX table, theme,
 * mute and dismissal flags), and stays:
 *
 *   - `openingFlowSignal.lastGood` and `openingFlowSignal.lastGood:<date>`
 *     (useOpeningFlowSignal): the last opening-flow payload, one slot per date;
 *   - `regime0dte:lastgood` (useRegime0dte, through usePolledWindowSignal):
 *     the last 0DTE gamma-regime payload;
 *   - every `feed-union:` key (useStickyUnion, slots named by LotteryFinder and
 *     SilentBoom): the Lottery Finder and Silent Boom fires seen that day.
 *
 * Each name comes from the hook that writes it. No React in here: it only
 * touches storage, so App calls it from one effect on the access mode.
 *
 * Storage can throw (access denied, a private window), and one key that will
 * not go must not stop the others, so every storage call sits in its own
 * try/catch and the function never throws.
 *
 * Spec: docs/superpowers/specs/2026-11-19-public-visitor-fetch-gating.md
 * (Phase 5).
 */

import { STORAGE_KEY_LIVE as OPENING_FLOW_KEY } from '../hooks/useOpeningFlowSignal.js';
import { STORAGE_KEY as REGIME_0DTE_KEY } from '../hooks/useRegime0dte.js';
import { FEED_UNION_PREFIX } from '../hooks/useStickyUnion.js';

/** Prefix of the per-date opening-flow slots: `<live key>:<YYYY-MM-DD>`. */
const OPENING_FLOW_DATED_PREFIX = `${OPENING_FLOW_KEY}:`;

/**
 * The slots whose full name is known. They are removed by name, so they go
 * even when the scan for the prefixed ones below throws.
 */
const FIXED_KEYS: readonly string[] = [OPENING_FLOW_KEY, REGIME_0DTE_KEY];

function isPrefixedLicensedKey(key: string): boolean {
  return (
    key.startsWith(OPENING_FLOW_DATED_PREFIX) ||
    key.startsWith(FEED_UNION_PREFIX)
  );
}

/**
 * The browser's localStorage. Null when reading the global throws: access
 * denied (a SecurityError), or no DOM at all (a ReferenceError).
 */
function getStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * Every licensed key now in storage. Collected before any is removed, because
 * removing a key shifts the index of those after it.
 */
function licensedKeys(storage: Storage): string[] {
  const keys = new Set<string>(FIXED_KEYS);
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key != null && isPrefixedLicensedKey(key)) keys.add(key);
    }
  } catch {
    // The scan failed part-way: the keys found so far and the fixed ones go.
  }
  return [...keys];
}

export function clearLicensedClientCaches(): void {
  const storage = getStorage();
  if (storage == null) return;
  for (const key of licensedKeys(storage)) {
    try {
      storage.removeItem(key);
    } catch {
      // This key stays; the rest still go.
    }
  }
}
