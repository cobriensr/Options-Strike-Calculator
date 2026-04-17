/**
 * ChainList — renders the list of pyramid chains with lazy leg fetch.
 *
 * Maintains:
 *   - `expandedIds`: a `Set<string>` of currently-expanded chains. Kept local
 *     because expansion is UI-only state; nothing else in the app cares.
 *   - `legsByChainId`: a map from chain id to its leg payload in one of three
 *     states: an array of legs, the literal string `'loading'`, or
 *     `{ error: string }`. Cache is populated on first expand so toggling
 *     open/closed doesn't thrash the network.
 *
 * On expand the component calls `getChainWithLegs(id)` exactly once per
 * mount-session, then uses the cached result on subsequent toggles. Re-fetch
 * is only triggered when the `chain` prop object reference changes (e.g. an
 * edit refreshed the list) OR when the legs cache entry is cleared elsewhere
 * (currently only `clearLegsCache` — used by parent after a leg mutation).
 *
 * Ref: Task 2C prompt's MVP note — "cache once and re-fetch if the chain
 * prop object reference changes". We key the cache by chain id (stable) but
 * invalidate lazily on prop change.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type {
  PyramidChain,
  PyramidChainWithLegs,
  PyramidLeg,
} from '../../types/pyramid';
import ChainCard from './ChainCard';
import LegTable from './LegTable';
import { getErrorMessage } from '../../utils/error';

// ============================================================
// Props + imperative handle
// ============================================================

export interface ChainListProps {
  readonly chains: ReadonlyArray<PyramidChain>;
  readonly getChainWithLegs: (id: string) => Promise<PyramidChainWithLegs>;
  readonly onEditChain: (chain: PyramidChain) => void;
  readonly onDeleteChain: (chainId: string) => Promise<void>;
  readonly onEditLeg: (leg: PyramidLeg) => void;
  readonly onDeleteLeg: (legId: string) => Promise<void>;
  readonly onAddLeg: (chainId: string) => void;
}

/**
 * Imperative handle exposed to the parent so a successful leg mutation can
 * invalidate the cache for a single chain without forcing a full list re-render.
 */
export interface ChainListHandle {
  clearLegsCache: (chainId: string) => void;
}

type LegsCacheEntry =
  | { kind: 'loading' }
  | { kind: 'ok'; legs: PyramidLeg[] }
  | { kind: 'error'; message: string };

// ============================================================
// Component
// ============================================================

const ChainList = forwardRef<ChainListHandle, ChainListProps>(
  function ChainList(
    {
      chains,
      getChainWithLegs,
      onEditChain,
      onDeleteChain,
      onEditLeg,
      onDeleteLeg,
      onAddLeg,
    },
    ref,
  ) {
    const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
      () => new Set(),
    );
    const [legsByChainId, setLegsByChainId] = useState<
      Record<string, LegsCacheEntry>
    >({});

    // Track the `chains` prop object references we've seen so we can detect
    // when the parent has refreshed a chain row. If the reference for a chain
    // id changes, we drop its legs cache so the next expand refetches.
    const seenChainRefs = useRef<Map<string, PyramidChain>>(new Map());
    useEffect(() => {
      const nextRefs = new Map<string, PyramidChain>();
      const toInvalidate: string[] = [];
      for (const c of chains) {
        const prior = seenChainRefs.current.get(c.id);
        if (prior != null && prior !== c) {
          toInvalidate.push(c.id);
        }
        nextRefs.set(c.id, c);
      }
      seenChainRefs.current = nextRefs;
      if (toInvalidate.length > 0) {
        setLegsByChainId((prev) => {
          const next = { ...prev };
          for (const id of toInvalidate) delete next[id];
          return next;
        });
      }
    }, [chains]);

    // Expose a hook-friendly cache invalidator to the parent. Used after
    // leg mutations (create / edit / delete) to force the next expand to fetch
    // fresh data instead of showing a stale cached list.
    useImperativeHandle(
      ref,
      () => ({
        clearLegsCache(chainId: string) {
          setLegsByChainId((prev) => {
            if (!(chainId in prev)) return prev;
            const next = { ...prev };
            delete next[chainId];
            return next;
          });
        },
      }),
      [],
    );

    const fetchLegs = useCallback(
      async (chainId: string) => {
        setLegsByChainId((prev) => ({
          ...prev,
          [chainId]: { kind: 'loading' },
        }));
        try {
          const result = await getChainWithLegs(chainId);
          setLegsByChainId((prev) => ({
            ...prev,
            [chainId]: { kind: 'ok', legs: result.legs },
          }));
        } catch (err) {
          setLegsByChainId((prev) => ({
            ...prev,
            [chainId]: { kind: 'error', message: getErrorMessage(err) },
          }));
        }
      },
      [getChainWithLegs],
    );

    const toggleExpanded = useCallback((chainId: string) => {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        if (next.has(chainId)) {
          next.delete(chainId);
        } else {
          next.add(chainId);
        }
        return next;
      });
    }, []);

    // Kick off fetches for any expanded ids that don't yet have a cache entry.
    // Running the fetch in an effect (rather than inside `toggleExpanded`)
    // keeps the state transitions pure and handles cache invalidation via
    // `clearLegsCache`: after a mutation the parent drops the entry, which
    // re-triggers this effect on the next render if the chain is still open.
    useEffect(() => {
      for (const id of expandedIds) {
        if (legsByChainId[id] == null) {
          void fetchLegs(id);
        }
      }
    }, [expandedIds, legsByChainId, fetchLegs]);

    if (chains.length === 0) {
      return (
        <p
          className="text-muted py-4 text-center font-sans text-sm italic"
          data-testid="pyramid-chain-list-empty"
        >
          No chains logged yet {'\u2014'} click {"'+ New Chain'"} above to
          start.
        </p>
      );
    }

    return (
      <div className="flex flex-col gap-2" data-testid="pyramid-chain-list">
        {chains.map((chain) => {
          const expanded = expandedIds.has(chain.id);
          const contentId = `pyramid-chain-body-${chain.id}`;
          const cacheEntry = legsByChainId[chain.id];
          return (
            <div key={chain.id} className="flex flex-col gap-2">
              <ChainCard
                chain={chain}
                expanded={expanded}
                contentId={contentId}
                onToggle={() => toggleExpanded(chain.id)}
                onEdit={() => onEditChain(chain)}
                onDelete={() => {
                  void onDeleteChain(chain.id);
                }}
                onAddLeg={() => onAddLeg(chain.id)}
              />
              {expanded && (
                <div
                  id={contentId}
                  className="border-edge bg-surface ml-6 rounded-md border"
                >
                  {cacheEntry == null || cacheEntry.kind === 'loading' ? (
                    <p
                      role="status"
                      aria-live="polite"
                      className="text-muted py-3 text-center font-sans text-xs"
                    >
                      Loading legs{'\u2026'}
                    </p>
                  ) : cacheEntry.kind === 'error' ? (
                    <div
                      role="alert"
                      className="text-danger flex items-center justify-between gap-2 px-3 py-2 font-sans text-xs"
                    >
                      <span>Failed to load legs: {cacheEntry.message}</span>
                      <button
                        type="button"
                        onClick={() => {
                          void fetchLegs(chain.id);
                        }}
                        className="border-edge-strong bg-chip-bg text-primary hover:bg-surface-alt cursor-pointer rounded-md border-[1.5px] px-2 py-1 font-sans text-[10px] font-semibold tracking-wider uppercase"
                      >
                        Retry
                      </button>
                    </div>
                  ) : (
                    <LegTable
                      legs={cacheEntry.legs}
                      onEditLeg={onEditLeg}
                      onDeleteLeg={(legId) => {
                        void onDeleteLeg(legId);
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  },
);

export default ChainList;
