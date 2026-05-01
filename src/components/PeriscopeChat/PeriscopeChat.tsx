/**
 * Periscope Chat panel.
 *
 * Manual upload of 1-3 Periscope screenshots → Claude analysis via the
 * `periscope` skill. Mode toggle (Read / Debrief), per-kind drag-drop
 * slots, optional parent_id (debrief mode), submit button, response
 * area showing the structured fields + the prose.
 *
 * State + submission live in `usePeriscopeChat`. This component is
 * presentation only.
 */

import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { SectionBox } from '../ui/SectionBox';
import { usePeriscopeChat } from './usePeriscopeChat.js';
import type { PeriscopeStructuredFields } from './types.js';
import { PERISCOPE_IMAGE_KINDS } from './types.js';

/**
 * Custom event name dispatched by PeriscopeChatHistory when the user
 * clicks "Debrief this" on a past row. The chat panel listens and
 * pre-fills mode + parentId so the user can immediately attach
 * screenshots and submit. Uses a window event (rather than props /
 * context) because the two panels are sibling lazy-loaded sections
 * — lifting state to App.tsx would couple them across the lazy
 * boundary.
 */
export const PERISCOPE_DEBRIEF_EVENT = 'periscope:start-debrief';

interface DebriefEventDetail {
  parentId: number;
}

// ============================================================
// Per-kind drag-drop slot
// ============================================================

interface ImageSlotProps {
  label: string;
  hint: string;
  preview: string | null;
  disabled: boolean;
  onSelect: (file: File | null) => void;
}

function ImageSlot({
  label,
  hint,
  preview,
  disabled,
  onSelect,
}: ImageSlotProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputId = useId();

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (disabled) return;
      const file = e.dataTransfer.files[0];
      if (file) onSelect(file);
    },
    [disabled, onSelect],
  );

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0] ?? null;
      onSelect(file);
      // Reset the input so re-uploading the same file fires onChange again.
      if (inputRef.current) inputRef.current.value = '';
    },
    [onSelect],
  );

  const handleClick = useCallback(() => {
    if (disabled) return;
    inputRef.current?.click();
  }, [disabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      }
    },
    [handleClick],
  );

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-secondary text-xs font-medium">
        {label}
      </label>
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={`Upload ${label}`}
        aria-disabled={disabled}
        className={`border-edge bg-surface/40 relative flex min-h-32 cursor-pointer items-center justify-center rounded-md border border-dashed p-2 text-center transition hover:border-[var(--color-accent)] focus:border-[var(--color-accent)] focus:outline-none ${disabled ? 'pointer-events-none opacity-50' : ''}`}
      >
        {preview ? (
          <>
            <img
              src={preview}
              alt={`${label} preview`}
              className="max-h-40 max-w-full rounded object-contain"
            />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSelect(null);
              }}
              className="absolute top-1 right-1 rounded bg-black/60 px-2 py-0.5 text-xs text-white hover:bg-black/80"
              aria-label={`Remove ${label}`}
            >
              ✕
            </button>
          </>
        ) : (
          <span className="text-muted text-xs">{hint}</span>
        )}
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={handleFileChange}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

// ============================================================
// Structured-fields display
// ============================================================

interface StructuredFieldsViewProps {
  fields: PeriscopeStructuredFields;
}

function StructuredFieldsView({ fields }: StructuredFieldsViewProps) {
  const rows: Array<{ label: string; value: string }> = useMemo(() => {
    const fmt = (n: number | null) =>
      n == null
        ? '—'
        : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return [
      { label: 'Spot', value: fmt(fields.spot) },
      {
        label: 'Cone',
        value:
          fields.cone_lower == null && fields.cone_upper == null
            ? '—'
            : `${fmt(fields.cone_lower)} – ${fmt(fields.cone_upper)}`,
      },
      { label: 'Long trigger', value: fmt(fields.long_trigger) },
      { label: 'Short trigger', value: fmt(fields.short_trigger) },
      { label: 'Regime', value: fields.regime_tag ?? '—' },
    ];
  }, [fields]);

  return (
    <div className="border-edge bg-surface/60 grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border p-3 text-sm sm:grid-cols-5">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-col">
          <span className="text-muted text-[10px] tracking-wide uppercase">
            {row.label}
          </span>
          <span className="text-primary font-mono">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// Main panel
// ============================================================

export default function PeriscopeChat() {
  const {
    mode,
    images,
    parentId,
    inFlight,
    elapsedMs,
    response,
    error,
    setMode,
    setParentId,
    setImage,
    submit,
    reset,
  } = usePeriscopeChat();

  // Listen for "Debrief this" clicks from the history panel. The
  // event carries a parentId; we flip mode + prefill parentId so the
  // user just has to drop screenshots and submit. Skipped if a
  // submission is in flight (don't yank state out from under it).
  useEffect(() => {
    function onStartDebrief(e: Event) {
      const detail = (e as CustomEvent<DebriefEventDetail>).detail;
      if (!detail || typeof detail.parentId !== 'number') return;
      if (inFlight) return;
      setMode('debrief');
      setParentId(detail.parentId);
    }
    window.addEventListener(PERISCOPE_DEBRIEF_EVENT, onStartDebrief);
    return () =>
      window.removeEventListener(PERISCOPE_DEBRIEF_EVENT, onStartDebrief);
  }, [inFlight, setMode, setParentId]);

  const stagedCount = Object.values(images).filter((v) => v != null).length;
  const canSubmit = !inFlight && stagedCount > 0;

  const elapsedLabel =
    elapsedMs > 0 ? ` · ${Math.floor(elapsedMs / 1000)}s elapsed` : '';

  return (
    <SectionBox
      label="Periscope Chat"
      badge={
        response
          ? `${response.mode === 'debrief' ? 'Debrief' : 'Read'} · ${Math.round(response.durationMs / 1000)}s`
          : null
      }
      collapsible
      defaultCollapsed={false}
    >
      <div className="flex flex-col gap-4">
        {/* Mode toggle */}
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted">Mode:</span>
          <div
            className="border-edge bg-surface/60 inline-flex rounded-md border p-0.5"
            role="radiogroup"
            aria-label="Analysis mode"
          >
            {(['read', 'debrief'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                disabled={inFlight}
                className={`rounded px-3 py-1 text-xs font-medium tracking-wide uppercase transition ${
                  mode === m
                    ? 'bg-[var(--color-accent)] text-white shadow-sm'
                    : 'text-secondary hover:text-primary'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          {mode === 'debrief' && (
            <label className="text-muted ml-2 flex items-center gap-1 text-xs">
              Parent read id:
              <input
                type="number"
                value={parentId ?? ''}
                onChange={(e) =>
                  setParentId(
                    e.target.value === ''
                      ? null
                      : Number.parseInt(e.target.value, 10),
                  )
                }
                disabled={inFlight}
                placeholder="(optional)"
                className="border-edge bg-surface text-primary w-24 rounded border px-2 py-0.5 font-mono text-xs"
              />
            </label>
          )}
        </div>

        {/* Image upload slots */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {PERISCOPE_IMAGE_KINDS.map(({ kind, label, hint }) => (
            <ImageSlot
              key={kind}
              label={label}
              hint={hint}
              preview={images[kind]?.preview ?? null}
              disabled={inFlight}
              onSelect={(file) => setImage(kind, file)}
            />
          ))}
        </div>

        {/* Action row */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {inFlight
              ? `Analyzing${elapsedLabel}…`
              : `Submit ${mode === 'debrief' ? 'debrief' : 'read'}`}
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={inFlight}
            className="border-edge text-secondary hover:text-primary rounded-md border px-3 py-1.5 text-xs transition disabled:opacity-40"
          >
            Reset
          </button>
          <span className="text-muted ml-auto text-xs">
            {stagedCount}/3 image{stagedCount === 1 ? '' : 's'} staged
          </span>
        </div>

        {/* Error */}
        {error && (
          <div
            role="alert"
            className="rounded-md border border-red-700/60 bg-red-950/30 p-2 text-xs text-red-300"
          >
            {error}
          </div>
        )}

        {/* Response */}
        {response && (
          <div className="flex flex-col gap-3">
            <StructuredFieldsView fields={response.structured} />
            <div className="border-edge bg-surface/40 text-primary rounded-md border p-3 text-sm whitespace-pre-wrap">
              {response.prose}
            </div>
            <div className="text-muted flex flex-wrap gap-x-4 gap-y-1 text-[10px]">
              <span>id: {response.id ?? '(save failed)'}</span>
              <span>model: {response.model}</span>
              <span>
                tokens: {response.usage.input} in / {response.usage.output} out
              </span>
              <span>
                cache: {response.usage.cacheRead} read /{' '}
                {response.usage.cacheWrite} write
              </span>
            </div>
          </div>
        )}
      </div>
    </SectionBox>
  );
}
