/**
 * Polling hook for the Gamma Squeeze board.
 *
 * Fetches `/api/gamma-squeezes` every 30s while the market is open and
 * aggregates rows by compound key (`ticker:strike:side:expiry`). Sibling
 * of `useIVAnomalies` but simpler: no per-strike chart, no banner store,
 * no exit-signal phase machine. Just "what's currently firing."
 *
 * Active-span demotion: a compound key whose latest firing is older
 * than `SQUEEZE_SILENCE_MS` is reclassified to `squeezePhase:
 * 'exhausted'` rather than removed. The user reads the panel as a
 * throughout-the-day history — still-firing setups float to the top,
 * exhausted ones sink to the bottom with a muted grey pill (see
 * SqueezeRow), and the 24h backend window naturally bounds visibility.
 *
 * Replay scrubber: composes `useTimeGridScrubber` (same shared hook as
 * IV Anomalies). When scrubbed, polling halts and the fetch carries
 * `?at=<utc-iso>` so the backend rebuilds the active board from the
 * 24h window ending at that moment. Returning to live (`scrubLive()`)
 * restarts the 30s poll loop.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActiveSqueeze,
  GammaSqueezeRow,
  GammaSqueezesResponse,
} from '../components/GammaSqueezes/types';
import { squeezeCompoundKey } from '../components/GammaSqueezes/types';
import { useTimeGridScrubber } from './useTimeGridScrubber';
import { ctWallClockToUtcIso, getETToday } from '../utils/timezone';

const POLL_MS = 30_000;
// Threshold past which a still-listed squeeze is demoted to "exhausted"
// in the UI. 8 min mirrors the gamma-window cadence — within one window
// without a fresh firing, the setup is no longer "currently squeezing"
// even if its row is still in the 24h backend response.
const SQUEEZE_SILENCE_MS = 8 * 60 * 1000;

/** Convert HH:MM (24h) into minutes-past-midnight. */
function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((v) => Number.parseInt(v, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

interface UseGammaSqueezesArgs {
  readonly enabled?: boolean;
  readonly marketOpen: boolean;
}

interface UseGammaSqueezesResult {
  readonly active: readonly ActiveSqueeze[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
  // Replay scrubber — mirrors useIVAnomalies surface.
  readonly selectedDate: string;
  readonly setSelectedDate: (d: string) => void;
  readonly scrubTime: string | null;
  readonly isLive: boolean;
  readonly isScrubbed: boolean;
  readonly canScrubPrev: boolean;
  readonly canScrubNext: boolean;
  readonly scrubPrev: () => void;
  readonly scrubNext: () => void;
  readonly scrubTo: (time: string) => void;
  readonly scrubLive: () => void;
  readonly timeGrid: readonly string[];
}

export function useGammaSqueezes({
  enabled = true,
  marketOpen,
}: UseGammaSqueezesArgs): UseGammaSqueezesResult {
  const [activeMap, setActiveMap] = useState<Map<string, ActiveSqueeze>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchSeq = useRef(0);

  // Replay scrubber: same shape as useIVAnomalies.
  const scrubber = useTimeGridScrubber();
  const { scrubTime, isScrubbed, scrubLive } = scrubber;
  const [selectedDate, setSelectedDate] = useState<string>(getETToday);
  const isToday = selectedDate === getETToday();
  const isLive = isToday && scrubTime === null;

  // Switching dates always reverts to live within that day.
  useEffect(() => {
    scrubLive();
  }, [selectedDate, scrubLive]);

  // Compose the `?at=` value sent to the backend. Live mode → omit param.
  // Scrubbed → ctWallClockToUtcIso(selectedDate, scrubTime). Past-day no-scrub
  // defaults to 15:00 CT (session close) so the user sees that day's
  // end-of-day board on first selection.
  const replayIso: string | null = isLive
    ? null
    : isScrubbed
      ? ctWallClockToUtcIso(selectedDate, hhmmToMin(scrubTime!))
      : ctWallClockToUtcIso(selectedDate, 15 * 60);

  const refresh = useCallback(async (atIso?: string | null) => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    try {
      const url = atIso
        ? `/api/gamma-squeezes?at=${encodeURIComponent(atIso)}`
        : '/api/gamma-squeezes';
      const r = await fetch(url, {
        credentials: 'include',
      });
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      }
      const data = (await r.json()) as GammaSqueezesResponse;
      // Stale-fetch guard: if a newer refresh fired while this awaited,
      // discard.
      if (seq !== fetchSeq.current) return;

      const next = new Map<string, ActiveSqueeze>();
      const now = Date.now();
      // Walk through every ticker's history and aggregate.
      for (const [tickerKey, rows] of Object.entries(data.history) as Array<
        [string, GammaSqueezeRow[]]
      >) {
        if (rows.length === 0) continue;
        // Group by compound key. Rows are DESC by ts.
        const byKey = new Map<string, GammaSqueezeRow[]>();
        for (const row of rows) {
          const key = squeezeCompoundKey(row);
          const bucket = byKey.get(key);
          if (bucket) bucket.push(row);
          else byKey.set(key, [row]);
        }
        for (const [key, group] of byKey) {
          const latest = group[0]!;
          const lastMs = Date.parse(latest.ts);
          if (!Number.isFinite(lastMs)) continue;
          // Silence DEMOTION (not eviction). When the most recent firing is
          // older than the silence window, surface the compound key as
          // 'exhausted' so the throughout-day history stays visible — sorted
          // beneath active/forming and rendered with the muted grey pill in
          // SqueezeRow. Cloning the object instead of mutating since `latest`
          // is a row from the API response that other code paths may also
          // hold a reference to.
          const isStale = now - lastMs > SQUEEZE_SILENCE_MS;
          const displayLatest = isStale
            ? { ...latest, squeezePhase: 'exhausted' as const }
            : latest;
          // First-seen = earliest ts in the active span. Walk back from
          // newest until we hit a gap > SQUEEZE_SILENCE_MS.
          let firstSeen = latest;
          for (let i = 1; i < group.length; i += 1) {
            const cur = group[i]!;
            const curMs = Date.parse(cur.ts);
            const prevMs = Date.parse(group[i - 1]!.ts);
            if (!Number.isFinite(curMs)) break;
            if (prevMs - curMs > SQUEEZE_SILENCE_MS) break;
            firstSeen = cur;
          }
          next.set(key, {
            compoundKey: key,
            ticker: tickerKey,
            strike: latest.strike,
            side: latest.side,
            expiry: latest.expiry,
            latest: displayLatest,
            firstSeenTs: firstSeen.ts,
            lastFiredTs: latest.ts,
            firingCount: group.length,
          });
        }
      }
      setActiveMap(next);
      setError(null);
    } catch (e) {
      if (seq !== fetchSeq.current) return;
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, []);

  // Initial fetch + re-fetch whenever replayIso changes (date pick, prev/next).
  // Replays clear the prior active map so old keys from another timestamp
  // don't linger across a scrub.
  useEffect(() => {
    if (!enabled) return;
    if (replayIso !== null) {
      setActiveMap(new Map());
    }
    void refresh(replayIso);
  }, [enabled, replayIso, refresh]);

  // Live polling — only when actually live (today + no scrub) and market is
  // open. Scrubbed snapshots are static so polling them would just thrash.
  useEffect(() => {
    if (!enabled || !marketOpen || !isLive) return;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [enabled, marketOpen, isLive, refresh]);

  const active = useMemo(() => {
    const list = [...activeMap.values()];
    // Sort: active first, then forming, then exhausted; within each,
    // most recent first.
    const phaseRank: Record<string, number> = {
      active: 0,
      forming: 1,
      exhausted: 2,
    };
    list.sort((a, b) => {
      const pa = phaseRank[a.latest.squeezePhase] ?? 3;
      const pb = phaseRank[b.latest.squeezePhase] ?? 3;
      if (pa !== pb) return pa - pb;
      return Date.parse(b.lastFiredTs) - Date.parse(a.lastFiredTs);
    });
    return list;
  }, [activeMap]);

  return {
    active,
    loading,
    error,
    refresh: () => void refresh(replayIso),
    selectedDate,
    setSelectedDate,
    scrubTime,
    isLive,
    isScrubbed,
    canScrubPrev: scrubber.canScrubPrev,
    canScrubNext: scrubber.canScrubNext,
    scrubPrev: scrubber.scrubPrev,
    scrubNext: scrubber.scrubNext,
    scrubTo: scrubber.scrubTo,
    scrubLive,
    timeGrid: scrubber.timeGrid,
  };
}
