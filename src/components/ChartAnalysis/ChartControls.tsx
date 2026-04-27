/**
 * ChartControls — Mode selector, image upload/preview, CSV upload,
 * analyze button with confirmation, and loading state.
 *
 * Confirmation dialog and loading indicator are in AnalysisLoadingState.
 */

import { useState, useEffect } from 'react';
import type { RefObject } from 'react';
import { theme } from '../../themes';
import type { AnalysisMode, UploadedImage } from './types';
import type { RetryPrompt } from '../../hooks/useChartAnalysis';
import { CHART_LABELS, MODE_LABELS } from './types';
import { tint } from '../../utils/ui-utils';
import { useAccessSession } from '../../hooks/useAccessSession';
import {
  ConfirmationBar,
  LoadingIndicator,
  RetryPromptDialog,
} from './AnalysisLoadingState';

// ── Types ──────────────────────────────────────────────────

interface Props {
  readonly mode: AnalysisMode;
  readonly onModeChange: (mode: AnalysisMode) => void;
  readonly entryExistsToday: boolean;
  readonly reviewExistsToday: boolean;
  // Image management
  readonly images: readonly UploadedImage[];
  readonly fileInputRef: RefObject<HTMLInputElement | null>;
  readonly replaceInputRef: RefObject<HTMLInputElement | null>;
  readonly removeImage: (id: string) => void;
  readonly clearAllImages: () => void;
  readonly updateLabel: (id: string, label: string) => void;
  readonly handleDrop: (e: React.DragEvent) => void;
  readonly handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  readonly handleReplaceFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  // CSV upload
  readonly csvInputRef: RefObject<HTMLInputElement | null>;
  readonly positionUpload: {
    status: 'idle' | 'uploading' | 'success' | 'error';
    message?: string;
    spreadCount?: number;
  };
  readonly onCSVUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  // Analyze
  readonly confirming: boolean;
  readonly onConfirmStart: () => void;
  readonly onConfirmCancel: () => void;
  readonly onConfirmSubmit: () => void;
  readonly loading: boolean;
  readonly elapsed: number;
  readonly THINKING_MESSAGES: readonly string[];
  readonly cancelAnalysis: () => void;
  readonly error: string | null;
  // Retry prompt
  readonly retryPrompt: RetryPrompt | null;
  readonly onRetryNow: () => void;
  readonly onCancelRetry: () => void;
  // Context for confirmation dialog
  readonly isBacktest: boolean;
  readonly lastAnalysis: { structure: string } | null;
}

// ── Component ──────────────────────────────────────────────

export default function ChartControls({
  mode,
  onModeChange,
  entryExistsToday,
  reviewExistsToday,
  images,
  fileInputRef,
  replaceInputRef,
  removeImage,
  clearAllImages,
  updateLabel,
  handleDrop,
  handleFileSelect,
  handleReplaceFile,
  csvInputRef,
  positionUpload,
  onCSVUpload,
  confirming,
  onConfirmStart,
  onConfirmCancel,
  onConfirmSubmit,
  loading,
  elapsed,
  THINKING_MESSAGES,
  cancelAnalysis,
  error,
  retryPrompt,
  onRetryNow,
  onCancelRetry,
  isBacktest,
  lastAnalysis,
}: Props) {
  // When the user clicks "Update Screenshots" in the retry dialog,
  // we hide the dialog so the upload area is accessible, and show a
  // "Retry with Updated Images" button instead.
  const [updatingForRetry, setUpdatingForRetry] = useState(false);

  // Reset local state when retry prompt clears (retry started or cancelled)
  useEffect(() => {
    if (!retryPrompt) setUpdatingForRetry(false);
  }, [retryPrompt]);

  // Guest mode: read-only access. The analyze submit button gates the only
  // expensive backend call (Anthropic) so a leaked guest key can't drain the
  // API budget. Server-side, /api/analyze keeps its rejectIfNotOwner check —
  // this is the matching UI affordance.
  const { mode: accessMode } = useAccessSession();
  const isGuest = accessMode === 'guest';

  return (
    <>
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
              ? theme.accent
              : m === 'midday'
                ? theme.caution
                : theme.green;
          const isActive = mode === m;
          return (
            <button
              key={m}
              type="button"
              disabled={disabled}
              onClick={() => !disabled && onModeChange(m)}
              className={`rounded-md px-3 py-1.5 font-sans text-[10px] font-semibold transition-all ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
              style={{
                backgroundColor: isActive
                  ? tint(modeColor, '18')
                  : theme.surfaceAlt,
                color: isActive ? modeColor : theme.textMuted,
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
            : `${images.length}/${CHART_LABELS.length} images \u2014 drop, click, or paste more`}
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
              backgroundColor: tint(theme.red, '12'),
              color: theme.red,
              border: `1px solid ${tint(theme.red, '25')}`,
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

      {/* PaperMoney CSV upload — hidden in review mode */}
      {images.length > 0 && !loading && mode !== 'review' && (
        <div className="mb-4 flex items-center justify-center gap-3">
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={onCSVUpload}
            aria-label="Upload paperMoney CSV"
          />
          <button
            type="button"
            onClick={() => csvInputRef.current?.click()}
            disabled={positionUpload.status === 'uploading'}
            className="cursor-pointer rounded-md px-4 py-2 font-sans text-xs font-semibold transition-opacity hover:opacity-80"
            style={{
              backgroundColor: theme.accent,
              color: '#fff',
              border: `1px solid ${theme.accent}`,
            }}
          >
            {positionUpload.status === 'uploading'
              ? 'Uploading...'
              : 'Upload paperMoney Positions (.csv)'}
          </button>
          {positionUpload.status === 'success' && (
            <span className="text-xs" style={{ color: theme.green }}>
              {positionUpload.message}
            </span>
          )}
          {positionUpload.status === 'error' && (
            <span className="text-xs" style={{ color: theme.red }}>
              {positionUpload.message}
            </span>
          )}
        </div>
      )}

      {/* Analyze button + confirmation step */}
      {images.length > 0 && !loading && !confirming && !retryPrompt && (
        <button
          type="button"
          onClick={isGuest ? undefined : onConfirmStart}
          disabled={isGuest}
          title={
            isGuest ? 'Owner only \u2014 guest mode is read-only' : undefined
          }
          className={`mb-3 w-full rounded-lg px-4 py-2.5 font-sans text-[12px] font-bold tracking-wider uppercase transition-opacity ${
            isGuest ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
          }`}
          style={{ backgroundColor: theme.accent, color: '#fff' }}
        >
          {isGuest
            ? 'Owner only \u2014 submit disabled in guest mode'
            : `Analyze ${images.length} chart${images.length > 1 ? 's' : ''} \u2014 ${MODE_LABELS[mode].label}`}
        </button>
      )}

      {confirming && !loading && (
        <ConfirmationBar
          images={images}
          mode={mode}
          isBacktest={isBacktest}
          lastAnalysis={lastAnalysis}
          onCancel={onConfirmCancel}
          onConfirm={onConfirmSubmit}
        />
      )}

      {loading && (
        <LoadingIndicator
          elapsed={elapsed}
          THINKING_MESSAGES={THINKING_MESSAGES}
          cancelAnalysis={cancelAnalysis}
        />
      )}

      {/* Retry prompt — shown when an attempt fails and retries remain */}
      {retryPrompt && !loading && !updatingForRetry && (
        <RetryPromptDialog
          retryPrompt={retryPrompt}
          onRetryNow={onRetryNow}
          onUpdateScreenshots={() => setUpdatingForRetry(true)}
          onCancel={onCancelRetry}
        />
      )}

      {/* "Retry with Updated Images" button — user is updating screenshots */}
      {retryPrompt && updatingForRetry && !loading && (
        <button
          type="button"
          onClick={() => {
            setUpdatingForRetry(false);
            onRetryNow();
          }}
          className="mb-3 w-full cursor-pointer rounded-lg px-4 py-2.5 font-sans text-[12px] font-bold tracking-wider uppercase transition-opacity"
          style={{ backgroundColor: theme.accent, color: '#fff' }}
        >
          Retry with Updated Images ({retryPrompt.attempt + 1}/
          {retryPrompt.maxAttempts})
        </button>
      )}

      {/* Error */}
      {error && !retryPrompt && (
        <div
          className="mb-3 rounded-lg px-3 py-2 text-[11px]"
          style={{
            backgroundColor: tint(theme.red, '12'),
            color: theme.red,
          }}
        >
          {error}
        </div>
      )}
    </>
  );
}
