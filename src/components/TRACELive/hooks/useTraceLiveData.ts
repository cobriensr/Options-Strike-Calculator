/**
 * useTraceLiveData — manages the TRACE Live dashboard's data flow.
 *
 * Two independent concerns govern behavior:
 *   1. Polling — runs while the user is on today's date during market
 *      hours, regardless of which capture is currently displayed. This
 *      keeps the dropdown current so newly-arrived captures show up
 *      without a manual refresh.
 *   2. Auto-follow — when on, the displayed capture advances to the
 *      most-recent row whenever the polled list updates. Default ON;
 *      flips OFF the moment the user picks a specific capture from the
 *      dropdown; flips back ON if the user picks "Latest" (id === null)
 *      or navigates back to today's date from a different one.
 *
 * Earlier shape conflated these two — `isLive` (= polling + follow) was
 * computed as `isToday && selectedId === null`, so the auto-follow's own
 * setSelectedId(latest.id) flipped isLive false on the first tick and
 * stopped polling entirely. The fix is to give "follow" its own state
 * and have polling depend on `isToday && marketOpen` only.
 *
 * Owner-gated — non-owners see empty state with no fetches.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../../../constants';
import { getErrorMessage } from '../../../utils/error';
import { checkIsOwner } from '../../../utils/auth';
import type { TraceLiveDetail, TraceLiveSummary } from '../types';

function etToday(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
}

export interface UseTraceLiveDataReturn {
  /** Compact summaries for the active date — drives the dropdown. */
  list: TraceLiveSummary[];
  listLoading: boolean;
  listError: string | null;
  /** Full detail for the active id, including imageUrls and analysis. */
  detail: TraceLiveDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  /** Date in ET (YYYY-MM-DD) — drives both list query and live/historical mode. */
  selectedDate: string;
  setSelectedDate: (d: string) => void;
  /** Active row id. null = "follow latest" (live mode default). */
  selectedId: number | null;
  setSelectedId: (id: number | null) => void;
  /** True when polling — today + no manual id selection. */
  isLive: boolean;
  /** Force a list+detail refresh now. */
  refresh: () => void;
}

export function useTraceLiveData(marketOpen: boolean): UseTraceLiveDataReturn {
  const isOwner = checkIsOwner();
  const [list, setList] = useState<TraceLiveSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceLiveDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(etToday);
  const [selectedId, setSelectedIdInternal] = useState<number | null>(null);
  const [followLatest, setFollowLatest] = useState(true);
  const mountedRef = useRef(true);

  const isToday = selectedDate === etToday();
  // Poll while on today's date during market hours — independent of
  // whether auto-follow is active, so the dropdown stays current even
  // when the user is reviewing a specific older capture from today.
  const shouldPoll = isToday && marketOpen;
  // "Live" = polling AND auto-following — what the UI's Live badge means.
  const isLive = shouldPoll && followLatest;

  // User-driven setSelectedId — picking a specific id turns off
  // auto-follow; picking null (Latest) turns it back on.
  const setSelectedId = useCallback((id: number | null) => {
    setSelectedIdInternal(id);
    setFollowLatest(id === null);
  }, []);

  // ── List fetch ───────────────────────────────────────────────────
  const fetchList = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/trace-live-list?date=${encodeURIComponent(selectedDate)}`,
        {
          credentials: 'same-origin',
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!mountedRef.current) return;
      if (!res.ok) {
        if (res.status !== 401) setListError('Failed to load TRACE captures');
        return;
      }
      const data = (await res.json()) as {
        date: string;
        count: number;
        analyses: TraceLiveSummary[];
      };
      if (!mountedRef.current) return;
      setList(data.analyses);
      setListError(null);
    } catch (err) {
      if (mountedRef.current) setListError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setListLoading(false);
    }
  }, [selectedDate]);

  // ── Detail fetch ─────────────────────────────────────────────────
  const fetchDetail = useCallback(async (id: number) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/trace-live-get?id=${id}`, {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(8_000),
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        if (res.status === 404) {
          setDetailError('Capture not found');
        } else if (res.status !== 401) {
          setDetailError('Failed to load capture detail');
        }
        return;
      }
      const data = (await res.json()) as TraceLiveDetail;
      if (!mountedRef.current) return;
      setDetail(data);
      setDetailError(null);
    } catch (err) {
      if (mountedRef.current) setDetailError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setDetailLoading(false);
    }
  }, []);

  // ── Lifecycle: mount flag ────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Reset selection on date change ───────────────────────────────
  // Going to a new date resets to "follow latest" — for today this means
  // resume live behavior; for historical days the auto-follow effect just
  // pins to that day's last capture once the list loads, which is fine.
  useEffect(() => {
    setSelectedIdInternal(null);
    setFollowLatest(true);
  }, [selectedDate]);

  // ── List polling ─────────────────────────────────────────────────
  // Polls while on today's date during market hours, regardless of
  // whether the user is auto-following or has picked a specific id.
  useEffect(() => {
    if (!isOwner) {
      setListLoading(false);
      return;
    }
    if (!shouldPoll) {
      // Historical or market-closed: single fetch.
      setListLoading(true);
      void fetchList();
      return;
    }
    void fetchList();
    const id = setInterval(() => void fetchList(), POLL_INTERVALS.TRACE_LIVE);
    return () => clearInterval(id);
  }, [isOwner, shouldPoll, fetchList]);

  // ── Auto-follow latest while followLatest is on ──────────────────
  // When list updates, advance selectedId to the most-recent row.
  // followLatest stays true unless the user explicitly picks a specific
  // capture (handled by the wrapped setSelectedId), so the displayed
  // analysis tracks new arrivals automatically.
  useEffect(() => {
    if (!followLatest || list.length === 0) return;
    const latest = list[list.length - 1]!;
    setSelectedIdInternal((prev) => (prev === latest.id ? prev : latest.id));
  }, [followLatest, list]);

  // ── Detail fetch on id change ────────────────────────────────────
  useEffect(() => {
    if (!isOwner || selectedId == null) {
      setDetail(null);
      return;
    }
    void fetchDetail(selectedId);
  }, [isOwner, selectedId, fetchDetail]);

  const refresh = useCallback(() => {
    setListLoading(true);
    void fetchList();
    if (selectedId != null) void fetchDetail(selectedId);
  }, [fetchList, fetchDetail, selectedId]);

  return {
    list,
    listLoading,
    listError,
    detail,
    detailLoading,
    detailError,
    selectedDate,
    setSelectedDate,
    selectedId,
    setSelectedId,
    isLive,
    refresh,
  };
}
