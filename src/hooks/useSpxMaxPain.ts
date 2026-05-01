/**
 * useSpxMaxPain — owner-gated SPX max-pain fetcher for the FuturesGamma
 * playbook.
 *
 * Phase 1D.4 unified path: a single `/api/max-pain-current?date=<selected>`
 * fetch covers both live and historical. The endpoint routes today ET to
 * the UW live path and past dates to a DB-backed compute from the
 * `oi_per_strike` table (populated daily by `fetch-oi-per-strike.ts`),
 * so this hook does not have to distinguish live vs. scrub.
 *
 * The hook fires once per `(selectedDate, isOwner)` combination — guarded
 * by a ref-based key so a setter-triggered re-render does not cause an
 * infinite re-fetch loop. On a date change the in-memory value is cleared
 * BEFORE the fetch starts so the UI never shows the previous date's value
 * with the new date's basis (a one-render correctness gap that produced
 * plausible-looking but wrong `esMaxPain` values).
 *
 * On non-owner sessions the value collapses to `null` and no fetch fires —
 * max-pain is owner-gated for now (mirrors the existing
 * `/api/max-pain-current` ACL).
 */

import { useEffect, useRef, useState } from 'react';

export interface UseSpxMaxPainReturn {
  /** Latest fetched SPX max-pain strike, or null when unknown / unfetched. */
  maxPain: number | null;
  /** True while a fetch for the current key is in flight. */
  loading: boolean;
}

/**
 * Owner-gated SPX max-pain fetcher.
 *
 * @param selectedDate ET trading date (YYYY-MM-DD). Date changes trigger a
 *                     fresh fetch and clear the prior value before the
 *                     network call resolves.
 * @param isOwner      Owner-gate. Non-owners get `{ maxPain: null,
 *                     loading: false }` and no fetch.
 */
export function useSpxMaxPain(
  selectedDate: string,
  isOwner: boolean,
): UseSpxMaxPainReturn {
  const [maxPain, setMaxPain] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  // One fetch per (selectedDate, isOwner) combination. The key guards the
  // effect from infinite re-fetching when the setter below triggers a
  // re-render but the identity of the fetch scope hasn't actually changed.
  const fetchKey = useRef<string | null>(null);

  useEffect(() => {
    if (!isOwner) {
      setMaxPain(null);
      setLoading(false);
      fetchKey.current = null;
      return;
    }

    const key = selectedDate;
    if (fetchKey.current === key) return;
    fetchKey.current = key;

    // Clear stale value BEFORE the fetch so a date change never shows
    // the previous date's max-pain on the new date's ES levels for the
    // ~200ms the fetch is in flight. Without this, `buildEsLevels`
    // translates a stale SPX max-pain through the CURRENT basis and
    // emits a plausible-looking but wrong esMaxPain for one render.
    setMaxPain(null);

    const controller = new AbortController();
    setLoading(true);

    (async () => {
      try {
        const url = `/api/max-pain-current?date=${encodeURIComponent(
          selectedDate,
        )}`;
        const res = await fetch(url, {
          credentials: 'same-origin',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(5_000),
          ]),
        });
        if (!res.ok) {
          // Clear the key so the next effect run can retry rather than
          // being blocked by the same-key guard above.
          fetchKey.current = null;
          setMaxPain(null);
          return;
        }
        const data = (await res.json()) as { maxPain: number | null };
        setMaxPain(data.maxPain ?? null);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Max-pain is advisory — don't surface as a top-level hook error,
        // but DO log + capture so a regression doesn't vanish silently.
        // And clear the key so the user can recover from a transient
        // failure by triggering another effect run (date change, remount).
        if (typeof console !== 'undefined') {
          console.warn('max-pain fetch failed — rendering advisory null', err);
        }
        fetchKey.current = null;
        setMaxPain(null);
      } finally {
        setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [selectedDate, isOwner]);

  return { maxPain, loading };
}
