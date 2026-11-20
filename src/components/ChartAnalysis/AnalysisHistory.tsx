/**
 * AnalysisHistory — Browse past Claude chart analyses.
 *
 * Orchestrator: manages state, data fetching, and derived values.
 * Delegates all UI rendering to AnalysisHistoryPicker.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import type {
  AnalysisEntry,
  AnalysisMode,
  DateEntry,
  ModeFilter,
} from './types';
import { SectionBox } from '../ui';
import { checkIsOwner } from '../../utils/auth';
import { parseEntryTimeMinutes } from '../../utils/entry-time';
import AnalysisHistoryPicker from './AnalysisHistoryPicker';
import { analysesResponseSchema, datesResponseSchema } from './analyses-schema';
import { captureUnlessAuth } from '../../lib/sentry-helpers';
import { summarizeZodIssues } from '../../lib/response-guard';

const DATES_ERROR_MESSAGE = 'Failed to load analysis dates';
const ANALYSES_ERROR_MESSAGE = 'Failed to load analyses for this date';

// ── Component ──────────────────────────────────────────────

interface Props {
  /** Bump this to trigger a refetch of analysis dates */
  readonly refreshKey?: number;
  readonly defaultCollapsed?: boolean;
}

export default function AnalysisHistory({
  refreshKey,
  defaultCollapsed,
}: Props) {
  // The panel is owner-only: it renders nothing for a guest, so a guest has
  // no use for what /api/analyses (owner-or-guest) would hand back, and a
  // public visitor would only draw a 401. The registry lists it for the owner
  // alone, so a change of access mode mounts or unmounts it, and a fresh mount
  // reads the mode here. This read, at every render above the effects (never
  // frozen in a ref or state), and the `isOwner` in both fetch effects' deps
  // are the backstop for an instance that outlives a mode change: it makes no
  // request as a non-owner, a drop aborts the request in flight, and signing
  // back in refetches.
  const isOwner = checkIsOwner();

  const [allDates, setAllDates] = useState<DateEntry[]>([]);
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all');
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [analyses, setAnalyses] = useState<AnalysisEntry[]>([]);
  const [selectedTime, setSelectedTime] = useState<string>('');
  const [selectedMode, setSelectedMode] = useState<AnalysisMode | ''>('');
  const [selectedRunIndex, setSelectedRunIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Its own state, apart from the dates list's `fetchError`, so neither fetch
  // can overwrite or clear the other's message.
  const [analysesError, setAnalysesError] = useState<string | null>(null);

  // ── Fetch dates on mount + when refreshKey changes ────

  useEffect(() => {
    if (!isOwner) {
      // Drop what an earlier owner session left, so a visitor who signs back
      // in doesn't open on its list or its error before the refetch lands.
      setAllDates([]);
      setFetchError(null);
      return;
    }

    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/analyses?dates=true', {
          signal: controller.signal,
        });
        if (!res.ok) {
          if (!controller.signal.aborted) setFetchError(DATES_ERROR_MESSAGE);
          return;
        }
        const text = await res.text();
        if (!text.startsWith('{')) {
          if (!controller.signal.aborted) setFetchError(DATES_ERROR_MESSAGE);
          return;
        }
        const body: unknown = JSON.parse(text);
        if (controller.signal.aborted) return;
        const parsed = datesResponseSchema.safeParse(body);
        if (!parsed.success) {
          // A well-formed reply of the wrong shape: nothing from it is kept,
          // and the list from before it goes too, as the catch below does.
          captureUnlessAuth(
            new Error('analyses dates response failed schema validation'),
            {
              contexts: {
                analysesDates: summarizeZodIssues(parsed.error.issues),
              },
            },
          );
          setAllDates([]);
          setFetchError(DATES_ERROR_MESSAGE);
          return;
        }
        setAllDates(parsed.data.dates);
        setFetchError(null);
      } catch {
        if (!controller.signal.aborted) {
          setAllDates([]);
          setFetchError(DATES_ERROR_MESSAGE);
        }
      }
    })();
    return () => controller.abort();
  }, [refreshKey, isOwner]);

  // ── Filtered dates based on mode filter ────────────────

  const filteredDates = useMemo(() => {
    if (modeFilter === 'all') return allDates;
    return allDates.filter((d) => {
      if (modeFilter === 'entry') return d.entries > 0;
      if (modeFilter === 'midday') return d.middays > 0;
      if (modeFilter === 'review') return d.reviews > 0;
      return true;
    });
  }, [allDates, modeFilter]);

  // ── Reset date when filter changes ─────────────────────

  useEffect(() => {
    setSelectedDate('');
    setAnalyses([]);
    setSelectedTime('');
    setSelectedMode('');
  }, [modeFilter]);

  // ── Fetch analyses when date changes ───────────────────

  useEffect(() => {
    // Every run supersedes the one before it, whose cleanup aborted its
    // fetch, and an aborted fetch never reaches the `setLoading(false)` after
    // its reply. So the flag is cleared here, for the no-date and non-owner
    // branches below; the fetch path's `setLoading(true)` follows in the same
    // effect and React batches the two, so there's no flicker. The previous
    // fetch's error goes with it: it described a request that is gone.
    setLoading(false);
    setAnalysesError(null);

    // A non-owner asks for nothing, and drops what an earlier owner session
    // left, like the no-date case.
    if (!isOwner || !selectedDate) {
      setAnalyses([]);
      setSelectedTime('');
      setSelectedMode('');
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    // The previous date's analyses go before the request, so a reply that
    // fails (a non-ok status, a body that isn't JSON, a rejected fetch)
    // leaves none on screen under this date, and the time and mode
    // auto-selects have none to pick from while it is in flight.
    setAnalyses([]);
    setSelectedTime('');
    setSelectedMode('');

    (async () => {
      try {
        const res = await fetch(`/api/analyses?date=${selectedDate}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          if (!controller.signal.aborted)
            setAnalysesError(ANALYSES_ERROR_MESSAGE);
          return;
        }
        const body: unknown = await res.json();
        if (controller.signal.aborted) return;
        const parsed = analysesResponseSchema.safeParse(body);
        if (!parsed.success) {
          // A well-formed reply of the wrong shape: nothing from it is kept
          // (the previous date's rows went before the request), and the panel
          // says it failed rather than that there is nothing.
          captureUnlessAuth(
            new Error('analyses response failed schema validation'),
            {
              contexts: {
                analyses: {
                  date: selectedDate,
                  ...summarizeZodIssues(parsed.error.issues),
                },
              },
            },
          );
          setAnalysesError(ANALYSES_ERROR_MESSAGE);
          return;
        }
        // The schema checks what the panel reads, and its output is looser
        // than `AnalysisEntry` (the server stores `null` for blocks the shared
        // type calls optional), so this is the one cast.
        setAnalyses(parsed.data.analyses as AnalysisEntry[]);
      } catch {
        if (!controller.signal.aborted)
          setAnalysesError(ANALYSES_ERROR_MESSAGE);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [selectedDate, refreshKey, isOwner]);

  // ── Filter analyses by mode filter ─────────────────────

  const filteredAnalyses = useMemo(() => {
    if (modeFilter === 'all') return analyses;
    return analyses.filter((a) => a.mode === modeFilter);
  }, [analyses, modeFilter]);

  // ── Derived: unique entry times for filtered analyses ──

  const availableTimes = useMemo(() => {
    const times = [...new Set(filteredAnalyses.map((a) => a.entryTime))];
    // A label that is not a clock time ("unknown") sorts first.
    const minutes = (t: string) => {
      const m = parseEntryTimeMinutes(t);
      return Number.isNaN(m) ? 0 : m;
    };
    return times.sort((a, b) => minutes(a) - minutes(b));
  }, [filteredAnalyses]);

  // ── Derived: available modes for selected time ─────────

  const availableModes = useMemo(() => {
    if (!selectedTime) return [];
    return filteredAnalyses
      .filter((a) => a.entryTime === selectedTime)
      .map((a) => a.mode);
  }, [filteredAnalyses, selectedTime]);

  // ── Derived: runs at selected (time, mode) ─────────────

  const runsAtTimeMode = useMemo(() => {
    if (!selectedTime || !selectedMode) return [];
    return filteredAnalyses
      .filter((a) => a.entryTime === selectedTime && a.mode === selectedMode)
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
  }, [filteredAnalyses, selectedTime, selectedMode]);

  const selectedAnalysis = useMemo(() => {
    if (runsAtTimeMode.length === 0) return null;
    return runsAtTimeMode[selectedRunIndex] ?? runsAtTimeMode[0] ?? null;
  }, [runsAtTimeMode, selectedRunIndex]);

  // ── Auto-select first time when times load ─────────────

  useEffect(() => {
    if (availableTimes.length > 0 && !selectedTime) {
      setSelectedTime(availableTimes[0]!);
    }
  }, [availableTimes, selectedTime]);

  // ── Auto-select mode when modes load ───────────────────

  useEffect(() => {
    if (availableModes.length > 0 && !selectedMode) {
      if (modeFilter !== 'all') {
        setSelectedMode(modeFilter as AnalysisMode);
      } else {
        const preferred: AnalysisMode[] = ['entry', 'midday', 'review'];
        const first = preferred.find((m) => availableModes.includes(m));
        setSelectedMode(first ?? availableModes[0]!);
      }
    }
  }, [availableModes, selectedMode, modeFilter]);

  // ── Reset downstream when time changes ─────────────────

  const handleTimeChange = useCallback((time: string) => {
    setSelectedTime(time);
    setSelectedMode('');
    setSelectedRunIndex(0);
  }, []);

  // Owner gating: only the owner (or local dev) sees the panel. This sits
  // after the hooks to satisfy the Rules of Hooks; the fetch effects above
  // already made no request for a non-owner.
  if (!isOwner) return null;

  // ── Render ─────────────────────────────────────────────

  if (allDates.length === 0) {
    return (
      <SectionBox
        label="Analysis History"
        collapsible
        defaultCollapsed={defaultCollapsed}
      >
        {fetchError && (
          <div className="text-danger text-[11px]">{fetchError}</div>
        )}
        {!fetchError && (
          <div className="border-edge-strong bg-surface rounded-[14px] border-2 border-dashed px-8 py-8 text-center">
            <div className="text-muted mb-1 text-[20px]">{'\u2014'}</div>
            <p className="text-secondary m-0 font-sans text-[13px]">
              No analyses saved yet.
            </p>
            <p className="text-muted m-0 mt-1 font-sans text-[11px]">
              Run a chart analysis to see results here.
            </p>
          </div>
        )}
      </SectionBox>
    );
  }

  return (
    <SectionBox
      label="Analysis History"
      collapsible
      defaultCollapsed={defaultCollapsed}
    >
      <AnalysisHistoryPicker
        modeFilter={modeFilter}
        onModeFilterChange={setModeFilter}
        fetchError={fetchError}
        filteredDates={filteredDates}
        selectedDate={selectedDate}
        onDateChange={setSelectedDate}
        availableTimes={availableTimes}
        selectedTime={selectedTime}
        onTimeChange={handleTimeChange}
        availableModes={availableModes}
        selectedMode={selectedMode}
        onModeChange={setSelectedMode}
        runsAtTimeMode={runsAtTimeMode}
        selectedRunIndex={selectedRunIndex}
        onRunIndexChange={setSelectedRunIndex}
        selectedAnalysis={selectedAnalysis}
        loading={loading}
        analysesError={analysesError}
        filteredAnalysesCount={filteredAnalyses.length}
      />
    </SectionBox>
  );
}
