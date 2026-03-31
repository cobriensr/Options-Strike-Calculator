/**
 * AnalysisHistory — Browse past Claude chart analyses.
 *
 * Top-level mode filter → Date picker → Entry Time picker → Mode tabs
 * All options are driven by what's in the database.
 * All result sections default to collapsed.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { theme } from '../../themes';
import type { AnalysisMode, AnalysisResult } from './types';
import { MODE_LABELS } from './types';
import { ErrorMsg, SectionBox } from '../ui';
import { tint } from '../../utils/ui-utils';
import AnalysisResultsView from './AnalysisResults';

// ── Types ──────────────────────────────────────────────────

interface DateEntry {
  date: string;
  total: number;
  entries: number;
  middays: number;
  reviews: number;
}

interface AnalysisEntry {
  id: number;
  entryTime: string;
  mode: AnalysisMode;
  structure: string;
  confidence: string;
  suggestedDelta: number;
  spx: number | null;
  vix: number | null;
  vix1d: number | null;
  hedge: string | null;
  analysis: AnalysisResult;
  createdAt: string;
}

type ModeFilter = 'all' | 'entry' | 'midday' | 'review';

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

  // ── Derived: the selected analysis ─────────────────────

  const selectedAnalysis = useMemo(() => {
    if (!selectedTime || !selectedMode) return null;
    return (
      filteredAnalyses.find(
        (a) => a.entryTime === selectedTime && a.mode === selectedMode,
      ) ?? null
    );
  }, [filteredAnalyses, selectedTime, selectedMode]);

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
        // If filtering by mode, auto-select that mode
        setSelectedMode(modeFilter as AnalysisMode);
      } else {
        // Prefer entry → midday → review
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
  }, []);

  // ── No-op for image replace ────────────────────────────

  const noopReplace = useCallback(() => {}, []);

  // ── Helpers ────────────────────────────────────────────

  const modeColor = (m: string) => {
    if (m === 'entry') return theme.accent;
    if (m === 'midday') return theme.caution;
    return '#A78BFA';
  };

  const formatDateLabel = (d: string) => {
    try {
      const [year, month, day] = d.split('-').map(Number);
      const date = new Date(year!, month! - 1, day!);
      return date.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return d;
    }
  };

  const dateCount = (d: DateEntry) => {
    if (modeFilter === 'entry') return d.entries;
    if (modeFilter === 'midday') return d.middays;
    if (modeFilter === 'review') return d.reviews;
    return d.total;
  };

  // ── Render ─────────────────────────────────────────────

  if (allDates.length === 0) {
    return (
      <SectionBox label="Analysis History">
        {fetchError && <ErrorMsg>{fetchError}</ErrorMsg>}
        {!fetchError && (
          <div
            className="rounded-lg px-3 py-6 text-center font-sans text-[11px]"
            style={{ color: theme.textMuted }}
          >
            No saved analyses yet. Run a chart analysis to get started.
          </div>
        )}
      </SectionBox>
    );
  }

  return (
    <SectionBox label="Analysis History">
      {/* ── Mode filter tabs ──────────────────────────────── */}
      <div className="mb-4 flex gap-1.5">
        {(
          [
            ['all', 'All'],
            ['entry', 'Pre-Trade'],
            ['midday', 'Mid-Day'],
            ['review', 'Review'],
          ] as const
        ).map(([key, label]) => {
          const active = modeFilter === key;
          const color =
            key === 'all'
              ? theme.text
              : key === 'entry'
                ? theme.accent
                : key === 'midday'
                  ? theme.caution
                  : '#A78BFA';
          return (
            <button
              key={key}
              type="button"
              onClick={() => setModeFilter(key)}
              className="cursor-pointer rounded-full px-3 py-1.5 font-mono text-[10px] font-semibold transition-all duration-100"
              style={{
                backgroundColor: active ? tint(color, '15') : 'transparent',
                color: active ? color : theme.textMuted,
                border: `1.5px solid ${active ? color + '40' : theme.border}`,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {fetchError && <ErrorMsg>{fetchError}</ErrorMsg>}

      {/* ── Picker row ────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        {/* Date picker */}
        <div className="min-w-[180px] flex-1">
          <label
            htmlFor="analysis-date-picker"
            className="text-muted mb-1 block font-sans text-[9px] font-bold tracking-wider uppercase"
          >
            Date
          </label>
          <select
            id="analysis-date-picker"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="bg-input border-edge-strong hover:border-edge-heavy w-full cursor-pointer appearance-none rounded-lg border-[1.5px] px-3 py-2 font-mono text-[12px] transition-[border-color] duration-150 outline-none"
            style={{ color: theme.text }}
          >
            <option value="">Select a date...</option>
            {filteredDates.map((d) => {
              const count = dateCount(d);
              return (
                <option key={d.date} value={d.date}>
                  {formatDateLabel(d.date)} ({count})
                </option>
              );
            })}
          </select>
        </div>

        {/* Time picker */}
        {selectedDate && availableTimes.length > 0 && (
          <div className="min-w-[140px]">
            <label
              htmlFor="analysis-time-picker"
              className="text-muted mb-1 block font-sans text-[9px] font-bold tracking-wider uppercase"
            >
              Entry Time
            </label>
            <select
              id="analysis-time-picker"
              value={selectedTime}
              onChange={(e) => handleTimeChange(e.target.value)}
              className="bg-input border-edge-strong hover:border-edge-heavy w-full cursor-pointer appearance-none rounded-lg border-[1.5px] px-3 py-2 font-mono text-[12px] transition-[border-color] duration-150 outline-none"
              style={{ color: theme.text }}
            >
              {availableTimes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Mode tabs — only show when filter is 'all' and multiple modes available */}
        {selectedTime && availableModes.length > 1 && (
          <fieldset className="m-0 border-0 p-0">
            <legend className="text-muted mb-1 block font-sans text-[9px] font-bold tracking-wider uppercase">
              Type
            </legend>
            <div className="flex gap-1">
              {(['entry', 'midday', 'review'] as AnalysisMode[]).map((m) => {
                const available = availableModes.includes(m);
                const active = selectedMode === m;
                if (!available) return null;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setSelectedMode(m)}
                    className="cursor-pointer rounded-md px-3 py-2 font-mono text-[10px] font-semibold transition-all duration-100"
                    style={{
                      backgroundColor: active
                        ? tint(modeColor(m), '18')
                        : 'transparent',
                      color: active ? modeColor(m) : theme.textMuted,
                      border: `1.5px solid ${active ? modeColor(m) + '40' : theme.border}`,
                    }}
                  >
                    {MODE_LABELS[m].label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}
      </div>

      {/* ── Loading ───────────────────────────────────────── */}
      {loading && (
        <div
          className="rounded-lg px-3 py-4 text-center font-sans text-[11px]"
          style={{ color: theme.textMuted }}
        >
          Loading...
        </div>
      )}

      {/* ── Summary bar + results ─────────────────────────── */}
      {selectedAnalysis && !loading && (
        <>
          <div
            className="mb-3 flex items-center justify-between rounded-lg px-3 py-2"
            style={{
              backgroundColor: tint(modeColor(selectedAnalysis.mode), '08'),
            }}
          >
            <div className="flex items-center gap-2">
              <span
                className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
                style={{
                  backgroundColor: tint(modeColor(selectedAnalysis.mode), '15'),
                  color: modeColor(selectedAnalysis.mode),
                }}
              >
                {MODE_LABELS[selectedAnalysis.mode].label}
              </span>
              <span
                className="font-mono text-[12px] font-bold"
                style={{
                  color:
                    selectedAnalysis.structure === 'IRON CONDOR'
                      ? theme.accent
                      : selectedAnalysis.structure === 'PUT CREDIT SPREAD'
                        ? theme.red
                        : selectedAnalysis.structure === 'CALL CREDIT SPREAD'
                          ? theme.green
                          : theme.caution,
                }}
              >
                {selectedAnalysis.structure}
              </span>
              <span
                className="font-mono text-[10px] font-semibold"
                style={{
                  color:
                    selectedAnalysis.confidence === 'HIGH'
                      ? theme.green
                      : selectedAnalysis.confidence === 'MODERATE'
                        ? theme.caution
                        : theme.red,
                }}
              >
                {selectedAnalysis.confidence}
              </span>
              <span className="text-muted font-mono text-[10px]">
                {selectedAnalysis.suggestedDelta}
                {'\u0394'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {!!selectedAnalysis.spx && (
                <span className="text-muted font-mono text-[10px]">
                  SPX {Number(selectedAnalysis.spx).toFixed(0)}
                </span>
              )}
              {!!selectedAnalysis.vix && (
                <span className="text-muted font-mono text-[10px]">
                  VIX {Number(selectedAnalysis.vix).toFixed(1)}
                </span>
              )}
            </div>
          </div>

          <AnalysisResultsView
            analysis={selectedAnalysis.analysis}
            mode={selectedAnalysis.mode}
            onReplaceImage={noopReplace}
            defaultCollapsed
          />
        </>
      )}

      {/* ── Empty state ───────────────────────────────────── */}
      {selectedDate && !loading && filteredAnalyses.length === 0 && (
        <div
          className="rounded-lg px-3 py-4 text-center font-sans text-[11px]"
          style={{ color: theme.textMuted }}
        >
          No{' '}
          {modeFilter === 'all'
            ? ''
            : MODE_LABELS[modeFilter as AnalysisMode].label + ' '}
          analyses found for this date.
        </div>
      )}
    </SectionBox>
  );
}
