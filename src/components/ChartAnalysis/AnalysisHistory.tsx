/**
 * AnalysisHistory — Browse past Claude chart analyses.
 *
 * Fetches saved analyses from /api/analyses and displays them
 * using the existing AnalysisResults component. No Claude calls
 * needed — just reads from Postgres.
 *
 * Usage:
 *   <AnalysisHistory th={th} />
 */

import { useState, useCallback, useEffect } from 'react';
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
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [analyses, setAnalyses] = useState<AnalysisEntry[]>([]);
  const [selectedAnalysis, setSelectedAnalysis] =
    useState<AnalysisEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch dates on mount ───────────────────────────────

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/analyses?dates=true');
        if (!res.ok) throw new Error('Failed to fetch dates');
        const text = await res.text();
        if (!text.startsWith('{')) throw new Error('API not available');
        const data = JSON.parse(text);
        if (!cancelled) setDates(data.dates ?? []);
      } catch {
        // Silently fail on mount — API may not be available locally
        if (!cancelled) setDates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Fetch analyses for a date ──────────────────────────

  const loadDate = useCallback(async (date: string) => {
    setSelectedDate(date);
    setSelectedAnalysis(null);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/analyses?date=${date}`);
      if (!res.ok) throw new Error('Failed to fetch analyses');
      const data = await res.json();
      setAnalyses(data.analyses ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Back navigation ────────────────────────────────────

  const goBackToList = useCallback(() => {
    setSelectedDate(null);
    setSelectedAnalysis(null);
    setAnalyses([]);
  }, []);

  const goBackToDate = useCallback(() => {
    setSelectedAnalysis(null);
  }, []);

  // ── No-op for image replace (not applicable in history) ─

  const noopReplace = useCallback(() => {}, []);

  // ── Helpers ────────────────────────────────────────────

  const structureColor = (s: string) => {
    if (s === 'IRON CONDOR') return th.accent;
    if (s === 'PUT CREDIT SPREAD') return th.red;
    if (s === 'CALL CREDIT SPREAD') return th.green;
    return th.caution;
  };

  const confidenceColor = (c: string) => {
    if (c === 'HIGH') return th.green;
    if (c === 'MODERATE') return th.caution;
    return th.red;
  };

  const modeColor = (m: string) => {
    if (m === 'entry') return th.accent;
    if (m === 'midday') return th.caution;
    return '#A78BFA';
  };

  const formatDate = (d: string) => {
    try {
      const date = new Date(d + 'T12:00:00');
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

  // ── Render: Single analysis ────────────────────────────

  if (selectedAnalysis) {
    return (
      <SectionBox label="Analysis History">
        <div className="mb-3">
          <button
            type="button"
            onClick={goBackToDate}
            className="cursor-pointer rounded-md px-3 py-1.5 font-sans text-[10px] font-semibold transition-opacity hover:opacity-80"
            style={{ backgroundColor: th.surfaceAlt, color: th.textMuted }}
          >
            {'\u2190'} Back to {formatDate(selectedDate!)}
          </button>
        </div>

        {/* Header bar */}
        <div
          className="mb-3 flex items-center justify-between rounded-lg px-3 py-2"
          style={{ backgroundColor: tint(modeColor(selectedAnalysis.mode), '08') }}
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
            <span className="text-muted font-mono text-[10px]">
              {selectedAnalysis.entryTime}
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
          th={th}
          analysis={selectedAnalysis.analysis}
          mode={selectedAnalysis.mode}
          onReplaceImage={noopReplace}
        />
      </SectionBox>
    );
  }

  // ── Render: Analyses for a date ────────────────────────

  if (selectedDate) {
    return (
      <SectionBox label="Analysis History">
        <div className="mb-3">
          <button
            type="button"
            onClick={goBackToList}
            className="cursor-pointer rounded-md px-3 py-1.5 font-sans text-[10px] font-semibold transition-opacity hover:opacity-80"
            style={{ backgroundColor: th.surfaceAlt, color: th.textMuted }}
          >
            {'\u2190'} All Dates
          </button>
        </div>

        <div
          className="mb-3 font-sans text-[13px] font-bold"
          style={{ color: th.text }}
        >
          {formatDate(selectedDate)}
        </div>

        {loading && (
          <div
            className="rounded-lg px-3 py-4 text-center font-sans text-[11px]"
            style={{ color: th.textMuted }}
          >
            Loading analyses...
          </div>
        )}

        {!loading && analyses.length === 0 && (
          <div
            className="rounded-lg px-3 py-4 text-center font-sans text-[11px]"
            style={{ color: th.textMuted }}
          >
            No analyses found for this date.
          </div>
        )}

        {!loading && analyses.length > 0 && (
          <div className="grid gap-2">
            {analyses.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setSelectedAnalysis(a)}
                className="border-edge cursor-pointer rounded-lg border p-3 text-left transition-all hover:border-[color:var(--color-accent)]"
                style={{ backgroundColor: th.surface }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
                      style={{
                        backgroundColor: tint(modeColor(a.mode), '15'),
                        color: modeColor(a.mode),
                      }}
                    >
                      {MODE_LABELS[a.mode].label}
                    </span>
                    <span className="text-muted font-mono text-[10px]">
                      {a.entryTime}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className="font-mono text-[11px] font-bold"
                      style={{ color: structureColor(a.structure) }}
                    >
                      {a.structure}
                    </span>
                    <span
                      className="font-mono text-[10px] font-semibold"
                      style={{ color: confidenceColor(a.confidence) }}
                    >
                      {a.confidence}
                    </span>
                    <span className="text-muted font-mono text-[10px]">
                      {a.suggestedDelta}{'\u0394'}
                    </span>
                  </div>
                </div>

                {/* Summary line */}
                <div
                  className="mt-1.5 line-clamp-2 text-[10px] leading-relaxed"
                  style={{ color: th.textSecondary }}
                >
                  {a.analysis.reasoning}
                </div>

                {/* Market context */}
                <div className="mt-1.5 flex items-center gap-3">
                  {!!a.spx && (
                    <span className="text-muted font-mono text-[9px]">
                      SPX {Number(a.spx).toFixed(0)}
                    </span>
                  )}
                  {!!a.vix && (
                    <span className="text-muted font-mono text-[9px]">
                      VIX {Number(a.vix).toFixed(1)}
                    </span>
                  )}
                  {a.hedge && a.hedge !== 'null' && (
                    <span className="text-muted font-mono text-[9px]">
                      Hedge: {a.hedge}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {error && (
          <div
            className="mt-2 rounded-lg px-3 py-2 text-[11px]"
            style={{ backgroundColor: th.red + '12', color: th.red }}
          >
            {error}
          </div>
        )}
      </SectionBox>
    );
  }

  // ── Render: Date list ──────────────────────────────────

  return (
    <SectionBox label="Analysis History">
      {dates.length === 0 && !error && (
        <div
          className="rounded-lg px-3 py-6 text-center font-sans text-[11px]"
          style={{ color: th.textMuted }}
        >
          No saved analyses yet. Run a chart analysis to get started.
        </div>
      )}

      {dates.length > 0 && (
        <div className="grid gap-1.5">
          {dates.map((d) => (
            <button
              key={d.date}
              type="button"
              onClick={() => loadDate(d.date)}
              className="border-edge cursor-pointer rounded-lg border px-3 py-2.5 text-left transition-all hover:border-[color:var(--color-accent)]"
              style={{ backgroundColor: th.surface }}
            >
              <div className="flex items-center justify-between">
                <span
                  className="font-sans text-[12px] font-semibold"
                  style={{ color: th.text }}
                >
                  {formatDate(d.date)}
                </span>
                <div className="flex items-center gap-1.5">
                  {d.entries > 0 && (
                    <span
                      className="rounded-full px-1.5 py-0.5 font-mono text-[9px] font-semibold"
                      style={{
                        backgroundColor: tint(th.accent, '12'),
                        color: th.accent,
                      }}
                    >
                      {d.entries} entry
                    </span>
                  )}
                  {d.middays > 0 && (
                    <span
                      className="rounded-full px-1.5 py-0.5 font-mono text-[9px] font-semibold"
                      style={{
                        backgroundColor: tint(th.caution, '12'),
                        color: th.caution,
                      }}
                    >
                      {d.middays} midday
                    </span>
                  )}
                  {d.reviews > 0 && (
                    <span
                      className="rounded-full px-1.5 py-0.5 font-mono text-[9px] font-semibold"
                      style={{
                        backgroundColor: tint('#A78BFA', '12'),
                        color: '#A78BFA',
                      }}
                    >
                      {d.reviews} review
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {error && (
        <div
          className="mt-2 rounded-lg px-3 py-2 text-[11px]"
          style={{ backgroundColor: th.red + '12', color: th.red }}
        >
          {error}
        </div>
      )}
    </SectionBox>
  );
}