/**
 * useVixTrajectory — intraday VIX ratio trajectory for the Curve
 * Shape panel. Polls /api/vix-snapshots-recent during market hours
 * and exposes rolling deltas for VIX1D/VIX, VIX9D/VIX, and SPX so
 * the cards can answer "is this ratio climbing while SPX rallies?"
 * instead of only "where is the ratio right now?".
 *
 * Owner-gated: silently skips polling for public visitors. Delta
 * calculation is browser-side so future tuning (5m vs 15m vs 30m
 * windows) does not require backend changes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants';
import { checkIsOwner } from '../utils/auth';

export interface VixSnapshot {
  entryTime: string;
  vix: number;
  vix1d: number | null;
  vix9d: number | null;
  spx: number | null;
}

export interface Trajectory {
  delta: number;
  spanMin: number;
}

export interface VixTrajectoryState {
  hasData: boolean;
  ratio1d: Trajectory | null;
  ratio9d: Trajectory | null;
  spx: Trajectory | null;
}

const EMPTY: VixTrajectoryState = {
  hasData: false,
  ratio1d: null,
  ratio9d: null,
  spx: null,
};

const WINDOW_MIN = 15;
const MIN_SPAN_MIN = 8;
const MAX_SPAN_MIN = 25;

function parseEntryTimeMinutes(t: string): number {
  const match = /^(\d+):(\d+)\s*(AM|PM)$/i.exec(t);
  if (!match) return Number.NaN;
  let h = Number.parseInt(match[1]!, 10);
  const minute = Number.parseInt(match[2]!, 10);
  if (h < 1 || h > 12 || minute < 0 || minute > 59) return Number.NaN;
  const isPm = match[3]!.toUpperCase() === 'PM';
  if (isPm && h !== 12) h += 12;
  else if (!isPm && h === 12) h = 0;
  return h * 60 + minute;
}

function computeTrajectory(
  series: readonly { t: number; value: number }[],
): Trajectory | null {
  if (series.length < 2) return null;
  const latest = series.at(-1);
  if (!latest) return null;
  const target = latest.t - WINDOW_MIN;

  let baseline: { t: number; value: number } | null = null;
  for (let i = series.length - 2; i >= 0; i--) {
    const s = series[i]!;
    if (s.t <= target) {
      baseline = s;
      break;
    }
  }
  if (!baseline) return null;

  const span = latest.t - baseline.t;
  if (span < MIN_SPAN_MIN || span > MAX_SPAN_MIN) return null;

  return {
    delta: latest.value - baseline.value,
    spanMin: span,
  };
}

function seriesOf(
  snapshots: readonly VixSnapshot[],
  pick: (s: VixSnapshot) => number | null,
): { t: number; value: number }[] {
  const out: { t: number; value: number }[] = [];
  for (const s of snapshots) {
    const v = pick(s);
    if (v == null || !Number.isFinite(v)) continue;
    const t = parseEntryTimeMinutes(s.entryTime);
    if (Number.isNaN(t)) continue;
    out.push({ t, value: v });
  }
  return out;
}

export function deriveTrajectory(
  snapshots: readonly VixSnapshot[],
): VixTrajectoryState {
  if (snapshots.length === 0) return { ...EMPTY, hasData: true };

  const ratio1dSeries = seriesOf(snapshots, (s) =>
    s.vix1d != null && s.vix > 0 ? s.vix1d / s.vix : null,
  );
  const ratio9dSeries = seriesOf(snapshots, (s) =>
    s.vix9d != null && s.vix > 0 ? s.vix9d / s.vix : null,
  );
  const spxSeries = seriesOf(snapshots, (s) => s.spx);

  return {
    hasData: true,
    ratio1d: computeTrajectory(ratio1dSeries),
    ratio9d: computeTrajectory(ratio9dSeries),
    spx: computeTrajectory(spxSeries),
  };
}

export function useVixTrajectory(marketOpen: boolean): VixTrajectoryState {
  const isOwner = checkIsOwner();
  const [state, setState] = useState<VixTrajectoryState>(EMPTY);
  const mountedRef = useRef(true);

  const fetchSnapshots = useCallback(async () => {
    try {
      const res = await fetch('/api/vix-snapshots-recent', {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { snapshots?: VixSnapshot[] };
      if (!mountedRef.current) return;
      setState(deriveTrajectory(data.snapshots ?? []));
    } catch {
      // Network error: silent; the next poll retries.
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Initial fetch when ownership resolves -- runs regardless of marketOpen so
  // the panel still shows today's most recent VIX snapshots after the close.
  // The poll loop below is the live-data path and stays gated on marketOpen.
  useEffect(() => {
    if (!isOwner) return;
    void fetchSnapshots();
  }, [isOwner, fetchSnapshots]);

  useEffect(() => {
    if (!isOwner || !marketOpen) return;
    const id = setInterval(fetchSnapshots, POLL_INTERVALS.MARKET_DATA);
    return () => clearInterval(id);
  }, [isOwner, marketOpen, fetchSnapshots]);

  return state;
}
