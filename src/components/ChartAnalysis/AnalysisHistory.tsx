/**
 * AnalysisHistory — Browse past Claude chart analyses.
 *
 * Cascading picker: Date → Entry Time → Mode (entry/midday/review)
 * All options are driven by what's in the database.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import type { Theme } from '../../themes';
import type { AnalysisMode, AnalysisResult } from './types';
import { MODE_LABELS } from './types';
import { SectionBox } from '../ui';
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

// ── Component ──────────────────────────────────────────────

interface Props {
  readonly th: Theme;
}

export default function AnalysisHistory({ th }: Props) {
  const [dates, setDates] = useState<DateEntry[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [analyses, setAnalyses] = useState<AnalysisEntry[]>([]);
  const [selectedTime, setSelectedTime] = useState<string>('');
  const [selectedMode, setSelectedMode] = useState<AnalysisMode | ''>('');
  const [loading, setLoading] = useState(false);

  // ── Fetch dates on mount ───────────────────────────────

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/analyses?dates=true');
        if (!res.ok) return;
        const text = await res.text();
        if (!text.startsWith('{')) return;
        const data = JSON.parse(text);
        if (!cancelled) setDates(data.dates ?? []);
      } catch {
        if (!cancelled) setDates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
  }, [selectedDate]);

  // ── Derived: unique entry times for selected date ──────

  const availableTimes = useMemo(() => {
    const times = [...new Set(analyses.map((a) => a.entryTime))];
    // Sort chronologically by parsing the time string
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
  }, [analyses]);

  // ── Derived: available modes for selected time ─────────

  const availableModes = useMemo(() => {
    if (!selectedTime) return [];
    return analyses
      .filter((a) => a.entryTime === selectedTime)
      .map((a) => a.mode);
  }, [analyses, selectedTime]);

  // ── Derived: the selected analysis ─────────────────────

  const selectedAnalysis = useMemo(() => {
    if (!selectedTime || !selectedMode) return null;
    return (
      analyses.find(
        (a) => a.entryTime === selectedTime && a.mode === selectedMode,
      ) ?? null
    );
  }, [analyses, selectedTime, selectedMode]);

  // ── Auto-select first time when times load ─────────────

  useEffect(() => {
    if (availableTimes.length > 0 && !selectedTime) {
      setSelectedTime(availableTimes[0]!);
    }
  }, [availableTimes, selectedTime]);

  // ── Auto-select first mode when modes load ─────────────

  useEffect(() => {
    if (availableModes.length > 0 && !selectedMode) {
      // Prefer entry → midday → review order
      const preferred: AnalysisMode[] = ['entry', 'midday', 'review'];
      const first = preferred.find((m) => availableModes.includes(m));
      setSelectedMode(first ?? availableModes[0]!);
    }
  }, [availableModes, selectedMode]);

  // ── Reset downstream when time changes ─────────────────

  const handleTimeChange = useCallback((time: string) => {
    setSelectedTime(time);
    setSelectedMode('');
  }, []);

  // ── No-op for image replace ────────────────────────────

  const noopReplace = useCallback(() => {}, []);

  // ── Helpers ────────────────────────────────────────────

  const modeColor = (m: string) => {
    if (m === 'entry') return th.accent;
    if (m === 'midday') return th.caution;
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

  // ── Render ─────────────────────────────────────────────

  if (dates.length === 0) {
    return (
      <SectionBox label="Analysis History">
        <div
          className="rounded-lg px-3 py-6 text-center font-sans text-[11px]"
          style={{ color: th.textMuted }}
        >
          No saved analyses yet. Run a chart analysis to get started.
        </div>
      </SectionBox>
    );
  }

  return (
    <SectionBox label="Analysis History">
      {/* ── Picker row ────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        {/* Date picker */}
        <div className="min-w-[180px] flex-1">
          <label
            htmlFor="analysis-date"
            className="text-muted mb-1 block font-sans text-[9px] font-bold tracking-wider uppercase"
          >
            Date
          </label>
          <select
            id="analysis-date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="bg-input border-edge-strong hover:border-edge-heavy w-full cursor-pointer appearance-none rounded-lg border-[1.5px] px-3 py-2 font-mono text-[12px] outline-none transition-[border-color] duration-150"
            style={{ color: th.text }}
          >
            <option value="">Select a date...</option>
            {dates.map((d) => (
              <option key={d.date} value={d.date}>
                {formatDateLabel(d.date)} ({d.total} analysis{d.total > 1 ? 'es' : ''})
              </option>
            ))}
          </select>
        </div>

        {/* Time picker */}
        {selectedDate && availableTimes.length > 0 && (
          <div className="min-w-[140px]">
            <label
              htmlFor="analysis-time"
              className="text-muted mb-1 block font-sans text-[9px] font-bold tracking-wider uppercase"
            >
              Entry Time
            </label>
            <select
              id="analysis-time"
              value={selectedTime}
              onChange={(e) => handleTimeChange(e.target.value)}
              className="bg-input border-edge-strong hover:border-edge-heavy w-full cursor-pointer appearance-none rounded-lg border-[1.5px] px-3 py-2 font-mono text-[12px] outline-none transition-[border-color] duration-150"
              style={{ color: th.text }}
            >
              {availableTimes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Mode tabs */}
        {selectedTime && availableModes.length > 0 && (
          <div>
            <fieldset className="m-0 border-0 p-0">
              <legend
                className="text-muted mb-1 block font-sans text-[9px] font-bold tracking-wider uppercase"
              >
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
                      color: active ? modeColor(m) : th.textMuted,
                      border: `1.5px solid ${active ? modeColor(m) + '40' : th.border}`,
                    }}
                  >
                    {MODE_LABELS[m].label}
                  </button>
                );
              })}
              </div>
            </fieldset>
          </div>
        )}
      </div>

      {/* ── Loading ───────────────────────────────────────── */}
      {loading && (
        <div
          className="rounded-lg px-3 py-4 text-center font-sans text-[11px]"
          style={{ color: th.textMuted }}
        >
          Loading...
        </div>
      )}

      {/* ── Summary bar ───────────────────────────────────── */}
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
                className="font-mono text-[12px] font-bold"
                style={{
                  color:
                    selectedAnalysis.structure === 'IRON CONDOR'
                      ? th.accent
                      : selectedAnalysis.structure === 'PUT CREDIT SPREAD'
                        ? th.red
                        : selectedAnalysis.structure === 'CALL CREDIT SPREAD'
                          ? th.green
                          : th.caution,
                }}
              >
                {selectedAnalysis.structure}
              </span>
              <span
                className="font-mono text-[10px] font-semibold"
                style={{
                  color:
                    selectedAnalysis.confidence === 'HIGH'
                      ? th.green
                      : selectedAnalysis.confidence === 'MODERATE'
                        ? th.caution
                        : th.red,
                }}
              >
                {selectedAnalysis.confidence}
              </span>
              <span className="text-muted font-mono text-[10px]">
                {selectedAnalysis.suggestedDelta}{'\u0394'}
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

          {/* ── Analysis results ──────────────────────────── */}
          <AnalysisResultsView
            th={th}
            analysis={selectedAnalysis.analysis}
            mode={selectedAnalysis.mode}
            onReplaceImage={noopReplace}
          />
        </>
      )}

      {/* ── Empty state after selecting date ──────────────── */}
      {selectedDate && !loading && analyses.length === 0 && (
        <div
          className="rounded-lg px-3 py-4 text-center font-sans text-[11px]"
          style={{ color: th.textMuted }}
        >
          No analyses found for this date.
        </div>
      )}
    </SectionBox>
  );
}