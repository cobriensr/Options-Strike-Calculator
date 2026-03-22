/**
 * ChartAnalysis — Upload Market Tide, Net Flow, and/or Periscope screenshots.
 * Sends images + current calculator context to Claude Opus 4.6 with adaptive thinking.
 * Returns a comprehensive trading plan: structure, strikes, management, entries, hedges.
 *
 * Supports three modes:
 *   - entry:   Pre-trade analysis (default)
 *   - midday:  Mid-day re-analysis
 *   - review:  End-of-day review
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { Theme } from '../../themes';
import type { CalculationResults } from '../../types';
import { SectionBox } from '../ui';
import { tint } from '../../utils/ui-utils';
import type { AnalysisMode } from './types';
import { CHART_LABELS, MODE_LABELS } from './types';
import AnalysisResultsView from './AnalysisResults';
import { useImageUpload } from '../../hooks/useImageUpload';
import { useChartAnalysis } from '../../hooks/useChartAnalysis';

export type { AnalysisContext } from './types';

interface Props {
  readonly th: Theme;
  readonly results: CalculationResults | null;
  readonly context: import('./types').AnalysisContext;
  readonly onAnalysisSaved?: () => void;
}

export default function ChartAnalysis({
  th,
  results,
  context,
  onAnalysisSaved,
}: Props) {
  const [mode, setMode] = useState<AnalysisMode>('entry');
  const [confirming, setConfirming] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [positionUpload, setPositionUpload] = useState<{
    status: 'idle' | 'uploading' | 'success' | 'error';
    message?: string;
    spreadCount?: number;
  }>({ status: 'idle' });

  const [entryExistsToday, setEntryExistsToday] = useState(false);
  const [reviewExistsToday, setReviewExistsToday] = useState(false);

  // ── Image management ──────────────────────────────────────
  const {
    images,
    fileInputRef,
    replaceInputRef,
    removeImage,
    clearAllImages,
    updateLabel,
    replaceImage,
    handleReplaceFile,
    handleDrop,
    handleFileSelect,
  } = useImageUpload();

  // ── Analysis ──────────────────────────────────────────────
  const {
    analysis,
    rawResponse,
    loading,
    error,
    elapsed,
    analyze,
    cancelAnalysis,
    lastAnalysis,
    THINKING_MESSAGES,
  } = useChartAnalysis({
    images,
    context,
    results,
    mode,
    onAnalysisSaved,
    onModeCompleted: (completedMode) => {
      if (completedMode === 'entry') setEntryExistsToday(true);
      if (completedMode === 'review') setReviewExistsToday(true);
    },
  });

  // Check which analysis modes already exist for today's selected date
  useEffect(() => {
    const date = context.selectedDate;
    if (!date) {
      setEntryExistsToday(false);
      setReviewExistsToday(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/analyses?date=${encodeURIComponent(date)}`,
          { credentials: 'include' },
        );
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const analyses = data.analyses ?? [];
        const hasEntry = analyses.some(
          (a: { mode: string }) => a.mode === 'entry',
        );
        const hasReview = analyses.some(
          (a: { mode: string }) => a.mode === 'review',
        );
        if (!cancelled) {
          setEntryExistsToday(hasEntry);
          setReviewExistsToday(hasReview);
          // Auto-switch to the next logical mode
          if (hasReview && (mode === 'entry' || mode === 'midday'))
            setMode('review');
          else if (hasEntry && mode === 'entry') setMode('midday');
        }
      } catch {
        // Non-critical — leave buttons enabled if check fails
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [context.selectedDate, mode]);

  const handleCSVUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (csvInputRef.current) csvInputRef.current.value = '';

      setPositionUpload({ status: 'uploading' });
      try {
        const csvText = await file.text();
        const spxParam = results?.spot ? `?spx=${results.spot}` : '';
        const res = await fetch(`/api/positions${spxParam}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csv: csvText }),
        });

        if (!res.ok) {
          const body = await res
            .json()
            .catch(() => ({ error: 'Upload failed' }));
          throw new Error(body.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        const count = data.positions?.stats?.totalSpreads ?? 0;
        setPositionUpload({
          status: 'success',
          message: `${count} spread${count !== 1 ? 's' : ''} loaded from paperMoney`,
          spreadCount: count,
        });
      } catch (err) {
        setPositionUpload({
          status: 'error',
          message: err instanceof Error ? err.message : 'Upload failed',
        });
      }
    },
    [results?.spot],
  );

  // ── Render ────────────────────────────────────────────────

  return (
    <SectionBox label="Chart Analysis">
      <div className="font-sans text-[11px] leading-relaxed">
        {/* Mode selector */}
        <div className="mb-3 flex gap-1.5">
          {(Object.keys(MODE_LABELS) as AnalysisMode[]).map((m) => {
            const disabled =
              (m === 'entry' && entryExistsToday) ||
              (m === 'midday' && reviewExistsToday);
            const disabledReason =
              m === 'entry' && entryExistsToday
                ? 'Pre-trade entry already exists for this date'
                : m === 'midday' && reviewExistsToday
                  ? 'Review already exists — mid-day is locked'
                  : undefined;
            const modeColor =
              m === 'entry'
                ? th.accent
                : m === 'midday'
                  ? th.caution
                  : th.green;
            const isActive = mode === m;
            return (
              <button
                key={m}
                type="button"
                disabled={disabled}
                onClick={() => !disabled && setMode(m)}
                className={`rounded-md px-3 py-1.5 font-sans text-[10px] font-semibold transition-all ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
                style={{
                  backgroundColor: isActive
                    ? tint(modeColor, '18')
                    : th.surfaceAlt,
                  color: isActive ? modeColor : th.textMuted,
                  border: `1px solid ${isActive ? tint(modeColor, '40') : 'transparent'}`,
                }}
                title={disabledReason ?? MODE_LABELS[m].desc}
              >
                {MODE_LABELS[m].label}
                {disabled && ' \u2713'}
              </button>
            );
          })}
          <span className="text-muted ml-2 self-center text-[10px] italic">
            {reviewExistsToday && mode === 'review'
              ? `${MODE_LABELS[mode].desc} — review already ran today`
              : entryExistsToday && mode !== 'entry'
                ? `${MODE_LABELS[mode].desc} — entry already ran today`
                : MODE_LABELS[mode].desc}
          </span>
        </div>

        {/* Drop zone */}
        <button
          type="button"
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          className="border-edge bg-surface-alt mb-3 w-full cursor-pointer rounded-lg border-2 border-dashed p-4 text-center transition-colors hover:border-[var(--color-accent)]"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Upload chart images"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />
          <input
            ref={replaceInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleReplaceFile}
          />
          <div className="text-muted text-[12px]">
            {images.length === 0
              ? 'Drop or click to upload, or paste (Ctrl+V) a screenshot from clipboard'
              : `${images.length}/8 images \u2014 drop, click, or paste more`}
          </div>
        </button>

        {/* Image previews */}
        {images.length > 0 && (
          <div className="mb-1.5 flex justify-end">
            <button
              type="button"
              onClick={clearAllImages}
              className="cursor-pointer rounded-md px-2.5 py-1 font-sans text-[10px] font-semibold transition-opacity hover:opacity-80"
              style={{
                backgroundColor: tint(th.red, '12'),
                color: th.red,
                border: `1px solid ${tint(th.red, '25')}`,
              }}
            >
              Clear All Images
            </button>
          </div>
        )}
        {images.length > 0 && (
          <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {images.map((img) => (
              <div
                key={img.id}
                className="bg-surface border-edge relative overflow-hidden rounded-lg border"
              >
                <img
                  src={img.preview}
                  alt={img.label}
                  className="h-24 w-full object-cover object-top"
                />
                <div className="flex items-center gap-1.5 p-1.5">
                  <select
                    value={img.label}
                    onChange={(e) => updateLabel(img.id, e.target.value)}
                    className="bg-surface-alt border-edge flex-1 rounded border px-1 py-0.5 font-sans text-[10px]"
                  >
                    {CHART_LABELS.filter(
                      (l) =>
                        l === img.label ||
                        !images.some((o) => o.id !== img.id && o.label === l),
                    ).map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeImage(img.id);
                    }}
                    className="text-muted hover:text-danger text-[14px] leading-none"
                    aria-label="Remove image"
                  >
                    {'\u00D7'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* PaperMoney CSV upload — hidden in review mode (review evaluates the recommendation, not positions) */}
        {images.length > 0 && !loading && mode !== 'review' && (
          <div className="mb-4 flex items-center justify-center gap-3">
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleCSVUpload}
              aria-label="Upload paperMoney CSV"
            />
            <button
              type="button"
              onClick={() => csvInputRef.current?.click()}
              disabled={positionUpload.status === 'uploading'}
              className="cursor-pointer rounded-md px-4 py-2 font-sans text-xs font-semibold transition-opacity hover:opacity-80"
              style={{
                backgroundColor: th.accent,
                color: '#fff',
                border: `1px solid ${th.accent}`,
              }}
            >
              {positionUpload.status === 'uploading'
                ? 'Uploading...'
                : 'Upload paperMoney Positions (.csv)'}
            </button>
            {positionUpload.status === 'success' && (
              <span className="text-xs" style={{ color: th.green }}>
                {positionUpload.message}
              </span>
            )}
            {positionUpload.status === 'error' && (
              <span className="text-xs" style={{ color: th.red }}>
                {positionUpload.message}
              </span>
            )}
          </div>
        )}

        {/* Analyze button + confirmation step */}
        {images.length > 0 && !loading && !confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="mb-3 w-full cursor-pointer rounded-lg px-4 py-2.5 font-sans text-[12px] font-bold tracking-wider uppercase transition-opacity"
            style={{ backgroundColor: th.accent, color: '#fff' }}
          >
            {`Analyze ${images.length} chart${images.length > 1 ? 's' : ''} \u2014 ${MODE_LABELS[mode].label}`}
          </button>
        )}

        {confirming && !loading && (
          <div
            className="mb-3 flex items-center justify-between rounded-lg px-4 py-3"
            style={{
              backgroundColor: tint(th.caution, '10'),
              border: '1.5px solid ' + tint(th.caution, '30'),
            }}
          >
            <div>
              <div
                className="font-sans text-[11px] font-semibold"
                style={{ color: th.caution }}
              >
                Send {images.length} image{images.length > 1 ? 's' : ''} to
                Opus? (~5{'\u201310'} min, billed on send)
              </div>
              <div className="text-muted mt-0.5 font-sans text-[10px]">
                {MODE_LABELS[mode].label} {'\u2022'}{' '}
                {images.map((img) => img.label).join(', ')}
                {!context.isBacktest && (
                  <span style={{ color: th.accent }}>
                    {' \u2022'} Will fetch live positions from Schwab
                  </span>
                )}
                {lastAnalysis && (mode === 'midday' || mode === 'review') && (
                  <span style={{ color: th.green }}>
                    {' '}
                    {'\u2022'} Includes previous {lastAnalysis.structure}{' '}
                    recommendation
                  </span>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="cursor-pointer rounded-md px-3 py-1.5 font-sans text-[10px] font-semibold transition-opacity hover:opacity-80"
                style={{ backgroundColor: th.surfaceAlt, color: th.textMuted }}
              >
                Go Back
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  analyze();
                }}
                className="cursor-pointer rounded-md px-4 py-1.5 font-sans text-[10px] font-bold tracking-wider uppercase transition-opacity hover:opacity-90"
                style={{ backgroundColor: th.accent, color: '#fff' }}
              >
                Confirm
              </button>
            </div>
          </div>
        )}

        {loading && (
          <div
            className="border-edge mb-3 overflow-hidden rounded-lg border p-4"
            style={{ backgroundColor: th.surfaceAlt }}
          >
            {/* Pulsing bar */}
            <div
              className="mb-3 h-1 w-full overflow-hidden rounded-full"
              style={{ backgroundColor: tint(th.accent, '20') }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  backgroundColor: th.accent,
                  width: `${Math.min(95, (elapsed / 600) * 100)}%`,
                  transition: 'width 1s linear',
                }}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div
                  className="mb-0.5 font-sans text-[11px] font-semibold"
                  style={{ color: th.accent }}
                >
                  Opus is thinking...
                </div>
                <div className="text-muted font-sans text-[10px]">
                  {
                    THINKING_MESSAGES[
                      Math.min(
                        Math.floor(elapsed / 50),
                        THINKING_MESSAGES.length - 1,
                      )
                    ]
                  }
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div
                  className="font-mono text-[12px] font-bold"
                  style={{ color: th.textMuted }}
                >
                  {elapsed}s
                </div>
                <button
                  type="button"
                  onClick={cancelAnalysis}
                  className="cursor-pointer rounded-md px-3 py-1 font-sans text-[10px] font-semibold transition-opacity hover:opacity-80"
                  style={{
                    backgroundColor: tint(th.red, '18'),
                    color: th.red,
                    border: `1px solid ${tint(th.red, '30')}`,
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div
            className="mb-3 rounded-lg px-3 py-2 text-[11px]"
            style={{ backgroundColor: tint(th.red, '12'), color: th.red }}
          >
            {error}
          </div>
        )}

        {/* Results */}
        {analysis && (
          <AnalysisResultsView
            th={th}
            analysis={analysis}
            mode={mode}
            onReplaceImage={replaceImage}
          />
        )}

        {/* Raw response fallback */}
        {!analysis && rawResponse && (
          <div className="bg-surface-alt border-edge rounded-lg border p-3">
            <div className="text-muted mb-1 font-sans text-[10px] font-bold tracking-wider uppercase">
              Raw Analysis
            </div>
            <pre className="text-secondary max-h-48 overflow-auto font-mono text-[10px] leading-relaxed whitespace-pre-wrap">
              {rawResponse}
            </pre>
          </div>
        )}
      </div>
    </SectionBox>
  );
}
