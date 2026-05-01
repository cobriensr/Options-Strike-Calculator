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
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
// Markdown renderer — styled to match ChartAnalysis aesthetics
// ============================================================

/**
 * Tailwind-styled overrides for the markdown elements Claude actually
 * produces in periscope reads: headings, bold, lists, and GFM tables.
 * Defined once, memoized via the module scope, and reused by every
 * render so react-markdown doesn't re-create the components map.
 */
const MARKDOWN_COMPONENTS = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-primary mt-1 mb-2 text-base font-semibold">
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-primary mt-3 mb-1.5 text-sm font-semibold">
      {children}
    </h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="text-secondary mt-2 mb-1 text-xs font-semibold tracking-wide uppercase">
      {children}
    </h3>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="text-secondary my-1.5 text-xs leading-relaxed">{children}</p>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="text-primary font-semibold">{children}</strong>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="my-1.5 ml-4 list-disc space-y-0.5 text-xs">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="my-1.5 ml-4 list-decimal space-y-0.5 text-xs">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="text-secondary leading-relaxed">{children}</li>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="bg-surface text-primary rounded px-1 py-0.5 font-mono text-[11px]">
      {children}
    </code>
  ),
  hr: () => <hr className="border-edge my-3" />,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-edge min-w-full border text-[11px]">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => (
    <thead className="bg-surface/60">{children}</thead>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border-edge text-primary border px-2 py-1 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border-edge text-secondary border px-2 py-1">{children}</td>
  ),
};

const REMARK_PLUGINS = [remarkGfm];

function ProseView({ prose }: { prose: string }) {
  return (
    <div className="border-edge bg-surface/40 rounded-md border p-3">
      <Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {prose}
      </Markdown>
    </div>
  );
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
          {mode === 'debrief' && parentId != null && (
            <span className="text-muted ml-2 font-mono text-[10px]">
              Linked to read #{parentId}
            </span>
          )}
        </div>

        {/* Image upload slots */}
        <div className="flex flex-col gap-2">
          <p className="text-muted text-xs">
            Drop, click, or paste (Ctrl+V) screenshots — pasted images fill
            chart → GEX → charm in order.
          </p>
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
            <ProseView prose={response.prose} />
          </div>
        )}
      </div>
    </SectionBox>
  );
}
