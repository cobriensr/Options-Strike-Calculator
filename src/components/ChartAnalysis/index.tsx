/**
 * ChartAnalysis — Upload Market Tide, Net Flow, and/or Periscope screenshots.
 * Sends images + current calculator context to Claude Opus 4.6 with adaptive thinking.
 * Returns a comprehensive trading plan: structure, strikes, management, entries, hedges.
 *
 * Supports three modes:
 *   - entry:   Pre-trade analysis (default)
 *   - midday:  Mid-day re-analysis
 *   - review:  End-of-day review
 *
 * Controls + loading are delegated to ChartControls.
 * Result rendering is delegated to AnalysisDisplay.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { CalculationResults } from '../../types';
import { SectionBox } from '../ui';
import type { AnalysisMode } from './types';
import ChartControls from './ChartControls';
import AnalysisDisplay from './AnalysisDisplay';
import { useImageUpload } from '../../hooks/useImageUpload';
import { useChartAnalysis } from '../../hooks/useChartAnalysis';

export type { AnalysisContext } from './types';

interface Props {
  readonly results: CalculationResults | null;
  readonly context: import('./types').AnalysisContext;
  readonly onAnalysisSaved?: () => void;
  readonly csvPositionSummary?: string | null;
}

export default function ChartAnalysis({
  results,
  context,
  onAnalysisSaved,
  csvPositionSummary,
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
  const hasCSVPositions =
    positionUpload.status === 'success' &&
    (positionUpload.spreadCount ?? 0) > 0;

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
    retryPrompt,
    confirmRetry,
    cancelRetry,
  } = useChartAnalysis({
    images,
    context,
    results,
    mode,
    hasCSVPositions,
    csvPositionSummary: csvPositionSummary ?? undefined,
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
          if (hasReview) setMode('review');
          else if (hasEntry) setMode('midday');
        }
      } catch {
        // Non-critical — leave buttons enabled if check fails
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [context.selectedDate]); // mode intentionally omitted — only re-fetch on date change

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

        if (!data.saved) {
          setPositionUpload({
            status: 'error',
            message: `Parsed ${count} spreads but failed to save — Claude won't see your positions`,
          });
          return;
        }

        setPositionUpload({
          status: 'success',
          message: `${count} spread${count !== 1 ? 's' : ''} saved from paperMoney`,
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
    <SectionBox label="Chart Analysis" collapsible>
      <div className="font-sans text-[11px] leading-relaxed">
        <ChartControls
          mode={mode}
          onModeChange={setMode}
          entryExistsToday={entryExistsToday}
          reviewExistsToday={reviewExistsToday}
          images={images}
          fileInputRef={fileInputRef}
          replaceInputRef={replaceInputRef}
          removeImage={removeImage}
          clearAllImages={clearAllImages}
          updateLabel={updateLabel}
          handleDrop={handleDrop}
          handleFileSelect={handleFileSelect}
          handleReplaceFile={handleReplaceFile}
          csvInputRef={csvInputRef}
          positionUpload={positionUpload}
          onCSVUpload={handleCSVUpload}
          confirming={confirming}
          onConfirmStart={() => setConfirming(true)}
          onConfirmCancel={() => setConfirming(false)}
          onConfirmSubmit={() => {
            setConfirming(false);
            analyze();
          }}
          loading={loading}
          elapsed={elapsed}
          THINKING_MESSAGES={THINKING_MESSAGES}
          cancelAnalysis={cancelAnalysis}
          error={error}
          retryPrompt={retryPrompt}
          onRetryNow={confirmRetry}
          onCancelRetry={cancelRetry}
          isBacktest={context.isBacktest ?? false}
          lastAnalysis={lastAnalysis}
        />

        <AnalysisDisplay
          analysis={analysis}
          rawResponse={rawResponse}
          mode={mode}
          onReplaceImage={replaceImage}
        />
      </div>
    </SectionBox>
  );
}
