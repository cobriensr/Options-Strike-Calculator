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
import AnalysisHistoryPicker from './AnalysisHistoryPicker';

// ── Component ──────────────────────────────────────────────

interface Props {
  /** Bump this to trigger a refetch of analysis dates */
  readonly refreshKey?: number;
}

export default function AnalysisHistory({ refreshKey }: Props) {
  const [allDates, setAllDates] = useState<DateEntry[]>([]);
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all');
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [analyses, setAnalyses] = useState<AnalysisEntry[]>([]);
  const [selectedTime, setSelectedTime] = useState<string>('');
  const [selectedMode, setSelectedMode] = useState<AnalysisMode | ''>('');
  const [selectedRunIndex, setSelectedRunIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // ── Fetch dates on mount + when refreshKey changes ────

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/analyses?dates=true', {
          signal: controller.signal,
        });
        if (!res.ok) {
          if (!controller.signal.aborted)
            setFetchError('Failed to load analysis dates');
          return;
        }
        const text = await res.text();
        if (!text.startsWith('{')) {
          if (!controller.signal.aborted)
            setFetchError('Failed to load analysis dates');
          return;
        }
        const data = JSON.parse(text);
        if (!controller.signal.aborted) {
          setAllDates(data.dates ?? []);
          setFetchError(null);
        }
      } catch {
        if (!controller.signal.aborted) {
          setAllDates([]);
          setFetchError('Failed to load analysis dates');
        }
      }
    })();
    return () => controller.abort();
  }, [refreshKey]);

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
    if (!selectedDate) {
      setAnalyses([]);
      setSelectedTime('');
      setSelectedMode('');
      return;
    }

    let cancelled = false;
    setLoading(true);
    setSelectedTime('');
    setSelectedMode('');

    (async () => {
      try {
        const res = await fetch(`/api/analyses?date=${selectedDate}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setAnalyses(data.analyses ?? []);
      } catch {
        if (!cancelled) setAnalyses([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedDate, refreshKey]);

  // ── Filter analyses by mode filter ─────────────────────

  const filteredAnalyses = useMemo(() => {
    if (modeFilter === 'all') return analyses;
    return analyses.filter((a) => a.mode === modeFilter);
  }, [analyses, modeFilter]);

  // ── Derived: unique entry times for filtered analyses ──

  const availableTimes = useMemo(() => {
    const times = [...new Set(filteredAnalyses.map((a) => a.entryTime))];
    return times.sort((a, b) => {
      const parse = (t: string) => {
        const match = /^(\d+):(\d+)\s*(AM|PM)/i.exec(t);
        if (!match) return 0;
        let h = Number.parseInt(match[1]!, 10);
        const m = Number.parseInt(match[2]!, 10);
        const ampm = match[3]!.toUpperCase();
        if (ampm === 'PM' && h !== 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;
        return h * 60 + m;
      };
      return parse(a) - parse(b);
    });
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

  // Owner gating — only render for authenticated owner (or local dev)
  // Placed after hooks to satisfy Rules of Hooks
  const isOwner = checkIsOwner();
  if (!isOwner) return null;

  // ── Render ─────────────────────────────────────────────

  if (allDates.length === 0) {
    return (
      <SectionBox label="Analysis History" collapsible>
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
    <SectionBox label="Analysis History" collapsible>
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
        filteredAnalysesCount={filteredAnalyses.length}
      />
    </SectionBox>
  );
}
