/**
 * useTraceLiveData — manages the TRACE Live dashboard's data flow.
 *
 * One hook owns the date + active-id state, list fetch + 60s polling
 * during live mode, and detail fetch when an id is selected. Mirrors the
 * useDarkPoolLevels live/historical pattern from this codebase.
 *
 * Live mode (today + selectedId === null):
 *   - Polls /api/trace-live-list?date=today every POLL_INTERVALS.TRACE_LIVE.
 *   - Auto-selects the most recent row's id when the list updates.
 *   - When selected id changes, fetches detail.
 *
 * Historical mode (date in past OR selectedId !== null):
 *   - Single fetch of the list for the chosen date.
 *   - Detail fetched on each id change.
 *   - No polling.
 *
 * Owner-gated — non-owners see empty state with no fetches.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../../../constants';
import { getErrorMessage } from '../../../utils/error';
import { useIsOwner } from '../../../hooks/useIsOwner';
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
  const isOwner = useIsOwner();
  const [list, setList] = useState<TraceLiveSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceLiveDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(etToday);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const mountedRef = useRef(true);

  const isToday = selectedDate === etToday();
  const isLive = isToday && selectedId === null;

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

  // ── Reset selectedId on date change ──────────────────────────────
  useEffect(() => {
    setSelectedId(null);
  }, [selectedDate]);

  // ── List polling ─────────────────────────────────────────────────
  useEffect(() => {
    if (!isOwner) {
      setListLoading(false);
      return;
    }
    if (!isLive || !marketOpen) {
      // Historical or market-closed: single fetch.
      setListLoading(true);
      void fetchList();
      return;
    }
    // Live: poll.
    void fetchList();
    const id = setInterval(() => void fetchList(), POLL_INTERVALS.TRACE_LIVE);
    return () => clearInterval(id);
  }, [isOwner, isLive, marketOpen, fetchList]);

  // ── Auto-follow latest in live mode ──────────────────────────────
  // When the polled list returns a new "most recent" row, update the
  // active id so the detail view follows. In historical mode, the user
  // explicitly sets selectedId; we don't override it here.
  useEffect(() => {
    if (!isLive || list.length === 0) return;
    const latest = list[list.length - 1]!;
    setSelectedId((prev) => (prev === latest.id ? prev : latest.id));
  }, [isLive, list]);

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
